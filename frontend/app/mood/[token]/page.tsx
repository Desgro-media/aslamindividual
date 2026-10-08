"use client";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, Heart } from "lucide-react";

const MOOD_EMOJIS = ["😞", "😟", "😕", "😐", "🙂", "😊", "😄", "😁", "🤩", "🥳"];
const MOOD_LABELS = [
  "Very Low", "Low", "Not Great", "Neutral", "Okay",
  "Good", "Pretty Good", "Great", "Excellent", "Amazing!"
];
const MOOD_COLORS = [
  "#ef4444", "#f87171", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#10b981", "#06b6d4", "#6366f1"
];

export default function MoodCheckInPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [selected, setSelected]   = useState<number | null>(null);
  const [note, setNote]           = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]  = useState(false);
  const [error, setError]          = useState("");

  const handleSubmit = async () => {
    if (selected === null) { setError("Please select a mood first."); return; }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "/api/v1"}/mood`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackingToken: token, moodScore: selected + 1, note }),
      });
      if (!res.ok) throw new Error("Failed to submit");
      setSubmitted(true);
    } catch (e) {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div style={{
        minHeight: "100vh", background: "var(--bg)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
      }}>
        <div className="nm-raised anim-fade-up" style={{
          borderRadius: 32, padding: 48, maxWidth: 480, width: "100%", textAlign: "center",
        }}>
          <div style={{ fontSize: 72, marginBottom: 24 }}>{MOOD_EMOJIS[selected!]}</div>
          <div className="nm-inset-sm" style={{
            width: 64, height: 64, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 24px",
          }}>
            <CheckCircle2 style={{ width: 30, height: 30, color: "#22c55e" }} />
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-1)", marginBottom: 8 }}>Thank you!</h1>
          <p style={{ fontSize: 15, color: "var(--text-2)", lineHeight: 1.6 }}>
            Your mood has been recorded. Your doctor will review your progress at your next session. 💙
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20,
    }}>
      <div className="nm-raised anim-fade-up" style={{
        borderRadius: 32, padding: "40px 36px", maxWidth: 560, width: "100%",
        display: "flex", flexDirection: "column", gap: 32,
      }}>
        {/* Header */}
        <div style={{ textAlign: "center" }}>
          <div className="nm-inset-sm" style={{
            width: 64, height: 64, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 20px",
          }}>
            <Heart style={{ width: 28, height: 28, color: "var(--accent)" }} />
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-1)", marginBottom: 8 }}>
            How are you feeling?
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-3)", lineHeight: 1.6 }}>
            After your session today, take a moment to check in. Your response helps your doctor track your progress.
          </p>
        </div>

        {/* Mood Selector */}
        <div>
          <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 16, textAlign: "center" }}>
            Tap your mood (1 = Very Low, 10 = Amazing)
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
            {MOOD_EMOJIS.map((emoji, i) => (
              <button key={i} onClick={() => { setSelected(i); setError(""); }}
                style={{
                  padding: "14px 8px", borderRadius: 18, border: "none", cursor: "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                  background: selected === i ? `${MOOD_COLORS[i]}18` : "transparent",
                  outline: selected === i ? `2.5px solid ${MOOD_COLORS[i]}` : "none",
                  transform: selected === i ? "scale(1.08)" : "scale(1)",
                  transition: "all 0.2s ease",
                  boxShadow: selected === i
                    ? `0 4px 16px ${MOOD_COLORS[i]}30`
                    : "inset 2px 2px 5px var(--sd), inset -2px -2px 5px var(--sl)",
                }}>
                <span style={{ fontSize: 28, lineHeight: 1 }}>{emoji}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: selected === i ? MOOD_COLORS[i] : "var(--text-3)" }}>
                  {i + 1}
                </span>
              </button>
            ))}
          </div>

          {selected !== null && (
            <div style={{
              marginTop: 16, padding: "10px 20px", borderRadius: 12, textAlign: "center",
              background: `${MOOD_COLORS[selected]}12`, border: `1px solid ${MOOD_COLORS[selected]}30`,
              transition: "all 0.3s",
            }}>
              <p style={{ fontSize: 15, fontWeight: 700, color: MOOD_COLORS[selected] }}>
                {MOOD_LABELS[selected]}
              </p>
            </div>
          )}
        </div>

        {/* Optional Note */}
        <div>
          <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
            Anything you&apos;d like to share? (optional)
          </p>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="How are you feeling? Any thoughts about today's session..."
            rows={3}
            className="nm-inset"
            style={{
              width: "100%", borderRadius: 16, padding: "14px 16px",
              border: "none", fontSize: 14, color: "var(--text-1)",
              background: "transparent", resize: "none", outline: "none",
              fontFamily: "inherit", lineHeight: 1.6, boxSizing: "border-box",
            }}
          />
        </div>

        {error && (
          <p style={{ color: "#ef4444", fontSize: 13, textAlign: "center", marginTop: -16 }}>{error}</p>
        )}

        {/* Submit */}
        <button onClick={handleSubmit} disabled={submitting || selected === null}
          style={{
            padding: "16px", borderRadius: 16, border: "none", cursor: selected === null ? "not-allowed" : "pointer",
            background: selected !== null ? MOOD_COLORS[selected] : "var(--text-3)",
            color: "#fff", fontWeight: 700, fontSize: 15, transition: "all 0.3s",
            opacity: submitting ? 0.7 : 1,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
          {submitting ? "Submitting..." : `Submit${selected !== null ? ` — ${MOOD_EMOJIS[selected]} ${MOOD_LABELS[selected]}` : ""}`}
        </button>

        <p style={{ textAlign: "center", fontSize: 11, color: "var(--text-3)", marginTop: -16 }}>
          🔒 Your response is private and only visible to your doctor.
        </p>
      </div>
    </div>
  );
}
