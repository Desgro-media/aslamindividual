import { Ctx, del, get, patch, post } from "../router";
import { badRequest, noContent, optInt, optStr, pathId } from "../http";
import { tx } from "../db";
import { tenantIdOf } from "../security/auth";
import { addDays, minutesToTime, parseDate, timeToMinutes, today } from "../time";
import { Patient } from "../types";
import * as avail from "../services/availability";
import * as wf from "../services/workflow";
import * as therapist from "../services/therapist";
import { buildMonthlyReport } from "../services/monthlyReport";

// The Psyfos workflow API: the receptionist's booking helpers, session
// completion with case status + follow-ups, the follow-up queue, the monthly
// management report, and the therapist's own dashboard data (/me/**).

const tenant = (c: Ctx) => tenantIdOf(c.me());

const qDuration = (c: Ctx): number | null => {
    const raw = c.query.get("duration");
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw badRequest("Invalid value for 'duration'.");
    return n;
};

export function registerWorkflowRoutes(): void {
    // ── Receptionist booking flow: select therapist -> their services -> slots ──
    // Mounted under /appointments so the existing APPOINTMENTS permission applies:
    // anyone who may schedule can see who they can schedule with. (/staff, the
    // owner's management screen, is deliberately not opened up for this.)
    get("/appointments/therapists", "user", async (c) => therapist.listTherapists(c.db, tenant(c)));
    get("/appointments/service-options", "user", async (c) => therapist.getServiceOptions(c.db, tenant(c)));

    get("/appointments/therapists/:id/services", "user", async (c) => {
        const t = await therapist.requireTherapist(c.db, tenant(c), pathId(c.params.id));
        return avail.getDoctorOfferedServices(c.db, t.id);
    });

    get("/appointments/therapists/:id/slots", "user", async (c) => {
        const t = await therapist.requireTherapist(c.db, tenant(c), pathId(c.params.id));
        const date = parseDate(c.query.get("date"), "date");
        const holiday = await c.db.one("SELECT 1 FROM clinic_holiday WHERE holiday_date = $1 AND psychologist_id = $2", [date, tenant(c)]);
        return avail.getAvailableSlotsForDoctor(c.db, t.id, date, !!holiday, c.query.get("mode"), qDuration(c));
    });

    // ── Complete a session: notes + session status + next follow-up, atomically ──
    post("/appointments/:id/complete", "user", async (c) =>
        wf.completeSession(pathId(c.params.id), tenant(c), c.me(), await c.optionalBody()));

    // ── Client lookup & case status ──────────────────────────────────────────
    // Registered before dashboard.ts's GET /patients/:id so "lookup" isn't read as an id.
    get("/patients/lookup", "user", async (c) => {
        const phone = (c.query.get("phone") ?? "").trim();
        if (!phone) throw badRequest("Invalid value for 'phone'.");
        const p = await c.db.one<Patient & { lastSessionDate: string | null; sessions: number }>(
            `SELECT p.*, (SELECT max(a.appointment_date) FROM appointment a WHERE a.patient_id = p.id AND a.status = 'COMPLETED') AS last_session_date,
                    (SELECT count(*) FROM appointment a WHERE a.patient_id = p.id AND a.status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING')) AS sessions
               FROM patient p WHERE p.phone = $1 AND p.primary_psychologist_id = $2`, [phone, tenant(c)]);
        return { exists: !!p, patient: p };
    });

    patch("/patients/:id/case-status", "user", async (c) => {
        const body = await c.body();
        return wf.setCaseStatus(tenant(c), c.me(), pathId(c.params.id), body.caseStatus, optStr(body, "reason"));
    });

    get("/patients/:id/case-history", "user", async (c) => {
        const id = pathId(c.params.id);
        const t = tenant(c);
        return {
            statusLog: await wf.getCaseStatusLog(c.db, id, t),
            followUps: await wf.listFollowUps(c.db, t, { patientId: id }),
        };
    });

    post("/patients/:id/follow-up", "user", async (c) =>
        wf.createFollowUpForClient(tenant(c), c.me(), pathId(c.params.id), await c.body()));

    // ── Follow-ups ───────────────────────────────────────────────────────────
    get("/follow-ups", "user", async (c) => {
        const doctor = c.query.get("doctorId");
        return wf.listFollowUps(c.db, tenant(c), {
            doctorId: doctor ? pathId(doctor, "doctorId") : null,
            openOnly: c.query.get("open") === "true",
            from: c.query.get("from") ? parseDate(c.query.get("from"), "from") : null,
            to: c.query.get("to") ? parseDate(c.query.get("to"), "to") : null,
        });
    });

    post("/follow-ups", "user", async (c) => {
        const body = await c.body();
        const patientId = optInt(body, "patientId");
        if (patientId === null) throw badRequest("patientId must not be null");
        return wf.createFollowUpForClient(tenant(c), c.me(), patientId, body);
    });

    patch("/follow-ups/:id", "user", async (c) => wf.updateFollowUp(c.db, pathId(c.params.id), tenant(c), await c.body()));

    post("/follow-ups/:id/book", "user", async (c) => {
        const body = await c.body();
        const date = parseDate(body.appointmentDate, "appointmentDate");
        const mins = timeToMinutes(body.startTime);
        if (mins === null) throw badRequest("startTime must not be null");
        return tx((db) => wf.bookFollowUp(db, pathId(c.params.id), tenant(c), c.me(), {
            appointmentDate: date, startTime: minutesToTime(mins), staffId: optInt(body, "staffId"), mode: optStr(body, "mode"),
            sessionType: optStr(body, "sessionType"), durationMinutes: optInt(body, "durationMinutes"),
            paymentHandledBy: optStr(body, "paymentHandledBy"),
        }));
    });

    post("/follow-ups/:id/done", "user", async (c) => wf.markFollowUpDone(c.db, pathId(c.params.id), tenant(c)));

    del("/follow-ups/:id", "user", async (c) => {
        await wf.cancelFollowUp(c.db, pathId(c.params.id), tenant(c));
        return noContent();
    });

    // ── Monthly / Management report (clinic-wide; needs the ANALYTICS permission) ──
    get("/reports/monthly", "user", async (c) => {
        // Revenue is only for people who may see Billing — the permission filter
        // already gated ANALYTICS; this keeps money out of a non-billing reader's report.
        return buildMonthlyReport(c.db, tenant(c), c.query.get("month"), null, true);
    });

    // ── /me/** : the signed-in therapist's own dashboard ─────────────────────
    get("/me/schedule", "user", async (c) => {
        const from = c.query.get("from") ? parseDate(c.query.get("from"), "from") : today();
        const to = c.query.get("to") ? parseDate(c.query.get("to"), "to") : addDays(from, 14);
        if (to < from) throw badRequest("'to' must not be before 'from'.");
        if (to > addDays(from, 366)) throw badRequest("That date range is too long — ask for a year or less.");
        return therapist.getMySchedule(c.db, c.me(), from, to, c.query.get("includeCancelled") === "true");
    });

    get("/me/clients", "user", async (c) => therapist.getMyClients(c.db, c.me()));
    get("/me/session-notes", "user", async (c) => therapist.getMySessionNotes(c.db, c.me()));
    get("/me/follow-ups", "user", async (c) => therapist.getMyFollowUps(c.db, c.me(), c.query.get("open") === "true"));

    get("/me/case-history/:patientId", "user", async (c) => therapist.getCaseHistory(c.db, c.me(), pathId(c.params.patientId, "patientId")));

    // My Session Reports — the same numbers as the clinic report, restricted to
    // this practitioner's own sessions & clients, and without revenue.
    get("/me/session-report", "user", async (c) => {
        const me = c.me();
        return buildMonthlyReport(c.db, tenantIdOf(me), c.query.get("month"), me, false);
    });

}
