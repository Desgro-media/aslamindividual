import { tx } from "../db";
import { del, get, patch, post, put, Ctx } from "../router";
import { badRequest, forbidden, noContent, emptyOk, pathId, isBlank } from "../http";
import { tenantIdOf } from "../security/auth";
import { Roles } from "../types";
import { parseDate, minutesToTime, timeToMinutes } from "../time";
import * as appts from "../services/appointments";
import * as patients from "../services/patients";
import * as notes from "../services/notes";
import * as invoices from "../services/invoices";
import * as settings from "../services/settings";
import * as subs from "../services/subscription";

// The authenticated tenant dashboard API — everything here is scoped to the
// caller's tenant (clinic or individual) resolved server-side from their token,
// never from a client-supplied id.

const tenant = (c: Ctx) => tenantIdOf(c.me());

// Map<String,String> request bodies on the old backend coerced numbers to strings.
const strOf = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
function decimalOf(v: unknown, label: string): number | null {
    const s = strOf(v);
    if (s === null || s.trim() === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n)) throw badRequest(`Invalid value for '${label}'.`);
    return n;
}
const idOf = (v: unknown): number | null => {
    const s = strOf(v);
    if (s === null || s.trim() === "") return null;
    const n = Number(s);
    return Number.isInteger(n) ? n : null;
};

function optionalMinutes(raw: unknown): number | null {
    const s = strOf(raw);
    if (s === null || s.trim() === "") return null;
    const n = Number(s.trim());
    if (!Number.isInteger(n)) throw badRequest(`Invalid date/time or number format: For input string: "${s}"`);
    return n;
}

export function registerDashboardRoutes(): void {
    // ── Appointments ─────────────────────────────────────────────────────────
    get("/appointments", "user", async (c) => appts.getAppointmentsByTenant(c.db, tenant(c)));

    post("/appointments/manual", "user", async (c) => {
        const request = appts.parseManualBookingRequest(await c.body());
        return appts.scheduleManually(request, c.me(), tenant(c));
    });

    // Record a past session (always under the caller's own tenant)
    post("/appointments/past", "user", async (c) => {
        const body = await c.body();
        if (body.patientId == null || body.appointmentDate == null || body.startTime == null) {
            throw badRequest("patientId, appointmentDate, and startTime are required");
        }
        const patientId = idOf(body.patientId);
        if (patientId === null) throw badRequest("Invalid date/time or number format: For input string: \"" + body.patientId + "\"");
        const date = parseDate(body.appointmentDate, "appointmentDate");
        const mins = timeToMinutes(String(body.startTime));
        if (mins === null) throw badRequest("Invalid date/time or number format: Text '" + body.startTime + "' could not be parsed");
        const staffId = idOf(body.staffId);
        return appts.recordPastSession(
            c.me(), patientId, tenant(c), staffId, date, minutesToTime(mins), strOf(body.sessionType),
            body.notes === undefined ? "" : strOf(body.notes), body.status === undefined ? "COMPLETED" : strOf(body.status),
            strOf(body.mode), optionalMinutes(body.durationMinutes));
    });

    patch("/appointments/:id/convert", "user", async (c) =>
        appts.convertDemoToAppointment(pathId(c.params.id), c.me(), tenant(c), appts.parseConvertRequest(await c.body())));

    patch("/appointments/:id/notes", "user", async (c) => {
        const body = await c.body();
        return appts.updateAppointmentNotes(c.db, pathId(c.params.id), tenant(c), strOf(body.notes));
    });

    patch("/appointments/:id/details", "user", async (c) => {
        const body = await c.body();
        const date = body.appointmentDate != null ? parseDate(body.appointmentDate, "appointmentDate") : null;
        let time: string | null = null;
        if (body.startTime != null) {
            const mins = timeToMinutes(String(body.startTime));
            if (mins === null) throw badRequest("Invalid date/time or number format: Text '" + body.startTime + "' could not be parsed");
            time = minutesToTime(mins);
        }
        return appts.updateAppointmentDetails(
            pathId(c.params.id), tenant(c), date, time, strOf(body.sessionType), strOf(body.notes), strOf(body.mode),
            optionalMinutes(body.durationMinutes));
    });

    // Status change: ?status=CONFIRMED|CANCELLED|COMPLETED|AWAITING_PAYMENT[&cancellationReason=][&fee=]
    patch("/appointments/:id", "user", async (c) => {
        const status = c.query.get("status");
        if (status === null) throw badRequest("Invalid value for 'status'.");
        const fee = c.query.get("fee");
        const feeNum = fee === null || fee === "" ? null : Number(fee);
        if (feeNum !== null && !Number.isFinite(feeNum)) throw badRequest("Invalid value for 'fee'.");
        return tx((db) => appts.updateAppointmentStatus(db, pathId(c.params.id), tenant(c), status, c.query.get("cancellationReason"), feeNum));
    });

    del("/appointments/:id", "user", async (c) => {
        await appts.deleteAppointment(pathId(c.params.id), tenant(c));
        return noContent();
    });

    // ── Patients ─────────────────────────────────────────────────────────────
    get("/patients", "user", async (c) => patients.getAllPatients(c.db, tenant(c)));
    post("/patients", "user", async (c) => patients.createPatient(c.db, await c.body(), tenant(c)));
    get("/patients/:id", "user", async (c) => patients.getPatientById(c.db, pathId(c.params.id), tenant(c)));
    get("/patients/:id/appointments", "user", async (c) => appts.getAppointmentsByPatient(c.db, pathId(c.params.id), tenant(c)));

    patch("/patients/:id/details", "user", async (c) => {
        const body = await c.body();
        return patients.updatePatientDetails(c.db, pathId(c.params.id), tenant(c), strOf(body.name), strOf(body.email), strOf(body.phone));
    });

    patch("/patients/:id/risk-flag", "user", async (c) => {
        const body = await c.body();
        if (body.riskFlag == null) throw badRequest("The request could not be read — please check the values you entered.");
        const flag = String(body.riskFlag).toLowerCase() === "true";
        return patients.updateRiskFlag(c.db, pathId(c.params.id), tenant(c), flag, strOf(body.riskReason));
    });

    del("/patients/:id", "user", async (c) => {
        await patients.deletePatient(pathId(c.params.id), tenant(c));
        return noContent();
    });

    // File attachments — body: { fileName, fileData: "data:<mime>;base64,..." }
    post("/patients/:id/attachments", "user", async (c) => {
        const body = await c.body();
        return patients.uploadAttachment(c.db, pathId(c.params.id), tenant(c), strOf(body.fileName), strOf(body.fileData));
    });
    get("/patients/:id/attachments", "user", async (c) => patients.getAttachments(c.db, pathId(c.params.id), tenant(c)));
    get("/patients/:id/attachments/:attachmentId/download", "user", async (c) => {
        const a = await patients.getAttachmentForDownload(c.db, pathId(c.params.id), pathId(c.params.attachmentId), tenant(c));
        const ascii = a.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
        return new Response(new Uint8Array(a.bytes), {
            status: 200,
            headers: {
                "Content-Type": a.fileType,
                "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
                "Content-Length": String(a.bytes.length),
            },
        });
    });
    del("/patients/:id/attachments/:attachmentId", "user", async (c) => {
        await patients.deleteAttachment(c.db, pathId(c.params.id), pathId(c.params.attachmentId), tenant(c));
        return noContent();
    });

    // ── SOAP session notes ───────────────────────────────────────────────────
    post("/notes", "user", async (c) => {
        const body = await c.body();
        const apptId = idOf(body.appointmentId);
        if (apptId === null) throw badRequest("The request could not be read — please check the values you entered.");
        return notes.saveNote(c.db, apptId, tenant(c), body);
    });
    get("/notes/appointment/:id", "user", async (c) => {
        const n = await notes.getNoteByAppointment(c.db, pathId(c.params.id), tenant(c));
        return n ?? noContent();
    });
    get("/notes/patient/:id", "user", async (c) => notes.getNotesByPatient(c.db, pathId(c.params.id), tenant(c)));
    del("/notes/:id", "user", async (c) => {
        await notes.deleteNote(c.db, pathId(c.params.id), tenant(c));
        return noContent();
    });

    // ── Mood trend (dashboard side) ──────────────────────────────────────────
    get("/mood/patient/:id", "user", async (c) => notes.getMoodLogsByPatient(c.db, pathId(c.params.id), tenant(c)));
    get("/mood/appointment/:id", "user", async (c) => {
        const m = await notes.getMoodLogByAppointment(c.db, pathId(c.params.id), tenant(c));
        return m ?? noContent();
    });

    // ── Invoices ─────────────────────────────────────────────────────────────
    // A receptionist's only lever on an invoice is collecting money — pricing,
    // discounting and waiving stay owner/therapist-only, even though both share
    // the BILLING permission gate.
    const requireNotReceptionist = (c: Ctx) => {
        if (c.me().role === Roles.RECEPTIONIST) {
            throw forbidden("Receptionists can collect payments but can't adjust pricing, discount, or waive invoices.");
        }
    };

    get("/invoices", "user", async (c) => invoices.getAllInvoices(c.db, tenant(c)));
    get("/invoices/summary", "user", async (c) => invoices.getRevenueSummary(c.db, tenant(c)));
    get("/invoices/patient/:id", "user", async (c) => invoices.getInvoicesByPatient(c.db, pathId(c.params.id), tenant(c)));
    get("/invoices/appointment/:id", "user", async (c) => invoices.getInvoiceByAppointmentId(c.db, pathId(c.params.id), tenant(c)));

    // Settle in full, with an optional discount. Owner/therapist only.
    patch("/invoices/:id/pay", "user", async (c) => {
        requireNotReceptionist(c);
        const body = await c.body();
        return tx((db) => invoices.markAsPaid(
            db, pathId(c.params.id), tenant(c), strOf(body.paymentMethod) ?? "CASH", decimalOf(body.discountAmount, "discountAmount"),
            strOf(body.discountReason), strOf(body.remark), idOf(body.bankAccountId), strOf(body.bankAccountName), c.me().id));
    });

    // Collect a full or partial payment — the receptionist's action.
    post("/invoices/:id/payments", "user", async (c) => {
        const body = await c.body();
        const amount = decimalOf(body.amount, "amount");
        if (amount === null) throw badRequest("Invalid value for 'amount'.");
        return tx((db) => invoices.recordPayment(
            db, pathId(c.params.id), tenant(c), amount, strOf(body.paymentMethod) ?? "CASH", idOf(body.bankAccountId),
            strOf(body.bankAccountName), strOf(body.remark), c.me().id));
    });

    get("/invoices/:id/payments", "user", async (c) => invoices.getPaymentHistory(c.db, pathId(c.params.id), tenant(c)));

    patch("/invoices/:id/amount", "user", async (c) => {
        const body = await c.body();
        const amount = decimalOf(body.amount, "amount");
        if (amount === null) throw badRequest("Invalid value for 'amount'.");
        return tx((db) => invoices.updateAmount(db, pathId(c.params.id), tenant(c), amount));
    });

    patch("/invoices/:id/waive", "user", async (c) => {
        requireNotReceptionist(c);
        return tx((db) => invoices.markAsWaived(db, pathId(c.params.id), tenant(c)));
    });

    // ── Service catalog ──────────────────────────────────────────────────────
    get("/services", "user", async (c) => settings.listServices(c.db, tenant(c)));
    post("/services", "user", async (c) => settings.createService(c.db, tenant(c), await c.body()));
    put("/services/:id", "user", async (c) => settings.updateService(c.db, pathId(c.params.id), tenant(c), await c.body()));
    patch("/services/:id/toggle", "user", async (c) => settings.toggleService(c.db, pathId(c.params.id), tenant(c)));
    del("/services/:id", "user", async (c) => {
        await tx((db) => settings.deleteService(db, pathId(c.params.id), tenant(c)));
        return noContent();
    });

    // ── Practice settings, holidays, bank accounts ───────────────────────────
    get("/settings", "user", async (c) => settings.getSettings(c.db, tenant(c)));
    put("/settings", "user", async (c) => settings.updateSettings(c.db, tenant(c), await c.body()));
    get("/holidays", "user", async (c) => settings.getHolidays(c.db, tenant(c)));
    post("/holidays", "user", async (c) => settings.addHoliday(c.db, tenant(c), await c.body()));
    del("/holidays/:id", "user", async (c) => {
        await settings.removeHoliday(c.db, pathId(c.params.id), tenant(c));
        return emptyOk();
    });

    get("/bank-accounts", "user", async (c) => settings.getAllBankAccounts(c.db, tenant(c)));
    post("/bank-accounts", "user", async (c) => {
        const body = await c.body();
        return tx((db) => settings.createBankAccount(db, body, tenant(c)));
    });
    put("/bank-accounts/:id", "user", async (c) => {
        const body = await c.body();
        return tx((db) => settings.updateBankAccount(db, pathId(c.params.id), tenant(c), body));
    });
    patch("/bank-accounts/:id/set-default", "user", async (c) => {
        return tx((db) => settings.setDefaultBankAccount(db, pathId(c.params.id), tenant(c)));
    });
    del("/bank-accounts/:id", "user", async (c) => {
        await settings.deleteBankAccount(c.db, pathId(c.params.id), tenant(c));
        return noContent();
    });

    // ── Leads ────────────────────────────────────────────────────────────────
    get("/leads", "user", async (c) => settings.getAllLeads(c.db, tenant(c)));

    // ── Reports (the long-standing summary; the monthly report is in workflow.ts) ─
    get("/reports/summary", "user", async (c) => {
        const t = tenant(c);
        const row = await c.db.one<{ totalPatients: number; totalAppointments: number; awaitingPayment: number; paymentUnderReview: number }>(
            `SELECT (SELECT count(*) FROM patient WHERE primary_psychologist_id = $1) AS total_patients,
                    (SELECT count(*) FROM appointment WHERE psychologist_id = $1) AS total_appointments,
                    (SELECT count(*) FROM appointment WHERE psychologist_id = $1 AND status = 'AWAITING_PAYMENT') AS awaiting_payment,
                    (SELECT count(*) FROM appointment WHERE psychologist_id = $1 AND status = 'PAYMENT_UNDER_REVIEW') AS payment_under_review`, [t]);
        return {
            totalPatients: row!.totalPatients, totalAppointments: row!.totalAppointments,
            awaitingPayment: row!.awaitingPayment, paymentUnderReview: row!.paymentUnderReview,
            pendingAppointments: row!.awaitingPayment, // kept for backward compat
        };
    });
    // Placeholders on the old backend too — kept so nothing that calls them breaks.
    get("/reports/trends", "user", async (c) => ({ range: c.query.get("range") ?? "7d", data: [10, 20, 15, 30, 25] }));
    get("/reports/busiest", "user", async () => ({ Monday: 15, Tuesday: 20 }));

    // ── The tenant's own platform subscription ───────────────────────────────
    get("/subscription/me", "user", async (c) => subs.getStatus(c.db, tenant(c)));
    post("/subscription/payment-submissions", "user", async (c) => {
        const body = await c.body();
        const ref = body.upiTransactionRef;
        if (isBlank(ref) || typeof ref !== "string") throw badRequest("upiTransactionRef must not be blank");
        if (ref.length > 100) throw badRequest("upiTransactionRef size must be between 0 and 100");
        return subs.submitPayment(tenant(c), {
            upiTransactionRef: ref, screenshotBase64: strOf(body.screenshotBase64), amountClaimed: decimalOf(body.amountClaimed, "amountClaimed"),
        });
    });
    get("/subscription/payment-submissions", "user", async (c) => subs.getSubmissions(c.db, tenant(c)));

}
