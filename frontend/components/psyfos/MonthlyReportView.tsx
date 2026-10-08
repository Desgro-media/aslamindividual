"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  AlertCircle, CalendarClock, ChevronLeft, ChevronRight, Download, FileText, Printer, TrendingUp, UserCheck, Users, Wallet,
} from "lucide-react";
import api from "../../lib/api";
import { CHART, useThemeMode } from "../../lib/chartTheme";
import {
  CASE_STATUS_OPTIONS, SERVICE_CATEGORIES, categoryLabel, errMessage, fmtDay, fmtTime, money, monthOfToday, shiftMonth,
} from "../../lib/psyfos";
import CaseStatusChip from "./CaseStatusChip";
import { ModeBadge, SessionStatusBadge } from "./SessionBits";

// One report component, two uses:
//   /dashboard/reports     — the Monthly / Management Report for the whole clinic
//   /dashboard/my-reports  — a therapist's own "My Session Reports"
// The server decides what each caller may see; this only renders what it gets.

type R = any;

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v}%`);

function Tile({ label, value, sub, color = "var(--text-1)", Icon }: { label: string; value: React.ReactNode; sub?: string; color?: string; Icon?: React.ElementType }) {
  return (
    <div className="soft-card" style={{ padding: "16px 18px", display: "flex", gap: 14, alignItems: "flex-start", breakInside: "avoid" }}>
      {Icon && <Icon style={{ width: 20, height: 20, color, marginTop: 2, flexShrink: 0 }} />}
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: 26, fontWeight: 800, color, letterSpacing: "-0.03em", lineHeight: 1.05 }}>{value}</p>
        <p style={{ fontSize: 11.5, color: "var(--text-3)", fontWeight: 600, marginTop: 4 }}>{label}</p>
        {sub && <p style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>{sub}</p>}
      </div>
    </div>
  );
}

function Panel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="soft-card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14, breakInside: "avoid" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <h3 style={{ fontSize: 14, fontWeight: 800, color: "var(--text-1)" }}>{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function Bar100({ value, total, color }: { value: number; total: number; color: string }) {
  return (
    <div className="meter-track" style={{ height: 8 }}>
      <div className="meter-fill" style={{ width: `${total > 0 ? Math.min(100, (value / total) * 100) : 0}%`, background: color }} />
    </div>
  );
}

function toCsv(r: R): string {
  const rows: (string | number)[][] = [["Section", "Metric", "Value"]];
  const add = (s: string, m: string, v: string | number | null | undefined) => rows.push([s, m, v ?? ""]);
  add("Report", "Scope", r.scope === "CLINIC" ? "Clinic" : "Therapist");
  add("Report", "Month", r.label);
  add("Sessions", "Total", r.sessions.total);
  add("Sessions", "Completed", r.sessions.completed);
  add("Sessions", "Cancelled", r.sessions.cancelled);
  add("Sessions", "Upcoming", r.sessions.upcoming);
  add("Sessions", "Completion rate %", r.sessions.completionRate);
  add("Sessions", "Hours delivered", r.sessions.hours);
  add("Sessions", "Online", r.sessions.byMode.ONLINE);
  add("Sessions", "In-person", r.sessions.byMode.OFFLINE);
  add("Clients", "Seen", r.clients.seen);
  add("Clients", "New clients", r.clients.newClients);
  add("Clients", "Repeat clients", r.clients.repeatClients);
  CASE_STATUS_OPTIONS.forEach(o => {
    add("Session status (now)", o.label, r.caseStatus.current[o.value] ?? 0);
    add("Session status (moved this month)", o.label, r.caseStatus.movedThisMonth[o.value] ?? 0);
  });
  add("Follow-ups", "Set this month", r.followUps.set);
  add("Follow-ups", "Due this month", r.followUps.dueThisMonth);
  add("Follow-ups", "Attended", r.followUps.completed);
  add("Follow-ups", "Overdue now", r.followUps.overdueNow);
  add("Follow-ups", "Adherence %", r.followUps.adherenceRate);
  add("Notes", "Completed sessions", r.notes.completedSessions);
  add("Notes", "With notes", r.notes.withNotes);
  add("Notes", "Missing notes", r.notes.missing);
  r.byCategory.forEach((c: any) => {
    add("Service category", `${categoryLabel(c.category)} — sessions`, c.sessions);
    if (c.revenue !== undefined) add("Service category", `${categoryLabel(c.category)} — revenue`, c.revenue);
  });
  r.topServices.forEach((s: any) => add("Top services", s.name, s.sessions));
  if (r.revenue) {
    add("Revenue", "Collected", r.revenue.collected);
    add("Revenue", "Invoiced", r.revenue.invoiced);
    add("Revenue", "Discounts", r.revenue.discounts);
    add("Revenue", "Outstanding", r.revenue.outstanding);
    r.revenue.byMethod.forEach((m: any) => add("Revenue by method", m.method, m.amount));
  }
  if (r.leads) {
    add("Enquiries", "New", r.leads.enquiries);
    add("Enquiries", "Converted", r.leads.converted);
  }
  (r.byTherapist ?? []).forEach((t: any) => {
    add(`Therapist: ${t.name}`, "Sessions", t.sessions);
    add(`Therapist: ${t.name}`, "Completed", t.completed);
    add(`Therapist: ${t.name}`, "Cancelled", t.cancelled);
    add(`Therapist: ${t.name}`, "Clients", t.clients);
    add(`Therapist: ${t.name}`, "New clients", t.newClients);
    add(`Therapist: ${t.name}`, "Closed cases", t.closedCases);
    add(`Therapist: ${t.name}`, "Notes missing", t.notesMissing);
    add(`Therapist: ${t.name}`, "Revenue", t.revenue);
  });
  (r.sessionList ?? []).forEach((s: any) => add("Session", `${s.date} ${s.startTime.slice(0, 5)} ${s.patientName}`, `${s.status}${s.hasNote ? "" : " (no notes)"}`));
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  return rows.map(r2 => r2.map(esc).join(",")).join("\n");
}

export default function MonthlyReportView({
  endpoint, heading, blurb,
}: { endpoint: string; heading: string; blurb: string }) {
  const [month, setMonth] = useState(monthOfToday());
  const [r, setR] = useState<R | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mode = useThemeMode();
  const c = CHART[mode];

  const load = useCallback(() => {
    setLoading(true); setError("");
    api.get(endpoint, { params: { month } })
      .then(res => setR(res.data))
      .catch(e => { setR(null); setError(errMessage(e, "Couldn't build the report.")); })
      .finally(() => setLoading(false));
  }, [endpoint, month]);
  useEffect(() => { load(); }, [load]);

  const download = () => {
    if (!r) return;
    const blob = new Blob([toCsv(r)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${r.scope === "CLINIC" ? "monthly-report" : "my-session-report"}-${r.month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const dailyData = useMemo(() => (r?.daily ?? []).map((d: any) => ({
    day: d.date.slice(8), completed: d.completed, cancelled: d.cancelled, other: Math.max(0, d.total - d.completed - d.cancelled),
  })), [r]);

  const maxCat = Math.max(1, ...(r?.byCategory ?? []).map((x: any) => x.sessions));
  const closedCases = (r?.caseStatus.movedThisMonth.TERMINATED ?? 0) + (r?.caseStatus.movedThisMonth.DROPPED ?? 0);
  const isClinic = r?.scope === "CLINIC";

  return (
    <div className="anim-fade-up" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body * { visibility: hidden; }
          #report-print, #report-print * { visibility: visible; }
          #report-print { position: absolute; left: 0; top: 0; width: 100%; padding: 12px; }
          .no-print { display: none !important; }
        }
      ` }} />

      <div className="no-print" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-1)", letterSpacing: "-0.03em", marginBottom: 4 }}>{heading}</h1>
          <p style={{ fontSize: 14, color: "var(--text-3)", maxWidth: 640 }}>{blurb}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft style={{ width: 16, height: 16 }} /></button>
          <input type="month" className="nm-input no-icon" value={month} max={monthOfToday()} onChange={e => e.target.value && setMonth(e.target.value)} style={{ width: 210 }} />
          <button type="button" className="icon-btn" aria-label="Next month" disabled={month >= monthOfToday()} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight style={{ width: 16, height: 16 }} /></button>
          <button type="button" className="btn-nm" onClick={download} disabled={!r} style={{ padding: "9px 14px", fontSize: 12, fontWeight: 700, gap: 6 }}><Download style={{ width: 13, height: 13 }} /> CSV</button>
          <button type="button" className="btn-nm" onClick={() => window.print()} disabled={!r} style={{ padding: "9px 14px", fontSize: 12, fontWeight: 700, gap: 6 }}><Printer style={{ width: 13, height: 13 }} /> Print</button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>{[0, 1, 2, 3].map(i => <div key={i} className="skel" style={{ height: 92, borderRadius: 18 }} />)}</div>
      ) : error || !r ? (
        <div className="soft-card" style={{ padding: "48px 20px", textAlign: "center" }}>
          <AlertCircle style={{ width: 36, height: 36, color: "var(--danger)", margin: "0 auto 10px" }} />
          <p style={{ color: "var(--text-2)", fontWeight: 600 }}>{error || "No data."}</p>
          <button className="btn-nm-accent" onClick={load} style={{ marginTop: 14, padding: "9px 20px" }}>Retry</button>
        </div>
      ) : (
        <div id="report-print" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--text-1)" }}>{heading} — {r.label}</h2>
            <p style={{ fontSize: 12, color: "var(--text-3)" }}>{fmtDay(r.from, { day: "numeric", month: "short" })} – {fmtDay(r.to, { day: "numeric", month: "short", year: "numeric" })}</p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
            <Tile Icon={UserCheck} label="Sessions completed" value={r.sessions.completed} color="var(--accent)" sub={`${r.sessions.total} scheduled · ${r.sessions.hours} h delivered`} />
            <Tile Icon={TrendingUp} label="Completion rate" value={pct(r.sessions.completionRate)} color="var(--success)" sub={`${r.sessions.cancelled} cancelled`} />
            <Tile Icon={Users} label="Clients seen" value={r.clients.seen} sub={`${r.clients.newClients} new · ${r.clients.repeatClients} returning`} />
            <Tile Icon={CalendarClock} label="Follow-up adherence" value={pct(r.followUps.adherenceRate)} color={r.followUps.overdueNow ? "var(--warning)" : "var(--success)"} sub={`${r.followUps.overdueNow} overdue now`} />
            {isClinic && r.revenue && <Tile Icon={Wallet} label="Collected" value={money(r.revenue.collected)} color="var(--success)" sub={`${money(r.revenue.outstanding)} outstanding`} />}
            {isClinic && r.leads && <Tile Icon={FileText} label="New enquiries" value={r.leads.enquiries} sub={`${r.leads.converted} booked (${pct(r.leads.conversionRate)})`} />}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18 }}>
            <Panel title="Session status of clients">
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {CASE_STATUS_OPTIONS.map(o => {
                  const now = r.caseStatus.current[o.value] ?? 0;
                  const total = Object.values(r.caseStatus.current as Record<string, number>).reduce((a, b) => a + b, 0);
                  const moved = r.caseStatus.movedThisMonth[o.value] ?? 0;
                  return (
                    <div key={o.value}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                        <CaseStatusChip status={o.value} size="sm" />
                        <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, color: "var(--text-1)" }}>{now}</span>
                        <span style={{ fontSize: 11, color: "var(--text-3)", minWidth: 96, textAlign: "right" }}>
                          {moved > 0 ? `+${moved} this month` : "no change"}
                        </span>
                      </div>
                      <Bar100 value={now} total={total} color={o.color === "var(--text-2)" ? "var(--text-3)" : o.color} />
                    </div>
                  );
                })}
              </div>
              <p style={{ fontSize: 11.5, color: "var(--text-3)" }}>{closedCases} case{closedCases === 1 ? "" : "s"} closed this month (terminated or dropped).</p>
            </Panel>

            <Panel title="Follow-ups">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[
                  ["Set this month", r.followUps.set],
                  ["Due this month", r.followUps.dueThisMonth],
                  ["Attended", r.followUps.completed],
                  ["Booked, upcoming", r.followUps.booked],
                ].map(([k, v]) => (
                  <div key={k as string} className="soft-card-2" style={{ borderRadius: 14, padding: "12px 14px" }}>
                    <p style={{ fontSize: 22, fontWeight: 800, color: "var(--text-1)" }}>{v}</p>
                    <p style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 600 }}>{k}</p>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                  <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Session notes written</span>
                  <span style={{ color: "var(--text-1)", fontWeight: 800 }}>{r.notes.withNotes}/{r.notes.completedSessions} · {pct(r.notes.completionRate)}</span>
                </div>
                <Bar100 value={r.notes.withNotes} total={r.notes.completedSessions} color={r.notes.missing ? "var(--warning)" : "var(--success)"} />
                {r.notes.missing > 0 && <p style={{ fontSize: 11.5, color: "var(--warning)", marginTop: 6 }}>{r.notes.missing} completed session{r.notes.missing === 1 ? "" : "s"} still need notes.</p>}
              </div>
            </Panel>
          </div>

          <Panel title="Sessions per day"
            right={<span style={{ fontSize: 11, color: "var(--text-3)", display: "flex", gap: 12 }}>
              <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: c.accent, marginRight: 5 }} />Completed</span>
              <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: c.dim, marginRight: 5 }} />Other</span>
              <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: c.status.CANCELLED, marginRight: 5 }} />Cancelled</span>
            </span>}>
            {dailyData.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--text-3)", padding: "20px 0" }}>No sessions in {r.label}.</p>
            ) : (
              <div style={{ width: "100%", height: 230 }}>
                <ResponsiveContainer>
                  <BarChart data={dailyData} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                    <CartesianGrid stroke={c.grid} vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: c.axisText, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fill: c.axisText, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: c.cursor }} contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 12, fontSize: 12 }} />
                    <Bar dataKey="completed" name="Completed" stackId="a" fill={c.accent} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="other" name="Other" stackId="a" fill={c.dim} />
                    <Bar dataKey="cancelled" name="Cancelled" stackId="a" fill={c.status.CANCELLED} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18 }}>
            <Panel title="By service category">
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {SERVICE_CATEGORIES.map(cat => {
                  const row = r.byCategory.find((x: any) => x.category === cat.value);
                  const n = row?.sessions ?? 0;
                  return (
                    <div key={cat.value}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 5 }}>
                        <span style={{ fontWeight: 700, color: "var(--text-1)" }}>{cat.label}</span>
                        <span style={{ color: "var(--text-2)" }}>
                          <strong style={{ color: "var(--text-1)" }}>{n}</strong> session{n === 1 ? "" : "s"}
                          {row?.revenue !== undefined && <> · {money(row.revenue)}</>}
                        </span>
                      </div>
                      <Bar100 value={n} total={maxCat} color="var(--accent)" />
                    </div>
                  );
                })}
              </div>
            </Panel>
            <Panel title="Most booked services">
              {r.topServices.length === 0 ? <p style={{ fontSize: 13, color: "var(--text-3)" }}>Nothing booked this month.</p> : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {r.topServices.map((s: any, i: number) => (
                    <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
                      <span style={{ width: 22, color: "var(--text-3)", fontWeight: 700 }}>{i + 1}</span>
                      <span style={{ flex: 1, color: "var(--text-1)", fontWeight: 600 }}>{s.name}</span>
                      <strong style={{ color: "var(--text-1)" }}>{s.sessions}</strong>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 18, marginTop: 6, fontSize: 12, color: "var(--text-2)" }}>
                    <span>In-person: <strong>{r.sessions.byMode.OFFLINE}</strong></span>
                    <span>Online: <strong>{r.sessions.byMode.ONLINE}</strong></span>
                  </div>
                </div>
              )}
            </Panel>
          </div>

          {isClinic && r.revenue && (
            <Panel title="Revenue">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                {[
                  ["Collected this month", money(r.revenue.collected), "var(--success)"],
                  ["Invoiced (this month's sessions)", money(r.revenue.invoiced), "var(--text-1)"],
                  ["Discounts given", money(r.revenue.discounts), "var(--text-1)"],
                  ["Still outstanding", money(r.revenue.outstanding), r.revenue.outstanding ? "var(--warning)" : "var(--text-1)"],
                ].map(([k, v, col]) => (
                  <div key={k as string} className="soft-card-2" style={{ borderRadius: 14, padding: "12px 14px" }}>
                    <p style={{ fontSize: 20, fontWeight: 800, color: col as string }}>{v}</p>
                    <p style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 600, marginTop: 2 }}>{k}</p>
                  </div>
                ))}
              </div>
              {r.revenue.byMethod.length > 0 && (
                <p style={{ fontSize: 12, color: "var(--text-2)" }}>
                  By method: {r.revenue.byMethod.map((m: any) => `${m.method.replace("_", " ").toLowerCase()} ${money(m.amount)}`).join(" · ")}
                </p>
              )}
            </Panel>
          )}

          {isClinic && r.byTherapist && (
            <Panel title="By therapist">
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ width: "100%", textAlign: "left", fontSize: 13, borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["Therapist", "Sessions", "Completed", "Cancelled", "Clients", "New", "Closed", "Notes missing", ...(r.revenue ? ["Collected"] : [])].map((h, i) => (
                      <th key={h} style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {r.byTherapist.length === 0 && <tr><td colSpan={9} style={{ padding: 20, textAlign: "center", color: "var(--text-3)" }}>No sessions this month.</td></tr>}
                    {r.byTherapist.map((t: any) => (
                      <tr key={t.doctorId} style={{ borderTop: "1px solid var(--glass-border-dim)" }}>
                        <td style={{ padding: "11px 12px", fontWeight: 700, color: "var(--text-1)" }}>{t.name}</td>
                        {[t.sessions, t.completed, t.cancelled, t.clients, t.newClients, t.closedCases].map((v, i) => <td key={i} style={{ padding: "11px 12px", textAlign: "right", color: "var(--text-2)" }}>{v}</td>)}
                        <td style={{ padding: "11px 12px", textAlign: "right", color: t.notesMissing ? "var(--warning)" : "var(--text-2)", fontWeight: t.notesMissing ? 700 : 400 }}>{t.notesMissing}</td>
                        {r.revenue && <td style={{ padding: "11px 12px", textAlign: "right", fontWeight: 700, color: "var(--text-1)" }}>{money(t.revenue)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {!isClinic && r.sessionList && (
            <Panel title={`My sessions in ${r.label}`}>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ width: "100%", textAlign: "left", fontSize: 13, borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["Date", "Client", "Service", "Mode", "Status", "Session status", "Notes"].map(h => (
                      <th key={h} style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {r.sessionList.length === 0 && <tr><td colSpan={7} style={{ padding: 20, textAlign: "center", color: "var(--text-3)" }}>No sessions this month.</td></tr>}
                    {r.sessionList.map((s: any) => (
                      <tr key={s.id} style={{ borderTop: "1px solid var(--glass-border-dim)" }}>
                        <td style={{ padding: "10px 12px", color: "var(--text-2)", whiteSpace: "nowrap" }}>{fmtDay(s.date)} · {fmtTime(s.startTime)}</td>
                        <td style={{ padding: "10px 12px", fontWeight: 700, color: "var(--text-1)" }}>{s.patientName}</td>
                        <td style={{ padding: "10px 12px", color: "var(--text-2)" }}>{s.service ?? "General"}</td>
                        <td style={{ padding: "10px 12px" }}><ModeBadge mode={s.mode} /></td>
                        <td style={{ padding: "10px 12px" }}><SessionStatusBadge status={s.status} /></td>
                        <td style={{ padding: "10px 12px" }}><CaseStatusChip status={s.caseStatus} size="sm" /></td>
                        <td style={{ padding: "10px 12px", color: s.status === "COMPLETED" && !s.hasNote ? "var(--warning)" : "var(--text-2)", fontWeight: 600 }}>
                          {s.status === "COMPLETED" ? (s.hasNote ? "Saved" : "Missing") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
