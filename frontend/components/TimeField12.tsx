"use client";

import React, { useEffect, useRef, useState } from "react";
import { from12, Meridiem, parts12 } from "../lib/sessionLength";

// A time of day typed as hour : minute with an explicit AM / PM toggle. The
// browser's own <input type="time"> follows the computer's clock setting — on a
// 24-hour setup it shows no AM/PM at all, so "02:01" silently meant 2 AM. This
// looks and behaves the same everywhere.
//
// `value` and `onChange` use 24-hour "HH:mm" (the form's internal format), so
// nothing downstream changes. onChange gets "" while the time is incomplete or
// out of range; what's being typed is kept until it becomes valid again.
//
// Typing helpers: a 24-hour hour (13–23) is turned into its PM equivalent, and
// pressing A or P in the box sets AM / PM.
export default function TimeField12({ value, onChange, label, compact = false }: {
  value: string;
  onChange: (value: string) => void;
  /** e.g. "Start time" — names the group and its parts for screen readers */
  label: string;
  compact?: boolean;
}) {
  const initial = parts12(value);
  const [hour, setHour] = useState(initial.hour);
  const [minute, setMinute] = useState(initial.minute);
  const [mer, setMer] = useState<Meridiem>(initial.mer);
  const minuteRef = useRef<HTMLInputElement>(null);

  // Follow changes made from outside (End filled from the length, a length chip,
  // a suggested start). An empty value never wipes what's being typed.
  useEffect(() => {
    if (!value || from12(hour, minute, mer) === value) return;
    const p = parts12(value);
    setHour(p.hour); setMinute(p.minute); setMer(p.mer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (h: string, m: string, ap: Meridiem) => onChange(from12(h, m, ap));

  const changeHour = (raw: string) => {
    let digits = raw.replace(/\D/g, "").slice(0, 2);
    let ap = mer;
    const n = Number(digits);
    if (digits.length === 2 && n >= 13 && n <= 23) {        // typed 24-hour, e.g. 14 -> 2 PM
      digits = String(n - 12); ap = "PM";
    } else if (digits === "00") {                            // 00 -> 12 AM
      digits = "12"; ap = "AM";
    } else if (digits.length === 2 && n > 12) {              // not a time — keep the first digit
      digits = digits.slice(0, 1);
    }
    setHour(digits); setMer(ap);
    commit(digits, minute, ap);
    // Hour is done once it can't grow: two digits, or a single digit of 2–9.
    if (digits.length === 2 || (digits.length === 1 && Number(digits) >= 2)) minuteRef.current?.focus();
  };

  const changeMinute = (raw: string) => {
    let digits = raw.replace(/\D/g, "").slice(0, 2);
    if (digits.length === 2 && Number(digits) > 59) digits = digits.slice(0, 1);
    setMinute(digits);
    commit(hour, digits, mer);
  };

  const finishMinute = () => {
    if (minute.length === 1) {                               // "5" -> "05"
      const padded = `0${minute}`;
      setMinute(padded);
      commit(hour, padded, mer);
    }
  };

  const pickMer = (ap: Exclude<Meridiem, "">) => { setMer(ap); commit(hour, minute, ap); };

  // A / P anywhere in the box sets AM / PM, like the native control.
  const keyShortcut = (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === "a" || k === "p") { e.preventDefault(); pickMer(k === "a" ? "AM" : "PM"); }
  };

  return (
    <div
      role="group" aria-label={label} className="nm-input no-icon time12"
      style={compact ? { padding: "8px 10px", borderRadius: 12 } : undefined}
    >
      <input
        aria-label={`${label} hour`} placeholder="hh" inputMode="numeric" autoComplete="off"
        value={hour} onChange={e => changeHour(e.target.value)} onKeyDown={keyShortcut} onFocus={e => e.target.select()}
      />
      <span aria-hidden style={{ fontWeight: 700, color: "var(--text-3)" }}>:</span>
      <input
        ref={minuteRef} aria-label={`${label} minute`} placeholder="mm" inputMode="numeric" autoComplete="off"
        value={minute} onChange={e => changeMinute(e.target.value)} onBlur={finishMinute} onKeyDown={keyShortcut} onFocus={e => e.target.select()}
      />
      <span className="time12-mer">
        {(["AM", "PM"] as const).map(ap => (
          <button key={ap} type="button" aria-label={`${label} ${ap}`} aria-pressed={mer === ap} onClick={() => pickMer(ap)}>
            {ap}
          </button>
        ))}
      </span>
    </div>
  );
}
