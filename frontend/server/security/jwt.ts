import { SignJWT, jwtVerify } from "jose";
import { config, validateJwtSecret } from "../config";

// Tokens are HS256 JWTs signed with the *raw UTF-8 bytes* of JWT_SECRET — the
// same thing the Java backend's `Keys.hmacShaKeyFor(secret.getBytes())` did, so
// a session issued before the migration keeps working after it.

// Millisecond-precision issue time alongside the standard whole-second `iat`.
// Needed because `credentialsChangedAt` has sub-second precision: with seconds
// alone, a token minted in the same second as a password change is
// indistinguishable from one minted just before it.
const IAT_MILLIS = "iatMs";

let cachedKey: { secret: string; key: Uint8Array } | null = null;
function signingKey(): Uint8Array {
    const secret = config.jwtSecret;
    if (!cachedKey || cachedKey.secret !== secret) {
        validateJwtSecret();
        cachedKey = { secret, key: new TextEncoder().encode(secret) };
    }
    return cachedKey.key;
}

export interface TokenClaims {
    username: string;
    role: string | null;
    issuedAtMs: number | null;
    issuedAtSec: number | null;
}

export async function signToken(username: string, role: string): Promise<string> {
    const now = Date.now();
    return new SignJWT({ role, [IAT_MILLIS]: now })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(username)
        .setIssuedAt(Math.floor(now / 1000))
        .setExpirationTime(Math.floor((now + config.jwtExpirationMs) / 1000))
        .sign(signingKey());
}

/** Verifies signature + expiry. Returns null for any invalid/expired/forged token. */
export async function verifyToken(token: string): Promise<TokenClaims | null> {
    try {
        const { payload } = await jwtVerify(token, signingKey(), { algorithms: ["HS256"] });
        if (!payload.sub) return null;
        const ms = payload[IAT_MILLIS];
        return {
            username: payload.sub,
            role: typeof payload.role === "string" ? payload.role : null,
            issuedAtMs: typeof ms === "number" ? ms : null,
            issuedAtSec: typeof payload.iat === "number" ? payload.iat : null,
        };
    } catch {
        return null;
    }
}
