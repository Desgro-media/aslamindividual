import { randomUUID } from "node:crypto";
import { Db, tx } from "../db";
import {
    JsonObject, UNREADABLE, badRequest, conflict, notBlank, notFound, oneOf, optEmail, optInt, optStr, requiredEmail,
} from "../http";
import {
    DEFAULT_SESSION_MINUTES, endOfSession, isValidDate, minutesBetween, minutesToTime, nowTs, overlaps, parseServiceDuration,
    requireValidSessionMinutes, timeToMinutes, isValidSessionMinutes,
} from "../time";
import { AppUser, Appointment, ClinicService, Lead, Patient, Roles } from "../types";
import { resolveBookablePrice } from "./availability";
import { createInvoiceForAppointment, markAppointmentInvoiceAsPaid } from "./invoices";
import { sendBookingApproved, sendBookingCancelled, sendPaymentLink } from "./notifications";
import { resolveBookableDoctorId, resolveTenantStaffId } from "./staffResolution";
import { isAccessAllowed } from "./subscription";

// ── DTO ──────────────────────────────────────────────────────────────────────

export interface AppointmentDto {
    id: number;
    patientId: number;
    patientName: string;
    patientEmail: string | null;
    patientPhone: string;
    patientCaseStatus: string;
    appointmentDate: string;
    startTime: string;
    endTime: string;
    status: string;
    trackingToken: string;
    cancellationReason: string | null;
    sessionType: string | null;
    mode: string;
    notes: string | null;
    rating: number | null;
    feedback: string | null;
    telegramConnected: boolean;
    fee: number | null;
    paymentScreenshotBase64: string | null;
    previousAppointmentId: number | null;
    returningPatient: boolean;
    psychologistId: number;
    psychologistName: string | null;
    psychologistSlug: string | null;
    assignedDoctorId: number;
    assignedDoctorName: string | null;
    assignedDoctorJobTitle: string | null;
}

interface ApptWithPatient extends Appointment {
    pName: string;
    pEmail: string | null;
    pPhone: string;
    pTelegram: string | null;
    pCaseStatus: string;
}

export const APPT_PATIENT_SQL = `
    SELECT a.*, p.name AS p_name, p.email AS p_email, p.phone AS p_phone,
           p.telegram_chat_id AS p_telegram, p.case_status AS p_case_status
      FROM appointment a JOIN patient p ON p.id = a.patient_id`;

/** Maps appointment rows to DTOs with three batched lookups (users, invoices) instead of N+1. */
export async function toDtos(db: Db, rows: ApptWithPatient[]): Promise<AppointmentDto[]> {
    if (rows.length === 0) return [];
    const userIds = [...new Set(rows.flatMap((a) => [a.psychologistId, a.assignedDoctorId ?? a.psychologistId]))];
    const users = await db.many<Pick<AppUser, "id" | "name" | "slug" | "jobTitle">>(
        "SELECT id, name, slug, job_title FROM app_user WHERE id = ANY($1::bigint[])", [userIds]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const invoices = await db.many<{ appointmentId: number; amount: number }>(
        "SELECT appointment_id, amount FROM invoice WHERE appointment_id = ANY($1::bigint[])", [rows.map((a) => a.id)]);
    const feeByAppt = new Map(invoices.map((i) => [i.appointmentId, i.amount]));

    return rows.map((a) => {
        const owner = userById.get(a.psychologistId);
        // Falls back to the tenant owner for rows from before assignedDoctorId existed.
        const doctorId = a.assignedDoctorId ?? a.psychologistId;
        const doctor = userById.get(doctorId);
        return {
            id: a.id,
            patientId: a.patientId,
            patientName: a.pName,
            patientEmail: a.pEmail,
            patientPhone: a.pPhone,
            patientCaseStatus: a.pCaseStatus,
            appointmentDate: a.appointmentDate,
            startTime: a.startTime,
            endTime: a.endTime,
            status: a.status,
            trackingToken: a.trackingToken,
            cancellationReason: a.cancellationReason,
            sessionType: a.sessionType,
            mode: a.mode ?? "OFFLINE",
            notes: a.notes,
            rating: a.rating,
            feedback: a.feedback,
            telegramConnected: !!a.pTelegram && a.pTelegram.length > 0,
            fee: feeByAppt.get(a.id) ?? null,
            paymentScreenshotBase64: a.paymentScreenshotBase64,
            previousAppointmentId: a.previousAppointmentId,
            returningPatient: a.previousAppointmentId !== null,
            psychologistId: a.psychologistId,
            psychologistName: owner?.name ?? null,
            psychologistSlug: owner?.slug ?? null,
            assignedDoctorId: doctorId,
            assignedDoctorName: doctor?.name ?? null,
            assignedDoctorJobTitle: doctor?.jobTitle ?? null,
        };
    });
}

export async function dtoById(db: Db, id: number): Promise<AppointmentDto> {
    const row = await db.one<ApptWithPatient>(`${APPT_PATIENT_SQL} WHERE a.id = $1`, [id]);
    if (!row) throw notFound(`Appointment not found: ${id}`);
    return (await toDtos(db, [row]))[0];
}

const ALL_STATUSES = ["PENDING", "AWAITING_PAYMENT", "PAYMENT_UNDER_REVIEW", "CONFIRMED", "COMPLETED", "CANCELLED", "DEMO_CALL_PENDING"];

const newToken = () => randomUUID().replace(/-/g, "").substring(0, 25);

// ── Requests ─────────────────────────────────────────────────────────────────

export interface BookingRequest {
    patientName: string;
    patientEmail: string | null;
    patientPhone: string;
    appointmentDate: string;
    startTime: string; // "HH:mm:ss"
    sessionType: string | null;
    notes: string | null;
    mode: string | null;
    slug?: string;
    staffId?: number | null;
}

function requireDateField(body: JsonObject, field: string): string {
    const v = body[field];
    if (v === undefined || v === null || v === "") throw badRequest(`${field} must not be null`);
    if (!isValidDate(v)) throw badRequest(UNREADABLE);
    return v as string;
}

function requireTimeField(body: JsonObject, field: string): string {
    const v = body[field];
    if (v === undefined || v === null || v === "") throw badRequest(`${field} must not be null`);
    const mins = timeToMinutes(v);
    if (mins === null) throw badRequest(UNREADABLE);
    return minutesToTime(mins);
}

const MODE_MSG = "Mode must be ONLINE or OFFLINE";

export function parseBookingRequest(body: JsonObject, opts: { requireSlug: boolean }): BookingRequest {
    const patientName = notBlank(body, "patientName", 150);
    const patientEmail = optEmail(body, "patientEmail", 150);
    const patientPhone = notBlank(body, "patientPhone", 30);
    const appointmentDate = requireDateField(body, "appointmentDate");
    const startTime = requireTimeField(body, "startTime");
    const sessionType = optStr(body, "sessionType", 30);
    const notes = optStr(body, "notes", 2000);
    const mode = oneOf(body, "mode", ["ONLINE", "OFFLINE"], MODE_MSG);
    const slug = opts.requireSlug ? notBlank(body, "slug", 100) : undefined;
    return { patientName, patientEmail, patientPhone, appointmentDate, startTime, sessionType, notes, mode, slug, staffId: optInt(body, "staffId") };
}

export interface ManualBookingRequest extends BookingRequest {
    paymentHandledBy: string | null;
    durationMinutes: number | null;
}

export function parseManualBookingRequest(body: JsonObject): ManualBookingRequest {
    const patientName = notBlank(body, "patientName", 150);
    const patientEmail = optStr(body, "patientEmail", 150);
    const patientPhone = notBlank(body, "patientPhone", 30);
    const appointmentDate = requireDateField(body, "appointmentDate");
    const startTime = requireTimeField(body, "startTime");
    const sessionType = optStr(body, "sessionType", 30);
    const notes = optStr(body, "notes", 2000);
    const mode = oneOf(body, "mode", ["ONLINE", "OFFLINE"], MODE_MSG);
    const staffId = optInt(body, "staffId");
    const paymentHandledBy = oneOf(body, "paymentHandledBy", ["SELF", "RECEPTION"], "Payment handler must be SELF or RECEPTION");
    const durationMinutes = optInt(body, "durationMinutes");
    if (durationMinutes !== null) {
        if (durationMinutes < 15) throw badRequest("Session length must be at least 15 minutes");
        if (durationMinutes > 240) throw badRequest("Session length can't be more than 240 minutes");
    }
    return { patientName, patientEmail, patientPhone, appointmentDate, startTime, sessionType, notes, mode, staffId, paymentHandledBy, durationMinutes };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function requireAcceptingBookings(db: Db, tenantId: number): Promise<void> {
    if (!(await isAccessAllowed(db, tenantId))) {
        throw conflict("This practitioner isn't currently accepting new bookings.");
    }
}

// The selected service's own length (its free-text duration); default 60. Only
// the DEFAULT — the practitioner can override it per appointment.
async function resolveSessionDurationMinutes(db: Db, sessionType: string | null, ownerId: number): Promise<number> {
    if (sessionType === null || !/^[+-]?\d+$/.test(sessionType)) return DEFAULT_SESSION_MINUTES;
    const svc = await db.one<ClinicService>(
        "SELECT * FROM clinic_service WHERE id = $1 AND psychologist_id = $2", [Number(sessionType), ownerId]);
    return svc ? parseServiceDuration(svc.duration) : DEFAULT_SESSION_MINUTES;
}

// Authoritative calendar-conflict check for one practitioner on one date.
// Mode-agnostic on purpose (one person can't run two sessions at once) and keyed
// by the specific practitioner, not the tenant.
async function assertSlotFree(
    db: Db, doctorId: number, date: string, startMin: number, endMin: number,
    excludeAppointmentId: number | null, conflictMessage: string
): Promise<void> {
    const rows = await db.many<Appointment>(
        "SELECT * FROM appointment WHERE appointment_date = $1 AND assigned_doctor_id = $2 AND status <> 'CANCELLED'",
        [date, doctorId]
    );
    const clash = rows
        .filter((a) => excludeAppointmentId === null || a.id !== excludeAppointmentId)
        .some((a) => overlaps(startMin, endMin, timeToMinutes(a.startTime)!, timeToMinutes(a.endTime)!));
    if (clash) throw conflict(conflictMessage);
}

// Serialises bookings per practitioner (other doctors are unaffected): the
// overlap check is read-then-insert, so two simultaneous requests for the same
// doctor could otherwise both see a free slot and both insert.
async function lockPractitioner(db: Db, doctorId: number): Promise<void> {
    await db.query("SELECT id FROM app_user WHERE id = $1 FOR UPDATE", [doctorId]);
}

async function findOrCreatePatient(db: Db, tenantId: number, name: string, email: string | null, phone: string): Promise<Patient> {
    const found = await db.one<Patient>("SELECT * FROM patient WHERE phone = $1 AND primary_psychologist_id = $2", [phone, tenantId]);
    if (found) return found;
    try {
        return await db.insert<Patient>("patient", {
            name, email, phone, primaryPsychologistId: tenantId, riskFlag: false, source: "Direct",
        });
    } catch (err) {
        // A concurrent request created the same client between our SELECT and INSERT.
        if ((err as { code?: string }).code === "23505") {
            const again = await db.one<Patient>("SELECT * FROM patient WHERE phone = $1 AND primary_psychologist_id = $2", [phone, tenantId]);
            if (again) return again;
        }
        throw err;
    }
}

export interface ScheduleOptions {
    /** the practitioner-chosen session length, or null to use the service's own */
    requestedDurationMinutes: number | null;
    /** passed to the front desk instead of the patient paying online */
    toReception: boolean;
}

/**
 * Book a session under a tenant for a specific practitioner. Used by the public
 * booking link, dashboard manual scheduling, rebooking, and follow-up booking —
 * so slot locking, pricing validation, invoicing and notifications can never
 * drift between those paths.
 */
export async function bookAppointmentForOwner(
    db: Db, request: BookingRequest, tenantId: number, assignedDoctorId: number, opts: ScheduleOptions
): Promise<AppointmentDto> {
    // 1. Find or create the patient (identified by phone, scoped to this tenant)
    const normalizedEmail = request.patientEmail && request.patientEmail.trim() ? request.patientEmail.trim() : null;
    const patient = await findOrCreatePatient(db, tenantId, request.patientName, normalizedEmail, request.patientPhone);

    // 2. Session duration — the practitioner's explicit pick, else the service's own
    const slotDuration = opts.requestedDurationMinutes !== null
        ? requireValidSessionMinutes(opts.requestedDurationMinutes)
        : await resolveSessionDurationMinutes(db, request.sessionType, tenantId);

    // 2b. Validate mode against what this doctor actually offers BEFORE
    // anything is persisted — fail closed. Also closes the trust boundary on a
    // client-supplied sessionType the doctor never opted into.
    const mode = request.mode ?? "OFFLINE";
    if (request.sessionType !== null && /^[+-]?\d+$/.test(request.sessionType)) {
        await resolveBookablePrice(db, tenantId, assignedDoctorId, Number(request.sessionType), mode);
    }

    // 2c. Reject if this exact slot was just taken (same-transaction, authoritative)
    const startMin = timeToMinutes(request.startTime)!;
    const endMin = endOfSession(startMin, slotDuration);
    await lockPractitioner(db, assignedDoctorId);
    await assertSlotFree(db, assignedDoctorId, request.appointmentDate, startMin, endMin, null,
        "This slot was just booked — please choose another time.");

    // 4. Link to the patient's last active session for journey tracking
    const prev = await db.one<{ id: number }>(
        `SELECT id FROM appointment WHERE patient_id = $1 AND status <> 'CANCELLED'
          ORDER BY appointment_date DESC, start_time DESC LIMIT 1`, [patient.id]);

    // 5. Save. A walk-in passed to reception is happening regardless of when the
    // balance gets settled — confirm immediately and track the money via the invoice.
    let appt = await db.insert<Appointment>("appointment", {
        patientId: patient.id,
        appointmentDate: request.appointmentDate,
        startTime: request.startTime,
        endTime: minutesToTime(endMin),
        status: opts.toReception ? "CONFIRMED" : "AWAITING_PAYMENT",
        trackingToken: newToken(),
        sessionType: request.sessionType,
        mode,
        notes: request.notes,
        previousAppointmentId: prev?.id ?? null,
        psychologistId: tenantId,
        assignedDoctorId,
    });

    // 5b. If this contact submitted the booking form's first step as a lead,
    // this booking is that lead converting.
    await convertLead(db, request.patientPhone, tenantId, patient.id, appt.id);

    // 6. Invoice — per-doctor, per-mode pricing
    const invoice = await createInvoiceForAppointment(db, appt.id, null, opts.toReception ? "RECEPTION" : "SELF");

    const notice = {
        name: patient.name, email: patient.email, phone: patient.phone,
        date: appt.appointmentDate, time: appt.startTime, token: appt.trackingToken,
    };
    // Free service, or payment deferred to reception — already confirmed, just
    // notify. Otherwise it stays AWAITING_PAYMENT until the patient pays online.
    if (opts.toReception || !invoice.amount) {
        if (appt.status !== "CONFIRMED") {
            appt = await db.update<Appointment>("appointment", appt.id, { status: "CONFIRMED" });
        }
        db.after(() => sendBookingApproved(notice));
    } else {
        db.after(() => sendPaymentLink(notice));
    }
    return dtoById(db, appt.id);
}

async function convertLead(db: Db, phone: string, practitionerId: number, patientId: number, appointmentId: number): Promise<void> {
    const lead = await db.one<Lead>(
        `SELECT * FROM lead WHERE phone = $1 AND practitioner_id = $2 AND status = 'NEW' ORDER BY created_at DESC LIMIT 1`,
        [phone, practitionerId]);
    if (lead) {
        await db.update("lead", lead.id, { status: "CONVERTED", patientId, appointmentId, convertedAt: nowTs() });
    }
}

// ── Public booking ───────────────────────────────────────────────────────────

export async function bookAppointment(request: BookingRequest): Promise<AppointmentDto> {
    return tx(async (db) => {
        const owner = await db.one<AppUser>("SELECT * FROM app_user WHERE slug = $1 AND role = $2", [request.slug, Roles.PSYCHOLOGIST]);
        if (!owner) throw notFound("No such booking link");
        await requireAcceptingBookings(db, owner.id);
        // Validates request.staffId belongs to this clinic and is actually bookable.
        const assignedDoctorId = await resolveBookableDoctorId(db, owner, request.staffId ?? null);
        // A public booking never gets a custom length or deferred payment.
        return bookAppointmentForOwner(db, request, owner.id, assignedDoctorId, { requestedDurationMinutes: null, toReception: false });
    });
}

/**
 * Which practitioner a dashboard-scheduled session goes to. An explicit staffId
 * is validated against the caller's tenant; with none, it defaults to the
 * caller's own calendar — but only if the caller actually IS a practitioner. A
 * receptionist has no calendar of their own, so they must name a therapist
 * (otherwise a session would be silently assigned to the front desk login).
 */
export async function resolveSchedulingDoctor(db: Db, caller: AppUser, tenantId: number, requestedStaffId: number | null): Promise<number> {
    if (requestedStaffId === null && caller.tenantId !== null && caller.role !== Roles.PSYCHOLOGIST) {
        throw badRequest("Select a therapist for this session.");
    }
    return resolveTenantStaffId(db, tenantId, caller.id, requestedStaffId);
}

export async function scheduleManually(request: ManualBookingRequest, caller: AppUser, tenantId: number): Promise<AppointmentDto> {
    return tx(async (db) => {
        const assignedDoctorId = await resolveSchedulingDoctor(db, caller, tenantId, request.staffId ?? null);
        // Only meaningful here — the staff member explicitly chose "pass to reception".
        return bookAppointmentForOwner(db, request, tenantId, assignedDoctorId, {
            requestedDurationMinutes: request.durationMinutes,
            toReception: request.paymentHandledBy === "RECEPTION",
        });
    });
}

// ── Tracking (public, by token) ──────────────────────────────────────────────

export async function getAppointmentByToken(db: Db, token: string): Promise<AppointmentDto> {
    const row = await db.one<ApptWithPatient>(`${APPT_PATIENT_SQL} WHERE a.tracking_token = $1`, [token]);
    if (!row) throw notFound(`Appointment not found for token: ${token}`);
    return (await toDtos(db, [row]))[0];
}

export async function rebookAppointment(token: string, newDate: string, newStartTime: string): Promise<AppointmentDto> {
    return tx(async (db) => {
        const old = await db.one<Appointment & { pName: string; pEmail: string | null; pPhone: string }>(
            `SELECT a.*, p.name AS p_name, p.email AS p_email, p.phone AS p_phone
               FROM appointment a JOIN patient p ON p.id = a.patient_id WHERE a.tracking_token = $1`, [token]);
        if (!old) throw notFound("Appointment not found");
        if (old.status !== "CANCELLED") throw conflict("Only CANCELLED appointments can be rebooked");

        // Tenant AND the specific practitioner are carried over from the existing
        // (already-verified) appointment — a rebook must land back with the same
        // doctor — and so is the session length the practitioner may have set.
        const doctorId = old.assignedDoctorId ?? old.psychologistId;
        const originalMinutes = minutesBetween(old.startTime, old.endTime);
        const carried = isValidSessionMinutes(originalMinutes) ? originalMinutes : null;
        return bookAppointmentForOwner(db, {
            patientName: old.pName, patientEmail: old.pEmail, patientPhone: old.pPhone,
            appointmentDate: newDate, startTime: newStartTime, sessionType: old.sessionType,
            mode: old.mode, notes: old.notes,
        }, old.psychologistId, doctorId, { requestedDurationMinutes: carried, toReception: false });
    });
}

// ── Dashboard reads ──────────────────────────────────────────────────────────

export async function getAppointmentsByTenant(db: Db, tenantId: number): Promise<AppointmentDto[]> {
    const rows = await db.many<ApptWithPatient>(`${APPT_PATIENT_SQL} WHERE a.psychologist_id = $1 ORDER BY a.id`, [tenantId]);
    return toDtos(db, rows);
}

export async function getAppointmentsByPatient(db: Db, patientId: number, tenantId: number): Promise<AppointmentDto[]> {
    const rows = await db.many<ApptWithPatient>(
        `${APPT_PATIENT_SQL} WHERE a.patient_id = $1 AND a.psychologist_id = $2 ORDER BY a.appointment_date DESC, a.start_time DESC`,
        [patientId, tenantId]);
    return toDtos(db, rows);
}

export async function requireOwnedAppointment(db: Db, id: number, tenantId: number): Promise<Appointment> {
    const a = await db.one<Appointment>("SELECT * FROM appointment WHERE id = $1 AND psychologist_id = $2", [id, tenantId]);
    if (!a) throw notFound(`Appointment not found: ${id}`);
    return a;
}

// ── Status changes ───────────────────────────────────────────────────────────

async function noticeFor(db: Db, appt: Appointment) {
    const p = await db.one<Patient>("SELECT * FROM patient WHERE id = $1", [appt.patientId]);
    return {
        name: p!.name, email: p!.email, phone: p!.phone,
        date: appt.appointmentDate ?? "TBD", time: appt.startTime ?? "TBD", token: appt.trackingToken,
    };
}

/** Confirm / cancel / complete / re-open an appointment. */
export async function updateAppointmentStatus(
    db: Db, id: number, ownerId: number, status: string, cancellationReason: string | null, fee: number | null
): Promise<AppointmentDto> {
    if (!ALL_STATUSES.includes(status)) throw badRequest(`Invalid status: ${status}`);
    await requireOwnedAppointment(db, id, ownerId);

    let appt = await db.update<Appointment>("appointment", id, {
        status,
        cancellationReason: status === "CANCELLED" && cancellationReason !== null ? cancellationReason : undefined,
    });
    const notice = await noticeFor(db, appt);

    if (status === "AWAITING_PAYMENT") {
        const inv = await createInvoiceForAppointment(db, id, fee);
        if (!inv.amount) {
            appt = await db.update<Appointment>("appointment", id, { status: "CONFIRMED" });
            db.after(() => sendBookingApproved(notice));
        } else {
            db.after(() => sendPaymentLink(notice));
        }
    } else if (status === "CONFIRMED") {
        await markAppointmentInvoiceAsPaid(db, id, "MANUAL_TRANSFER");
        db.after(() => sendBookingApproved(notice));
    } else if (status === "CANCELLED") {
        const reason = appt.cancellationReason;
        db.after(() => sendBookingCancelled(notice, reason));
        // A follow-up booked on this session goes back to "needs scheduling".
        await db.exec(
            "UPDATE follow_up SET status = 'PENDING', appointment_id = NULL, updated_at = $2 WHERE appointment_id = $1 AND status = 'BOOKED'",
            [id, nowTs()]);
    } else if (status === "COMPLETED") {
        await createInvoiceForAppointment(db, id);
        await db.exec(
            "UPDATE follow_up SET status = 'DONE', updated_at = $2 WHERE appointment_id = $1 AND status = 'BOOKED'",
            [id, nowTs()]);
    }
    return dtoById(db, appt.id);
}

export async function reportPaymentMade(token: string, screenshot: string | null): Promise<AppointmentDto> {
    return tx(async (db) => {
        const appt = await db.one<Appointment>("SELECT * FROM appointment WHERE tracking_token = $1", [token]);
        if (!appt) throw notFound("Appointment not found");
        if (appt.status !== "AWAITING_PAYMENT" && appt.status !== "PENDING") throw conflict("Appointment is not awaiting payment");
        await db.update("appointment", appt.id, { status: "PAYMENT_UNDER_REVIEW", paymentScreenshotBase64: screenshot });
        return dtoById(db, appt.id);
    });
}

export async function updateAppointmentNotes(db: Db, id: number, ownerId: number, notes: string | null): Promise<AppointmentDto> {
    await requireOwnedAppointment(db, id, ownerId);
    await db.update("appointment", id, { notes });
    return dtoById(db, id);
}

export async function submitRating(db: Db, token: string, rating: number | null, feedback: string | null): Promise<AppointmentDto> {
    const appt = await db.one<Appointment>("SELECT * FROM appointment WHERE tracking_token = $1", [token]);
    if (!appt) throw notFound("Invalid tracking token.");
    if (appt.status !== "COMPLETED") throw conflict("Only completed sessions can be rated.");
    await db.update("appointment", appt.id, { rating, feedback });
    return dtoById(db, appt.id);
}

// ── Demo calls ───────────────────────────────────────────────────────────────

export interface DemoBookingRequest {
    patientName: string; patientEmail: string; patientPhone: string;
    serviceInterest: string | null; preferredTime: string | null; notes: string | null; slug: string;
}

export function parseDemoRequest(body: JsonObject): DemoBookingRequest {
    return {
        patientName: notBlank(body, "patientName"),
        patientEmail: requiredEmail(body, "patientEmail"),
        patientPhone: notBlank(body, "patientPhone"),
        serviceInterest: optStr(body, "serviceInterest"),
        preferredTime: optStr(body, "preferredTime"),
        notes: optStr(body, "notes"),
        slug: notBlank(body, "slug"),
    };
}

export async function requestDemoCall(request: DemoBookingRequest): Promise<AppointmentDto> {
    return tx(async (db) => {
        const owner = await db.one<AppUser>("SELECT * FROM app_user WHERE slug = $1 AND role = $2", [request.slug, Roles.PSYCHOLOGIST]);
        if (!owner) throw notFound("No such booking link");
        await requireAcceptingBookings(db, owner.id);

        const demoEmail = request.patientEmail && request.patientEmail.trim() ? request.patientEmail.trim() : null;
        const patient = await findOrCreatePatient(db, owner.id, request.patientName, demoEmail, request.patientPhone);

        const pref = request.preferredTime;
        const combinedNotes = pref && pref.trim()
            ? "Preferred time: " + pref + (request.notes && request.notes.trim() ? "\n" + request.notes : "")
            : request.notes;

        // Placeholder date/time until the demo is converted into a real appointment.
        const appt = await db.insert<Appointment>("appointment", {
            patientId: patient.id, status: "DEMO_CALL_PENDING", trackingToken: newToken(),
            sessionType: request.serviceInterest, notes: combinedNotes,
            appointmentDate: "1970-01-01", startTime: "00:00:00", endTime: "00:00:00",
            psychologistId: owner.id,
        });
        return dtoById(db, appt.id);
    });
}

export interface ConvertDemoRequest {
    appointmentDate: string; startTime: string; sessionType: string | null; staffId: number | null; mode: string | null;
}

export function parseConvertRequest(body: JsonObject): ConvertDemoRequest {
    return {
        appointmentDate: requireDateField(body, "appointmentDate"),
        startTime: requireTimeField(body, "startTime"),
        sessionType: optStr(body, "sessionType"),
        staffId: optInt(body, "staffId"),
        mode: optStr(body, "mode"),
    };
}

export async function convertDemoToAppointment(id: number, caller: AppUser, tenantId: number, request: ConvertDemoRequest): Promise<AppointmentDto> {
    return tx(async (db) => {
        let appt = await requireOwnedAppointment(db, id, tenantId);
        if (appt.status !== "DEMO_CALL_PENDING") throw conflict("Only demo call requests can be converted to appointments");

        const slotDuration = await resolveSessionDurationMinutes(db, request.sessionType, tenantId);
        // The converting practitioner's own calendar is the fallback — not the
        // clinic owner's (the previous behaviour mis-attributed the session).
        const assignedDoctorId = await resolveSchedulingDoctor(db, caller, tenantId, request.staffId);

        const resolvedSessionType = request.sessionType && request.sessionType.trim() ? request.sessionType : appt.sessionType;
        const mode = request.mode ?? "OFFLINE";
        if (resolvedSessionType !== null && /^[+-]?\d+$/.test(resolvedSessionType)) {
            await resolveBookablePrice(db, tenantId, assignedDoctorId, Number(resolvedSessionType), mode);
        }

        const startMin = timeToMinutes(request.startTime)!;
        appt = await db.update<Appointment>("appointment", id, {
            appointmentDate: request.appointmentDate,
            startTime: request.startTime,
            endTime: minutesToTime(endOfSession(startMin, slotDuration)),
            sessionType: resolvedSessionType, mode, assignedDoctorId, status: "AWAITING_PAYMENT",
        });
        const invoice = await createInvoiceForAppointment(db, appt.id);
        const notice = await noticeFor(db, appt);
        if (!invoice.amount) {
            appt = await db.update<Appointment>("appointment", id, { status: "CONFIRMED" });
            db.after(() => sendBookingApproved(notice));
        } else {
            db.after(() => sendPaymentLink(notice));
        }
        return dtoById(db, appt.id);
    });
}

// ── Delete / edit / past sessions ────────────────────────────────────────────

export async function deleteAppointment(id: number, ownerId: number): Promise<void> {
    await tx(async (db) => {
        await requireOwnedAppointment(db, id, ownerId);
        await db.exec("DELETE FROM notification_log WHERE appointment_id = $1", [id]);
        await db.exec("DELETE FROM session_note WHERE appointment_id = $1", [id]);
        await db.exec("DELETE FROM mood_log WHERE appointment_id = $1", [id]);
        await db.exec("DELETE FROM invoice_payment WHERE invoice_id IN (SELECT id FROM invoice WHERE appointment_id = $1)", [id]);
        await db.exec("DELETE FROM invoice WHERE appointment_id = $1", [id]);
        await db.exec("DELETE FROM rebook_request WHERE original_appointment_id = $1 OR new_appointment_id = $1", [id]);
        // Workflow records that pointed at this session stay valid, just unlinked.
        await db.exec(
            "UPDATE follow_up SET status = 'PENDING', appointment_id = NULL, updated_at = $2 WHERE appointment_id = $1 AND status = 'BOOKED'",
            [id, nowTs()]);
        await db.exec("UPDATE follow_up SET source_appointment_id = NULL WHERE source_appointment_id = $1", [id]);
        await db.exec("UPDATE case_status_log SET appointment_id = NULL WHERE appointment_id = $1", [id]);
        await db.exec("UPDATE appointment SET previous_appointment_id = NULL WHERE previous_appointment_id = $1", [id]);
        await db.exec("DELETE FROM appointment WHERE id = $1", [id]);
    });
}

/**
 * Edit an appointment. `durationMinutes` null keeps whatever length the
 * appointment already has (a notes-only edit must never reset a custom length).
 */
export async function updateAppointmentDetails(
    id: number, ownerId: number, date: string | null, startTime: string | null, sessionType: string | null,
    notes: string | null, mode: string | null, durationMinutes: number | null
): Promise<AppointmentDto> {
    return tx(async (db) => {
        const appt = await requireOwnedAppointment(db, id, ownerId);
        if (mode !== null && mode !== "ONLINE" && mode !== "OFFLINE") throw badRequest("Mode must be ONLINE or OFFLINE");

        const changes: Record<string, unknown> = {};
        if (date !== null || startTime !== null || durationMinutes !== null) {
            const newDate = date ?? appt.appointmentDate;
            const newStart = startTime ?? appt.startTime;
            const currentMinutes = minutesBetween(appt.startTime, appt.endTime);
            let minutes: number;
            if (durationMinutes !== null) minutes = requireValidSessionMinutes(durationMinutes);
            else if (isValidSessionMinutes(currentMinutes)) minutes = currentMinutes; // keep the practitioner's length
            else minutes = await resolveSessionDurationMinutes(db, sessionType ?? appt.sessionType, ownerId); // placeholder row
            const startMin = timeToMinutes(newStart)!;
            const endMin = endOfSession(startMin, minutes);
            const newEndTime = minutesToTime(endMin);
            const newStartTime = minutesToTime(startMin);

            // Only re-check the calendar if the occupied range actually moved.
            const rangeChanged = newDate !== appt.appointmentDate
                || timeToMinutes(newStart) !== timeToMinutes(appt.startTime) || newEndTime !== minutesToTime(timeToMinutes(appt.endTime)!);
            if (rangeChanged && appt.status !== "CANCELLED") {
                const doctorId = appt.assignedDoctorId ?? appt.psychologistId;
                await lockPractitioner(db, doctorId);
                await assertSlotFree(db, doctorId, newDate, startMin, endMin, appt.id,
                    "That time overlaps another session on this doctor's calendar — choose a different time or a shorter session length.");
            }
            changes.appointmentDate = newDate;
            changes.startTime = newStartTime;
            changes.endTime = newEndTime;
            // Keep a booked follow-up's due date in step with its session.
            await db.exec(
                "UPDATE follow_up SET due_date = $2, due_time = $3, updated_at = $4 WHERE appointment_id = $1 AND status = 'BOOKED'",
                [id, newDate, newStartTime, nowTs()]);
        }
        if (sessionType !== null) changes.sessionType = sessionType;
        if (mode !== null) changes.mode = mode;
        if (notes !== null) changes.notes = notes;
        await db.update("appointment", id, changes);
        return dtoById(db, id);
    });
}

/** Record a session that already happened (always under the caller's tenant). */
export async function recordPastSession(
    caller: AppUser, patientId: number, tenantId: number, requestedStaffId: number | null, date: string, time: string,
    sessionType: string | null, notes: string | null, status: string | null, mode: string | null, durationMinutes: number | null
): Promise<AppointmentDto> {
    return tx(async (db) => {
        const patient = await db.one<Patient>("SELECT * FROM patient WHERE id = $1 AND primary_psychologist_id = $2", [patientId, tenantId]);
        if (!patient) throw notFound(`Patient not found: ${patientId}`);
        if (mode !== null && mode !== "ONLINE" && mode !== "OFFLINE") throw badRequest("Mode must be ONLINE or OFFLINE");

        const slotDuration = durationMinutes !== null
            ? requireValidSessionMinutes(durationMinutes)
            : await resolveSessionDurationMinutes(db, sessionType, tenantId);
        const resolvedStatus = status && status.trim() ? status : "COMPLETED";
        if (!ALL_STATUSES.includes(resolvedStatus)) throw badRequest(`Invalid status: ${resolvedStatus}`);
        const assignedDoctorId = await resolveSchedulingDoctor(db, caller, tenantId, requestedStaffId);

        // Records something that already happened, possibly under a service/mode
        // combo the doctor no longer offers — no live-booking price validation;
        // invoice creation degrades to a zero fee if the combo can't be resolved.
        const startMin = timeToMinutes(time)!;
        const appt = await db.insert<Appointment>("appointment", {
            patientId: patient.id, appointmentDate: date, startTime: minutesToTime(startMin),
            endTime: minutesToTime(endOfSession(startMin, slotDuration)),
            status: resolvedStatus, sessionType, mode: mode ?? "OFFLINE", notes,
            trackingToken: newToken(), psychologistId: tenantId, assignedDoctorId,
        });
        await createInvoiceForAppointment(db, appt.id);
        return dtoById(db, appt.id);
    });
}

