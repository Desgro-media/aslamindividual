import type { Db } from "../db";
import { badRequest } from "../http";
import { addDays, daysInMonth, today } from "../time";
import { AppUser, CASE_STATUSES } from "../types";
import { myClientPredicate } from "./therapist";

// The Monthly / Management Report, and each therapist's "My Session Reports" —
// the same numbers, the former across the whole clinic, the latter restricted to
// one practitioner's own sessions and clients (and without revenue, which is
// governed by the Billing permission).

const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function monthRange(month: string | null): { month: string; from: string; to: string; lastDay: string; label: string } {
    const m = month ? MONTH_RE.exec(month) : null;
    let y: number, mo: number;
    if (month) {
        if (!m || +m[2] < 1 || +m[2] > 12) throw badRequest("Invalid value for 'month'. Use YYYY-MM.");
        y = +m[1]; mo = +m[2];
    } else {
        const t = today();
        y = +t.slice(0, 4); mo = +t.slice(5, 7);
    }
    const from = `${y}-${String(mo).padStart(2, "0")}-01`;
    const nextY = mo === 12 ? y + 1 : y;
    const nextM = mo === 12 ? 1 : mo + 1;
    const to = `${nextY}-${String(nextM).padStart(2, "0")}-01`; // exclusive
    const lastDay = `${y}-${String(mo).padStart(2, "0")}-${String(daysInMonth(y, mo)).padStart(2, "0")}`;
    const label = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
    return { month: `${y}-${String(mo).padStart(2, "0")}`, from, to, lastDay, label };
}

const ZERO_STATUS = () => Object.fromEntries(CASE_STATUSES.map((s) => [s, 0])) as Record<string, number>;
const CATEGORIES = ["COUNSELLING", "THERAPY", "ASSESSMENT", "CAREER", "OTHER"];

// Appointment rows for the month, with their service category resolved. A
// session_type is normally a service id (as text) but can be a legacy name.
const apptCte = (doctorFilter: boolean) => `
    WITH appt AS (
        SELECT a.*, cs.category AS category, COALESCE(cs.name, a.session_type) AS service_name
          FROM appointment a
          LEFT JOIN clinic_service cs
                 ON cs.id = CASE WHEN a.session_type ~ '^[0-9]{1,18}$' THEN a.session_type::bigint END
                AND cs.psychologist_id = a.psychologist_id
         WHERE a.psychologist_id = $1 AND a.status <> 'DEMO_CALL_PENDING'
           AND a.appointment_date >= $2 AND a.appointment_date < $3
           ${doctorFilter ? "AND a.assigned_doctor_id = $4" : ""}
    )`;

export interface MonthlyReport {
    scope: "CLINIC" | "THERAPIST";
    month: string; label: string; from: string; to: string; generatedAt: string;
    sessions: {
        total: number; completed: number; cancelled: number; upcoming: number; awaitingPayment: number;
        completionRate: number | null; byStatus: Record<string, number>; hours: number;
        byMode: { ONLINE: number; OFFLINE: number };
    };
    clients: { seen: number; newClients: number; registered: number; repeatClients: number; avgSessionsPerClient: number | null };
    caseStatus: { current: Record<string, number>; movedThisMonth: Record<string, number> };
    followUps: { set: number; dueThisMonth: number; completed: number; booked: number; overdueNow: number; adherenceRate: number | null };
    notes: { completedSessions: number; withNotes: number; missing: number; completionRate: number | null };
    byCategory: Array<{ category: string; sessions: number; completed: number; revenue?: number }>;
    topServices: Array<{ name: string; sessions: number }>;
    daily: Array<{ date: string; total: number; completed: number; cancelled: number }>;
    revenue?: {
        collected: number; invoiced: number; outstanding: number; discounts: number;
        byMethod: Array<{ method: string; amount: number }>;
    };
    leads?: { enquiries: number; converted: number; conversionRate: number | null };
    byTherapist?: Array<{
        doctorId: number; name: string; sessions: number; completed: number; cancelled: number; clients: number;
        newClients: number; notesMissing: number; closedCases: number; revenue: number;
    }>;
    sessionList?: Array<{
        id: number; patientId: number; patientName: string; date: string; startTime: string; status: string;
        service: string | null; mode: string; hasNote: boolean; caseStatus: string;
    }>;
}

const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Build the report. `doctor` set => a single therapist's own numbers; otherwise
 * the whole clinic. `includeRevenue` is false for a therapist's own report.
 */
export async function buildMonthlyReport(
    db: Db, tenantId: number, monthParam: string | null, doctor: AppUser | null, includeRevenue: boolean
): Promise<MonthlyReport> {
    const r = monthRange(monthParam);
    const base = [tenantId, r.from, r.to];
    const withDoc = doctor ? [...base, doctor.id] : base;
    const cte = apptCte(!!doctor);
    const todayStr = today();
    // created_at / log timestamps are wall-clock timestamps; the month is a half-open [from, to) date range.
    const fromTs = `${r.from} 00:00:00`;
    const toTs = `${r.to} 00:00:00`;

    // ── Sessions ────────────────────────────────────────────────────────────
    const statusRows = await db.many<{ status: string; n: number }>(`${cte} SELECT status, count(*) AS n FROM appt GROUP BY status`, withDoc);
    const byStatus: Record<string, number> = {};
    statusRows.forEach((s) => (byStatus[s.status] = s.n));
    const completed = byStatus.COMPLETED ?? 0;
    const cancelled = byStatus.CANCELLED ?? 0;
    const total = statusRows.reduce((sum, s) => sum + s.n, 0);
    const awaitingPayment = (byStatus.AWAITING_PAYMENT ?? 0) + (byStatus.PAYMENT_UNDER_REVIEW ?? 0) + (byStatus.PENDING ?? 0);
    const upcoming = (await db.scalar<number>(
        `${cte} SELECT count(*) FROM appt WHERE status IN ('CONFIRMED', 'AWAITING_PAYMENT', 'PAYMENT_UNDER_REVIEW', 'PENDING') AND appointment_date >= '${todayStr}'`, withDoc)) ?? 0;
    const hours = r2(((await db.scalar<number>(
        `${cte} SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (end_time - start_time))), 0) FROM appt WHERE status = 'COMPLETED'`, withDoc)) ?? 0) / 3600);
    const modeRows = await db.many<{ mode: string; n: number }>(
        `${cte} SELECT COALESCE(mode, 'OFFLINE') AS mode, count(*) AS n FROM appt WHERE status <> 'CANCELLED' GROUP BY 1`, withDoc);
    const byMode = { ONLINE: 0, OFFLINE: 0 };
    modeRows.forEach((m) => { if (m.mode === "ONLINE") byMode.ONLINE = m.n; else byMode.OFFLINE += m.n; });

    // ── Clients ─────────────────────────────────────────────────────────────
    const seen = (await db.scalar<number>(`${cte} SELECT count(DISTINCT patient_id) FROM appt WHERE status = 'COMPLETED'`, withDoc)) ?? 0;
    const firstSessionFilter = doctor ? "AND f.assigned_doctor_id = $4" : "";
    const newClients = (await db.scalar<number>(
        `SELECT count(*) FROM (
            SELECT DISTINCT ON (patient_id) patient_id, assigned_doctor_id, appointment_date
              FROM appointment WHERE psychologist_id = $1 AND status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING')
             ORDER BY patient_id, appointment_date, start_time) f
          WHERE f.appointment_date >= $2 AND f.appointment_date < $3 ${firstSessionFilter}`, withDoc)) ?? 0;
    const registered = doctor ? newClients : (await db.scalar<number>(
        "SELECT count(*) FROM patient WHERE primary_psychologist_id = $1 AND created_at >= $2 AND created_at < $3", [tenantId, fromTs, toTs])) ?? 0;
    const repeatClients = (await db.scalar<number>(
        `${cte} SELECT count(*) FROM (SELECT patient_id FROM appt WHERE status = 'COMPLETED' GROUP BY patient_id HAVING count(*) > 1) x`, withDoc)) ?? 0;

    // ── Case status ─────────────────────────────────────────────────────────
    const current = ZERO_STATUS();
    const curRows = doctor
        ? await db.many<{ caseStatus: string; n: number }>(
            `SELECT p.case_status, count(*) AS n FROM patient p WHERE ${myClientPredicate(doctor)} GROUP BY p.case_status`, [tenantId, doctor.id])
        : await db.many<{ caseStatus: string; n: number }>(
            "SELECT case_status, count(*) AS n FROM patient WHERE primary_psychologist_id = $1 GROUP BY case_status", [tenantId]);
    curRows.forEach((c) => (current[c.caseStatus] = c.n));
    const moved = ZERO_STATUS();
    const movedRows = await db.many<{ toStatus: string; n: number }>(
        `SELECT to_status, count(*) AS n FROM case_status_log WHERE psychologist_id = $1 AND created_at >= $2 AND created_at < $3
          ${doctor ? "AND changed_by = $4" : ""} GROUP BY to_status`,
        doctor ? [tenantId, fromTs, toTs, doctor.id] : [tenantId, fromTs, toTs]);
    movedRows.forEach((m) => (moved[m.toStatus] = m.n));
    // A first-time client starts as a New Case — count them under that heading for the month.
    moved.NEW_CASE = newClients;

    // ── Follow-ups ──────────────────────────────────────────────────────────
    const fuDoc = doctor ? "AND doctor_id = $5" : "";
    const fuParams = doctor ? [tenantId, fromTs, toTs, r.from, doctor.id] : [tenantId, fromTs, toTs, r.from];
    const fuNext = r.to;
    const fuStats = await db.one<{ setN: number; due: number; done: number; booked: number }>(
        `SELECT (SELECT count(*) FROM follow_up WHERE psychologist_id = $1 AND created_at >= $2 AND created_at < $3 ${fuDoc}) AS set_n,
                (SELECT count(*) FROM follow_up WHERE psychologist_id = $1 AND due_date >= $4 AND due_date < '${fuNext}'
                    AND status IN ('PENDING', 'BOOKED', 'DONE') ${fuDoc}) AS due,
                (SELECT count(*) FROM follow_up WHERE psychologist_id = $1 AND due_date >= $4 AND due_date < '${fuNext}'
                    AND status = 'DONE' ${fuDoc}) AS done,
                (SELECT count(*) FROM follow_up WHERE psychologist_id = $1 AND due_date >= $4 AND due_date < '${fuNext}'
                    AND status = 'BOOKED' ${fuDoc}) AS booked`, fuParams);
    const overdueNow = (await db.scalar<number>(
        `SELECT count(*) FROM follow_up WHERE psychologist_id = $1 AND status = 'PENDING' AND due_date < '${todayStr}' ${doctor ? "AND doctor_id = $2" : ""}`,
        doctor ? [tenantId, doctor.id] : [tenantId])) ?? 0;

    // ── Notes ───────────────────────────────────────────────────────────────
    const withNotes = (await db.scalar<number>(
        `${cte} SELECT count(*) FROM appt a WHERE a.status = 'COMPLETED' AND EXISTS (SELECT 1 FROM session_note n WHERE n.appointment_id = a.id)`, withDoc)) ?? 0;

    // ── Breakdowns ──────────────────────────────────────────────────────────
    const catRows = await db.many<{ category: string; sessions: number; completed: number }>(
        `${cte} SELECT COALESCE(category, 'OTHER') AS category, count(*) AS sessions,
                       count(*) FILTER (WHERE status = 'COMPLETED') AS completed
                  FROM appt WHERE status <> 'CANCELLED' GROUP BY 1`, withDoc);
    const byCategory = CATEGORIES.map((c) => {
        const row = catRows.find((x) => x.category === c);
        return { category: c, sessions: row?.sessions ?? 0, completed: row?.completed ?? 0 } as MonthlyReport["byCategory"][number];
    });
    const topServices = await db.many<{ name: string; sessions: number }>(
        `${cte} SELECT COALESCE(service_name, 'General') AS name, count(*) AS sessions
                  FROM appt WHERE status <> 'CANCELLED' GROUP BY 1 ORDER BY sessions DESC, name ASC LIMIT 8`, withDoc);
    const daily = await db.many<{ date: string; total: number; completed: number; cancelled: number }>(
        `${cte} SELECT appointment_date AS date, count(*) AS total,
                       count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
                       count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled
                  FROM appt GROUP BY appointment_date ORDER BY appointment_date`, withDoc);

    const report: MonthlyReport = {
        scope: doctor ? "THERAPIST" : "CLINIC",
        month: r.month, label: r.label, from: r.from, to: addDays(r.to, -1), generatedAt: new Date().toISOString(),
        sessions: {
            total, completed, cancelled, upcoming, awaitingPayment, completionRate: rate(completed, completed + cancelled),
            byStatus, hours, byMode,
        },
        clients: { seen, newClients, registered, repeatClients, avgSessionsPerClient: seen > 0 ? r2(completed / seen) : null },
        caseStatus: { current, movedThisMonth: moved },
        followUps: {
            set: fuStats?.setN ?? 0, dueThisMonth: fuStats?.due ?? 0, completed: fuStats?.done ?? 0, booked: fuStats?.booked ?? 0,
            overdueNow, adherenceRate: rate(fuStats?.done ?? 0, fuStats?.due ?? 0),
        },
        notes: { completedSessions: completed, withNotes, missing: Math.max(0, completed - withNotes), completionRate: rate(withNotes, completed) },
        byCategory, topServices, daily,
    };

    // ── Revenue (clinic report only) ────────────────────────────────────────
    if (includeRevenue && !doctor) {
        const collected = (await db.scalar<number>(
            `SELECT COALESCE(SUM(ip.amount), 0) FROM invoice_payment ip JOIN invoice i ON i.id = ip.invoice_id
              WHERE i.psychologist_id = $1 AND ip.paid_at >= $2 AND ip.paid_at < $3`, [tenantId, fromTs, toTs])) ?? 0;
        const byMethod = await db.many<{ method: string; amount: number }>(
            `SELECT COALESCE(ip.payment_method, 'OTHER') AS method, SUM(ip.amount) AS amount
               FROM invoice_payment ip JOIN invoice i ON i.id = ip.invoice_id
              WHERE i.psychologist_id = $1 AND ip.paid_at >= $2 AND ip.paid_at < $3 GROUP BY 1 ORDER BY amount DESC`, [tenantId, fromTs, toTs]);
        const inv = await db.one<{ invoiced: number; discounts: number; outstanding: number }>(
            `${cte} SELECT COALESCE(SUM(i.amount - COALESCE(i.discount_amount, 0)), 0) AS invoiced,
                           COALESCE(SUM(COALESCE(i.discount_amount, 0)), 0) AS discounts,
                           COALESCE(SUM(CASE WHEN i.status IN ('UNPAID', 'PARTIALLY_PAID')
                               THEN GREATEST(i.amount - COALESCE(i.discount_amount, 0)
                                    - COALESCE((SELECT SUM(ip.amount) FROM invoice_payment ip WHERE ip.invoice_id = i.id), 0), 0)
                               ELSE 0 END), 0) AS outstanding
                      FROM appt a JOIN invoice i ON i.appointment_id = a.id WHERE a.status <> 'CANCELLED'`, base);
        report.revenue = {
            collected: r2(collected), invoiced: r2(inv?.invoiced ?? 0), discounts: r2(inv?.discounts ?? 0),
            outstanding: r2(inv?.outstanding ?? 0),
            byMethod: byMethod.map((m) => ({ method: m.method, amount: r2(m.amount) })),
        };
        // Per category revenue = money collected this month against sessions of that category.
        const catRev = await db.many<{ category: string; amount: number }>(
            `SELECT COALESCE(cs.category, 'OTHER') AS category, SUM(ip.amount) AS amount
               FROM invoice_payment ip JOIN invoice i ON i.id = ip.invoice_id JOIN appointment a ON a.id = i.appointment_id
               LEFT JOIN clinic_service cs ON cs.id = CASE WHEN a.session_type ~ '^[0-9]{1,18}$' THEN a.session_type::bigint END
                    AND cs.psychologist_id = a.psychologist_id
              WHERE i.psychologist_id = $1 AND ip.paid_at >= $2 AND ip.paid_at < $3 GROUP BY 1`, [tenantId, fromTs, toTs]);
        report.byCategory = report.byCategory.map((c) => ({ ...c, revenue: r2(catRev.find((x) => x.category === c.category)?.amount ?? 0) }));

        const leadRow = await db.one<{ enquiries: number; converted: number }>(
            `SELECT count(*) AS enquiries, count(*) FILTER (WHERE status = 'CONVERTED') AS converted
               FROM lead WHERE practitioner_id = $1 AND created_at >= $2 AND created_at < $3`, [tenantId, fromTs, toTs]);
        report.leads = {
            enquiries: leadRow?.enquiries ?? 0, converted: leadRow?.converted ?? 0,
            conversionRate: rate(leadRow?.converted ?? 0, leadRow?.enquiries ?? 0),
        };
    }

    // ── Per therapist (clinic report) ───────────────────────────────────────
    if (!doctor) {
        const rows = await db.many<{
            doctorId: number; name: string | null; sessions: number; completed: number; cancelled: number; clients: number;
            notesMissing: number;
        }>(
            `${cte}
             SELECT a.assigned_doctor_id AS doctor_id, u.name, count(*) FILTER (WHERE a.status <> 'CANCELLED') AS sessions,
                    count(*) FILTER (WHERE a.status = 'COMPLETED') AS completed,
                    count(*) FILTER (WHERE a.status = 'CANCELLED') AS cancelled,
                    count(DISTINCT a.patient_id) FILTER (WHERE a.status = 'COMPLETED') AS clients,
                    count(*) FILTER (WHERE a.status = 'COMPLETED'
                        AND NOT EXISTS (SELECT 1 FROM session_note n WHERE n.appointment_id = a.id)) AS notes_missing
               FROM appt a LEFT JOIN app_user u ON u.id = a.assigned_doctor_id
              GROUP BY a.assigned_doctor_id, u.name ORDER BY completed DESC, u.name`, base);
        const firsts = await db.many<{ doctorId: number; n: number }>(
            `SELECT f.assigned_doctor_id AS doctor_id, count(*) AS n FROM (
                SELECT DISTINCT ON (patient_id) patient_id, assigned_doctor_id, appointment_date
                  FROM appointment WHERE psychologist_id = $1 AND status NOT IN ('CANCELLED', 'DEMO_CALL_PENDING')
                 ORDER BY patient_id, appointment_date, start_time) f
              WHERE f.appointment_date >= $2 AND f.appointment_date < $3 GROUP BY 1`, base);
        const closed = await db.many<{ doctorId: number; n: number }>(
            `SELECT changed_by AS doctor_id, count(*) AS n FROM case_status_log
              WHERE psychologist_id = $1 AND created_at >= $2 AND created_at < $3 AND to_status IN ('TERMINATED', 'DROPPED') GROUP BY 1`,
            [tenantId, fromTs, toTs]);
        const revs = includeRevenue ? await db.many<{ doctorId: number; amount: number }>(
            `SELECT a.assigned_doctor_id AS doctor_id, SUM(ip.amount) AS amount
               FROM invoice_payment ip JOIN invoice i ON i.id = ip.invoice_id JOIN appointment a ON a.id = i.appointment_id
              WHERE i.psychologist_id = $1 AND ip.paid_at >= $2 AND ip.paid_at < $3 GROUP BY 1`, [tenantId, fromTs, toTs]) : [];
        report.byTherapist = rows.map((t) => ({
            doctorId: t.doctorId, name: t.name ?? "Unassigned", sessions: t.sessions, completed: t.completed, cancelled: t.cancelled,
            clients: t.clients, newClients: firsts.find((f) => f.doctorId === t.doctorId)?.n ?? 0, notesMissing: t.notesMissing,
            closedCases: closed.find((c) => c.doctorId === t.doctorId)?.n ?? 0,
            revenue: r2(revs.find((x) => x.doctorId === t.doctorId)?.amount ?? 0),
        }));
    }

    // ── A therapist's own session list ──────────────────────────────────────
    if (doctor) {
        report.sessionList = (await db.many<{
            id: number; patientId: number; patientName: string; date: string; startTime: string; status: string;
            service: string | null; mode: string; hasNote: boolean; caseStatus: string;
        }>(
            `${cte}
             SELECT a.id, a.patient_id, p.name AS patient_name, a.appointment_date AS date, a.start_time, a.status,
                    a.service_name AS service, COALESCE(a.mode, 'OFFLINE') AS mode, p.case_status,
                    EXISTS (SELECT 1 FROM session_note n WHERE n.appointment_id = a.id) AS has_note
               FROM appt a JOIN patient p ON p.id = a.patient_id ORDER BY a.appointment_date, a.start_time`, withDoc));
    }
    return report;
}
