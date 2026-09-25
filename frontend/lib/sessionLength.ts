// Session length ("how long does one session run") — shared by the
// availability editor (slot spacing) and the manual-scheduling / past-session /
// edit-session forms (per-appointment length), so they all offer the same
// choices and agree on the limits. The backend enforces the same range
// (see SessionDurations.java) — these constants are for the UI, not a
// substitute for that check.

export const MIN_SESSION_MINUTES = 15;
export const MAX_SESSION_MINUTES = 240;
export const DEFAULT_SESSION_MINUTES = 60;

// Same labels the availability editor has always shown: "60 min", "90 min", "2 hrs".
export function formatSessionLength(minutes: number): string {
  return minutes > 60 && minutes % 60 === 0 ? `${minutes / 60} hrs` : `${minutes} min`;
}

const PRESET_MINUTES = [15, 30, 45, 50, 60, 75, 90, 120, 150, 180];

// The dropdown options. `current` (e.g. a service's own 40-minute length, or an
// existing appointment's odd length) is included when it isn't one of the
// presets, so the select never shows a blank for a value that is actually set.
export function sessionLengthOptions(current?: number | null): { value: number; label: string }[] {
  const values = current && !PRESET_MINUTES.includes(current) && current >= MIN_SESSION_MINUTES && current <= MAX_SESSION_MINUTES
    ? [...PRESET_MINUTES, current].sort((a, b) => a - b)
    : PRESET_MINUTES;
  return values.map(value => ({ value, label: formatSessionLength(value) }));
}

// Mirrors SessionDurations.parseServiceDuration on the backend: a service's
// free-text duration ("50 min", "1 hr", "1.5 hours", "1h30m") in minutes,
// DEFAULT_SESSION_MINUTES when it can't be understood or is out of range.
export function parseServiceDuration(text?: string | null): number {
  if (!text || !text.trim()) return DEFAULT_SESSION_MINUTES;
  const s = text.trim().toLowerCase();

  let total = 0;
  let found = false;
  const h = s.match(/(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)(?![a-z])/);
  if (h) { total += parseFloat(h[1]) * 60; found = true; }
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:minutes|minute|mins|min|m)(?![a-z])/);
  if (m) { total += parseFloat(m[1]); found = true; }
  if (!found) {
    const n = s.match(/(\d+(?:\.\d+)?)/);
    if (n) { total = parseFloat(n[1]); found = true; }
  }
  if (!found) return DEFAULT_SESSION_MINUTES;

  const minutes = Math.round(total);
  return minutes >= MIN_SESSION_MINUTES && minutes <= MAX_SESSION_MINUTES ? minutes : DEFAULT_SESSION_MINUTES;
}

function toMinuteOfDay(time?: string | null): number | null {
  const match = time?.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h * 60 + m;
}

// Whole minutes between two "HH:mm[:ss]" strings; 0 when either is missing or
// the range is empty (e.g. a demo-call placeholder stored as 00:00–00:00).
export function minutesBetween(start?: string | null, end?: string | null): number {
  const s = toMinuteOfDay(start);
  const e = toMinuteOfDay(end);
  if (s === null || e === null || e <= s) return 0;
  return e - s;
}

// "09:00" + 90 -> "10:30". Null if it would run past midnight (the backend
// refuses those too), so callers can hide the hint instead of showing "00:30".
export function addMinutesToTime(time: string, minutes: number): string | null {
  const s = toMinuteOfDay(time);
  if (s === null) return null;
  const end = s + minutes;
  if (end >= 24 * 60) return null;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}
