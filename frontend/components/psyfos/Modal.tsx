"use client";

import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

// The same dialog shell the rest of the dashboard uses (soft-card on a blurred
// overlay) so the Psyfos screens look and behave like every existing modal.
export default function Modal({
  title, subtitle, onClose, children, footer, maxWidth = 520, icon,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: number;
  icon?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="overlay-enter"
      style={{
        position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="soft-card anim-scale-in"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: "100%", maxWidth, maxHeight: "92vh", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "22px 26px 16px", display: "flex", alignItems: "flex-start", gap: 14, flexShrink: 0 }}>
          {icon && <div className="icon-badge icon-badge--accent" style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0 }}>{icon}</div>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ fontSize: 17, fontWeight: 800, color: "var(--text-1)", letterSpacing: "-0.02em" }}>{title}</h3>
            {subtitle && <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3 }}>{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="icon-btn" aria-label="Close" style={{ width: 34, height: 34, borderRadius: "50%" }}>
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>
        <div style={{ padding: "4px 26px 20px", overflowY: "auto", flex: 1 }}>{children}</div>
        {footer && (
          <div style={{ padding: "14px 26px 22px", borderTop: "1px solid var(--card-border)", display: "flex", gap: 12, justifyContent: "flex-end", flexShrink: 0 }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

export function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 7 }}>
      {children}
      {hint && <span style={{ textTransform: "none", fontWeight: 500, letterSpacing: 0, marginLeft: 6 }}>{hint}</span>}
    </label>
  );
}
