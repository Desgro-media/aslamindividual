"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, CalendarCheck, CalendarClock, CalendarPlus, Check, CheckCircle2, History, Loader2, Pencil, Plus,
  Search, Stethoscope, X,
} from "lucide-react";
import api from "../../../lib/api";
import {
  FollowUp, FollowUpBucket, addDays, errMessage, fmtDay, fmtTime, localDate, relativeDay,
} from "../../../lib/psyfos";
import CaseStatusChip from "../../../components/psyfos/CaseStatusChip";
import FollowUpBookModal from "../../../components/psyfos/FollowUpBookModal";
import Modal, { FieldLabel } from "../../../components/psyfos/Modal";
import { useServiceNames } from "../../../components/psyfos/SessionBits";

// Follow-up: the therapist sets the next follow-up date at the end of a session;
// the front desk turns it into a booked session. Both see the same queue — a
// therapist sees their own clients, the clinic sees everyone's.

type Tab = "todo" | "booked" | "history";

const BUCKETS: { key: FollowUpBucket; label: string; color: string; bg: string }[] = [
  { key: "OVERDUE",  label: "Overdue",  color: "var(--danger)",  bg: "var(--danger-bg)" },
  { key: "TODAY",    label: "Due today",color: "var(--accent)",  bg: "var(--accent-surface)" },
  { key: "UPCOMING", label: "Upcoming", color: "var(--text-2)",  bg: "var(--card-2)" },
];

export default function FollowUpsPage() {
  const [isTherapist, setIsTherapist] = useState(false);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("todo");
  const [search, setSearch] = useState("");
  const [booking, setBooking] = useState<FollowUp | null>(null);
  const [editing, setEditing] = useState<FollowUp | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [flash, setFlash] = useState("");
  const serviceName = useServiceNames();

  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem("user") || "null");
      setIsTherapist(!!u?.tenantId && u?.role === "ROLE_PSYCHOLOGIST");
    } catch { /* default: clinic-wide */ }
    setReady(true);
  }, []);

  const load = useCallback(() => {
    if (!ready) return;
    setLoading(true);
    setError("");
    api.get(isTherapist ? "/me/follow-ups" : "/follow-ups")
      .then(r => setRows(r.data ?? []))
      .catch(e => setError(errMessage(e, "Couldn't load follow-ups.")))
      .finally(() => setLoading(false));
  }, [ready, isTherapist]);
  useEffect(() => { load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(""), 3500); };

  const q = search.trim().toLowerCase();
  const matches = (f: FollowUp) => !q || f.patientName.toLowerCase().includes(q) || (f.doctorName ?? "").toLowerCase().includes(q) || f.patientPhone.includes(q);

  const pending = rows.filter(f => f.status === "PENDING" && matches(f));
  const booked = rows.filter(f => f.status === "BOOKED" && matches(f)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const history = rows.filter(f => (f.status === "DONE" || f.status === "CANCELLED") && matches(f)).sort((a, b) => b.dueDate.localeCompare(a.dueDate));

  const counts = useMemo(() => ({
    overdue: rows.filter(f => f.bucket === "OVERDUE").length,
    today: rows.filter(f => f.bucket === "TODAY").length,
    upcoming: rows.filter(f => f.bucket === "UPCOMING").length,
    booked: rows.filter(f => f.status === "BOOKED").length,
  }), [rows]);

  const act = async (f: FollowUp, fn: () => Promise<unknown>, done: string) => {
    setBusyId(f.id);
    try { await fn(); say(done); load(); }
    catch (e) { setError(errMessage(e, "That didn't work. Please try again.")); }
    finally { setBusyId(null); }
  };

  const Row = ({ f }: { f: FollowUp }) => {
    const bucket = BUCKETS.find(b => b.key === f.bucket);
    const busy = busyId === f.id;
    return (
      <div className="soft-card" style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Link href={`/dashboard/patients/${f.patientId}`} style={{ fontSize: 14.5, fontWeight: 800, color: "var(--text-1)", textDecoration: "none" }}>{f.patientName}</Link>
            <CaseStatusChip status={f.patientCaseStatus} size="sm" />
          </div>
          <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3 }}>
            {f.doctorName ? <><Stethoscope style={{ width: 11, height: 11, display: "inline", verticalAlign: "-1px" }} /> {f.doctorName}</> : "No therapist set"}
            {f.sessionType ? ` · ${serviceName(f.sessionType)}` : ""}
          </p>
          {f.note && <p style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4, fontStyle: "italic" }}>“{f.note}”</p>}
        </div>

        <div style={{ minWidth: 150 }}>
          {f.status === "BOOKED" || f.status === "DONE" ? (
            <>
              <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text-1)" }}>{relativeDay(f.appointmentDate ?? f.dueDate)}</p>
              <p style={{ fontSize: 11.5, color: "var(--text-3)" }}>{fmtDay(f.appointmentDate ?? f.dueDate)}{f.appointmentStartTime ? ` · ${fmtTime(f.appointmentStartTime)}` : ""}</p>
            </>
          ) : (
            <>
              <p style={{ fontSize: 13, fontWeight: 700, color: bucket?.color ?? "var(--text-1)" }}>{relativeDay(f.dueDate)}</p>
              <p style={{ fontSize: 11.5, color: "var(--text-3)" }}>Due {fmtDay(f.dueDate)}</p>
            </>
          )}
        </div>

        <span style={{
          padding: "4px 11px", borderRadius: 50, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap",
          color: f.status === "DONE" ? "var(--success)" : f.status === "CANCELLED" ? "var(--text-3)" : f.status === "BOOKED" ? "var(--accent)" : bucket?.color,
          background: f.status === "DONE" ? "var(--success-bg)" : f.status === "CANCELLED" ? "var(--card-2)" : f.status === "BOOKED" ? "var(--accent-surface)" : bucket?.bg,
        }}>
          {f.status === "PENDING" ? bucket?.label : f.status === "BOOKED" ? "Booked" : f.status === "DONE" ? "Done" : "Cancelled"}
        </span>

        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          {f.status === "PENDING" && (
            <>
              <button type="button" disabled={busy} onClick={() => setBooking(f)} className="btn-nm-accent" style={{ padding: "7px 16px", fontSize: 12, fontWeight: 700, gap: 6 }}>
                <CalendarCheck style={{ width: 13, height: 13 }} /> Book session
              </button>
              <button type="button" disabled={busy} onClick={() => setEditing(f)} className="icon-btn" title="Change date / note" style={{ width: 34, height: 34 }}>
                <Pencil style={{ width: 14, height: 14 }} />
              </button>
              <button type="button" disabled={busy} title="Mark done (seen outside the system)" className="icon-btn" style={{ width: 34, height: 34, color: "var(--success)" }}
                onClick={() => act(f, () => api.post(`/follow-ups/${f.id}/done`), "Marked as done.")}>
                <Check style={{ width: 15, height: 15 }} />
              </button>
              <button type="button" disabled={busy} title="Remove this follow-up" className="icon-btn" style={{ width: 34, height: 34, color: "var(--danger)" }}
                onClick={() => { if (confirm(`Remove the follow-up for ${f.patientName}?`)) act(f, () => api.delete(`/follow-ups/${f.id}`), "Follow-up removed."); }}>
                <X style={{ width: 15, height: 15 }} />
              </button>
            </>
          )}
          {f.status === "BOOKED" && f.appointmentId && (
            <Link href={`/dashboard/patients/${f.patientId}`} className="btn-nm" style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, textDecoration: "none", color: "var(--text-1)" }}>
              Open client
            </Link>
          )}
        </div>
      </div>
    );
  };

  const list = tab === "todo" ? pending : tab === "booked" ? booked : history;

  return (
    <div className="anim-fade-up" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-1)", letterSpacing: "-0.03em", marginBottom: 4 }}>
            {isTherapist ? "My follow-ups" : "Follow-ups"}
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-3)" }}>
            {isTherapist
              ? "Clients you've asked to come back. Set a date at the end of a session — the front desk books the time."
              : "Clients due back for a follow-up session, set by their therapist. Book a time to move them off the list."}
          </p>
        </div>
        <button type="button" onClick={() => setAdding(true)} className="btn-nm-accent" style={{ padding: "10px 18px", fontWeight: 700, gap: 6 }}>
          <Plus style={{ width: 15, height: 15 }} /> Add follow-up
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
        {[
          { label: "Overdue", value: counts.overdue, color: counts.overdue ? "var(--danger)" : "var(--text-3)", Icon: AlertTriangle },
          { label: "Due today", value: counts.today, color: counts.today ? "var(--accent)" : "var(--text-3)", Icon: CalendarClock },
          { label: "Upcoming", value: counts.upcoming, color: "var(--text-1)", Icon: CalendarPlus },
          { label: "Booked", value: counts.booked, color: "var(--success)", Icon: CalendarCheck },
        ].map(s => (
          <div key={s.label} className="soft-card" style={{ padding: "16px 18px", display: "flex", alignItems: "center", gap: 14 }}>
            <s.Icon style={{ width: 20, height: 20, color: s.color }} />
            <div>
              <p style={{ fontSize: 24, fontWeight: 800, color: s.color, letterSpacing: "-0.03em", lineHeight: 1 }}>{s.value}</p>
              <p style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 600, marginTop: 3 }}>{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="soft-card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {([
            { v: "todo" as const, label: "Needs scheduling", n: rows.filter(f => f.status === "PENDING").length },
            { v: "booked" as const, label: "Booked", n: counts.booked },
            { v: "history" as const, label: "History", n: 0 },
          ]).map(t => (
            <button key={t.v} type="button" onClick={() => setTab(t.v)} className="tab-pill"
              style={{
                padding: "8px 16px", borderRadius: 50, fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
                background: tab === t.v ? "var(--accent)" : "var(--glass)", color: tab === t.v ? "#fff" : "var(--text-2)",
              }}>
              {t.label}{t.n > 0 && <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 50, fontSize: 10, background: tab === t.v ? "rgba(255,255,255,0.25)" : "var(--sd)" }}>{t.n}</span>}
            </button>
          ))}
        </div>
        <div style={{ position: "relative", flex: 1, minWidth: 200, maxWidth: 320, marginLeft: "auto" }}>
          <Search style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--text-3)", zIndex: 1, pointerEvents: "none" }} />
          <input className="nm-input" style={{ paddingLeft: 40 }} placeholder="Search client or therapist…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {flash && <p style={{ fontSize: 13, fontWeight: 600, color: "var(--success)", background: "var(--success-bg)", padding: "10px 16px", borderRadius: 14 }}>{flash}</p>}
      {error && <p style={{ fontSize: 13, color: "var(--danger)", background: "var(--danger-bg)", padding: "10px 16px", borderRadius: 14 }}>{error}</p>}

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 70, borderRadius: 18 }} />)}</div>
      ) : list.length === 0 ? (
        <div className="soft-card" style={{ padding: "56px 20px", textAlign: "center" }}>
          {tab === "history" ? <History style={{ width: 38, height: 38, color: "var(--text-3)", margin: "0 auto 12px" }} /> : <CheckCircle2 style={{ width: 38, height: 38, color: "var(--text-3)", margin: "0 auto 12px" }} />}
          <p style={{ color: "var(--text-2)", fontWeight: 700 }}>
            {tab === "todo" ? "No follow-ups waiting to be scheduled." : tab === "booked" ? "No follow-up sessions booked." : "No past follow-ups yet."}
          </p>
          <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
            {tab === "todo" ? "When a therapist completes a session and picks a follow-up date, it lands here." : ""}
          </p>
        </div>
      ) : tab === "todo" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {BUCKETS.map(b => {
            const group = pending.filter(f => f.bucket === b.key);
            if (group.length === 0) return null;
            return (
              <div key={b.key} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <h3 style={{ fontSize: 13, fontWeight: 800, color: b.color }}>{b.label} <span style={{ color: "var(--text-3)", fontWeight: 600 }}>({group.length})</span></h3>
                {group.map(f => <Row key={f.id} f={f} />)}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{list.map(f => <Row key={f.id} f={f} />)}</div>
      )}

      {booking && (
        <FollowUpBookModal
          followUp={booking}
          onClose={() => setBooking(null)}
          onBooked={() => { setBooking(null); say("Follow-up session booked."); load(); }}
        />
      )}
      {editing && <EditFollowUpModal followUp={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); say("Follow-up updated."); load(); }} />}
      {adding && <AddFollowUpModal therapist={isTherapist} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); say("Follow-up added."); load(); }} />}
    </div>
  );
}

function EditFollowUpModal({ followUp, onClose, onSaved }: { followUp: FollowUp; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(followUp.dueDate < localDate() ? localDate() : followUp.dueDate);
  const [note, setNote] = useState(followUp.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setSaving(true); setError("");
    try { await api.patch(`/follow-ups/${followUp.id}`, { dueDate: date, note: note.trim() || null }); onSaved(); }
    catch (e) { setError(errMessage(e, "Couldn't update the follow-up.")); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="Change follow-up" subtitle={followUp.patientName} icon={<Pencil style={{ width: 18, height: 18 }} />} maxWidth={420} onClose={onClose}
      footer={<>
        <button type="button" className="btn-nm" onClick={onClose} style={{ padding: "10px 20px" }}>Cancel</button>
        <button type="button" className="btn-nm-accent" disabled={saving} onClick={save} style={{ padding: "10px 24px", fontWeight: 700 }}>
          {saving ? <Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> : "Save"}
        </button>
      </>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
        <div><FieldLabel>Due date</FieldLabel><input type="date" className="nm-input no-icon" value={date} min={localDate()} onChange={e => setDate(e.target.value)} /></div>
        <div><FieldLabel hint="optional">Note</FieldLabel><textarea className="nm-textarea" rows={2} value={note} onChange={e => setNote(e.target.value)} /></div>
        {error && <p style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 12px", borderRadius: 10 }}>{error}</p>}
      </div>
    </Modal>
  );
}

function AddFollowUpModal({ therapist, onClose, onSaved }: { therapist: boolean; onClose: () => void; onSaved: () => void }) {
  const [clients, setClients] = useState<{ id: number; name: string; phone?: string | null; caseStatus?: string }[]>([]);
  const [q, setQ] = useState("");
  const [patientId, setPatientId] = useState<number | null>(null);
  const [date, setDate] = useState(addDays(localDate(), 7));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get(therapist ? "/me/clients" : "/patients").then(r => setClients(r.data ?? [])).catch(() => setError("Couldn't load your clients."));
  }, [therapist]);

  const shown = clients
    .filter(c => !["TERMINATED", "DROPPED"].includes(c.caseStatus ?? ""))
    .filter(c => !q.trim() || c.name.toLowerCase().includes(q.toLowerCase()) || (c.phone ?? "").includes(q))
    .slice(0, 8);

  const save = async () => {
    if (!patientId) { setError("Choose a client."); return; }
    setSaving(true); setError("");
    try { await api.post(`/patients/${patientId}/follow-up`, { dueDate: date, note: note.trim() || undefined }); onSaved(); }
    catch (e) { setError(errMessage(e, "Couldn't add the follow-up.")); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Add follow-up" subtitle="For a client who is still in care" icon={<CalendarPlus style={{ width: 18, height: 18 }} />} maxWidth={460} onClose={onClose}
      footer={<>
        <button type="button" className="btn-nm" onClick={onClose} style={{ padding: "10px 20px" }}>Cancel</button>
        <button type="button" className="btn-nm-accent" disabled={saving || !patientId} onClick={save} style={{ padding: "10px 24px", fontWeight: 700, opacity: patientId ? 1 : 0.5 }}>
          {saving ? <Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> : "Add follow-up"}
        </button>
      </>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
        <div>
          <FieldLabel>Client</FieldLabel>
          <input className="nm-input no-icon" placeholder="Search by name or phone…" value={q} onChange={e => setQ(e.target.value)} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {shown.map(c => (
              <button key={c.id} type="button" onClick={() => setPatientId(c.id)}
                style={{
                  textAlign: "left", padding: "9px 12px", borderRadius: 12, cursor: "pointer", fontSize: 13, fontWeight: 600, display: "flex", justifyContent: "space-between", gap: 10,
                  border: `1.5px solid ${patientId === c.id ? "var(--accent)" : "transparent"}`,
                  background: patientId === c.id ? "var(--accent-surface)" : "var(--card-2)", color: patientId === c.id ? "var(--accent)" : "var(--text-1)",
                }}>
                <span>{c.name}</span><span style={{ fontWeight: 500, color: "var(--text-3)", fontSize: 12 }}>{c.phone}</span>
              </button>
            ))}
            {shown.length === 0 && <p style={{ fontSize: 12, color: "var(--text-3)" }}>No matching clients in care.</p>}
          </div>
        </div>
        <div><FieldLabel>Follow-up date</FieldLabel><input type="date" className="nm-input no-icon" value={date} min={localDate()} onChange={e => setDate(e.target.value)} /></div>
        <div><FieldLabel hint="optional">Note</FieldLabel><textarea className="nm-textarea" rows={2} value={note} onChange={e => setNote(e.target.value)} /></div>
        {error && <p style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 12px", borderRadius: 10 }}>{error}</p>}
      </div>
    </Modal>
  );
}
