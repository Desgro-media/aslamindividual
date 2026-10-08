// Seeds a ready-to-click demo clinic ("Psyfos Demo Clinic") through the public API —
// no database access needed, so it works against any deployed copy.
//
//   BASE_URL=https://your-app.vercel.app \
//   SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=... \
//   npm run seed:demo
//
// The super-admin login is only used to activate the demo clinic's subscription for a
// year (otherwise the 14-day trial would lock your team out). Safe to re-run: if the
// demo clinic already exists it does nothing.
//
// These accounts have well-known passwords. Keep real client data out of this clinic.

const BASE = (process.env.BASE_URL || "http://localhost:3001").replace(/\/+$/, "") + "/api/v1";
const ADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || "";

const OWNER = { email: "demo-owner@psyfos.test", password: "Passw0rd!123" };
const ASHA = { email: "demo-asha@psyfos.test", password: "Therapist#123" };
const RAVI = { email: "demo-ravi@psyfos.test", password: "Therapist#123" };
const RIYA = { email: "demo-riya@psyfos.test", password: "Reception#123" };

class HttpError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

async function call(method: string, path: string, token?: string | null, body?: unknown): Promise<any> {
    const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new HttpError(res.status, `${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return data;
}

const clinicToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata" }).format(new Date());
const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function main() {
    console.log(`Seeding demo clinic on ${BASE}`);
    const health = await fetch(BASE + "/health").catch(() => null);
    if (!health || !health.ok) throw new Error(`${BASE}/health is not UP (HTTP ${health?.status ?? "no response"}) — fix the deployment first.`);

    const today = clinicToday();

    let O: string;
    try {
        const owner = await call("POST", "/auth/signup", null, {
            name: "Psyfos Demo Clinic", email: OWNER.email, password: OWNER.password,
            phone: "9876500000", accountType: "CLINIC", clinicName: "Psyfos Demo Clinic",
        });
        O = owner.token;
    } catch (e) {
        if (e instanceof HttpError && (e.status === 409 || e.status === 400)) {
            console.log("Demo clinic already exists (or the owner email is taken) — nothing to do.");
            return;
        }
        throw e;
    }

    // Keep the demo clinic unlocked: the self-signup trial is only 14 days.
    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
        const admin = (await call("POST", "/auth/login", null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).token;
        const tenants: any[] = await call("GET", "/superadmin/tenants", admin);
        const mine = tenants.find((t) => String(t.email ?? t.username ?? "").toLowerCase() === OWNER.email);
        if (!mine) throw new Error("Could not find the demo clinic in the super-admin tenant list.");
        await call("POST", `/superadmin/tenants/${mine.id}/subscription`, admin, { action: "ACTIVATE", preset: "ONE_YEAR" });
        console.log("Demo clinic subscription activated for one year.");
    } else {
        console.log("SUPERADMIN_EMAIL/PASSWORD not given — the demo clinic stays on its 14-day trial.");
    }

    const services: any[] = await call("GET", "/services", O);
    const byName = (n: string) => services.find((s) => s.name === n);
    const ind = byName("Individual Therapy"), init = byName("Initial Consultation"), assess = byName("Psychological Assessment"), career = byName("Career & Vocational Guidance");
    for (const [svc, fee] of [[ind, 1500], [init, 800], [assess, 3000], [career, 1000]] as const) {
        await call("PUT", `/services/${svc.id}`, O, { ...svc, fee });
    }

    const asha = await call("POST", "/staff", O, { name: "Dr. Asha Menon", username: ASHA.email, password: ASHA.password, role: "ROLE_PSYCHOLOGIST", jobTitle: "Clinical Psychologist", bookable: true, permissions: [], bio: "CBT and trauma-focused therapy." });
    const ravi = await call("POST", "/staff", O, { name: "Ravi Iyer", username: RAVI.email, password: RAVI.password, role: "ROLE_PSYCHOLOGIST", jobTitle: "Career Counsellor", bookable: true, permissions: [] });
    await call("POST", "/staff", O, { name: "Riya Front Desk", username: RIYA.email, password: RIYA.password, role: "ROLE_RECEPTIONIST", jobTitle: "Front Desk Executive", permissions: ["APPOINTMENTS", "PATIENTS", "BILLING", "ANALYTICS"] });

    const offers: Array<[any, Array<[any, number, number | null]>]> = [
        [asha, [[ind, 1500, 1200], [init, 800, 700], [assess, 3000, null]]],
        [ravi, [[career, 1000, 900], [init, 700, 600]]],
    ];
    for (const [doc, list] of offers) {
        await call("PUT", `/staff/${doc.id}/services`, O, list.map(([svc, off, on]) => ({ clinicServiceId: svc.id, offlineOffered: true, offlinePrice: off, onlineOffered: on !== null, onlinePrice: on ?? 0 })));
        await call("POST", `/staff/${doc.id}/availability-blocks`, O, { daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"], startTime: "09:00", endTime: "17:00", intervalMinutes: 60, mode: "OFFLINE" });
        await call("POST", `/staff/${doc.id}/availability-blocks`, O, { daysOfWeek: ["MONDAY", "WEDNESDAY", "FRIDAY"], startTime: "18:00", endTime: "20:00", intervalMinutes: 60, mode: "ONLINE" });
    }

    const A = (await call("POST", "/auth/login", null, { email: ASHA.email, password: ASHA.password })).token;
    const R = (await call("POST", "/auth/login", null, { email: RIYA.email, password: RIYA.password })).token;

    const clients: Array<[string, string, string | null]> = [
        ["Meera Nair", "9000011111", "meera@example.com"],
        ["Arun Kumar", "9000022222", "arun@example.com"],
        ["Sneha Pillai", "9000033333", "sneha@example.com"],
        ["Joseph Mathew", "9000044444", null],
        ["Fatima Rahman", "9000055555", "fatima@example.com"],
    ];
    const pat: Record<string, number> = {};
    const book = (token: string, c: [string, string, string | null], date: string, time: string, svc: any, staffId: number) =>
        call("POST", "/appointments/manual", token, { patientName: c[0], patientPhone: c[1], patientEmail: c[2] ?? undefined, appointmentDate: date, startTime: time, sessionType: String(svc.id), mode: "OFFLINE", staffId, paymentHandledBy: "RECEPTION" });
    // A slot earlier today may already be in the past when this runs — fall back to tomorrow.
    const bookTodayOrNext = (c: [string, string, string | null], time: string, svc: any, staffId: number) =>
        book(R, c, today, time, svc, staffId).catch(() => book(R, c, addDays(today, 1), time, svc, staffId));

    for (const c of clients) {
        const p = await call("POST", "/patients", O, { name: c[0], phone: c[1], email: c[2] ?? undefined, assignedDoctorId: asha.id });
        pat[c[1]] = p.id;
    }
    for (const [i, c] of clients.entries()) {
        const backs = [28, 21, 14, 7].slice(0, i === 3 ? 1 : i === 4 ? 2 : 4);
        for (const back of backs) {
            await call("POST", "/appointments/past", O, { patientId: pat[c[1]], appointmentDate: addDays(today, -back), startTime: "11:00", sessionType: String(ind.id), staffId: asha.id, status: "COMPLETED", durationMinutes: 50 });
        }
    }

    await bookTodayOrNext(clients[0], "10:00:00", ind, asha.id);
    await bookTodayOrNext(clients[1], "14:00:00", ind, asha.id);
    await book(R, clients[2], addDays(today, 1), "11:00:00", init, asha.id);
    await book(R, clients[4], addDays(today, 2), "15:00:00", assess, asha.id);
    await book(R, clients[3], addDays(today, 1), "10:00:00", career, ravi.id);

    // Wrap up old sessions so every case status (and a pending follow-up) is represented.
    const past: any[] = await call("GET", `/me/schedule?from=${addDays(today, -40)}&to=${addDays(today, -1)}`, A);
    const last = (c: [string, string, string | null]) => past.filter((s) => s.patientId === pat[c[1]]).pop();
    const m = last(clients[0]);
    if (m) await call("POST", `/appointments/${m.id}/complete`, A, {
        note: { subjective: "Feeling calmer; sleeping better.", objective: "Brighter affect, good eye contact.", assessment: "Responding well to CBT for GAD.", plan: "Continue weekly; thought records." },
        caseStatus: "ONGOING", followUp: { date: addDays(today, 3), note: "Review exposure hierarchy" },
    });
    const f = last(clients[4]);
    if (f) await call("POST", `/appointments/${f.id}/complete`, A, { note: { subjective: "Stopped attending after relocation." }, caseStatus: "DROPPED", caseStatusReason: "Moved cities, not reachable" });
    const j = last(clients[3]);
    if (j) await call("POST", `/appointments/${j.id}/complete`, A, { note: { assessment: "Goals met." }, caseStatus: "TERMINATED", caseStatusReason: "Goals achieved" });
    const a = last(clients[1]);
    if (a) await call("POST", `/appointments/${a.id}/complete`, A, { caseStatus: "PERIODIC_FOLLOW_UP", followUp: { date: addDays(today, 1), note: "Monthly check-in" } });

    console.log("\nDone. Demo logins (open the site's /login):");
    for (const [role, u] of [["Clinic owner", OWNER], ["Therapist", ASHA], ["Therapist 2", RAVI], ["Receptionist", RIYA]] as const) {
        console.log(`  ${role.padEnd(13)} ${u.email}  /  ${u.password}`);
    }
    console.log(`  Public booking page: ${BASE.replace("/api/v1", "")}/book/psyfos-demo-clinic`);
}

main().catch((e) => { console.error("\nSeed failed:", e.message); process.exit(1); });
