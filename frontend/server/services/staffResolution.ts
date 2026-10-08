import type { Db } from "../db";
import { notFound } from "../http";
import { AppUser, Roles } from "../types";

// The single place that turns a client-supplied "which staff member" id into a
// trusted one. Every path that lets a caller pick a specific practitioner — the
// public booking flow and the dashboard's admin-driven scheduling — must go
// through here rather than trusting a raw id, or a clinic's booking page could
// be used to book against a practitioner in a different clinic.

/**
 * Public booking flow. Falls back to the tenant owner's own id when no staff
 * member is requested (the only path an INDIVIDUAL account ever takes). A
 * clinic's chosen staff member must be bookable, enabled, and belong to this
 * tenant; any mismatch fails exactly like "no such practitioner".
 */
export async function resolveBookableDoctorId(db: Db, tenantOwner: AppUser, requestedStaffId: number | null): Promise<number> {
    if (requestedStaffId === null) return tenantOwner.id;
    if (requestedStaffId === tenantOwner.id) {
        if (!tenantOwner.bookable || !tenantOwner.enabled) throw notFound("No such practitioner");
        return tenantOwner.id;
    }
    // Role-filtered at the query itself, so a receptionist/support-staff id can
    // never resolve here even if `bookable` were somehow left true on that row.
    const staff = await db.one<AppUser>(
        "SELECT * FROM app_user WHERE id = $1 AND tenant_id = $2 AND role = $3",
        [requestedStaffId, tenantOwner.id, Roles.PSYCHOLOGIST]
    );
    if (!staff || !staff.bookable || !staff.enabled) throw notFound("No such practitioner");
    return staff.id;
}

/**
 * Dashboard-driven scheduling (manual booking / past-session recording /
 * demo-call conversion). Unlike the public flow it does not require "bookable"
 * — an admin can schedule against a staff member who isn't publicly listed.
 * Falls back to the caller's own id when none is requested.
 */
export async function resolveTenantStaffId(
    db: Db, tenantId: number, callerOwnId: number, requestedAssignedDoctorId: number | null
): Promise<number> {
    if (requestedAssignedDoctorId === null) return callerOwnId;
    if (requestedAssignedDoctorId === tenantId) return tenantId;
    const staff = await db.one<AppUser>(
        "SELECT * FROM app_user WHERE id = $1 AND tenant_id = $2 AND role = $3",
        [requestedAssignedDoctorId, tenantId, Roles.PSYCHOLOGIST]
    );
    if (!staff || !staff.enabled) throw notFound("No such staff member");
    return staff.id;
}
