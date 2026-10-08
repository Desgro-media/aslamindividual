import { Pool, PoolClient, QueryResult, types } from "pg";
import { config } from "./config";
import { nowTs } from "./time";

// ── Type parsing ─────────────────────────────────────────────────────────────
// Postgres `date`, `time` and `timestamp` (without time zone) carry the clinic's
// wall-clock values (see config.timezone). They are handed back as the raw
// strings Postgres prints — never through JS Date — so there is no implicit
// UTC/local conversion anywhere between the table and the JSON response.
types.setTypeParser(1082, (v) => v); // date
types.setTypeParser(1083, (v) => v); // time
types.setTypeParser(1114, (v) => v); // timestamp
types.setTypeParser(20, (v) => Number(v)); // int8 / bigint / count(*) — ids stay far below 2^53
types.setTypeParser(1700, (v) => Number(v)); // numeric — money has 2 decimals

const TIMESTAMP_OID = 1114;

// ── Pool ─────────────────────────────────────────────────────────────────────
type GlobalWithPool = typeof globalThis & { __psyfosPool?: Pool };
const g = globalThis as GlobalWithPool;

function pool(): Pool {
    if (!g.__psyfosPool) {
        if (!config.databaseUrl) {
            throw new Error(
                "DATABASE_URL is not set. Point it at a Postgres database (Neon, Supabase, Vercel Postgres, or local)."
            );
        }
        const p = new Pool({
            connectionString: config.databaseUrl,
            max: config.dbPoolMax,
            idleTimeoutMillis: 10_000,
            connectionTimeoutMillis: 15_000,
        });
        // An idle client erroring (e.g. the pooler recycling it) must not crash
        // the function — the pool simply drops it and opens a new one.
        p.on("error", (err) => console.error("[db] idle client error:", err.message));
        g.__psyfosPool = p;
    }
    return g.__psyfosPool;
}

// ── Row mapping ──────────────────────────────────────────────────────────────
const toCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

// "2026-09-25 10:56:45.497" -> "2026-09-25T10:56:45.497" (what Jackson's
// LocalDateTime serialisation produced, so existing clients parse it unchanged).
const isoTs = (v: string) => v.replace(" ", "T");

export interface QueryOut<T> {
    rows: T[];
    rowCount: number;
}

// Tables whose rows carry the standard audit timestamps (Hibernate's
// @CreationTimestamp / @UpdateTimestamp). Anything not listed here has neither.
const CREATED_AND_UPDATED = new Set([
    "app_user", "patient", "appointment", "clinic_service", "lead", "session_note",
    "subscription", "invoice", "follow_up",
]);
const CREATED_ONLY = new Set([
    "admin_audit_log", "invoice_payment", "mood_log", "payment_submission", "case_status_log",
]);

export class Db {
    private readonly hooks: Array<() => void> = [];

    constructor(private readonly client: Pool | PoolClient, private readonly transactional = false) {}

    /**
     * Run `fn` once the surrounding transaction has COMMITTED (immediately when
     * there is no transaction). Used for side effects — notification emails,
     * Telegram messages — that must never fire for work that ends up rolled back.
     */
    after(fn: () => void): void {
        if (this.transactional) this.hooks.push(fn);
        else fn();
    }

    flushAfterCommit(): void {
        for (const h of this.hooks.splice(0)) {
            try {
                h();
            } catch (err) {
                console.error("[db] after-commit hook failed:", (err as Error).message);
            }
        }
    }

    async query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<QueryOut<T>> {
        const raw = await this.client.query(sql, params as any[]);
        // A multi-statement script (migrations) comes back as one result per statement.
        const res = (Array.isArray(raw) ? raw[raw.length - 1] : raw) as QueryResult | undefined;
        if (!res) return { rows: [], rowCount: 0 };
        const tsCols = res.fields.filter((f) => f.dataTypeID === TIMESTAMP_OID).map((f) => f.name);
        const rows = res.rows.map((raw) => {
            const out: Record<string, any> = {};
            for (const key of Object.keys(raw)) {
                let v = raw[key];
                if (v !== null && tsCols.includes(key)) v = isoTs(v as string);
                out[toCamel(key)] = v;
            }
            return out as T;
        });
        return { rows, rowCount: res.rowCount ?? rows.length };
    }

    async many<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
        return (await this.query<T>(sql, params)).rows;
    }

    async one<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | null> {
        const rows = (await this.query<T>(sql, params)).rows;
        return rows[0] ?? null;
    }

    async scalar<T = number>(sql: string, params: unknown[] = []): Promise<T | null> {
        const row = (await this.query<Record<string, T>>(sql, params)).rows[0];
        if (!row) return null;
        const first = Object.values(row)[0];
        return (first as T) ?? null;
    }

    async exec(sql: string, params: unknown[] = []): Promise<number> {
        return (await this.query(sql, params)).rowCount;
    }

    // INSERT built from a plain object (camelCase keys -> snake_case columns).
    // `undefined` values are skipped so column defaults apply; `null` is written
    // as NULL. Audit timestamps are filled in from the clinic clock — the same
    // wall-clock the old backend stored.
    async insert<T = Record<string, any>>(table: string, data: Record<string, unknown>): Promise<T> {
        const row: Record<string, unknown> = { ...data };
        if (CREATED_AND_UPDATED.has(table) || CREATED_ONLY.has(table)) {
            if (row.createdAt === undefined) row.createdAt = nowTs();
        }
        if (CREATED_AND_UPDATED.has(table) && row.updatedAt === undefined) row.updatedAt = nowTs();

        const keys = Object.keys(row).filter((k) => row[k] !== undefined);
        const cols = keys.map((k) => `"${toSnake(k)}"`).join(", ");
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const values = keys.map((k) => row[k]);
        const sql = keys.length
            ? `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`
            : `INSERT INTO ${table} DEFAULT VALUES RETURNING *`;
        const out = await this.one<T>(sql, values);
        return out as T;
    }

    // UPDATE ... WHERE id = $n, same conventions as insert().
    async update<T = Record<string, any>>(table: string, id: number, data: Record<string, unknown>): Promise<T> {
        const row: Record<string, unknown> = { ...data };
        if (CREATED_AND_UPDATED.has(table)) row.updatedAt = nowTs();
        const keys = Object.keys(row).filter((k) => row[k] !== undefined);
        const sets = keys.map((k, i) => `"${toSnake(k)}" = $${i + 1}`).join(", ");
        const values = keys.map((k) => row[k]);
        const out = await this.one<T>(`UPDATE ${table} SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, [
            ...values,
            id,
        ]);
        return out as T;
    }
}

/** Shared, non-transactional access (each statement on its own connection). */
export function getDb(): Db {
    return new Db(pool());
}

/**
 * Run `fn` inside one transaction on one connection. Anything thrown rolls it
 * back — the equivalent of Spring's @Transactional on a service method.
 */
export async function tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await pool().connect();
    try {
        await client.query("BEGIN");
        const db = new Db(client, true);
        const result = await fn(db);
        await client.query("COMMIT");
        db.flushAfterCommit();
        return result;
    } catch (err) {
        try {
            await client.query("ROLLBACK");
        } catch {
            /* connection already gone — nothing to roll back */
        }
        throw err;
    } finally {
        client.release();
    }
}

export async function closePool(): Promise<void> {
    if (g.__psyfosPool) {
        await g.__psyfosPool.end();
        g.__psyfosPool = undefined;
    }
}
