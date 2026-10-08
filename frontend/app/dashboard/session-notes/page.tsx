"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Loader2, NotebookPen, Pencil, Search } from "lucide-react";
import api from "../../../lib/api";
import { errMessage, fmtDay, fmtTime } from "../../../lib/psyfos";
import CaseStatusChip from "../../../components/psyfos/CaseStatusChip";
import Modal, { FieldLabel } from "../../../components/psyfos/Modal";
import SessionWrapUpModal from "../../../components/psyfos/SessionWrapUpModal";
import { useServiceNames } from "../../../components/psyfos/SessionBits";

// Therapist flow: "Add Session Notes → Save / Update Records".
// Three lists: sessions that ended but were never completed, completed sessions
// still missing notes, and every note already written.

type QueueItem = {
  appointmentId: number; patientId: number; patientName: string; appointmentDate: string; startTime: string;
  endTime: string; mode: string | null; assignedDoctorId: number;
  sessionType: string | null; caseStatus: any; status: string;
};
type NoteItem = QueueItem & {
  noteId: number; subjective: string | null; objective: string | null; assessment: string | null; plan: string | null;
  content: string | null; updatedAt: string | null;
};
type Data = { pendingNotes: QueueItem[]; awaitingCompletion: QueueItem[]; notes: NoteItem[] };

const SOAP = [
  { key: "subjective", label: "Subjective", hint: "What the client reported" },
  { key: "objective", label: "Objective", hint: "What you observed" },
  { key: "assessment", label: "Assessment", hint: "Clinical impression" },
  { key: "plan", label: "Plan", hint: "Next steps" },
] as const;

export default function SessionNotesPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<QueueItem | null>(null);
  const [completing, setCompleting] = useState<QueueItem | null>(null);
  const [flash, setFlash] = useState("");
  const serviceName = useServiceNames();

  const load = useCallback(() => {
    setLoading(true); setError("");
    api.get("/me/session-notes")
      .then(r => setData(r.data))
      .catch(e => setError(errMessage(e, "Couldn't load your session notes.")))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(""), 3500); };

  const notes = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (data?.notes ?? []).filter(n =>
      !query || n.patientName.toLowerCase().includes(query)
      || [n.subjective, n.objective, n.assessment, n.plan, n.content].some(v => v?.toLowerCase().includes(query)));
  }, [data, q]);

  const QueueRow = ({ item, action, label }: { item: QueueItem; action: () => void; label: string }) => (
    <div className="soft-card" style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Link href={`/dashboard/patients/${item.patientId}`} style={{ fontSize: 14, fontWeight: 800, color: "var(--text-1)", textDecoration: "none" }}>{item.patientName}</Link>
          <CaseStatusChip status={item.caseStatus} size="sm" />
        </div>
        <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>{fmtDay(item.appointmentDate)} · {fmtTime(item.startTime)} · {serviceName(item.sessionType)}</p>
      </div>
      <button type="button" onClick={action} className="btn-nm-accent" style={{ padding: "7px 16px", fontSize: 12, fontWeight: 700 }}>{label}</button>
    </div>
  );

  return (
    <div className="anim-fade-up" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-1)", letterSpacing: "-0.03em", marginBottom: 4 }}>Session notes</h1>
        <p style={{ fontSize: 14, color: "var(--text-3)" }}>Write up sessions while they&apos;re fresh. Notes follow the SOAP format and stay with the client&apos;s case history.</p>
      </div>

      {flash && <p style={{ fontSize: 13, fontWeight: 600, color: "var(--success)", background: "var(--success-bg)", padding: "10px 16px", borderRadius: 14 }}>{flash}</p>}

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 66, borderRadius: 18 }} />)}</div>
      ) : error || !data ? (
        <div className="soft-card" style={{ padding: "48px 20px", textAlign: "center" }}>
          <AlertCircle style={{ width: 36, height: 36, color: "var(--danger)", margin: "0 auto 10px" }} />
          <p style={{ color: "var(--text-2)", fontWeight: 600 }}>{error}</p>
          <button className="btn-nm-accent" onClick={load} style={{ marginTop: 14, padding: "9px 20px" }}>Retry</button>
        </div>
      ) : (
        <>
          {data.awaitingCompletion.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <h3 style={{ fontSize: 13, fontWeight: 800, color: "var(--warning)" }}>
                Finished but not completed <span style={{ color: "var(--text-3)", fontWeight: 600 }}>({data.awaitingCompletion.length})</span>
              </h3>
              {data.awaitingCompletion.map(i => <QueueRow key={i.appointmentId} item={i} label="Complete session" action={() => setCompleting(i)} />)}
            </section>
          )}

          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h3 style={{ fontSize: 13, fontWeight: 800, color: data.pendingNotes.length ? "var(--accent)" : "var(--text-2)" }}>
              Notes to write <span style={{ color: "var(--text-3)", fontWeight: 600 }}>({data.pendingNotes.length})</span>
            </h3>
            {data.pendingNotes.length === 0 ? (
              <div className="soft-card" style={{ padding: "26px 20px", textAlign: "center", color: "var(--text-3)", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
                <CheckCircle2 style={{ width: 18, height: 18, color: "var(--success)" }} /> You&apos;re all caught up — every completed session has notes.
              </div>
            ) : data.pendingNotes.map(i => <QueueRow key={i.appointmentId} item={i} label="Write notes" action={() => setEditing(i)} />)}
          </section>

          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <h3 style={{ fontSize: 13, fontWeight: 800, color: "var(--text-1)" }}>All notes <span style={{ color: "var(--text-3)", fontWeight: 600 }}>({notes.length})</span></h3>
              <div style={{ position: "relative", flex: 1, minWidth: 200, maxWidth: 340, marginLeft: "auto" }}>
                <Search style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--text-3)", zIndex: 1, pointerEvents: "none" }} />
                <input className="nm-input" style={{ paddingLeft: 40 }} placeholder="Search client or note text…" value={q} onChange={e => setQ(e.target.value)} />
              </div>
            </div>
            {notes.length === 0 ? (
              <div className="soft-card" style={{ padding: "44px 20px", textAlign: "center" }}>
                <NotebookPen style={{ width: 36, height: 36, color: "var(--text-3)", margin: "0 auto 10px" }} />
                <p style={{ color: "var(--text-3)", fontSize: 14 }}>{q ? "No notes match your search." : "No notes written yet."}</p>
              </div>
            ) : notes.map(n => (
              <div key={n.noteId} className="soft-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <Link href={`/dashboard/case-history?patient=${n.patientId}`} style={{ fontSize: 14, fontWeight: 800, color: "var(--text-1)", textDecoration: "none" }}>{n.patientName}</Link>
                  <CaseStatusChip status={n.caseStatus} size="sm" />
                  <span style={{ fontSize: 12, color: "var(--text-3)" }}>{fmtDay(n.appointmentDate)} · {fmtTime(n.startTime)} · {serviceName(n.sessionType)}</span>
                  <button type="button" className="icon-btn" title="Edit note" style={{ marginLeft: "auto", width: 32, height: 32 }} onClick={() => setEditing(n)}>
                    <Pencil style={{ width: 14, height: 14 }} />
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                  {([["Subjective", n.subjective], ["Objective", n.objective], ["Assessment", n.assessment], ["Plan", n.plan], ["Notes", n.content]] as [string, string | null][])
                    .filter(([, v]) => v && v.trim()).map(([k, v]) => (
                      <div key={k} className="soft-card-2" style={{ borderRadius: 12, padding: "10px 14px" }}>
                        <p style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{k}</p>
                        <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{v}</p>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      {editing && (
        <NoteModal item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); say("Notes saved."); load(); }} />
      )}
      {completing && (
        <SessionWrapUpModal
          appointment={{ id: completing.appointmentId, patientId: completing.patientId, patientName: completing.patientName,
            assignedDoctorId: completing.assignedDoctorId, appointmentDate: completing.appointmentDate, startTime: completing.startTime,
            endTime: completing.endTime, mode: completing.mode ?? undefined, patientCaseStatus: completing.caseStatus }}
          onClose={() => setCompleting(null)}
          onDone={() => { setCompleting(null); say("Session completed."); load(); }}
        />
      )}
    </div>
  );
}

function NoteModal({ item, onClose, onSaved }: { item: QueueItem; onClose: () => void; onSaved: () => void }) {
  const [soap, setSoap] = useState({ subjective: "", objective: "", assessment: "", plan: "" });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get(`/notes/appointment/${item.appointmentId}`)
      .then(r => { if (r.status === 200 && r.data) setSoap({ subjective: r.data.subjective ?? "", objective: r.data.objective ?? "", assessment: r.data.assessment ?? "", plan: r.data.plan ?? "" }); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [item.appointmentId]);

  const save = async () => {
    if (!Object.values(soap).some(v => v.trim())) { setError("Write something in at least one section."); return; }
    setSaving(true); setError("");
    try { await api.post("/notes", { appointmentId: item.appointmentId, ...soap }); onSaved(); }
    catch (e) { setError(errMessage(e, "Couldn't save the notes.")); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Session notes" subtitle={`${item.patientName} · ${fmtDay(item.appointmentDate)}, ${fmtTime(item.startTime)}`}
      icon={<NotebookPen style={{ width: 18, height: 18 }} />} maxWidth={620} onClose={onClose}
      footer={<>
        <button type="button" className="btn-nm" onClick={onClose} style={{ padding: "10px 20px" }}>Cancel</button>
        <button type="button" className="btn-nm-accent" disabled={saving || !loaded} onClick={save} style={{ padding: "10px 24px", fontWeight: 700 }}>
          {saving ? <Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> : "Save notes"}
        </button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
        {SOAP.map(f => (
          <div key={f.key}>
            <FieldLabel hint={f.hint}>{f.label}</FieldLabel>
            <textarea className="nm-textarea" rows={5} value={soap[f.key]} onChange={e => setSoap(s => ({ ...s, [f.key]: e.target.value }))} />
          </div>
        ))}
      </div>
      {error && <p style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 12px", borderRadius: 10, marginTop: 12 }}>{error}</p>}
    </Modal>
  );
}
