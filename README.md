# Mindesk

A practice-management and booking platform for psychologists — solo practitioners and clinics alike. One dashboard covers the public booking page, patient records, session notes, scheduling, invoicing, and analytics; clinics additionally get staff accounts with per-person dashboard permissions and shared, multi-doctor booking.

This document is the single reference for how the product and codebase fit together: who it's for, how multi-tenancy and security work, every feature, the data model, the API surface, and how to run and deploy it.

> **Architecture update — now a single Vercel app.** The REST API that used to be the Spring Boot service in
> `backend/` is now part of the Next.js app: `frontend/server/` (services, security, SQL migrations in
> `frontend/db/migrations/`) served by `frontend/app/api/v1/[...path]/route.ts`. Same endpoints, same JSON, same
> roles/permissions, same database schema — so the existing screens work unchanged. Deploy with
> [`DEPLOY.md`](DEPLOY.md). Wherever this README says "Spring"/"Java"/"JPA", read `frontend/server/` — the
> `backend/` folder is kept only as a reference/rollback.

## Psyfos workflow (therapist & receptionist)

The clinic's required flow is built on top of the existing screens:

**Receptionist:** enquiry (Leads / public booking page) → client details → service (Counselling · Therapy · Assessment · Career · Other) → therapist → date & time → payment / confirmation → *(session)* → follow-up → session status → Monthly / Management Report.
Entry point: **Appointments → New Booking** (a 5-step wizard; also launched from a lead or a client's profile).

**Therapist:** login → **Schedule** → today's appointments → client profile → **Case History** → conduct session → **Session Notes** → update **session status** → schedule next **Follow-up** → save. Nav: Schedule · My Clients · Case History · Session Notes · Follow-up · My Session Reports. "Complete session" does notes + status + follow-up in one atomic step (`POST /appointments/:id/complete`).

**Session status** (per client): New Case · Ongoing · Periodic Follow-up · Terminated · Dropped — logged on every change (`case_status_log`). **Follow-ups** (`follow_up`): set a date, optionally book the session; PENDING → BOOKED → DONE. **Reports:** `/dashboard/reports` (clinic, ANALYTICS permission) and `/dashboard/my-reports` (a therapist's own numbers); both export CSV / print.

---

## Table of contents

1. [Who this is for](#who-this-is-for)
2. [Tech stack](#tech-stack)
3. [Repository layout](#repository-layout)
4. [Architecture: tenants, staff, and data isolation](#architecture-tenants-staff-and-data-isolation)
5. [Authentication, roles, and permissions](#authentication-roles-and-permissions)
6. [Core features](#core-features)
7. [Clinic & staff management](#clinic--staff-management)
8. [Public booking flow](#public-booking-flow)
9. [Subscriptions & billing](#subscriptions--billing)
10. [Superadmin](#superadmin)
11. [Integrations](#integrations)
12. [Security measures](#security-measures)
13. [Data model](#data-model)
14. [API surface](#api-surface)
15. [Frontend route map](#frontend-route-map)
16. [Local development](#local-development)
17. [Deployment](#deployment)
18. [Known limitations & technical debt](#known-limitations--technical-debt)

---

## Who this is for

At signup, an account is one of two types, chosen once and never mixed:

- **Individual** — a solo freelance psychologist. One person, one calendar, one dashboard. This is the original product and its behavior is unchanged by anything below.
- **Clinic** — a practice with more than one person seeing patients, or a front-desk/admin layer. The clinic owner's dashboard gains a **Staff** page: they create logins for doctors, receptionists, and support staff, decide what each one can see, and clients booking the clinic's public link pick which practitioner they want to see.

Both are the same price (₹9,999/year after a 14-day free trial) — a clinic doesn't pay per seat.

## Tech stack

**Backend** — `backend/`
- Java 17, Spring Boot 3.2.5 (web, data-jpa, security, validation, actuator)
- PostgreSQL (via Spring Data JPA / Hibernate, `ddl-auto=update` — see [Known limitations](#known-limitations--technical-debt))
- JWT auth via `io.jsonwebtoken` (JJWT) 0.11.5
- Twilio SDK (SMS/WhatsApp), Resend (email) — both optional
- Lombok, Maven (`mvnw` wrapper included, no local Maven install required)

**Frontend** — `frontend/`
- Next.js 14.2.3 (App Router), React 18, TypeScript 5
- Tailwind CSS for utility styling, plus a hand-written CSS design system (`globals.css` — the `soft-card`/`nm-*`/`btn-nm-*` neumorphic component classes used throughout)
- axios (API client), react-hook-form, date-fns, recharts (analytics charts), sonner (toasts), lucide-react (icons)

**Infra**
- Docker Compose for local Postgres + optional full-stack containers (`docker-compose.yml`)
- Production: EC2 (Docker Compose + Caddy for automatic HTTPS) for the backend/DB, Vercel for the frontend — see [`DEPLOY.md`](DEPLOY.md)

## Repository layout

```
backend/
  src/main/java/com/patientbook/
    controller/    REST endpoints (one class per resource area)
    service/       business logic, tenant-scoping, orchestration
    repository/    Spring Data JPA interfaces
    entity/        JPA entities (see Data model below)
    dto/           request/response payloads (entities are never returned directly)
    security/      JWT filter chain, role/permission gating, rate limiting
    config/        StartupInitializer (superadmin seeding, one-time backfills)
  src/main/resources/application*.properties
frontend/
  app/             Next.js App Router pages (see Frontend route map)
  components/      shared UI (ChatbotWidget, ThemeToggle, Spotlight, ...)
  lib/             typed API clients (api.ts, publicApi.ts, profileApi.ts, staffApi.ts, superAdminApi.ts, subscriptionApi.ts)
docker-compose.yml, docker-compose.prod.yml, Caddyfile
DEPLOY.md          step-by-step EC2 + Vercel deployment guide
```

## Architecture: tenants, staff, and data isolation

Every account is a row in a single `app_user` table — there's no separate "organization" table. The distinction that drives everything is one column:

- **`tenantId` is `NULL`** → this row is itself a tenant. This is either an **Individual** practitioner or a **Clinic**'s owner/admin account. Its own `id` is the tenant ID that every other table (patients, appointments, invoices, settings, services, bank accounts...) is scoped by.
- **`tenantId` is set** → this row is a **staff member** belonging to the clinic whose owner has that ID. Staff never own tenant-wide data themselves; they operate within their tenant's data via permissions.

`CurrentUserProvider.getCurrentTenantId()` is the single place this resolves: for a tenant root it returns their own ID (byte-for-byte the same value an Individual account always used), for staff it returns their `tenantId`. Every controller that touches shared clinic data (patients, invoices, settings, bank accounts, reports, the service catalog) scopes its queries through this method — so a receptionist and a clinic-owner see the exact same shared patient list, and an Individual account's behavior never changes.

**What stays per-person even inside a clinic:** a doctor's own calendar, weekly schedule, availability overrides, and per-service pricing are keyed by that specific person's own ID (`getCurrentUserId()`), never the tenant ID — reached through `/api/v1/me/**`. This is deliberate: it means a staff doctor manages their own calendar through the exact same self-service endpoints an Individual account already used, with no new code path. The one place both concepts meet is `Appointment`, which carries **both** `psychologistId` (the tenant — "which clinic/practice") and `assignedDoctorId` (the specific practitioner the appointment is with); slot-conflict checks are scoped by `assignedDoctorId` so two doctors in the same clinic can be booked at the same time without colliding.

**Trusting client input:** no request body ever carries a `tenantId` or is allowed to assert "I am staff of clinic X" — tenant identity is always re-derived server-side from the authenticated caller's own `app_user` row. Any endpoint that accepts a client-chosen staff/doctor ID (public booking's staff picker, admin-driven manual scheduling) runs it through `StaffResolutionService`, which validates the ID actually belongs to the caller's tenant and is an appropriate role, before trusting it for anything.

## Authentication, roles, and permissions

JWT-based, stateless (`Authorization: Bearer <token>`, ~8h expiry). Four role strings exist (`com.patientbook.security.Roles`):

| Role | Who | Notes |
|---|---|---|
| `ROLE_PSYCHOLOGIST` | Every tenant root (Individual or Clinic owner), **and** any bookable staff doctor within a clinic | Reused across both because the underlying capability — "run my own calendar" — is identical either way |
| `ROLE_RECEPTIONIST` | Clinic support staff | Always has `tenantId` set; never a tenant root |
| `ROLE_STAFF` | Clinic support staff, generic | Same as above |
| `ROLE_SUPERADMIN` | The single seeded platform-owner account | Never created via signup — see [Superadmin](#superadmin) |

**Dashboard-tab permissions** (clinic staff only — tenant roots always have full access to their own tenant): `APPOINTMENTS`, `PATIENTS`, `BILLING`, `ANALYTICS`, `SETTINGS`, stored as a comma-separated list on the staff's own row and enforced by `StaffPermissionFilter` (a servlet filter, so it can't be bypassed by any one controller forgetting a check). A staff doctor (`ROLE_PSYCHOLOGIST` with `tenantId` set) is auto-granted `APPOINTMENTS` and `PATIENTS` — running your own calendar and seeing the shared patient roster is the job — but still needs an explicit grant for `BILLING`/`ANALYTICS`/`SETTINGS`, so one compromised or disgruntled doctor login doesn't expose the whole clinic's revenue.

**Deactivation is immediate**, not just "blocks the next login": `JwtAuthenticationFilter` reloads the account's `enabled` flag from the database on every single request (never cached), so revoking a staff member's access takes effect on their very next API call, not after their current token happens to expire.

## Core features

These work identically for Individual and Clinic accounts (clinic-specific behavior is called out in each section):

- **Public booking page** (`/book/{slug}`) — a branded, no-login booking flow: patient details → (clinics only) pick a practitioner → session type → date/time → confirm. See [Public booking flow](#public-booking-flow).
- **Patients** — a shared, phone-deduplicated patient roster per tenant (a returning patient is recognized by phone number). Risk-flagging, notes, file attachments, appointment history, and Telegram-linking live on the patient record.
- **Appointments** — full lifecycle: `AWAITING_PAYMENT → CONFIRMED → COMPLETED`, plus `CANCELLED`, `PENDING`, `PAYMENT_UNDER_REVIEW`, and a `DEMO_CALL_PENDING` state for pre-booking sales calls that convert into real appointments. Manual scheduling and past-session backfill are available from the dashboard.
- **Session notes** — structured SOAP notes (Subjective/Objective/Assessment/Plan) per appointment, plus a legacy free-text field.
- **Invoicing** — auto-generated per appointment using the treating doctor's own price for that service (falling back to the clinic's catalog fee); supports discounts, waiving, multiple bank accounts with a default, and a revenue summary.
- **Services & pricing** — a shared, tenant-wide service catalog (name, duration, description, icon, default fee) that each bookable practitioner then individually prices and opts into offering via their own `/me/services`.
- **Availability** — two overlapping mechanisms per practitioner: legacy fixed weekly slots, and block-based generation (a day-of-week + time range + interval, expanded into slots), plus one-off date overrides (block a day, or add an extra slot).
- **Analytics** — booking trends, completion/payment-clearance rates, patient retention, busiest-day breakdowns.
- **Mood check-ins** — a public, token-linked page (`/mood/{token}`) where a patient self-reports a 1–10 mood score after a session, visible to their practitioner as a trend. No login; the tracking token is the same one used for the booking-status page.
- **Tracking & rebooking** — every appointment gets a unique tracking link (`/track/{token}`) showing live status, payment instructions/proof upload, a post-completion rating prompt, and a one-click rebook flow for cancelled sessions (pre-fills the same patient/service, picks a new slot, issues a new tracking token — tenant and assigned doctor are carried over server-side, never re-derived from client input).
- **AI chatbot widget** — a floating assistant on public-facing pages, backed by any OpenAI-compatible chat-completions API (configurable; defaults to an NVIDIA-hosted model). Its knowledge is a static markdown file injected into the system prompt (simple RAG, not embeddings/vector search) — answers strictly from that document, says "I don't know" otherwise. Fully optional: with no API key configured it returns a friendly "not set up yet" message instead of failing.

## Clinic & staff management

Reachable from a clinic owner's dashboard under **Staff** (hidden entirely for Individual accounts and for staff logins).

- **Creating staff**: the clinic admin sets a name, login email, password, job title, role (`Staff` / `Receptionist` / `Psychologist`), and which dashboard tabs they can see. A `Psychologist` role can additionally be marked **bookable**, which is what makes them appear on the public booking page's practitioner picker.
- **Staff can never self-provision or manage each other** — every staff-management endpoint requires the caller to be the clinic's own tenant root; this is enforced once, centrally, in `StaffService.requireClinicOwner`, not scattered across controllers.
- **Ownership is always double-checked**: every action targeting a specific staff ID (`StaffService.requireOwnedStaff`) confirms that ID actually belongs to the caller's own clinic before touching it — so one clinic can never edit, deactivate, or read the attendance history of another clinic's staff, even though staff IDs are globally unique across the whole platform.
- **"Delete" deactivates, it doesn't erase**: turning a staff member off blocks their login immediately and removes them from the public booking page, but their historical appointments, invoices, and notes keep showing their real name — reactivating restores access without having lost any calendar/pricing configuration.
- **Attendance**: every staff login/logout is timestamped (`StaffAttendance`), visible to the clinic owner as a live "who's active now" view plus full history, scoped the same tenant-safe way as everything else.
- **A staff doctor's own calendar**: once created, a staff psychologist logs in and configures their own bio, photo, offered services & pricing, and weekly availability from the same **Settings** page an Individual account uses — those tabs are visible to any bookable staff doctor regardless of their granted permissions (they're self-scoped, not clinic-wide), while the clinic-wide tabs (practice info, bank accounts, leave days) stay behind the `SETTINGS` permission.

## Public booking flow

`/book/{slug}` resolves the tenant root behind that slug (never a raw numeric ID — an unknown slug always 404s rather than confirming/denying it exists). For a Clinic account, the wizard inserts a **Practitioner** step between patient details and session selection, listing every bookable, enabled staff doctor (plus the owner, if they're bookable too); picking exactly one skips the picker automatically the same way an Individual's link always has. The chosen staff ID is validated server-side on **both** the read side (fetching that doctor's services/slots) and the booking-submission endpoint itself — a client can't submit a booking against a doctor who doesn't belong to that clinic.

## Subscriptions & billing

Every tenant (Individual or Clinic — never staff, who ride on their clinic's own subscription) gets a 14-day free trial from signup, then ₹9,999/year. There's no payment gateway integration: the client pays via UPI/GPay outside the app and submits proof (a UTR + optional screenshot) from their own dashboard's Subscription page; a superadmin reviews and approves/rejects it. `SubscriptionAccessFilter` blocks the dashboard API (never the public booking page — existing patients can always still book) once a subscription lapses. Accounts that existed before this system shipped were grandfathered in as unrestricted.

## Superadmin

A single seeded platform-owner account (`ROLE_SUPERADMIN`, provisioned once at startup from `SUPERADMIN_EMAIL`/`SUPERADMIN_PASSWORD`, never via signup), reachable at `/superadmin/login` and gated by an optional IP allowlist. From `/superadmin/dashboard` they see every tenant with a visual **Individual vs. Clinic** badge (clinics additionally show their current staff count), review pending payment submissions, and can manually activate/suspend any tenant's subscription. Every mutating action is written to an audit log (`AdminAuditLog`). The tenant list and startup grandfathering logic are explicitly scoped to tenant-root rows (`tenantId IS NULL`) so clinic staff — who share the same `ROLE_PSYCHOLOGIST` string as real tenants — never get double-counted as phantom paying customers.

## Integrations

All of the following are optional — the app runs fully without any of them configured, just with that specific channel silently skipped:

- **Email** — Resend (`RESEND_API_KEY`).
- **SMS & WhatsApp** — Twilio (`TWILIO_*`).
- **Telegram** — a bot the patient can link from their tracking page; outbound notifications are pushed to linked chats, and inbound `/start {token}` linking is handled by scheduled long-polling (`@Scheduled`, every 3s) against Telegram's `getUpdates` — there's no inbound webhook endpoint.
- **AI chatbot** — any OpenAI-compatible endpoint (`AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`).
- **Google Calendar** — **scaffolded only, not implemented.** Config placeholders (`GOOGLE_CLIENT_ID`/`SECRET`/`REDIRECT_URI`) and an `Appointment.googleCalendarEventId` column exist, but there's no OAuth flow, no callback controller, and nothing currently reads or writes that column. Treat as reserved for future work, not a working feature.

## Security measures

- Passwords hashed with BCrypt; JWT signing secret is validated at startup (refuses to boot on a blank/placeholder/too-short secret).
- Every tenant-scoped lookup uses an ownership-checked query (`findByIdAnd...TenantId`/`...PsychologistId`) where a wrong ID and a *different tenant's* ID produce an identical 404 — never leaking whether a record exists elsewhere.
- Login/signup, public booking submission, and the phone-number "returning patient" check are all rate-limited per IP (`PublicApiRateLimitFilter`) — the last one specifically to close off a phone-number enumeration oracle.
- Login failures are deliberately generic ("Invalid email or password") regardless of whether the email doesn't exist, the password is wrong, or the account is deactivated — distinguishing any of those would let someone enumerate valid or disabled accounts by probing with random passwords.
- A bookable "practitioner" can only ever be a `ROLE_PSYCHOLOGIST` row — enforced redundantly at write time (staff creation/update), at the query layer (role-filtered repository methods), and again at resolution time (`StaffResolutionService`), so no single missed check can let a receptionist row end up publicly bookable.
- CSP/HSTS/frame-deny headers on every response (this is a pure JSON API, so a locked-down CSP costs nothing functionally); CORS origins are explicitly configured in production rather than left wildcard-open.
- Deactivating a staff account revokes access on their very next request, not just their next login attempt (see [Authentication](#authentication-roles-and-permissions)).

## Data model

All entities live in `backend/src/main/java/com/patientbook/entity/`:

| Entity | Purpose |
|---|---|
| `AppUser` | Every login — tenant roots, clinic staff, and the superadmin, distinguished by `role`/`tenantId`/`accountType` (see [Architecture](#architecture-tenants-staff-and-data-isolation)) |
| `AccountType` | Enum: `INDIVIDUAL` / `CLINIC` |
| `Patient` | Shared per-tenant patient roster, deduplicated by phone |
| `PatientAttachment` | Files uploaded to a patient's record |
| `Appointment` | The core booking record — carries both the tenant (`psychologistId`) and the specific treating doctor (`assignedDoctorId`) |
| `SessionNote` | SOAP notes per appointment |
| `MoodLog` | Patient-submitted post-session mood score |
| `Invoice` | Per-appointment billing record (amount, discount, payment method, paid-to account) |
| `BankAccount` | A tenant's payout accounts (one default) |
| `ClinicService` | The shared service catalog (name, duration, default fee, icon) |
| `DoctorServicePrice` | One practitioner's own price + offered flag for a catalog service |
| `DoctorWeeklySlot` | Legacy fixed weekly availability slot |
| `DoctorAvailabilityBlock` | Block-based availability (day + time range + interval) |
| `DoctorDateOverride` | One-off date exception (block a day / add an extra slot) |
| `ClinicSettings` | Practice info (name, address, contact, payment QR) — one row per tenant |
| `ClinicHoliday` | Tenant-wide closed dates |
| `StaffAttendance` | Login/logout timestamps for clinic staff |
| `Subscription` | A tenant's trial/paid billing state |
| `PaymentSubmission` | A submitted UPI payment proof awaiting superadmin review |
| `AdminAuditLog` | Every superadmin mutation, for accountability |
| `NotificationLog` | Record of sent notifications |
| `RebookRequest` | Present in the schema but not currently used — see [Known limitations](#known-limitations--technical-debt) |

## API surface

All endpoints are under `/api/v1`. Grouped by access level:

- **Public, unauthenticated** — `/auth/signup`, `/auth/login`, `/public/{slug}/**` (info, staff roster, services, slots, holidays, bank accounts, returning-patient check), `POST /appointments` (booking submit), `/demo-booking`, `/track/{token}/**`, `POST /mood`, `/chat`.
- **Authenticated, self-scoped** — `/auth/me`, `/auth/logout`, `/me/**` (a practitioner's own profile/services/availability/calendar — works identically for an Individual or a staff doctor).
- **Authenticated, tenant-scoped** (permission-gated for clinic staff — see [Authentication](#authentication-roles-and-permissions)) — `/patients/**`, `/appointments` (list/manage), `/notes/**`, `/mood/patient|appointment/**`, `/invoices/**`, `/bank-accounts/**`, `/reports/**`, `/settings`, `/holidays/**`, `/services/**` (the catalog), `/subscription/**`.
- **Clinic-owner-only** — `/staff/**`, `/staff/attendance/**`.
- **Platform superadmin only** — `/superadmin/**` (IP-allowlist-able).

## Frontend route map

```
/                              landing page
/login, /signup                auth
/book/[slug]                   public booking wizard
/demo-book/[slug]               public demo-call booking
/track/[token]                  appointment status/payment/rating
/track/[token]/rebook           rebook a cancelled appointment
/mood/[token]                   patient mood check-in
/superadmin/login, /superadmin/dashboard

/dashboard                      overview
/dashboard/appointments
/dashboard/patients, /dashboard/patients/[id]
/dashboard/billing
/dashboard/services              (clinic-wide catalog CRUD)
/dashboard/analytics
/dashboard/settings              (self-scoped tabs: Profile/Services/Availability;
                                   clinic-wide tabs: Practice/Payment/Holidays)
/dashboard/staff                 (clinic owners only)
/dashboard/subscription
```

## Local development

```bash
# 1. Start Postgres (and optionally the whole stack)
docker compose up -d individual-db

# 2. Backend — reads localhost:5433 by default, no env vars required for a basic run
cd backend && ./mvnw spring-boot:run
# optional: SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=... ./mvnw spring-boot:run

# 3. Frontend
cd frontend && npm install && npm run dev
```
Backend: `http://localhost:8087` (health check: `/actuator/health`). Frontend: `http://localhost:3000` (or `3001` if `3000` is taken).

> **First run against an existing/older database?** See the one-time schema fix in [`DEPLOY.md`](DEPLOY.md#one-time-database-fix-deploying-the-clinicstaff-feature) — Hibernate's auto-migration can't add a `NOT NULL` column or relax an existing constraint on a table that already has rows, which the clinic/staff feature's schema change needs. A brand-new database needs no manual step.

## Deployment

See [`DEPLOY.md`](DEPLOY.md) for the full EC2 (Docker + Caddy) + Vercel walkthrough, environment variables, and the subscription/superadmin operational flow.

## Known limitations & technical debt

Kept here deliberately rather than swept under the rug:

- **No migration framework** — schema changes rely on Hibernate's `ddl-auto=update`, which only reliably *adds* nullable columns. Anything stricter (a new `NOT NULL` column, relaxing an existing constraint) needs a manual one-time `ALTER TABLE` on any database that already has data — see `DEPLOY.md`.
- **`RebookRequest` entity is unused** — it exists in the schema and has a repository, but the actual rebook flow doesn't create rows in it (it just books a fresh `Appointment` pre-filled from the cancelled one). Either wire it up for real audit history or remove it.
- **Google Calendar integration is scaffolded, not implemented** — config and a DB column exist; no OAuth flow or callback endpoint does.
- **No password-reset flow** for any account type (Individual, Clinic, or staff) — a forgotten password currently has no self-service recovery path.
- **Single-instance rate limiting** — `PublicApiRateLimitFilter` is in-memory; running multiple backend replicas would need it moved to a shared store (e.g. Redis) to stay effective.
