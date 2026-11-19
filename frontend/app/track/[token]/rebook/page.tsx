"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import ThemeToggle from "../../../../components/ThemeToggle";
import {
  RotateCcw, ChevronLeft, ChevronRight, Loader2,
  Calendar, Clock, CheckCircle2, ArrowLeft, Shield
} from "lucide-react";
import api from "../../../../lib/api";
import { format, isBefore, isToday, isSameDay, startOfMonth, endOfMonth, eachDayOfInterval, getDay } from "date-fns";

// ── Mini Calendar ───────────────────────────────────────────────────────────
function MiniCalendar({ selected, onSelect }: { selected: Date | null; onSelect: (d: Date) => void }) {
  const [viewDate, setViewDate] = useState(new Date());
  const today = new Date();
  const days = eachDayOfInterval({ start: startOfMonth(viewDate), end: endOfMonth(viewDate) });
  const startPad = getDay(startOfMonth(viewDate));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <button
          onClick={() => setViewDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          className="btn-nm" style={{ width: 32, height: 32, borderRadius: "50%", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <ChevronLeft style={{ width: 14, height: 14, color: "var(--text-2)" }} />
        </button>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-1)" }}>
          {format(viewDate, "MMMM yyyy")}
        </span>
        <button
          onClick={() => setViewDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          className="btn-nm" style={{ width: 32, height: 32, borderRadius: "50%", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <ChevronRight style={{ width: 14, height: 14, color: "var(--text-2)" }} />
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 8 }}>
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", padding: "4px 0" }}>{d}</div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", rowGap: 4 }}>
        {Array(startPad).fill(null).map((_, i) => <div key={`pad-${i}`} />)}
        {days.map(day => {
          const past = isBefore(day, today) && !isToday(day);
          const sel = selected ? isSameDay(day, selected) : false;
          const todayD = isToday(day);
          return (
            <div key={day.toISOString()} style={{ display: "flex", justifyContent: "center" }}>
              <button
                disabled={past}
                onClick={() => onSelect(day)}
                className={`cal-day-nm ${past ? "cal-disabled" : ""} ${sel ? "cal-selected" : ""} ${todayD && !sel ? "cal-today" : ""}`}
              >
                {format(day, "d")}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function RebookPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedTime, setSelectedTime] = useState<string>("");
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [originalAppt, setOriginalAppt] = useState<any>(null);

  useEffect(() => {
    api.get(`/track/${token}`).then(res => setOriginalAppt(res.data)).catch(() => {});
  }, [token]);

  const fetchSlots = useCallback(async (date: Date) => {
    if (!originalAppt?.psychologistSlug) return;
    setSlotsLoading(true);
    setSelectedTime("");
    try {
      const dateStr = format(date, "yyyy-MM-dd");
      // A rebooking keeps the cancelled session's length (which may be a custom one
      // the doctor set), so only offer starts where that whole session fits.
      const [sh, sm] = String(originalAppt.startTime ?? "").split(":").map(Number);
      const [eh, em] = String(originalAppt.endTime ?? "").split(":").map(Number);
      const length = (eh * 60 + em) - (sh * 60 + sm);
      const durationParam = Number.isFinite(length) && length >= 15 && length <= 240 ? `&duration=${length}` : "";
      const res = await api.get(`/public/${originalAppt.psychologistSlug}/slots?date=${dateStr}${durationParam}`);
      setAvailableSlots(Array.isArray(res.data) ? res.data : []);
    } catch {
      setAvailableSlots([]);
    } finally {
      setSlotsLoading(false);
    }
  }, [originalAppt]);

  useEffect(() => {
    if (selectedDate) fetchSlots(selectedDate);
  }, [selectedDate, fetchSlots]);

  const formatTime = (t: string) => {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const hr = h % 12 || 12;
    return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  const handleSubmit = async () => {
    if (!selectedDate || !selectedTime) {
      setError("Please select both a date and a time slot.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await api.post(`/track/${token}/rebook`, {
        newAppointmentDate: format(selectedDate, "yyyy-MM-dd"),
        newStartTime: selectedTime,
      });
      router.push(`/track/${res.data.trackingToken}`);
    } catch (err: any) {
      setError(
        err.response?.data?.message ||
          "Failed to rebook. Please try a different slot or contact the clinic."
      );
      setLoading(false);
    }
  };

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", paddingBottom: 60 }}>
      
      {/* Nav */}
      <nav style={{ padding: "20px 28px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link
          href={`/track/${token}`}
          style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
        >
          <div className="btn-nm" style={{ width: 36, height: 36, borderRadius: "50%", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ArrowLeft style={{ width: 15, height: 15, color: "var(--text-2)" }} />
          </div>
          <span style={{ fontSize: 13, color: "var(--text-2)", fontWeight: 500 }}>Back</span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Shield style={{ width: 14, height: 14, color: "var(--accent)" }} />
            <span style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "monospace" }}>…{token?.slice(-8)}</span>
          </div>
          <ThemeToggle />
        </div>
      </nav>

      <div style={{ width: "100%", maxWidth: 640, margin: "0 auto", padding: "20px" }}>
        
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 32 }} className="anim-fade-up">
          <div style={{ margin: "0 auto 20px", width: 64, height: 64, borderRadius: "50%", background: "var(--bg)", boxShadow: "5px 5px 12px var(--sd), -5px -5px 12px var(--sl)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div className="nm-inset" style={{ width: 44, height: 44, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <RotateCcw style={{ width: 20, height: 20, color: "var(--accent)" }} />
            </div>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-1)", marginBottom: 12 }}>Book a New Slot</h1>
          <p style={{ fontSize: 14, color: "var(--text-2)", maxWidth: 400, margin: "0 auto", lineHeight: 1.6 }}>
            Choose a new date and time for your appointment. Your personal details will be carried over automatically.
          </p>
        </div>

        {/* Original appt context */}
        {originalAppt && (
          <div className="nm-inset anim-fade-up d1" style={{ borderRadius: 20, padding: 20, display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 24 }}>
            <div className="nm-raised-sm" style={{ width: 36, height: 36, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
              <Calendar style={{ width: 16, height: 16, color: "var(--danger)" }} />
            </div>
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: "var(--danger)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Previously Cancelled</p>
              <p style={{ fontSize: 14, color: "var(--text-1)" }}>
                {originalAppt.appointmentDate && format(new Date(originalAppt.appointmentDate), "MMM d, yyyy")}
                {originalAppt.startTime && ` at ${originalAppt.startTime}`}
              </p>
            </div>
          </div>
        )}

        {/* Form card */}
        <div className="nm-raised-lg anim-scale-in d2" style={{ borderRadius: 28, padding: 32 }}>
          
          {error && (
            <div className="anim-fade-in nm-inset-sm" style={{ borderRadius: 12, padding: "12px 16px", marginBottom: 24, color: "var(--danger)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, marginBottom: 32 }}>
            
            {/* Calendar */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
                <Calendar style={{ width: 14, height: 14, color: "var(--accent)" }} /> Pick a Date
              </p>
              <div className="cal-container">
                <MiniCalendar selected={selectedDate} onSelect={setSelectedDate} />
              </div>
            </div>

            {/* Time slots */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
                <Clock style={{ width: 14, height: 14, color: "var(--accent)" }} />
                {selectedDate ? `Times · ${format(selectedDate, "EEE, MMM d")}` : "Select a date"}
              </p>

              {!selectedDate && (
                <div className="nm-inset-sm" style={{ height: 260, borderRadius: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-3)" }}>
                  <Calendar style={{ width: 32, height: 32, marginBottom: 12, opacity: 0.5 }} />
                  <span style={{ fontSize: 13 }}>Choose a date to see slots</span>
                </div>
              )}

              {selectedDate && slotsLoading && (
                <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Loader2 style={{ width: 24, height: 24, color: "var(--accent)", animation: "spinSlow 1s linear infinite" }} />
                </div>
              )}

              {selectedDate && !slotsLoading && availableSlots.length === 0 && (
                <div className="nm-inset-sm" style={{ height: 260, borderRadius: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-3)" }}>
                  <Clock style={{ width: 32, height: 32, marginBottom: 12, opacity: 0.5 }} />
                  <span style={{ fontSize: 13 }}>No slots available</span>
                  <span style={{ fontSize: 11, marginTop: 4 }}>Try another date</span>
                </div>
              )}

              {selectedDate && !slotsLoading && availableSlots.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxHeight: 260, overflowY: "auto", padding: "4px 8px 4px 4px" }}>
                  {availableSlots.map(slot => (
                    <button
                      key={slot}
                      onClick={() => setSelectedTime(slot)}
                      className={`time-nm ${selectedTime === slot ? "time-selected" : ""}`}
                      style={{ padding: "12px 0" }}
                    >
                      {formatTime(slot)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Selected summary */}
          {selectedDate && selectedTime && (
            <div className="nm-inset anim-fade-in" style={{ borderRadius: 16, padding: "16px 20px", marginBottom: 24, display: "flex", alignItems: "center", gap: 12 }}>
              <CheckCircle2 style={{ width: 20, height: 20, color: "var(--accent)", flexShrink: 0 }} />
              <div style={{ fontSize: 13 }}>
                <span style={{ color: "var(--text-3)" }}>New slot: </span>
                <strong style={{ color: "var(--text-1)" }}>
                  {format(selectedDate, "EEEE, MMM d")} at {formatTime(selectedTime)}
                </strong>
              </div>
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={loading || !selectedDate || !selectedTime}
            className="btn-nm-accent"
            style={{ width: "100%" }}
          >
            {loading ? (
              <><Loader2 style={{ width: 16, height: 16, animation: "spinSlow 1s linear infinite" }} /> Rebooking…</>
            ) : (
              <><CheckCircle2 style={{ width: 16, height: 16 }} /> Confirm New Booking</>
            )}
          </button>
        </div>

        <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-3)", marginTop: 24 }}>
          Your personal details (name, email, phone) are carried over from your previous booking.
        </p>
      </div>
    </div>
  );
}
