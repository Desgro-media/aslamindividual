"use client";

import React, { useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import api from "../../lib/api";
import { CASE_STATUS_OPTIONS, CaseStatus, caseStatusMeta, errMessage } from "../../lib/psyfos";
import Modal, { FieldLabel } from "./Modal";
import { CaseStatusPicker } from "./CaseStatusChip";

// Change a client's session status outside a session wrap-up (e.g. mark a
// client Dropped after repeated no-shows, or Terminated at discharge).
export default function CaseStatusModal({
  patient, onClose, onSaved,
}: {
  patient: { id: number; name: string; caseStatus?: CaseStatus | null };
  onClose: () => void;
  onSaved: (updated: any) => void;
}) {
  const [status, setStatus] = useState<CaseStatus>(patient.caseStatus ?? "NEW_CASE");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const open = caseStatusMeta(status).open;
  const unchanged = status === (patient.caseStatus ?? "NEW_CASE");

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const res = await api.patch(`/patients/${patient.id}/case-status`, { caseStatus: status, reason: reason.trim() || undefined });
      onSaved(res.data);
    } catch (e) {
      setError(errMessage(e, "Couldn't update the status. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Update session status"
      subtitle={patient.name}
      icon={<Activity style={{ width: 20, height: 20 }} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-nm" style={{ padding: "10px 20px" }}>Cancel</button>
          <button type="button" onClick={save} disabled={saving || unchanged} className="btn-nm-accent" style={{ padding: "10px 24px", fontWeight: 700, opacity: unchanged ? 0.5 : 1 }}>
            {saving ? <><Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> Saving…</> : "Save status"}
          </button>
        </>
      }
    >
      <div style={{ marginTop: 8 }}>
        <CaseStatusPicker value={status} onChange={setStatus} />
        <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 10 }}>
          {CASE_STATUS_OPTIONS.find(o => o.value === status)?.hint}
        </p>
        <div style={{ marginTop: 16 }}>
          <FieldLabel hint="optional">Reason</FieldLabel>
          <textarea className="nm-textarea" rows={2} value={reason} onChange={e => setReason(e.target.value)}
            placeholder={open ? "Anything worth recording about this change…" : "Why is this case being closed?"} />
        </div>
        {!open && (
          <p style={{ fontSize: 11.5, color: "var(--warning)", background: "var(--warning-bg)", padding: "8px 12px", borderRadius: 10, marginTop: 12 }}>
            Closing a case withdraws any follow-up that hasn&apos;t been scheduled yet.
          </p>
        )}
        {error && <p style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 12px", borderRadius: 10, marginTop: 12 }}>{error}</p>}
      </div>
    </Modal>
  );
}
