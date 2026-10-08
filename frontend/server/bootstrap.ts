import { config, validateJwtSecret } from "./config";
import { getDb } from "./db";
import { runMigrations } from "./migrate";
import { hashPassword } from "./security/auth";
import { Roles } from "./types";
import { nowTs } from "./time";

// What the Spring StartupInitializer + Hibernate ddl-auto=update did on every
// boot, as an idempotent step that runs once per warm function instance:
//   1. bring the schema up to date (versioned SQL migrations)
//   2. grandfather any tenant that predates the subscription system
//   3. seed the single superadmin from SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD
//
// After the first request it is a resolved promise, so it costs nothing.

type G = typeof globalThis & { __psyfosReady?: Promise<void> };
const g = globalThis as G;

export function ensureReady(): Promise<void> {
    if (!g.__psyfosReady) {
        g.__psyfosReady = bootstrap().catch((err) => {
            g.__psyfosReady = undefined; // let the next request retry instead of caching a failure
            throw err;
        });
    }
    return g.__psyfosReady;
}

export async function bootstrap(): Promise<void> {
    validateJwtSecret();
    const applied = await runMigrations();
    if (applied.length) console.log(`[bootstrap] applied migrations: ${applied.join(", ")}`);
    await grandfatherExistingTenants();
    await seedSuperAdmin();
}

// Launching the trial/paid system must never lock out an account that was
// already using the product — anyone without a Subscription row yet is
// ACTIVE with no forced expiry. Only new signups get the 14-day trial.
async function grandfatherExistingTenants(): Promise<void> {
    const ts = nowTs();
    const n = await getDb().exec(
        `INSERT INTO subscription (psychologist_id, status, plan, amount, created_at, updated_at)
         SELECT u.id, 'ACTIVE', 'INDIVIDUAL_ANNUAL', 9999, $1, $1
           FROM app_user u
          WHERE u.role = $2 AND u.tenant_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.psychologist_id = u.id)`,
        [ts, Roles.PSYCHOLOGIST]
    );
    if (n > 0) console.log(`[bootstrap] grandfathered ${n} pre-existing account(s) with an unrestricted ACTIVE subscription`);
}

async function seedSuperAdmin(): Promise<void> {
    const email = config.superadminEmail.trim().toLowerCase();
    const password = config.superadminPassword;
    if (!email || !password) {
        console.warn(
            "[bootstrap] SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD not set — no superadmin account will be seeded."
        );
        return;
    }
    const db = getDb();
    const existing = await db.one<{ role: string }>("SELECT role FROM app_user WHERE username = $1", [email]);
    if (existing) {
        if (existing.role !== Roles.SUPERADMIN) {
            console.error(
                `[bootstrap] SUPERADMIN_EMAIL ${email} is already registered as a regular account — refusing to seed a ` +
                    "superadmin with the same email. Use a distinct email for the superadmin account."
            );
        }
        return;
    }

    // The superadmin row still needs a unique, non-null slug to satisfy the
    // table's schema, even though it's never reachable via /book/{slug}
    // (public lookups are scoped to ROLE_PSYCHOLOGIST).
    let slug = "superadmin";
    let suffix = 1;
    while (await db.one("SELECT 1 FROM app_user WHERE slug = $1", [slug])) {
        suffix += 1;
        slug = `superadmin-${suffix}`;
    }
    try {
        await db.insert("app_user", {
            username: email,
            password: await hashPassword(password),
            name: "Super Admin",
            role: Roles.SUPERADMIN,
            slug,
            bookable: false,
            enabled: true,
        });
        console.log(`[bootstrap] seeded superadmin account for ${email}`);
    } catch (err) {
        // Two cold instances starting together can both get here; the loser's
        // insert trips the unique constraint, which just means it already exists.
        if ((err as { code?: string }).code !== "23505") throw err;
    }
}
