// Loads .env.local (then .env) for CLI scripts, the way `next dev` does for the app.
// Variables already present in the real environment always win.
for (const file of [".env.local", ".env"]) {
    try {
        (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(file);
    } catch {
        /* file missing — fine */
    }
}
