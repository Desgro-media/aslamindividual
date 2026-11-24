"use client";

import React, { useState } from "react";
import { Check, Loader2, Share2 } from "lucide-react";
import api from "../../lib/api";
import { ShareState, errMessage, fmtDay } from "../../lib/psyfos";
import Modal, { FieldLabel } from "./Modal";

// Share a client with other therapists in the clinic. Each row is a switch: the
// change is saved the moment it's pressed, so there's no separate Save step to
// forget. A shared therapist can follow and edit this client's journey (session
// status, follow-ups, notes) — the clinic owner always can.
export default function ShareClientModal({
  patient, state, onClose, onChanged,
}: {
  patient: { id: number; name: string };
  state: ShareState;
  onClose: () => void;
  /** called with the fresh state after every change */
  onChanged: (next: ShareState) => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const sharedAt = (id: number) => state.shares.find(s => s.therapistId === id);

  const toggle = async (therapistId: number, currentlyShared: boolean) => {
    setError("");
    setBusyId(therapistId);
    try {
      const res = currentlyShared
        ? await api.delete(`/patients/${patient.id}/shares/${therapistId}`)
        : await api.post(`/patients/${patient.id}/shares`, { therapistId });
      onChanged(res.data);
    } catch (e) {
      setError(errMessage(e, "Couldn't update sharing. Please try again."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      title="Share this client"
      subtitle={patient.name}
      icon={<Share2 style={{ width: 20, height: 20 }} />}
      onClose={onClose}
      footer={<button type="button" onClick={onClose} className="btn-nm-accent" style={{ padding: "10px 24px", fontWeight: 700 }}>Done</button>}
    >
      <p style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55, marginTop: 6 }}>
        A therapist you share with sees this client under <strong>My clients</strong> and can update their
        session status, follow-ups and session notes. You can stop sharing at any time.
      </p>

      {state.treating.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <FieldLabel>{state.treating.length > 1 ? "Treating therapists" : "Treating therapist"}</FieldLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {state.treating.map(t => (
              <div key={t.id} className="soft-card-2" style={{ borderRadius: 14, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                <div className="team-avatar" style={{ width: 36, height: 36, borderRadius: "50%", fontSize: 15, flexShrink: 0 }}>
                  {(t.name ?? "?").charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.name ?? "Therapist"}{t.isMe ? " (you)" : ""}
                  </p>
                  <p style={{ fontSize: 11.5, color: "var(--text-3)" }}>{t.jobTitle ?? "Therapist"}</p>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 50, background: "var(--accent-surface)", color: "var(--accent)", flexShrink: 0 }}>
                  {t.assigned ? "Primary" : "Treating"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <FieldLabel>Shared with</FieldLabel>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {state.candidates.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-3)", padding: "14px 4px" }}>
            There are no other therapists in your clinic to share with yet.
          </p>
        ) : state.candidates.map(t => {
          const share = sharedAt(t.id);
          const on = t.shared;
          const busy = busyId === t.id;
          return (
            <div key={t.id} className="soft-card-2"
              style={{ borderRadius: 14, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, border: `1.5px solid ${on ? "var(--accent)" : "transparent"}` }}>
              <div className="team-avatar" style={{ width: 36, height: 36, borderRadius: "50%", fontSize: 15, flexShrink: 0 }}>
                {(t.name ?? "?").charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name ?? "Therapist"}</p>
                <p style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                  {on && share
                    ? `Shared${share.sharedByName ? ` by ${share.sharedByName}` : ""}${share.sharedAt ? ` · ${fmtDay(share.sharedAt.slice(0, 10), { day: "numeric", month: "short" })}` : ""}`
                    : t.jobTitle ?? "Therapist"}
                </p>
              </div>
              <button type="button" disabled={busy || busyId !== null}
                onClick={() => toggle(t.id, on)}
                className={on ? "btn-nm" : "btn-nm-accent"}
                style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, gap: 6, minWidth: 108, justifyContent: "center" }}>
                {busy ? <Loader2 style={{ width: 13, height: 13, animation: "spinSlow 1s linear infinite" }} />
                  : on ? <><Check style={{ width: 13, height: 13, color: "var(--success)" }} /> Shared</> : "Share"}
              </button>
            </div>
          );
        })}
      </div>

      {state.candidates.some(t => t.shared) && (
        <p style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 10 }}>Press &ldquo;Shared&rdquo; again to stop sharing with that therapist.</p>
      )}
      {error && <p style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 12px", borderRadius: 10, marginTop: 12 }}>{error}</p>}
    </Modal>
  );
}
