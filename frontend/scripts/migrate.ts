// Applies any pending SQL migrations (db/migrations/*.sql) to DATABASE_URL.
//   npm run db:migrate
// The app also does this by itself on its first request, so running this is
// optional — it is useful to prepare a fresh database before the first deploy,
// or to see exactly what was applied.
import "./_env";
import { closePool } from "../server/db";
import { runMigrations } from "../server/migrate";

async function main() {
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
        console.error("DATABASE_URL is not set. Put it in frontend/.env.local or export it first.");
        process.exit(1);
    }
    const applied = await runMigrations();
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is already up to date.");
    await closePool();
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
