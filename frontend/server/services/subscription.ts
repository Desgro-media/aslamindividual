import { Db, tx } from "../db";
import { config } from "../config";
import { badRequest, conflict } from "../http";
import { ldtFormat, ldtParse, nowLdt } from "../time";
import { PaymentSubmission, Subscription } from "../types";

// Single source of truth for "is this practitioner's dashboard access
// currently allowed" — the access guard and the superadmin tenant list both
// delegate here instead of keeping their own copy of the trial/expiry state
// machine.

export const TRIALING = "TRIALING";
export const SCHEDULED = "SCHEDULED";
export const ACTIVE = "ACTIVE";
export const EXPIRED = "EXPIRED";
export const CANCELLED = "CANCELLED";

export interface Resolution { status: string; allowed: boolean }

const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024; // 3MB decoded
const MAX_SUBMISSIONS_PER_DAY = 5;

// The single authority on "what is this subscription right now". Pure: `now`
// is passed in, so one request can't observe two clocks mid-evaluation.
//
// Access is the UNION of the trial window and the paid window. That is what
// makes it safe for an admin to queue a future paid period for someone still
// mid-trial: the queued period doesn't cut the trial short, it takes over
// when the trial lapses.
//
// Precedence — paid, then trial, then not-yet-started, then lapsed:
//   CANCELLED  explicit admin suspension; sticky, never auto-recovers
//   ACTIVE     now is inside the paid window (or it's grandfathered)
//   TRIALING   now is inside the trial window
//   SCHEDULED  a paid window exists but hasn't begun yet
//   EXPIRED    everything else
export function resolve(sub: Subscription, now: Date): Resolution {
    if (sub.status === CANCELLED) return { status: CANCELLED, allowed: false };

    const periodStart = sub.currentPeriodStart ? ldtParse(sub.currentPeriodStart) : null;
    const periodEnd = sub.currentPeriodEnd ? ldtParse(sub.currentPeriodEnd) : null;
    const hasPaidPeriod = periodStart !== null || periodEnd !== null;

    // Grandfathered pre-launch accounts: ACTIVE, no bounds, never expire.
    if (!hasPaidPeriod && sub.status === ACTIVE) return { status: ACTIVE, allowed: true };

    const paidStarted = periodStart === null || now.getTime() >= periodStart.getTime();
    const paidNotEnded = periodEnd === null || now.getTime() < periodEnd.getTime();
    if (hasPaidPeriod && paidStarted && paidNotEnded) return { status: ACTIVE, allowed: true };

    if (inTrialWindow(sub, now)) return { status: TRIALING, allowed: true };

    // Denied now, but preserved — it resolves to ACTIVE on its own once `now`
    // reaches the start. Must never be rewritten to EXPIRED.
    if (hasPaidPeriod && !paidStarted) return { status: SCHEDULED, allowed: false };

    return { status: EXPIRED, allowed: false };
}

function inTrialWindow(sub: Subscription, now: Date): boolean {
    if (!sub.trialEndDate || now.getTime() >= ldtParse(sub.trialEndDate).getTime()) return false;
    return !sub.trialStartDate || now.getTime() >= ldtParse(sub.trialStartDate).getTime();
}

async function loadOrFailClosed(db: Db, tenantId: number): Promise<Subscription> {
    const existing = await db.one<Subscription>("SELECT * FROM subscription WHERE psychologist_id = $1", [tenantId]);
    if (existing) return existing;
    // No row ever created for this tenant — never fail open.
    return db.insert<Subscription>("subscription", {
        psychologistId: tenantId,
        status: EXPIRED,
        plan: "INDIVIDUAL_ANNUAL",
        amount: 9999,
    });
}

// Resolves a stored row into what it means right now, then lazily persists the
// corrected status ("check on read, correct if stale").
async function evaluateAndSync(db: Db, sub: Subscription): Promise<Resolution> {
    const res = resolve(sub, nowLdt());
    if (res.status !== sub.status) {
        await db.update("subscription", sub.id, { status: res.status });
    }
    return res;
}

export async function isAccessAllowed(db: Db, tenantId: number): Promise<boolean> {
    return (await evaluateAndSync(db, await loadOrFailClosed(db, tenantId))).allowed;
}

export interface SubscriptionStatusDto {
    status: string;
    locked: boolean;
    plan: string | null;
    amount: number | null;
    trialStartDate: string | null;
    trialEndDate: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    daysRemaining: number | null;
    platformUpiId: string;
    platformUpiQrBase64: string;
}

// Counts toward whichever deadline is actually governing access.
function daysRemaining(sub: Subscription, status: string): number | null {
    let deadline: string | null = null;
    if (status === TRIALING) deadline = sub.trialEndDate;
    else if (status === SCHEDULED) deadline = sub.currentPeriodStart;
    else if (status === ACTIVE) deadline = sub.currentPeriodEnd;
    if (!deadline) return null;
    const days = Math.trunc((ldtParse(deadline).getTime() - nowLdt().getTime()) / 86_400_000);
    return Math.max(0, days);
}

const ts = (v: string | null) => (v ? v.replace(" ", "T") : null);

export async function getStatus(db: Db, tenantId: number): Promise<SubscriptionStatusDto> {
    const sub = await loadOrFailClosed(db, tenantId);
    const res = await evaluateAndSync(db, sub);
    return {
        status: res.status,
        locked: !res.allowed,
        plan: sub.plan,
        amount: sub.amount,
        trialStartDate: ts(sub.trialStartDate),
        trialEndDate: ts(sub.trialEndDate),
        currentPeriodStart: ts(sub.currentPeriodStart),
        currentPeriodEnd: ts(sub.currentPeriodEnd),
        daysRemaining: daysRemaining(sub, res.status),
        platformUpiId: config.platformUpiId,
        platformUpiQrBase64: config.platformUpiQrBase64,
    };
}

// ── Payment proof submissions (tenant side) ──────────────────────────────────

export interface PaymentSubmissionDto {
    id: number;
    upiTransactionRef: string;
    amountClaimed: number | null;
    hasScreenshot: boolean;
    status: string;
    reviewNote: string | null;
    reviewedAt: string | null;
    createdAt: string | null;
}

function toSubmissionDto(s: PaymentSubmission): PaymentSubmissionDto {
    return {
        id: s.id,
        upiTransactionRef: s.upiTransactionRef,
        amountClaimed: s.amountClaimed,
        hasScreenshot: !!s.screenshotBase64 && s.screenshotBase64.trim() !== "",
        status: s.status,
        reviewNote: s.reviewNote,
        reviewedAt: ts(s.reviewedAt),
        createdAt: ts(s.createdAt),
    };
}

export async function submitPayment(
    tenantId: number,
    req: { upiTransactionRef: string; screenshotBase64: string | null; amountClaimed: number | null }
): Promise<PaymentSubmissionDto> {
    return tx(async (db) => {
        const since = ldtFormat(new Date(nowLdt().getTime() - 86_400_000));
        const recent = await db.scalar<number>(
            "SELECT count(*) FROM payment_submission WHERE psychologist_id = $1 AND created_at > $2",
            [tenantId, since]
        );
        if ((recent ?? 0) >= MAX_SUBMISSIONS_PER_DAY) {
            throw conflict("Too many payment submissions today — please wait before submitting again.");
        }
        if (req.screenshotBase64 && req.screenshotBase64.trim() !== "") validateScreenshot(req.screenshotBase64);

        const row = await db.insert<PaymentSubmission>("payment_submission", {
            psychologistId: tenantId,
            upiTransactionRef: req.upiTransactionRef.trim(),
            screenshotBase64: req.screenshotBase64,
            amountClaimed: req.amountClaimed,
            status: "PENDING",
        });
        return toSubmissionDto(row);
    });
}

export async function getSubmissions(db: Db, tenantId: number): Promise<PaymentSubmissionDto[]> {
    const rows = await db.many<PaymentSubmission>(
        "SELECT * FROM payment_submission WHERE psychologist_id = $1 ORDER BY created_at DESC",
        [tenantId]
    );
    return rows.map(toSubmissionDto);
}

// Real image-content validation, not just trusting the client's claim —
// decoded-size cap plus magic-byte sniffing for PNG/JPEG/WebP. Accepts either
// a bare base64 string or a full "data:image/...;base64," data URL.
function validateScreenshot(value: string): void {
    let payload = value;
    let declaredMime: string | null = null;
    const commaIdx = value.indexOf(",");
    if (value.startsWith("data:") && commaIdx > 0) {
        const header = value.substring(5, commaIdx);
        const semi = header.indexOf(";");
        declaredMime = (semi >= 0 ? header.substring(0, semi) : header).trim().toLowerCase();
        payload = value.substring(commaIdx + 1);
    }

    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.replace(/\s+/g, ""))) {
        throw badRequest("Screenshot is not valid base64 image data");
    }
    const decoded = Buffer.from(payload, "base64");
    if (decoded.length > MAX_SCREENSHOT_BYTES) throw badRequest("Screenshot is too large (max 3MB)");

    const sniffed = sniffImageMime(decoded);
    if (!sniffed) throw badRequest("Screenshot must be a PNG, JPEG, or WebP image");
    // The declared data-URL MIME type must match what the bytes actually are.
    if (declaredMime !== null && declaredMime !== sniffed) {
        throw badRequest("Screenshot's declared type doesn't match its actual content");
    }
}

function sniffImageMime(b: Buffer): string | null {
    if (b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
    return null;
}

