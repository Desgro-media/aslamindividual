import { config } from "./config";
import { ApiError } from "./http";

// ── Clinic clock ─────────────────────────────────────────────────────────────
// Dates/times in this system are *wall-clock in the clinic's timezone*
// (java.time.LocalDate / LocalTime / LocalDateTime on the old backend). They
// are carried as strings: "YYYY-MM-DD", "HH:mm:ss", "YYYY-MM-DD HH:mm:ss.SSS".
// Where arithmetic is needed they are mapped onto a UTC `Date` purely as a
// calendar calculator — the zone is never applied twice.

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number }

function clinicParts(at: Date = new Date()): Parts {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: config.timezone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
    });
    const get: Record<string, number> = {};
    for (const p of fmt.formatToParts(at)) {
        if (p.type !== "literal") get[p.type] = Number(p.value);
    }
    return { y: get.year, mo: get.month, d: get.day, h: get.hour, mi: get.minute, s: get.second, ms: at.getMilliseconds() };
}

const p2 = (n: number) => String(n).padStart(2, "0");
const p3 = (n: number) => String(n).padStart(3, "0");

/** Today's date in the clinic's timezone, "YYYY-MM-DD". */
export function today(): string {
    const p = clinicParts();
    return `${p.y}-${p2(p.mo)}-${p2(p.d)}`;
}

/** Minutes since midnight, clinic wall-clock. */
export function nowMinutes(): number {
    const p = clinicParts();
    return p.h * 60 + p.mi;
}

/** Clinic wall-clock timestamp for a `timestamp` column: "YYYY-MM-DD HH:mm:ss.SSS". */
export function nowTs(): string {
    const p = clinicParts();
    return `${p.y}-${p2(p.mo)}-${p2(p.d)} ${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}.${p3(p.ms)}`;
}

/** Clinic wall-clock "now" as a calendar-calculator Date (UTC fields = clinic fields). */
export function nowLdt(): Date {
    return clinicLdtOf(Date.now());
}

/** The clinic wall-clock reading of an absolute instant (epoch ms), as a calculator Date. */
export function clinicLdtOf(epochMs: number): Date {
    const p = clinicParts(new Date(epochMs));
    return new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms));
}

// ── LocalDate ────────────────────────────────────────────────────────────────
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(v: unknown): v is string {
    if (typeof v !== "string") return false;
    const m = DATE_RE.exec(v);
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function parseDate(v: unknown, label = "date"): string {
    if (!isValidDate(v)) throw new ApiError(400, `Invalid value for '${label}'.`);
    return v;
}

export function dateToUtc(date: string): Date {
    const m = DATE_RE.exec(date)!;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

export function utcToDate(d: Date): string {
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

export function addDays(date: string, n: number): string {
    const d = dateToUtc(date);
    d.setUTCDate(d.getUTCDate() + n);
    return utcToDate(d);
}

const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
export function dayOfWeek(date: string): string {
    return DAY_NAMES[dateToUtc(date).getUTCDay()];
}
export const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

export function monthOf(date: string): string {
    return date.slice(0, 7);
}

export function daysInMonth(year: number, month1: number): number {
    return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

// ── LocalTime ────────────────────────────────────────────────────────────────
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/** Minutes since midnight for "H:mm", "HH:mm" or "HH:mm:ss[.fff]"; null if not a time. */
export function timeToMinutes(v: unknown): number | null {
    if (typeof v !== "string") return null;
    const m = TIME_RE.exec(v.trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0;
    if (h > 23 || mi > 59 || s > 59) return null;
    return h * 60 + mi;
}

export function parseTime(v: unknown, label = "time"): string {
    const mins = timeToMinutes(v);
    if (mins === null) throw new ApiError(400, `Invalid value for '${label}'.`);
    return minutesToTime(mins);
}

/** "HH:mm:ss" — how Postgres `time` and Jackson's LocalTime both print a whole minute. */
export function minutesToTime(mins: number): string {
    return `${p2(Math.floor(mins / 60))}:${p2(mins % 60)}:00`;
}

/** "HH:mm" — the format availability blocks and slot lists use. */
export function minutesToHm(mins: number): string {
    return `${p2(Math.floor(mins / 60))}:${p2(mins % 60)}`;
}

// ── LocalDateTime arithmetic (subscription windows) ──────────────────────────
export function ldtParse(s: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s);
    if (!m) throw new Error(`Bad timestamp: ${s}`);
    const ms = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms));
}

export function ldtFormat(d: Date, micros?: number): string {
    const frac = micros !== undefined ? String(micros).padStart(6, "0") : p3(d.getUTCMilliseconds());
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
        `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${frac}`;
}

export function plusDays(d: Date, n: number): Date {
    const r = new Date(d.getTime());
    r.setUTCDate(r.getUTCDate() + n);
    return r;
}

// Calendar-aware like java.time: Jan 31 + 1 month = Feb 28/29, not Mar 2/3.
export function plusMonths(d: Date, n: number): Date {
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
    const year = Math.floor(total / 12);
    const month = total - year * 12;
    const day = Math.min(d.getUTCDate(), daysInMonth(year, month + 1));
    return new Date(Date.UTC(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

export const plusYears = (d: Date, n: number) => plusMonths(d, n * 12);

export function startOfDay(date: string): Date {
    return dateToUtc(date);
}

// ── SessionDurations ─────────────────────────────────────────────────────────
// Single home for "how long is a session" so booking, editing, slot listing
// and availability blocks cannot drift apart. A session's length is never
// stored on its own — it is (endTime - startTime) on the appointment.
export const MIN_SESSION_MINUTES = 15;
export const MAX_SESSION_MINUTES = 240;
export const DEFAULT_SESSION_MINUTES = 60;
const MINUTES_PER_DAY = 24 * 60;

export const isValidSessionMinutes = (m: number) => Number.isInteger(m) && m >= MIN_SESSION_MINUTES && m <= MAX_SESSION_MINUTES;

export function requireValidSessionMinutes(m: number): number {
    if (!isValidSessionMinutes(m)) {
        throw new ApiError(400, `Session length must be between ${MIN_SESSION_MINUTES} and ${MAX_SESSION_MINUTES} minutes`);
    }
    return m;
}

// ClinicService.duration is free text ("50 min", "1 hr", "1.5 hours", "1h30m").
export function parseServiceDuration(text: string | null | undefined): number {
    if (!text || !text.trim()) return DEFAULT_SESSION_MINUTES;
    const s = text.trim().toLowerCase();
    let total = 0;
    let found = false;
    const h = /(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)(?![a-z])/.exec(s);
    if (h) { total += parseFloat(h[1]) * 60; found = true; }
    const m = /(\d+(?:\.\d+)?)\s*(?:minutes|minute|mins|min|m)(?![a-z])/.exec(s);
    if (m) { total += parseFloat(m[1]); found = true; }
    if (!found) {
        const n = /(\d+(?:\.\d+)?)/.exec(s);
        if (n) { total = parseFloat(n[1]); found = true; }
    }
    if (!found) return DEFAULT_SESSION_MINUTES;
    const minutes = Math.round(total);
    return isValidSessionMinutes(minutes) ? minutes : DEFAULT_SESSION_MINUTES;
}

// start + minutes, refusing anything that would run past midnight.
export function endOfSession(startMinute: number, minutes: number): number {
    if (startMinute + minutes >= MINUTES_PER_DAY) {
        throw new ApiError(400, "A session can't run past midnight — choose an earlier start time or a shorter session length.");
    }
    return startMinute + minutes;
}

/** Whole minutes from start to end ("HH:mm[:ss]"); <= 0 for a placeholder row. */
export function minutesBetween(start: string | null | undefined, end: string | null | undefined): number {
    const s = timeToMinutes(start);
    const e = timeToMinutes(end);
    if (s === null || e === null) return 0;
    return e - s;
}

/** Half-open interval overlap — back-to-back sessions do NOT overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
    return aStart < bEnd && bStart < aEnd;
}
