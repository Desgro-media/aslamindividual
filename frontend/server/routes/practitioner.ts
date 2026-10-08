import { Ctx, del, get, patch, post, put } from "../router";
import { badRequest, JsonObject, noContent, pathId } from "../http";
import { tenantIdOf } from "../security/auth";
import { parseDate } from "../time";
import { AppUser } from "../types";
import { tx } from "../db";
import * as avail from "../services/availability";
import * as staffSvc from "../services/staff";
import * as superadmin from "../services/superadmin";

// A practitioner's OWN calendar/profile (/me/**), a clinic owner's staff
// management (/staff/**), and the platform superadmin console (/superadmin/**).

const tenant = (c: Ctx) => tenantIdOf(c.me());

const strOrNull = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

async function holidayOn(c: Ctx, date: string, tenantId: number): Promise<boolean> {
    return !!(await c.db.one("SELECT 1 FROM clinic_holiday WHERE holiday_date = $1 AND psychologist_id = $2", [date, tenantId]));
}

function parseOptionalDuration(c: Ctx): number | null {
    const raw = c.query.get("duration");
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw badRequest("Invalid value for 'duration'.");
    return n;
}

// Shared by /me/** (the caller's own id) and /staff/:staffId/** (an owner acting
// on a staff member): the actual logic is parameterised by an explicit doctor id.
function registerAvailabilityRoutes(prefix: string, resolveDoctor: (c: Ctx) => Promise<AppUser>) {
    get(`${prefix}/availability-blocks`, "user", async (c) => avail.getAvailabilityBlocks(c.db, (await resolveDoctor(c)).id));

    post(`${prefix}/availability-blocks`, "user", async (c) => {
        const doctor = await resolveDoctor(c);
        const body = await c.body();
        if (body.intervalMinutes == null) throw badRequest("Session length is required");
        const interval = Number(body.intervalMinutes);
        if (!Number.isInteger(interval)) throw badRequest(`Invalid date/time or number format: For input string: "${body.intervalMinutes}"`);
        return avail.addAvailabilityBlocks(
            c.db, doctor.id, Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map(String) : null,
            strOrNull(body.startTime) as string, strOrNull(body.endTime) as string, interval, strOrNull(body.mode));
    });

    del(`${prefix}/availability-blocks/day/:dayOfWeek`, "user", async (c) => {
        const doctor = await resolveDoctor(c);
        await avail.clearDayBlocks(c.db, doctor.id, c.params.dayOfWeek, c.query.get("mode"));
        return noContent();
    });

    del(`${prefix}/availability-blocks/:blockId`, "user", async (c) => {
        const doctor = await resolveDoctor(c);
        await avail.removeAvailabilityBlock(c.db, pathId(c.params.blockId), doctor.id);
        return noContent();
    });

    get(`${prefix}/date-overrides`, "user", async (c) => avail.getDateOverrides(c.db, (await resolveDoctor(c)).id));

    post(`${prefix}/date-overrides`, "user", async (c) => {
        const doctor = await resolveDoctor(c);
        const body = await c.body();
        const date = parseDate(body.specificDate, "specificDate");
        const available = body.available == null || String(body.available).toLowerCase() === "true";
        return avail.addDateOverride(c.db, doctor.id, date, strOrNull(body.slotTime), available, strOrNull(body.mode));
    });

    del(`${prefix}/date-overrides/:overrideId`, "user", async (c) => {
        const doctor = await resolveDoctor(c);
        await avail.removeDateOverride(c.db, pathId(c.params.overrideId), doctor.id);
        return noContent();
    });

    get(`${prefix}/services`, "user", async (c) => {
        const doctor = await resolveDoctor(c);
        return avail.getAllDoctorServices(c.db, doctor.tenantId ?? doctor.id, doctor.id);
    });

    put(`${prefix}/services`, "user", async (c) => {
        const doctor = await resolveDoctor(c);
        const body = await c.req.json().catch(() => null);
        if (!Array.isArray(body)) throw badRequest("The request could not be read — please check the values you entered.");
        const updates = body.map((d: JsonObject) => ({
            clinicServiceId: Number(d.clinicServiceId),
            onlinePrice: d.onlinePrice == null ? null : Number(d.onlinePrice),
            offlinePrice: d.offlinePrice == null ? null : Number(d.offlinePrice),
            onlineOffered: d.onlineOffered === true,
            offlineOffered: d.offlineOffered === true,
        }));
        const tenantId = doctor.tenantId ?? doctor.id;
        return tx((db) => avail.saveDoctorServices(db, tenantId, doctor.id, updates));
    });
}

export function registerPractitionerRoutes(): void {
    // ── /me/** : the caller's own profile & calendar ─────────────────────────
    const toProfile = (u: AppUser) => ({
        id: u.id, username: u.username, name: u.name, slug: u.slug, jobTitle: u.jobTitle, bio: u.bio,
        bookable: u.bookable, profileImageUrl: u.profileImageUrl,
    });
    get("/me/profile", "user", async (c) => toProfile(c.me()));

    patch("/me/profile", "user", async (c) => {
        const body = await c.body();
        const bookable = body.bookable == null || String(body.bookable).toLowerCase() === "true";
        const updated = await avail.updateDoctorProfile(c.db, c.me().id, strOrNull(body.bio), bookable, strOrNull(body.profileImageUrl));
        return toProfile(updated);
    });

    // Slots on the caller's own calendar — the dashboard's manual "Schedule Appointment" flow.
    get("/me/slots", "user", async (c) => {
        const date = parseDate(c.query.get("date"), "date");
        const me = c.me();
        // Clinic closures are tenant-wide; slot conflict is scoped to this doctor's own calendar.
        return avail.getAvailableSlotsForDoctor(c.db, me.id, date, await holidayOn(c, date, tenantIdOf(me)), c.query.get("mode"), parseOptionalDuration(c));
    });

    get("/me/weekly-schedule", "user", async (c) => avail.getDoctorWeeklySchedule(c.db, c.me().id));
    post("/me/weekly-slots", "user", async (c) => {
        const body = await c.body();
        return avail.addWeeklySlot(c.db, c.me().id, String(body.dayOfWeek ?? ""), String(body.slotTime ?? ""));
    });
    del("/me/weekly-slots/:slotId", "user", async (c) => {
        await avail.removeWeeklySlot(c.db, pathId(c.params.slotId), c.me().id);
        return noContent();
    });

    registerAvailabilityRoutes("/me", async (c) => c.me());

    // ── /staff/** : clinic owner managing staff ──────────────────────────────
    // Static paths first so `attendance` is never mistaken for a staff id.
    get("/staff/attendance/active", "user", async (c) => {
        staffSvc.requireClinicOwner(c.me());
        return staffSvc.getActiveForTenant(c.db, c.me().id);
    });
    get("/staff/attendance/date/:date", "user", async (c) => {
        staffSvc.requireClinicOwner(c.me());
        return staffSvc.getTenantHistoryForDate(c.db, c.me().id, parseDate(c.params.date, "date"));
    });
    get("/staff/attendance/staff/:staffId", "user", async (c) => {
        staffSvc.requireClinicOwner(c.me());
        return staffSvc.getHistoryForStaff(c.db, c.me().id, pathId(c.params.staffId));
    });
    get("/staff/attendance", "user", async (c) => {
        staffSvc.requireClinicOwner(c.me());
        return staffSvc.getTenantHistory(c.db, c.me().id);
    });

    get("/staff", "user", async (c) => staffSvc.listStaff(c.db, c.me()));
    post("/staff", "user", async (c) => staffSvc.createStaff(c.db, c.me(), await c.body()));
    put("/staff/:id/permissions", "user", async (c) => {
        const perms = await c.req.json().catch(() => null);
        if (!Array.isArray(perms)) throw badRequest("The request could not be read — please check the values you entered.");
        return staffSvc.updatePermissions(c.db, c.me(), pathId(c.params.id), perms);
    });
    patch("/staff/:id/details", "user", async (c) => {
        const body = await c.body();
        return staffSvc.updateStaff(c.db, c.me(), pathId(c.params.id), { name: body.name, role: body.role });
    });
    patch("/staff/:id/credentials", "user", async (c) => {
        const body = await c.body();
        return staffSvc.updateCredentials(c.db, c.me(), pathId(c.params.id), strOrNull(body.username), strOrNull(body.password));
    });
    post("/staff/:id/reactivate", "user", async (c) => staffSvc.reactivateStaff(c.db, c.me(), pathId(c.params.id)));
    put("/staff/:id", "user", async (c) => staffSvc.updateStaff(c.db, c.me(), pathId(c.params.id), await c.body()));
    del("/staff/:id", "user", async (c) => staffSvc.deactivateStaff(c.me(), pathId(c.params.id)));

    // A clinic owner managing one staff member's calendar & pricing directly.
    const ownedStaff = async (c: Ctx): Promise<AppUser> => {
        const caller = c.me();
        staffSvc.requireClinicOwner(caller);
        return staffSvc.requireOwnedStaff(c.db, caller, pathId(c.params.staffId, "staffId"));
    };
    get("/staff/:staffId/slots", "user", async (c) => {
        const staff = await ownedStaff(c);
        const date = parseDate(c.query.get("date"), "date");
        return avail.getAvailableSlotsForDoctor(c.db, staff.id, date, await holidayOn(c, date, staff.tenantId as number), c.query.get("mode"), parseOptionalDuration(c));
    });
    registerAvailabilityRoutes("/staff/:staffId", ownedStaff);

    // ── /superadmin/** : platform console ────────────────────────────────────
    get("/superadmin/tenants", "superadmin", async (c) => superadmin.listTenants(c.db));
    get("/superadmin/dashboard/stats", "superadmin", async (c) => superadmin.getDashboardStats(c.db));
    get("/superadmin/tenants/:id/payment-submissions", "superadmin", async (c) =>
        superadmin.listSubmissionsForTenant(c.db, pathId(c.params.id)));
    post("/superadmin/tenants/:id/subscription", "superadmin", async (c) =>
        superadmin.overrideSubscription(pathId(c.params.id), c.me().id, superadmin.parseOverride(await c.body())));
    post("/superadmin/tenants/:id/reset-password", "superadmin", async (c) => {
        const body = await c.optionalBody();
        return superadmin.resetTenantPassword(pathId(c.params.id), c.me().id, strOrNull(body.password));
    });
    get("/superadmin/payment-submissions", "superadmin", async (c) => superadmin.listPendingSubmissions(c.db));
    post("/superadmin/payment-submissions/:id/approve", "superadmin", async (c) => superadmin.approve(pathId(c.params.id), c.me().id));
    post("/superadmin/payment-submissions/:id/reject", "superadmin", async (c) => {
        const body = await c.body();
        const reason = body.reason;
        if (reason == null || String(reason).trim() === "") throw badRequest("reason must not be blank");
        if (String(reason).length > 500) throw badRequest("reason size must be between 0 and 500");
        return superadmin.reject(pathId(c.params.id), c.me().id, String(reason));
    });

}
