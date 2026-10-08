# Deploying Mindesk (Psyfos) on Vercel

The whole product — website **and** REST API — is now one Next.js app in `frontend/`. The API that used to be
a separate Spring Boot service lives in `frontend/server/` and is served from `/api/v1/*` by a single Vercel
Function. There is no Java server, no EC2, no Docker, no Caddy to run any more. You need two things:

1. a **Vercel project** (the app), and
2. a **Postgres database** (Neon is the one-click option from the Vercel Marketplace).

> The old Java backend is still in `backend/` as a reference and a rollback option. Nothing in the new
> deployment uses it.

## 1 · Create the database

Easiest: Vercel dashboard → your project → **Storage → Create → Neon (Postgres)**. It injects
`DATABASE_URL`/`POSTGRES_URL` for you. Pick the region closest to your clinic (e.g. Mumbai).
Any Postgres works (Supabase, RDS…) — use its **pooled** connection string.

You do **not** have to create tables. On the first request the app applies the SQL in
`frontend/db/migrations/` itself (and seeds the super-admin), exactly like the old backend did at startup.
To do it ahead of time: `cd frontend && npm run db:migrate`.

## 2 · Create the Vercel project

1. vercel.com → **Add New → Project** → import this GitHub repo.
2. **Root Directory:** `frontend`  ·  Framework: Next.js (auto-detected). `vercel.json` pins the Mumbai region
   (`bom1`) and the function timeout — change `regions` if your database lives elsewhere.
3. **Environment variables** (see `frontend/.env.example` for the full list):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | pooled Postgres URL (set automatically by the Neon integration) |
| `JWT_SECRET` | `openssl rand -base64 64`. **Re-use the old backend's value to keep everyone logged in** |
| `APP_BASE_URL` | your Vercel URL, e.g. `https://mindesk.vercel.app` |
| `NEXT_PUBLIC_API_URL` | `/api/v1` |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | the platform-owner login at `/admin` |
| `PLATFORM_UPI_ID`, `PLATFORM_UPI_QR_BASE64` | shown on the tenants' Subscription page |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | optional — email |
| `TWILIO_*` | optional — SMS / WhatsApp |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | optional — see below |
| `AI_API_KEY` (+ `AI_BASE_URL`, `AI_MODEL`) | optional — help chatbot |

4. **Deploy.** Open `https://<your-app>/api/v1/health?deep=1` — it should return `{"status":"UP"}`.

## 3 · Moving your existing data (only if you already have live data)

The new schema is identical to what Hibernate created, so a plain dump/restore is all it takes:

```bash
# from the old server (or any machine that can reach it)
pg_dump --no-owner --no-privileges -Fc "postgresql://individual:...@old-host:5432/individual" -f mindesk.dump
# into the new database (use Neon's *direct* connection string for the restore)
pg_restore --no-owner --no-privileges -d "postgresql://...neon.tech/neondb?sslmode=require" mindesk.dump
```

On the first request the app adds the Psyfos columns/tables (case status, follow-ups, service categories)
and categorises your existing services by name. Existing clients who already had a completed session start
as **Ongoing**, everyone else as **New Case**. Everything else is untouched.

## 4 · After deploying

* **Telegram (optional):** the old backend polled Telegram; Vercel can't. Set `TELEGRAM_BOT_TOKEN`,
  `APP_BASE_URL` (and ideally `TELEGRAM_WEBHOOK_SECRET`) and run once: `cd frontend && npm run telegram:webhook`.
* **Uptime monitor:** `.github/workflows/uptime-check.yml` now pings `/api/v1/health`; update the
  `HEALTH_CHECK_URL` secret to `https://<your-app>/api/v1/health`. (`/actuator/health` is rewritten there too.)
* **Rate limiting:** login/signup/public endpoints have an in-memory per-instance limiter. For a hard limit add a
  Vercel Firewall rate-limit rule on `/api/v1/auth/*` and `/api/v1/public/*`.
* **Backups:** use the database provider's point-in-time recovery (Neon has it built in). The EBS-snapshot script
  in `deploy/` was for the EC2 setup and no longer applies.

## Things that behave differently on Vercel

* **Upload size:** Vercel rejects request bodies over 4.5 MB, so patient attachments are limited to **3 MB**
  (was 10 MB). Payment screenshots and bank QR images are already compressed in the browser and are unaffected.
  If you need bigger files later, the upgrade path is Vercel Blob with direct-from-browser uploads.
* **Notifications** (email/SMS/Telegram) are sent in the background after the response, using Vercel's
  `waitUntil`, instead of the old `@Async` threads.
* **Time zone:** every "today"/"now" is computed in `APP_TIMEZONE` (default `Asia/Kolkata`), same as the old
  container's `-Duser.timezone`.

## Local development

```bash
cd frontend
cp .env.example .env.local        # point DATABASE_URL at any local/scratch Postgres
npm install
npm run dev                       # http://localhost:3000 — site and API together
npm run test:api                  # end-to-end API checks (use a THROWAWAY database)
```
