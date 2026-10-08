// Shared vocabulary of the Psyfos workflow: the five session (case) statuses,
// the service categories, date helpers, and the API response shapes the
// Schedule / My Clients / Follow-up / Reports screens share.

export type CaseStatus = "NEW_CASE" | "ONGOING" | "PERIODIC_FOLLOW_UP" | "TERMINATED" | "DROPPED";

export interface CaseStatusOption {
  value: CaseStatus;
  label: string;
  hint: string;
  /** text colour, soft background, soft border — all theme variables so dark mode follows */
  color: string;
  bg: string;
  brd: string;
  /** still in care, so a next follow-up makes sense */
  open: boolean;
}

export const CASE_STATUS_OPTIONS: CaseStatusOption[] = [
  { value: "NEW_CASE",           label: "New Case",           hint: "First sessions — assessment and intake", color: "var(--accent)",  bg: "var(--accent-surface)", brd: "var(--accent-border)", open: true },
  { value: "ONGOING",            label: "Ongoing",            hint: "Regular sessions in progress",           color: "var(--success)", bg: "var(--success-bg)",     brd: "var(--success-brd)",   open: true },
  { value: "PERIODIC_FOLLOW_UP", label: "Periodic Follow-up", hint: "Spaced check-ins (monthly / quarterly)", color: "#0e7490",        bg: "rgba(6,182,212,0.12)",  brd: "rgba(6,182,212,0.28)", open: true },
  { value: "TERMINATED",         label: "Terminated",         hint: "Treatment completed or closed",          color: "var(--text-2)",  bg: "var(--card-2)",         brd: "var(--card-border)",   open: false },
  { value: "DROPPED",            label: "Dropped",            hint: "Client stopped attending",               color: "var(--danger)",  bg: "var(--danger-bg)",      brd: "var(--danger-brd)",    open: false },
];

export const caseStatusMeta = (v?: string | null): CaseStatusOption =>
  CASE_STATUS_OPTIONS.find(o => o.value === v) ?? CASE_STATUS_OPTIONS[0];

export const SERVICE_CATEGORIES = [
  { value: "COUNSELLING", label: "Counselling" },
  { value: "THERAPY",     label: "Therapy" },
  { value: "ASSESSMENT",  label: "Assessment" },
  { value: "CAREER",      label: "Career" },
  { value: "OTHER",       label: "Other" },
] as const;

export const categoryLabel = (v?: string | null) =>
  SERVICE_CATEGORIES.find(c => c.value === v)?.label ?? "Other";

// ── Dates ────────────────────────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, "0");

/** Local-timezone YYYY-MM-DD (toISOString() is UTC and reports yesterday until 05:30 IST). */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + n);
  return localDate(d);
}

export function monthOfToday(): string {
  return localDate().slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}

export const hm = (t?: string | null) => (t ? t.slice(0, 5) : "");

export function fmtTime(t?: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  return `${h % 12 === 0 ? 12 : h % 12}:${p2(m)} ${suffix}`;
}

export function fmtDay(date?: string | null, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }): string {
  if (!date) return "—";
  return new Date(date + "T00:00:00").toLocaleDateString("en-IN", opts);
}

export function fmtDayLong(date?: string | null): string {
  return fmtDay(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function relativeDay(date: string, today = localDate()): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  if (date === addDays(today, -1)) return "Yesterday";
  return fmtDay(date);
}

export const money = (n?: number | null) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n ?? 0);

export function errMessage(e: any, fallback: string): string {
  const m = e?.response?.data?.message;
  return typeof m === "string" && m.trim() ? m : fallback;
}

// ── API shapes ───────────────────────────────────────────────────────────────

export interface Therapist {
  id: number; name: string | null; jobTitle: string | null; bio: string | null;
  profileImageUrl: string | null; bookable: boolean; isOwner: boolean;
}

export interface ServiceOption {
  serviceId: number; name: string; description: string | null; duration: string; icon: string | null; category: string;
  therapists: Array<{
    id: number; name: string | null; jobTitle: string | null; profileImageUrl: string | null;
    onlineOffered: boolean; offlineOffered: boolean; onlinePrice: number | null; offlinePrice: number | null;
  }>;
}

export type FollowUpBucket = "OVERDUE" | "TODAY" | "UPCOMING" | "BOOKED" | "DONE" | "CANCELLED";

export interface FollowUp {
  id: number; patientId: number; patientName: string; patientPhone: string; patientCaseStatus: CaseStatus;
  doctorId: number | null; doctorName: string | null; sourceAppointmentId: number | null;
  dueDate: string; dueTime: string | null; note: string | null; status: "PENDING" | "BOOKED" | "DONE" | "CANCELLED";
  bucket: FollowUpBucket; appointmentId: number | null; appointmentStatus: string | null;
  appointmentDate: string | null; appointmentStartTime: string | null; sessionType: string | null; mode: string | null;
  createdAt: string | null;
}

export interface AppointmentLite {
  id: number; patientId: number; patientName: string; patientEmail?: string | null; patientPhone: string;
  patientCaseStatus?: CaseStatus; appointmentDate: string; startTime: string; endTime: string; status: string;
  sessionType?: string | null; mode?: string; notes?: string | null; trackingToken: string;
  assignedDoctorId: number; assignedDoctorName?: string | null; returningPatient?: boolean; fee?: number | null;
}
