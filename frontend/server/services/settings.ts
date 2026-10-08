import type { Db } from "../db";
import { JsonObject, badRequest, notFound, notBlank, optStr } from "../http";
import { isValidDate } from "../time";
import { BankAccount, ClinicHoliday, ClinicService, ClinicSettings, Lead } from "../types";
import { optBool, optInt } from "../http";

// ── Practice settings (one row per tenant, created on first read) ────────────

export async function getSettings(db: Db, ownerId: number): Promise<ClinicSettings> {
    const existing = await db.one<ClinicSettings>("SELECT * FROM clinic_settings WHERE psychologist_id = $1", [ownerId]);
    if (existing) return existing;
    return db.insert<ClinicSettings>("clinic_settings", { psychologistId: ownerId });
}

const nz = (body: JsonObject, k: string): string | null => {
    const v = body[k];
    return v === undefined || v === null ? null : String(v);
};

/** PUT semantics: the whole settings object is replaced (an omitted field becomes null), exactly as before. */
export async function updateSettings(db: Db, ownerId: number, body: JsonObject): Promise<ClinicSettings> {
    const settings = await getSettings(db, ownerId);
    return db.update<ClinicSettings>("clinic_settings", settings.id, {
        clinicName: nz(body, "clinicName"),
        doctorName: nz(body, "doctorName"),
        address: nz(body, "address"),
        contactPhone: nz(body, "contactPhone"),
        contactEmail: nz(body, "contactEmail"),
        paymentQrCodeUrl: nz(body, "paymentQrCodeUrl"),
        demoCallNumber: nz(body, "demoCallNumber"),
        bankAccountName: nz(body, "bankAccountName"),
    });
}

// ── Holidays ─────────────────────────────────────────────────────────────────

export const getHolidays = (db: Db, ownerId: number) =>
    db.many<ClinicHoliday>("SELECT * FROM clinic_holiday WHERE psychologist_id = $1 ORDER BY id", [ownerId]);

export async function addHoliday(db: Db, ownerId: number, body: JsonObject): Promise<ClinicHoliday> {
    if (!isValidDate(body.holidayDate)) throw badRequest("holidayDate must not be null");
    return db.insert<ClinicHoliday>("clinic_holiday", {
        psychologistId: ownerId, holidayDate: body.holidayDate, reason: nz(body, "reason"),
    });
}

export async function removeHoliday(db: Db, id: number, ownerId: number): Promise<void> {
    await db.exec("DELETE FROM clinic_holiday WHERE id = $1 AND psychologist_id = $2", [id, ownerId]);
}

// ── Bank accounts ────────────────────────────────────────────────────────────
// The frontend reads/writes `isDefault`; the old backend's Lombok quirk exposed
// the same flag as `default`. Both spellings are emitted and both are accepted.

export interface BankAccountDto {
    id: number; accountName: string | null; bankName: string | null; accountNumber?: string | null;
    ifscCode?: string | null; upiId?: string | null; qrCodeBase64: string | null;
    isDefault: boolean; default: boolean; active: boolean;
}

const toBankDto = (b: BankAccount): BankAccountDto => ({
    id: b.id, accountName: b.accountName, bankName: b.bankName, accountNumber: b.accountNumber,
    ifscCode: b.ifscCode, upiId: b.upiId, qrCodeBase64: b.qrCodeBase64,
    isDefault: b.isDefault, default: b.isDefault, active: b.active,
});

// Public-safe: omits sensitive account details (account number, IFSC, UPI ID).
const toPublicBankDto = (b: BankAccount): BankAccountDto => ({
    id: b.id, accountName: b.accountName, bankName: b.bankName, accountNumber: null, ifscCode: null, upiId: null,
    qrCodeBase64: b.qrCodeBase64,
    isDefault: b.isDefault, default: b.isDefault, active: b.active,
});

const wantsDefault = (body: JsonObject) => body.isDefault === true || body.default === true;

export async function getAllBankAccounts(db: Db, ownerId: number): Promise<BankAccountDto[]> {
    const rows = await db.many<BankAccount>(
        "SELECT * FROM bank_account WHERE psychologist_id = $1 ORDER BY is_default DESC, account_name ASC", [ownerId]);
    return rows.map(toBankDto);
}

export async function getActiveBankAccounts(db: Db, ownerId: number): Promise<BankAccountDto[]> {
    const rows = await db.many<BankAccount>(
        "SELECT * FROM bank_account WHERE psychologist_id = $1 AND active = true ORDER BY id", [ownerId]);
    return rows.map(toPublicBankDto);
}

async function clearOtherDefaults(db: Db, exceptId: number | null, ownerId: number): Promise<void> {
    await db.exec(
        "UPDATE bank_account SET is_default = false WHERE psychologist_id = $1 AND active = true AND is_default = true AND ($2::bigint IS NULL OR id <> $2)",
        [ownerId, exceptId]);
}

export async function createBankAccount(db: Db, body: JsonObject, ownerId: number): Promise<BankAccountDto> {
    const isDefault = wantsDefault(body);
    if (isDefault) await clearOtherDefaults(db, null, ownerId);
    const b = await db.insert<BankAccount>("bank_account", {
        psychologistId: ownerId, accountName: nz(body, "accountName"), bankName: nz(body, "bankName"),
        accountNumber: nz(body, "accountNumber"), ifscCode: nz(body, "ifscCode"), upiId: nz(body, "upiId"),
        qrCodeBase64: nz(body, "qrCodeBase64"), isDefault, active: true,
    });
    return toBankDto(b);
}

export async function updateBankAccount(db: Db, id: number, ownerId: number, body: JsonObject): Promise<BankAccountDto> {
    const existing = await db.one<BankAccount>("SELECT * FROM bank_account WHERE id = $1 AND psychologist_id = $2", [id, ownerId]);
    if (!existing) throw notFound(`Bank account not found: ${id}`);
    const patch: Record<string, unknown> = {};
    for (const k of ["accountName", "bankName", "accountNumber", "ifscCode", "upiId", "qrCodeBase64"]) {
        const v = nz(body, k);
        if (v !== null) patch[k] = v;
    }
    if (wantsDefault(body) && !existing.isDefault) {
        await clearOtherDefaults(db, id, ownerId);
        patch.isDefault = true;
    }
    return toBankDto(await db.update<BankAccount>("bank_account", id, patch));
}

export async function setDefaultBankAccount(db: Db, id: number, ownerId: number): Promise<BankAccountDto> {
    await clearOtherDefaults(db, id, ownerId);
    const existing = await db.one<BankAccount>("SELECT * FROM bank_account WHERE id = $1 AND psychologist_id = $2", [id, ownerId]);
    if (!existing) throw notFound(`Bank account not found: ${id}`);
    return toBankDto(await db.update<BankAccount>("bank_account", id, { isDefault: true }));
}

// Soft delete — past invoices keep referring to the account by name.
export async function deleteBankAccount(db: Db, id: number, ownerId: number): Promise<void> {
    const existing = await db.one<BankAccount>("SELECT * FROM bank_account WHERE id = $1 AND psychologist_id = $2", [id, ownerId]);
    if (!existing) throw notFound(`Bank account not found: ${id}`);
    await db.update("bank_account", id, { active: false });
}

// ── Service catalog ──────────────────────────────────────────────────────────

export const SERVICE_CATEGORIES = ["COUNSELLING", "THERAPY", "ASSESSMENT", "CAREER", "OTHER"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface ClinicServiceDto {
    id: number; name: string; description: string | null; duration: string; fee: number | null; icon: string | null;
    category: string; active: boolean; displayOrder: number; createdAt: string | null;
}

export const toServiceDto = (s: ClinicService): ClinicServiceDto => ({
    id: s.id, name: s.name, description: s.description, duration: s.duration, fee: s.fee, icon: s.icon,
    category: s.category, active: s.active, displayOrder: s.displayOrder, createdAt: s.createdAt,
});

function parseCategory(body: JsonObject): ServiceCategory | undefined {
    const v = body.category;
    if (v === undefined || v === null || v === "") return undefined;
    const up = String(v).trim().toUpperCase();
    if (!(SERVICE_CATEGORIES as readonly string[]).includes(up)) {
        throw badRequest(`Category must be one of ${SERVICE_CATEGORIES.join(", ")}`);
    }
    return up as ServiceCategory;
}

export async function listServices(db: Db, tenantId: number): Promise<ClinicServiceDto[]> {
    const rows = await db.many<ClinicService>(
        "SELECT * FROM clinic_service WHERE psychologist_id = $1 ORDER BY display_order ASC, created_at ASC", [tenantId]);
    return rows.map(toServiceDto);
}

export async function listActiveServices(db: Db, tenantId: number): Promise<ClinicServiceDto[]> {
    const rows = await db.many<ClinicService>(
        "SELECT * FROM clinic_service WHERE psychologist_id = $1 AND active = true ORDER BY display_order ASC, created_at ASC", [tenantId]);
    return rows.map(toServiceDto);
}

export async function createService(db: Db, tenantId: number, body: JsonObject): Promise<ClinicServiceDto> {
    const name = notBlank(body, "name");
    const fee = body.fee === undefined || body.fee === null || body.fee === "" ? 0 : Number(body.fee);
    if (!Number.isFinite(fee)) throw badRequest("fee is invalid");
    const svc = await db.insert<ClinicService>("clinic_service", {
        psychologistId: tenantId, name, description: nz(body, "description"),
        duration: nz(body, "duration") ?? "50 min", fee,
        icon: nz(body, "icon") ?? "Sparkles",
        category: parseCategory(body) ?? "OTHER",
        active: optBool(body, "active") ?? false, // matches the old DTO's primitive-boolean default
        displayOrder: optInt(body, "displayOrder") ?? 0,
    });
    return toServiceDto(svc);
}

export async function updateService(db: Db, id: number, tenantId: number, body: JsonObject): Promise<ClinicServiceDto> {
    const svc = await db.one<ClinicService>("SELECT * FROM clinic_service WHERE id = $1 AND psychologist_id = $2", [id, tenantId]);
    if (!svc) throw notFound(`Service not found: ${id}`);
    const fee = body.fee === undefined || body.fee === null || body.fee === "" ? 0 : Number(body.fee);
    if (!Number.isFinite(fee)) throw badRequest("fee is invalid");
    const updated = await db.update<ClinicService>("clinic_service", id, {
        name: notBlank(body, "name"),
        description: nz(body, "description"),
        duration: nz(body, "duration") ?? svc.duration,
        fee,
        icon: nz(body, "icon"),
        // The category is new: a client that doesn't send it (an older cached
        // page) keeps whatever the service already had.
        category: parseCategory(body) ?? svc.category,
        active: optBool(body, "active") ?? false,
        displayOrder: optInt(body, "displayOrder") ?? 0,
    });
    return toServiceDto(updated);
}

export async function deleteService(db: Db, id: number, tenantId: number): Promise<void> {
    const svc = await db.one<ClinicService>("SELECT * FROM clinic_service WHERE id = $1 AND psychologist_id = $2", [id, tenantId]);
    if (!svc) throw notFound(`Service not found: ${id}`);
    // Per-doctor pricing rows FK-block the delete once anyone has priced this
    // service — clear them first. Booking history is unaffected: appointments
    // store the service as free text, not a FK.
    await db.exec("DELETE FROM doctor_service_price WHERE clinic_service_id = $1", [id]);
    await db.exec("DELETE FROM clinic_service WHERE id = $1", [id]);
}

export async function toggleService(db: Db, id: number, tenantId: number): Promise<ClinicServiceDto> {
    const svc = await db.one<ClinicService>("SELECT * FROM clinic_service WHERE id = $1 AND psychologist_id = $2", [id, tenantId]);
    if (!svc) throw notFound(`Service not found: ${id}`);
    return toServiceDto(await db.update<ClinicService>("clinic_service", id, { active: !svc.active }));
}

// ── Leads ────────────────────────────────────────────────────────────────────

export async function createLead(db: Db, ownerId: number, body: JsonObject): Promise<Lead> {
    const name = notBlank(body, "name", 150);
    const email = optStr(body, "email", 150);
    if (email && email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        throw badRequest("email must be a well-formed email address");
    }
    const phone = notBlank(body, "phone", 30);
    const notes = optStr(body, "notes", 2000);
    return db.insert<Lead>("lead", {
        name, email: email && email.trim() ? email.trim() : null, phone, notes, practitionerId: ownerId, status: "NEW",
    });
}

export const getAllLeads = (db: Db, practitionerId: number) =>
    db.many<Lead>("SELECT * FROM lead WHERE practitioner_id = $1 ORDER BY created_at DESC, id DESC", [practitionerId]);
