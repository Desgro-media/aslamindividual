"use client";

import React, { useState } from "react";
import { CalendarPlus, Loader2 } from "lucide-react";
import api from "../../lib/api";
import { addDays, errMessage, localDate } from "../../lib/psyfos";
import Modal, { FieldLabel } from "./Modal";

// Record that a client is due back around a date. Booking a real session for it
// is a separate step (FollowUpBookModal), so the therapist can set the date at
// the end of a session and the front desk can fill in the time later.
export default function SetFollowUpModal({
  patient, onClose, onSaved,
}: { patient: { id: number; name: string }; onClose: () => void; onSaved: (followUp: any) => void }) {
  const [date, setDate] = useState(addDays(localDate(), 7));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setError("");
    if (!date) { setError("Choose a date."); return; }
    setSaving(true);
    try {
      const res = await api.post(`/patients/${patient.id}/follow-up`, { dueDate: date, note: note.trim() || undefined });
      onSaved(res.data);
    } catch (e) {
      setError(errMessage(e, "Couldn't save the follow-up. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Schedule next follow-up"
      subtitle={patient.name}
      icon={<CalendarPlus style={{ width: 20, height: 20 }} />}
      maxWidth={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-nm" style={{ padding: "10px 20px" }}>Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="btn-nm-accent" style={{ padding: "10px 24px", fontWeight: 700 }}>
            {saving ? <><Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> Saving…</> : "Save follow-up"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
        <div>
          <FieldLabel>Follow-up date</FieldLabel>
          <input type="date" className="nm-input no-icon" value={date} min={localDate()} onChange={e => setDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel hint="optional">Note</FieldLabel>
          <textarea className="nm-textarea" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="What should the next session cover?" />
        </div>
        <p style={{ fontSize: 11.5, color: "var(--text-3)" }}>
          This puts the client on the Follow-up list. You can book the actual session from there once a time is agreed.
        </p>
        {error && <p style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 12px", borderRadius: 10 }}>{error}</p>}
      </div>
    </Modal>
  );
}
