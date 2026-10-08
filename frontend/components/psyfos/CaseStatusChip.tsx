"use client";

import React from "react";
import { CASE_STATUS_OPTIONS, CaseStatus, caseStatusMeta } from "../../lib/psyfos";

export default function CaseStatusChip({ status, size = "md" }: { status?: string | null; size?: "sm" | "md" }) {
  const m = caseStatusMeta(status);
  return (
    <span
      title={m.hint}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", flexShrink: 0,
        padding: size === "sm" ? "2px 8px" : "4px 11px", borderRadius: 50,
        fontSize: size === "sm" ? 10 : 11, fontWeight: 700, letterSpacing: "0.03em",
        color: m.color, background: m.bg, border: `1px solid ${m.brd}`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.color }} />
      {m.label}
    </span>
  );
}

// The five session statuses as a pill group — used wherever a therapist picks one.
export function CaseStatusPicker({
  value, onChange, disabled,
}: { value: CaseStatus | null; onChange: (v: CaseStatus) => void; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {CASE_STATUS_OPTIONS.map(o => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            title={o.hint}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 50, cursor: "pointer",
              fontSize: 12, fontWeight: 700,
              border: `1.5px solid ${active ? o.color : "transparent"}`,
              background: active ? o.bg : "var(--card-2)",
              color: active ? o.color : "var(--text-2)",
              transition: "all .18s ease",
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: active ? o.color : "var(--text-3)" }} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
