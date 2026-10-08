import { tx } from "./db";
import { MIGRATIONS } from "./migrations.generated";

// Applies any db/migrations/*.sql that hasn't run yet, in filename order.
//
// The whole run happens inside ONE transaction guarded by a transaction-level
// advisory lock. That choice matters on serverless: several cold instances can
// start at the same moment, and managed Postgres poolers (Neon, Supabase) run in
// transaction-pooling mode where session-level locks are unreliable — an xact
// lock is held by exactly the backend connection the transaction is pinned to.
const LOCK_KEY = 727274; // arbitrary, stable

export async function runMigrations(): Promise<string[]> {
    return tx(async (db) => {
        await db.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
        await db.query(
            "CREATE TABLE IF NOT EXISTS schema_migrations (" +
                "version text PRIMARY KEY, applied_at timestamp without time zone NOT NULL DEFAULT now())"
        );
        const done = new Set(
            (await db.many<{ version: string }>("SELECT version FROM schema_migrations")).map((r) => r.version)
        );
        const applied: string[] = [];
        for (const m of MIGRATIONS) {
            if (done.has(m.version)) continue;
            await db.query(m.sql); // no params => simple protocol => multi-statement files are fine
            await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [m.version]);
            applied.push(m.version);
        }
        return applied;
    });
}
