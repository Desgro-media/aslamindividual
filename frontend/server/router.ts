import { Db, getDb } from "./db";
import { ApiError, JsonObject, errorResponse, json, readJson, unauthorized } from "./http";
import { currentUserFromRequest } from "./security/auth";
import {
    clientIp, permissionAllows, rateLimitAllows, subscriptionAllows, superAdminIpAllowed,
} from "./security/guards";
import { AppUser, Roles } from "./types";
import { ensureReady } from "./bootstrap";

// A deliberately tiny router: the old Spring controllers map onto it 1:1
// (`@PatchMapping("/appointments/{id}/notes")` -> route("PATCH", "/appointments/:id/notes", ...)).
// One catch-all Next.js route handler feeds every /api/v1/** request through
// dispatch(), which runs the same filter chain Spring Security did:
//   rate limit -> superadmin IP allowlist -> JWT -> subscription gate
//   -> staff permission gate -> route-level authorization -> handler.

export type AuthMode = "public" | "user" | "superadmin";

export interface Ctx {
    req: Request;
    url: URL;
    path: string;
    params: Record<string, string>;
    query: URLSearchParams;
    db: Db;
    /** The authenticated account, or null on a public request without a valid token. */
    user: AppUser | null;
    ip: string;
    /** The authenticated account — only callable on routes registered with auth "user"/"superadmin". */
    me(): AppUser;
    body(): Promise<JsonObject>;
    optionalBody(): Promise<JsonObject>;
}

type Handler = (c: Ctx) => Promise<unknown> | unknown;

interface Route {
    method: string;
    regex: RegExp;
    keys: string[];
    auth: AuthMode;
    handler: Handler;
}

// Held on globalThis (not module scope) and keyed by "METHOD pattern": a route
// registered twice REPLACES the earlier one in place. Both matter under Next's
// dev-mode hot reload, which re-evaluates the route modules — without this the
// first (stale) handler would win forever, or every route would be doubled.
// In production the modules load once and this is just a plain table.
type G = typeof globalThis & { __psyfosRouteTable?: Map<string, Route> };
const routes: Map<string, Route> = ((globalThis as G).__psyfosRouteTable ??= new Map());

export function route(method: string, pattern: string, auth: AuthMode, handler: Handler): void {
    const keys: string[] = [];
    const source = pattern
        .split("/")
        .map((seg) => {
            if (seg.startsWith(":")) {
                keys.push(seg.slice(1));
                return "([^/]+)";
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/");
    routes.set(`${method} ${pattern}`, { method, regex: new RegExp(`^${source}$`), keys, auth, handler });
}

export const get = (p: string, a: AuthMode, h: Handler) => route("GET", p, a, h);
export const post = (p: string, a: AuthMode, h: Handler) => route("POST", p, a, h);
export const put = (p: string, a: AuthMode, h: Handler) => route("PUT", p, a, h);
export const patch = (p: string, a: AuthMode, h: Handler) => route("PATCH", p, a, h);
export const del = (p: string, a: AuthMode, h: Handler) => route("DELETE", p, a, h);

const API_PREFIX = "/api/v1";

// Headers every API response carries: this is a pure JSON API, so there is
// never a reason to cache it, sniff it, or leak a referrer from it.
const API_HEADERS: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
};

function withHeaders(res: Response): Response {
    for (const [k, v] of Object.entries(API_HEADERS)) {
        if (!res.headers.has(k)) res.headers.set(k, v);
    }
    return res;
}

export async function dispatch(req: Request): Promise<Response> {
    try {
        return withHeaders(await handle(req));
    } catch (err) {
        return withHeaders(errorResponse(err));
    }
}

async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    if (!path.startsWith(API_PREFIX)) throw new ApiError(404, "Not found");
    const sub = path.slice(API_PREFIX.length) || "/";

    // 1. Rate limit + superadmin network allowlist (cheap, before any DB work)
    if (!rateLimitAllows(req, path)) {
        return json({ message: "Too many requests — please try again shortly." }, 429);
    }
    if (!superAdminIpAllowed(req, path)) {
        return json({ message: "Access denied from this network." }, 403);
    }

    // 2. Find the route
    let matched: Route | null = null;
    let params: Record<string, string> = {};
    let pathMatched = false;
    for (const r of routes.values()) {
        const m = r.regex.exec(sub);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        matched = r;
        params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        break;
    }
    if (!matched) {
        if (pathMatched) throw new ApiError(405, "Method not allowed");
        throw new ApiError(404, "Not found");
    }

    // 3. Make sure the schema exists / is current (memoised per instance)
    await ensureReady();
    const db = getDb();

    // 4. Authenticate (a public route still honours a valid token, like the
    //    old JWT filter did — the subscription/permission gates below need it)
    const user = await currentUserFromRequest(req, db);

    // 5. Subscription gate (402) and staff-permission gate (403)
    if (!(await subscriptionAllows(db, req, path, user))) {
        return json({ message: "Your subscription has expired. Please renew to continue.", reason: "SUBSCRIPTION_EXPIRED" }, 402);
    }
    if (!permissionAllows(path, user)) {
        return json({ message: "You don't have permission to access this.", reason: "MISSING_PERMISSION" }, 403);
    }

    // 6. Route-level authorization
    if (matched.auth !== "public" && !user) throw unauthorized();
    if (matched.auth === "superadmin" && user!.role !== Roles.SUPERADMIN) {
        throw new ApiError(403, "Access denied");
    }

    let bodyCache: JsonObject | undefined;
    const ctx: Ctx = {
        req,
        url,
        path,
        params,
        query: url.searchParams,
        db,
        user,
        ip: clientIp(req),
        me: () => {
            if (!user) throw unauthorized();
            return user;
        },
        body: async () => (bodyCache ??= await readJson(req)),
        optionalBody: async () => (bodyCache ??= await readJson(req, { optional: true })),
    };

    const result = await matched.handler(ctx);
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    return json(result);
}
