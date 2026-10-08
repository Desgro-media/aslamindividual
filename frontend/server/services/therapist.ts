import type { Db } from "../db";
import { forbidden, notFound } from "../http";
import { nowMinutes, today } from "../time";
import { AppUser, CaseStatus, Patient, Roles, SessionNote } from "../types";
import { APPT_PATIENT_SQL, AppointmentDto, toDtos } from "./appointments";
import { getDoctorOfferedServices } from "./availability";
import { FollowUpDto, getCaseStatusLog, listFollowUps, CaseStatusLogDto } from "./workflow";

// Everything a therapist's own dashboard needs — Schedule, My Clients, Case
// History, Session Notes, Follow-up — scoped to the signed-in practitioner by
// construction: the practitioner is always the authenticated caller, never an id
// taken from the request. (Individual practitioners and clinic owners use the
// same endpoints for their own calendar.)

const tenantOf = (u: AppUser) => u.tenantId ?? u.id;

/** A solo practitioner is the only person seeing patients, so every client is "theirs". */
const isSolo = (u: AppUser) => u.tenantId === null && u.accountType !== "CLINIC";

// SQL predicate: "this patient is one of my clients" ($1 = tenant, $2 = me).
const MY_CLIENT = `(p.primary_psychologist_id = $1 AND (p.assigned_doctor_id = $2 OR EXISTS (
        SELECT 1 FROM appointment ax WHERE ax.patient_id = p.id AND ax.assigned_doctor_id = $2
           AND ax.status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING'))))`;
const SOLO_CLIENT = `(p.primary_psychologist_id = $1 AND $2::bigint IS NOT NULL)`;

export const myClientPredicate = (me: AppUser) => (isSolo(me) ? SOLO_CLIENT : MY_CLIENT);

// ── Schedule ─────────────────────────────────────────────────────────────────

export interface ScheduleItem extends AppointmentDto {
    hasNote: boolean;
    sessionNumber: number;
}

export async function getMySchedule(
    db: Db, me: AppUser, from: string, to: string, includeCancelled: boolean
): Promise<ScheduleItem[]> {
    const rows = await db.many<Parameters<typeof toDtos>[1][number]>(
        `${APPT_PATIENT_SQL}
          WHERE a.assigned_doctor_id = $1 AND a.psychologist_id = $2 AND a.status <> 'DEMO_CALL_PENDING'
            AND a.appointment_date >= $3 AND a.appointment_date <= $4
            ${includeCancelled ? "" : "AND a.status <> 'CANCELLED'"}
          ORDER BY a.appointment_date ASC, a.start_time ASC`,
        [me.id, tenantOf(me), from, to]);
    const dtos = await toDtos(db, rows);
    if (dtos.length === 0) return [];

    const ids = dtos.map((d) => d.id);
    const withNote = new Set(
        (await db.many<{ appointmentId: number }>(
            "SELECT appointment_id FROM session_note WHERE appointment_id = ANY($1::bigint[])", [ids])).map((r) => r.appointmentId));
    const numbers = await db.many<{ id: number; n: number }>(
        `SELECT a.id, (SELECT count(*) FROM appointment b
                        WHERE b.patient_id = a.patient_id AND b.status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING')
                          AND (b.appointment_date < a.appointment_date
                               OR (b.appointment_date = a.appointment_date AND b.start_time <= a.start_time))) AS n
           FROM appointment a WHERE a.id = ANY($1::bigint[])`, [ids]);
    const numberById = new Map(numbers.map((r) => [r.id, r.n]));
    return dtos.map((d) => ({ ...d, hasNote: withNote.has(d.id), sessionNumber: numberById.get(d.id) ?? 1 }));
}

// ── My clients ───────────────────────────────────────────────────────────────

export interface MyClient {
    id: number; name: string; email: string | null; phone: string; caseStatus: CaseStatus;
    caseStatusUpdatedAt: string | null; riskFlag: boolean; assignedDoctorId: number | null; createdAt: string | null;
    sessionsWithMe: number; completedWithMe: number; lastSessionDate: string | null;
    nextAppointmentDate: string | null; nextAppointmentTime: string | null;
    nextFollowUpDate: string | null; nextFollowUpStatus: string | null; pendingNotes: number;
}

export async function getMyClients(db: Db, me: AppUser): Promise<MyClient[]> {
    const rows = await db.many<MyClient>(
        `SELECT p.id, p.name, p.email, p.phone, p.case_status, p.case_status_updated_at, p.risk_flag,
                p.assigned_doctor_id, p.created_at,
                (SELECT count(*) FROM appointment a WHERE a.patient_id = p.id AND a.assigned_doctor_id = $2
                    AND a.status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING')) AS sessions_with_me,
                (SELECT count(*) FROM appointment a WHERE a.patient_id = p.id AND a.assigned_doctor_id = $2
                    AND a.status = 'COMPLETED') AS completed_with_me,
                (SELECT max(a.appointment_date) FROM appointment a WHERE a.patient_id = p.id
                    AND a.status = 'COMPLETED') AS last_session_date,
                (SELECT a.appointment_date FROM appointment a WHERE a.patient_id = p.id
                    AND a.status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING', 'COMPLETED') AND a.appointment_date >= $3
                  ORDER BY a.appointment_date, a.start_time LIMIT 1) AS next_appointment_date,
                (SELECT a.start_time FROM appointment a WHERE a.patient_id = p.id
                    AND a.status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING', 'COMPLETED') AND a.appointment_date >= $3
                  ORDER BY a.appointment_date, a.start_time LIMIT 1) AS next_appointment_time,
                (SELECT f.due_date FROM follow_up f WHERE f.patient_id = p.id AND f.status IN ('PENDING', 'BOOKED')
                  ORDER BY f.due_date LIMIT 1) AS next_follow_up_date,
                (SELECT f.status FROM follow_up f WHERE f.patient_id = p.id AND f.status IN ('PENDING', 'BOOKED')
                  ORDER BY f.due_date LIMIT 1) AS next_follow_up_status,
                (SELECT count(*) FROM appointment a WHERE a.patient_id = p.id AND a.assigned_doctor_id = $2
                    AND a.status = 'COMPLETED'
                    AND NOT EXISTS (SELECT 1 FROM session_note n WHERE n.appointment_id = a.id)) AS pending_notes
           FROM patient p
          WHERE ${myClientPredicate(me)}
          ORDER BY p.name ASC`,
        [tenantOf(me), me.id, today()]);
    return rows;
}

// ── Session notes ────────────────────────────────────────────────────────────

export interface NoteQueueItem {
    appointmentId: number; patientId: number; patientName: string; appointmentDate: string; startTime: string;
    endTime: string; mode: string | null; assignedDoctorId: number;
    sessionType: string | null; caseStatus: CaseStatus; status: string;
}

export interface NoteListItem extends NoteQueueItem {
    noteId: number; subjective: string | null; objective: string | null; assessment: string | null;
    plan: string | null; content: string | null; updatedAt: string | null;
}

export interface MySessionNotes {
    /** completed sessions whose notes haven't been written yet */
    pendingNotes: NoteQueueItem[];
    /** confirmed sessions whose time has passed but that were never marked complete */
    awaitingCompletion: NoteQueueItem[];
    notes: NoteListItem[];
}

export async function getMySessionNotes(db: Db, me: AppUser): Promise<MySessionNotes> {
    const tenant = tenantOf(me);
    const base = `
        SELECT a.id AS appointment_id, a.patient_id, p.name AS patient_name, a.appointment_date, a.start_time,
               a.end_time, a.mode, a.assigned_doctor_id, a.session_type, p.case_status, a.status
          FROM appointment a JOIN patient p ON p.id = a.patient_id
         WHERE a.assigned_doctor_id = $1 AND a.psychologist_id = $2`;
    const pendingNotes = await db.many<NoteQueueItem>(
        `${base} AND a.status = 'COMPLETED' AND NOT EXISTS (SELECT 1 FROM session_note n WHERE n.appointment_id = a.id)
          ORDER BY a.appointment_date DESC, a.start_time DESC LIMIT 100`, [me.id, tenant]);
    const nowTime = `${String(Math.floor(nowMinutes() / 60)).padStart(2, "0")}:${String(nowMinutes() % 60).padStart(2, "0")}:00`;
    const awaitingCompletion = await db.many<NoteQueueItem>(
        `${base} AND a.status = 'CONFIRMED'
            AND (a.appointment_date < $3 OR (a.appointment_date = $3 AND a.end_time <= $4))
          ORDER BY a.appointment_date DESC, a.start_time DESC LIMIT 100`, [me.id, tenant, today(), nowTime]);
    const notes = await db.many<NoteListItem & Pick<SessionNote, "id">>(
        `SELECT a.id AS appointment_id, a.patient_id, p.name AS patient_name, a.appointment_date, a.start_time,
                a.end_time, a.mode, a.assigned_doctor_id, a.session_type, p.case_status, a.status, n.id AS note_id, n.subjective, n.objective, n.assessment,
                n.plan, n.content, n.updated_at
           FROM session_note n JOIN appointment a ON a.id = n.appointment_id JOIN patient p ON p.id = n.patient_id
          WHERE a.assigned_doctor_id = $1 AND a.psychologist_id = $2
          ORDER BY a.appointment_date DESC, a.start_time DESC LIMIT 300`, [me.id, tenant]);
    return { pendingNotes, awaitingCompletion, notes };
}

// ── Case history ─────────────────────────────────────────────────────────────

/** Whether this practitioner may open the client's case history. */
export async function canAccessClient(db: Db, me: AppUser, patient: Patient): Promise<boolean> {
    if (patient.primaryPsychologistId !== tenantOf(me)) return false;
    if (me.tenantId === null) return true; // the owner / a solo practitioner sees the whole roster
    if (patient.assignedDoctorId === me.id) return true;
    const seen = await db.one(
        "SELECT 1 FROM appointment WHERE patient_id = $1 AND assigned_doctor_id = $2 AND status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING') LIMIT 1",
        [patient.id, me.id]);
    return !!seen;
}

export interface CaseHistory {
    patient: Patient;
    sessions: Array<AppointmentDto & { note: SessionNote | null; sessionNumber: number }>;
    statusLog: CaseStatusLogDto[];
    followUps: FollowUpDto[];
}

export async function getCaseHistory(db: Db, me: AppUser, patientId: number): Promise<CaseHistory> {
    const patient = await db.one<Patient>("SELECT * FROM patient WHERE id = $1 AND primary_psychologist_id = $2", [patientId, tenantOf(me)]);
    if (!patient) throw notFound("Patient not found");
    if (me.role === Roles.RECEPTIONIST || !(await canAccessClient(db, me, patient))) {
        throw forbidden("This client isn't on your caseload.");
    }

    const rows = await db.many<Parameters<typeof toDtos>[1][number]>(
        `${APPT_PATIENT_SQL} WHERE a.patient_id = $1 AND a.psychologist_id = $2 AND a.status <> 'DEMO_CALL_PENDING'
          ORDER BY a.appointment_date ASC, a.start_time ASC`, [patientId, tenantOf(me)]);
    const dtos = await toDtos(db, rows);
    const notes = await db.many<SessionNote>("SELECT * FROM session_note WHERE patient_id = $1", [patientId]);
    const noteByAppt = new Map(notes.map((n) => [n.appointmentId, n]));
    let counter = 0;
    const sessions = dtos.map((d) => {
        if (d.status !== "CANCELLED") counter += 1;
        return { ...d, note: noteByAppt.get(d.id) ?? null, sessionNumber: d.status === "CANCELLED" ? 0 : counter };
    });
    return {
        patient,
        sessions: sessions.reverse(), // newest first
        statusLog: await getCaseStatusLog(db, patientId, tenantOf(me)),
        followUps: await listFollowUps(db, tenantOf(me), { patientId }),
    };
}

// ── Follow-ups for the signed-in therapist ───────────────────────────────────

export const getMyFollowUps = (db: Db, me: AppUser, openOnly: boolean) =>
    listFollowUps(db, tenantOf(me), { doctorId: me.id, openOnly });

// ── Practitioner directory (receptionist booking flow) ───────────────────────

export interface TherapistDto {
    id: number; name: string | null; jobTitle: string | null; bio: string | null; profileImageUrl: string | null;
    bookable: boolean; isOwner: boolean;
}

/**
 * The people a session can be booked with — the clinic's enabled practitioners
 * (plus the owner, if they take clients). Available to anyone who can schedule,
 * unlike /staff, which is the owner's management screen.
 */
export async function listTherapists(db: Db, tenantId: number): Promise<TherapistDto[]> {
    return db.many<TherapistDto>(
        `SELECT id, name, job_title, bio, profile_image_url, bookable, (id = $1) AS is_owner
           FROM app_user
          WHERE (tenant_id = $1 AND role = $2 AND enabled = true) OR (id = $1 AND bookable = true AND enabled = true)
          ORDER BY (id = $1) DESC, name ASC`, [tenantId, Roles.PSYCHOLOGIST]);
}

export async function requireTherapist(db: Db, tenantId: number, therapistId: number): Promise<TherapistDto> {
    const t = (await listTherapists(db, tenantId)).find((x) => x.id === therapistId);
    if (!t) throw notFound("No such therapist");
    return t;
}

// ── Service options (receptionist booking flow: select service -> select therapist) ──

export interface ServiceOption {
    serviceId: number;
    name: string;
    description: string | null;
    duration: string;
    icon: string | null;
    category: string;
    therapists: Array<{
        id: number; name: string | null; jobTitle: string | null; profileImageUrl: string | null;
        onlineOffered: boolean; offlineOffered: boolean; onlinePrice: number | null; offlinePrice: number | null;
    }>;
}

/**
 * The booking catalogue: every active service that at least one therapist
 * currently offers, with who offers it and at what price in each mode. Lets the
 * front desk pick the SERVICE first and then a therapist who provides it — the
 * order of the Psyfos intake flow — without needing the owner-only Services or
 * Staff screens.
 */
export async function getServiceOptions(db: Db, tenantId: number): Promise<ServiceOption[]> {
    const services = await db.many<{
        id: number; name: string; description: string | null; duration: string; icon: string | null; category: string;
    }>("SELECT id, name, description, duration, icon, category FROM clinic_service WHERE psychologist_id = $1 AND active = true ORDER BY display_order ASC, created_at ASC", [tenantId]);
    const therapists = await listTherapists(db, tenantId);

    const offeredBy = new Map<number, ServiceOption["therapists"]>();
    for (const t of therapists) {
        for (const o of await getDoctorOfferedServices(db, t.id)) {
            const list = offeredBy.get(o.clinicServiceId) ?? [];
            list.push({
                id: t.id, name: t.name, jobTitle: t.jobTitle, profileImageUrl: t.profileImageUrl,
                onlineOffered: o.onlineOffered, offlineOffered: o.offlineOffered, onlinePrice: o.onlinePrice, offlinePrice: o.offlinePrice,
            });
            offeredBy.set(o.clinicServiceId, list);
        }
    }
    return services
        .filter((s) => offeredBy.has(s.id))
        .map((s) => ({
            serviceId: s.id, name: s.name, description: s.description, duration: s.duration, icon: s.icon, category: s.category,
            therapists: offeredBy.get(s.id)!,
        }));
}
