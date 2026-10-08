"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, FileText, RefreshCw, UserRound, AlertCircle,
} from "lucide-react";
import api from "../../../lib/api";
import {
  addDays, fmtDay, fmtDayLong, fmtTime, localDate, relativeDay, errMessage,
} from "../../../lib/psyfos";
import CaseStatusChip from "../../../components/psyfos/CaseStatusChip";
import SessionWrapUpModal from "../../../components/psyfos/SessionWrapUpModal";
import { ModeBadge, SessionStatusBadge, useServiceNames } from "../../../components/psyfos/SessionBits";

// Therapist flow, steps 2–3: "View Schedule → View Today's Appointments".
// From a session the therapist opens the client profile, conducts the session,
// and wraps it up (notes → session status → next follow-up) without leaving.

type Item = {
  id: number; patientId: number; patientName: string; patientPhone: string; patientCaseStatus: any;
  appointmentDate: string; startTime: string; endTime: string; status: string; sessionType?: string | null;
  mode?: string; notes?: string | null; assignedDoctorId: number; hasNote: boolean; sessionNumber: number;
  returningPatient?: boolean;
};

const mins = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const durationOf = (i: Item) => Math.max(0, mins(i.endTime) - mins(i.startTime));

export default function SchedulePage() {
  const today = localDate();
  const [date, setDate] = useState(today);
  const [view, setView] = useState<"day" | "week">("day");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [wrapUp, setWrapUp] = useState<Item | null>(null);
  const [flash, setFlash] = useState("");
  const serviceName = useServiceNames();

  const from = date;
  const to = view === "day" ? date : addDays(date, 6);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api.get("/me/schedule", { params: { from, to } })
      .then(r => setItems(r.data ?? []))
      .catch(e => setError(errMessage(e, "Couldn't load your schedule.")))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, Item[]>();
    items.forEach(i => { const list = map.get(i.appointmentDate) ?? []; list.push(i); map.set(i.appointmentDate, list); });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const dayItems = items.filter(i => i.appointmentDate === date);
  const done = dayItems.filter(i => i.status === "COMPLETED").length;
  const remaining = dayItems.filter(i => i.status !== "COMPLETED").length;
  const notesPending = dayItems.filter(i => i.status === "COMPLETED" && !i.hasNote).length;

  const step = view === "day" ? 1 : 7;

  const renderCard = (i: Item) => {
    const isDone = i.status === "COMPLETED";
    const canComplete = !isDone && i.status !== "CANCELLED";
    return (
      <div key={i.id} className="soft-card card-hover" style={{ padding: 0, overflow: "hidden", display: "flex" }}>
        <div style={{
          width: 108, flexShrink: 0, padding: "16px 10px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
          background: isDone ? "var(--accent-surface)" : "var(--card-2)", borderRight: "1px solid var(--card-border)",
        }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: "var(--text-1)", letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>{fmtTime(i.startTime)}</span>
          <span style={{ fontSize: 10.5, color: "var(--text-3)", display: "inline-flex", alignItems: "center", gap: 3 }}>
            <Clock style={{ width: 10, height: 10 }} /> {durationOf(i)} min
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0, padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Link href={`/dashboard/patients/${i.patientId}`} style={{ fontSize: 15, fontWeight: 800, color: "var(--text-1)", textDecoration: "none" }}>
              {i.patientName}
            </Link>
            <CaseStatusChip status={i.patientCaseStatus} size="sm" />
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 6, background: "var(--sd)", color: "var(--text-2)" }}>Session {i.sessionNumber}</span>
            {i.returningPatient && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 6, background: "var(--accent-surface)", color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <RefreshCw style={{ width: 9, height: 9 }} /> Returning
              </span>
            )}
            <span style={{ marginLeft: "auto" }}><SessionStatusBadge status={i.status} /></span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--text-2)" }}>
            <span>{serviceName(i.sessionType)}</span>
            <ModeBadge mode={i.mode} />
            {isDone && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: i.hasNote ? "var(--success)" : "var(--warning)", fontWeight: 600 }}>
                <FileText style={{ width: 12, height: 12 }} /> {i.hasNote ? "Notes saved" : "Notes pending"}
              </span>
            )}
          </div>
          {i.notes && <p style={{ fontSize: 12, color: "var(--text-3)", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>“{i.notes}”</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link href={`/dashboard/patients/${i.patientId}`} className="btn-nm" style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, gap: 6, textDecoration: "none", color: "var(--text-1)" }}>
              <UserRound style={{ width: 13, height: 13, color: "var(--accent)" }} /> Open client
            </Link>
            <Link href={`/dashboard/case-history?patient=${i.patientId}`} className="btn-nm" style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, gap: 6, textDecoration: "none", color: "var(--text-1)" }}>
              <FileText style={{ width: 13, height: 13, color: "var(--accent)" }} /> Case history
            </Link>
            {canComplete && (
              <button type="button" onClick={() => setWrapUp(i)} className="btn-nm-accent" style={{ padding: "7px 16px", fontSize: 12, fontWeight: 700, gap: 6 }}>
                <CheckCircle2 style={{ width: 13, height: 13 }} /> Complete session
              </button>
            )}
            {isDone && (
              <button type="button" onClick={() => setWrapUp(i)} className="btn-nm" style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>
                Edit notes / status
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="anim-fade-up" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {/* Controls */}
      <div className="soft-card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {(["day", "week"] as const).map(v => (
            <button key={v} type="button" onClick={() => setView(v)} className="tab-pill"
              style={{
                padding: "8px 16px", borderRadius: 50, fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
                background: view === v ? "var(--accent)" : "var(--glass)", color: view === v ? "#fff" : "var(--text-2)",
              }}>
              {v === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" className="icon-btn" aria-label="Previous" onClick={() => setDate(addDays(date, -step))}><ChevronLeft style={{ width: 16, height: 16 }} /></button>
          <input type="date" className="nm-input no-icon" value={date} onChange={e => e.target.value && setDate(e.target.value)} style={{ width: 190 }} />
          <button type="button" className="icon-btn" aria-label="Next" onClick={() => setDate(addDays(date, step))}><ChevronRight style={{ width: 16, height: 16 }} /></button>
        </div>
        {date !== today && (
          <button type="button" className="btn-nm" onClick={() => setDate(today)} style={{ padding: "8px 16px", fontSize: 12, fontWeight: 700 }}>Today</button>
        )}
        <button type="button" className="btn-nm" onClick={load} style={{ padding: "8px 16px", fontSize: 12, marginLeft: "auto", gap: 6 }}>
          <RefreshCw style={{ width: 13, height: 13, animation: loading ? "spinSlow 1s linear infinite" : "none" }} /> Refresh
        </button>
      </div>

      {flash && (
        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--success)", background: "var(--success-bg)", padding: "10px 16px", borderRadius: 14 }}>{flash}</p>
      )}

      {/* Day summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
        {[
          { label: relativeDay(date, today) + "’s sessions", value: dayItems.length, color: "var(--text-1)" },
          { label: "Still to do", value: remaining, color: "var(--accent)" },
          { label: "Completed", value: done, color: "var(--success)" },
          { label: "Notes pending", value: notesPending, color: notesPending ? "var(--warning)" : "var(--text-3)" },
        ].map(s => (
          <div key={s.label} className="soft-card" style={{ padding: "16px 18px" }}>
            <p style={{ fontSize: 26, fontWeight: 800, color: s.color, letterSpacing: "-0.03em" }}>{s.value}</p>
            <p style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 600, marginTop: 2 }}>{s.label}</p>
          </div>
        ))}
      </div>

      {/* Sessions */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 96, borderRadius: 18 }} />)}
        </div>
      ) : error ? (
        <div className="soft-card" style={{ padding: "48px 20px", textAlign: "center" }}>
          <AlertCircle style={{ width: 36, height: 36, color: "var(--danger)", margin: "0 auto 10px" }} />
          <p style={{ color: "var(--text-2)", fontWeight: 600 }}>{error}</p>
          <button className="btn-nm-accent" onClick={load} style={{ marginTop: 14, padding: "9px 20px" }}>Retry</button>
        </div>
      ) : grouped.length === 0 ? (
        <div className="soft-card" style={{ padding: "56px 20px", textAlign: "center" }}>
          <CalendarDays style={{ width: 40, height: 40, color: "var(--text-3)", margin: "0 auto 12px" }} />
          <p style={{ color: "var(--text-2)", fontWeight: 700 }}>
            {view === "day" ? `Nothing scheduled for ${fmtDayLong(date)}.` : "Nothing scheduled this week."}
          </p>
          <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>New bookings from the front desk and the booking page appear here automatically.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {grouped.map(([day, list]) => (
            <div key={day} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {view === "week" && (
                <h3 style={{ fontSize: 13, fontWeight: 800, color: day === today ? "var(--accent)" : "var(--text-1)", letterSpacing: "0.02em" }}>
                  {relativeDay(day, today)}{day === today || day === addDays(today, 1) ? ` · ${fmtDay(day)}` : ""}
                  <span style={{ marginLeft: 8, fontWeight: 600, color: "var(--text-3)" }}>{list.length} session{list.length === 1 ? "" : "s"}</span>
                </h3>
              )}
              {list.map(renderCard)}
            </div>
          ))}
        </div>
      )}

      {wrapUp && (
        <SessionWrapUpModal
          appointment={wrapUp}
          onClose={() => setWrapUp(null)}
          onDone={(res) => {
            setWrapUp(null);
            const bits = ["Session saved"];
            if (res?.caseStatusChanged) bits.push("status updated");
            if (res?.followUp) bits.push(res.followUp.status === "BOOKED" ? "follow-up booked" : "follow-up set");
            setFlash(bits.join(" · ") + ".");
            setTimeout(() => setFlash(""), 4000);
            load();
          }}
        />
      )}
    </div>
  );
}
