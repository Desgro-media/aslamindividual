import { randomInt } from "node:crypto";
import type { Db } from "../db";
import { tx } from "../db";
import { ApiError, JsonObject, badRequest, conflict, notFound } from "../http";
import { hashPassword } from "../security/auth";
import { isValidDate, ldtFormat, ldtParse, nowLdt, plusDays, plusMonths, plusYears, startOfDay } from "../time";
import { AppUser, PaymentSubmission, Roles, Subscription } from "../types";
import { sendPaymentRejectedEmail, sendSubscriptionActivatedEmail } from "./notifications";
import * as subs from "./subscription";

// Everything a superadmin can do: see every tenant's subscription state,
// review/approve/reject submitted payment proofs, and manually override a
// tenant's subscription (comps/refunds/suspension). Every mutation is
// audit-logged — this role can flip anyone's paid access.

const MAX_SCHEDULE_AHEAD_YEARS = 5;
const MAX_PERIOD_YEARS = 10;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const displayDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const auditDate = (v: string | Date | null) => {
    if (!v) return "open";
    const d = typeof v === "string" ? ldtParse(v) : v;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

export interface TenantSummaryDto {
    id: number; name: string | null; email: string; phone: string | null; slug: string | null; createdAt: string | null;
    subscriptionStatus: string; locked: boolean; trialEndDate: string | null; currentPeriodStart: string | null;
    currentPeriodEnd: string | null; daysRemaining: number | null; accountType: string; staffCount: number;
}

async function toSummary(db: Db, tenant: AppUser): Promise<TenantSummaryDto> {
    // Same status/locked/daysRemaining computation the access gate enforces, so
    // this list can never drift out of sync with what's actually being gated.
    const status = await subs.getStatus(db, tenant.id);
    const isClinic = tenant.accountType === "CLINIC";
    const staffCount = isClinic
        ? (await db.scalar<number>("SELECT count(*) FROM app_user WHERE tenant_id = $1", [tenant.id])) ?? 0 : 0;
    return {
        id: tenant.id, name: tenant.name, email: tenant.username, phone: tenant.phone, slug: tenant.slug,
        createdAt: tenant.createdAt, subscriptionStatus: status.status, locked: status.locked,
        trialEndDate: status.trialEndDate, currentPeriodStart: status.currentPeriodStart,
        currentPeriodEnd: status.currentPeriodEnd, daysRemaining: status.daysRemaining,
        accountType: isClinic ? "CLINIC" : "INDIVIDUAL", staffCount,
    };
}

export async function listTenants(db: Db): Promise<TenantSummaryDto[]> {
    // tenant_id IS NULL excludes clinic staff-doctors, who share the PSYCHOLOGIST
    // role string but aren't billed independently.
    const tenants = await db.many<AppUser>(
        "SELECT * FROM app_user WHERE role = $1 AND tenant_id IS NULL ORDER BY created_at DESC", [Roles.PSYCHOLOGIST]);
    const out: TenantSummaryDto[] = [];
    for (const t of tenants) out.push(await toSummary(db, t));
    return out;
}

type SubmissionRow = PaymentSubmission & { tenantName: string | null; tenantEmail: string | null; tenantType: string | null };

const SUBMISSION_SQL = `
    SELECT s.*, u.name AS tenant_name, u.username AS tenant_email, u.account_type AS tenant_type
      FROM payment_submission s LEFT JOIN app_user u ON u.id = s.psychologist_id`;

function toReviewDto(s: SubmissionRow) {
    return {
        id: s.id, psychologistId: s.psychologistId, psychologistName: s.tenantName ?? "Unknown",
        psychologistEmail: s.tenantEmail ?? "", upiTransactionRef: s.upiTransactionRef, amountClaimed: s.amountClaimed,
        screenshotBase64: s.screenshotBase64, status: s.status, reviewNote: s.reviewNote,
        reviewedAt: s.reviewedAt, createdAt: s.createdAt,
    };
}

function toHistoryDto(s: SubmissionRow) {
    return {
        id: s.id, psychologistId: s.psychologistId, psychologistName: s.tenantName ?? "Unknown",
        psychologistEmail: s.tenantEmail ?? "", accountType: s.tenantType === "CLINIC" ? "CLINIC" : "INDIVIDUAL",
        upiTransactionRef: s.upiTransactionRef, amountClaimed: s.amountClaimed, status: s.status,
        reviewNote: s.reviewNote, reviewedAt: s.reviewedAt, createdAt: s.createdAt,
    };
}

export async function listPendingSubmissions(db: Db) {
    return (await db.many<SubmissionRow>(`${SUBMISSION_SQL} WHERE s.status = 'PENDING' ORDER BY s.created_at ASC`)).map(toReviewDto);
}

export async function listSubmissionsForTenant(db: Db, tenantId: number) {
    return (await db.many<SubmissionRow>(`${SUBMISSION_SQL} WHERE s.psychologist_id = $1 ORDER BY s.created_at DESC`, [tenantId])).map(toReviewDto);
}

/**
 * Powers the overview screen. Tenant mix + subscription-state breakdown come
 * from listTenants()'s live status (never a raw read of the subscription table)
 * so these counts can never disagree with the Tenants table below them.
 */
export async function getDashboardStats(db: Db) {
    const tenants = await listTenants(db);
    let totalClinics = 0, totalIndividuals = 0, active = 0, trialing = 0, scheduled = 0, expired = 0, cancelled = 0;
    for (const t of tenants) {
        if (t.accountType === "CLINIC") totalClinics++; else totalIndividuals++;
        switch (t.subscriptionStatus) {
            case subs.ACTIVE: active++; break;
            case subs.TRIALING: trialing++; break;
            case subs.SCHEDULED: scheduled++; break;
            case subs.EXPIRED: expired++; break;
            case subs.CANCELLED: cancelled++; break;
            // Unrecognised counts as expired so the buckets always sum to the total.
            default: expired++; break;
        }
    }
    const count = async (status: string) =>
        (await db.scalar<number>("SELECT count(*) FROM payment_submission WHERE status = $1", [status])) ?? 0;
    const successful = await count("APPROVED");
    const pending = await count("PENDING");
    const failed = await count("REJECTED");
    const totalRevenue = (await db.scalar<number>(
        "SELECT SUM(amount_claimed) FROM payment_submission WHERE status = 'APPROVED'")) ?? 0;
    const recent = await db.many<SubmissionRow>(`${SUBMISSION_SQL} ORDER BY s.created_at DESC LIMIT 20`);
    return {
        totalClinics, totalIndividuals, totalTenants: tenants.length,
        activeSubscriptions: active, trialingSubscriptions: trialing, scheduledSubscriptions: scheduled,
        expiredSubscriptions: expired, cancelledSubscriptions: cancelled,
        totalPayments: successful + pending + failed, successfulPayments: successful,
        pendingPayments: pending, failedPayments: failed, totalRevenue, recentPayments: recent.map(toHistoryDto),
    };
}

async function audit(db: Db, adminId: number, action: string, targetId: number | null, detail: string) {
    await db.insert("admin_audit_log", { adminUserId: adminId, action, targetPsychologistId: targetId, detail });
}

// Optimistic lock on payment_submission.version: two admins approving and
// rejecting the same proof in the same instant can't both win.
async function reviewSubmission(db: Db, s: PaymentSubmission, patch: Record<string, unknown>): Promise<PaymentSubmission> {
    const toSnake = (k: string) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
    const entries = Object.entries(patch);
    const sets = entries.map(([k], i) => `"${toSnake(k)}" = $${i + 1}`).join(", ");
    const row = await db.one<PaymentSubmission>(
        `UPDATE payment_submission SET ${sets}, version = version + 1 WHERE id = $${entries.length + 1} AND version = $${entries.length + 2} RETURNING *`,
        [...entries.map(([, v]) => v), s.id, s.version]);
    if (!row) throw new ApiError(409, "This record was just updated elsewhere. Please refresh and try again.");
    return row;
}

async function loadReviewDto(db: Db, id: number) {
    return toReviewDto((await db.one<SubmissionRow>(`${SUBMISSION_SQL} WHERE s.id = $1`, [id]))!);
}

export async function approve(submissionId: number, adminId: number) {
    return tx(async (db) => {
        const submission = await db.one<PaymentSubmission>("SELECT * FROM payment_submission WHERE id = $1", [submissionId]);
        if (!submission) throw notFound("Submission not found");
        if (submission.status !== "PENDING") throw conflict("This submission has already been reviewed");
        const tenant = await db.one<AppUser>("SELECT * FROM app_user WHERE id = $1", [submission.psychologistId]);
        if (!tenant) throw notFound("Tenant not found");

        let sub = await db.one<Subscription>("SELECT * FROM subscription WHERE psychologist_id = $1", [tenant.id]);
        if (!sub) {
            sub = await db.insert<Subscription>("subscription", { psychologistId: tenant.id, status: "EXPIRED", plan: "INDIVIDUAL_ANNUAL", amount: 9999 });
        }
        const now = nowLdt();
        // Renewals queue after any time already paid for rather than resetting to
        // today, so approving early never costs the tenant remaining days.
        const currentEnd = sub.currentPeriodEnd ? ldtParse(sub.currentPeriodEnd) : null;
        const extendFrom = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
        const periodEnd = plusYears(extendFrom, 1);
        await db.update("subscription", sub.id, {
            status: subs.ACTIVE, currentPeriodStart: ldtFormat(extendFrom), currentPeriodEnd: ldtFormat(periodEnd),
        });
        await reviewSubmission(db, submission, { status: "APPROVED", reviewedByAdminId: adminId, reviewedAt: ldtFormat(now) });
        await audit(db, adminId, "APPROVE_PAYMENT", tenant.id, `submissionId=${submissionId}`);
        db.after(() => sendSubscriptionActivatedEmail(tenant.name ?? tenant.username, tenant.username, displayDate(periodEnd)));
        return loadReviewDto(db, submissionId);
    });
}

export async function reject(submissionId: number, adminId: number, reason: string) {
    return tx(async (db) => {
        const submission = await db.one<PaymentSubmission>("SELECT * FROM payment_submission WHERE id = $1", [submissionId]);
        if (!submission) throw notFound("Submission not found");
        if (submission.status !== "PENDING") throw conflict("This submission has already been reviewed");
        await reviewSubmission(db, submission, {
            status: "REJECTED", reviewNote: reason, reviewedByAdminId: adminId, reviewedAt: ldtFormat(nowLdt()),
        });
        const tenant = await db.one<AppUser>("SELECT * FROM app_user WHERE id = $1", [submission.psychologistId]);
        await audit(db, adminId, "REJECT_PAYMENT", submission.psychologistId, `submissionId=${submissionId} reason=${reason}`);
        if (tenant) db.after(() => sendPaymentRejectedEmail(tenant.name ?? tenant.username, tenant.username, reason));
        return loadReviewDto(db, submissionId);
    });
}

interface OverrideRequest {
    action: string; preset: string | null; startDate: string | null; endDate: string | null; extendDays: number | null;
}

export function parseOverride(body: JsonObject): OverrideRequest {
    const action = body.action;
    if (typeof action !== "string" || !action.trim()) throw badRequest("action must not be blank");
    if (action !== "ACTIVATE" && action !== "SUSPEND") throw badRequest("action must be ACTIVATE or SUSPEND");
    const preset = body.preset ?? null;
    if (preset !== null && !["ONE_MONTH", "SIX_MONTHS", "ONE_YEAR", "CUSTOM"].includes(preset)) {
        throw badRequest("preset must be ONE_MONTH, SIX_MONTHS, ONE_YEAR or CUSTOM");
    }
    for (const f of ["startDate", "endDate"]) {
        if (body[f] != null && !isValidDate(body[f])) throw badRequest("The request could not be read — please check the values you entered.");
    }
    const extendDays = body.extendDays == null ? null : Number(body.extendDays);
    return { action, preset, startDate: body.startDate ?? null, endDate: body.endDate ?? null, extendDays };
}

// The last instant of the given day, so the whole day counts as inside the
// window. Microsecond precision is the most a timestamp(6) column can hold.
const endOfDayStr = (date: string) => `${date} 23:59:59.999999`;

function describeWindow(start: string | null, end: string | null): string {
    return `${auditDate(start)}..${auditDate(end)}`;
}

/**
 * Turns the admin's date-only intent into a concrete [start, end) window. Start
 * defaults to max(now, currentPeriodEnd) so "give them another year" queues
 * after time already paid for. Boundaries are inclusive-by-day.
 */
function resolveWindow(sub: Subscription, req: OverrideRequest): { start: Date; end: Date; endStr?: string } {
    const now = nowLdt();
    const currentEnd = sub.currentPeriodEnd ? ldtParse(sub.currentPeriodEnd) : null;
    const defaultStart = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
    const start = req.startDate ? startOfDay(req.startDate) : defaultStart;

    let end: Date;
    let endStr: string | undefined;
    if (req.preset === "CUSTOM") {
        if (!req.endDate) throw badRequest("An end date is required for a custom period");
        endStr = endOfDayStr(req.endDate);
        end = ldtParse(endStr);
    } else if (req.preset) {
        // Calendar-aware arithmetic, not a fixed day count.
        end = req.preset === "ONE_MONTH" ? plusMonths(start, 1) : req.preset === "SIX_MONTHS" ? plusMonths(start, 6) : plusYears(start, 1);
    } else {
        // Legacy {action, extendDays} with no preset.
        end = plusDays(start, req.extendDays ?? 365);
    }

    if (end.getTime() <= start.getTime()) throw badRequest("The end date must be after the start date");
    if (start.getTime() > plusYears(now, MAX_SCHEDULE_AHEAD_YEARS).getTime()) {
        throw badRequest(`A period can't start more than ${MAX_SCHEDULE_AHEAD_YEARS} years from now — check the start date`);
    }
    if (end.getTime() > plusYears(start, MAX_PERIOD_YEARS).getTime()) {
        throw badRequest(`A period can't be longer than ${MAX_PERIOD_YEARS} years — check the end date`);
    }
    return { start, end, endStr };
}

export async function overrideSubscription(tenantId: number, adminId: number, req: OverrideRequest) {
    return tx(async (db) => {
        const tenant = await db.one<AppUser>(
            "SELECT * FROM app_user WHERE id = $1 AND role = $2 AND tenant_id IS NULL", [tenantId, Roles.PSYCHOLOGIST]);
        if (!tenant) throw notFound("Tenant not found");
        let sub = await db.one<Subscription>("SELECT * FROM subscription WHERE psychologist_id = $1", [tenantId]);
        if (!sub) {
            sub = await db.insert<Subscription>("subscription", { psychologistId: tenantId, status: "EXPIRED", plan: "INDIVIDUAL_ANNUAL", amount: 9999 });
        }

        let detail: string;
        if (req.action === "SUSPEND") {
            // Dates are deliberately left untouched — suspension is a hold, not a deletion.
            await db.update("subscription", sub.id, { status: subs.CANCELLED });
            detail = `suspended; window preserved ${describeWindow(sub.currentPeriodStart, sub.currentPeriodEnd)}`;
        } else {
            const before = sub.currentPeriodEnd;
            const w = resolveWindow(sub, req);
            const startStr = ldtFormat(w.start);
            const endStr = w.endStr ?? ldtFormat(w.end);
            // Clears any prior CANCELLED hold; resolve() decides ACTIVE vs
            // SCHEDULED from the dates on the next read.
            await db.update("subscription", sub.id, { currentPeriodStart: startStr, currentPeriodEnd: endStr, status: subs.ACTIVE });
            detail = `preset=${req.preset ?? "LEGACY"} window=${describeWindow(startStr, endStr)} previousEnd=${before ? auditDate(before) : "none"}`;
        }
        await audit(db, adminId, `MANUAL_OVERRIDE_${req.action}`, tenantId, detail);
        return toSummary(db, tenant);
    });
}

// Read-aloud-safe: no characters that sound or look alike (0/O, 1/l/I), grouped
// into blocks so an admin can dictate it over a phone call.
function generatePassword(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < 12; i++) {
        if (i > 0 && i % 4 === 0) out += "-";
        out += alphabet.charAt(randomInt(alphabet.length));
    }
    return out;
}

/**
 * Last resort for a tenant who can't sign in. SETS a password (a bcrypt hash can
 * never be reversed into the old one), signs out every open session, and records
 * who did it — but never the password itself.
 */
export async function resetTenantPassword(tenantId: number, adminId: number, requestedPassword: string | null) {
    return tx(async (db) => {
        const tenant = await db.one<AppUser>(
            "SELECT * FROM app_user WHERE id = $1 AND role = $2 AND tenant_id IS NULL", [tenantId, Roles.PSYCHOLOGIST]);
        if (!tenant) throw notFound("Tenant not found");
        let password: string;
        if (requestedPassword && requestedPassword.trim()) {
            if (requestedPassword.length < 8) throw badRequest("Password must be at least 8 characters");
            password = requestedPassword;
        } else {
            password = generatePassword();
        }
        const changedAt = ldtFormat(nowLdt());
        await db.update("app_user", tenant.id, { password: await hashPassword(password), credentialsChangedAt: changedAt });
        await audit(db, adminId, "RESET_TENANT_PASSWORD", tenantId, `issued a new password for ${tenant.username}; existing sessions revoked`);
        return {
            tenantId: tenant.id, name: tenant.name, email: tenant.username, temporaryPassword: password,
            changedAt: changedAt.replace(" ", "T"),
        };
    });
}

