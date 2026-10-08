import { config } from "../config";
import type { Db } from "../db";
import { AppUser, Roles } from "../types";
import { isAccessAllowed } from "../services/subscription";
import { tenantIdOf } from "./auth";

// ── Client IP ────────────────────────────────────────────────────────────────
// Vercel overwrites X-Forwarded-For with the real connecting address (a client
// can't pre-seed it), so the first hop is trustworthy there.
export function clientIp(req: Request): string {
    const vercel = req.headers.get("x-vercel-forwarded-for");
    if (vercel) return vercel.split(",")[0].trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
    return "unknown";
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// Fixed-window counter per (IP, bucket) for the unauthenticated surface. It is
// in-memory, so on Vercel each warm function instance counts separately — it
// blunts a single-source flood but is not a global limit. For a hard limit add
// a Vercel Firewall rate-limit rule on /api/v1/auth/* and /api/v1/public/*.

// failuresOnly: the bucket is checked on every request but only grows when the caller
// reports a failure — so a shared office IP full of correct logins is never throttled.
interface Bucket { key: string; limit: number; windowMs: number; failuresOnly?: boolean }

const BOOKING_SUBMIT: Bucket = { key: "booking", limit: 8, windowMs: 10 * 60_000 };
const PATIENT_CHECK: Bucket = { key: "patient-check", limit: 20, windowMs: 60_000 };
const PUBLIC_READ: Bucket = { key: "public-read", limit: 120, windowMs: 60_000 };
const LOGIN_ATTEMPT: Bucket = { key: "login", limit: 10, windowMs: 15 * 60_000, failuresOnly: true };
const SIGNUP_ATTEMPT: Bucket = { key: "signup", limit: 15, windowMs: 15 * 60_000 };

const counters = new Map<string, { windowStart: number; count: number }>();

function bucketFor(method: string, path: string): Bucket | null {
    if (method === "POST" && path.endsWith("/api/v1/appointments")) return BOOKING_SUBMIT;
    if (method === "POST" && path.endsWith("/api/v1/auth/login")) return LOGIN_ATTEMPT;
    if (method === "POST" && path.endsWith("/api/v1/auth/signup")) return SIGNUP_ATTEMPT;
    if (!path.includes("/api/v1/public/")) return null;
    if (path.endsWith("/patients/check")) return PATIENT_CHECK;
    return PUBLIC_READ;
}

/** True when the request is allowed to proceed. */
function counterFor(bucket: Bucket, req: Request) {
    const key = `${bucket.key}:${clientIp(req)}`;
    const now = Date.now();
    let c = counters.get(key);
    if (!c || now - c.windowStart > bucket.windowMs) {
        c = { windowStart: now, count: 0 };
        counters.set(key, c);
    }
    // Safety valve against unbounded growth from many distinct IPs.
    if (counters.size > 50_000) counters.clear();
    return c;
}

export function rateLimitAllows(req: Request, path: string): boolean {
    const bucket = bucketFor(req.method, path);
    if (!bucket) return true;
    const c = counterFor(bucket, req);
    if (bucket.failuresOnly) return c.count < bucket.limit;
    c.count += 1;
    return c.count <= bucket.limit;
}

/** Counts one failed sign-in against the caller's IP (see LOGIN_ATTEMPT). */
export function recordLoginFailure(req: Request): void {
    counterFor(LOGIN_ATTEMPT, req).count += 1;
}

// ── Superadmin IP allowlist ──────────────────────────────────────────────────
// Optional extra layer on top of the role check; OFF by default (an empty
// allowlist means no restriction) so it can never lock the operator out.
export function superAdminIpAllowed(req: Request, path: string): boolean {
    const raw = config.superadminIpAllowlist;
    if (!path.includes("/api/v1/superadmin/") || !raw.trim()) return true;
    const ip = clientIp(req);
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .some((prefix) => ip.startsWith(prefix));
}

// ── Subscription gate ────────────────────────────────────────────────────────
// Blocks the tenant dashboard API once a trial/subscription has lapsed. The
// public booking surface is exempt here (no JWT to identify a practitioner) and
// is gated inside the booking service instead.
const EXEMPT_PREFIXES = [
    "/api/v1/auth/",
    "/api/v1/public/",
    "/api/v1/track/",
    "/api/v1/subscription/",
    "/api/v1/superadmin/",
    "/api/v1/telegram/",
    "/api/v1/health",
];

function subscriptionExempt(method: string, path: string): boolean {
    if (method === "POST" && path.endsWith("/api/v1/appointments")) return true;
    if (method === "POST" && path.endsWith("/api/v1/demo-booking")) return true;
    if (path.endsWith("/api/v1/chat")) return true;
    return EXEMPT_PREFIXES.some((p) => path.includes(p));
}

export async function subscriptionAllows(db: Db, req: Request, path: string, user: AppUser | null): Promise<boolean> {
    if (!user) return true; // nothing to gate — the route's own auth decides (401)
    if (subscriptionExempt(req.method, path)) return true;
    if (user.role === Roles.SUPERADMIN) return true;
    // A clinic staff row has no Subscription of its own — gate on the owning
    // clinic's billing state.
    return isAccessAllowed(db, tenantIdOf(user));
}

// ── Staff dashboard-tab permissions ──────────────────────────────────────────
// Gates a clinic's data (Patients/Appointments/Billing/Analytics/Settings) by
// each staff member's granted permissions. Only clinic STAFF (tenantId set)
// are ever restricted; tenant roots and the superadmin always have full access.
// Staff-doctors (role PSYCHOLOGIST) are auto-granted APPOINTMENTS + PATIENTS.
const PATIENTS = "PATIENTS";
const APPOINTMENTS = "APPOINTMENTS";
const BILLING = "BILLING";
const ANALYTICS = "ANALYTICS";
const SETTINGS = "SETTINGS";

const DOCTOR_AUTO_GRANTED = new Set([APPOINTMENTS, PATIENTS]);

// Order matters only where prefixes overlap; none currently do.
const PREFIX_PERMISSIONS: Array<[string, string]> = [
    ["/api/v1/patients", PATIENTS],
    ["/api/v1/leads", PATIENTS],
    ["/api/v1/notes", PATIENTS],
    ["/api/v1/mood", PATIENTS],
    ["/api/v1/appointments", APPOINTMENTS],
    ["/api/v1/follow-ups", APPOINTMENTS],
    ["/api/v1/invoices", BILLING],
    ["/api/v1/bank-accounts", BILLING],
    ["/api/v1/reports", ANALYTICS],
    ["/api/v1/settings", SETTINGS],
    ["/api/v1/holidays", SETTINGS],
    ["/api/v1/services", SETTINGS],
];

export function requiredPermission(path: string): string | null {
    // /me/** (a doctor's own data — self-scoped by construction) and /staff/**
    // (tenant-root-only, enforced by the staff service itself) are never gated here.
    if (path.includes("/api/v1/me/") || path.includes("/api/v1/staff")) return null;
    for (const [prefix, perm] of PREFIX_PERMISSIONS) {
        if (path.includes(prefix)) return perm;
    }
    return null;
}

export function parsePermissions(csv: string | null): string[] {
    if (!csv || !csv.trim()) return [];
    return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

export function permissionAllows(path: string, user: AppUser | null): boolean {
    if (!user || user.tenantId === null) return true; // tenant roots/superadmin unrestricted
    const needed = requiredPermission(path);
    if (!needed) return true;
    if (user.role === Roles.PSYCHOLOGIST && DOCTOR_AUTO_GRANTED.has(needed)) return true;
    return parsePermissions(user.permissions).includes(needed);
}
