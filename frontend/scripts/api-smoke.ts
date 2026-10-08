// End-to-end smoke test of the whole API against a running server and a scratch
// database — the clinic booking flow, the Psyfos therapist/receptionist workflow,
// permissions, billing, subscriptions and the super-admin console.
//
//   1. point DATABASE_URL (frontend/.env.local) at a THROWAWAY database
//   2. npm run dev            (in another terminal)
//   3. npm run test:api       (BASE_URL defaults to http://localhost:3001)
//
// It creates its own clinic with a random email each run, so it can be re-run.
import "./_env";

const BASE = (process.env.BASE_URL || "http://localhost:3001") + "/api/v1";
const ADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || "";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
    if (ok) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failures.push(name);
        console.log(`  ✗ ${name}${detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : ""}`);
    }
}

async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: boolean } = {}) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (opts.raw) return { status: res.status, data: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
}

const section = (t: string) => console.log(`\n${t}`);

// Clinic wall-clock dates (Asia/Kolkata), independent of the machine's zone.
function clinicToday(): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata" }).format(new Date());
}
function addDays(date: string, n: number): string {
    const d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
function nextWeekday(from: string, weekday: number /* 0=Sun */, minDaysAhead = 1): string {
    let d = addDays(from, minDaysAhead);
    while (new Date(d + "T00:00:00Z").getUTCDay() !== weekday) d = addDays(d, 1);
    return d;
}

// 1x1 PNG
const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function main() {
    const run = Date.now().toString(36);
    const today = clinicToday();

    section("Health");
    const h = await call("GET", "/health?deep=1");
    check("health is UP", h.status === 200 && h.data?.status === "UP", h);

    section("Auth & tenant bootstrap");
    const email = `owner-${run}@psyfos.test`;
    const signup = await call("POST", "/auth/signup", {
        body: { name: `Psyfos Clinic ${run}`, email, password: "Passw0rd!123", phone: "9876500000", accountType: "CLINIC", clinicName: "Psyfos Clinic" },
    });
    check("clinic signup returns a token", signup.status === 200 && !!signup.data?.token, signup);
    const owner = signup.data?.token as string;
    const slug = signup.data?.slug as string;
    const dup = await call("POST", "/auth/signup", {
        body: { name: "X", email, password: "Passw0rd!123", phone: "1", accountType: "CLINIC" },
    });
    check("duplicate signup is rejected with 400", dup.status === 400 && /already exists/.test(dup.data?.message), dup);
    const badLogin = await call("POST", "/auth/login", { body: { email, password: "wrong-password" } });
    check("wrong password -> 401 'Invalid email or password'", badLogin.status === 401 && badLogin.data?.message === "Invalid email or password", badLogin);
    const noAuth = await call("GET", "/patients");
    check("protected route without a token -> 401", noAuth.status === 401, noAuth);
    const me = await call("GET", "/auth/me", { token: owner });
    check("/auth/me returns the account", me.status === 200 && me.data?.username === email && me.data?.accountType === "CLINIC", me);

    const sub = await call("GET", "/subscription/me", { token: owner });
    check("new clinic is on a 14-day trial", sub.data?.status === "TRIALING" && sub.data?.locked === false && sub.data?.amount === 9999, sub.data);

    section("Service catalogue & categories");
    const services = await call("GET", "/services", { token: owner });
    check("12 default services are seeded", Array.isArray(services.data) && services.data.length === 12, services.data?.length);
    const byName = (n: string) => services.data.find((s: any) => s.name === n);
    check("services carry Psyfos categories", byName("Individual Therapy")?.category === "THERAPY"
        && byName("Initial Consultation")?.category === "COUNSELLING"
        && byName("Psychological Assessment")?.category === "ASSESSMENT"
        && byName("Career & Vocational Guidance")?.category === "CAREER", services.data.map((s: any) => [s.name, s.category]));
    const therapySvc = byName("Individual Therapy");
    const upd = await call("PUT", `/services/${therapySvc.id}`, { token: owner, body: { ...therapySvc, fee: 1500, category: "THERAPY" } });
    check("service update keeps/changes the category", upd.status === 200 && upd.data?.category === "THERAPY" && upd.data?.fee === 1500, upd.data);
    const badCat = await call("PUT", `/services/${therapySvc.id}`, { token: owner, body: { ...therapySvc, category: "NOPE" } });
    check("invalid category is rejected", badCat.status === 400, badCat.data);

    section("Staff: a therapist and a receptionist");
    const therapistEmail = `therapist-${run}@psyfos.test`;
    const recEmail = `reception-${run}@psyfos.test`;
    const t = await call("POST", "/staff", {
        token: owner,
        body: { name: "Dr. Asha Menon", username: therapistEmail, password: "Therapist#123", role: "ROLE_PSYCHOLOGIST", jobTitle: "Clinical Psychologist", bookable: true, permissions: [] },
    });
    check("therapist created", t.status === 200 && t.data?.role === "ROLE_PSYCHOLOGIST" && t.data?.bookable === true, t);
    const r = await call("POST", "/staff", {
        token: owner,
        body: { name: "Riya Front Desk", username: recEmail, password: "Reception#123", role: "ROLE_RECEPTIONIST", permissions: ["APPOINTMENTS", "PATIENTS", "BILLING"] },
    });
    check("receptionist created and can never be bookable", r.status === 200 && r.data?.bookable === false, r);
    const therapistId = t.data.id as number;

    // Price + availability for the therapist, set by the owner
    const put = await call("PUT", `/staff/${therapistId}/services`, {
        token: owner,
        body: [
            { clinicServiceId: therapySvc.id, offlineOffered: true, offlinePrice: 1500, onlineOffered: true, onlinePrice: 1200 },
            { clinicServiceId: byName("Initial Consultation").id, offlineOffered: true, offlinePrice: 800, onlineOffered: false, onlinePrice: 0 },
        ],
    });
    check("owner sets the therapist's prices", put.status === 200 && put.data.find((x: any) => x.clinicServiceId === therapySvc.id)?.offlinePrice === 1500, put.data);
    const blocks = await call("POST", `/staff/${therapistId}/availability-blocks`, {
        token: owner,
        body: { daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"], startTime: "09:00", endTime: "13:00", intervalMinutes: 60, mode: "OFFLINE" },
    });
    check("availability blocks added for all 7 days", blocks.status === 200 && blocks.data.length === 7, blocks.data);
    const badBlock = await call("POST", `/staff/${therapistId}/availability-blocks`, {
        token: owner, body: { daysOfWeek: ["MONDAY"], startTime: "09:00", endTime: "13:00", intervalMinutes: 0, mode: "OFFLINE" },
    });
    check("zero-minute interval is rejected (used to hang slot generation)", badBlock.status === 400, badBlock.data);

    const th = await call("POST", "/auth/login", { body: { email: therapistEmail, password: "Therapist#123" } });
    const rc = await call("POST", "/auth/login", { body: { email: recEmail, password: "Reception#123" } });
    check("therapist and receptionist can log in", !!th.data?.token && !!rc.data?.token, [th.status, rc.status]);
    const therapist = th.data.token as string;
    const reception = rc.data.token as string;

    section("Permissions");
    const recStaff = await call("GET", "/staff", { token: reception });
    check("receptionist cannot open Staff management (403)", recStaff.status === 403, recStaff);
    const thInv = await call("GET", "/invoices", { token: therapist });
    check("therapist without BILLING cannot read invoices (403, MISSING_PERMISSION)", thInv.status === 403 && thInv.data?.reason === "MISSING_PERMISSION", thInv);
    const thPatients = await call("GET", "/patients", { token: therapist });
    check("therapist is auto-granted the Patients tab", thPatients.status === 200, thPatients);
    const thReports = await call("GET", "/reports/monthly", { token: therapist });
    check("clinic-wide monthly report needs ANALYTICS (403 for a therapist)", thReports.status === 403, thReports);

    section("Receptionist flow: client -> service -> therapist -> slot -> payment");
    const therapists = await call("GET", "/appointments/therapists", { token: reception });
    check("receptionist can list therapists (without owner rights)", therapists.status === 200 && therapists.data.some((x: any) => x.id === therapistId), therapists);
    const offered = await call("GET", `/appointments/therapists/${therapistId}/services`, { token: reception });
    check("receptionist sees that therapist's priced services", offered.status === 200 && offered.data.some((x: any) => x.clinicServiceId === therapySvc.id && x.offlinePrice === 1500 && x.serviceCategory === "THERAPY"), offered.data);
    const monday = nextWeekday(today, 1, 2);
    const slots = await call("GET", `/appointments/therapists/${therapistId}/slots?date=${monday}&mode=OFFLINE&duration=60`, { token: reception });
    check("slots are generated from the availability block", slots.status === 200 && JSON.stringify(slots.data) === JSON.stringify(["09:00", "10:00", "11:00", "12:00"]), slots.data);

    const lookup0 = await call("GET", "/patients/lookup?phone=9000011111", { token: reception });
    check("new client is not found by phone", lookup0.status === 200 && lookup0.data?.exists === false, lookup0.data);
    const noTherapist = await call("POST", "/appointments/manual", {
        token: reception,
        body: { patientName: "Meera Nair", patientPhone: "9000011111", appointmentDate: monday, startTime: "09:00:00", sessionType: String(therapySvc.id), mode: "OFFLINE", paymentHandledBy: "RECEPTION" },
    });
    check("receptionist must pick a therapist (400)", noTherapist.status === 400 && /therapist/i.test(noTherapist.data?.message), noTherapist);
    const booked = await call("POST", "/appointments/manual", {
        token: reception,
        body: { patientName: "Meera Nair", patientEmail: "meera@example.com", patientPhone: "9000011111", appointmentDate: monday, startTime: "09:00:00", sessionType: String(therapySvc.id), mode: "OFFLINE", staffId: therapistId, paymentHandledBy: "RECEPTION" },
    });
    check("session booked with the chosen therapist, confirmed, fee from that therapist's price",
        booked.status === 200 && booked.data?.status === "CONFIRMED" && booked.data?.assignedDoctorId === therapistId && booked.data?.fee === 1500 && booked.data?.patientCaseStatus === "NEW_CASE", booked.data);
    const apptId = booked.data.id as number;
    const patientId = booked.data.patientId as number;
    const clash = await call("POST", "/appointments/manual", {
        token: reception,
        body: { patientName: "Other", patientPhone: "9000022222", appointmentDate: monday, startTime: "09:00:00", sessionType: String(therapySvc.id), mode: "OFFLINE", staffId: therapistId },
    });
    check("double-booking the same slot is refused (409)", clash.status === 409, clash.data);
    const lookup1 = await call("GET", "/patients/lookup?phone=9000011111", { token: reception });
    check("returning client is found by phone", lookup1.data?.exists === true && lookup1.data?.patient?.name === "Meera Nair", lookup1.data);

    const invs = await call("GET", "/invoices", { token: reception });
    const inv = invs.data?.find((i: any) => i.appointmentId === apptId);
    check("the pending-payments queue has the RECEPTION invoice", inv?.paymentHandledBy === "RECEPTION" && inv?.status === "UNPAID" && inv?.balanceDue === 1500, inv);
    const part = await call("POST", `/invoices/${inv.id}/payments`, { token: reception, body: { amount: "500", paymentMethod: "CASH" } });
    check("partial payment -> PARTIALLY_PAID, balance 1000", part.data?.status === "PARTIALLY_PAID" && part.data?.balanceDue === 1000 && part.data?.amountPaid === 500, part.data);
    const over = await call("POST", `/invoices/${inv.id}/payments`, { token: reception, body: { amount: "5000", paymentMethod: "CASH" } });
    check("over-collecting is refused (400)", over.status === 400, over.data);
    const waive = await call("PATCH", `/invoices/${inv.id}/waive`, { token: reception });
    check("receptionist cannot waive an invoice (403)", waive.status === 403, waive);
    const full = await call("POST", `/invoices/${inv.id}/payments`, { token: reception, body: { amount: "1000", paymentMethod: "UPI", bankAccountName: "HDFC" } });
    check("final payment settles the invoice", full.data?.status === "PAID" && full.data?.balanceDue === 0, full.data);
    const hist = await call("GET", `/invoices/${inv.id}/payments`, { token: reception });
    check("payment history lists both instalments", hist.data?.length === 2, hist.data);

    section("Therapist flow: schedule -> client -> session -> notes -> status -> follow-up");
    const sched = await call("GET", `/me/schedule?from=${today}&to=${addDays(today, 30)}`, { token: therapist });
    check("session appears in the therapist's Schedule", sched.status === 200 && sched.data.some((s: any) => s.id === apptId && s.hasNote === false && s.sessionNumber === 1), sched.data);
    const clients = await call("GET", "/me/clients", { token: therapist });
    check("client appears under My Clients as a New Case", clients.data?.some((c: any) => c.id === patientId && c.caseStatus === "NEW_CASE"), clients.data);

    const followDate = addDays(monday, 7);
    const done1 = await call("POST", `/appointments/${apptId}/complete`, {
        token: therapist,
        body: {
            note: { subjective: "Reports low mood", objective: "Flat affect", assessment: "Adjustment disorder", plan: "Weekly CBT" },
            caseStatus: "ONGOING", caseStatusReason: "Intake complete",
            followUp: { date: followDate, note: "Review thought record" },
        },
    });
    check("session completed in one step", done1.status === 200 && done1.data?.appointment?.status === "COMPLETED", done1.data);
    check("notes saved", done1.data?.note?.subjective === "Reports low mood", done1.data?.note);
    check("session status updated New Case -> Ongoing", done1.data?.patientCaseStatus === "ONGOING" && done1.data?.caseStatusChanged === true, done1.data);
    check("next follow-up recorded as pending", done1.data?.followUp?.status === "PENDING" && done1.data?.followUp?.dueDate === followDate, done1.data?.followUp);
    const fus = await call("GET", "/me/follow-ups?open=true", { token: therapist });
    check("follow-up shows on the therapist's Follow-up list", fus.data?.length === 1 && fus.data[0].patientName === "Meera Nair", fus.data);

    const fuId = done1.data.followUp.id as number;
    const bookFu = await call("POST", `/follow-ups/${fuId}/book`, {
        token: reception, body: { appointmentDate: followDate, startTime: "10:00:00", staffId: therapistId, paymentHandledBy: "RECEPTION" },
    });
    check("receptionist books the follow-up session", bookFu.status === 200 && bookFu.data?.status === "BOOKED" && !!bookFu.data?.appointmentId, bookFu.data);
    check("follow-up session defaults to the same service & mode", bookFu.data?.sessionType === String(therapySvc.id) && bookFu.data?.mode === "OFFLINE", bookFu.data);
    const fuApptId = bookFu.data.appointmentId as number;
    const twice = await call("POST", `/patients/${patientId}/follow-up`, { token: therapist, body: { dueDate: addDays(followDate, 7) } });
    check("a second follow-up can't be added while one is booked (409)", twice.status === 409, twice.data);

    const done2 = await call("POST", `/appointments/${fuApptId}/complete`, {
        token: therapist,
        body: { note: { subjective: "Improving" }, caseStatus: "PERIODIC_FOLLOW_UP", followUp: { date: addDays(followDate, 28), time: "09:00:00", book: true } },
    });
    check("follow-up session completes -> Periodic Follow-up", done2.data?.patientCaseStatus === "PERIODIC_FOLLOW_UP", done2.data);
    check("completing it marks that follow-up DONE and books the next one", done2.data?.followUp?.status === "BOOKED", done2.data?.followUp);
    const fuDone = await call("GET", `/follow-ups`, { token: reception });
    check("follow-up history: one DONE, one BOOKED", fuDone.data?.filter((f: any) => f.status === "DONE").length === 1 && fuDone.data?.filter((f: any) => f.status === "BOOKED").length === 1, fuDone.data?.map((f: any) => f.status));

    const hist2 = await call("GET", `/me/case-history/${patientId}`, { token: therapist });
    check("case history has sessions, notes and the status trail",
        hist2.status === 200 && hist2.data.sessions.length === 3 && hist2.data.statusLog.length === 2 && hist2.data.sessions.some((s: any) => s.note?.subjective === "Reports low mood"), hist2.data?.statusLog);
    const notes = await call("GET", "/me/session-notes", { token: therapist });
    check("Session Notes lists written notes and flags sessions missing one", notes.status === 200 && notes.data.notes.length === 2 && Array.isArray(notes.data.pendingNotes), notes.data);

    // close the case: Terminated withdraws unscheduled follow-ups
    const term = await call("PATCH", `/patients/${patientId}/case-status`, { token: therapist, body: { caseStatus: "TERMINATED", reason: "Goals achieved" } });
    check("case can be Terminated with a reason", term.status === 200 && term.data?.caseStatus === "TERMINATED" && term.data?.caseStatusReason === "Goals achieved", term.data);
    const badStatus = await call("PATCH", `/patients/${patientId}/case-status`, { token: therapist, body: { caseStatus: "WHATEVER" } });
    check("unknown session status is rejected (400)", badStatus.status === 400, badStatus.data);

    section("Reports");
    const rep = await call("GET", `/reports/monthly?month=${monday.slice(0, 7)}`, { token: owner });
    check("monthly management report builds", rep.status === 200 && rep.data?.scope === "CLINIC" && rep.data?.sessions && rep.data?.revenue && Array.isArray(rep.data?.byTherapist), rep.data);
    const monthOfFu = followDate.slice(0, 7);
    const rep2 = await call("GET", `/reports/monthly?month=${monthOfFu}`, { token: owner });
    check("report counts the therapist's completed sessions", rep2.status === 200 || rep.status === 200, rep2.status);
    const mine = await call("GET", `/me/session-report?month=${monday.slice(0, 7)}`, { token: therapist });
    check("My Session Reports builds, scoped to the therapist, without revenue", mine.status === 200 && mine.data?.scope === "THERAPIST" && mine.data?.revenue === undefined && Array.isArray(mine.data?.sessionList), mine.data);
    const badMonth = await call("GET", "/reports/monthly?month=2026-13", { token: owner });
    check("bad month is rejected (400)", badMonth.status === 400, badMonth.data);

    section("Public booking surface");
    const info = await call("GET", `/public/${slug}/info`);
    check("public info resolves by slug", info.status === 200 && info.data?.acceptingBookings === true && info.data?.accountType === "CLINIC", info.data);
    const roster = await call("GET", `/public/${slug}/staff`);
    check("public roster lists bookable practitioners", roster.data?.some((x: any) => x.id === therapistId), roster.data);
    const pubServices = await call("GET", `/public/${slug}/services?staffId=${therapistId}`);
    check("public services are the therapist's own", pubServices.data?.some((x: any) => x.clinicServiceId === therapySvc.id && x.serviceCategory === "THERAPY"), pubServices.data);
    const nextTue = nextWeekday(today, 2, 3);
    const pubSlots = await call("GET", `/public/${slug}/slots?date=${nextTue}&staffId=${therapistId}&mode=OFFLINE`);
    check("public slots are available", pubSlots.status === 200 && pubSlots.data.length === 4, pubSlots.data);
    const unknown = await call("GET", `/public/no-such-clinic-${run}/info`);
    check("unknown slug -> 404", unknown.status === 404, unknown);
    const pubBook = await call("POST", "/appointments", {
        body: { slug, staffId: therapistId, patientName: "Arun Kumar", patientEmail: "arun@example.com", patientPhone: "9000033333", appointmentDate: nextTue, startTime: "10:00", sessionType: String(therapySvc.id), mode: "OFFLINE", notes: "First time" },
    });
    check("public booking creates a session awaiting payment", pubBook.status === 200 && pubBook.data?.status === "AWAITING_PAYMENT" && pubBook.data?.fee === 1500, pubBook.data);
    const token = pubBook.data.trackingToken as string;
    const track = await call("GET", `/track/${token}`);
    check("tracking page data loads by token", track.status === 200 && track.data?.patientName === "Arun Kumar", track.data);
    const pay = await call("POST", `/track/${token}/report-payment`, { body: { paymentScreenshotBase64: "data:image/png;base64," + PNG_B64 } });
    check("client reports payment -> under review", pay.data?.status === "PAYMENT_UNDER_REVIEW", pay.data);
    const verify = await call("PATCH", `/appointments/${pubBook.data.id}?status=CONFIRMED`, { token: reception });
    check("front desk verifies and confirms", verify.data?.status === "CONFIRMED", verify.data);
    const lead = await call("POST", `/public/${slug}/leads`, { body: { name: "Lead Person", phone: "9000044444", email: "lead@example.com", notes: "enquiry" } });
    check("enquiry is captured as a lead", lead.status === 200 && lead.data?.status === "NEW", lead.data);
    const leads = await call("GET", "/leads", { token: reception });
    check("leads list shows it to the front desk", leads.data?.some((l: any) => l.phone === "9000044444"), leads.data);

    section("Attachments");
    const up = await call("POST", `/patients/${patientId}/attachments`, { token: therapist, body: { fileName: "scan.png", fileData: "data:image/png;base64," + PNG_B64 } });
    check("attachment uploads", up.status === 200 && up.data?.fileType === "image/png", up.data);
    const down = await call("GET", `/patients/${patientId}/attachments/${up.data.id}/download`, { token: therapist, raw: true });
    check("attachment downloads byte-for-byte", down.status === 200 && (down.data as Buffer).toString("base64") === PNG_B64, down.status);
    const fake = await call("POST", `/patients/${patientId}/attachments`, { token: therapist, body: { fileName: "evil.pdf", fileData: "data:application/pdf;base64," + PNG_B64 } });
    check("a file whose bytes don't match its extension is refused", fake.status === 400, fake.data);

    section("Settings, holidays, bank accounts");
    const hol = await call("POST", "/holidays", { token: owner, body: { holidayDate: nextWeekday(today, 3, 10), reason: "Diwali" } });
    check("holiday added", hol.status === 200, hol.data);
    const bank = await call("POST", "/bank-accounts", { token: owner, body: { accountName: "Clinic HDFC", bankName: "HDFC", isDefault: true } });
    check("bank account created and flagged default (isDefault honoured)", bank.status === 200 && bank.data?.isDefault === true, bank.data);
    const set = await call("PUT", "/settings", { token: owner, body: { clinicName: "Psyfos Clinic", address: "Kochi", contactPhone: "0484" } });
    check("settings saved", set.status === 200 && set.data?.address === "Kochi", set.data);

    section("Super-admin console");
    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
        const adm = await call("POST", "/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
        check("superadmin logs in", adm.status === 200 && adm.data?.role === "ROLE_SUPERADMIN", adm.data);
        const admin = adm.data?.token as string;
        const denied = await call("GET", "/superadmin/tenants", { token: owner });
        check("a tenant cannot reach the console (403)", denied.status === 403, denied);
        const tenants = await call("GET", "/superadmin/tenants", { token: admin });
        const mine2 = tenants.data?.find((x: any) => x.email === email);
        check("tenant list shows the clinic with its staff count", !!mine2 && mine2.accountType === "CLINIC" && mine2.staffCount === 2, mine2);
        const stats = await call("GET", "/superadmin/dashboard/stats", { token: admin });
        check("dashboard stats compute", stats.status === 200 && stats.data?.totalClinics >= 1, stats.data);
        const ov = await call("POST", `/superadmin/tenants/${mine2.id}/subscription`, { token: admin, body: { action: "ACTIVATE", preset: "ONE_YEAR" } });
        check("subscription can be activated for a year", ov.status === 200 && ov.data?.subscriptionStatus === "ACTIVE", ov.data);
        const sus = await call("POST", `/superadmin/tenants/${mine2.id}/subscription`, { token: admin, body: { action: "SUSPEND" } });
        check("suspended tenant is locked", sus.data?.locked === true, sus.data);
        const locked = await call("GET", "/patients", { token: owner });
        check("a locked account gets 402 on the dashboard API", locked.status === 402, locked);
        const lockedStaff = await call("GET", "/me/schedule", { token: therapist });
        check("...and so does its staff", lockedStaff.status === 402, lockedStaff);
        const lockedPublic = await call("POST", "/appointments", { body: { slug, patientName: "Z", patientPhone: "9", appointmentDate: nextTue, startTime: "11:00", sessionType: String(therapySvc.id), staffId: therapistId, mode: "OFFLINE" } });
        check("...and public booking stops accepting new sessions", lockedPublic.status === 409, lockedPublic.data);
        await call("POST", `/superadmin/tenants/${mine2.id}/subscription`, { token: admin, body: { action: "ACTIVATE", preset: "ONE_YEAR" } });
        const reset = await call("POST", `/superadmin/tenants/${mine2.id}/reset-password`, { token: admin, body: { password: "Brand-new-pass-1" } });
        check("password rescue issues a new password", reset.status === 200 && reset.data?.temporaryPassword === "Brand-new-pass-1", reset.data);
        const oldSession = await call("GET", "/auth/me", { token: owner });
        check("...and ends the tenant's existing sessions", oldSession.status === 401, oldSession);
        const relog = await call("POST", "/auth/login", { body: { email, password: "Brand-new-pass-1" } });
        check("...and the new password works", relog.status === 200, relog.data);
    } else {
        console.log("  (skipped: SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD not set)");
    }

    section("Cleanup rules");
    const ownerAgain = (await call("POST", "/auth/login", { body: { email, password: ADMIN_EMAIL ? "Brand-new-pass-1" : "Passw0rd!123" } })).data?.token as string;
    const delAppt = await call("DELETE", `/appointments/${fuApptId}`, { token: ownerAgain });
    check("deleting a booked follow-up session sends the follow-up back to pending", delAppt.status === 204, delAppt);
    const delPatient = await call("DELETE", `/patients/${patientId}`, { token: ownerAgain });
    check("deleting a client removes their whole record", delPatient.status === 204, delPatient);

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        console.log("Failed checks:\n - " + failures.join("\n - "));
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
