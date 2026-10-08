"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Activity, AlertCircle, CalendarClock, ChevronDown, ChevronUp, ExternalLink, FileText, FolderOpen, Search, Stethoscope,
} from "lucide-react";
import api from "../../../lib/api";
import { CaseStatus, caseStatusMeta, errMessage, fmtDay, fmtDayLong, fmtTime, relativeDay } from "../../../lib/psyfos";
import CaseStatusChip from "../../../components/psyfos/CaseStatusChip";
import CaseStatusModal from "../../../components/psyfos/CaseStatusModal";
import SetFollowUpModal from "../../../components/psyfos/SetFollowUpModal";
import { ModeBadge, SessionStatusBadge, useServiceNames } from "../../../components/psyfos/SessionBits";

// Therapist flow: "Open Client Profile → View Case History / Previous Notes".
// One timeline per client — every session with its notes, every change of
// session status, and every follow-up — newest first.

type ClientRow = { id: number; name: string; phone?: string | null; caseStatus: CaseStatus; riskFlag?: boolean };

type TimelineEvent =
  | { kind: "session"; at: string; s: any }
  | { kind: "status"; at: string; l: any }
  | { kind: "followup"; at: string; f: any };

function CaseHistoryView() {
  const params = useSearchParams();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [selected, setSelected] = useState<number | null>(() => {
    const raw = params.get("patient");
    return raw ? Number(raw) : null;
  });
  const [history, setHistory] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [statusModal, setStatusModal] = useState(false);
  const [followModal, setFollowModal] = useState(false);
  const serviceName = useServiceNames();

  const loadClients = useCallback(() => {
    let staffDoctor = false;
    try {
      const u = JSON.parse(localStorage.getItem("user") || "null");
      staffDoctor = !!u?.tenantId && u?.role === "ROLE_PSYCHOLOGIST";
    } catch { /* clinic-wide list */ }
    api.get(staffDoctor ? "/me/clients" : "/patients")
      .then(r => setClients((r.data ?? []).map((c: any) => ({ id: c.id, name: c.name, phone: c.phone, caseStatus: c.caseStatus ?? "NEW_CASE", riskFlag: c.riskFlag }))))
      .catch(() => setClients([]))
      .finally(() => setLoadingList(false));
  }, []);
  useEffect(() => { loadClients(); }, [loadClients]);

  const loadHistory = useCallback((id: number) => {
    setLoading(true); setError("");
    api.get(`/me/case-history/${id}`)
      .then(r => { setHistory(r.data); setOpen({}); })
      .catch(e => { setHistory(null); setError(errMessage(e, "Couldn't load this client's history.")); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (selected) loadHistory(selected); }, [selected, loadHistory]);

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return clients
      .filter(c => statusFilter === "ALL" || c.caseStatus === statusFilter)
      .filter(c => !query || c.name.toLowerCase().includes(query) || (c.phone ?? "").includes(query));
  }, [clients, q, statusFilter]);

  const events: TimelineEvent[] = useMemo(() => {
    if (!history) return [];
    const list: TimelineEvent[] = [
      ...history.sessions.map((s: any) => ({ kind: "session" as const, at: `${s.appointmentDate}T${s.startTime}`, s })),
      ...history.statusLog.map((l: any) => ({ kind: "status" as const, at: l.createdAt ?? "", l })),
      ...history.followUps.map((f: any) => ({ kind: "followup" as const, at: f.createdAt ?? "", f })),
    ];
    return list.sort((a, b) => b.at.localeCompare(a.at));
  }, [history]);

  const p = history?.patient;
  const done = history?.sessions.filter((s: any) => s.status === "COMPLETED") ?? [];
  const openFollowUp = history?.followUps.find((f: any) => f.status === "PENDING" || f.status === "BOOKED");

  return (
    <div className="anim-fade-up" style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)", gap: 22, alignItems: "start" }}>
      {/* Client picker */}
      <div className="soft-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, position: "sticky", top: 0, maxHeight: "calc(100vh - 150px)" }}>
        <div style={{ position: "relative" }}>
          <Search style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--text-3)", zIndex: 1, pointerEvents: "none" }} />
          <input className="nm-input" style={{ paddingLeft: 40 }} placeholder="Find a client…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className="nm-input no-icon" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="ALL">All session statuses</option>
          {["NEW_CASE", "ONGOING", "PERIODIC_FOLLOW_UP", "TERMINATED", "DROPPED"].map(s => <option key={s} value={s}>{caseStatusMeta(s).label}</option>)}
        </select>
        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, minHeight: 80 }}>
          {loadingList ? [0, 1, 2, 3].map(i => <div key={i} className="skel" style={{ height: 52, borderRadius: 14 }} />) :
            shown.length === 0 ? <p style={{ fontSize: 13, color: "var(--text-3)", padding: 10 }}>No clients match.</p> :
            shown.map(c => (
              <button key={c.id} type="button" onClick={() => setSelected(c.id)}
                style={{
                  textAlign: "left", padding: "10px 12px", borderRadius: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
                  border: `1.5px solid ${selected === c.id ? "var(--accent)" : "transparent"}`,
                  background: selected === c.id ? "var(--accent-surface)" : "var(--card-2)",
                }}>
                <div className="team-avatar" style={{ width: 34, height: 34, borderRadius: "50%", fontSize: 14, flexShrink: 0 }}>{c.name.charAt(0).toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.riskFlag && "🚨 "}{c.name}
                  </p>
                  <CaseStatusChip status={c.caseStatus} size="sm" />
                </div>
              </button>
            ))}
        </div>
      </div>

      {/* Timeline */}
      <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
        {!selected ? (
          <div className="soft-card" style={{ padding: "70px 20px", textAlign: "center" }}>
            <FolderOpen style={{ width: 42, height: 42, color: "var(--text-3)", margin: "0 auto 12px" }} />
            <p style={{ color: "var(--text-2)", fontWeight: 700 }}>Choose a client to read their case history</p>
            <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>Sessions, notes, status changes and follow-ups in one timeline.</p>
          </div>
        ) : loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 110, borderRadius: 18 }} />)}</div>
        ) : error ? (
          <div className="soft-card" style={{ padding: "48px 20px", textAlign: "center" }}>
            <AlertCircle style={{ width: 36, height: 36, color: "var(--danger)", margin: "0 auto 10px" }} />
            <p style={{ color: "var(--text-2)", fontWeight: 600 }}>{error}</p>
          </div>
        ) : p ? (
          <>
            {/* Header */}
            <div className="soft-card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <div className="team-avatar" style={{ width: 54, height: 54, borderRadius: "50%", fontSize: 22 }}>{p.name.charAt(0).toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--text-1)", letterSpacing: "-0.02em" }}>{p.name}</h2>
                  <p style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 2 }}>{p.phone}{p.email ? ` · ${p.email}` : ""}</p>
                </div>
                <CaseStatusChip status={p.caseStatus} />
                <button type="button" className="btn-nm" onClick={() => setStatusModal(true)} style={{ padding: "8px 14px", fontSize: 12, fontWeight: 700, gap: 6 }}>
                  <Activity style={{ width: 13, height: 13, color: "var(--accent)" }} /> Update status
                </button>
                <Link href={`/dashboard/patients/${p.id}`} className="btn-nm" style={{ padding: "8px 14px", fontSize: 12, fontWeight: 700, gap: 6, textDecoration: "none", color: "var(--text-1)" }}>
                  <ExternalLink style={{ width: 13, height: 13, color: "var(--accent)" }} /> Full profile
                </Link>
              </div>
              {p.riskFlag && (
                <p style={{ fontSize: 13, color: "var(--danger)", background: "var(--danger-bg)", padding: "9px 14px", borderRadius: 12, fontWeight: 600 }}>
                  🚨 High risk{p.riskReason ? ` — ${p.riskReason}` : ""}
                </p>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                {[
                  ["Sessions completed", String(done.length)],
                  ["Client since", p.createdAt ? fmtDay(p.createdAt.slice(0, 10), { day: "numeric", month: "short", year: "numeric" }) : "—"],
                  ["Last session", done.length ? fmtDay(done[0].appointmentDate) : "—"],
                  ["Next follow-up", openFollowUp ? `${relativeDay(openFollowUp.appointmentDate ?? openFollowUp.dueDate)}${openFollowUp.status === "PENDING" ? " (to book)" : ""}` : "None set"],
                ].map(([k, v]) => (
                  <div key={k} className="soft-card-2" style={{ borderRadius: 14, padding: "12px 14px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{k}</p>
                    <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text-1)", marginTop: 3 }}>{v}</p>
                  </div>
                ))}
              </div>
              {!openFollowUp && caseStatusMeta(p.caseStatus).open && (
                <div>
                  <button type="button" className="btn-nm" onClick={() => setFollowModal(true)} style={{ padding: "8px 14px", fontSize: 12, fontWeight: 700, gap: 6 }}>
                    <CalendarClock style={{ width: 13, height: 13, color: "var(--accent)" }} /> Schedule next follow-up
                  </button>
                </div>
              )}
            </div>

            {/* Events */}
            {events.length === 0 ? (
              <div className="soft-card" style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-3)" }}>No history recorded yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 0, position: "relative", paddingLeft: 26 }}>
                <div style={{ position: "absolute", left: 8, top: 8, bottom: 8, width: 2, background: "var(--card-border)", borderRadius: 2 }} />
                {events.map((ev, idx) => {
                  const dot = (color: string) => (
                    <span style={{ position: "absolute", left: -23, top: 22, width: 12, height: 12, borderRadius: "50%", background: color, border: "3px solid var(--bg)" }} />
                  );
                  if (ev.kind === "status") {
                    const l = ev.l;
                    return (
                      <div key={`l${l.id}`} style={{ position: "relative", padding: "6px 0" }}>
                        {dot(caseStatusMeta(l.toStatus).color)}
                        <div className="soft-card-2" style={{ borderRadius: 14, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
                          <Activity style={{ width: 14, height: 14, color: "var(--accent)" }} />
                          <span style={{ color: "var(--text-2)" }}>Session status</span>
                          {l.fromStatus && <><CaseStatusChip status={l.fromStatus} size="sm" /><span style={{ color: "var(--text-3)" }}>→</span></>}
                          <CaseStatusChip status={l.toStatus} size="sm" />
                          <span style={{ color: "var(--text-3)", marginLeft: "auto", fontSize: 11.5 }}>
                            {l.changedByName ? `${l.changedByName} · ` : ""}{l.createdAt ? fmtDay(l.createdAt.slice(0, 10)) : ""}
                          </span>
                          {l.reason && <p style={{ width: "100%", fontSize: 12, color: "var(--text-2)", fontStyle: "italic" }}>“{l.reason}”</p>}
                        </div>
                      </div>
                    );
                  }
                  if (ev.kind === "followup") {
                    const f = ev.f;
                    return (
                      <div key={`f${f.id}`} style={{ position: "relative", padding: "6px 0" }}>
                        {dot("var(--warning)")}
                        <div className="soft-card-2" style={{ borderRadius: 14, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
                          <CalendarClock style={{ width: 14, height: 14, color: "var(--warning)" }} />
                          <span style={{ color: "var(--text-2)" }}>
                            Follow-up {f.status === "CANCELLED" ? "withdrawn" : "set"} for <strong style={{ color: "var(--text-1)" }}>{fmtDay(f.appointmentDate ?? f.dueDate)}</strong>
                            {f.status === "DONE" ? " — attended" : f.status === "BOOKED" ? " — session booked" : f.status === "PENDING" ? " — awaiting a time" : ""}
                          </span>
                          {f.note && <span style={{ color: "var(--text-3)", fontStyle: "italic" }}>“{f.note}”</span>}
                        </div>
                      </div>
                    );
                  }
                  const s = ev.s;
                  const note = s.note;
                  const expanded = open[s.id] ?? idx === 0;
                  const hasSoap = note && (note.subjective || note.objective || note.assessment || note.plan || note.content);
                  return (
                    <div key={`s${s.id}`} style={{ position: "relative", padding: "6px 0" }}>
                      {dot(s.status === "COMPLETED" ? "var(--accent)" : s.status === "CANCELLED" ? "var(--danger)" : "var(--success)")}
                      <div className="soft-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text-1)" }}>{fmtDayLong(s.appointmentDate)}</span>
                          <span style={{ fontSize: 12, color: "var(--text-3)" }}>{fmtTime(s.startTime)}</span>
                          {s.sessionNumber > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 6, background: "var(--sd)", color: "var(--text-2)" }}>Session {s.sessionNumber}</span>}
                          <SessionStatusBadge status={s.status} />
                          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-2)" }}>
                            <span>{serviceName(s.sessionType)}</span><ModeBadge mode={s.mode} />
                            {s.assignedDoctorName && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Stethoscope style={{ width: 11, height: 11 }} />{s.assignedDoctorName}</span>}
                          </span>
                        </div>
                        {s.status === "COMPLETED" && !hasSoap && (
                          <p style={{ fontSize: 12.5, color: "var(--warning)", background: "var(--warning-bg)", padding: "8px 12px", borderRadius: 10, display: "flex", alignItems: "center", gap: 8 }}>
                            <FileText style={{ width: 13, height: 13 }} /> No notes were recorded for this session.
                            <Link href="/dashboard/session-notes" style={{ marginLeft: "auto", fontWeight: 700, color: "var(--accent)", textDecoration: "none" }}>Add notes</Link>
                          </p>
                        )}
                        {hasSoap && (
                          <>
                            <button type="button" onClick={() => setOpen(o => ({ ...o, [s.id]: !expanded }))}
                              style={{ alignSelf: "flex-start", background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4, padding: 0 }}>
                              {expanded ? <ChevronUp style={{ width: 14, height: 14 }} /> : <ChevronDown style={{ width: 14, height: 14 }} />}
                              Session notes
                            </button>
                            {expanded && (
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                                {([["Subjective", note.subjective], ["Objective", note.objective], ["Assessment", note.assessment], ["Plan", note.plan], ["Notes", note.content]] as [string, string | null][])
                                  .filter(([, v]) => v && v.trim()).map(([k, v]) => (
                                    <div key={k} className="soft-card-2" style={{ borderRadius: 12, padding: "10px 14px" }}>
                                      <p style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{k}</p>
                                      <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{v}</p>
                                    </div>
                                  ))}
                              </div>
                            )}
                          </>
                        )}
                        {s.notes && <p style={{ fontSize: 12, color: "var(--text-3)", fontStyle: "italic" }}>Booking note: “{s.notes}”</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : null}
      </div>

      {statusModal && p && (
        <CaseStatusModal patient={p} onClose={() => setStatusModal(false)}
          onSaved={() => { setStatusModal(false); loadHistory(p.id); loadClients(); }} />
      )}
      {followModal && p && (
        <SetFollowUpModal patient={p} onClose={() => setFollowModal(false)} onSaved={() => { setFollowModal(false); loadHistory(p.id); }} />
      )}
    </div>
  );
}

export default function CaseHistoryPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "60vh" }} />}>
      <CaseHistoryView />
    </Suspense>
  );
}
