import { config } from "../config";
import { Ctx, get, post, patch } from "../router";
import { ApiError, json, noContent, notFound, pathId, badRequest, readJson } from "../http";
import { minutesToTime, parseDate, timeToMinutes } from "../time";
import { AppUser, ClinicHoliday, Roles } from "../types";
import * as auth from "../services/auth";
import * as appts from "../services/appointments";
import * as avail from "../services/availability";
import * as settings from "../services/settings";
import * as notes from "../services/notes";
import * as subs from "../services/subscription";
import { resolveBookableDoctorId } from "../services/staffResolution";
import { recordLogout } from "../services/staff";
import { chat } from "../services/chat";
import { handleTelegramUpdate } from "../services/telegram";
import { background } from "../services/notifications";

// Everything reachable without a login (plus the auth endpoints themselves):
// health, signup/login, the slug-scoped public booking surface, appointment
// tracking by token, mood check-ins, the help chatbot and the Telegram webhook.

export function registerPublicRoutes(): void {
    // ── Health (also served at the legacy /actuator/health) ──────────────────
    get("/health", "public", async (c) => {
        if (c.query.get("deep") === "1") await c.db.scalar("SELECT 1");
        return { status: "UP" };
    });

    // ── Auth ─────────────────────────────────────────────────────────────────
    post("/auth/signup", "public", async (c) => auth.signup(await c.body()));
    post("/auth/login", "public", async (c) => auth.login(c.db, await c.body()));
    patch("/auth/phone", "user", async (c) => auth.updatePhone(c.db, c.me(), await c.body()));
    post("/auth/logout", "user", async (c) => {
        await recordLogout(c.db, c.me());
        return noContent();
    });
    // Lets the frontend confirm a stored token is still valid before trusting it.
    get("/auth/me", "user", async (c) => auth.buildAuthResponse(c.me(), null));

    // ── Public booking surface, scoped by a practitioner's slug ──────────────
    const resolveOwner = async (c: Ctx): Promise<AppUser> => {
        const owner = await c.db.one<AppUser>("SELECT * FROM app_user WHERE slug = $1 AND role = $2", [c.params.slug, Roles.PSYCHOLOGIST]);
        if (!owner) throw notFound("No such booking link");
        return owner;
    };
    const staffIdParam = (c: Ctx): number | null => {
        const raw = c.query.get("staffId");
        return raw === null || raw === "" ? null : pathId(raw, "staffId");
    };

    get("/public/:slug/info", "public", async (c) => {
        const owner = await resolveOwner(c);
        const s = await settings.getSettings(c.db, owner.id);
        return {
            slug: owner.slug, name: owner.name, jobTitle: owner.jobTitle, bio: owner.bio,
            profileImageUrl: owner.profileImageUrl, bookable: owner.bookable,
            // Tenant-wide billing gate, distinct from `bookable` (one practitioner's
            // personal toggle): a clinic's whole roster goes un-bookable together
            // when the OWNER's subscription lapses.
            acceptingBookings: await subs.isAccessAllowed(c.db, owner.id),
            accountType: owner.accountType ?? "INDIVIDUAL",
            clinicName: s.clinicName, address: s.address, contactPhone: s.contactPhone, contactEmail: s.contactEmail,
            paymentQrCodeUrl: s.paymentQrCodeUrl, demoCallNumber: s.demoCallNumber,
        };
    });

    // The clinic's bookable staff roster: the tenant-root row itself (if bookable)
    // plus every enabled+bookable staff member.
    get("/public/:slug/staff", "public", async (c) => {
        const owner = await resolveOwner(c);
        const toDto = (u: AppUser) => ({ id: u.id, name: u.name, jobTitle: u.jobTitle, bio: u.bio, profileImageUrl: u.profileImageUrl });
        const roster = [];
        if (owner.bookable && owner.enabled) roster.push(toDto(owner));
        const staff = await c.db.many<AppUser>(
            "SELECT * FROM app_user WHERE tenant_id = $1 AND role = $2 AND bookable = true AND enabled = true ORDER BY id",
            [owner.id, Roles.PSYCHOLOGIST]);
        staff.forEach((s) => roster.push(toDto(s)));
        return roster;
    });

    get("/public/:slug/services/catalog", "public", async (c) => settings.listActiveServices(c.db, (await resolveOwner(c)).id));

    get("/public/:slug/services", "public", async (c) => {
        const owner = await resolveOwner(c);
        const doctorId = await resolveBookableDoctorId(c.db, owner, staffIdParam(c));
        return avail.getDoctorOfferedServices(c.db, doctorId);
    });

    get("/public/:slug/availability-summary", "public", async (c) => {
        const owner = await resolveOwner(c);
        const doctorId = await resolveBookableDoctorId(c.db, owner, staffIdParam(c));
        return avail.getAvailabilitySummary(c.db, doctorId, c.query.get("mode"));
    });

    get("/public/:slug/slots", "public", async (c) => {
        const owner = await resolveOwner(c);
        const date = parseDate(c.query.get("date"), "date");
        const doctorId = await resolveBookableDoctorId(c.db, owner, staffIdParam(c));
        // Holiday/closure is clinic-wide; slot conflict is per practitioner; booked-slot
        // exclusion is mode-agnostic. No `duration` on the public side: patients never
        // choose the session length.
        const holiday = await c.db.one("SELECT 1 FROM clinic_holiday WHERE holiday_date = $1 AND psychologist_id = $2", [date, owner.id]);
        return avail.getAvailableSlotsForDoctor(c.db, doctorId, date, !!holiday, c.query.get("mode"), null);
    });

    get("/public/:slug/holidays", "public", async (c) => {
        const owner = await resolveOwner(c);
        return c.db.many<ClinicHoliday>("SELECT * FROM clinic_holiday WHERE psychologist_id = $1 ORDER BY id", [owner.id]);
    });

    get("/public/:slug/bank-accounts", "public", async (c) => settings.getActiveBankAccounts(c.db, (await resolveOwner(c)).id));

    // Returning-patient check on the booking form
    get("/public/:slug/patients/check", "public", async (c) => {
        const owner = await resolveOwner(c);
        const phone = c.query.get("phone");
        if (phone === null) throw badRequest("Invalid value for 'phone'.");
        const row = await c.db.one("SELECT 1 FROM patient WHERE phone = $1 AND primary_psychologist_id = $2", [phone.trim(), owner.id]);
        return { exists: !!row };
    });

    // Captures a prospective client as soon as they submit step one of the
    // booking wizard; booking later flips the same row to CONVERTED.
    post("/public/:slug/leads", "public", async (c) => {
        const owner = await resolveOwner(c);
        return settings.createLead(c.db, owner.id, await c.body());
    });

    // ── Booking submit / demo call (public) ──────────────────────────────────
    post("/appointments", "public", async (c) => appts.bookAppointment(appts.parseBookingRequest(await c.body(), { requireSlug: true })));
    post("/demo-booking", "public", async (c) => appts.requestDemoCall(appts.parseDemoRequest(await c.body())));

    // ── Tracking by token ────────────────────────────────────────────────────
    get("/track/:token", "public", async (c) => appts.getAppointmentByToken(c.db, c.params.token));

    post("/track/:token/rebook", "public", async (c) => {
        const body = await c.body();
        const newDate = body.newAppointmentDate;
        const newStart = body.newStartTime;
        if (newDate == null) throw badRequest("newAppointmentDate must not be null");
        if (newStart == null) throw badRequest("newStartTime must not be null");
        const date = parseDate(newDate, "newAppointmentDate");
        const mins = timeToMinutes(newStart);
        if (mins === null) throw badRequest("The request could not be read — please check the values you entered.");
        return appts.rebookAppointment(c.params.token, date, minutesToTime(mins));
    });

    post("/track/:token/rating", "public", async (c) => {
        const body = await c.body();
        const rating = body.rating === undefined || body.rating === null ? null : Number(body.rating);
        if (rating !== null && !Number.isInteger(rating)) throw badRequest("The request could not be read — please check the values you entered.");
        return appts.submitRating(c.db, c.params.token, rating, body.feedback == null ? null : String(body.feedback));
    });

    post("/track/:token/report-payment", "public", async (c) => {
        const body = await c.body();
        return appts.reportPaymentMade(c.params.token, body.paymentScreenshotBase64 == null ? null : String(body.paymentScreenshotBase64));
    });

    // ── Mood check-in (public, by tracking token) ────────────────────────────
    post("/mood", "public", async (c) => {
        const body = await c.body();
        if (body.trackingToken == null || body.moodScore == null) throw badRequest("The request could not be read — please check the values you entered.");
        const score = Number(body.moodScore);
        if (!Number.isInteger(score)) throw badRequest("Invalid date/time or number format: For input string: \"" + body.moodScore + "\"");
        return notes.submitMoodLog(c.db, String(body.trackingToken), score, body.note == null ? null : String(body.note));
    });

    // ── Help chatbot ─────────────────────────────────────────────────────────
    post("/chat", "public", async (c) => {
        const body = await c.body();
        return { response: await chat(body.message == null ? "" : String(body.message)) };
    });

    // ── Telegram webhook (replaces the old getUpdates poller) ────────────────
    post("/telegram/webhook", "public", async (c) => {
        const secret = config.telegramWebhookSecret;
        if (secret && c.req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
            throw new ApiError(401, "Unauthorized");
        }
        const update = await readJson(c.req, { optional: true });
        // Telegram expects a fast 200; the linking work finishes in the background.
        background(handleTelegramUpdate(update));
        return json({ ok: true });
    });
}

