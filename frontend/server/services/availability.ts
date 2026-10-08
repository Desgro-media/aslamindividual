import type { Db } from "../db";
import { badRequest, notFound } from "../http";
import {
    WEEKDAYS, dayOfWeek, overlaps, requireValidSessionMinutes, timeToMinutes, today, nowMinutes, minutesToHm,
} from "../time";
import {
    AppUser, Appointment, AvailabilityBlock, ClinicService, DateOverride, DoctorServicePrice, WeeklySlot,
} from "../types";

// Everything here operates on ONE practitioner's own availability/pricing. The
// caller resolves *which* practitioner (from the authenticated user, never from
// a client-supplied id) and passes it in.
//
// Online/offline session mode is a second, independent dimension: every
// availability table (block, legacy weekly slot, date override) and the
// per-service price carries a `mode`, so a clinic's staff doctors each get
// fully independent online/offline calendars and price sheets.

const ONLINE = "ONLINE";
const OFFLINE = "OFFLINE";
const resolveMode = (mode: string | null | undefined) => mode ?? OFFLINE;

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface DoctorServicePriceDto {
    id: number | null;
    clinicServiceId: number;
    serviceName: string;
    serviceDescription: string | null;
    serviceDuration: string;
    serviceIcon: string | null;
    serviceCategory: string;
    onlinePrice: number | null;
    offlinePrice: number | null;
    onlineOffered: boolean;
    offlineOffered: boolean;
}

export interface DoctorWeeklySlotDto { id: number; dayOfWeek: string; slotTime: string; active: boolean }
export interface DoctorDateOverrideDto { id: number; specificDate: string; slotTime: string | null; available: boolean; mode: string | null }
export interface AvailabilityBlockDto { id: number; dayOfWeek: string; startTime: string; endTime: string; intervalMinutes: number; mode: string }
export interface AvailabilitySummaryDto { enabledWeekdays: string[]; extraDates: string[]; blockedDates: string[] }

const isIndividualDoctor = (d: AppUser) => d.tenantId === null && d.accountType !== "CLINIC";

async function requireDoctor(db: Db, id: number): Promise<AppUser> {
    const doctor = await db.one<AppUser>("SELECT * FROM app_user WHERE id = $1", [id]);
    if (!doctor) throw notFound(`Doctor not found: ${id}`);
    return doctor;
}

// ── Services & pricing ───────────────────────────────────────────────────────

function toIndividualDto(svc: ClinicService, override: DoctorServicePrice | undefined): DoctorServicePriceDto {
    // Individual doctor + catalog service: no row yet means "auto-offered
    // offline at the catalog fee, online not yet configured" — the one place
    // the individual zero-config fallback lives.
    const offlineOffered = !override || override.offlineOffered;
    const onlineOffered = !!override && override.onlineOffered;
    const offlinePrice = override && override.offlinePrice !== null ? override.offlinePrice : svc.fee ?? 0;
    const onlinePrice = override ? override.onlinePrice : null;
    return {
        id: override ? override.id : null,
        clinicServiceId: svc.id,
        serviceName: svc.name,
        serviceDescription: svc.description,
        serviceDuration: svc.duration,
        serviceIcon: svc.icon,
        serviceCategory: svc.category,
        onlinePrice,
        offlinePrice,
        onlineOffered,
        offlineOffered,
    };
}

function toClinicStaffDto(svc: ClinicService, override: DoctorServicePrice | undefined): DoctorServicePriceDto {
    // Clinic staff + catalog service: no row means "not offered in either mode".
    return {
        id: override ? override.id : null,
        clinicServiceId: svc.id,
        serviceName: svc.name,
        serviceDescription: svc.description,
        serviceDuration: svc.duration,
        serviceIcon: svc.icon,
        serviceCategory: svc.category,
        onlinePrice: override ? override.onlinePrice : null,
        offlinePrice: override ? override.offlinePrice : null,
        onlineOffered: !!override && override.onlineOffered,
        offlineOffered: !!override && override.offlineOffered,
    };
}

/**
 * Services a doctor offers in EITHER mode (for the booking form). Individual
 * practitioners have no OFFLINE opt-in step — every active catalog service is
 * bookable at the catalog fee unless overridden; ONLINE is always an explicit
 * opt-in. Clinic staff opt in per service per mode.
 */
export async function getDoctorOfferedServices(db: Db, doctorId: number): Promise<DoctorServicePriceDto[]> {
    const doctor = await requireDoctor(db, doctorId);
    if (isIndividualDoctor(doctor)) {
        const overrides = await db.many<DoctorServicePrice>("SELECT * FROM doctor_service_price WHERE psychologist_id = $1", [doctorId]);
        const byService = new Map(overrides.map((o) => [o.clinicServiceId, o]));
        const services = await db.many<ClinicService>(
            "SELECT * FROM clinic_service WHERE psychologist_id = $1 AND active = true ORDER BY display_order ASC, created_at ASC",
            [doctorId]
        );
        return services
            .map((s) => toIndividualDto(s, byService.get(s.id)))
            .filter((d) => d.onlineOffered || d.offlineOffered);
    }
    const rows = await db.many<DoctorServicePrice & { svc: ClinicService }>(
        `SELECT dsp.*, row_to_json(cs) AS svc
           FROM doctor_service_price dsp JOIN clinic_service cs ON cs.id = dsp.clinic_service_id
          WHERE dsp.psychologist_id = $1 ORDER BY dsp.id`,
        [doctorId]
    );
    return rows
        .filter((r) => r.onlineOffered || r.offlineOffered)
        .map((r) => {
            const svc = camelRow<ClinicService>(r.svc as unknown as Record<string, any>);
            return toClinicStaffDto(svc, r);
        });
}

// row_to_json hands back snake_case keys; map them like the Db layer does.
function camelRow<T>(raw: Record<string, any>): T {
    const out: Record<string, any> = {};
    for (const k of Object.keys(raw)) out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = raw[k];
    return out as T;
}

/**
 * All of a doctor's services with prices (including not-offered) — powers the
 * Services-page pricing editor. `tenantId` scopes the shared catalog (clinic
 * wide); `doctorId` scopes which of those this practitioner has priced.
 */
export async function getAllDoctorServices(db: Db, tenantId: number, doctorId: number): Promise<DoctorServicePriceDto[]> {
    const doctor = await requireDoctor(db, doctorId);
    const individual = isIndividualDoctor(doctor);
    const all = await db.many<ClinicService>(
        "SELECT * FROM clinic_service WHERE psychologist_id = $1 AND active = true ORDER BY display_order ASC, created_at ASC",
        [tenantId]
    );
    const configs = await db.many<DoctorServicePrice>("SELECT * FROM doctor_service_price WHERE psychologist_id = $1", [doctorId]);
    const byService = new Map(configs.map((c) => [c.clinicServiceId, c]));
    return all.map((s) => (individual ? toIndividualDto(s, byService.get(s.id)) : toClinicStaffDto(s, byService.get(s.id))));
}

export interface ServicePriceUpdate {
    clinicServiceId: number;
    onlinePrice: number | null;
    offlinePrice: number | null;
    onlineOffered: boolean;
    offlineOffered: boolean;
}

/** Save all of a doctor's service prices at once. The incoming DTOs carry the full current state. */
export async function saveDoctorServices(
    db: Db, tenantId: number, doctorId: number, updates: ServicePriceUpdate[]
): Promise<DoctorServicePriceDto[]> {
    await requireDoctor(db, doctorId);
    for (const dto of updates) {
        // Ownership-checked — a service id belonging to another tenant is rejected.
        const svc = await db.one<ClinicService>(
            "SELECT * FROM clinic_service WHERE id = $1 AND psychologist_id = $2",
            [dto.clinicServiceId, tenantId]
        );
        if (!svc) throw notFound(`Service not found: ${dto.clinicServiceId}`);
        const onlinePrice = dto.onlinePrice ?? 0;
        const offlinePrice = dto.offlinePrice ?? 0;
        const existing = await db.one<DoctorServicePrice>(
            "SELECT * FROM doctor_service_price WHERE psychologist_id = $1 AND clinic_service_id = $2",
            [doctorId, svc.id]
        );
        if (existing) {
            await db.update("doctor_service_price", existing.id, {
                onlinePrice, offlinePrice, onlineOffered: !!dto.onlineOffered, offlineOffered: !!dto.offlineOffered,
            });
        } else {
            await db.insert("doctor_service_price", {
                psychologistId: doctorId, clinicServiceId: svc.id,
                onlinePrice, offlinePrice, onlineOffered: !!dto.onlineOffered, offlineOffered: !!dto.offlineOffered,
            });
        }
    }
    return getAllDoctorServices(db, tenantId, doctorId);
}

// ── Legacy weekly slots ──────────────────────────────────────────────────────

export async function getDoctorWeeklySchedule(db: Db, doctorId: number): Promise<Record<string, DoctorWeeklySlotDto[]>> {
    const slots = await db.many<WeeklySlot>("SELECT * FROM doctor_weekly_slot WHERE psychologist_id = $1", [doctorId]);
    const schedule: Record<string, DoctorWeeklySlotDto[]> = {};
    for (const d of WEEKDAYS) schedule[d] = [];
    for (const s of slots) {
        (schedule[s.dayOfWeek] ||= []).push({ id: s.id, dayOfWeek: s.dayOfWeek, slotTime: s.slotTime, active: s.active });
    }
    for (const list of Object.values(schedule)) list.sort((a, b) => (a.slotTime < b.slotTime ? -1 : a.slotTime > b.slotTime ? 1 : 0));
    return schedule;
}

export async function addWeeklySlot(db: Db, doctorId: number, day: string, slotTime: string): Promise<DoctorWeeklySlotDto> {
    await requireDoctor(db, doctorId);
    if (!day || !slotTime) throw badRequest("dayOfWeek and slotTime are required");
    const s = await db.insert<WeeklySlot>("doctor_weekly_slot", {
        psychologistId: doctorId, dayOfWeek: day.toUpperCase(), slotTime, active: true, mode: OFFLINE,
    });
    return { id: s.id, dayOfWeek: s.dayOfWeek, slotTime: s.slotTime, active: s.active };
}

export async function removeWeeklySlot(db: Db, slotId: number, doctorId: number): Promise<void> {
    await db.exec("DELETE FROM doctor_weekly_slot WHERE id = $1 AND psychologist_id = $2", [slotId, doctorId]);
}

// ── Date overrides ───────────────────────────────────────────────────────────

const toOverrideDto = (o: DateOverride): DoctorDateOverrideDto => ({
    id: o.id, specificDate: o.specificDate, slotTime: o.slotTime, available: o.available, mode: o.mode,
});

export async function getDateOverrides(db: Db, doctorId: number): Promise<DoctorDateOverrideDto[]> {
    const rows = await db.many<DateOverride>(
        "SELECT * FROM doctor_date_override WHERE psychologist_id = $1 AND specific_date >= $2 ORDER BY id",
        [doctorId, today()]
    );
    return rows.map(toOverrideDto);
}

/**
 * `mode` may be null ONLY for a whole-day block (slotTime == null): "applies to
 * both calendars" is unambiguous for leave/holiday. A slot-specific override
 * must name an explicit mode.
 */
export async function addDateOverride(
    db: Db, doctorId: number, date: string, slotTime: string | null, available: boolean, mode: string | null
): Promise<DoctorDateOverrideDto> {
    if (slotTime !== null && mode === null) throw badRequest("mode is required when setting a specific slot time");
    await requireDoctor(db, doctorId);
    const o = await db.insert<DateOverride>("doctor_date_override", {
        psychologistId: doctorId, specificDate: date, slotTime, available, mode,
    });
    return toOverrideDto(o);
}

export async function removeDateOverride(db: Db, overrideId: number, doctorId: number): Promise<void> {
    await db.exec("DELETE FROM doctor_date_override WHERE id = $1 AND psychologist_id = $2", [overrideId, doctorId]);
}

// ── Availability blocks ──────────────────────────────────────────────────────

const toBlockDto = (b: AvailabilityBlock): AvailabilityBlockDto => ({
    id: b.id, dayOfWeek: b.dayOfWeek, startTime: b.startTime, endTime: b.endTime,
    intervalMinutes: b.intervalMinutes, mode: resolveMode(b.mode),
});

export async function getAvailabilityBlocks(db: Db, doctorId: number): Promise<Record<string, AvailabilityBlockDto[]>> {
    const blocks = await db.many<AvailabilityBlock>(
        "SELECT * FROM doctor_availability_block WHERE psychologist_id = $1 ORDER BY day_of_week ASC, start_time ASC",
        [doctorId]
    );
    const result: Record<string, AvailabilityBlockDto[]> = {};
    for (const d of WEEKDAYS) result[d] = [];
    for (const b of blocks) (result[b.dayOfWeek] ||= []).push(toBlockDto(b));
    return result;
}

const HM_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

function parseBlockTime(value: unknown, label: string): number {
    if (typeof value !== "string" || !value.trim()) throw badRequest(`${label} is required`);
    const m = HM_RE.exec(value.trim());
    const mins = m ? timeToMinutes(value) : null;
    if (mins === null) throw badRequest(`${label} must be in HH:mm format`);
    return mins;
}

/**
 * Add availability blocks (one per selected day). Everything is validated
 * BEFORE anything is saved — an interval of 0 used to make slot generation loop
 * forever. A day is skipped if an identical block already exists, so "Apply to
 * selected days" is safely repeatable.
 */
export async function addAvailabilityBlocks(
    db: Db, doctorId: number, daysOfWeek: string[] | null, startTime: string, endTime: string,
    intervalMinutes: number, mode: string | null
): Promise<AvailabilityBlockDto[]> {
    if (!daysOfWeek || daysOfWeek.length === 0) throw badRequest("Select at least one day");
    const start = parseBlockTime(startTime, "Start time");
    const end = parseBlockTime(endTime, "End time");
    if (start >= end) throw badRequest("Start time must be before end time");
    requireValidSessionMinutes(intervalMinutes);
    if (mode !== null && mode !== ONLINE && mode !== OFFLINE) throw badRequest("Mode must be ONLINE or OFFLINE");

    const days: string[] = [];
    for (const day of daysOfWeek) {
        const upper = day == null ? "" : String(day).trim().toUpperCase();
        if (!WEEKDAYS.includes(upper)) throw badRequest(`Invalid day of week: ${day}`);
        if (!days.includes(upper)) days.push(upper);
    }
    const startHm = minutesToHm(start);
    const endHm = minutesToHm(end);

    await requireDoctor(db, doctorId);
    const resolvedMode = resolveMode(mode);
    const created: AvailabilityBlockDto[] = [];
    for (const day of days) {
        const existing = await db.many<AvailabilityBlock>(
            "SELECT * FROM doctor_availability_block WHERE psychologist_id = $1 AND day_of_week = $2 AND mode = $3",
            [doctorId, day, resolvedMode]
        );
        if (existing.some((b) => b.startTime === startHm && b.endTime === endHm && b.intervalMinutes === intervalMinutes)) continue;
        const block = await db.insert<AvailabilityBlock>("doctor_availability_block", {
            psychologistId: doctorId, dayOfWeek: day, startTime: startHm, endTime: endHm,
            intervalMinutes, mode: resolvedMode,
        });
        created.push(toBlockDto(block));
    }
    return created;
}

export async function removeAvailabilityBlock(db: Db, blockId: number, doctorId: number): Promise<void> {
    await db.exec("DELETE FROM doctor_availability_block WHERE id = $1 AND psychologist_id = $2", [blockId, doctorId]);
}

/** Clears one day on ONE calendar — clearing Monday-online never touches Monday-offline. */
export async function clearDayBlocks(db: Db, doctorId: number, day: string, mode: string | null): Promise<void> {
    await db.exec(
        "DELETE FROM doctor_availability_block WHERE psychologist_id = $1 AND day_of_week = $2 AND mode = $3",
        [doctorId, day.toUpperCase(), resolveMode(mode)]
    );
}

// ── Slot computation ─────────────────────────────────────────────────────────

// Strict "HH:mm[:ss]" with a 2-digit hour, like LocalTime.parse — a legacy
// "9:00" string can never be booked, so it is dropped rather than offered.
function tryParseSlot(value: string | null): number | null {
    if (!value || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
    return timeToMinutes(value);
}

/**
 * Open start times for a doctor, in a given mode, on a given date. Only the
 * OPEN-WINDOW sources (legacy weekly slots, blocks, overrides) are mode
 * filtered. Existing appointments are looked up across ALL modes — one
 * physical doctor can't run an ONLINE and an OFFLINE session at once.
 *
 * `sessionMinutes` is the length the caller intends to book; a start time is
 * only offered if a session of that length would not collide with an existing
 * appointment — matching the authoritative check at booking time. Null (the
 * public flow) still hides any start time that falls inside an existing one.
 */
export async function getAvailableSlotsForDoctor(
    db: Db, doctorId: number, date: string, isHoliday: boolean, mode: string | null, sessionMinutes: number | null
): Promise<string[]> {
    if (isHoliday) return [];
    const resolvedMode = resolveMode(mode);
    const candidateMinutes = sessionMinutes !== null ? requireValidSessionMinutes(sessionMinutes) : 1;
    const dow = dayOfWeek(date);
    const slots = new Set<string>();

    // 1. Legacy individual weekly slots (OFFLINE only in practice)
    const weekly = await db.many<WeeklySlot>(
        "SELECT * FROM doctor_weekly_slot WHERE psychologist_id = $1 AND day_of_week = $2 AND mode = $3 AND active = true",
        [doctorId, dow, resolvedMode]
    );
    weekly.forEach((s) => slots.add(s.slotTime));

    // 2. Block-based availability — walks integer minutes-of-day (no wrap at midnight)
    const blocks = await db.many<AvailabilityBlock>(
        "SELECT * FROM doctor_availability_block WHERE psychologist_id = $1 AND day_of_week = $2 AND mode = $3",
        [doctorId, dow, resolvedMode]
    );
    for (const block of blocks) {
        const interval = block.intervalMinutes;
        if (interval <= 0) continue; // corrupt row — would never advance
        const bs = tryParseSlot(block.startTime);
        const be = tryParseSlot(block.endTime);
        if (bs === null || be === null) continue;
        for (let t = bs; t < be; t += interval) slots.add(minutesToHm(t));
    }

    // 3. Date-specific overrides — a null-mode row (whole-day block) applies here too
    const overrides = await db.many<DateOverride>(
        "SELECT * FROM doctor_date_override WHERE psychologist_id = $1 AND specific_date = $2 AND (mode IS NULL OR mode = $3)",
        [doctorId, date, resolvedMode]
    );
    for (const o of overrides) {
        if (o.available && o.slotTime !== null) {
            slots.add(o.slotTime);
        } else if (!o.available) {
            if (o.slotTime === null) return []; // entire day blocked
            slots.delete(o.slotTime);
        }
    }

    // 4. Drop slots colliding with a non-cancelled appointment, slots already
    //    past today, and slots whose session would run past midnight.
    const active = await db.many<Appointment>(
        "SELECT * FROM appointment WHERE appointment_date = $1 AND assigned_doctor_id = $2 AND status <> 'CANCELLED'",
        [date, doctorId]
    );
    const booked = active.map((a) => ({ s: timeToMinutes(a.startTime)!, e: timeToMinutes(a.endTime)! }));
    const isToday = date === today();
    const nowMin = nowMinutes();
    return [...slots]
        .filter((s) => {
            const start = tryParseSlot(s);
            if (start === null) return false;
            if (isToday && start <= nowMin) return false;
            if (start + candidateMinutes >= 24 * 60) return false;
            const end = start + candidateMinutes;
            return booked.every((a) => start !== a.s && !overlaps(start, end, a.s, a.e));
        })
        .sort();
}

/**
 * Lets the booking calendar disable days that can't have a slot for a mode,
 * before the user picks a date. Schedule-only, not booked-slot-aware.
 */
export async function getAvailabilitySummary(db: Db, doctorId: number, mode: string | null): Promise<AvailabilitySummaryDto> {
    const resolvedMode = resolveMode(mode);
    const weekdays = new Set<string>();
    const blocks = await db.many<AvailabilityBlock>(
        "SELECT * FROM doctor_availability_block WHERE psychologist_id = $1 ORDER BY day_of_week ASC, start_time ASC",
        [doctorId]
    );
    blocks.filter((b) => resolveMode(b.mode) === resolvedMode).forEach((b) => weekdays.add(b.dayOfWeek));
    if (resolvedMode === OFFLINE) {
        const weekly = await db.many<WeeklySlot>("SELECT * FROM doctor_weekly_slot WHERE psychologist_id = $1", [doctorId]);
        weekly.filter((s) => s.active).forEach((s) => weekdays.add(s.dayOfWeek));
    }

    const blocked = new Set<string>();
    const extra = new Set<string>();
    const overrides = await db.many<DateOverride>(
        "SELECT * FROM doctor_date_override WHERE psychologist_id = $1 AND specific_date >= $2 ORDER BY id",
        [doctorId, today()]
    );
    for (const o of overrides) {
        const applies = o.mode === null || o.mode === resolvedMode;
        if (!applies) continue;
        if (!o.available && o.slotTime === null) blocked.add(o.specificDate);
        else if (o.available && o.slotTime !== null) extra.add(o.specificDate);
    }
    return { enabledWeekdays: [...weekdays], extraDates: [...extra], blockedDates: [...blocked] };
}

/**
 * A specific doctor's BOOKABLE price for a service+mode, rejecting anything the
 * doctor hasn't opted into. Never trust a client-supplied mode/price combo
 * without this check.
 */
export async function resolveBookablePrice(
    db: Db, tenantId: number | null, doctorId: number | null, clinicServiceId: number | null, mode: string | null
): Promise<number> {
    const resolvedMode = resolveMode(mode);
    const online = resolvedMode === ONLINE;
    const notOffered = () => badRequest(`This practitioner does not offer this service ${online ? "online" : "in person"}`);

    if (doctorId !== null && clinicServiceId !== null) {
        const dsp = await db.one<DoctorServicePrice>(
            "SELECT * FROM doctor_service_price WHERE psychologist_id = $1 AND clinic_service_id = $2",
            [doctorId, clinicServiceId]
        );
        if (dsp) {
            const offered = online ? dsp.onlineOffered : dsp.offlineOffered;
            if (offered) {
                const price = online ? dsp.onlinePrice : dsp.offlinePrice;
                return price ?? 0;
            }
            throw notOffered();
        }
    }

    // No configured row at all — the individual, zero-config, OFFLINE-only
    // auto-fallback. ONLINE never falls back to the catalog.
    if (!online && doctorId !== null && clinicServiceId !== null && tenantId !== null) {
        const doctor = await db.one<AppUser>("SELECT * FROM app_user WHERE id = $1", [doctorId]);
        if (doctor && isIndividualDoctor(doctor)) {
            const svc = await db.one<ClinicService>(
                "SELECT * FROM clinic_service WHERE id = $1 AND psychologist_id = $2",
                [clinicServiceId, tenantId]
            );
            if (!svc) throw badRequest(`Service not found: ${clinicServiceId}`);
            return svc.fee ?? 0;
        }
    }
    throw notOffered();
}

export async function updateDoctorProfile(
    db: Db, doctorId: number, bio: string | null, bookable: boolean, profileImageUrl: string | null
): Promise<AppUser> {
    const user = await db.one<AppUser>("SELECT * FROM app_user WHERE id = $1", [doctorId]);
    if (!user) throw notFound(`User not found: ${doctorId}`);
    return db.update<AppUser>("app_user", doctorId, {
        bio: bio !== null ? bio : undefined,
        bookable,
        profileImageUrl: profileImageUrl !== null ? profileImageUrl : undefined,
    });
}
