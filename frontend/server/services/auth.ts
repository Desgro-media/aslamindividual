import type { Db } from "../db";
import { tx } from "../db";
import { JsonObject, badRequest, notBlank, optStr, requiredEmail } from "../http";
import { authenticateCredentials, hashPassword } from "../security/auth";
import { parsePermissions } from "../security/guards";
import { signToken } from "../security/jwt";
import { nowLdt, ldtFormat, plusDays } from "../time";
import { AppUser } from "../types";
import { recordLogin } from "./staff";

const TRIAL_DAYS = 14;

export interface AuthResponse {
    token: string | null;
    type: string;
    id: number;
    username: string;
    name: string | null;
    slug: string | null;
    jobTitle: string | null;
    role: string;
    phone: string | null;
    accountType: string | null;
    tenantId: number | null;
    permissions: string[];
}

export function buildAuthResponse(u: AppUser, token: string | null): AuthResponse {
    return {
        token, type: "Bearer", id: u.id, username: u.username, name: u.name, slug: u.slug, jobTitle: u.jobTitle,
        role: u.role, phone: u.phone, accountType: u.accountType, tenantId: u.tenantId,
        permissions: parsePermissions(u.permissions),
    };
}

// Default service catalogue every new account starts with — each tagged with
// the category the Psyfos booking flow groups services by.
const DEFAULT_SERVICES: Array<[string, string, string, string, string, string]> = [
    // name, description, duration, icon, category, (unused)
    ["Initial Consultation", "First-time assessment to understand your needs, history, and goals.", "50 min", "Sparkles", "COUNSELLING", ""],
    ["Individual Therapy", "One-on-one sessions for personal growth, trauma recovery, and coping skills.", "50 min", "Brain", "THERAPY", ""],
    ["Psychological Assessment", "Comprehensive evaluation including IQ, personality, learning disability, and diagnostic testing.", "90 min", "ClipboardList", "ASSESSMENT", ""],
    ["Couples Counseling", "Improve communication, resolve conflicts, and strengthen your relationship.", "80 min", "Heart", "COUNSELLING", ""],
    ["Family Therapy", "Help families improve communication and resolve conflicts, including parent-child issues.", "80 min", "Home", "THERAPY", ""],
    ["Group Therapy", "Therapy with others facing similar challenges — anxiety, grief, addiction, and social skills.", "90 min", "Users", "THERAPY", ""],
    ["Child & Adolescent Therapy", "Support for children and teens with behavioral issues, ADHD, anxiety, and developmental concerns.", "50 min", "Baby", "THERAPY", ""],
    ["CBT Session", "Cognitive Behavioral Therapy to identify and change unhelpful thinking and behavior patterns.", "50 min", "Repeat", "THERAPY", ""],
    ["Crisis Intervention", "Immediate support during emergencies — suicidal thoughts, trauma, grief, or abuse.", "60 min", "AlertCircle", "COUNSELLING", ""],
    ["Career & Vocational Guidance", "Career counseling, aptitude testing, and job-related stress management.", "50 min", "Briefcase", "CAREER", ""],
    ["Follow-Up Session", "Ongoing follow-up to review progress and adjust your treatment plan.", "30 min", "RefreshCw", "OTHER", ""],
    ["Other / Unsure", "Not sure what you need? Book and we'll guide you to the right service.", "Flexible", "HelpCircle", "OTHER", ""],
];

async function generateUniqueSlug(db: Db, name: string): Promise<string> {
    let base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (!base.trim()) base = "practitioner";
    let candidate = base;
    let suffix = 1;
    while (await db.one("SELECT 1 FROM app_user WHERE slug = $1", [candidate])) {
        suffix += 1;
        candidate = `${base}-${suffix}`;
    }
    return candidate;
}

/**
 * Every freelancer/clinic creates their own tenant-root account here — there is
 * no admin who provisions accounts for anyone else. Clinic STAFF accounts are
 * created by their clinic admin (see staff.ts) and never sign up here.
 */
export async function signup(body: JsonObject): Promise<AuthResponse> {
    const name = notBlank(body, "name");
    const emailRaw = requiredEmail(body, "email");
    const password = notBlank(body, "password");
    if (password.length < 8) throw badRequest("Password must be at least 8 characters");
    const phone = notBlank(body, "phone", 30);
    const accountTypeRaw = optStr(body, "accountType");
    const clinicNameRaw = optStr(body, "clinicName", 150);

    const email = emailRaw.trim().toLowerCase();
    return tx(async (db) => {
        if (await db.one("SELECT 1 FROM app_user WHERE username = $1", [email])) {
            throw badRequest("An account with this email already exists");
        }
        const accountType = accountTypeRaw && accountTypeRaw.toUpperCase() === "CLINIC" ? "CLINIC" : "INDIVIDUAL";
        const user = await db.insert<AppUser>("app_user", {
            username: email,
            password: await hashPassword(password),
            name: name.trim(),
            phone: phone.trim(),
            slug: await generateUniqueSlug(db, name),
            accountType,
            role: "ROLE_PSYCHOLOGIST",
            bookable: true,
            enabled: true,
        });

        const clinicName = accountType === "CLINIC" && clinicNameRaw && clinicNameRaw.trim() ? clinicNameRaw.trim() : null;
        // Every new account starts with its own copy of the default service
        // catalog and an empty practice-settings row, scoped to that account only.
        await db.insert("clinic_settings", { psychologistId: user.id, doctorName: user.name, clinicName });
        let order = 1;
        for (const [svcName, description, duration, icon, category] of DEFAULT_SERVICES) {
            await db.insert("clinic_service", {
                psychologistId: user.id, name: svcName, description, duration, fee: 0, icon, category, displayOrder: order++, active: true,
            });
        }
        // New signups start a 14-day trial. CLINIC is ₹9,999/year, INDIVIDUAL ₹4,999/year.
        const now = nowLdt();
        const isClinic = accountType === "CLINIC";
        await db.insert("subscription", {
            psychologistId: user.id, status: "TRIALING",
            trialStartDate: ldtFormat(now), trialEndDate: ldtFormat(plusDays(now, TRIAL_DAYS)),
            plan: isClinic ? "CLINIC_ANNUAL" : "INDIVIDUAL_ANNUAL", amount: isClinic ? 9999 : 4999,
        });
        return buildAuthResponse(user, await signToken(user.username, user.role));
    });
}

export async function login(db: Db, body: JsonObject): Promise<AuthResponse> {
    const email = notBlank(body, "email");
    const password = notBlank(body, "password");
    const user = await authenticateCredentials(db, email.trim().toLowerCase(), password);
    // Only ever records for clinic staff (tenantId set) — no-ops for tenant roots/superadmin.
    await recordLogin(db, user);
    return buildAuthResponse(user, await signToken(user.username, user.role));
}

export async function updatePhone(db: Db, user: AppUser, body: JsonObject): Promise<AuthResponse> {
    const phone = notBlank(body, "phone", 30);
    const updated = await db.update<AppUser>("app_user", user.id, { phone: phone.trim() });
    return buildAuthResponse(updated, null);
}
