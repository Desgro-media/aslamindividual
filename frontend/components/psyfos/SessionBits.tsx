"use client";

import React, { useEffect, useState } from "react";
import { MapPin, Video } from "lucide-react";
import api from "../../lib/api";

// Small pieces every Psyfos screen shows next to a session.

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  CONFIRMED:            { label: "Confirmed",        color: "var(--success)", bg: "var(--success-bg)" },
  COMPLETED:            { label: "Completed",        color: "var(--accent)",  bg: "var(--accent-surface)" },
  AWAITING_PAYMENT:     { label: "Awaiting payment", color: "#c2410c",        bg: "rgba(249,115,22,0.12)" },
  PAYMENT_UNDER_REVIEW: { label: "Verifying payment",color: "#0e7490",        bg: "rgba(6,182,212,0.12)" },
  PENDING:              { label: "Pending",          color: "var(--warning)", bg: "var(--warning-bg)" },
  CANCELLED:            { label: "Cancelled",        color: "var(--danger)",  bg: "var(--danger-bg)" },
  DEMO_CALL_PENDING:    { label: "Demo call",        color: "#0369a1",        bg: "rgba(14,165,233,0.12)" },
};

export function SessionStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, color: "var(--text-2)", bg: "var(--card-2)" };
  return (
    <span style={{
      padding: "4px 10px", borderRadius: 50, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
      color: s.color, background: s.bg, whiteSpace: "nowrap", flexShrink: 0,
    }}>
      {s.label}
    </span>
  );
}

export function ModeBadge({ mode }: { mode?: string | null }) {
  const online = mode === "ONLINE";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, color: online ? "#0369a1" : "var(--text-2)" }}>
      {online ? <Video style={{ width: 11, height: 11 }} /> : <MapPin style={{ width: 11, height: 11 }} />}
      {online ? "Online" : "In-person"}
    </span>
  );
}

/**
 * Resolves an appointment's `sessionType` (a service id stored as text, or a
 * legacy name) to a display name. Reads the booking catalogue, which every role
 * that can see appointments may call — unlike /services, which needs Settings.
 */
export function useServiceNames(): (sessionType?: string | null) => string {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    api.get("/appointments/service-options")
      .then(r => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        (r.data ?? []).forEach((o: any) => { map[String(o.serviceId)] = o.name; });
        setNames(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return (sessionType?: string | null) => {
    if (!sessionType) return "General";
    return names[sessionType] ?? (/^\d+$/.test(sessionType) ? "Session" : sessionType.replace(/_/g, " "));
  };
}
