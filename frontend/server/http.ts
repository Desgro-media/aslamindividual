// HTTP plumbing: the error type every service throws, the JSON response
// helpers, and the request-validation helpers. The status codes and `message`
// wording deliberately match what the Spring GlobalExceptionHandler produced,
// because the existing dashboard pages read `error.response.data.message`.

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly extra?: Record<string, unknown>
    ) {
        super(message);
        this.name = "ApiError";
    }
}

// ResourceNotFoundException -> 404, IllegalArgumentException -> 400,
// IllegalStateException -> 409, AccessDeniedException -> 403.
export const notFound = (message: string) => new ApiError(404, message);
export const badRequest = (message: string) => new ApiError(400, message);
export const conflict = (message: string) => new ApiError(409, message);
export const forbidden = (message = "Access denied") => new ApiError(403, message);
export const unauthorized = (message = "Unauthorized") => new ApiError(401, message);

const JSON_HEADERS = { "Content-Type": "application/json" };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export const noContent = () => new Response(null, { status: 204 });
export const emptyOk = () => new Response(null, { status: 200 });

// Duck-typed rather than `instanceof`: during `next dev` hot reloads the module
// that threw and the module that catches can be different instances of this
// file, and instanceof would then wrongly turn a clean 4xx into a 500.
export function isApiError(err: unknown): err is ApiError {
    return !!err && typeof err === "object" && (err as { name?: string }).name === "ApiError"
        && typeof (err as { status?: unknown }).status === "number";
}

export function errorResponse(err: unknown): Response {
    if (isApiError(err)) {
        return json({ message: err.message, ...(err.extra ?? {}) }, err.status);
    }
    // Postgres constraint violations (SQLSTATE class 23)
    const code = (err as { code?: string } | null)?.code;
    if (code === "23503") {
        return json({ message: "This record is still referenced by other data and can't be deleted." }, 409);
    }
    if (code === "23505") {
        return json({ message: "A record with these details already exists." }, 409);
    }
    if (code === "22P02" || code === "22007" || code === "22008") {
        return json({ message: "The request could not be read — please check the values you entered." }, 400);
    }
    // Deliberately generic: an unexpected exception's message can carry SQL,
    // file paths or library internals. The real one goes to the server log.
    console.error("[api] Unhandled error:", err);
    return json({ message: "An unexpected error occurred" }, 500);
}

// ── Request body ─────────────────────────────────────────────────────────────

export type JsonObject = Record<string, any>;

export const UNREADABLE = "The request could not be read — please check the values you entered.";

export async function readJson(req: Request, opts: { optional?: boolean } = {}): Promise<JsonObject> {
    const text = await req.text();
    if (!text.trim()) {
        if (opts.optional) return {};
        throw badRequest(UNREADABLE);
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
        return parsed;
    } catch {
        throw badRequest(UNREADABLE);
    }
}

// ── Validation (Jakarta Bean Validation equivalents) ─────────────────────────
// Jakarta's built-in messages are sentence fragments ("must not be blank");
// like GlobalExceptionHandler.describeFieldError we prefix those with the
// field name, while our own full-sentence messages pass through untouched.

function fail(field: string, message: string): never {
    throw badRequest(/^[a-z]/.test(message) ? `${field} ${message}` : message);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export function notBlank(body: JsonObject, field: string, max?: number): string {
    const v = body[field];
    if (isBlank(v) || typeof v !== "string") fail(field, "must not be blank");
    if (max !== undefined && (v as string).length > max) fail(field, `size must be between 0 and ${max}`);
    return v as string;
}

/** Optional text; null/absent -> null. */
export function optStr(body: JsonObject, field: string, max?: number): string | null {
    const v = body[field];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw badRequest(UNREADABLE);
    if (max !== undefined && v.length > max) fail(field, `size must be between 0 and ${max}`);
    return v;
}

export function optEmail(body: JsonObject, field: string, max?: number): string | null {
    const v = optStr(body, field, max);
    // Bean Validation's @Email treats the empty string as valid.
    if (v !== null && v !== "" && !EMAIL_RE.test(v.trim())) fail(field, "must be a well-formed email address");
    return v;
}

export function requiredEmail(body: JsonObject, field: string, max?: number): string {
    const v = notBlank(body, field, max);
    if (!EMAIL_RE.test(v.trim())) fail(field, "must be a well-formed email address");
    return v;
}

export function oneOf(body: JsonObject, field: string, allowed: string[], message: string): string | null {
    const v = body[field];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || !allowed.includes(v)) throw badRequest(message);
    return v;
}

/** Jackson coerces "123" -> 123 for numeric targets; so do we. null/absent -> null. */
export function optInt(body: JsonObject, field: string): number | null {
    const v = body[field];
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw badRequest(UNREADABLE);
    return n;
}

export function optBool(body: JsonObject, field: string): boolean | null {
    const v = body[field];
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
    throw badRequest(UNREADABLE);
}

export function pathId(value: string, label = "id"): number {
    const n = Number(value);
    if (!Number.isInteger(n)) throw badRequest(`Invalid value for '${label}'.`);
    return n;
}
