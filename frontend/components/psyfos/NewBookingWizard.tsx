"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Banknote, CalendarCheck, Check, CheckCircle2, Clock, Copy, CreditCard, Link2, Loader2,
  MapPin, Receipt, Stethoscope, UserRound, Video, Wallet,
} from "lucide-react";
import api from "../../lib/api";
import { parseServiceDuration, sessionLengthOptions } from "../../lib/sessionLength";
import {
  SERVICE_CATEGORIES, ServiceOption, Therapist, categoryLabel, errMessage, fmtDay, fmtTime, localDate, money,
} from "../../lib/psyfos";
import Modal, { FieldLabel } from "./Modal";
import CaseStatusChip from "./CaseStatusChip";

// The receptionist's intake flow, start to finish, in one dialog:
//   client details -> service -> therapist -> date & time -> payment / confirmation
// Everything is saved by the same POST /appointments/manual the rest of the
// dashboard uses, so slot locking, per-therapist pricing, invoicing and client
// notifications behave exactly as they do everywhere else.

export interface BookingPrefill { name?: string; phone?: string; email?: string; notes?: string }

type PayChoice = "LINK" | "DESK" | "NOW";

const STEPS = ["Client", "Service", "Therapist", "Date & time", "Payment"];
const PAY_METHODS = [
  { value: "CASH", label: "Cash", icon: Banknote },
  { value: "UPI", label: "UPI", icon: Wallet },
  { value: "CARD", label: "Card", icon: CreditCard },
  { value: "MANUAL_TRANSFER", label: "Bank transfer", icon: Receipt },
];

export default function NewBookingWizard({
  prefill, onClose, onBooked,
}: { prefill?: BookingPrefill; onClose: () => void; onBooked?: (appointment: any) => void }) {
  const [step, setStep] = useState(1);

  // 1 · client
  const [name, setName] = useState(prefill?.name ?? "");
  const [phone, setPhone] = useState(prefill?.phone ?? "");
  const [email, setEmail] = useState(prefill?.email ?? "");
  const [notes, setNotes] = useState(prefill?.notes ?? "");
  const [lookup, setLookup] = useState<any | null>(null);

  // 2 · service
  const [options, setOptions] = useState<ServiceOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [category, setCategory] = useState<string>("ALL");
  const [service, setService] = useState<ServiceOption | null>(null);

  // 3 · therapist
  const [therapistId, setTherapistId] = useState<number | null>(null);

  // 4 · date & time
  const [mode, setMode] = useState<"OFFLINE" | "ONLINE">("OFFLINE");
  const [duration, setDuration] = useState(60);
  const [date, setDate] = useState(localDate());
  const [time, setTime] = useState("");
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  // 5 · payment
  const [pay, setPay] = useState<PayChoice>("DESK");
  const [payMethod, setPayMethod] = useState("CASH");
  const [payAmount, setPayAmount] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ appointment: any; paidNow: number | null; paymentNote?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Service catalogue (who offers what, at what price)
  useEffect(() => {
    api.get("/appointments/service-options")
      .then(r => setOptions(r.data ?? []))
      .catch(() => setError("Couldn't load the services. Check your connection and try again."))
      .finally(() => setOptionsLoading(false));
  }, []);

  // Returning-client lookup, debounced on the phone number
  const lookedUp = useRef("");
  useEffect(() => {
    const p = phone.trim();
    if (p.length < 6 || p === lookedUp.current) return;
    const t = setTimeout(() => {
      lookedUp.current = p;
      api.get("/patients/lookup", { params: { phone: p } })
        .then(r => {
          setLookup(r.data?.exists ? r.data.patient : null);
          if (r.data?.exists) {
            setName(n => n.trim() ? n : r.data.patient.name);
            setEmail(e => e.trim() ? e : (r.data.patient.email ?? ""));
          }
        })
        .catch(() => setLookup(null));
    }, 450);
    return () => clearTimeout(t);
  }, [phone]);

  const therapist = service?.therapists.find(t => t.id === therapistId) ?? null;
  const offeredModes = useMemo(() => {
    const m: ("OFFLINE" | "ONLINE")[] = [];
    if (therapist?.offlineOffered) m.push("OFFLINE");
    if (therapist?.onlineOffered) m.push("ONLINE");
    return m;
  }, [therapist]);

  const price = therapist ? (mode === "ONLINE" ? therapist.onlinePrice : therapist.offlinePrice) ?? 0 : 0;
  const defaultMinutes = service ? parseServiceDuration(service.duration) : 60;

  // Keep mode & duration consistent with the chosen service / therapist
  useEffect(() => { if (service) setDuration(defaultMinutes); }, [service, defaultMinutes]);
  useEffect(() => {
    if (therapist && offeredModes.length && !offeredModes.includes(mode)) setMode(offeredModes[0]);
  }, [therapist, offeredModes, mode]);
  useEffect(() => { setPayAmount(price ? String(price) : ""); }, [price]);

  // Free slots for the chosen therapist/day/mode/length
  useEffect(() => {
    if (step !== 4 || !therapistId || !date) return;
    let cancelled = false;
    setSlotsLoading(true);
    api.get(`/appointments/therapists/${therapistId}/slots`, { params: { date, mode, duration } })
      .then(r => { if (!cancelled) setSlots(r.data ?? []); })
      .catch(() => { if (!cancelled) setSlots([]); })
      .finally(() => { if (!cancelled) setSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [step, therapistId, date, mode, duration]);
  useEffect(() => { if (time && !slotsLoading && !slots.includes(time)) setTime(""); }, [slots, time, slotsLoading]);

  const visibleCategories = SERVICE_CATEGORIES.filter(c => options.some(o => o.category === c.value));
  const shownServices = options.filter(o => category === "ALL" || o.category === category);

  const canNext =
    step === 1 ? name.trim().length > 0 && phone.trim().length > 0 :
    step === 2 ? !!service :
    step === 3 ? !!therapistId :
    step === 4 ? !!date && !!time : true;

  const next = () => { setError(""); if (canNext && step < 5) setStep(step + 1); };
  const back = () => { setError(""); if (step > 1) setStep(step - 1); };

  const confirm = async () => {
    if (!service || !therapistId || !time) return;
    setError("");
    setSaving(true);
    try {
      const res = await api.post("/appointments/manual", {
        patientName: name.trim(),
        patientEmail: email.trim() || undefined,
        patientPhone: phone.trim(),
        appointmentDate: date,
        startTime: `${time}:00`,
        sessionType: String(service.serviceId),
        notes: notes.trim() || undefined,
        mode,
        staffId: therapistId,
        paymentHandledBy: pay === "LINK" ? "SELF" : "RECEPTION",
        durationMinutes: duration !== defaultMinutes ? duration : undefined,
      });
      const appointment = res.data;
      let paidNow: number | null = null;
      let paymentNote: string | undefined;

      // "Paid now": record the money straight away against the new invoice.
      if (pay === "NOW" && (appointment.fee ?? 0) > 0) {
        try {
          const amount = Math.min(Number(payAmount) || 0, appointment.fee);
          if (amount > 0) {
            const inv = await api.get(`/invoices/appointment/${appointment.id}`);
            await api.post(`/invoices/${inv.data.id}/payments`, { amount: String(amount), paymentMethod: payMethod });
            paidNow = amount;
          }
        } catch (e) {
          paymentNote = `The session is booked, but the payment couldn't be recorded (${errMessage(e, "please add it from Pending Payments")}).`;
        }
      }
      setResult({ appointment, paidNow, paymentNote });
      onBooked?.(appointment);
    } catch (e) {
      setError(errMessage(e, "Couldn't book the session. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setStep(1); setName(""); setPhone(""); setEmail(""); setNotes(""); setLookup(null); lookedUp.current = "";
    setCategory("ALL"); setService(null); setTherapistId(null); setTime(""); setDate(localDate()); setResult(null); setError("");
    setPay("DESK");
  };

  // ── Done screen ────────────────────────────────────────────────────────────
  if (result) {
    const a = result.appointment;
    const link = typeof window !== "undefined" ? `${window.location.origin}/track/${a.trackingToken}` : "";
    return (
      <Modal title="Session booked" subtitle={`${a.patientName}`} icon={<CheckCircle2 style={{ width: 20, height: 20 }} />} onClose={onClose}
        footer={<>
          <button type="button" onClick={reset} className="btn-nm" style={{ padding: "10px 20px" }}>Book another</button>
          <button type="button" onClick={onClose} className="btn-nm-accent" style={{ padding: "10px 24px", fontWeight: 700 }}>Done</button>
        </>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
          <div className="soft-card-2" style={{ borderRadius: 16, padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {[
              ["When", `${fmtDay(a.appointmentDate)} · ${fmtTime(a.startTime)}`],
              ["Therapist", a.assignedDoctorName || "—"],
              ["Service", service?.name || "—"],
              ["Mode", a.mode === "ONLINE" ? "Online" : "In-person"],
              ["Fee", a.fee ? money(a.fee) : "No fee"],
              ["Status", a.status === "CONFIRMED" ? "Confirmed" : "Awaiting payment"],
            ].map(([k, v]) => (
              <div key={k}>
                <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)" }}>{k}</p>
                <p style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-1)", marginTop: 2 }}>{v}</p>
              </div>
            ))}
          </div>
          {result.paidNow !== null && (
            <p style={{ fontSize: 12.5, color: "var(--success)", background: "var(--success-bg)", padding: "9px 14px", borderRadius: 12, fontWeight: 600 }}>
              {money(result.paidNow)} collected{result.paidNow < (a.fee ?? 0) ? ` — ${money((a.fee ?? 0) - result.paidNow)} still due (see Pending Payments)` : " — paid in full"}.
            </p>
          )}
          {result.paymentNote && (
            <p style={{ fontSize: 12.5, color: "var(--warning)", background: "var(--warning-bg)", padding: "9px 14px", borderRadius: 12 }}>{result.paymentNote}</p>
          )}
          {a.status === "AWAITING_PAYMENT" && (
            <p style={{ fontSize: 12.5, color: "var(--text-2)" }}>The client has been sent a payment link by email / SMS. The slot is held until payment is verified.</p>
          )}
          <div className="soft-card-2" style={{ borderRadius: 14, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <Link2 style={{ width: 14, height: 14, color: "var(--accent)", flexShrink: 0 }} />
            <span style={{ fontSize: 11.5, color: "var(--text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{link}</span>
            <button type="button" className="icon-btn" title="Copy the client's tracking link"
              onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800); }}>
              {copied ? <Check style={{ width: 14, height: 14, color: "var(--success)" }} /> : <Copy style={{ width: 14, height: 14 }} />}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // ── Wizard ─────────────────────────────────────────────────────────────────
  return (
    <Modal
      title="New booking"
      subtitle="Client details → service → therapist → date & time → payment"
      icon={<CalendarCheck style={{ width: 20, height: 20 }} />}
      maxWidth={680}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={step === 1 ? onClose : back} className="btn-nm" style={{ padding: "10px 20px", gap: 6 }}>
            {step === 1 ? "Cancel" : <><ArrowLeft style={{ width: 14, height: 14 }} /> Back</>}
          </button>
          {step < 5 ? (
            <button type="button" onClick={next} disabled={!canNext} className="btn-nm-accent" style={{ padding: "10px 24px", fontWeight: 700, opacity: canNext ? 1 : 0.5, gap: 6 }}>
              Continue <ArrowRight style={{ width: 14, height: 14 }} />
            </button>
          ) : (
            <button type="button" onClick={confirm} disabled={saving} className="btn-nm-accent" style={{ padding: "10px 24px", fontWeight: 700 }}>
              {saving ? <><Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> Booking…</> : "Confirm booking"}
            </button>
          )}
        </>
      }
    >
      {/* Step indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0 20px", flexWrap: "wrap" }}>
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          const current = n === step;
          return (
            <React.Fragment key={label}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, fontWeight: 800,
                  background: done ? "var(--success)" : current ? "var(--accent)" : "var(--card-2)",
                  color: done || current ? "#fff" : "var(--text-3)",
                }}>
                  {done ? <Check style={{ width: 12, height: 12 }} /> : n}
                </span>
                <span style={{ fontSize: 12, fontWeight: current ? 800 : 600, color: current ? "var(--text-1)" : "var(--text-3)" }}>{label}</span>
              </div>
              {n < STEPS.length && <span style={{ flex: "0 0 14px", height: 1, background: "var(--card-border)" }} />}
            </React.Fragment>
          );
        })}
      </div>

      {/* 1 · Client details */}
      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <FieldLabel>Phone number *</FieldLabel>
              <input className="nm-input no-icon" value={phone} onChange={e => { setPhone(e.target.value); setLookup(null); lookedUp.current = ""; }}
                placeholder="98765 43210" inputMode="tel" autoFocus />
            </div>
            <div>
              <FieldLabel>Full name *</FieldLabel>
              <input className="nm-input no-icon" value={name} onChange={e => setName(e.target.value)} placeholder="Client's name" />
            </div>
          </div>
          {lookup && (
            <div className="soft-card-2" style={{ borderRadius: 14, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <UserRound style={{ width: 15, height: 15, color: "var(--accent)" }} />
              <span style={{ fontSize: 12.5, color: "var(--text-1)", fontWeight: 600 }}>Returning client</span>
              <CaseStatusChip status={lookup.caseStatus} size="sm" />
              <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                {lookup.sessions} session{lookup.sessions === 1 ? "" : "s"}{lookup.lastSessionDate ? ` · last seen ${fmtDay(lookup.lastSessionDate)}` : ""}
              </span>
            </div>
          )}
          <div>
            <FieldLabel hint="optional">Email</FieldLabel>
            <input className="nm-input no-icon" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="client@email.com" />
          </div>
          <div>
            <FieldLabel hint="optional">Reason for visit / notes</FieldLabel>
            <textarea className="nm-textarea" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="What brings them in? Anything the therapist should know." />
          </div>
        </div>
      )}

      {/* 2 · Service */}
      {step === 2 && (
        <div>
          {optionsLoading ? (
            <p style={{ fontSize: 13, color: "var(--text-3)" }}>Loading services…</p>
          ) : options.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--warning)", background: "var(--warning-bg)", padding: "12px 14px", borderRadius: 12 }}>
              No service is currently offered by any therapist. Set up services and prices under Staff → Schedule &amp; Pricing first.
            </p>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {[{ value: "ALL", label: "All" }, ...visibleCategories].map(c => (
                  <button key={c.value} type="button" onClick={() => setCategory(c.value)} className="tab-pill"
                    style={{
                      padding: "7px 14px", borderRadius: 50, fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
                      background: category === c.value ? "var(--accent)" : "var(--glass)",
                      color: category === c.value ? "#fff" : "var(--text-2)",
                    }}>
                    {c.label}
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                {shownServices.map(o => {
                  const active = service?.serviceId === o.serviceId;
                  const prices = o.therapists.flatMap(t => [t.offlineOffered ? t.offlinePrice : null, t.onlineOffered ? t.onlinePrice : null]).filter((p): p is number => p !== null);
                  const from = prices.length ? Math.min(...prices) : null;
                  return (
                    <button key={o.serviceId} type="button"
                      onClick={() => { setService(o); setTherapistId(o.therapists.length === 1 ? o.therapists[0].id : null); setTime(""); }}
                      className="soft-card-2 card-hover"
                      style={{
                        textAlign: "left", padding: "12px 14px", borderRadius: 14, cursor: "pointer",
                        border: `1.5px solid ${active ? "var(--accent)" : "transparent"}`, background: active ? "var(--accent-surface)" : undefined,
                      }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: active ? "var(--accent)" : "var(--text-1)" }}>{o.name}</span>
                        {active && <Check style={{ width: 15, height: 15, color: "var(--accent)" }} />}
                      </div>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--accent)" }}>{categoryLabel(o.category)}</span>
                        <span style={{ fontSize: 11, color: "var(--text-3)", display: "inline-flex", alignItems: "center", gap: 4 }}><Clock style={{ width: 11, height: 11 }} />{o.duration}</span>
                        {from !== null && <span style={{ fontSize: 11, color: "var(--text-3)" }}>from {money(from)}</span>}
                      </div>
                      <p style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
                        {o.therapists.length} therapist{o.therapists.length === 1 ? "" : "s"}
                      </p>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* 3 · Therapist */}
      {step === 3 && service && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ fontSize: 12.5, color: "var(--text-3)" }}>
            Therapists who offer <strong style={{ color: "var(--text-1)" }}>{service.name}</strong>:
          </p>
          {service.therapists.map(t => {
            const active = therapistId === t.id;
            return (
              <button key={t.id} type="button" onClick={() => { setTherapistId(t.id); setTime(""); }}
                className="soft-card-2 card-hover"
                style={{
                  textAlign: "left", padding: "12px 16px", borderRadius: 16, cursor: "pointer", display: "flex", alignItems: "center", gap: 14,
                  border: `1.5px solid ${active ? "var(--accent)" : "transparent"}`, background: active ? "var(--accent-surface)" : undefined,
                }}>
                <div className="team-avatar" style={{ width: 42, height: 42, borderRadius: "50%", fontSize: 16, flexShrink: 0 }}>
                  {(t.name ?? "?").charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 700, color: active ? "var(--accent)" : "var(--text-1)" }}>{t.name}</p>
                  <p style={{ fontSize: 11.5, color: "var(--text-3)" }}>{t.jobTitle || "Practitioner"}</p>
                </div>
                <div style={{ textAlign: "right", fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.6 }}>
                  {t.offlineOffered && <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}><MapPin style={{ width: 11, height: 11 }} />{money(t.offlinePrice)}</div>}
                  {t.onlineOffered && <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}><Video style={{ width: 11, height: 11 }} />{money(t.onlinePrice)}</div>}
                </div>
                {active && <Check style={{ width: 16, height: 16, color: "var(--accent)" }} />}
              </button>
            );
          })}
        </div>
      )}

      {/* 4 · Date & time */}
      {step === 4 && service && therapist && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <FieldLabel>Mode</FieldLabel>
              <div style={{ display: "flex", gap: 8 }}>
                {([{ v: "OFFLINE" as const, label: "In-person", Icon: MapPin }, { v: "ONLINE" as const, label: "Online", Icon: Video }]).map(({ v, label, Icon }) => {
                  const offered = offeredModes.includes(v);
                  return (
                    <button key={v} type="button" disabled={!offered} onClick={() => { setMode(v); setTime(""); }} className="btn-nm"
                      title={offered ? undefined : `${therapist.name} doesn't offer this service ${v === "ONLINE" ? "online" : "in person"}`}
                      style={{ flex: 1, padding: "10px 8px", gap: 6, fontSize: 12, opacity: offered ? 1 : 0.4, background: mode === v ? "var(--accent)" : undefined, color: mode === v ? "#fff" : undefined }}>
                      <Icon style={{ width: 12, height: 12 }} /> {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <FieldLabel>Session length</FieldLabel>
              <select className="nm-input no-icon" value={duration} onChange={e => { setDuration(Number(e.target.value)); setTime(""); }}>
                {sessionLengthOptions(defaultMinutes).map(o => <option key={o.value} value={o.value}>{o.label}{o.value === defaultMinutes ? " (service default)" : ""}</option>)}
              </select>
            </div>
          </div>
          <div>
            <FieldLabel>Date</FieldLabel>
            <input type="date" className="nm-input no-icon" value={date} min={localDate()} onChange={e => { setDate(e.target.value); setTime(""); }} />
          </div>
          <div>
            <FieldLabel>Available times — {therapist.name}</FieldLabel>
            {slotsLoading ? (
              <p style={{ fontSize: 12.5, color: "var(--text-3)" }}>Checking the calendar…</p>
            ) : slots.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--warning)", background: "var(--warning-bg)", padding: "10px 14px", borderRadius: 12 }}>
                Nothing free on {fmtDay(date)} for {mode === "ONLINE" ? "online" : "in-person"} sessions. Try another date.
              </p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {slots.map(s => (
                  <button key={s} type="button" onClick={() => setTime(s)}
                    style={{
                      padding: "9px 16px", borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: "pointer",
                      border: `1.5px solid ${time === s ? "var(--accent)" : "transparent"}`,
                      background: time === s ? "var(--accent-surface)" : "var(--card-2)", color: time === s ? "var(--accent)" : "var(--text-2)",
                    }}>
                    {fmtTime(s)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 5 · Payment & confirmation */}
      {step === 5 && service && therapist && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="soft-card-2" style={{ borderRadius: 16, padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {[
              ["Client", `${name}${phone ? ` · ${phone}` : ""}`],
              ["Service", `${service.name} (${categoryLabel(service.category)})`],
              ["Therapist", therapist.name ?? "—"],
              ["When", `${fmtDay(date)} · ${fmtTime(time)} · ${duration} min`],
              ["Mode", mode === "ONLINE" ? "Online" : "In-person"],
              ["Fee", price ? money(price) : "No fee"],
            ].map(([k, v]) => (
              <div key={k}>
                <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)" }}>{k}</p>
                <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text-1)", marginTop: 2 }}>{v}</p>
              </div>
            ))}
          </div>

          {price > 0 ? (
            <div>
              <FieldLabel>Payment</FieldLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {([
                  { v: "DESK" as const, title: "Collect at the front desk", sub: "Session is confirmed now; the balance shows in Pending Payments", icon: Stethoscope },
                  { v: "NOW" as const, title: "Client is paying now", sub: "Record the payment as part of this booking", icon: Banknote },
                  { v: "LINK" as const, title: "Send the client a payment link", sub: "Held as 'awaiting payment' until the client pays online", icon: Link2 },
                ]).map(o => (
                  <button key={o.v} type="button" onClick={() => setPay(o.v)}
                    style={{
                      textAlign: "left", padding: "11px 14px", borderRadius: 14, cursor: "pointer", display: "flex", gap: 12, alignItems: "center",
                      border: `1.5px solid ${pay === o.v ? "var(--accent)" : "transparent"}`, background: pay === o.v ? "var(--accent-surface)" : "var(--card-2)",
                    }}>
                    <o.icon style={{ width: 16, height: 16, color: pay === o.v ? "var(--accent)" : "var(--text-3)", flexShrink: 0 }} />
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 700, color: pay === o.v ? "var(--accent)" : "var(--text-1)" }}>{o.title}</p>
                      <p style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 1 }}>{o.sub}</p>
                    </div>
                  </button>
                ))}
              </div>

              {pay === "NOW" && (
                <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
                  <div>
                    <FieldLabel>Amount (₹)</FieldLabel>
                    <input type="number" className="nm-input no-icon" value={payAmount} min={1} max={price} onChange={e => setPayAmount(e.target.value)} />
                  </div>
                  <div>
                    <FieldLabel>Method</FieldLabel>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {PAY_METHODS.map(m => (
                        <button key={m.value} type="button" onClick={() => setPayMethod(m.value)}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 5, padding: "9px 11px", borderRadius: 10, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
                            border: `1.5px solid ${payMethod === m.value ? "var(--accent)" : "transparent"}`,
                            background: payMethod === m.value ? "var(--accent-surface)" : "var(--card-2)", color: payMethod === m.value ? "var(--accent)" : "var(--text-2)",
                          }}>
                          <m.icon style={{ width: 12, height: 12 }} /> {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p style={{ gridColumn: "1 / -1", fontSize: 11.5, color: "var(--text-3)" }}>
                    Enter less than {money(price)} to take a part-payment — the rest stays in Pending Payments.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--success)", background: "var(--success-bg)", padding: "10px 14px", borderRadius: 12, fontWeight: 600 }}>
              This service has no fee for this therapist, so the session is confirmed automatically.
            </p>
          )}
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 12px", borderRadius: 10, marginTop: 14 }}>{error}</p>}
    </Modal>
  );
}
