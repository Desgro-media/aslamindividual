import type { Db } from "../db";
import { tx } from "../db";
import { JsonObject, badRequest, conflict, forbidden, notFound, optBool } from "../http";
import { hashPassword } from "../security/auth";
import { parsePermissions } from "../security/guards";
import { nowTs, today } from "../time";
import { AppUser, Roles, StaffAttendance } from "../types";
import { sendStaffCredentialsChangedEmail } from "./notifications";

// Staff account management for a CLINIC tenant. Every method starts with
// requireClinicOwner (only the clinic's own tenant-root account can provision/
// manage staff credentials) and, for anything targeting a specific staff id,
// requireOwnedStaff (the id must belong to the caller's own tenant — without it
// one clinic could edit/deactivate another clinic's staff by id).

const ALLOWED_ROLES: string[] = [Roles.STAFF, Roles.RECEPTIONIST, Roles.PSYCHOLOGIST];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface StaffSummaryDto {
    id: number; name: string | null; username: string; jobTitle: string | null; role: string;
    permissions: string[]; bio: string | null; bookable: boolean; profileImageUrl: string | null;
    enabled: boolean; createdAt: string | null;
}

const toSummary = (s: AppUser): StaffSummaryDto => ({
    id: s.id, name: s.name, username: s.username, jobTitle: s.jobTitle, role: s.role,
    permissions: parsePermissions(s.permissions), bio: s.bio, bookable: s.bookable,
    profileImageUrl: s.profileImageUrl, enabled: s.enabled, createdAt: s.createdAt,
});

export function requireClinicOwner(caller: AppUser): void {
    if (caller.tenantId !== null || caller.accountType !== "CLINIC") {
        throw forbidden("Only a clinic account can manage staff");
    }
}

export async function requireOwnedStaff(db: Db, caller: AppUser, staffId: number): Promise<AppUser> {
    const staff = await db.one<AppUser>("SELECT * FROM app_user WHERE id = $1 AND tenant_id = $2", [staffId, caller.id]);
    if (!staff) throw notFound(`Staff member not found: ${staffId}`);
    return staff;
}

function normalizeRole(role: unknown): string {
    const candidate = typeof role === "string" && role.trim() ? role : Roles.STAFF;
    if (!ALLOWED_ROLES.includes(candidate)) {
        throw badRequest(`Invalid role: ${candidate}. Allowed: [${ALLOWED_ROLES.join(", ")}]`);
    }
    return candidate;
}

const joinPermissions = (p: unknown): string => (Array.isArray(p) ? p.map(String).join(",") : "");

export async function listStaff(db: Db, caller: AppUser): Promise<StaffSummaryDto[]> {
    requireClinicOwner(caller);
    const rows = await db.many<AppUser>("SELECT * FROM app_user WHERE tenant_id = $1 ORDER BY name ASC", [caller.id]);
    return rows.map(toSummary);
}

export async function createStaff(db: Db, caller: AppUser, dto: JsonObject): Promise<StaffSummaryDto> {
    requireClinicOwner(caller);
    if (!dto.username || String(dto.username).trim() === "") throw badRequest("Username is required");
    if (!dto.password || String(dto.password).length < 8) throw badRequest("Password must be at least 8 characters");

    const username = String(dto.username).trim().toLowerCase();
    // The shared login form's email field is type="email" — a non-email-shaped
    // username could never sign in from the browser.
    if (!EMAIL_PATTERN.test(username)) throw badRequest("Username must be a valid email address");
    if (await db.one("SELECT 1 FROM app_user WHERE username = $1", [username])) {
        throw badRequest("An account with this email already exists");
    }
    const role = normalizeRole(dto.role);
    const staff = await db.insert<AppUser>("app_user", {
        username,
        password: await hashPassword(String(dto.password)),
        name: dto.name != null ? String(dto.name).trim() : username,
        role,
        tenantId: caller.id,
        slug: null, // staff are never independently bookable via a public slug
        jobTitle: dto.jobTitle ?? null,
        permissions: joinPermissions(dto.permissions),
        bio: dto.bio ?? null,
        // Only a PSYCHOLOGIST can ever be publicly bookable — enforced here, not
        // just hidden in the create form.
        bookable: role === Roles.PSYCHOLOGIST && dto.bookable === true,
        profileImageUrl: dto.profileImageUrl ?? null,
        enabled: true,
    });
    return toSummary(staff);
}

/** Partial update — a field is applied only if the caller actually sent it. */
export async function updateStaff(db: Db, caller: AppUser, staffId: number, dto: JsonObject): Promise<StaffSummaryDto> {
    requireClinicOwner(caller);
    const staff = await requireOwnedStaff(db, caller, staffId);

    const patch: Record<string, unknown> = {};
    let role = staff.role;
    if (dto.name != null) {
        if (String(dto.name).trim() === "") throw badRequest("Name cannot be empty");
        patch.name = String(dto.name).trim();
    }
    if (dto.jobTitle != null) patch.jobTitle = dto.jobTitle;
    if (dto.bio != null) patch.bio = dto.bio;
    if (dto.bookable != null) patch.bookable = optBool(dto, "bookable");
    if (dto.profileImageUrl != null) patch.profileImageUrl = dto.profileImageUrl;
    if (dto.permissions != null) patch.permissions = joinPermissions(dto.permissions);
    if (dto.role != null && String(dto.role).trim() !== "") {
        role = normalizeRole(dto.role);
        patch.role = role;
    }
    if (dto.password != null && String(dto.password).trim() !== "") {
        if (String(dto.password).length < 8) throw badRequest("Password must be at least 8 characters");
        patch.password = await hashPassword(String(dto.password));
        patch.credentialsChangedAt = nowTs();
    }
    // A role change away from PSYCHOLOGIST can never leave this row publicly bookable.
    if (role !== Roles.PSYCHOLOGIST) patch.bookable = false;
    return toSummary(await db.update<AppUser>("app_user", staffId, patch));
}

/**
 * Sign-in details (login email and/or password), kept off updateStaff on
 * purpose: this is the surface a staff member gets instead of self-service
 * password reset, which this product does not have.
 */
export async function updateCredentials(
    db: Db, caller: AppUser, staffId: number, rawUsername: string | null, rawPassword: string | null
): Promise<StaffSummaryDto> {
    requireClinicOwner(caller);
    const staff = await requireOwnedStaff(db, caller, staffId);

    const username = rawUsername && rawUsername.trim() ? rawUsername.trim().toLowerCase() : null;
    const password = rawPassword && rawPassword.trim() ? rawPassword : null;
    if (username === null && password === null) throw badRequest("Provide a new email, a new password, or both");

    const patch: Record<string, unknown> = {};
    let emailChanged = false;
    if (username !== null && username !== staff.username) {
        if (!EMAIL_PATTERN.test(username)) throw badRequest("Username must be a valid email address");
        // Usernames are globally unique across every tenant — check the whole table.
        if (await db.one("SELECT 1 FROM app_user WHERE username = $1", [username])) {
            throw badRequest("An account with this email already exists");
        }
        patch.username = username;
        emailChanged = true;
    }
    let passwordChanged = false;
    if (password !== null) {
        if (password.length < 8) throw badRequest("Password must be at least 8 characters");
        patch.password = await hashPassword(password);
        passwordChanged = true;
    }
    if (!emailChanged && !passwordChanged) return toSummary(staff); // resubmitted the same email

    // Signs out whatever devices this staff member was already logged in on.
    patch.credentialsChangedAt = nowTs();
    const saved = await db.update<AppUser>("app_user", staffId, patch);
    // To the NEW address on an email change — the old one no longer identifies the account.
    db.after(() => sendStaffCredentialsChangedEmail(saved.name ?? saved.username, saved.username, caller.name ?? "Your clinic", emailChanged, passwordChanged));
    return toSummary(saved);
}

export async function updatePermissions(db: Db, caller: AppUser, staffId: number, permissions: unknown): Promise<StaffSummaryDto> {
    requireClinicOwner(caller);
    await requireOwnedStaff(db, caller, staffId);
    return toSummary(await db.update<AppUser>("app_user", staffId, { permissions: joinPermissions(permissions) }));
}

/**
 * Soft-deactivation, not a delete — historical appointments/invoices/notes keep
 * attributing to this staff member's real name. Blocks login and public
 * bookability immediately.
 */
export async function deactivateStaff(caller: AppUser, staffId: number): Promise<StaffSummaryDto> {
    return tx(async (db) => {
        requireClinicOwner(caller);
        await requireOwnedStaff(db, caller, staffId);
        const saved = await db.update<AppUser>("app_user", staffId, { enabled: false, bookable: false });
        await closeOpenSession(db, staffId);
        return toSummary(saved);
    });
}

/**
 * Permanent removal of a staff login — the clinic owner's "Delete", as opposed to
 * the reversible deactivate above. It deletes the account and the things that only
 * exist for that person (their availability, date overrides, weekly slots, service
 * prices and login history). Everything the clinic recorded stays — appointments,
 * notes, invoices, follow-ups — but no longer shows a doctor name, since the
 * account is gone (use deactivate to keep the name on the records).
 *
 * Refused while they still have upcoming sessions: those would be left on a
 * calendar nobody can open, so the owner has to cancel or complete them first.
 * Clients assigned to them become unassigned (visible to the owner as before).
 * Any signed-in device is logged out at once — the session lookup no longer
 * finds the account.
 */
export async function deleteStaff(caller: AppUser, staffId: number): Promise<void> {
    await tx(async (db) => {
        requireClinicOwner(caller);
        const staff = await requireOwnedStaff(db, caller, staffId);

        const upcoming = Number(await db.scalar<string>(
            `SELECT COUNT(*) FROM appointment
              WHERE assigned_doctor_id = $1 AND appointment_date >= $2
                AND status IN ('PENDING', 'AWAITING_PAYMENT', 'PAYMENT_UNDER_REVIEW', 'CONFIRMED')`,
            [staffId, today()]) ?? 0);
        if (upcoming > 0) {
            throw conflict(
                `${staff.name ?? "This staff member"} still has ${upcoming} upcoming session${upcoming === 1 ? "" : "s"}. ` +
                `Cancel ${upcoming === 1 ? "it" : "them"} first, or use Deactivate instead.`);
        }

        for (const table of ["doctor_availability_block", "doctor_date_override", "doctor_weekly_slot", "doctor_service_price"]) {
            await db.exec(`DELETE FROM ${table} WHERE psychologist_id = $1`, [staffId]);
        }
        await db.exec("DELETE FROM staff_attendance WHERE staff_id = $1", [staffId]);
        await db.exec("UPDATE patient SET assigned_doctor_id = NULL WHERE assigned_doctor_id = $1", [staffId]);
        await db.exec("DELETE FROM app_user WHERE id = $1 AND tenant_id = $2", [staffId, caller.id]);
    });
}

export async function reactivateStaff(db: Db, caller: AppUser, staffId: number): Promise<StaffSummaryDto> {
    requireClinicOwner(caller);
    await requireOwnedStaff(db, caller, staffId);
    return toSummary(await db.update<AppUser>("app_user", staffId, { enabled: true }));
}

// ── Attendance (login/logout times for clinic staff) ─────────────────────────

export interface AttendanceDto {
    id: number; staffId: number; staffName: string | null; staffUsername: string; staffJobTitle: string | null;
    loginTime: string; logoutTime: string | null; workMinutes: number | null; date: string;
}

const ATTENDANCE_SQL = `
    SELECT sa.*, u.name AS staff_name, u.username AS staff_username, u.job_title AS staff_job_title
      FROM staff_attendance sa JOIN app_user u ON u.id = sa.staff_id`;

type AttendanceRow = StaffAttendance & { staffName: string | null; staffUsername: string; staffJobTitle: string | null };

const toAttendanceDto = (a: AttendanceRow): AttendanceDto => ({
    id: a.id, staffId: a.staffId, staffName: a.staffName, staffUsername: a.staffUsername, staffJobTitle: a.staffJobTitle,
    loginTime: a.loginTime, logoutTime: a.logoutTime, workMinutes: a.workMinutes, date: a.date,
});

/** Tracks anyone with tenantId set; tenant roots and the superadmin are never tracked. */
export async function recordLogin(db: Db, user: AppUser): Promise<void> {
    if (user.tenantId === null) return;
    await db.insert("staff_attendance", { staffId: user.id, loginTime: nowTs(), date: nowTs().slice(0, 10) });
}

export async function recordLogout(db: Db, user: AppUser): Promise<void> {
    if (user.tenantId === null) return;
    await closeOpenSession(db, user.id);
}

export async function closeOpenSession(db: Db, staffId: number): Promise<void> {
    const open = await db.one<StaffAttendance>(
        "SELECT * FROM staff_attendance WHERE staff_id = $1 AND logout_time IS NULL ORDER BY login_time DESC LIMIT 1", [staffId]);
    if (!open) return;
    const now = nowTs();
    const minutes = Math.floor((Date.parse(now.replace(" ", "T") + "Z") - Date.parse(open.loginTime.replace(" ", "T") + "Z")) / 60000);
    await db.update("staff_attendance", open.id, { logoutTime: now, workMinutes: minutes });
}

export async function getTenantHistory(db: Db, tenantId: number): Promise<AttendanceDto[]> {
    return (await db.many<AttendanceRow>(`${ATTENDANCE_SQL} WHERE u.tenant_id = $1 ORDER BY sa.login_time DESC`, [tenantId])).map(toAttendanceDto);
}
export async function getTenantHistoryForDate(db: Db, tenantId: number, date: string): Promise<AttendanceDto[]> {
    return (await db.many<AttendanceRow>(`${ATTENDANCE_SQL} WHERE u.tenant_id = $1 AND sa.date = $2 ORDER BY sa.login_time DESC`, [tenantId, date])).map(toAttendanceDto);
}
export async function getActiveForTenant(db: Db, tenantId: number): Promise<AttendanceDto[]> {
    return (await db.many<AttendanceRow>(`${ATTENDANCE_SQL} WHERE u.tenant_id = $1 AND sa.logout_time IS NULL ORDER BY sa.login_time DESC`, [tenantId])).map(toAttendanceDto);
}
// Ownership-checked — a staffId belonging to a different tenant is rejected first.
export async function getHistoryForStaff(db: Db, tenantId: number, staffId: number): Promise<AttendanceDto[]> {
    if (!(await db.one("SELECT 1 FROM app_user WHERE id = $1 AND tenant_id = $2", [staffId, tenantId]))) {
        throw notFound(`Staff member not found: ${staffId}`);
    }
    return (await db.many<AttendanceRow>(`${ATTENDANCE_SQL} WHERE sa.staff_id = $1 ORDER BY sa.login_time DESC`, [staffId])).map(toAttendanceDto);
}
