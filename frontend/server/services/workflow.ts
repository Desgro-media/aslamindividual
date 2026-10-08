import type { Db } from "../db";
import { tx } from "../db";
import { JsonObject, badRequest, conflict, notFound, optBool, optInt, optStr } from "../http";
import { isValidDate, minutesToTime, nowTs, timeToMinutes, today } from "../time";
import { AppUser, Appointment, CASE_STATUSES, CaseStatus, CaseStatusLog, FollowUp, Patient, Roles } from "../types";
import * as appts from "./appointments";
import { saveNote, SessionNoteDto } from "./notes";

// The Psyfos session lifecycle, layered on top of the existing appointment flow:
//
//   session conducted -> notes added -> SESSION STATUS updated
//   (New Case / Ongoing / Periodic Follow-up / Terminated / Dropped)
//   -> next FOLLOW-UP date set (and optionally booked) -> records saved.
//
// Nothing here replaces an existing endpoint; it adds the case-status and
// follow-up concepts and one "complete session" operation that does all of the
// above atomically.

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
    NEW_CASE: "New Case",
    ONGOING: "Ongoing",
    PERIODIC_FOLLOW_UP: "Periodic Follow-up",
    TERMINATED: "Terminated",
    DROPPED: "Dropped",
};

export const isCaseStatus = (v: unknown): v is CaseStatus => typeof v === "string" && (CASE_STATUSES as string[]).includes(v);

/** Statuses where the client is still in care (and therefore expects follow-ups). */
export const ACTIVE_CASE_STATUSES: CaseStatus[] = ["NEW_CASE", "ONGOING", "PERIODIC_FOLLOW_UP"];

// ── Case status ──────────────────────────────────────────────────────────────

export async function requireOwnedPatient(db: Db, patientId: number, tenantId: number): Promise<Patient> {
    const p = await db.one<Patient>("SELECT * FROM patient WHERE id = $1 AND primary_psychologist_id = $2", [patientId, tenantId]);
    if (!p) throw notFound("Patient not found");
    return p;
}

export interface CaseStatusChange {
    tenantId: number;
    patientId: number;
    toStatus: CaseStatus;
    reason: string | null;
    appointmentId: number | null;
    changedBy: number | null;
}

/**
 * Move a client to a new case status. A no-op (nothing logged) when the status
 * is unchanged. Records the transition so reports and the case history can show
 * how a case progressed. Closing a case (Terminated / Dropped) withdraws any
 * follow-up that was still waiting to be scheduled.
 */
export async function changeCaseStatus(db: Db, change: CaseStatusChange): Promise<{ patient: Patient; changed: boolean }> {
    const patient = await requireOwnedPatient(db, change.patientId, change.tenantId);
    if (patient.caseStatus === change.toStatus) return { patient, changed: false };

    const updated = await db.update<Patient>("patient", patient.id, {
        caseStatus: change.toStatus,
        caseStatusUpdatedAt: nowTs(),
        caseStatusReason: change.reason,
    });
    await db.insert("case_status_log", {
        psychologistId: change.tenantId, patientId: patient.id, appointmentId: change.appointmentId,
        changedBy: change.changedBy, fromStatus: patient.caseStatus, toStatus: change.toStatus, reason: change.reason,
    });
    if (!ACTIVE_CASE_STATUSES.includes(change.toStatus)) {
        await db.exec(
            "UPDATE follow_up SET status = 'CANCELLED', updated_at = $2 WHERE patient_id = $1 AND status = 'PENDING'",
            [patient.id, nowTs()]);
    }
    return { patient: updated, changed: true };
}

export async function setCaseStatus(
    tenantId: number, caller: AppUser, patientId: number, status: unknown, reason: string | null
): Promise<Patient> {
    if (!isCaseStatus(status)) {
        throw badRequest(`Session status must be one of ${CASE_STATUSES.map((s) => CASE_STATUS_LABEL[s]).join(", ")}`);
    }
    return tx(async (db) => (await changeCaseStatus(db, {
        tenantId, patientId, toStatus: status, reason: reason && reason.trim() ? reason.trim() : null,
        appointmentId: null, changedBy: caller.id,
    })).patient);
}

export interface CaseStatusLogDto {
    id: number; patientId: number; appointmentId: number | null; appointmentDate: string | null;
    fromStatus: CaseStatus | null; toStatus: CaseStatus; reason: string | null;
    changedBy: number | null; changedByName: string | null; createdAt: string | null;
}

export async function getCaseStatusLog(db: Db, patientId: number, tenantId: number): Promise<CaseStatusLogDto[]> {
    await requireOwnedPatient(db, patientId, tenantId);
    const rows = await db.many<CaseStatusLog & { apptDate: string | null; byName: string | null }>(
        `SELECT l.*, a.appointment_date AS appt_date, u.name AS by_name
           FROM case_status_log l
           LEFT JOIN appointment a ON a.id = l.appointment_id
           LEFT JOIN app_user u ON u.id = l.changed_by
          WHERE l.patient_id = $1 AND l.psychologist_id = $2 ORDER BY l.created_at DESC, l.id DESC`, [patientId, tenantId]);
    return rows.map((r) => ({
        id: r.id, patientId: r.patientId, appointmentId: r.appointmentId, appointmentDate: r.apptDate,
        fromStatus: r.fromStatus, toStatus: r.toStatus, reason: r.reason, changedBy: r.changedBy,
        changedByName: r.byName, createdAt: r.createdAt,
    }));
}

// ── Follow-ups ───────────────────────────────────────────────────────────────

export type FollowUpBucket = "OVERDUE" | "TODAY" | "UPCOMING" | "BOOKED" | "DONE" | "CANCELLED";

export interface FollowUpDto {
    id: number; patientId: number; patientName: string; patientPhone: string; patientCaseStatus: CaseStatus;
    doctorId: number | null; doctorName: string | null; sourceAppointmentId: number | null;
    dueDate: string; dueTime: string | null; note: string | null; status: FollowUp["status"];
    bucket: FollowUpBucket; appointmentId: number | null; appointmentStatus: string | null;
    appointmentDate: string | null; appointmentStartTime: string | null; sessionType: string | null; mode: string | null;
    createdAt: string | null;
}

type FollowUpRow = FollowUp & {
    pName: string; pPhone: string; pCaseStatus: CaseStatus; doctorName: string | null;
    aStatus: string | null; aDate: string | null; aStart: string | null; srcSessionType: string | null; srcMode: string | null;
};

const FOLLOW_UP_SQL = `
    SELECT f.*, p.name AS p_name, p.phone AS p_phone, p.case_status AS p_case_status, d.name AS doctor_name,
           a.status AS a_status, a.appointment_date AS a_date, a.start_time AS a_start,
           COALESCE(a.session_type, s.session_type) AS src_session_type, COALESCE(a.mode, s.mode) AS src_mode
      FROM follow_up f
      JOIN patient p ON p.id = f.patient_id
      LEFT JOIN app_user d ON d.id = f.doctor_id
      LEFT JOIN appointment a ON a.id = f.appointment_id
      LEFT JOIN appointment s ON s.id = f.source_appointment_id`;

function bucketOf(f: FollowUp, todayStr: string): FollowUpBucket {
    if (f.status === "DONE") return "DONE";
    if (f.status === "CANCELLED") return "CANCELLED";
    if (f.status === "BOOKED") return "BOOKED";
    if (f.dueDate < todayStr) return "OVERDUE";
    if (f.dueDate === todayStr) return "TODAY";
    return "UPCOMING";
}

function toFollowUpDto(r: FollowUpRow, todayStr: string): FollowUpDto {
    return {
        id: r.id, patientId: r.patientId, patientName: r.pName, patientPhone: r.pPhone, patientCaseStatus: r.pCaseStatus,
        doctorId: r.doctorId, doctorName: r.doctorName, sourceAppointmentId: r.sourceAppointmentId,
        dueDate: r.dueDate, dueTime: r.dueTime, note: r.note, status: r.status, bucket: bucketOf(r, todayStr),
        appointmentId: r.appointmentId, appointmentStatus: r.aStatus, appointmentDate: r.aDate, appointmentStartTime: r.aStart,
        sessionType: r.srcSessionType, mode: r.srcMode, createdAt: r.createdAt,
    };
}

export interface FollowUpFilter {
    doctorId?: number | null;
    patientId?: number | null;
    /** only follow-ups still needing attention (PENDING or BOOKED) */
    openOnly?: boolean;
    from?: string | null;
    to?: string | null;
}

export async function listFollowUps(db: Db, tenantId: number, filter: FollowUpFilter = {}): Promise<FollowUpDto[]> {
    const where = ["f.psychologist_id = $1"];
    const params: unknown[] = [tenantId];
    if (filter.doctorId) { params.push(filter.doctorId); where.push(`f.doctor_id = $${params.length}`); }
    if (filter.patientId) { params.push(filter.patientId); where.push(`f.patient_id = $${params.length}`); }
    if (filter.openOnly) where.push("f.status IN ('PENDING', 'BOOKED')");
    if (filter.from) { params.push(filter.from); where.push(`f.due_date >= $${params.length}`); }
    if (filter.to) { params.push(filter.to); where.push(`f.due_date <= $${params.length}`); }
    const rows = await db.many<FollowUpRow>(`${FOLLOW_UP_SQL} WHERE ${where.join(" AND ")} ORDER BY f.due_date ASC, f.id ASC`, params);
    const t = today();
    return rows.map((r) => toFollowUpDto(r, t));
}

async function followUpDto(db: Db, id: number): Promise<FollowUpDto> {
    const row = await db.one<FollowUpRow>(`${FOLLOW_UP_SQL} WHERE f.id = $1`, [id]);
    if (!row) throw notFound("Follow-up not found");
    return toFollowUpDto(row, today());
}

async function requireOwnedFollowUp(db: Db, id: number, tenantId: number): Promise<FollowUp> {
    const f = await db.one<FollowUp>("SELECT * FROM follow_up WHERE id = $1 AND psychologist_id = $2", [id, tenantId]);
    if (!f) throw notFound("Follow-up not found");
    return f;
}

export interface NewFollowUp {
    tenantId: number;
    patientId: number;
    doctorId: number | null;
    sourceAppointmentId: number | null;
    dueDate: string;
    dueTime: string | null;
    note: string | null;
    createdBy: number;
}

/**
 * Set the client's next follow-up. A client has one open follow-up at a time:
 * a still-unscheduled one is replaced; if one is already booked as a real
 * session, the caller must change that session first.
 */
export async function createFollowUp(db: Db, n: NewFollowUp): Promise<FollowUp> {
    if (!isValidDate(n.dueDate)) throw badRequest("Follow-up date is required (YYYY-MM-DD)");
    if (n.dueDate < today()) throw badRequest("The follow-up date can't be in the past");
    await requireOwnedPatient(db, n.patientId, n.tenantId);

    const booked = await db.one<{ id: number; dueDate: string }>(
        "SELECT id, due_date FROM follow_up WHERE patient_id = $1 AND status = 'BOOKED' LIMIT 1", [n.patientId]);
    if (booked) {
        throw conflict(`This client already has a follow-up session booked for ${booked.dueDate}. Reschedule or cancel that session first.`);
    }
    await db.exec(
        "UPDATE follow_up SET status = 'CANCELLED', updated_at = $2 WHERE patient_id = $1 AND status = 'PENDING'",
        [n.patientId, nowTs()]);

    return db.insert<FollowUp>("follow_up", {
        psychologistId: n.tenantId, patientId: n.patientId, doctorId: n.doctorId, sourceAppointmentId: n.sourceAppointmentId,
        dueDate: n.dueDate, dueTime: n.dueTime, note: n.note && n.note.trim() ? n.note.trim() : null,
        status: "PENDING", createdBy: n.createdBy,
    });
}

export interface BookFollowUpInput {
    appointmentDate: string;
    startTime: string; // HH:mm:ss
    staffId: number | null;
    mode: string | null;
    sessionType: string | null;
    durationMinutes: number | null;
    paymentHandledBy: string | null;
}

/**
 * Turn a follow-up into a real session on the calendar — through the same
 * booking path as every other session, so slot locking, per-therapist pricing,
 * invoicing and notifications all behave identically. The service and mode
 * default to the session the follow-up came from.
 */
export async function bookFollowUp(
    db: Db, followUpId: number, tenantId: number, caller: AppUser, input: BookFollowUpInput
): Promise<FollowUpDto> {
    const f = await requireOwnedFollowUp(db, followUpId, tenantId);
    if (f.status === "BOOKED") throw conflict("This follow-up already has a session booked.");
    if (f.status === "DONE" || f.status === "CANCELLED") throw conflict(`This follow-up is already ${f.status.toLowerCase()}.`);

    const patient = await requireOwnedPatient(db, f.patientId, tenantId);
    const source = f.sourceAppointmentId
        ? await db.one<Appointment>("SELECT * FROM appointment WHERE id = $1", [f.sourceAppointmentId])
        : null;
    const last = source ?? (await db.one<Appointment>(
        `SELECT * FROM appointment WHERE patient_id = $1 AND status <> 'CANCELLED' AND status <> 'DEMO_CALL_PENDING'
          ORDER BY appointment_date DESC, start_time DESC LIMIT 1`, [patient.id]));

    // Same therapist as the session it follows, unless the caller picks another.
    const doctorId = await appts.resolveSchedulingDoctor(
        db, caller, tenantId, input.staffId ?? f.doctorId ?? last?.assignedDoctorId ?? null);

    const dto = await appts.bookAppointmentForOwner(db, {
        patientName: patient.name, patientEmail: patient.email, patientPhone: patient.phone,
        appointmentDate: input.appointmentDate, startTime: input.startTime,
        sessionType: input.sessionType ?? last?.sessionType ?? null,
        notes: f.note ? `Follow-up: ${f.note}` : "Follow-up session",
        mode: input.mode ?? last?.mode ?? "OFFLINE",
    }, tenantId, doctorId, {
        requestedDurationMinutes: input.durationMinutes,
        toReception: input.paymentHandledBy === "RECEPTION",
    });

    await db.update("follow_up", f.id, {
        status: "BOOKED", appointmentId: dto.id, dueDate: input.appointmentDate, dueTime: input.startTime, doctorId,
    });
    return followUpDto(db, f.id);
}

export async function updateFollowUp(db: Db, id: number, tenantId: number, body: JsonObject): Promise<FollowUpDto> {
    const f = await requireOwnedFollowUp(db, id, tenantId);
    if (f.status !== "PENDING") throw conflict("Only a follow-up that isn't booked yet can be changed here — edit the session instead.");
    const patch: Record<string, unknown> = {};
    if (body.dueDate != null) {
        if (!isValidDate(body.dueDate)) throw badRequest("Follow-up date is required (YYYY-MM-DD)");
        if (body.dueDate < today()) throw badRequest("The follow-up date can't be in the past");
        patch.dueDate = body.dueDate;
    }
    if (body.dueTime !== undefined) {
        if (body.dueTime === null || body.dueTime === "") patch.dueTime = null;
        else {
            const m = timeToMinutes(body.dueTime);
            if (m === null) throw badRequest("The request could not be read — please check the values you entered.");
            patch.dueTime = minutesToTime(m);
        }
    }
    if (body.note !== undefined) patch.note = body.note === null ? null : String(body.note);
    if (body.doctorId !== undefined) patch.doctorId = body.doctorId === null ? null : Number(body.doctorId);
    await db.update("follow_up", id, patch);
    return followUpDto(db, id);
}

export async function markFollowUpDone(db: Db, id: number, tenantId: number): Promise<FollowUpDto> {
    await requireOwnedFollowUp(db, id, tenantId);
    await db.update("follow_up", id, { status: "DONE" });
    return followUpDto(db, id);
}

export async function cancelFollowUp(db: Db, id: number, tenantId: number): Promise<FollowUpDto> {
    const f = await requireOwnedFollowUp(db, id, tenantId);
    if (f.status === "BOOKED") {
        throw conflict("A session is already booked for this follow-up — cancel or reschedule that session instead.");
    }
    await db.update("follow_up", id, { status: "CANCELLED" });
    return followUpDto(db, id);
}

export async function createFollowUpForClient(
    tenantId: number, caller: AppUser, patientId: number, body: JsonObject
): Promise<FollowUpDto> {
    return tx(async (db) => {
        const dueDate = body.dueDate;
        if (!isValidDate(dueDate)) throw badRequest("Follow-up date is required (YYYY-MM-DD)");
        const dueTime = body.dueTime ? minutesToTime(timeToMinutes(body.dueTime) ?? 0) : null;
        const doctorId = optInt(body, "doctorId") ?? (await lastDoctorFor(db, patientId)) ?? (caller.role === Roles.PSYCHOLOGIST ? caller.id : null);
        const f = await createFollowUp(db, {
            tenantId, patientId, doctorId, sourceAppointmentId: null, dueDate, dueTime, note: optStr(body, "note"), createdBy: caller.id,
        });
        return followUpDto(db, f.id);
    });
}

async function lastDoctorFor(db: Db, patientId: number): Promise<number | null> {
    const row = await db.one<{ assignedDoctorId: number | null }>(
        `SELECT assigned_doctor_id FROM appointment WHERE patient_id = $1 AND status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING')
          ORDER BY appointment_date DESC, start_time DESC LIMIT 1`, [patientId]);
    if (row?.assignedDoctorId) return row.assignedDoctorId;
    const p = await db.one<{ assignedDoctorId: number | null }>("SELECT assigned_doctor_id FROM patient WHERE id = $1", [patientId]);
    return p?.assignedDoctorId ?? null;
}

// ── Complete a session (the therapist's end-of-session wrap-up) ──────────────

export interface CompleteSessionResult {
    appointment: appts.AppointmentDto;
    note: SessionNoteDto | null;
    patientCaseStatus: CaseStatus;
    caseStatusChanged: boolean;
    followUp: FollowUpDto | null;
}

/**
 * One atomic operation for "session conducted":
 *   1. mark the session COMPLETED (creates the invoice if needed)
 *   2. save the session notes (SOAP) if any were written
 *   3. update the client's session status (New Case / Ongoing / ...)
 *   4. set the next follow-up (and book it right away when a time is chosen)
 * Everything succeeds or nothing is saved — a half-recorded session can't happen.
 */
export async function completeSession(
    appointmentId: number, tenantId: number, caller: AppUser, body: JsonObject
): Promise<CompleteSessionResult> {
    // Validate the whole request before touching anything.
    const caseStatusRaw = body.caseStatus ?? null;
    if (caseStatusRaw !== null && !isCaseStatus(caseStatusRaw)) {
        throw badRequest(`Session status must be one of ${CASE_STATUSES.map((s) => CASE_STATUS_LABEL[s]).join(", ")}`);
    }
    const reason = optStr(body, "caseStatusReason");
    const noteIn = (body.note ?? null) as JsonObject | null;
    const fu = (body.followUp ?? null) as JsonObject | null;
    if (fu !== null && typeof fu !== "object") throw badRequest("The request could not be read — please check the values you entered.");
    const fuDate = fu && fu.date ? fu.date : null;
    if (fuDate !== null && !isValidDate(fuDate)) throw badRequest("Follow-up date is required (YYYY-MM-DD)");
    const fuTime = fu && fu.time ? timeToMinutes(fu.time) : null;
    if (fu && fu.time && fuTime === null) throw badRequest("The request could not be read — please check the values you entered.");

    return tx(async (db) => {
        const appt = await appts.requireOwnedAppointment(db, appointmentId, tenantId);
        if (appt.status === "CANCELLED" || appt.status === "DEMO_CALL_PENDING") {
            throw conflict("A cancelled session or a demo-call request can't be completed.");
        }

        // 1. COMPLETED
        if (appt.status !== "COMPLETED") {
            await appts.updateAppointmentStatus(db, appointmentId, tenantId, "COMPLETED", null, null);
        }

        // 2. Notes
        let note: SessionNoteDto | null = null;
        if (noteIn && ["subjective", "objective", "assessment", "plan", "content"].some((k) => noteIn[k] && String(noteIn[k]).trim())) {
            note = await saveNote(db, appointmentId, tenantId, noteIn);
        }

        // 3. Session status
        let caseStatusChanged = false;
        let patientCaseStatus: CaseStatus = (await requireOwnedPatient(db, appt.patientId, tenantId)).caseStatus;
        if (caseStatusRaw !== null) {
            const res = await changeCaseStatus(db, {
                tenantId, patientId: appt.patientId, toStatus: caseStatusRaw as CaseStatus,
                reason: reason && reason.trim() ? reason.trim() : null, appointmentId, changedBy: caller.id,
            });
            caseStatusChanged = res.changed;
            patientCaseStatus = res.patient.caseStatus;
        }

        // 4. Next follow-up (only meaningful while the case is still open)
        let followUp: FollowUpDto | null = null;
        if (fuDate !== null && ACTIVE_CASE_STATUSES.includes(patientCaseStatus)) {
            const doctorId = appt.assignedDoctorId ?? appt.psychologistId;
            const row = await createFollowUp(db, {
                tenantId, patientId: appt.patientId, doctorId, sourceAppointmentId: appt.id, dueDate: fuDate,
                dueTime: fuTime !== null ? minutesToTime(fuTime) : null, note: fu ? optStr(fu, "note") : null, createdBy: caller.id,
            });
            if (fuTime !== null && optBool(fu!, "book") !== false) {
                followUp = await bookFollowUp(db, row.id, tenantId, caller, {
                    appointmentDate: fuDate, startTime: minutesToTime(fuTime),
                    staffId: optInt(fu!, "staffId"), mode: optStr(fu!, "mode"), sessionType: optStr(fu!, "sessionType"),
                    durationMinutes: optInt(fu!, "durationMinutes"), paymentHandledBy: optStr(fu!, "paymentHandledBy"),
                });
            } else {
                followUp = await followUpDto(db, row.id);
            }
        }

        return {
            appointment: await appts.dtoById(db, appointmentId),
            note, patientCaseStatus, caseStatusChanged, followUp,
        };
    });
}

