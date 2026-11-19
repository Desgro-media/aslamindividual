"use client";

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { addMinutesToTime, format12, formatSessionLength, minutesBetween, sessionRangeError, toHm } from "../lib/sessionLength";
import { getTimeCheck, TimeCheck } from "../lib/profileApi";
import TimeField12 from "./TimeField12";

// The doctor types when the session starts and when it ends — nothing is picked
// from a fixed grid, because real sessions don't run to a fixed length. Used by
// the schedule, add-past-session and edit-session forms.
//
//  - Typing a Start moves the End with it (the length is kept); the first Start
//    fills End with `defaultMinutes` until the doctor sets an End of their own.
//  - Quick-length chips set End from Start in one tap.
//  - `suggestions` (optional) are the doctor's usual open start times, offered as
//    one-tap starts — only a shortcut, never a restriction.
//  - `check` (optional) asks the server about the typed range on that date: an
//    overlap with another session is shown as an error, hours/holiday/leave/past
//    as warnings the doctor can ignore.

const QUICK_LENGTHS = [30, 45, 50, 60, 90];

const labelStyle = (compact: boolean): React.CSSProperties => compact
  ? { display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6, textTransform: "uppercase" }
  : { display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 };

export default function SessionTimeRange({
  start, end, onChange, defaultMinutes, suggestions, suggestionsLoading = false, check, onCheck, compact = false,
}: {
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
  /** Length to fill End with when only Start has been typed. */
  defaultMinutes?: number;
  suggestions?: string[];
  suggestionsLoading?: boolean;
  check?: { date: string; mode: "ONLINE" | "OFFLINE"; staffId?: number } | null;
  /** Called with each server verdict (null while unknown) so the form can block saving on a conflict. */
  onCheck?: (result: TimeCheck | null) => void;
  compact?: boolean;
}) {
  const startHm = toHm(start);
  const endHm = toHm(end);
  const length = minutesBetween(startHm, endHm);
  const rangeError = sessionRangeError(startHm, endHm);
  const rangeOk = !!startHm && !!endHm && !rangeError;

  // Once the doctor has chosen an End themselves (or the form opened with one),
  // a changed default (another service, availability finishing loading) no
  // longer overwrites it.
  const endLocked = useRef(Boolean(endHm));

  const fillFromDefault = (s: string) => (defaultMinutes ? addMinutesToTime(s, defaultMinutes) ?? "" : "");

  useEffect(() => {
    if (endLocked.current || !startHm || !defaultMinutes) return;
    const next = addMinutesToTime(startHm, defaultMinutes) ?? "";
    if (next !== endHm) onChange(startHm, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultMinutes]);

  const changeStart = (value: string) => {
    if (!value) { onChange("", endHm); return; }
    if (rangeOk) {
      // Keep the session length: moving Start moves End with it.
      const shifted = addMinutesToTime(value, length);
      onChange(value, shifted ?? endHm);
    } else if (!endHm || !endLocked.current) {
      onChange(value, fillFromDefault(value));
    } else {
      onChange(value, endHm);
    }
  };

  const changeEnd = (value: string) => {
    endLocked.current = true;
    onChange(startHm, value);
  };

  const pickLength = (minutes: number) => {
    if (!startHm) return;
    endLocked.current = true;
    onChange(startHm, addMinutesToTime(startHm, minutes) ?? endHm);
  };

  // ── Live calendar check (debounced; a reply for an earlier range is dropped) ──
  const [result, setResult] = useState<TimeCheck | null>(null);
  const checkKey = check && rangeOk ? `${check.date}|${check.mode}|${check.staffId ?? 0}|${startHm}|${endHm}` : "";
  const onCheckRef = useRef(onCheck);
  onCheckRef.current = onCheck;

  useEffect(() => {
    if (!check || !checkKey) { setResult(null); onCheckRef.current?.(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      getTimeCheck(check.date, startHm, endHm, check.mode, check.staffId)
        .then(r => { if (!cancelled) { setResult(r); onCheckRef.current?.(r); } })
        .catch(() => { if (!cancelled) { setResult(null); onCheckRef.current?.(null); } });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);

  const lengthLabel = rangeOk ? formatSessionLength(length) : "";

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <span style={labelStyle(compact)}>Start</span>
          <TimeField12 label="Start time" value={startHm} onChange={changeStart} compact={compact} />
        </div>
        <div>
          <span style={labelStyle(compact)}>End</span>
          <TimeField12 label="End time" value={endHm} onChange={changeEnd} compact={compact} />
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 600 }}>Length</span>
        {QUICK_LENGTHS.map(m => {
          const active = rangeOk && length === m;
          return (
            <button
              key={m} type="button" onClick={() => pickLength(m)} disabled={!startHm}
              style={{
                padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: startHm ? "pointer" : "not-allowed",
                border: `1.5px solid ${active ? "var(--accent)" : "transparent"}`,
                background: active ? "var(--accent-surface)" : "var(--bg)",
                color: active ? "var(--accent)" : "var(--text-2)", opacity: startHm ? 1 : 0.5,
              }}
            >
              {m} min
            </button>
          );
        })}
      </div>

      {rangeError ? (
        <p role="alert" style={{ fontSize: 12, color: "var(--danger)", fontWeight: 600, marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
          <AlertTriangle style={{ width: 13, height: 13, flexShrink: 0 }} /> {rangeError}
        </p>
      ) : rangeOk ? (
        <p style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
          <Clock style={{ width: 13, height: 13, flexShrink: 0 }} /> Session runs {format12(startHm)} – {format12(endHm)} ({lengthLabel})
        </p>
      ) : null}

      {result?.conflict && (
        <p role="alert" style={{ fontSize: 12, color: "var(--danger)", fontWeight: 600, marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
          <AlertTriangle style={{ width: 13, height: 13, flexShrink: 0 }} />
          Overlaps another session on this calendar ({format12(result.conflict.startTime)} – {format12(result.conflict.endTime)}). Change the start or end.
        </p>
      )}
      {!result?.conflict && result?.warnings.map(w => (
        <p key={w} style={{ fontSize: 12, color: "var(--warning)", fontWeight: 600, marginTop: 6, display: "flex", gap: 6, alignItems: "flex-start" }}>
          <AlertTriangle style={{ width: 13, height: 13, flexShrink: 0, marginTop: 1 }} /> {w} You can still book it.
        </p>
      ))}

      {suggestions !== undefined && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", marginBottom: 6 }}>
            Usual open start times <span style={{ fontWeight: 400 }}>(tap to use — or type any time above)</span>
          </p>
          {suggestionsLoading ? (
            <p style={{ fontSize: 12, color: "var(--text-3)" }}>Checking available times…</p>
          ) : suggestions.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-3)" }}>None for this date — type the times you want above.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {suggestions.map(t => (
                <button
                  key={t} type="button" onClick={() => changeStart(t)}
                  style={{
                    padding: "5px 11px", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none",
                    background: startHm === t ? "var(--accent)" : "var(--bg)", color: startHm === t ? "#fff" : "var(--text-2)",
                  }}
                >
                  {format12(t)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
