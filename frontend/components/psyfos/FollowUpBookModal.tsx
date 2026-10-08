"use client";

import React, { useEffect, useState } from "react";
import { CalendarCheck, Loader2, MapPin, Video } from "lucide-react";
import api from "../../lib/api";
import { FollowUp, Therapist, errMessage, fmtDay, fmtTime, localDate } from "../../lib/psyfos";
import Modal, { FieldLabel } from "./Modal";

// Turn a follow-up into a real session: pick the day, a free time on the
// therapist's calendar, and how it will be paid for. The service and mode
// default to the session being followed up.
export default function FollowUpBookModal({
  followUp, onClose, onBooked,
}: { followUp: FollowUp; onClose: () => void; onBooked: (updated: FollowUp) => void }) {
  const [date, setDate] = useState(followUp.dueDate < localDate() ? localDate() : followUp.dueDate);
  const [time, setTime] = useState(followUp.dueTime ? followUp.dueTime.slice(0, 5) : "");
  const [mode, setMode] = useState<"ONLINE" | "OFFLINE">(followUp.mode === "ONLINE" ? "ONLINE" : "OFFLINE");
  const [doctorId, setDoctorId] = useState<number | "">(followUp.doctorId ?? "");
  const [therapists, setTherapists] = useState<Therapist[]>([]);
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [pay, setPay] = useState<"SELF" | "RECEPTION">("RECEPTION");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/appointments/therapists").then(r => setTherapists(r.data ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!doctorId || !date) { setSlots([]); return; }
    let cancelled = false;
    setSlotsLoading(true);
    api.get(`/appointments/therapists/${doctorId}/slots`, { params: { date, mode } })
      .then(r => { if (!cancelled) setSlots(r.data ?? []); })
      .catch(() => { if (!cancelled) setSlots([]); })
      .finally(() => { if (!cancelled) setSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [doctorId, date, mode]);

  useEffect(() => { if (time && !slotsLoading && !slots.includes(time)) setTime(""); }, [slots, time, slotsLoading]);

  const save = async () => {
    setError("");
    if (!time) { setError("Pick a time."); return; }
    setSaving(true);
    try {
      const res = await api.post(`/follow-ups/${followUp.id}/book`, {
        appointmentDate: date, startTime: `${time}:00`, staffId: doctorId || undefined, mode, paymentHandledBy: pay,
      });
      onBooked(res.data);
    } catch (e) {
      setError(errMessage(e, "Couldn't book the session. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Book follow-up session"
      subtitle={`${followUp.patientName} · due ${fmtDay(followUp.dueDate)}`}
      icon={<CalendarCheck style={{ width: 20, height: 20 }} />}
      maxWidth={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-nm" style={{ padding: "10px 20px" }}>Cancel</button>
          <button type="button" onClick={save} disabled={saving || !time} className="btn-nm-accent" style={{ padding: "10px 24px", fontWeight: 700, opacity: time ? 1 : 0.5 }}>
            {saving ? <><Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> Booking…</> : "Book session"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8 }}>
        {followUp.note && (
          <p className="soft-card-2" style={{ fontSize: 12.5, color: "var(--text-2)", padding: "10px 14px", borderRadius: 12 }}>
            <strong>Therapist&apos;s note:</strong> {followUp.note}
          </p>
        )}

        {therapists.length > 0 && (
          <div>
            <FieldLabel>Therapist</FieldLabel>
            <select className="nm-input no-icon" value={doctorId} onChange={e => { setDoctorId(e.target.value ? Number(e.target.value) : ""); setTime(""); }}>
              <option value="">Select a therapist…</option>
              {therapists.map(t => <option key={t.id} value={t.id}>{t.name}{t.jobTitle ? ` — ${t.jobTitle}` : ""}</option>)}
            </select>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <FieldLabel>Date</FieldLabel>
            <input type="date" className="nm-input no-icon" value={date} min={localDate()} onChange={e => { setDate(e.target.value); setTime(""); }} />
          </div>
          <div>
            <FieldLabel>Mode</FieldLabel>
            <div style={{ display: "flex", gap: 8 }}>
              {([{ v: "OFFLINE" as const, label: "In-person", Icon: MapPin }, { v: "ONLINE" as const, label: "Online", Icon: Video }]).map(({ v, label, Icon }) => (
                <button key={v} type="button" onClick={() => { setMode(v); setTime(""); }} className="btn-nm"
                  style={{ flex: 1, padding: "10px 8px", gap: 6, fontSize: 12, background: mode === v ? "var(--accent)" : undefined, color: mode === v ? "#fff" : undefined }}>
                  <Icon style={{ width: 12, height: 12 }} /> {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <FieldLabel>Time</FieldLabel>
          {!doctorId ? (
            <p style={{ fontSize: 12, color: "var(--text-3)" }}>Choose a therapist to see their free times.</p>
          ) : slotsLoading ? (
            <p style={{ fontSize: 12, color: "var(--text-3)" }}>Checking the calendar…</p>
          ) : slots.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--warning)" }}>No free {mode === "ONLINE" ? "online" : "in-person"} times that day — try another date.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {slots.map(s => (
                <button key={s} type="button" onClick={() => setTime(s)}
                  style={{
                    padding: "8px 14px", borderRadius: 12, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                    border: `1.5px solid ${time === s ? "var(--accent)" : "transparent"}`,
                    background: time === s ? "var(--accent-surface)" : "var(--card-2)",
                    color: time === s ? "var(--accent)" : "var(--text-2)",
                  }}>
                  {fmtTime(s)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <FieldLabel>Payment</FieldLabel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {([
              { v: "RECEPTION" as const, label: "Front desk collects", sub: "Confirmed now; shows in Pending Payments" },
              { v: "SELF" as const, label: "Client pays online", sub: "A payment link is sent to the client" },
            ]).map(o => (
              <button key={o.v} type="button" onClick={() => setPay(o.v)}
                style={{
                  flex: "1 1 200px", textAlign: "left", padding: "10px 14px", borderRadius: 14, cursor: "pointer",
                  border: `1.5px solid ${pay === o.v ? "var(--accent)" : "transparent"}`,
                  background: pay === o.v ? "var(--accent-surface)" : "var(--card-2)",
                }}>
                <p style={{ fontSize: 12.5, fontWeight: 700, color: pay === o.v ? "var(--accent)" : "var(--text-1)" }}>{o.label}</p>
                <p style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>{o.sub}</p>
              </button>
            ))}
          </div>
        </div>

        {error && <p style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 12px", borderRadius: 10 }}>{error}</p>}
      </div>
    </Modal>
  );
}
