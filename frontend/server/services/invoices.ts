import type { Db } from "../db";
import { ApiError, badRequest, conflict, notFound } from "../http";
import { nowTs, today } from "../time";
import { Appointment, ClinicSettings, Invoice, InvoicePayment } from "../types";
import { resolveBookablePrice } from "./availability";
import { sendPaymentLink } from "./notifications";

// ── Money helpers ────────────────────────────────────────────────────────────
// Amounts are rupees with 2 decimals. Every operation re-rounds to paise so
// binary floating point can never leave a balance of 0.0000001.
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const nvl = (n: number | null | undefined) => (n === null || n === undefined ? 0 : n);
const max0 = (n: number) => (n > 0 ? n : 0);

export interface InvoiceDto {
    id: number;
    appointmentId: number;
    patientId: number;
    patientName: string;
    patientEmail: string | null;
    sessionType: string | null;
    mode: string;
    appointmentDate: string;
    amount: number;
    discountAmount: number;
    finalAmount: number;
    discountReason: string | null;
    status: string;
    paymentHandledBy: string;
    amountPaid: number;
    balanceDue: number;
    paymentMethod: string | null;
    remark: string | null;
    toAccount: string | null;
    bankAccountId: number | null;
    bankAccountName: string | null;
    paidAt: string | null;
    createdAt: string | null;
}

export interface InvoicePaymentDto {
    id: number;
    amount: number;
    paymentMethod: string | null;
    bankAccountName: string | null;
    remark: string | null;
    paidAt: string;
}

interface InvoiceJoined extends Invoice {
    aSessionType: string | null;
    aMode: string | null;
    aDate: string;
    pName: string;
    pEmail: string | null;
    paidTotal: number;
}

const JOINED_SQL = `
    SELECT i.*, a.session_type AS a_session_type, a.mode AS a_mode, a.appointment_date AS a_date,
           p.name AS p_name, p.email AS p_email,
           COALESCE((SELECT SUM(ip.amount) FROM invoice_payment ip WHERE ip.invoice_id = i.id), 0) AS paid_total
      FROM invoice i
      JOIN appointment a ON a.id = i.appointment_id
      JOIN patient p ON p.id = i.patient_id`;

// ── Bank-name resolution (for the "to account" label) ────────────────────────
async function resolveBankName(db: Db, ownerId: number): Promise<string> {
    try {
        const def = await db.one<{ accountName: string | null; bankName: string | null }>(
            "SELECT account_name, bank_name FROM bank_account WHERE psychologist_id = $1 AND is_default = true AND active = true ORDER BY id LIMIT 1",
            [ownerId]
        );
        const first = def ?? (await db.one<{ accountName: string | null; bankName: string | null }>(
            "SELECT account_name, bank_name FROM bank_account WHERE psychologist_id = $1 AND active = true ORDER BY id LIMIT 1",
            [ownerId]
        ));
        const name = first ? first.accountName ?? first.bankName : null;
        if (name && name.trim()) return name;
    } catch { /* fall through to the legacy single bank name */ }
    try {
        const s = await db.one<ClinicSettings>("SELECT * FROM clinic_settings WHERE psychologist_id = $1", [ownerId]);
        if (s?.bankAccountName && s.bankAccountName.trim()) return s.bankAccountName;
    } catch { /* ignore */ }
    return "Bank Account";
}

function toDto(inv: InvoiceJoined, bankName: string): InvoiceDto {
    const discount = nvl(inv.discountAmount);
    const finalAmount = r2(inv.amount - discount);
    const amountPaid = r2(inv.paidTotal);
    const balanceDue = inv.status === "PAID" || inv.status === "WAIVED" ? 0 : max0(r2(finalAmount - amountPaid));

    let toAccount: string | null = null;
    const settledOrInProgress = inv.status === "PAID" || inv.status === "PARTIALLY_PAID";
    if (settledOrInProgress && inv.paymentMethod) {
        if (inv.paymentMethod === "CASH") toAccount = "Cash in hand";
        else if (inv.bankAccountName && inv.bankAccountName.trim()) toAccount = inv.bankAccountName;
        else toAccount = bankName;
    }
    return {
        id: inv.id,
        appointmentId: inv.appointmentId,
        patientId: inv.patientId,
        patientName: inv.pName,
        patientEmail: inv.pEmail,
        sessionType: inv.aSessionType,
        mode: inv.aMode ?? "OFFLINE",
        appointmentDate: inv.aDate,
        amount: inv.amount,
        discountAmount: discount,
        finalAmount,
        discountReason: inv.discountReason,
        status: inv.status,
        paymentHandledBy: inv.paymentHandledBy,
        amountPaid,
        balanceDue,
        paymentMethod: inv.paymentMethod,
        remark: inv.remark,
        toAccount,
        bankAccountId: inv.bankAccountId,
        bankAccountName: inv.bankAccountName,
        paidAt: inv.paidAt,
        createdAt: inv.createdAt,
    };
}

async function loadJoined(db: Db, where: string, params: unknown[]): Promise<InvoiceJoined | null> {
    return db.one<InvoiceJoined>(`${JOINED_SQL} WHERE ${where}`, params);
}

async function dtoFor(db: Db, invoiceId: number, tenantId: number): Promise<InvoiceDto> {
    const joined = await loadJoined(db, "i.id = $1", [invoiceId]);
    if (!joined) throw notFound(`Invoice not found: ${invoiceId}`);
    return toDto(joined, await resolveBankName(db, tenantId));
}

// Optimistic lock (Invoice.version): two near-simultaneous writers on the same
// invoice can't both act on the same remaining balance — the loser gets a 409
// instead of silently over-collecting or double-settling.
async function saveInvoice(db: Db, inv: Invoice, changes: Record<string, unknown>): Promise<Invoice> {
    const entries = Object.entries({ ...changes, updatedAt: nowTs() }).filter(([, v]) => v !== undefined);
    const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
    const sets = entries.map(([k], i) => `"${toSnake(k)}" = $${i + 1}`).join(", ");
    const values = entries.map(([, v]) => v);
    const row = await db.one<Invoice>(
        `UPDATE invoice SET ${sets}, version = version + 1 WHERE id = $${entries.length + 1} AND version = $${entries.length + 2} RETURNING *`,
        [...values, inv.id, inv.version]
    );
    if (!row) throw new ApiError(409, "This record was just updated elsewhere. Please refresh and try again.");
    return row;
}

async function totalPaid(db: Db, invoiceId: number): Promise<number> {
    return r2((await db.scalar<number>("SELECT COALESCE(SUM(amount), 0) FROM invoice_payment WHERE invoice_id = $1", [invoiceId])) ?? 0);
}

async function remainingBalance(db: Db, inv: Invoice): Promise<number> {
    return max0(r2(inv.amount - nvl(inv.discountAmount) - (await totalPaid(db, inv.id))));
}

async function getInvoiceRow(db: Db, id: number, tenantId: number): Promise<Invoice> {
    const inv = await db.one<Invoice>("SELECT * FROM invoice WHERE id = $1 AND psychologist_id = $2", [id, tenantId]);
    if (!inv) throw notFound(`Invoice not found: ${id}`);
    return inv;
}

// Sync the appointment to CONFIRMED when a payment fully settles an invoice
// that was still gating confirmation on it (the online self-pay path). A no-op
// for RECEPTION-routed invoices, which are confirmed from the moment they're booked.
async function confirmAppointmentIfPending(db: Db, appointmentId: number): Promise<void> {
    await db.exec(
        `UPDATE appointment SET status = 'CONFIRMED', updated_at = $2
          WHERE id = $1 AND status IN ('AWAITING_PAYMENT', 'PAYMENT_UNDER_REVIEW', 'PENDING')`,
        [appointmentId, nowTs()]
    );
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Auto-create the invoice for an appointment (idempotent: payment routing is
 * decided once, at creation time, and never retroactively changed).
 */
export async function createInvoiceForAppointment(
    db: Db, appointmentId: number, manualFee: number | null = null, paymentHandledBy: string | null = null
): Promise<InvoiceDto> {
    const existing = await db.one<Invoice>("SELECT * FROM invoice WHERE appointment_id = $1", [appointmentId]);
    if (existing) return dtoFor(db, existing.id, existing.psychologistId);

    const appt = await db.one<Appointment>("SELECT * FROM appointment WHERE id = $1", [appointmentId]);
    if (!appt) throw notFound(`Appointment not found: ${appointmentId}`);

    let fee = 0;
    if (manualFee !== null) {
        fee = manualFee;
    } else if (appt.sessionType !== null && /^\s*[+-]?\d+\s*$/.test(appt.sessionType)) {
        // Pricing is per-PRACTITIONER (never per-tenant) — using the tenant id
        // here would silently charge every patient the clinic owner's price.
        const pricingDoctorId = appt.assignedDoctorId ?? appt.psychologistId;
        const mode = appt.mode ?? "OFFLINE";
        try {
            fee = await resolveBookablePrice(db, appt.psychologistId, pricingDoctorId, Number(appt.sessionType.trim()), mode);
        } catch (err) {
            // The doctor's offerings changed since this appointment was created
            // (demo conversion / past-session recording don't pre-validate):
            // degrade to a zero fee rather than fail; an admin can reprice.
            if (!(err instanceof ApiError && err.status === 400)) throw err;
        }
    }

    const inv = await db.insert<Invoice>("invoice", {
        psychologistId: appt.psychologistId,
        appointmentId: appt.id,
        patientId: appt.patientId,
        amount: fee,
        discountAmount: 0,
        status: "UNPAID",
        paymentHandledBy: paymentHandledBy === "RECEPTION" ? "RECEPTION" : "SELF",
        version: 0,
    });
    return dtoFor(db, inv.id, appt.psychologistId);
}

// ── Pay / collect ────────────────────────────────────────────────────────────

/**
 * Settle in full, with an optional discount — the owner/therapist action from
 * the Billing page (never a receptionist's; see the route guard).
 */
export async function markAsPaid(
    db: Db, invoiceId: number, ownerId: number, paymentMethod: string, discountAmount: number | null,
    discountReason: string | null, remark: string | null, bankAccountId: number | null,
    bankAccountName: string | null, collectedByStaffId: number
): Promise<InvoiceDto> {
    const inv = await getInvoiceRow(db, invoiceId, ownerId);
    if (inv.status === "PAID" || inv.status === "WAIVED") throw conflict(`Invoice is already ${inv.status}`);

    // A previously partially-paid invoice already has money in the ledger — the
    // discount and "collect now" apply only to what's still outstanding.
    const alreadyPaid = await totalPaid(db, inv.id);
    const existingDiscount = nvl(inv.discountAmount);
    const remainingBeforeDiscount = r2(inv.amount - existingDiscount - alreadyPaid);

    const newDiscount = discountAmount ?? 0;
    if (newDiscount < 0) throw badRequest("Discount amount cannot be negative");
    if (newDiscount > remainingBeforeDiscount) {
        throw badRequest(`Discount cannot exceed the remaining balance of ${remainingBeforeDiscount.toFixed(2)}`);
    }

    const changes: Record<string, unknown> = { paymentMethod };
    if (newDiscount > 0) changes.discountAmount = r2(existingDiscount + newDiscount);
    if (discountReason !== null) changes.discountReason = discountReason.trim() === "" ? null : discountReason.trim();
    const newRemark = remark !== null ? (remark.trim() === "" ? null : remark.trim()) : inv.remark;
    if (remark !== null) changes.remark = newRemark;
    if (bankAccountId !== null) changes.bankAccountId = bankAccountId;
    const newBankName = bankAccountName && bankAccountName.trim() ? bankAccountName.trim() : inv.bankAccountName;
    if (bankAccountName && bankAccountName.trim()) changes.bankAccountName = newBankName;

    const amountToCollectNow = r2(remainingBeforeDiscount - newDiscount);
    if (amountToCollectNow > 0) {
        await db.insert("invoice_payment", {
            invoiceId: inv.id, amount: amountToCollectNow, paymentMethod, bankAccountId,
            bankAccountName: newBankName, remark: newRemark, collectedByStaffId, paidAt: nowTs(),
        });
    }
    changes.status = "PAID";
    changes.paidAt = today();

    await confirmAppointmentIfPending(db, inv.appointmentId);
    await saveInvoice(db, inv, changes);
    return dtoFor(db, inv.id, ownerId);
}

/**
 * Record a payment — full or partial — the receptionist's collect-only action
 * (also reusable for anyone taking an installment). Never touches
 * discount/waive.
 */
export async function recordPayment(
    db: Db, invoiceId: number, tenantId: number, amount: number | null, paymentMethod: string,
    bankAccountId: number | null, bankAccountName: string | null, remark: string | null, collectedByStaffId: number
): Promise<InvoiceDto> {
    const inv = await getInvoiceRow(db, invoiceId, tenantId);
    if (inv.status === "PAID" || inv.status === "WAIVED") throw conflict(`Invoice is already ${inv.status}`);
    if (amount === null || !(amount > 0)) throw badRequest("Payment amount must be greater than zero");

    const remaining = await remainingBalance(db, inv);
    if (amount > remaining) throw badRequest(`Payment cannot exceed the remaining balance of ${remaining.toFixed(2)}`);

    await db.insert("invoice_payment", {
        invoiceId: inv.id, amount, paymentMethod, bankAccountId, bankAccountName,
        remark: remark && remark.trim() ? remark.trim() : null, collectedByStaffId, paidAt: nowTs(),
    });

    const changes: Record<string, unknown> = { paymentMethod };
    if (bankAccountId !== null) changes.bankAccountId = bankAccountId;
    if (bankAccountName && bankAccountName.trim()) changes.bankAccountName = bankAccountName.trim();

    if (r2(remaining - amount) <= 0) {
        changes.status = "PAID";
        changes.paidAt = today();
        await confirmAppointmentIfPending(db, inv.appointmentId);
    } else {
        changes.status = "PARTIALLY_PAID";
    }
    await saveInvoice(db, inv, changes);
    return dtoFor(db, inv.id, tenantId);
}

export async function getPaymentHistory(db: Db, invoiceId: number, tenantId: number): Promise<InvoicePaymentDto[]> {
    const inv = await getInvoiceRow(db, invoiceId, tenantId);
    const rows = await db.many<InvoicePayment>("SELECT * FROM invoice_payment WHERE invoice_id = $1 ORDER BY paid_at ASC", [inv.id]);
    return rows.map((p) => ({
        id: p.id, amount: p.amount, paymentMethod: p.paymentMethod, bankAccountName: p.bankAccountName,
        remark: p.remark, paidAt: p.paidAt,
    }));
}

/** Internal-only: called after the caller has already verified ownership of the appointment. */
export async function markAppointmentInvoiceAsPaid(db: Db, appointmentId: number, paymentMethod: string): Promise<void> {
    const inv = await db.one<Invoice>("SELECT * FROM invoice WHERE appointment_id = $1", [appointmentId]);
    if (!inv) return; // nothing to settle
    if (inv.status === "PAID" || inv.status === "WAIVED") return;

    const remaining = await remainingBalance(db, inv);
    if (remaining > 0) {
        await db.insert("invoice_payment", { invoiceId: inv.id, amount: remaining, paymentMethod, paidAt: nowTs() });
    }
    await saveInvoice(db, inv, { status: "PAID", paymentMethod, paidAt: today() });
}

// ── Reprice / waive ──────────────────────────────────────────────────────────

export async function updateAmount(db: Db, invoiceId: number, ownerId: number, newAmount: number | null): Promise<InvoiceDto> {
    const inv = await getInvoiceRow(db, invoiceId, ownerId);
    if (!(inv.status === "UNPAID" || inv.status === "PARTIALLY_PAID")) {
        throw conflict(`Cannot reprice an invoice that is already ${inv.status}`);
    }
    if (newAmount === null || !(newAmount > 0)) throw badRequest("Amount must be greater than zero");
    const alreadyCommitted = r2((await totalPaid(db, inv.id)) + nvl(inv.discountAmount));
    if (newAmount < alreadyCommitted) {
        throw badRequest(`Amount cannot be less than what's already been collected or discounted (${alreadyCommitted.toFixed(2)})`);
    }
    const saved = await saveInvoice(db, inv, { amount: newAmount });

    // A price set on an appointment auto-confirmed as free (CONFIRMED + UNPAID)
    // that the PATIENT must pay resets it to AWAITING_PAYMENT and sends the pay
    // link. A RECEPTION-routed invoice is excluded — its appointment is
    // confirmed by design, and emailing a "pay online" link would open a second
    // payment channel.
    const appt = await db.one<Appointment & { pName: string; pEmail: string | null; pPhone: string }>(
        `SELECT a.*, p.name AS p_name, p.email AS p_email, p.phone AS p_phone
           FROM appointment a JOIN patient p ON p.id = a.patient_id WHERE a.id = $1`, [inv.appointmentId]);
    if (appt && appt.status === "CONFIRMED" && saved.paymentHandledBy !== "RECEPTION") {
        await db.exec("UPDATE appointment SET status = 'AWAITING_PAYMENT', updated_at = $2 WHERE id = $1", [appt.id, nowTs()]);
        db.after(() => sendPaymentLink({
            name: appt.pName, email: appt.pEmail, phone: appt.pPhone,
            date: appt.appointmentDate, time: appt.startTime, token: appt.trackingToken,
        }));
    }
    return dtoFor(db, inv.id, ownerId);
}

/**
 * Waive. Money already collected stays collected — only the uncollected
 * remainder is waived (folded into discountAmount). The status only becomes the
 * bare "WAIVED" when nothing was ever collected.
 */
export async function markAsWaived(db: Db, invoiceId: number, ownerId: number): Promise<InvoiceDto> {
    const inv = await getInvoiceRow(db, invoiceId, ownerId);
    if (inv.status === "PAID" || inv.status === "WAIVED") throw conflict(`Invoice is already ${inv.status}`);

    const alreadyPaid = await totalPaid(db, inv.id);
    const remaining = await remainingBalance(db, inv);
    const changes: Record<string, unknown> = {};
    if (remaining > 0) changes.discountAmount = r2(nvl(inv.discountAmount) + remaining);
    if (alreadyPaid > 0) {
        changes.status = "PAID";
        if (!inv.paidAt) changes.paidAt = today();
    } else {
        changes.status = "WAIVED";
    }
    await confirmAppointmentIfPending(db, inv.appointmentId);
    await saveInvoice(db, inv, changes);
    return dtoFor(db, inv.id, ownerId);
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getAllInvoices(db: Db, ownerId: number): Promise<InvoiceDto[]> {
    const bank = await resolveBankName(db, ownerId);
    const rows = await db.many<InvoiceJoined>(`${JOINED_SQL} WHERE i.psychologist_id = $1 ORDER BY i.created_at DESC, i.id DESC`, [ownerId]);
    return rows.map((r) => toDto(r, bank));
}

export async function getInvoicesByPatient(db: Db, patientId: number, ownerId: number): Promise<InvoiceDto[]> {
    const bank = await resolveBankName(db, ownerId);
    const rows = await db.many<InvoiceJoined>(
        `${JOINED_SQL} WHERE i.patient_id = $1 AND i.psychologist_id = $2 ORDER BY i.created_at DESC, i.id DESC`, [patientId, ownerId]);
    return rows.map((r) => toDto(r, bank));
}

export async function getInvoiceByAppointmentId(db: Db, appointmentId: number, ownerId: number): Promise<InvoiceDto> {
    const joined = await loadJoined(db, "i.appointment_id = $1 AND i.psychologist_id = $2", [appointmentId, ownerId]);
    if (!joined) throw notFound(`Invoice not found for appointment: ${appointmentId}`);
    return toDto(joined, await resolveBankName(db, ownerId));
}

export async function getRevenueSummary(db: Db, ownerId: number): Promise<Record<string, unknown>> {
    const rows = await db.many<InvoiceJoined>(`${JOINED_SQL} WHERE i.psychologist_id = $1`, [ownerId]);
    const bal = (i: InvoiceJoined) => max0(r2(i.amount - nvl(i.discountAmount) - i.paidTotal));

    // Revenue = what was actually collected: a PAID invoice contributes
    // amount - discount; a PARTIALLY_PAID one only what's been collected so far.
    const totalRevenue = r2(rows
        .filter((i) => i.status === "PAID" || i.status === "PARTIALLY_PAID")
        .reduce((sum, i) => sum + (i.status === "PAID" ? i.amount - nvl(i.discountAmount) : i.paidTotal), 0));
    const open = rows.filter((i) => i.status === "UNPAID" || i.status === "PARTIALLY_PAID");
    return {
        totalRevenue,
        outstanding: r2(open.reduce((sum, i) => sum + bal(i), 0)),
        paidCount: rows.filter((i) => i.status === "PAID").length,
        unpaidCount: open.length,
        totalInvoices: rows.length,
    };
}
