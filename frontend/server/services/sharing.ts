import type { Db } from "../db";
import { badRequest, forbidden, notFound } from "../http";
import { nowTs } from "../time";
import { AppUser, Patient, Roles } from "../types";

// Client sharing — the treating therapist (or the clinic owner) can share a
// client with another therapist in the same clinic. A shared therapist sees the
// client under "My clients" / "Case history" and can edit the client's journey:
// session status, follow-ups, session notes and session wrap-ups.
//
// Who can do what with a client:
//   OWNER     the clinic owner / a solo practitioner — everything, always. Never
//             stored as a share (they already see every client).
//   TREATING  a therapist the client is assigned to, or who has a session with
//             them — edits the journey and can share the client onward.
//   SHARED    a therapist the client was shared with — edits the journey, but
//             can't re-share it (the treating therapist or owner decides that).
//   NONE      any other therapist in the clinic — read-only: edits to the
//             client's journey and record are refused.
// Deleting a client is reserved for the owner and the treating therapist.
// (Appointment-level edits — rescheduling, cancelling, payments — are shared
// with the front desk and billing flows and are not caseload-restricted here.)
// Receptionists and other non-therapist staff are not restricted by any of this;
// their access to clients is governed by their dashboard permissions, as before.
//
// This module only depends on the database and the user/patient types, so the
// workflow, notes and therapist services can all import it without a cycle.

const tenantOf = (u: AppUser) => u.tenantId ?? u.id;

/** A therapist who belongs to a clinic (as opposed to the owner or a solo practitioner). */
export const isStaffTherapist = (u: AppUser) => u.tenantId !== null && u.role === Roles.PSYCHOLOGIST;

export type ClientAccess = "OWNER" | "TREATING" | "SHARED" | null;

/** SQL fragments over a `patient p` row; $2 is always the therapist's user id. */
export const OWN_CLIENT_SQL = `(COALESCE(p.assigned_doctor_id = $2, false) OR EXISTS (
        SELECT 1 FROM appointment ax WHERE ax.patient_id = p.id AND ax.assigned_doctor_id = $2
           AND ax.status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING')))`;
export const SHARED_CLIENT_SQL = `EXISTS (SELECT 1 FROM patient_share ps WHERE ps.patient_id = p.id AND ps.shared_with_id = $2)`;

/** How `me` relates to this client, or null when they have no access to the journey. */
export async function clientAccess(db: Db, me: AppUser, patient: Patient): Promise<ClientAccess> {
    if (patient.primaryPsychologistId !== tenantOf(me)) return null;
    if (me.tenantId === null) return "OWNER";
    if (patient.assignedDoctorId === me.id) return "TREATING";
    const row = await db.one<{ treating: boolean; shared: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM appointment WHERE patient_id = $1 AND assigned_doctor_id = $2
                           AND status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING')) AS treating,
                EXISTS (SELECT 1 FROM patient_share WHERE patient_id = $1 AND shared_with_id = $2) AS shared`,
        [patient.id, me.id]);
    if (row?.treating) return "TREATING";
    if (row?.shared) return "SHARED";
    return null;
}

/**
 * Guard for every write to a client's journey. Therapists who work in a clinic
 * must have the client on their caseload (own or shared); the owner, a solo
 * practitioner and front-desk staff pass straight through, as they always did.
 */
export async function assertCanEditJourney(db: Db, caller: AppUser, patientId: number): Promise<void> {
    if (!isStaffTherapist(caller)) return;
    const patient = await db.one<Patient>(
        "SELECT * FROM patient WHERE id = $1 AND primary_psychologist_id = $2", [patientId, tenantOf(caller)]);
    if (!patient) throw notFound("Patient not found");
    if ((await clientAccess(db, caller, patient)) === null) {
        throw forbidden("This client isn't on your caseload. Ask their therapist or the clinic owner to share the client with you.");
    }
}

/**
 * Guard for removing a client record. A shared therapist may follow and edit the
 * journey but not delete the client — that stays with the client's own therapist
 * and the owner (front-desk staff are unrestricted, as before).
 */
export async function assertCanDeleteClient(db: Db, caller: AppUser, patientId: number): Promise<void> {
    if (!isStaffTherapist(caller)) return;
    const patient = await db.one<Patient>(
        "SELECT * FROM patient WHERE id = $1 AND primary_psychologist_id = $2", [patientId, tenantOf(caller)]);
    if (!patient) throw notFound("Patient not found");
    if ((await clientAccess(db, caller, patient)) !== "TREATING") {
        throw forbidden("Only this client's therapist or the clinic owner can delete them.");
    }
}

// ── The share list for one client ────────────────────────────────────────────

export interface ShareDto {
    therapistId: number; therapistName: string | null; therapistJobTitle: string | null;
    sharedById: number | null; sharedByName: string | null; sharedAt: string | null;
}

export interface ShareCandidate { id: number; name: string | null; jobTitle: string | null; shared: boolean }

/** A therapist who works with the client in their own right (not via a share). */
export interface TreatingTherapist {
    id: number; name: string | null; jobTitle: string | null; enabled: boolean;
    /** the therapist the client is assigned to (vs. one who simply has a session with them) */
    assigned: boolean;
    isMe: boolean;
}

export interface ShareState {
    /** how the caller relates to this client; NONE = a clinic therapist with no access */
    access: "OWNER" | "TREATING" | "SHARED" | "NONE" | "OTHER";
    /** may the caller edit the client's journey? */
    canEdit: boolean;
    /** may the caller share / un-share this client with other therapists? */
    canManage: boolean;
    /** may the caller delete the client record? (not a therapist who only has it shared) */
    canDelete: boolean;
    /** the therapist(s) who treat this client directly */
    treating: TreatingTherapist[];
    /** therapists this client has been shared with */
    shares: ShareDto[];
    /** therapists the caller could share with (only when canManage) */
    candidates: ShareCandidate[];
    /** for a read-only caller: who to ask */
    treatingTherapists: string[];
}

async function requireTenantPatient(db: Db, patientId: number, tenantId: number): Promise<Patient> {
    const p = await db.one<Patient>("SELECT * FROM patient WHERE id = $1 AND primary_psychologist_id = $2", [patientId, tenantId]);
    if (!p) throw notFound("Patient not found");
    return p;
}

async function listShares(db: Db, patientId: number): Promise<ShareDto[]> {
    return db.many<ShareDto>(
        `SELECT ps.shared_with_id AS therapist_id, t.name AS therapist_name, t.job_title AS therapist_job_title,
                ps.shared_by AS shared_by_id, b.name AS shared_by_name, ps.created_at AS shared_at
           FROM patient_share ps
           JOIN app_user t ON t.id = ps.shared_with_id
           LEFT JOIN app_user b ON b.id = ps.shared_by
          WHERE ps.patient_id = $1
          ORDER BY ps.created_at ASC, ps.id ASC`, [patientId]);
}

/** Therapists with their own relationship to the client (they don't need a share). */
async function treatingTherapistIds(db: Db, patient: Patient): Promise<Set<number>> {
    const rows = await db.many<{ id: number }>(
        `SELECT DISTINCT assigned_doctor_id AS id FROM appointment
          WHERE patient_id = $1 AND assigned_doctor_id IS NOT NULL AND status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING')`, [patient.id]);
    const ids = new Set(rows.map((r) => r.id));
    if (patient.assignedDoctorId !== null) ids.add(patient.assignedDoctorId);
    return ids;
}

export async function getShareState(db: Db, me: AppUser, patientId: number): Promise<ShareState> {
    const patient = await requireTenantPatient(db, patientId, tenantOf(me));
    const access = await clientAccess(db, me, patient);
    const shares = await listShares(db, patientId);

    const kind: ShareState["access"] =
        access ?? (isStaffTherapist(me) ? "NONE" : "OTHER");
    const canManage = access === "OWNER" || access === "TREATING";
    const canEdit = kind !== "NONE";
    const canDelete = kind !== "NONE" && kind !== "SHARED";

    // Who works with this client in their own right (assigned, or has a session with them) —
    // so the owner can tell the treating therapist apart from those it was shared with.
    const own = await treatingTherapistIds(db, patient);
    const treating: TreatingTherapist[] = own.size === 0 ? [] : (await db.many<{ id: number; name: string | null; jobTitle: string | null; enabled: boolean }>(
        "SELECT id, name, job_title, enabled FROM app_user WHERE id = ANY($1::bigint[])", [[...own]]))
        .map((t) => ({ id: t.id, name: t.name, jobTitle: t.jobTitle, enabled: t.enabled, assigned: t.id === patient.assignedDoctorId, isMe: t.id === me.id }))
        .sort((a, b) => Number(b.assigned) - Number(a.assigned) || (a.name ?? "").localeCompare(b.name ?? ""));

    let candidates: ShareCandidate[] = [];
    if (canManage) {
        const sharedIds = new Set(shares.map((s) => s.therapistId));
        const therapists = await db.many<{ id: number; name: string | null; jobTitle: string | null }>(
            `SELECT id, name, job_title FROM app_user
              WHERE tenant_id = $1 AND role = $2 AND enabled = true AND id <> $3 ORDER BY name ASC`,
            [tenantOf(me), Roles.PSYCHOLOGIST, me.id]);
        candidates = therapists
            .filter((t) => !own.has(t.id) || sharedIds.has(t.id))
            .map((t) => ({ id: t.id, name: t.name, jobTitle: t.jobTitle, shared: sharedIds.has(t.id) }));
    }

    // For a read-only caller: who to ask for access.
    const treatingTherapists = kind === "NONE"
        ? treating.filter((t) => t.enabled && t.name).slice(0, 3).map((t) => t.name as string)
        : [];
    return { access: kind, canEdit, canManage, canDelete, treating, shares, candidates, treatingTherapists };
}

/** Share a client with another therapist in the clinic. Idempotent. */
export async function shareClient(db: Db, me: AppUser, patientId: number, therapistId: number): Promise<ShareState> {
    const patient = await requireTenantPatient(db, patientId, tenantOf(me));
    const access = await clientAccess(db, me, patient);
    if (access !== "OWNER" && access !== "TREATING") {
        throw forbidden("Only this client's therapist or the clinic owner can share them.");
    }
    if (therapistId === me.id) throw badRequest("You already have access to this client.");
    if (therapistId === tenantOf(me)) throw badRequest("The clinic owner already has access to every client.");

    const target = await db.one<AppUser>(
        "SELECT * FROM app_user WHERE id = $1 AND tenant_id = $2 AND role = $3 AND enabled = true",
        [therapistId, tenantOf(me), Roles.PSYCHOLOGIST]);
    if (!target) throw notFound("No such therapist");
    if ((await treatingTherapistIds(db, patient)).has(target.id)) {
        throw badRequest(`${target.name ?? "This therapist"} already works with this client.`);
    }

    await db.exec(
        `INSERT INTO patient_share (psychologist_id, patient_id, shared_with_id, shared_by, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (patient_id, shared_with_id) DO NOTHING`,
        [tenantOf(me), patientId, target.id, me.id, nowTs()]);
    return getShareState(db, me, patientId);
}

/** Stop sharing. The owner and the treating therapist can remove anyone; a shared therapist can remove themselves. */
export async function unshareClient(db: Db, me: AppUser, patientId: number, therapistId: number): Promise<ShareState> {
    const patient = await requireTenantPatient(db, patientId, tenantOf(me));
    const access = await clientAccess(db, me, patient);
    const leavingMyself = therapistId === me.id && access === "SHARED";
    if (access !== "OWNER" && access !== "TREATING" && !leavingMyself) {
        throw forbidden("Only this client's therapist or the clinic owner can change who they're shared with.");
    }
    await db.exec("DELETE FROM patient_share WHERE patient_id = $1 AND shared_with_id = $2", [patientId, therapistId]);
    return getShareState(db, me, patientId);
}
