"use client";

import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CalendarPlus, ClipboardList, Loader2 } from "lucide-react";
import api from "../../lib/api";
import {
  CASE_STATUS_OPTIONS, CaseStatus, addDays, caseStatusMeta, errMessage, fmtDay, fmtTime, localDate,
} from "../../lib/psyfos";
import Modal, { FieldLabel } from "./Modal";
import { CaseStatusPicker } from "./CaseStatusChip";

export interface WrapUpAppointment {
  id: number;
  patientId: number;
  patientName: string;
  assignedDoctorId: number;
  appointmentDate: string;
  startTime: string;
  endTime: string;
  mode?: string;
  status?: string;
  patientCaseStatus?: CaseStatus;
}

const SOAP = [
  { key: "subjective", label: "Subjective", hint: "What the client reported", placeholder: "Presenting concerns, mood, events since last session…" },
  { key: "objective",  label: "Objective",  hint: "What you observed",       placeholder: "Appearance, affect, behaviour, test results…" },
  { key: "assessment", label: "Assessment", hint: "Clinical impression",     placeholder: "Formulation, progress against goals…" },
  { key: "plan",       label: "Plan",       hint: "Next steps",              placeholder: "Interventions, homework, referrals…" },
] as const;

function minutesBetween(a: string, b: string) {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}

/**
 * The therapist's end-of-session wrap-up, in one place:
 * notes -> session status -> next follow-up -> save. Everything is saved
 * together by POST /appointments/:id/complete, so a half-recorded session
 * can't happen.
 */
export default function SessionWrapUpModal({
  appointment, onClose, onDone,
}: { appointment: WrapUpAppointment; onClose: () => void; onDone: (result: any) => void }) {
  const [soap, setSoap] = useState({ subjective: "", objective: "", assessment: "", plan: "" });
  const [status, setStatus] = useState<CaseStatus>(
    appointment.patientCaseStatus === "NEW_CASE" || !appointment.patientCaseStatus ? "ONGOING" : appointment.patientCaseStatus
  );
  const [reason, setReason] = useState("");
  const [followUp, setFollowUp] = useState(true);
  const [fuDate, setFuDate] = useState(addDays(localDate(), 7));
  const [fuTime, setFuTime] = useState("");
  const [fuNote, setFuNote] = useState("");
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadedNote, setLoadedNote] = useState(false);

  const open = caseStatusMeta(status).open;
  const duration = Math.max(15, minutesBetween(appointment.startTime, appointment.endTime) || 60);

  // Pre-fill any note already written for this session (re-opening a wrap-up).
  useEffect(() => {
    api.get(`/notes/appointment/${appointment.id}`)
      .then(r => {
        if (r.status === 200 && r.data) {
          setSoap({
            subjective: r.data.subjective ?? "", objective: r.data.objective ?? "",
            assessment: r.data.assessment ?? "", plan: r.data.plan ?? "",
          });
          setLoadedNote(true);
        }
      })
      .catch(() => {});
  }, [appointment.id]);

  // Free times on the therapist's own calendar for the chosen follow-up day.
  useEffect(() => {
    if (!followUp || !open || !fuDate) { setSlots([]); return; }
    let cancelled = false;
    setSlotsLoading(true);
    api.get(`/appointments/therapists/${appointment.assignedDoctorId}/slots`, {
      params: { date: fuDate, mode: appointment.mode || "OFFLINE", duration },
    })
      .then(r => { if (!cancelled) setSlots(r.data ?? []); })
      .catch(() => { if (!cancelled) setSlots([]); })
      .finally(() => { if (!cancelled) setSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [followUp, open, fuDate, appointment.assignedDoctorId, appointment.mode, duration]);

  useEffect(() => { if (fuTime && !slots.includes(fuTime) && !slotsLoading) setFuTime(""); }, [slots, fuTime, slotsLoading]);

  const hasNote = Object.values(soap).some(v => v.trim());

  const summary = useMemo(() => {
    const parts = ["Mark this session completed"];
    if (hasNote) parts.push("save your notes");
    parts.push(`set the status to ${caseStatusMeta(status).label}`);
    if (open && followUp && fuDate) {
      parts.push(fuTime ? `book the follow-up for ${fmtDay(fuDate)} at ${fmtTime(fuTime)}` : `set the next follow-up for ${fmtDay(fuDate)}`);
    }
    return parts.join(", ").replace(/, ([^,]*)$/, " and $1") + ".";
  }, [hasNote, status, open, followUp, fuDate, fuTime]);

  const save = async () => {
    setError("");
    if (open && followUp && !fuDate) { setError("Choose a follow-up date, or switch the follow-up off."); return; }
    if (open && followUp && fuDate < localDate()) { setError("The follow-up date can't be in the past."); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { caseStatus: status };
      if (hasNote) body.note = soap;
      if (!open && reason.trim()) body.caseStatusReason = reason.trim();
      if (open && followUp && fuDate) {
        body.followUp = {
          date: fuDate,
          time: fuTime ? `${fuTime}:00` : undefined,
          note: fuNote.trim() || undefined,
          book: !!fuTime,
        };
      }
      const res = await api.post(`/appointments/${appointment.id}/complete`, body);
      onDone(res.data);
    } catch (e) {
      setError(errMessage(e, "Couldn't save the session. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Complete session"
      subtitle={`${appointment.patientName} · ${fmtDay(appointment.appointmentDate)}, ${fmtTime(appointment.startTime)}`}
      icon={<CheckCircle2 style={{ width: 20, height: 20 }} />}
      maxWidth={640}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-nm" style={{ padding: "10px 20px" }}>Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="btn-nm-accent" style={{ padding: "10px 24px", fontWeight: 700 }}>
            {saving ? <><Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> Saving…</> : "Complete session"}
          </button>
        </>
      }
    >
      {/* 1 · Notes */}
      <section style={{ marginTop: 8 }}>
        <h4 style={{ fontSize: 13, fontWeight: 800, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <ClipboardList style={{ width: 15, height: 15, color: "var(--accent)" }} /> Session notes
          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-3)" }}>
            {loadedNote ? "· editing the saved note" : "· optional — you can also add them later"}
          </span>
        </h4>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {SOAP.map(f => (
            <div key={f.key}>
              <FieldLabel hint={f.hint}>{f.label}</FieldLabel>
              <textarea
                className="nm-textarea" rows={3} placeholder={f.placeholder}
                value={soap[f.key]} onChange={e => setSoap(s => ({ ...s, [f.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      </section>

      {/* 2 · Session status */}
      <section style={{ marginTop: 22 }}>
        <h4 style={{ fontSize: 13, fontWeight: 800, color: "var(--text-1)", marginBottom: 12 }}>Session status</h4>
        <CaseStatusPicker value={status} onChange={setStatus} />
        <p style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 8 }}>
          {CASE_STATUS_OPTIONS.find(o => o.value === status)?.hint}
        </p>
        {!open && (
          <div style={{ marginTop: 12 }}>
            <FieldLabel hint="optional">Reason</FieldLabel>
            <textarea className="nm-textarea" rows={2} value={reason} onChange={e => setReason(e.target.value)}
              placeholder={status === "DROPPED" ? "e.g. Stopped responding after two missed sessions" : "e.g. Goals achieved, discharged"} />
          </div>
        )}
      </section>

      {/* 3 · Follow-up */}
      {open && (
        <section style={{ marginTop: 22 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h4 style={{ fontSize: 13, fontWeight: 800, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 8 }}>
              <CalendarPlus style={{ width: 15, height: 15, color: "var(--accent)" }} /> Next follow-up
            </h4>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: "var(--text-2)", cursor: "pointer" }}>
              <input type="checkbox" checked={followUp} onChange={e => setFollowUp(e.target.checked)} />
              Schedule one
            </label>
          </div>

          {followUp && (
            <div className="soft-card-2" style={{ borderRadius: 16, padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <FieldLabel>Date</FieldLabel>
                  <input type="date" className="nm-input no-icon" value={fuDate} min={localDate()}
                    onChange={e => { setFuDate(e.target.value); setFuTime(""); }} />
                </div>
                <div>
                  <FieldLabel hint="optional">Time</FieldLabel>
                  <select className="nm-input no-icon" value={fuTime} onChange={e => setFuTime(e.target.value)} disabled={slotsLoading}>
                    <option value="">{slotsLoading ? "Checking calendar…" : "Decide later"}</option>
                    {slots.map(s => <option key={s} value={s}>{fmtTime(s)}</option>)}
                  </select>
                </div>
              </div>
              {!slotsLoading && fuDate && slots.length === 0 && (
                <p style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                  No free times on your calendar that day — the follow-up will be saved for the front desk to schedule.
                </p>
              )}
              <div>
                <FieldLabel hint="optional">Note for the front desk</FieldLabel>
                <input className="nm-input no-icon" value={fuNote} onChange={e => setFuNote(e.target.value)}
                  placeholder="e.g. Review thought record · bring school report" />
              </div>
              <p style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                {fuTime
                  ? "A time is chosen, so the session is booked right away (same service, same length, with you)."
                  : "Without a time the follow-up appears in the Follow-up list for the front desk to book."}
              </p>
            </div>
          )}
        </section>
      )}

      <p style={{ fontSize: 12, color: "var(--text-2)", marginTop: 20, padding: "10px 14px", borderRadius: 12, background: "var(--accent-surface)" }}>
        {summary}
      </p>
      {error && (
        <p style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 12px", borderRadius: 10, marginTop: 12 }}>{error}</p>
      )}
    </Modal>
  );
}
