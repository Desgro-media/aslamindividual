import { compare, hash } from "bcryptjs";
import type { Db } from "../db";
import { ApiError } from "../http";
import { clinicLdtOf, ldtParse } from "../time";
import { AppUser } from "../types";
import { verifyToken } from "./jwt";

// ── Passwords ────────────────────────────────────────────────────────────────
// bcrypt, cost 10 — same as Spring's BCryptPasswordEncoder default, so every
// existing hash ($2a$10$...) verifies unchanged.
export const hashPassword = (plain: string) => hash(plain, 10);
export const checkPassword = (plain: string, hashed: string) => compare(plain, hashed);

// Compared against when the email is unknown, so "no such account" costs the
// same time as "wrong password" (Spring's DaoAuthenticationProvider does this
// too) and login timing can't be used to enumerate accounts.
const DUMMY_HASH = "$2a$10$7EqJtq98hPqEX7fNZaFWoOa5h5E5VxPq1z0m6Yb1rJjQXlK0rUQ8e";

export const INVALID_LOGIN = "Invalid email or password";

/** Resolves email+password to a user, or throws the one fixed 401 message. */
export async function authenticateCredentials(db: Db, email: string, password: string): Promise<AppUser> {
    const user = await db.one<AppUser>("SELECT * FROM app_user WHERE username = $1", [email]);
    if (!user) {
        await checkPassword(password, DUMMY_HASH);
        throw new ApiError(401, INVALID_LOGIN);
    }
    // A deactivated account is rejected before the password is even checked,
    // with the same message as a wrong password (no "this account is disabled"
    // oracle for probing which staff logins were deactivated).
    if (!user.enabled) throw new ApiError(401, INVALID_LOGIN);
    if (!(await checkPassword(password, user.password))) throw new ApiError(401, INVALID_LOGIN);
    return user;
}

// ── Bearer token -> current user ─────────────────────────────────────────────

export function bearerToken(req: Request): string | null {
    const header = req.headers.get("authorization");
    if (header && header.startsWith("Bearer ")) {
        const t = header.slice(7).trim();
        return t || null;
    }
    return null;
}

/**
 * The account behind a request's bearer token, or null when there is no valid
 * session. The row is re-read from the database on every request (never
 * cached), so a deactivated staff member or a password reset takes effect on
 * the very next call instead of lingering until the token expires.
 */
export async function currentUserFromRequest(req: Request, db: Db): Promise<AppUser | null> {
    const token = bearerToken(req);
    if (!token) return null;
    const claims = await verifyToken(token);
    if (!claims) return null;

    const user = await db.one<AppUser>("SELECT * FROM app_user WHERE username = $1", [claims.username]);
    if (!user || !user.enabled) return null;
    if (issuedBeforeCredentialChange(claims, user)) return null;
    return user;
}

// A password reset (or an admin editing a staff login) must end the sessions
// that were already open. Compared at millisecond precision using the token's
// own iatMs claim; both sides are the clinic's wall-clock.
function issuedBeforeCredentialChange(
    claims: { issuedAtMs: number | null; issuedAtSec: number | null },
    user: AppUser
): boolean {
    if (!user.credentialsChangedAt) return false; // never changed — nothing to cut off
    const changedAt = ldtParse(user.credentialsChangedAt).getTime();

    if (claims.issuedAtMs !== null) {
        return clinicLdtOf(claims.issuedAtMs).getTime() < changedAt;
    }
    // Token predates the iatMs claim: fall back to whole seconds and resolve the
    // ambiguous same-second case in favour of keeping the session.
    if (claims.issuedAtSec === null) return true;
    const issued = Math.floor(clinicLdtOf(claims.issuedAtSec * 1000).getTime() / 1000);
    return issued < Math.floor(changedAt / 1000);
}

/** id every clinic-wide resource is scoped by: the clinic's own id for staff, else the caller's. */
export const tenantIdOf = (u: AppUser) => (u.tenantId !== null ? u.tenantId : u.id);
export const isTenantRoot = (u: AppUser) => u.tenantId === null;
