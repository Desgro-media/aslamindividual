"use client";

import React, { useEffect, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Calendar, Clock, CheckCircle2,
  XCircle, Hourglass, FileText, ChevronDown, ChevronUp,
  Search, ArrowDownUp, AlertCircle, Phone, Mail, Check,
  Download, Plus, BrainCircuit, TrendingUp, Star,
  Lock, Pencil, Save, Trash2, DollarSign, Smile, X, RefreshCw,
  Paperclip, Loader2, UploadCloud, Video, MapPin, Stethoscope, Activity, CalendarClock, CalendarCheck,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval,
  format as dfmt, isSameDay, isToday, isAfter, isSameMonth, addMonths, subMonths, parseISO,
} from "date-fns";
import api from "../../../../lib/api";
import { CHART, useThemeMode, SeriesTooltip } from "../../../../lib/chartTheme";
import { SpotlightDiv } from "../../../../components/Spotlight";
import CaseStatusChip from "../../../../components/psyfos/CaseStatusChip";
import CaseStatusModal from "../../../../components/psyfos/CaseStatusModal";
import SetFollowUpModal from "../../../../components/psyfos/SetFollowUpModal";
import FollowUpBookModal from "../../../../components/psyfos/FollowUpBookModal";
import NewBookingWizard from "../../../../components/psyfos/NewBookingWizard";
import { caseStatusMeta, fmtDay as psyFmtDay, fmtTime as psyFmtTime, relativeDay as psyRelativeDay, type FollowUp as PsyFollowUp } from "../../../../lib/psyfos";
import { getMySlots, getMyServices, getAvailabilityBlocks, DoctorServicePrice, AvailabilityBlock } from "../../../../lib/profileApi";
import {
  MIN_SESSION_MINUTES, MAX_SESSION_MINUTES, DEFAULT_SESSION_MINUTES,
  sessionLengthOptions, parseServiceDuration, minutesBetween, addMinutesToTime,
} from "../../../../lib/sessionLength";

// ── Custom dropdown (dark-mode safe — avoids native <select> OS rendering) ───
function CalDrop({ label, options, onSelect }: {
  label: string;
  options: { value: string | number; label: string; disabled?: boolean }[];
  onSelect: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ fontSize: 13, fontWeight: 700, color: "var(--text-1)", background: "transparent", border: "none",
          cursor: "pointer", display: "flex", alignItems: "center", gap: 3, padding: "2px 4px", borderRadius: 6 }}>
        {label}
        <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div className="soft-card" style={{
          position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
          zIndex: 200, borderRadius: 12, padding: "6px 0",
          maxHeight: 200, overflowY: "auto", minWidth: 120,
        }}>
          {options.map(opt => (
            <button key={opt.value} type="button" disabled={opt.disabled}
              onClick={() => { if (!opt.disabled) { onSelect(String(opt.value)); setOpen(false); } }}
              style={{
                display: "block", width: "100%", textAlign: "center",
                padding: "8px 16px", border: "none", background: String(opt.value) === label ? "var(--accent-surface)" : "transparent",
                color: opt.disabled ? "var(--text-3)" : String(opt.value) === label ? "var(--accent)" : "var(--text-1)",
                fontSize: 12, fontWeight: String(opt.value) === label ? 700 : 400,
                cursor: opt.disabled ? "default" : "pointer",
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Mini Calendar ─────────────────────────────────────────────────────────────
function MiniCalendar({ value, onChange, maxDate }: {
  value: string;
  onChange: (iso: string) => void;
  maxDate?: Date;
}) {
  const cap   = maxDate ?? new Date();
  const today = new Date();

  // Always start on a valid, non-future month regardless of whatever is in value
  const [view, setView] = useState<Date>(() => {
    if (!value) return today;
    try {
      const d = parseISO(value);
      return isAfter(d, cap) ? cap : d;
    } catch { return today; }
  });

  const selected = value ? (() => { try { return parseISO(value); } catch { return null; } })() : null;

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const maxYear = cap.getFullYear();
  const minYear = maxYear - 60;
  const years   = Array.from({ length: maxYear - minYear + 1 }, (_, i) => maxYear - i);

  const setMonth = (m: number) => setView(v => new Date(v.getFullYear(), m, 1));
  const setYear  = (y: number) => setView(v => {
    const m = y === maxYear && v.getMonth() > cap.getMonth() ? cap.getMonth() : v.getMonth();
    return new Date(y, m, 1);
  });

  const canNext = !isSameMonth(view, cap) && isAfter(cap, endOfMonth(view));

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(view), { weekStartsOn: 1 }),
    end:   endOfWeek(endOfMonth(view),     { weekStartsOn: 1 }),
  });

  return (
    <div className="soft-card-2" style={{ borderRadius: 16, padding: 16, userSelect: "none" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 4 }}>
        <button type="button" onClick={() => setView(v => subMonths(v, 1))}
          style={{ width: 28, height: 28, borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", color: "var(--text-2)", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
          ‹
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <CalDrop
            label={MONTHS[view.getMonth()]}
            options={MONTHS.map((m, i) => ({
              value: i, label: m,
              disabled: view.getFullYear() === maxYear && i > cap.getMonth(),
            }))}
            onSelect={v => setMonth(Number(v))}
          />
          <CalDrop
            label={String(view.getFullYear())}
            options={years.map(y => ({ value: y, label: String(y) }))}
            onSelect={v => setYear(Number(v))}
          />
        </div>

        <button type="button" onClick={() => setView(v => addMonths(v, 1))} disabled={!canNext}
          style={{ width: 28, height: 28, borderRadius: 8, border: "none", background: "transparent", cursor: canNext ? "pointer" : "not-allowed", color: canNext ? "var(--text-2)" : "var(--text-3)", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
          ›
        </button>
      </div>

      {/* Weekday labels */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 4 }}>
        {["Mo","Tu","We","Th","Fr","Sa","Su"].map(d => (
          <span key={d} style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: "var(--text-3)", padding: "4px 0" }}>{d}</span>
        ))}
      </div>

      {/* Day grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {days.map(day => {
          const inMonth   = isSameMonth(day, view);
          const disabled  = isAfter(day, cap);
          const sel       = !!(selected && isSameDay(day, selected));
          const todayMark = isToday(day);

          return (
            <button key={day.toISOString()} type="button"
              disabled={disabled || !inMonth}
              onClick={() => onChange(dfmt(day, "yyyy-MM-dd"))}
              style={{
                padding: "7px 0", borderRadius: 8, fontSize: 12, fontWeight: sel || todayMark ? 700 : 400,
                border: !sel && todayMark ? "1.5px solid var(--accent)" : "none",
                background: sel ? "var(--accent)" : "transparent",
                color: sel ? "#fff" : !inMonth || disabled ? "var(--text-3)" : todayMark ? "var(--accent)" : "var(--text-1)",
                cursor: disabled || !inMonth ? "default" : "pointer",
                opacity: !inMonth ? 0.2 : 1,
                transition: "background 0.12s",
              }}
            >
              {dfmt(day, "d")}
            </button>
          );
        })}
      </div>

      {/* Selected date label */}
      {selected && !isAfter(selected, cap) && (
        <p style={{ textAlign: "center", fontSize: 11, color: "var(--accent)", fontWeight: 600, marginTop: 10 }}>
          {dfmt(selected, "EEEE, MMMM d, yyyy")}
        </p>
      )}
    </div>
  );
}

type Patient = {
  id: number; name: string; email: string; phone: string; createdAt: string; riskFlag?: boolean; riskReason?: string; riskFlaggedAt?: string;
  assignedDoctorId?: number | null;
  caseStatus?: "NEW_CASE" | "ONGOING" | "PERIODIC_FOLLOW_UP" | "TERMINATED" | "DROPPED";
  caseStatusUpdatedAt?: string | null; caseStatusReason?: string | null;
};
type Appointment = {
  id: number; appointmentDate: string; startTime: string; endTime: string;
  status: string; sessionType?: string; mode?: string; notes?: string; cancellationReason?: string;
  rating?: number; feedback?: string;
  assignedDoctorId?: number | null; assignedDoctorName?: string | null; assignedDoctorJobTitle?: string | null;
};
type SessionNote = { id: number; appointmentId: number; content?: string; subjective?: string; objective?: string; assessment?: string; plan?: string; updatedAt: string; };
type Invoice     = { id: number; appointmentId: number; status: string; amount: number; discountAmount?: number; finalAmount?: number; discountReason?: string; paymentMethod?: string; toAccount?: string | null; bankAccountName?: string | null; };
type AppointmentWithJourney = Appointment & { previousAppointmentId?: number | null; returningPatient?: boolean; };
type MoodLog     = { id: number; appointmentId?: number; moodScore: number; logDate: string; note?: string; };
type BankAccount = { id: number; accountName: string; bankName: string; accountNumber?: string; ifscCode?: string; upiId?: string; isDefault: boolean; active: boolean; };
type Attachment  = { id: number; patientId: number; fileName: string; fileType: string; fileSize: number; uploadedAt: string; };

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB — mirrors the backend's PatientAttachmentService cap
const ALLOWED_ATTACHMENT_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv"];

// Shared online/in-person toggle for the manual scheduling, past-session,
// and edit-session forms below.
function ModeToggle({ value, onChange }: { value: "ONLINE" | "OFFLINE"; onChange: (m: "ONLINE" | "OFFLINE") => void }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      {([
        { v: "OFFLINE" as const, label: "In-person", Icon: MapPin },
        { v: "ONLINE" as const, label: "Online", Icon: Video },
      ]).map(({ v, label, Icon }) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          style={{
            flex: 1, padding: "9px 0", borderRadius: 10, border: `1.5px solid ${value === v ? "var(--accent)" : "transparent"}`,
            background: value === v ? "var(--accent-surface)" : "transparent", color: value === v ? "var(--accent)" : "var(--text-2)",
            fontWeight: 600, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}>
          <Icon style={{ width: 13, height: 13 }} /> {label}
        </button>
      ))}
    </div>
  );
}

// How long a session runs — the practitioner decides, per appointment. Shared
// by the schedule / past-session / edit-session forms so they offer the same
// choices as the availability editor's "Session length". `value` "" only
// occurs on the edit form's "keep existing" option.
function SessionLengthSelect({ value, onChange, keepExisting = false, compact = false }: {
  value: number | "";
  onChange: (v: number | "") => void;
  keepExisting?: boolean;
  compact?: boolean;
}) {
  const options = sessionLengthOptions(typeof value === "number" ? value : null);
  return (
    <select
      aria-label="Session length"
      className="nm-input"
      style={{ width: "100%", padding: compact ? "10px 12px" : 12, borderRadius: compact ? 12 : 14, color: "var(--text-1)" }}
      value={value}
      onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))}
    >
      {keepExisting && <option value="">-- Keep existing --</option>}
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const STATUS_CFG: Record<string, { label: string; textColor: string; icon: React.ReactNode }> = {
  AWAITING_PAYMENT:     { label: "Awaiting Payment", textColor: "#f59e0b", icon: <Hourglass className="w-4 h-4" /> },
  PAYMENT_UNDER_REVIEW: { label: "Verifying Payment",textColor: "#0891b2", icon: <Search className="w-4 h-4" /> },
  CONFIRMED:            { label: "Confirmed",        textColor: "#00c48c", icon: <CheckCircle2 className="w-4 h-4" /> },
  COMPLETED:            { label: "Completed",        textColor: "#4f6ef7", icon: <Check className="w-4 h-4" /> },
  CANCELLED:            { label: "Cancelled",        textColor: "#f43f5e", icon: <XCircle className="w-4 h-4" /> },
};

export default function ClientTimelinePage() {
  const params = useParams();
  const router = useRouter();
  const [patient, setPatient]           = useState<Patient | null>(null);
  const [appointments, setAppointments] = useState<AppointmentWithJourney[]>([]);
  const [services, setServices]         = useState<any[]>([]);
  const [sessionNotes, setSessionNotes] = useState<Record<number, SessionNote>>({});
  const [invoices, setInvoices]         = useState<Record<number, Invoice>>({});
  const [moodLogs, setMoodLogs]         = useState<MoodLog[]>([]);
  const [loading, setLoading]           = useState(true);
  const themeMode = useThemeMode();
  const chartC = CHART[themeMode];

  // Clinic staff (tenantId set) or a tenant root signed up as CLINIC — a
  // solo practitioner already knows who "the doctor" is, so skip the badge.
  const [isClinicContext, setIsClinicContext] = useState(false);
  // The logged-in user's own id/name — staffDoctors below only ever lists
  // OTHER staff, never the caller's own row, so resolving "this patient's
  // assigned doctor is me" needs this separately.
  const [ownUser, setOwnUser] = useState<{ id: number; name: string; jobTitle: string | null } | null>(null);
  // A receptionist/support login has no calendar of its own, so it books through
  // the front-desk booking flow (pick a therapist, see their slots) rather than
  // the "schedule on my own calendar" dialog below.
  const [isPractitioner, setIsPractitioner] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  useEffect(() => {
    try {
      const user = JSON.parse(localStorage.getItem("user") || "null");
      if (user) {
        setIsClinicContext(!!user.tenantId || user.accountType === "CLINIC");
        setOwnUser({ id: user.id, name: user.name || user.username, jobTitle: user.jobTitle ?? null });
        setIsPractitioner(!user.tenantId || user.role === "ROLE_PSYCHOLOGIST");
      }
    } catch { /* default to hidden if we can't tell */ }
  }, []);

  // Psyfos: session status (New Case / Ongoing / ...) and the next follow-up.
  const [caseInfo, setCaseInfo] = useState<{ statusLog: any[]; followUps: PsyFollowUp[] }>({ statusLog: [], followUps: [] });
  const [caseModal, setCaseModal] = useState(false);
  const [followModal, setFollowModal] = useState(false);
  const [bookFollow, setBookFollow] = useState<PsyFollowUp | null>(null);
  const loadCaseInfo = () => {
    if (!params.id) return;
    api.get(`/patients/${params.id}/case-history`).then(r => setCaseInfo(r.data)).catch(() => {});
  };
  useEffect(() => { loadCaseInfo(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [params.id]);

  // Roster of bookable psychologists in this clinic, for the doctor picker
  // on the Schedule/Add Session modals below. GET /staff only succeeds for
  // a clinic OWNER (tenant root, accountType CLINIC) — it 403s for staff
  // logins and for individual practitioners, which is exactly who doesn't
  // need a picker (a staff-doctor scheduling for themselves needs no
  // choice; an individual has no one else to choose). See the
  // Promise.allSettled fetch below — a rejection here just leaves this
  // empty and the picker stays hidden, same as every other optional block
  // on this page.
  const [staffDoctors, setStaffDoctors] = useState<{ id: number; name: string; jobTitle: string | null }[]>([]);

  // Timeline controls
  const [search, setSearch]       = useState("");
  const [sortDesc, setSortDesc]   = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Modal states
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteSessionId, setNoteSessionId] = useState<number | "">("");
  const [modalNoteText, setModalNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [schedDate, setSchedDate] = useState("");
  const [schedTime, setSchedTime] = useState("");
  const [schedType, setSchedType] = useState("");
  const [schedMode, setSchedMode] = useState<"ONLINE" | "OFFLINE">("OFFLINE");
  const [schedDoctorId, setSchedDoctorId] = useState(""); // "" = myself
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [schedSaving, setSchedSaving] = useState(false);
  // The doctor's explicit session-length pick. null = "not chosen yet" — the
  // effective length then follows the selected service's own length (see
  // schedDuration below). Always sent explicitly on submit, so what the form
  // shows is exactly what gets saved.
  const [schedDurationOverride, setSchedDurationOverride] = useState<number | null>(null);

  // Per-doctor service pricing, so the Schedule modal only offers services the
  // selected practitioner has actually priced for the selected mode. Without
  // this, picking an unpriced service just fails server-side with
  // "This practitioner does not offer this service ..." (clinic accounts get
  // no catalogue-fee fallback — see DoctorAvailabilityService.resolveBookablePrice).
  // Keyed by doctor id; key 0 = the logged-in user ("myself").
  const [servicePricingByDoctor, setServicePricingByDoctor] = useState<Record<number, DoctorServicePrice[]>>({});

  // Each doctor's weekly availability blocks (same keying as above). The
  // "Session length" set on a block in Settings → Availability is the doctor's
  // own decision of how long a session runs, so it's what the Schedule form
  // defaults to for that day — see schedDefault below.
  const [availabilityByDoctor, setAvailabilityByDoctor] = useState<Record<number, Record<string, AvailabilityBlock[]>>>({});

  const [pastModalOpen, setPastModalOpen]   = useState(false);
  const [pastDate, setPastDate]             = useState("");
  const [pastTime, setPastTime]             = useState("");
  const [pastType, setPastType]             = useState("");
  const [pastMode, setPastMode]             = useState<"ONLINE" | "OFFLINE">("OFFLINE");
  const [pastDoctorId, setPastDoctorId]     = useState(""); // "" = myself
  const [pastStatus, setPastStatus]         = useState("COMPLETED");
  const [pastNotes, setPastNotes]           = useState("");
  const [pastSaving, setPastSaving]         = useState(false);
  const [pastDurationOverride, setPastDurationOverride] = useState<number | null>(null);

  // Risk flag modal states
  const [riskModalOpen, setRiskModalOpen] = useState(false);
  const [riskReason, setRiskReason] = useState("");
  const [riskSaving, setRiskSaving] = useState(false);

  // Notes editing state
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null); // appointmentId being edited
  const [soapNote, setSoapNote]           = useState({ subjective: "", objective: "", assessment: "", plan: "" });
  const [savingNote, setSavingNote]       = useState(false);

  // Set session price state
  const [sessionPriceModal, setSessionPriceModal] = useState<{ invoiceId: number; currentAmount: number; aptId: number } | null>(null);
  const [sessionPriceInput, setSessionPriceInput] = useState("");
  const [sessionPriceError, setSessionPriceError] = useState("");
  const [sessionPriceSaving, setSessionPriceSaving] = useState(false);

  // Edit patient state
  const [editPatientOpen, setEditPatientOpen]   = useState(false);
  const [editPatientForm, setEditPatientForm]   = useState<{ name: string; email: string; phone: string }>({ name: "", email: "", phone: "" });
  const [editPatientSaving, setEditPatientSaving] = useState(false);

  // Edit session state
  const [editSessionOpen, setEditSessionOpen]   = useState(false);
  const [editSessionId, setEditSessionId]       = useState<number | null>(null);
  const [editSessionForm, setEditSessionForm]   = useState<{
    appointmentDate: string; startTime: string; sessionType: string; notes: string; mode: string;
    durationMinutes: number | ""; // "" = keep the appointment's existing length
  }>({ appointmentDate: "", startTime: "", sessionType: "", notes: "", mode: "", durationMinutes: "" });
  const [editSessionSaving, setEditSessionSaving] = useState(false);

  // Schedule modal payment state. "RECEPTION" means the therapist is
  // deliberately deferring collection to the front desk instead of sending
  // the patient an online payment link — see the receptionist Pending
  // Payments page (/dashboard/reception).
  const [schedPayStatus, setSchedPayStatus] = useState<"AWAITING" | "PAID" | "RECEPTION">("AWAITING");
  const [schedPayAmount, setSchedPayAmount] = useState("");
  const [schedPayMethod, setSchedPayMethod] = useState("CASH");

  // Past session modal payment state
  const [pastPayStatus, setPastPayStatus] = useState<"AWAITING" | "PAID">("PAID");
  const [pastPayAmount, setPastPayAmount] = useState("");
  const [pastPayMethod, setPastPayMethod] = useState("CASH");

  // Bank accounts (fetched on mount)
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);

  // File attachments
  const [attachments, setAttachments]     = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [uploadingFile, setUploadingFile] = useState(false);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<number | null>(null);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<number | null>(null);

  // Schedule modal: bank account
  const [schedBankAccountId, setSchedBankAccountId] = useState<number | "">("");
  const [schedBankAccountName, setSchedBankAccountName] = useState("");

  // Past session modal: bank account
  const [pastBankAccountId, setPastBankAccountId] = useState<number | "">("");
  const [pastBankAccountName, setPastBankAccountName] = useState("");

  const fetchNotes = (patientId: string | string[]) =>
    api.get(`/notes/patient/${patientId}`).then(r =>
      setSessionNotes(Object.fromEntries(r.data.map((n: SessionNote) => [n.appointmentId, n])))
    ).catch(() => {});

  const applyPaymentAfterCreate = async (
    appointmentId: number,
    payStatus: "AWAITING" | "PAID" | "RECEPTION",
    payAmount: string,
    payMethod: string,
    bankAccId?: number | "",
    bankAccName?: string,
  ) => {
    try {
      const invRes = await api.get(`/invoices/appointment/${appointmentId}`);
      const inv = invRes.data;
      if (payAmount.trim() && inv.id) {
        await api.patch(`/invoices/${inv.id}/amount`, { amount: payAmount.trim() });
      }
      if (payStatus === "PAID" && inv.id) {
        const payBody: Record<string, string> = { paymentMethod: payMethod };
        if (bankAccId) payBody.bankAccountId = String(bankAccId);
        if (bankAccName) payBody.bankAccountName = bankAccName;
        const updatedInv = await api.patch(`/invoices/${inv.id}/pay`, payBody);
        setInvoices(prev => ({ ...prev, [appointmentId]: updatedInv.data }));
      } else {
        const freshInv = await api.get(`/invoices/appointment/${appointmentId}`);
        setInvoices(prev => ({ ...prev, [appointmentId]: freshInv.data }));
      }
    } catch (e) {
      console.error("Payment update failed:", e);
    }
  };

  const handleSetSessionPrice = async () => {
    if (!sessionPriceModal) return;
    setSessionPriceError("");
    const val = parseFloat(sessionPriceInput);
    if (isNaN(val) || val <= 0) { setSessionPriceError("Enter a valid amount greater than ₹0."); return; }
    setSessionPriceSaving(true);
    try {
      await api.patch(`/invoices/${sessionPriceModal.invoiceId}/amount`, { amount: val.toString() });
      const freshInv = await api.get(`/invoices/appointment/${sessionPriceModal.aptId}`);
      setInvoices(prev => ({ ...prev, [sessionPriceModal.aptId]: freshInv.data }));
      setSessionPriceModal(null);
      setSessionPriceInput("");
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      setSessionPriceError(msg?.trim() ? msg : "Failed to update price.");
    } finally {
      setSessionPriceSaving(false);
    }
  };

  const handleEditPatient = async () => {
    if (!patient || !editPatientForm.name.trim() || !editPatientForm.phone.trim()) return;
    setEditPatientSaving(true);
    try {
      const detailsRes = await api.patch(`/patients/${patient.id}/details`, {
        name:  editPatientForm.name,
        email: editPatientForm.email,
        phone: editPatientForm.phone,
      });
      setPatient(detailsRes.data);
      setEditPatientOpen(false);
    } catch (e) {
      console.error(e);
      alert("Failed to update patient details");
    } finally {
      setEditPatientSaving(false);
    }
  };

  const handleDeleteSession = async (aptId: number) => {
    if (!confirm("Delete this session and its related records? This cannot be undone.")) return;
    try {
      await api.delete(`/appointments/${aptId}`);
      setAppointments(prev => prev.filter(a => a.id !== aptId));
      setInvoices(prev => { const next = { ...prev }; delete next[aptId]; return next; });
    } catch (e) {
      console.error(e);
      alert("Failed to delete session");
    }
  };

  const handleEditSession = async () => {
    if (!editSessionId) return;
    setEditSessionSaving(true);
    try {
      const res = await api.patch(`/appointments/${editSessionId}/details`, {
        appointmentDate: editSessionForm.appointmentDate || undefined,
        startTime:       editSessionForm.startTime       || undefined,
        sessionType:     editSessionForm.sessionType     || undefined,
        mode:            editSessionForm.mode            || undefined,
        notes:           editSessionForm.notes,
        // Omitted = the server keeps the appointment's current length.
        durationMinutes: editSessionForm.durationMinutes === "" ? undefined : String(editSessionForm.durationMinutes),
      });
      setAppointments(prev => prev.map(a => a.id === editSessionId ? { ...a, ...res.data } : a));
      setEditSessionOpen(false);
    } catch (e: any) {
      console.error(e);
      // e.g. "That time overlaps another session on this doctor's calendar…"
      const msg = e?.response?.data?.message;
      alert(typeof msg === "string" && msg.trim() ? msg : "Failed to update session");
    } finally {
      setEditSessionSaving(false);
    }
  };

  // Helper functions
  const handleSaveNote = async () => {
    if (!noteSessionId) return;
    setNoteSaving(true);
    try {
      await api.patch(`/appointments/${noteSessionId}/notes`, { notes: modalNoteText });
      setAppointments(prev => prev.map(a => a.id === Number(noteSessionId) ? { ...a, notes: modalNoteText } : a));
      setNoteModalOpen(false);
      setModalNoteText("");
      setNoteSessionId("");
    } catch (err) {
      console.error(err);
      alert("Failed to save note");
    } finally {
      setNoteSaving(false);
    }
  };

  const handleToggleRisk = async () => {
    if (!patient) return;
    const newFlag = !patient.riskFlag;
    if (newFlag && !riskReason.trim()) return;
    
    setRiskSaving(true);
    try {
      const res = await api.patch(`/patients/${patient.id}/risk-flag`, {
        riskFlag: newFlag,
        riskReason: newFlag ? riskReason : null
      });
      setPatient(res.data);
      setRiskModalOpen(false);
      setRiskReason("");
    } catch (err) {
      console.error(err);
      alert("Failed to update risk flag");
    } finally {
      setRiskSaving(false);
    }
  };

  const handleDeletePatient = async () => {
    if (!patient) return;
    if (confirm("Are you sure you want to completely delete this patient and all related records? This action cannot be undone.")) {
      try {
        await api.delete(`/patients/${patient.id}`);
        router.push('/dashboard/patients');
      } catch (err) {
        console.error(err);
        alert("Failed to delete patient");
      }
    }
  };

  // What the Schedule form's session length defaults to, in priority order:
  //   1. the session length the doctor set in Settings → Availability for this
  //      weekday + mode — only when every block that day/mode agrees on one
  //      value (with mixed lengths there's no single "the" length, so it
  //      doesn't guess);
  //   2. the selected service's own length;
  //   3. 60 minutes.
  const schedDefault = useMemo<{ minutes: number; source: "availability" | "service" | "fallback" }>(() => {
    const blocksByDay = availabilityByDoctor[schedDoctorId ? Number(schedDoctorId) : 0];
    if (blocksByDay && schedDate) {
      const weekday = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][new Date(schedDate + "T00:00:00").getDay()];
      const lengths = new Set(
        (blocksByDay[weekday] ?? []).filter(b => b.mode === schedMode).map(b => b.intervalMinutes)
      );
      if (lengths.size === 1) {
        const minutes = Array.from(lengths)[0];
        if (minutes >= MIN_SESSION_MINUTES && minutes <= MAX_SESSION_MINUTES) return { minutes, source: "availability" };
      }
    }
    const svc = services.find(s => s.id.toString() === schedType);
    return svc
      ? { minutes: parseServiceDuration(svc.duration), source: "service" }
      : { minutes: DEFAULT_SESSION_MINUTES, source: "fallback" };
  }, [availabilityByDoctor, schedDoctorId, schedDate, schedMode, schedType, services]);

  // The session length the Schedule form will book: the doctor's own pick if
  // they made one, otherwise the default above.
  const schedDuration = schedDurationOverride ?? schedDefault.minutes;

  const pastDuration = useMemo(() => {
    if (pastDurationOverride !== null) return pastDurationOverride;
    const svc = services.find(s => s.id.toString() === pastType);
    return svc ? parseServiceDuration(svc.duration) : DEFAULT_SESSION_MINUTES;
  }, [pastDurationOverride, pastType, services]);

  // Load the open start times for whatever the Schedule form currently has
  // selected. One effect keyed on everything that changes the answer (date,
  // mode, doctor AND session length — a longer session leaves fewer valid
  // start times) instead of ad-hoc fetches in each change handler. The
  // `cancelled` flag drops a response that arrives after the inputs have
  // already moved on, so a slow reply for an earlier date can never overwrite
  // the slots for the date now showing.
  useEffect(() => {
    if (!scheduleModalOpen || !schedDate) { setSlotsLoading(false); return; }
    let cancelled = false;
    setSlotsLoading(true);
    getMySlots(schedDate, schedMode, schedDoctorId ? Number(schedDoctorId) : undefined, schedDuration)
      .then(res => {
        if (cancelled) return;
        const list = Array.isArray(res) ? res : [];
        setAvailableSlots(list);
        // A previously picked time that no longer fits the new length is dropped.
        setSchedTime(t => (t && list.includes(t) ? t : ""));
      })
      .catch(() => {
        if (cancelled) return;
        setAvailableSlots([]);
        setSchedTime("");
      })
      .finally(() => { if (!cancelled) setSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [scheduleModalOpen, schedDate, schedMode, schedDoctorId, schedDuration]);

  const fetchServices = () => {
    if (services.length === 0) {
      // /services needs the Settings permission, which therapists and front-desk
      // logins don't have — they read the booking catalogue instead (same
      // service names, limited to what the clinic actually offers).
      api.get("/services")
        .catch(() => api.get("/appointments/service-options").then(r => ({
          data: (r.data ?? []).map((o: any) => ({
            id: o.serviceId, name: o.name, description: o.description, duration: o.duration,
            icon: o.icon, fee: 0, active: true, displayOrder: 0,
          })),
        })))
        .then(r => setServices(r.data))
        .catch(() => {});
    }
  };

  // Load the (mode-aware) service pricing for a given practitioner. doctorId
  // "" means the logged-in user; a numeric id means a clinic staff doctor.
  // Cached per doctor — key 0 for "myself" — so switching the picker back and
  // forth doesn't refetch.
  const fetchServicePricing = (doctorId: string) => {
    const key = doctorId ? Number(doctorId) : 0;
    if (servicePricingByDoctor[key]) return;
    getMyServices(doctorId ? Number(doctorId) : undefined)
      .then(rows => setServicePricingByDoctor(prev => ({ ...prev, [key]: rows })))
      .catch(() => setServicePricingByDoctor(prev => ({ ...prev, [key]: [] })));
  };

  // Same idea for the doctor's availability blocks; a failed load just leaves
  // the length defaulting to the service's, as before.
  const fetchAvailability = (doctorId: string) => {
    const key = doctorId ? Number(doctorId) : 0;
    if (availabilityByDoctor[key]) return;
    getAvailabilityBlocks(doctorId ? Number(doctorId) : undefined)
      .then(blocks => setAvailabilityByDoctor(prev => ({ ...prev, [key]: blocks ?? {} })))
      .catch(() => setAvailabilityByDoctor(prev => ({ ...prev, [key]: {} })));
  };

  // clinicServiceIds the currently-selected Schedule doctor offers in the
  // currently-selected mode. null = pricing not loaded yet (show all rather
  // than an empty list mid-fetch).
  const offeredSchedServiceIds = useMemo<Set<string> | null>(() => {
    const rows = servicePricingByDoctor[schedDoctorId ? Number(schedDoctorId) : 0];
    if (!rows) return null;
    return new Set(
      rows
        .filter(r => (schedMode === "ONLINE" ? r.onlineOffered : r.offlineOffered))
        .map(r => String(r.clinicServiceId))
    );
  }, [servicePricingByDoctor, schedDoctorId, schedMode]);

  // Drop a chosen service the moment it stops being offered — after a mode or
  // doctor switch, or once a late pricing fetch lands — so a stale selection
  // can't be submitted into the "does not offer this service" error.
  useEffect(() => {
    if (schedType && offeredSchedServiceIds && !offeredSchedServiceIds.has(schedType)) {
      setSchedType("");
    }
  }, [offeredSchedServiceIds, schedType]);

  const openScheduleModal = () => {
    setSchedDate(""); setSchedTime(""); setSchedType(""); setSchedMode("OFFLINE"); setSchedDoctorId("");
    setSchedDurationOverride(null);
    setSchedPayStatus("AWAITING"); setSchedPayAmount(""); setSchedPayMethod("CASH");
    setAvailableSlots([]); setSlotsLoading(false);
    setScheduleModalOpen(true);
    fetchServices();
    fetchServicePricing("");
    fetchAvailability("");
    const defaultAcc = bankAccounts.find(b => b.isDefault) ?? bankAccounts[0] ?? null;
    setSchedBankAccountId(defaultAcc?.id ?? "");
    setSchedBankAccountName(defaultAcc?.accountName ?? "");
  };
  const openPastModal = () => {
    setPastDate(""); setPastTime(""); setPastType(""); setPastMode("OFFLINE"); setPastDoctorId(""); setPastNotes(""); setPastStatus("COMPLETED");
    setPastDurationOverride(null);
    setPastPayStatus("PAID"); setPastPayAmount(""); setPastPayMethod("CASH");
    setPastModalOpen(true);
    fetchServices();
    const defaultAcc = bankAccounts.find(b => b.isDefault) ?? bankAccounts[0] ?? null;
    setPastBankAccountId(defaultAcc?.id ?? "");
    setPastBankAccountName(defaultAcc?.accountName ?? "");
  };
  const openNoteModal = () => {
    setNoteSessionId("");
    setModalNoteText("");
    setNoteModalOpen(true);
  };

  const handleSchedule = async () => {
    if (!schedDate || !schedTime || !schedType || !patient) return;
    setSchedSaving(true);
    try {
      const res = await api.post('/appointments/manual', {
        patientName: patient.name,
        patientEmail: patient.email,
        patientPhone: patient.phone,
        appointmentDate: schedDate,
        startTime: schedTime,
        sessionType: schedType,
        mode: schedMode,
        staffId: schedDoctorId ? Number(schedDoctorId) : undefined,
        notes: "",
        paymentHandledBy: schedPayStatus === "RECEPTION" ? "RECEPTION" : undefined,
        // The length shown in the form — sent explicitly so the booking never
        // silently falls back to a different default server-side.
        durationMinutes: schedDuration,
      });
      setAppointments(prev => [res.data, ...prev]);
      await applyPaymentAfterCreate(res.data.id, schedPayStatus, schedPayAmount, schedPayMethod, schedBankAccountId, schedBankAccountName);
      setScheduleModalOpen(false);
      setSchedDate(""); setSchedTime(""); setSchedType(""); setSchedMode("OFFLINE"); setSchedDoctorId("");
      setSchedDurationOverride(null);
      setSchedPayStatus("AWAITING"); setSchedPayAmount(""); setSchedPayMethod("CASH");
      setSchedBankAccountId(""); setSchedBankAccountName("");
    } catch (err: any) {
      console.error(err);
      // Surface the backend's actual reason (e.g. "This practitioner does not
      // offer this service in person" when the doctor has no price configured
      // for this service/mode) instead of a generic failure — mirrors
      // handleAddPastSession's error handling.
      const msg = err?.response?.data?.message;
      alert(msg?.trim() ? msg : "Failed to schedule appointment");
    } finally {
      setSchedSaving(false);
    }
  };

  const handleAddPastSession = async () => {
    if (!pastDate || !pastTime || !pastType || !patient) return;
    setPastSaving(true);
    try {
      const res = await api.post("/appointments/past", {
        patientId:       String(patient.id),
        appointmentDate: pastDate,
        startTime:       pastTime,
        sessionType:     pastType,
        mode:            pastMode,
        staffId:         pastDoctorId || undefined,
        status:          pastStatus,
        notes:           pastNotes,
        durationMinutes: String(pastDuration),
      });
      setAppointments(prev => [res.data, ...prev]);
      await applyPaymentAfterCreate(res.data.id, pastPayStatus, pastPayAmount, pastPayMethod, pastBankAccountId, pastBankAccountName);
      setPastModalOpen(false);
      setPastDate(""); setPastTime(""); setPastType(""); setPastMode("OFFLINE"); setPastDoctorId(""); setPastNotes(""); setPastStatus("COMPLETED");
      setPastDurationOverride(null);
      setPastPayStatus("PAID"); setPastPayAmount(""); setPastPayMethod("CASH");
      setPastBankAccountId(""); setPastBankAccountName("");
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.response?.data || err?.message || "Unknown error";
      const status = err?.response?.status ?? "no response";
      console.error("Add past session failed:", status, msg);
      alert(`Failed to add past session (${status}): ${msg}`);
    } finally {
      setPastSaving(false);
    }
  };

  useEffect(() => {
    if (!params.id) return;
    Promise.allSettled([
      api.get(`/patients/${params.id}`),
      api.get(`/patients/${params.id}/appointments`),
      api.get(`/services`),
      api.get(`/notes/patient/${params.id}`),
      api.get(`/invoices/patient/${params.id}`),
      api.get(`/mood/patient/${params.id}`),
      api.get(`/bank-accounts`),
      api.get(`/patients/${params.id}/attachments`),
      // Only a clinic OWNER can call this — it 403s for staff logins and
      // individual practitioners, both of whom don't need a doctor picker
      // anyway (see the "staffDoctors" comment above). A rejection here
      // just leaves the picker hidden, same as every other optional block.
      api.get(`/staff`),
    ])
    .then(([pRes, aRes, sRes, nRes, invRes, moodRes, bankRes, attRes, staffRes]) => {
      if (pRes.status === "fulfilled") setPatient(pRes.value.data);
      if (aRes.status === "fulfilled") setAppointments(aRes.value.data);
      if (sRes.status === "fulfilled") setServices(sRes.value.data);
      if (nRes.status === "fulfilled") setSessionNotes(Object.fromEntries(nRes.value.data.map((n: SessionNote) => [n.appointmentId, n])));
      if (invRes.status === "fulfilled") setInvoices(Object.fromEntries(invRes.value.data.map((inv: Invoice) => [inv.appointmentId, inv])));
      if (moodRes.status === "fulfilled") setMoodLogs(moodRes.value.data);
      if (bankRes.status === "fulfilled") setBankAccounts((bankRes.value.data ?? []).filter((b: BankAccount) => b.active));
      if (attRes.status === "fulfilled") setAttachments(attRes.value.data);
      if (staffRes.status === "fulfilled") {
        setStaffDoctors((staffRes.value.data ?? []).filter((s: any) => s.role === "ROLE_PSYCHOLOGIST" && s.enabled));
      }
    })
    .catch(console.error)
    .finally(() => setLoading(false));
  }, [params.id]);

  const handleUploadAttachment = async (file: File) => {
    if (!patient) return;
    setAttachmentError("");

    const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
    if (!extension || !ALLOWED_ATTACHMENT_EXTENSIONS.includes(extension)) {
      setAttachmentError("Unsupported file type. Allowed: PDF, Word, Excel, PowerPoint, images, and text/CSV files.");
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachmentError("File exceeds the 10MB size limit.");
      return;
    }

    setUploadingFile(true);
    try {
      const fileData = await fileToDataUrl(file);
      const res = await api.post(`/patients/${patient.id}/attachments`, {
        fileName: file.name,
        fileData,
      });
      setAttachments(prev => [res.data, ...prev]);
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      setAttachmentError(msg?.trim() ? msg : "Failed to upload file.");
    } finally {
      setUploadingFile(false);
    }
  };

  const handleDownloadAttachment = async (attachment: Attachment) => {
    if (!patient) return;
    setDownloadingAttachmentId(attachment.id);
    try {
      const res = await api.get(`/patients/${patient.id}/attachments/${attachment.id}/download`, { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert("Failed to download attachment.");
    } finally {
      setDownloadingAttachmentId(null);
    }
  };

  const handleDeleteAttachment = async (attachmentId: number) => {
    if (!patient) return;
    if (!confirm("Delete this attachment? This cannot be undone.")) return;
    setDeletingAttachmentId(attachmentId);
    try {
      await api.delete(`/patients/${patient.id}/attachments/${attachmentId}`);
      setAttachments(prev => prev.filter(a => a.id !== attachmentId));
    } catch (e) {
      console.error(e);
      alert("Failed to delete attachment.");
    } finally {
      setDeletingAttachmentId(null);
    }
  };

  // Metrics calculation
  const metrics = useMemo(() => {
    const total = appointments.length;
    if (total === 0) return null;

    const completed = appointments.filter(a => a.status === "COMPLETED" || a.status === "CONFIRMED");
    const cancelled = appointments.filter(a => a.status === "CANCELLED");
    // appointmentDate is a date-only string ("YYYY-MM-DD") — parsed bare it's
    // read as UTC midnight, which for timezones ahead of UTC can already be
    // hours into "today" by the time this runs, wrongly bucketing a
    // same-day appointment as past. Force local-midnight parsing instead,
    // consistent with the rest of the timeline (see apt.appointmentDate + "T00:00:00" above).
    const asLocalDate = (d: string) => new Date(d + "T00:00:00");
    const pastAppointments = appointments.filter(a => asLocalDate(a.appointmentDate) < new Date());

    // Attendance rate
    const attendanceRate = pastAppointments.length > 0
      ? Math.round((pastAppointments.filter(a => a.status === "COMPLETED").length / pastAppointments.length) * 100)
      : 100;

    // Sorting to find first/last easily
    const sorted = [...completed].sort((a, b) => asLocalDate(a.appointmentDate).getTime() - asLocalDate(b.appointmentDate).getTime());

    let avgGap = 0;
    if (sorted.length > 1) {
      const firstDate = asLocalDate(sorted[0].appointmentDate).getTime();
      const lastDate = asLocalDate(sorted[sorted.length - 1].appointmentDate).getTime();
      const daysDiff = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
      avgGap = Math.round(daysDiff / (sorted.length - 1));
    }

    const futureAppointments = appointments.filter(a => asLocalDate(a.appointmentDate) >= new Date() && (a.status === "AWAITING_PAYMENT" || a.status === "PAYMENT_UNDER_REVIEW" || a.status === "CONFIRMED"));
    const upcomingFollowUp = futureAppointments.length > 0
      ? futureAppointments.sort((a,b) => asLocalDate(a.appointmentDate).getTime() - asLocalDate(b.appointmentDate).getTime())[0].appointmentDate
      : null;

    const treatmentDuration = sorted.length > 1
      ? Math.round((asLocalDate(sorted[sorted.length - 1].appointmentDate).getTime() - asLocalDate(sorted[0].appointmentDate).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    let progressTrend = "Stable";
    if (attendanceRate >= 80 && completed.length > 3) progressTrend = "Improving";
    if (cancelled.length > completed.length) progressTrend = "Requires Attention";

    const allNotes = completed.map(a => a.notes).filter(Boolean).join(" ");
    
    const commonTopics = ["anxiety", "depression", "stress", "relationship", "sleep", "focus", "trauma", "coping", "career", "family"];
    const foundTopics = commonTopics.filter(t => allNotes.toLowerCase().includes(t));
    const keyDiscussionTopics = foundTopics.length > 0 ? foundTopics : ["General Well-being"];

    const primaryConcerns = sorted.length > 0 && sorted[0].notes 
      ? (sorted[0].notes.length > 50 ? sorted[0].notes.substring(0, 50) + "..." : sorted[0].notes)
      : "Not specified initially";

    return {
      total,
      completed: completed.length,
      cancelled: cancelled.length,
      attendanceRate,
      firstVisit: sorted.length > 0 ? sorted[0].appointmentDate : null,
      lastVisit: sorted.length > 0 ? sorted[sorted.length - 1].appointmentDate : null,
      avgGap,
      upcomingFollowUp,
      treatmentDuration,
      progressTrend,
      keyDiscussionTopics,
      primaryConcerns
    };
  }, [appointments]);

  // The treating doctor. Prefers the patient's explicit assignedDoctorId
  // (set at creation, or defaulted there — see the patients list page);
  // falls back to the most recent non-cancelled appointment's assigned
  // doctor for patients created before that field existed, where the
  // relationship only lives on the appointment.
  const patientDoctor = useMemo((): { name: string; jobTitle: string | null } | null => {
    if (patient?.assignedDoctorId != null) {
      if (ownUser && patient.assignedDoctorId === ownUser.id) return ownUser;
      const s = staffDoctors.find(d => d.id === patient.assignedDoctorId);
      if (s) return s;
    }
    const withDoctor = appointments
      .filter(a => a.status !== "CANCELLED" && a.assignedDoctorName)
      .sort((a, b) => (b.appointmentDate + b.startTime).localeCompare(a.appointmentDate + a.startTime));
    const latest = withDoctor[0];
    return latest ? { name: latest.assignedDoctorName!, jobTitle: latest.assignedDoctorJobTitle ?? null } : null;
  }, [patient, ownUser, staffDoctors, appointments]);

  const aiSummaryText = useMemo(() => {
    if (!metrics || metrics.completed === 0) return "Not enough session data to generate a summary.";
    
    const topics = metrics.keyDiscussionTopics.join(", ");
    let text = `Based on ${metrics.completed} completed sessions, the client has maintained a ${metrics.attendanceRate}% attendance rate. `;
    
    if (metrics.progressTrend === "Improving") {
      text += `They have shown consistent engagement and an improving progress trend. `;
    } else if (metrics.progressTrend === "Requires Attention") {
      text += `There have been some attendance inconsistencies which may require attention. `;
    }

    text += `Primary recurring themes discussed include ${topics}. `;

    if (metrics.upcomingFollowUp) {
      text += `The next follow-up is scheduled for ${new Date(metrics.upcomingFollowUp + "T00:00:00").toLocaleDateString()}, where focus should remain on current coping strategies.`;
    } else {
      text += `No upcoming follow-up is currently scheduled; it is recommended to reach out for continuation of care.`;
    }

    return text;
  }, [metrics]);

  // Timeline Filtering & Sorting
  // Sessions you're allowed to write a note against. The backend puts no
  // status condition on PATCH /appointments/{id}/notes, so the only ones
  // worth excluding are the two that aren't a real session to write up: a
  // cancelled booking and a sales demo call. The previous CONFIRMED-or-
  // COMPLETED-only rule silently hid every session still awaiting payment,
  // which is the state most sessions are in right after they're booked.
  const notableSessions = useMemo(
    () => appointments.filter(a => a.status !== "CANCELLED" && a.status !== "DEMO_CALL_PENDING"),
    [appointments]
  );

  const filteredTimeline = useMemo(() => {
    let result = appointments.filter(a => {
      const query = search.toLowerCase();
      if (!query) return true;
      return (
        (a.sessionType?.toLowerCase().includes(query)) ||
        (a.status.toLowerCase().includes(query)) ||
        (a.notes?.toLowerCase().includes(query)) ||
        (a.cancellationReason?.toLowerCase().includes(query))
      );
    });

    result.sort((a, b) => {
      const aTime = new Date(`${a.appointmentDate}T${a.startTime}`).getTime();
      const bTime = new Date(`${b.appointmentDate}T${b.startTime}`).getTime();
      return sortDesc ? bTime - aTime : aTime - bTime;
    });

    // Session number = position among non-cancelled appointments only (consistent with appointments list).
    // Cancelled sessions are not counted so the numbering reflects actual attended/booked sessions.
    const chronological = [...appointments]
      .filter(a => a.status !== "CANCELLED")
      .sort((a, b) =>
        new Date(`${a.appointmentDate}T${a.startTime}`).getTime() -
        new Date(`${b.appointmentDate}T${b.startTime}`).getTime()
      );

    return result.map(apt => {
      const index = chronological.findIndex(c => c.id === apt.id);
      return { ...apt, sessionNumber: index >= 0 ? index + 1 : null };
    });
  }, [appointments, search, sortDesc]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "400px" }}>
        <div className="soft-card" style={{ width: 40, height: 40, borderRadius: "50%", display: "flex", justifyContent: "center", alignItems: "center", animation: "pulseOpacity 1.5s infinite" }}>
          <Hourglass style={{ width: 20, height: 20, color: "var(--accent)" }} />
        </div>
      </div>
    );
  }

  if (!patient) return <div>Patient not found.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }} className="anim-fade-up">
      
      {/* Risk Flag Banner */}
      {patient.riskFlag && (
        <div style={{ padding: "16px 20px", borderRadius: 20, background: "var(--danger-bg)", border: "1px solid var(--danger-brd)", display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div className="icon-badge icon-badge--danger" style={{ flexShrink: 0 }}>
            <AlertCircle />
          </div>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: "var(--danger)", marginBottom: 4 }}>HIGH RISK PATIENT</h3>
            <p style={{ fontSize: 14, color: "var(--text-2)" }}>{patient.riskReason}</p>
            {patient.riskFlaggedAt && (
              <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>Flagged on {new Date(patient.riskFlaggedAt).toLocaleDateString()}</p>
            )}
          </div>
        </div>
      )}
      
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <button
            onClick={() => router.push('/dashboard/patients')}
            className="soft-card card-hover"
            style={{ width: 44, height: 44, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text-1)" }}
          >
            <ArrowLeft style={{ width: 20, height: 20 }} />
          </button>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-1)", letterSpacing: "-0.03em", marginBottom: 4 }}>
              Client Timeline
            </h1>
            <p style={{ fontSize: 14, color: "var(--text-3)" }}>Detailed session history and progress</p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button onClick={openNoteModal} className="btn-nm"
            style={{ padding: "10px 16px", gap: 8, fontWeight: 700, fontSize: 13, color: "var(--text-1)" }}>
            <Plus style={{ width: 15, height: 15, color: "var(--accent)" }} /> Add Note
          </button>
          <button onClick={isPractitioner ? openScheduleModal : () => setWizardOpen(true)} className="btn-nm"
            style={{ padding: "10px 16px", gap: 8, fontWeight: 700, fontSize: 13, color: "var(--text-1)" }}>
            <Calendar style={{ width: 15, height: 15, color: "var(--accent)" }} /> Schedule
          </button>
          <button onClick={openPastModal} className="btn-nm"
            style={{ padding: "10px 16px", gap: 8, fontWeight: 700, fontSize: 13, color: "var(--text-1)" }}>
            <RefreshCw style={{ width: 15, height: 15, color: "var(--accent)" }} /> Add Session
          </button>
          <button
            onClick={handleDeletePatient}
            className="btn-nm"
            style={{ padding: "10px 16px", gap: 8, fontWeight: 700, fontSize: 13, color: "var(--danger)" }}
          >
            <Trash2 style={{ width: 15, height: 15 }} /> Delete
          </button>
          <button
            onClick={() => {
              if (patient.riskFlag) {
                if (confirm("Are you sure you want to clear the risk flag?")) handleToggleRisk();
              } else {
                setRiskModalOpen(true);
              }
            }}
            className="btn-nm"
            style={{ padding: "10px 16px", gap: 8, fontWeight: 700, fontSize: 13, background: patient.riskFlag ? "var(--danger-bg)" : undefined, color: patient.riskFlag ? "var(--danger)" : "var(--text-3)" }}
          >
            <AlertCircle style={{ width: 15, height: 15 }} />
            {patient.riskFlag ? "Clear Risk Flag" : "Flag as High Risk"}
          </button>
        </div>
      </div>

      {caseModal && (
        <CaseStatusModal patient={{ id: patient.id, name: patient.name, caseStatus: patient.caseStatus }} onClose={() => setCaseModal(false)}
          onSaved={(updated) => { setCaseModal(false); setPatient(prev => prev ? { ...prev, ...updated } : prev); loadCaseInfo(); }} />
      )}
      {followModal && (
        <SetFollowUpModal patient={{ id: patient.id, name: patient.name }} onClose={() => setFollowModal(false)}
          onSaved={() => { setFollowModal(false); loadCaseInfo(); }} />
      )}
      {bookFollow && (
        <FollowUpBookModal followUp={bookFollow} onClose={() => setBookFollow(null)}
          onBooked={() => { setBookFollow(null); loadCaseInfo(); api.get(`/patients/${patient.id}/appointments`).then(r => setAppointments(r.data)).catch(() => {}); }} />
      )}
      {wizardOpen && (
        <NewBookingWizard prefill={{ name: patient.name, phone: patient.phone, email: patient.email }} onClose={() => setWizardOpen(false)}
          onBooked={() => { api.get(`/patients/${patient.id}/appointments`).then(r => setAppointments(r.data)).catch(() => {}); loadCaseInfo(); }} />
      )}

      <style dangerouslySetInnerHTML={{__html: `
        @media print {
          body * { visibility: hidden; }
          #summary-card, #summary-card * { visibility: visible; }
          #summary-card { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none !important; border: 1px solid #ddd; }
          .no-print { display: none !important; }
        }
      `}} />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 1fr) minmax(300px, 2.5fr)", gap: 24, alignItems: "start" }}>
        
        {/* Left Column: Patient Info & Metrics */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24, position: "sticky", top: 24 }}>
          
          {/* ONE-CLICK SESSION SUMMARY CARD */}
          {metrics && (
            <div id="summary-card" className="soft-card" style={{ borderRadius: 24, padding: 32, display: "flex", flexDirection: "column", gap: 24 }}>
              {/* Header & Badges */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 10 }}>
                    <BrainCircuit style={{ width: 24, height: 24, color: "var(--accent)" }} />
                    Treatment Summary
                  </h2>
                  <p style={{ fontSize: 13, color: "var(--text-3)", marginTop: 4 }}>Automatically generated overview based on {metrics.completed} session(s)</p>
                </div>

                <button onClick={() => alert("Summary exported as PDF.")} className="btn-nm no-print" style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600, gap: 6, color: "var(--text-1)" }}>
                  <Download style={{ width: 14, height: 14, color: "var(--accent)" }} /> Export
                </button>
              </div>

              {/* AI Generated Text Block */}
              <div className="soft-card-2" style={{ padding: "20px 24px", borderRadius: 16, borderLeft: "4px solid var(--accent)", background: "rgba(91, 109, 232, 0.03)" }}>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text-2)", fontStyle: "italic" }}>"{aiSummaryText}"</p>
              </div>

              {/* Key Metrics Grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
                <div className="soft-card-2" style={{ padding: 16, borderRadius: 16 }}>
                  <p style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Treatment Duration</p>
                  <p style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)" }}>{metrics.treatmentDuration} days</p>
                </div>
                <div className="soft-card-2" style={{ padding: 16, borderRadius: 16 }}>
                  <p style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Next Follow-up</p>
                  <p style={{ fontSize: 15, fontWeight: 700, color: metrics.upcomingFollowUp ? "var(--text-1)" : "var(--text-3)" }}>
                    {metrics.upcomingFollowUp ? new Date(metrics.upcomingFollowUp + "T00:00:00").toLocaleDateString() : "Not Scheduled"}
                  </p>
                </div>
                <div className="soft-card-2" style={{ padding: 16, borderRadius: 16 }}>
                  <p style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Progress Trend</p>
                  <p style={{ fontSize: 15, fontWeight: 700, color: metrics.progressTrend === "Improving" ? "var(--success)" : "var(--text-1)", display: "flex", alignItems: "center", gap: 6 }}>
                    <TrendingUp style={{ width: 14, height: 14 }} /> {metrics.progressTrend}
                  </p>
                </div>
                <div className="soft-card-2" style={{ padding: 16, borderRadius: 16 }}>
                  <p style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Primary Concerns</p>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {metrics.primaryConcerns}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Patient Card */}
          <SpotlightDiv className="soft-card card-hover" style={{ borderRadius: 24, padding: 28, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <div className="team-avatar" style={{ width: 80, height: 80, borderRadius: "50%", fontSize: 32, marginBottom: 16 }}>
              {patient.name.charAt(0).toUpperCase()}
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--text-1)", marginBottom: 4 }}>{patient.name}</h2>
            <p style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 16, fontFamily: "monospace" }}>ID: {patient.id.toString().padStart(5, "0")}</p>

            <button onClick={() => { setEditPatientForm({ name: patient.name, email: patient.email || "", phone: patient.phone || "" }); setEditPatientOpen(true); }}
              className="icon-btn" title="Edit Details"
              style={{ width: 34, height: 34, borderRadius: "50%", color: "var(--accent)", marginBottom: 16 }}>
              <Pencil style={{ width: 14, height: 14 }} />
            </button>

            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="soft-card-2" style={{ borderRadius: 14, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: "var(--text-2)" }}>
                <Phone style={{ width: 16, height: 16, color: "var(--accent)" }} />
                <span>{patient.phone || "No phone provided"}</span>
              </div>
              {patient.email && (
                <div className="soft-card-2" style={{ borderRadius: 14, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: "var(--text-2)" }}>
                  <Mail style={{ width: 16, height: 16, color: "var(--accent)" }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{patient.email}</span>
                </div>
              )}
              {isClinicContext && (
                <div className="soft-card-2" style={{ borderRadius: 14, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: "var(--text-2)" }}>
                  <Stethoscope style={{ width: 16, height: 16, color: "var(--accent)" }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {patientDoctor
                      ? `${patientDoctor.name}${patientDoctor.jobTitle ? ` · ${patientDoctor.jobTitle}` : ""}`
                      : "No doctor assigned yet"}
                  </span>
                </div>
              )}

            </div>
          </SpotlightDiv>

          {/* Session status & follow-up */}
          {(() => {
            const meta = caseStatusMeta(patient.caseStatus);
            const openFu = caseInfo.followUps.find(f => f.status === "PENDING" || f.status === "BOOKED");
            return (
              <div className="soft-card" style={{ borderRadius: 24, padding: 28 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 10 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 8 }}>
                    <Activity style={{ width: 16, height: 16, color: "var(--accent)" }} /> Session status
                  </h3>
                  <button onClick={() => setCaseModal(true)} className="btn-nm" style={{ padding: "7px 14px", gap: 6, fontWeight: 600, fontSize: 12, color: "var(--accent)" }}>
                    <Pencil style={{ width: 12, height: 12 }} /> Update
                  </button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <CaseStatusChip status={patient.caseStatus} />
                  {patient.caseStatusUpdatedAt && (
                    <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>since {psyFmtDay(patient.caseStatusUpdatedAt.slice(0, 10), { day: "numeric", month: "short", year: "numeric" })}</span>
                  )}
                </div>
                <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>{meta.hint}</p>
                {patient.caseStatusReason && !meta.open && (
                  <p style={{ fontSize: 12.5, color: "var(--text-2)", fontStyle: "italic", marginTop: 8 }}>“{patient.caseStatusReason}”</p>
                )}

                <div className="soft-card-2" style={{ borderRadius: 16, padding: "14px 16px", marginTop: 16 }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <CalendarClock style={{ width: 12, height: 12 }} /> Next follow-up
                  </p>
                  {openFu ? (
                    <>
                      <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text-1)" }}>
                        {psyRelativeDay(openFu.appointmentDate ?? openFu.dueDate)}
                        <span style={{ fontWeight: 500, color: "var(--text-3)", fontSize: 12 }}> · {psyFmtDay(openFu.appointmentDate ?? openFu.dueDate)}{openFu.appointmentStartTime ? ` · ${psyFmtTime(openFu.appointmentStartTime)}` : ""}</span>
                      </p>
                      <p style={{ fontSize: 11.5, color: openFu.status === "BOOKED" ? "var(--success)" : "var(--warning)", fontWeight: 600, marginTop: 3 }}>
                        {openFu.status === "BOOKED" ? "Session booked" : "Date set — not booked yet"}
                      </p>
                      {openFu.note && <p style={{ fontSize: 12, color: "var(--text-2)", marginTop: 6, fontStyle: "italic" }}>“{openFu.note}”</p>}
                      {openFu.status === "PENDING" && (
                        <button onClick={() => setBookFollow(openFu)} className="btn-nm-accent" style={{ marginTop: 12, padding: "7px 16px", fontSize: 12, fontWeight: 700, gap: 6 }}>
                          <CalendarCheck style={{ width: 13, height: 13 }} /> Book session
                        </button>
                      )}
                    </>
                  ) : meta.open ? (
                    <>
                      <p style={{ fontSize: 13, color: "var(--text-3)" }}>None scheduled.</p>
                      <button onClick={() => setFollowModal(true)} className="btn-nm" style={{ marginTop: 10, padding: "7px 14px", fontSize: 12, fontWeight: 700, gap: 6, color: "var(--accent)" }}>
                        <Plus style={{ width: 13, height: 13 }} /> Schedule next follow-up
                      </button>
                    </>
                  ) : (
                    <p style={{ fontSize: 13, color: "var(--text-3)" }}>Not needed — this case is {meta.label.toLowerCase()}.</p>
                  )}
                </div>

                {caseInfo.statusLog.length > 0 && (
                  <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                    <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>History</p>
                    {caseInfo.statusLog.slice(0, 4).map((l: any) => (
                      <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
                        <CaseStatusChip status={l.toStatus} size="sm" />
                        <span style={{ color: "var(--text-3)" }}>{l.createdAt ? psyFmtDay(l.createdAt.slice(0, 10), { day: "numeric", month: "short" }) : ""}{l.changedByName ? ` · ${l.changedByName}` : ""}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Attachments Card */}
          <div className="soft-card" style={{ borderRadius: 24, padding: 28 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 8 }}>
                <Paperclip style={{ width: 16, height: 16, color: "var(--accent)" }} /> Attachments
              </h3>
              <label className="btn-nm" style={{ padding: "7px 14px", gap: 6, fontWeight: 600, fontSize: 12, color: "var(--accent)", cursor: uploadingFile ? "default" : "pointer" }}>
                {uploadingFile ? (
                  <Loader2 style={{ width: 13, height: 13, animation: "spinSlow 1s linear infinite" }} />
                ) : (
                  <UploadCloud style={{ width: 13, height: 13 }} />
                )}
                {uploadingFile ? "Uploading..." : "Upload"}
                <input
                  type="file"
                  style={{ display: "none" }}
                  disabled={uploadingFile}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) handleUploadAttachment(file);
                  }}
                />
              </label>
            </div>

            {attachmentError && (
              <p style={{ fontSize: 12, color: "var(--danger)", marginBottom: 12 }}>{attachmentError}</p>
            )}

            {attachments.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--text-3)", fontStyle: "italic" }}>No files attached yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {attachments.map(att => (
                  <div key={att.id} className="soft-card-2" style={{ borderRadius: 14, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                    <FileText style={{ width: 16, height: 16, color: "var(--accent)", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p title={att.fileName} style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {att.fileName}
                      </p>
                      <p style={{ fontSize: 11, color: "var(--text-3)" }}>
                        {formatFileSize(att.fileSize)} · {new Date(att.uploadedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    </div>
                    <button
                      onClick={() => handleDownloadAttachment(att)}
                      disabled={downloadingAttachmentId === att.id}
                      className="icon-btn"
                      title="Download"
                    >
                      {downloadingAttachmentId === att.id
                        ? <Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} />
                        : <Download style={{ width: 14, height: 14 }} />}
                    </button>
                    <button
                      onClick={() => handleDeleteAttachment(att.id)}
                      disabled={deletingAttachmentId === att.id}
                      className="icon-btn"
                      title="Delete"
                      style={{ color: "var(--danger)" }}
                    >
                      {deletingAttachmentId === att.id
                        ? <Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} />
                        : <Trash2 style={{ width: 14, height: 14 }} />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Metrics Card */}
          {metrics && (
            <SpotlightDiv className="soft-card card-hover" style={{ borderRadius: 24, padding: 28 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)", marginBottom: 20 }}>Journey Summary</h3>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                <div className="soft-card-2" style={{ borderRadius: 16, padding: "16px", textAlign: "center" }}>
                  <p style={{ fontSize: 24, fontWeight: 800, color: "var(--accent)" }}>{metrics.total}</p>
                  <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", marginTop: 4 }}>Total Sessions</p>
                </div>
                <div className="soft-card-2" style={{ borderRadius: 16, padding: "16px", textAlign: "center" }}>
                  <p style={{ fontSize: 24, fontWeight: 800, color: metrics.attendanceRate > 75 ? "var(--success)" : "var(--warning)" }}>{metrics.attendanceRate}%</p>
                  <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", marginTop: 4 }}>Attendance</p>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottom: "1px solid var(--card-border)" }}>
                  <span style={{ fontSize: 13, color: "var(--text-3)" }}>First Visit</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>
                    {metrics.firstVisit ? new Date(metrics.firstVisit + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottom: "1px solid var(--card-border)" }}>
                  <span style={{ fontSize: 13, color: "var(--text-3)" }}>Last Visit</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>
                    {metrics.lastVisit ? new Date(metrics.lastVisit + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: "var(--text-3)" }}>Avg. Gap</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>
                    {metrics.avgGap > 0 ? `${metrics.avgGap} days` : "—"}
                  </span>
                </div>
              </div>
            </SpotlightDiv>
          )}

          {/* 🎭 Mood Trend Chart */}
          {moodLogs.length > 0 && (
            <div className="soft-card" style={{ borderRadius: 24, padding: 28 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)", marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
                <Smile style={{ width: 18, height: 18, color: "var(--accent)" }} /> Mood Trend
              </h3>
              <p style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 20 }}>Patient-reported scores after sessions</p>
              <div style={{ height: 160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={moodLogs.map(m => ({ date: new Date(m.logDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }), score: m.moodScore }))} margin={{ top: 5, right: 8, left: -24, bottom: 0 }}>
                    <CartesianGrid stroke={chartC.grid} vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: chartC.axisText, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis domain={[1, 10]} ticks={[1, 5, 10]} tick={{ fill: chartC.axisText, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip
                      content={<SeriesTooltip mode={themeMode} unit="point" />}
                      cursor={{ stroke: chartC.cursor, strokeWidth: 1 }}
                    />
                    <Line type="monotone" dataKey="score" stroke={chartC.accent} strokeWidth={2} dot={{ fill: chartC.accent, r: 3.5, stroke: chartC.surface, strokeWidth: 2 }} activeDot={{ r: 5, fill: chartC.accent, stroke: chartC.surface, strokeWidth: 2 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
                <span style={{ fontSize: 11, color: "var(--text-3)" }}>Avg: <strong style={{ color: "var(--text-1)" }}>{(moodLogs.reduce((s, m) => s + m.moodScore, 0) / moodLogs.length).toFixed(1)}/10</strong></span>
                <span style={{ fontSize: 11, color: "var(--text-3)" }}>Latest: <strong style={{ color: "var(--accent)" }}>{moodLogs[moodLogs.length - 1]?.moodScore}/10</strong></span>
              </div>
            </div>
          )}

        </div>

        {/* Right Column: Timeline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          
          {/* Controls */}
          <div className="soft-card" style={{ borderRadius: 20, padding: "16px 20px", display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ position: "relative", flex: 1 }}>
              <Search style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", width: 16, height: 16, color: "var(--text-3)" }} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search notes, types, status..."
                className="nm-input"
                style={{ paddingLeft: 44, width: "100%", borderRadius: 14 }}
              />
            </div>
            <button
              onClick={() => setSortDesc(!sortDesc)}
              className="btn-nm"
              style={{ padding: "12px 16px", gap: 8, fontWeight: 600, fontSize: 13, color: "var(--text-1)" }}
            >
              <ArrowDownUp style={{ width: 16, height: 16, color: "var(--accent)" }} />
              {sortDesc ? "Newest First" : "Oldest First"}
            </button>
          </div>

          {/* Timeline Nodes */}
          {filteredTimeline.length === 0 ? (
            <div className="soft-card" style={{ borderRadius: 24, padding: "60px 20px", textAlign: "center" }}>
              <Calendar style={{ width: 48, height: 48, color: "var(--text-3)", margin: "0 auto 16px" }} />
              <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-1)" }}>No sessions found</h3>
              <p style={{ fontSize: 14, color: "var(--text-3)" }}>Try adjusting your search criteria.</p>
            </div>
          ) : (
            <div style={{ position: "relative", paddingLeft: 24, display: "flex", flexDirection: "column", gap: 32 }}>
              {/* Timeline connecting line */}
              <div style={{ position: "absolute", top: 20, bottom: 20, left: 24, width: 2, background: "rgba(180,185,210,0.2)" }} />
              
              {filteredTimeline.map((apt) => {
                const apptInv = invoices[apt.id];
                const effectiveStatus =
                  (apptInv?.status === "PAID" || apptInv?.status === "WAIVED") &&
                  (apt.status === "AWAITING_PAYMENT" || apt.status === "PAYMENT_UNDER_REVIEW" || apt.status === "PENDING")
                    ? "CONFIRMED"
                    : apt.status;
                const st = STATUS_CFG[effectiveStatus] || STATUS_CFG.AWAITING_PAYMENT;
                const isExpanded = expandedId === apt.id;
                
                return (
                  <div key={apt.id} style={{ position: "relative", paddingLeft: 32 }}>
                    {/* Node Dot */}
                    <div style={{ 
                      position: "absolute", left: -6, top: 24, 
                      width: 14, height: 14, borderRadius: "50%", 
                      background: st.textColor, 
                      boxShadow: `0 0 0 4px var(--bg), 0 0 10px ${st.textColor}40` 
                    }} />

                    {/* Node Content */}
                    <div className="soft-card" style={{ borderRadius: 20, overflow: "hidden", transition: "all 0.3s ease" }}>
                      
                      {/* Node Header */}
                      <div style={{ padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: "var(--text-1)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                              {apt.sessionNumber != null ? `Session ${apt.sessionNumber}` : "Cancelled"}
                            </span>
                            {apt.returningPatient && (
                              <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 8, background: "var(--accent-surface)", color: "var(--accent)", display: "flex", alignItems: "center", gap: 4 }}>
                                <RefreshCw style={{ width: 9, height: 9 }} /> Returning
                              </span>
                            )}
                            <span style={{ fontSize: 12, color: "var(--text-3)", display: "flex", alignItems: "center", gap: 4 }}>
                              <Calendar style={{ width: 12, height: 12 }} />
                              {new Date(apt.appointmentDate + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                            </span>
                          </div>
                          <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 8 }}>
                            {apt.sessionType ? (services.find(s => s.id.toString() === apt.sessionType)?.name || apt.sessionType.replace(/_/g, " ")) : "Session"}
                            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-3)", display: "flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
                              <Clock style={{ width: 14, height: 14 }} /> {apt.startTime}
                              {(() => {
                                const len = minutesBetween(apt.startTime, apt.endTime);
                                return len > 0 ? <span style={{ marginLeft: 4, whiteSpace: "nowrap" }}>· {len} min</span> : null;
                              })()}
                            </span>
                          </h3>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {/* Payment Badge */}
                          {(() => {
                            const inv = invoices[apt.id];
                            if (!inv) return null;
                            const isPaid = inv.status === "PAID";
                            const isWaived = inv.status === "WAIVED";
                            const hasDiscount = (inv.discountAmount ?? 0) > 0;
                            const displayAmount = hasDiscount ? inv.finalAmount : inv.amount;
                            const fmtINR = (n?: number) => n != null ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n) : "";
                            return (
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  {!isPaid && !isWaived && (
                                    <button
                                      onClick={() => { setSessionPriceModal({ invoiceId: inv.id, currentAmount: inv.amount, aptId: apt.id }); setSessionPriceInput(inv.amount?.toString() ?? ""); setSessionPriceError(""); }}
                                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", padding: "2px 4px", borderRadius: 6, display: "flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 600 }}
                                      title="Set price"
                                    >
                                      <Pencil style={{ width: 10, height: 10 }} /> Set Price
                                    </button>
                                  )}
                                  <span style={{ fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 8,
                                    color: isPaid ? "var(--success)" : isWaived ? "var(--text-2)" : "var(--warning)",
                                    background: isPaid ? "var(--success-bg)" : isWaived ? "var(--sd)" : "var(--warning-bg)",
                                    display: "flex", alignItems: "center", gap: 4 }}>
                                    <DollarSign style={{ width: 10, height: 10 }} />
                                    {isPaid ? `Paid ${fmtINR(displayAmount)}` : isWaived ? "Waived" : `Unpaid ${fmtINR(inv.amount)}`}
                                  </span>
                                </div>
                                {hasDiscount && isPaid && (
                                  <span style={{ fontSize: 10, color: "var(--success)", display: "flex", alignItems: "center", gap: 3 }}>
                                    <span style={{ textDecoration: "line-through", color: "var(--text-3)" }}>{fmtINR(inv.amount)}</span>
                                    {inv.discountReason && ` · ${inv.discountReason}`}
                                  </span>
                                )}
                                {isPaid && inv.bankAccountName && (
                                  <span style={{ fontSize: 10, color: "var(--text-3)", fontStyle: "italic" }}>→ {inv.bankAccountName}</span>
                                )}
                              </div>
                            );
                          })()}
                            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 700, color: st.textColor, background: `${st.textColor}15`, padding: "6px 12px", borderRadius: 10 }}>
                            {st.icon} {st.label}
                          </div>
                          <button
                            onClick={() => {
                              setEditSessionId(apt.id);
                              setEditSessionForm({
                                appointmentDate: apt.appointmentDate,
                                startTime: apt.startTime,
                                sessionType: apt.sessionType || "",
                                notes: apt.notes || "",
                                mode: apt.mode || "",
                                // Prefill with the length it actually has; a placeholder
                                // row with no real length falls back to "keep existing".
                                durationMinutes: (() => {
                                  const len = minutesBetween(apt.startTime, apt.endTime);
                                  return len >= MIN_SESSION_MINUTES && len <= MAX_SESSION_MINUTES ? len : "";
                                })(),
                              });
                              setEditSessionOpen(true);
                            }}
                            className="icon-btn"
                            title="Edit session"
                          >
                            <Pencil style={{ width: 14, height: 14 }} />
                          </button>
                          <button
                            onClick={() => handleDeleteSession(apt.id)}
                            className="icon-btn"
                            title="Delete session"
                          >
                            <Trash2 style={{ width: 14, height: 14 }} />
                          </button>
                        </div>
                      </div>

                      {/* Expandable Body */}
                      <div className="soft-card-2" style={{
                        margin: isExpanded ? "0 12px 12px 12px" : "0",
                        padding: isExpanded ? "20px" : "0",
                        borderRadius: 16,
                        maxHeight: isExpanded ? "800px" : "0",
                        opacity: isExpanded ? 1 : 0,
                        overflow: "hidden",
                        transition: "all 0.35s ease",
                        display: "flex", flexDirection: "column", gap: 16
                      }}>
                        {/* Patient booking note */}
                        {apt.notes ? (
                          <div>
                            <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", marginBottom: 6 }}>Session Notes / Reason</p>
                            <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>{apt.notes}</p>
                          </div>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-3)", fontSize: 13 }}>
                            <FileText style={{ width: 16, height: 16 }} /> No patient notes for this session.
                          </div>
                        )}

                        {apt.rating && (
                          <div style={{ borderTop: "1px solid rgba(180,185,210,0.1)", paddingTop: 16, marginTop: 4 }}>
                            <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                              Patient Feedback
                            </p>
                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
                              {[1, 2, 3, 4, 5].map(i => (
                                <Star 
                                  key={i} 
                                  style={{
                                    width: 16, height: 16,
                                    color: "var(--warning)",
                                    fill: i <= apt.rating! ? "var(--warning)" : "transparent"
                                  }}
                                />
                              ))}
                              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-1)", marginLeft: 6 }}>{apt.rating}/5</span>
                            </div>
                            {apt.feedback && (
                              <p style={{ fontSize: 13, color: "var(--text-2)", fontStyle: "italic", lineHeight: 1.5 }}>
                                "{apt.feedback}"
                              </p>
                            )}
                          </div>
                        )}

                        {/* Cancellation reason */}
                        {apt.status === "CANCELLED" && apt.cancellationReason && (
                          <div style={{ padding: "12px 16px", borderRadius: 12, background: "var(--danger-bg)", border: "1px solid var(--danger-brd)" }}>
                            <p style={{ fontSize: 11, fontWeight: 700, color: "var(--danger)", textTransform: "uppercase", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                              <AlertCircle style={{ width: 12, height: 12 }} /> Cancellation Reason
                            </p>
                            <p style={{ fontSize: 13, color: "var(--text-2)" }}>{apt.cancellationReason}</p>
                          </div>
                        )}

                        {/* Mood for this session */}
                        {(() => {
                          const mood = moodLogs.find(m => m.appointmentId === apt.id);
                          if (!mood) return null;
                          const EMOJIS = ["😞","😟","😕","😐","🙂","😊","😄","😁","🤩","🥳"];
                          return (
                            <div style={{ padding: "12px 16px", borderRadius: 12, background: "var(--accent-surface)", border: "1px solid var(--accent-border)", display: "flex", alignItems: "center", gap: 12 }}>
                              <span style={{ fontSize: 28 }}>{EMOJIS[mood.moodScore - 1]}</span>
                              <div>
                                <p style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", marginBottom: 2 }}>Post-Session Mood</p>
                                <p style={{ fontSize: 13, color: "var(--text-2)" }}>{mood.moodScore}/10{mood.note ? ` — "${mood.note}"` : ""}</p>
                              </div>
                            </div>
                          );
                        })()}

                        {/* 🔒 Private Clinical Notes */}
                        <div style={{ borderTop: "1px solid rgba(180,185,210,0.15)", paddingTop: 16 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                            <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
                              <Lock style={{ width: 11, height: 11 }} /> Private Clinical Notes (SOAP)
                            </p>
                            {editingNoteId !== apt.id && (
                              <button onClick={() => {
                                setEditingNoteId(apt.id);
                                const existing = sessionNotes[apt.id];
                                setSoapNote({
                                  subjective: existing?.subjective || "",
                                  objective: existing?.objective || "",
                                  assessment: existing?.assessment || "",
                                  plan: existing?.plan || "",
                                });
                              }}
                                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                                <Pencil style={{ width: 12, height: 12 }} />
                                {sessionNotes[apt.id] ? "Edit" : "Add Note"}
                              </button>
                            )}
                          </div>

                          {editingNoteId === apt.id ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <label style={{ fontSize: 12, fontWeight: 700, color: "#3b82f6", display: "flex", alignItems: "center", gap: 6 }}><span style={{width: 8, height: 8, borderRadius: '50%', background: '#3b82f6'}}></span> Subjective</label>
                                <textarea value={soapNote.subjective} onChange={e => setSoapNote({...soapNote, subjective: e.target.value})} placeholder="What the patient reported..." rows={2} className="soft-card-2" style={{ width: "100%", padding: "10px 12px", borderRadius: 8, color: "var(--text-1)", fontSize: 13, resize: "vertical", outline: "none", fontFamily: "inherit" }} />
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <label style={{ fontSize: 12, fontWeight: 700, color: "#10b981", display: "flex", alignItems: "center", gap: 6 }}><span style={{width: 8, height: 8, borderRadius: '50%', background: '#10b981'}}></span> Objective</label>
                                <textarea value={soapNote.objective} onChange={e => setSoapNote({...soapNote, objective: e.target.value})} placeholder="Therapist's observations..." rows={2} className="soft-card-2" style={{ width: "100%", padding: "10px 12px", borderRadius: 8, color: "var(--text-1)", fontSize: 13, resize: "vertical", outline: "none", fontFamily: "inherit" }} />
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <label style={{ fontSize: 12, fontWeight: 700, color: "#f59e0b", display: "flex", alignItems: "center", gap: 6 }}><span style={{width: 8, height: 8, borderRadius: '50%', background: '#f59e0b'}}></span> Assessment</label>
                                <textarea value={soapNote.assessment} onChange={e => setSoapNote({...soapNote, assessment: e.target.value})} placeholder="Diagnosis / clinical impression..." rows={2} className="soft-card-2" style={{ width: "100%", padding: "10px 12px", borderRadius: 8, color: "var(--text-1)", fontSize: 13, resize: "vertical", outline: "none", fontFamily: "inherit" }} />
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <label style={{ fontSize: 12, fontWeight: 700, color: "#8b5cf6", display: "flex", alignItems: "center", gap: 6 }}><span style={{width: 8, height: 8, borderRadius: '50%', background: '#8b5cf6'}}></span> Plan</label>
                                <textarea value={soapNote.plan} onChange={e => setSoapNote({...soapNote, plan: e.target.value})} placeholder="Treatment plan / homework..." rows={2} className="soft-card-2" style={{ width: "100%", padding: "10px 12px", borderRadius: 8, color: "var(--text-1)", fontSize: 13, resize: "vertical", outline: "none", fontFamily: "inherit" }} />
                              </div>

                              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                                <button onClick={async () => {
                                  setSavingNote(true);
                                  try {
                                    await api.post("/notes", { appointmentId: apt.id, ...soapNote });
                                    await fetchNotes(params.id);
                                    setEditingNoteId(null);
                                  } catch(e) { console.error(e); }
                                  finally { setSavingNote(false); }
                                }}
                                  disabled={savingNote}
                                  className="btn-nm-accent"
                                  style={{ padding: "8px 16px", gap: 6, fontWeight: 600, fontSize: 12 }}>
                                  <Save style={{ width: 13, height: 13 }} />{savingNote ? "Saving..." : "Save"}
                                </button>
                                <button onClick={() => setEditingNoteId(null)}
                                  className="btn-nm"
                                  style={{ padding: "8px 14px", fontWeight: 600, fontSize: 12 }}>
                                  Cancel
                                </button>
                                {sessionNotes[apt.id] && (
                                  <button onClick={async () => {
                                    if(!confirm('Delete this note?')) return;
                                    try {
                                      await api.delete(`/notes/${sessionNotes[apt.id].id}`);
                                      await fetchNotes(params.id);
                                      setEditingNoteId(null);
                                    } catch(e) { console.error(e); }
                                  }}
                                    className="icon-btn"
                                    style={{ marginLeft: "auto", padding: "8px 14px", gap: 4, fontWeight: 600, fontSize: 12, color: "var(--danger)" }}>
                                    <Trash2 style={{ width: 12, height: 12 }} /> Delete
                                  </button>
                                )}
                              </div>
                            </div>
                          ) : (
                            sessionNotes[apt.id] ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                                {sessionNotes[apt.id].subjective && (
                                  <div style={{ display: "flex", gap: 12 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: "#3b82f6", marginTop: 2 }}>S</span>
                                    <span style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{sessionNotes[apt.id].subjective}</span>
                                  </div>
                                )}
                                {sessionNotes[apt.id].objective && (
                                  <div style={{ display: "flex", gap: 12 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: "#10b981", marginTop: 2 }}>O</span>
                                    <span style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{sessionNotes[apt.id].objective}</span>
                                  </div>
                                )}
                                {sessionNotes[apt.id].assessment && (
                                  <div style={{ display: "flex", gap: 12 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: "#f59e0b", marginTop: 2 }}>A</span>
                                    <span style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{sessionNotes[apt.id].assessment}</span>
                                  </div>
                                )}
                                {sessionNotes[apt.id].plan && (
                                  <div style={{ display: "flex", gap: 12 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: "#8b5cf6", marginTop: 2 }}>P</span>
                                    <span style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{sessionNotes[apt.id].plan}</span>
                                  </div>
                                )}
                                {sessionNotes[apt.id].content && !sessionNotes[apt.id].subjective && !sessionNotes[apt.id].objective && !sessionNotes[apt.id].assessment && !sessionNotes[apt.id].plan && (
                                  <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                                    {sessionNotes[apt.id].content}
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p style={{ fontSize: 13, color: "var(--text-3)", fontStyle: "italic" }}>No clinical notes recorded.</p>
                            )
                          )}
                        </div>
                      </div>

                      {/* Expand Toggle — always shown */}
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : apt.id)}
                        style={{
                          width: "100%", padding: "12px", background: "transparent", border: "none",
                          borderTop: "1px solid rgba(180,185,210,0.1)", cursor: "pointer",
                          display: "flex", justifyContent: "center", alignItems: "center", gap: 6,
                          color: "var(--text-3)", fontSize: 12, fontWeight: 600, transition: "color 0.2s"
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = "var(--text-1)"}
                        onMouseLeave={e => e.currentTarget.style.color = "var(--text-3)"}
                      >
                        {isExpanded ? (
                          <><ChevronUp style={{ width: 14, height: 14 }} /> Hide Details</>
                        ) : (
                          <><ChevronDown style={{ width: 14, height: 14 }} /> View Details & Notes</>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Add Note Modal */}
      {noteModalOpen && typeof document !== "undefined" && createPortal(
        <div className="overlay-enter" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 9999 }} onClick={() => setNoteModalOpen(false)}>
          <div className="soft-card anim-scale-in" style={{ width: "100%", maxWidth: 500, maxHeight: "90vh", overflowY: "auto", padding: 32 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 20, fontWeight: 800, color: "var(--text-1)", marginBottom: 20 }}>Add Session Note</h3>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Select Session</label>
                <select
                  className="nm-input"
                  style={{ width: "100%", padding: 12, borderRadius: 14, color: "var(--text-1)" }}
                  value={noteSessionId}
                  disabled={notableSessions.length === 0}
                  onChange={e => {
                    const id = Number(e.target.value);
                    setNoteSessionId(id);
                    const apt = appointments.find(a => a.id === id);
                    setModalNoteText(apt?.notes || "");
                  }}
                >
                  <option value="">-- Choose a session --</option>
                  {notableSessions.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.appointmentDate} — {a.sessionType || "Session"} ({STATUS_CFG[a.status]?.label ?? a.status})
                    </option>
                  ))}
                </select>

                {/* A note always attaches to a session, so with nothing to
                    attach it to the dropdown is empty and Save stays greyed
                    out forever. Saying why — and which of the two reasons it
                    is — beats leaving the user clicking a dead control. */}
                {notableSessions.length === 0 && (
                  <p style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5, color: "var(--text-3)" }}>
                    {appointments.length === 0
                      ? <>This client has no sessions yet. Use <strong style={{ color: "var(--text-2)" }}>Add Session</strong> to record a past session, or <strong style={{ color: "var(--text-2)" }}>Schedule</strong> to book a new one — then you can write a note against it.</>
                      : <>This client&apos;s only sessions are cancelled, so there&apos;s nothing to write a note against. Add or schedule a session first.</>}
                  </p>
                )}
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Notes</label>
                <textarea 
                  className="nm-input" 
                  style={{ width: "100%", padding: 16, borderRadius: 14, minHeight: 120, color: "var(--text-1)", resize: "vertical" }}
                  value={modalNoteText}
                  onChange={e => setModalNoteText(e.target.value)}
                  placeholder="Type your notes here..."
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 16 }}>
                <button onClick={() => setNoteModalOpen(false)} className="btn-nm" style={{ padding: "10px 20px", fontWeight: 600 }}>Cancel</button>
                <button
                  onClick={handleSaveNote}
                  disabled={noteSaving || !noteSessionId || !modalNoteText}
                  className="btn-nm-accent"
                  style={{ padding: "10px 20px", fontWeight: 700 }}
                >
                  {noteSaving ? "Saving..." : "Save Note"}
                </button>
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Schedule Modal */}
      {scheduleModalOpen && typeof document !== "undefined" && createPortal(
        <div className="overlay-enter" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 9999 }} onClick={() => setScheduleModalOpen(false)}>
          <div className="soft-card anim-scale-in" style={{ width: "100%", maxWidth: 500, maxHeight: "90vh", overflowY: "auto", padding: 32 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 20, fontWeight: 800, color: "var(--text-1)", marginBottom: 20 }}>Schedule Session</h3>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {(() => {
                const schedServices = offeredSchedServiceIds
                  ? services.filter(s => offeredSchedServiceIds.has(s.id.toString()))
                  : services;
                const noneOffered = offeredSchedServiceIds !== null && schedServices.length === 0;
                return (
                  <div>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Session Type</label>
                    <select
                      className="nm-input"
                      style={{ width: "100%", padding: 12, borderRadius: 14, color: "var(--text-1)" }}
                      value={schedType}
                      onChange={e => {
                        setSchedType(e.target.value);
                        // When the length is coming from the service, a
                        // different service brings its own default — drop any
                        // earlier manual pick so the two can't disagree. When
                        // it comes from the doctor's availability the service
                        // doesn't affect it, so the pick stays.
                        if (schedDefault.source !== "availability") setSchedDurationOverride(null);
                      }}
                      disabled={noneOffered}
                    >
                      <option value="">-- Choose a service --</option>
                      {schedServices.map(s => (
                        <option key={s.id} value={s.id.toString()}>{s.name}</option>
                      ))}
                    </select>
                    {noneOffered && (
                      <p style={{ fontSize: 12, color: "var(--warning)", marginTop: 6 }}>
                        No {schedMode === "ONLINE" ? "online" : "in-person"} services are priced{schedDoctorId ? " for this doctor" : ""} yet.{" "}
                        <Link href="/dashboard/services" style={{ color: "var(--accent)", fontWeight: 700 }}>Set pricing in Services</Link>.
                      </p>
                    )}
                  </div>
                );
              })()}

              {staffDoctors.length > 0 && (
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Doctor</label>
                  <select
                    className="nm-input"
                    style={{ width: "100%", padding: 12, borderRadius: 14, color: "var(--text-1)" }}
                    value={schedDoctorId}
                    onChange={e => {
                      const next = e.target.value;
                      setSchedDoctorId(next);
                      setSchedTime("");
                      // Each doctor has their own calendar — the slots effect
                      // re-fetches for whichever one is now selected...
                      // ...and they have their own priced service list and
                      // their own availability (which sets the default length).
                      fetchServicePricing(next);
                      fetchAvailability(next);
                    }}
                  >
                    <option value="">Myself</option>
                    {staffDoctors.map(d => (
                      <option key={d.id} value={d.id.toString()}>{d.name}{d.jobTitle ? ` — ${d.jobTitle}` : ""}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Mode</label>
                <ModeToggle value={schedMode} onChange={m => {
                  setSchedMode(m);
                  setSchedTime("");
                  // Online and in-person can be genuinely separate calendars —
                  // the slots effect re-fetches for the new mode's calendar.
                }} />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Session Length</label>
                <SessionLengthSelect
                  value={schedDuration}
                  onChange={v => { if (v !== "") setSchedDurationOverride(v); }}
                />
                <p style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6, lineHeight: 1.5 }}>
                  {schedDefault.source === "availability"
                    ? `Default ${schedDefault.minutes} min — the session length in ${schedDoctorId ? "the doctor's" : "your"} ${schedMode === "ONLINE" ? "online" : "in-person"} availability for ${new Date(schedDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" })}s.`
                    : schedDefault.source === "service"
                      ? `Default ${schedDefault.minutes} min — the service's usual length. Pick a date to use your availability's session length instead.`
                      : `Default ${schedDefault.minutes} min.`}
                  {" "}You can change it for this patient; only times where a session this long fits are offered. The fee
                  doesn&apos;t change with the length — use Amount below to adjust it.
                  {schedDurationOverride !== null && schedDurationOverride !== schedDefault.minutes && (
                    <>
                      {" "}
                      <button type="button" onClick={() => setSchedDurationOverride(null)}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", fontWeight: 700, fontSize: 11 }}>
                        Reset to {schedDefault.minutes} min
                      </button>
                    </>
                  )}
                </p>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Date</label>
                <input
                  type="date"
                  className="nm-input"
                  style={{ width: "100%", padding: 12, borderRadius: 14, color: "var(--text-1)" }}
                  min={new Date().toISOString().split('T')[0]}
                  value={schedDate}
                  onChange={e => {
                    setSchedDate(e.target.value);
                    setSchedTime("");
                  }}
                />
              </div>

              {schedDate && (
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Time</label>
                  {slotsLoading ? (
                    <p style={{ fontSize: 13, color: "var(--text-3)" }}>Checking available times…</p>
                  ) : availableSlots.length === 0 ? (
                    <p style={{ fontSize: 13, color: "var(--warning)" }}>No available slots for this date and session length.</p>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                      {availableSlots.map(time => (
                        <button
                          key={time}
                          onClick={() => setSchedTime(time)}
                          className="soft-card-2"
                          style={{
                            padding: "10px 0", borderRadius: 12, border: "none", cursor: "pointer",
                            background: schedTime === time ? "var(--accent)" : undefined,
                            color: schedTime === time ? "#fff" : "var(--text-2)",
                            fontWeight: 600, fontSize: 13,
                            transition: "all 0.2s"
                          }}
                        >
                          {time}
                        </button>
                      ))}
                    </div>
                  )}
                  {!slotsLoading && schedTime && addMinutesToTime(schedTime, schedDuration) && (
                    <p style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginTop: 10 }}>
                      Session runs {schedTime} – {addMinutesToTime(schedTime, schedDuration)} ({schedDuration} min)
                    </p>
                  )}
                </div>
              )}

              <div style={{ borderTop: "1px solid rgba(180,185,210,0.15)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Payment</p>
                <div style={{ display: "flex", gap: 10 }}>
                  {(["AWAITING", "PAID", "RECEPTION"] as const).map(s => (
                    <button key={s} type="button" onClick={() => setSchedPayStatus(s)}
                      style={{ flex: 1, padding: "9px 0", borderRadius: 10, border: `1.5px solid ${schedPayStatus === s ? "var(--accent)" : "transparent"}`, background: schedPayStatus === s ? "var(--accent-surface)" : "transparent", color: schedPayStatus === s ? "var(--accent)" : "var(--text-2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                      {s === "AWAITING" ? "Pay Online" : s === "PAID" ? "Paid" : "Pass to Reception"}
                    </button>
                  ))}
                </div>
                {schedPayStatus === "RECEPTION" && (
                  <p style={{ fontSize: 11, color: "var(--text-3)", margin: 0, lineHeight: 1.5 }}>
                    The session is confirmed right away. No online payment link is sent — the front desk will collect
                    payment (in full or in parts) and it&apos;ll show up in their Pending Payments queue.
                  </p>
                )}
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6 }}>Amount (₹) — leave blank to use service fee</label>
                  <input type="number" className="nm-input" placeholder="e.g. 800" value={schedPayAmount} onChange={e => setSchedPayAmount(e.target.value)}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }} />
                </div>
                {schedPayStatus === "PAID" && (
                  <>
                    <div>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6 }}>Payment Method</label>
                      <select className="nm-input" value={schedPayMethod} onChange={e => setSchedPayMethod(e.target.value)}
                        style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }}>
                        {["CASH","UPI","CARD","MANUAL_TRANSFER","INSURANCE"].map(m => <option key={m} value={m}>{m.replace("_"," ")}</option>)}
                      </select>
                    </div>
                    {bankAccounts.length > 0 && (
                      <div>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6 }}>Payment Credited To</label>
                        <select className="nm-input" style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }}
                          value={schedBankAccountId}
                          onChange={e => {
                            const acc = bankAccounts.find(b => b.id === Number(e.target.value));
                            setSchedBankAccountId(acc ? acc.id : "");
                            setSchedBankAccountName(acc ? acc.accountName : "");
                          }}>
                          <option value="">-- Select account --</option>
                          {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.accountName} — {b.bankName}{b.isDefault ? " (Default)" : ""}</option>)}
                        </select>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 8 }}>
                <button onClick={() => setScheduleModalOpen(false)} className="btn-nm" style={{ padding: "10px 20px", fontWeight: 600 }}>Cancel</button>
                <button
                  onClick={handleSchedule}
                  disabled={schedSaving || !schedDate || !schedTime || !schedType}
                  className="btn-nm-accent"
                  style={{ padding: "10px 20px", fontWeight: 700 }}
                >
                  {schedSaving ? "Booking..." : "Confirm Booking"}
                </button>
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Add Past Session Modal */}
      {pastModalOpen && typeof document !== "undefined" && createPortal(
        <div className="overlay-enter" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 9999 }} onClick={() => setPastModalOpen(false)}>
          <div className="soft-card anim-scale-in" style={{ width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto", padding: 32 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 20, fontWeight: 800, color: "var(--text-1)", marginBottom: 4 }}>Add Past Session</h3>
            <p style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 24 }}>Record a session that already took place. No notifications will be sent.</p>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Session Type</label>
                <select className="nm-input" style={{ width: "100%", padding: 12, borderRadius: 14, color: "var(--text-1)" }}
                  value={pastType} onChange={e => { setPastType(e.target.value); setPastDurationOverride(null); }}>
                  <option value="">-- Choose a service --</option>
                  {services.map(s => <option key={s.id} value={s.id.toString()}>{s.name}</option>)}
                </select>
              </div>

              {staffDoctors.length > 0 && (
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Doctor</label>
                  <select className="nm-input" style={{ width: "100%", padding: 12, borderRadius: 14, color: "var(--text-1)" }}
                    value={pastDoctorId} onChange={e => setPastDoctorId(e.target.value)}>
                    <option value="">Myself</option>
                    {staffDoctors.map(d => (
                      <option key={d.id} value={d.id.toString()}>{d.name}{d.jobTitle ? ` — ${d.jobTitle}` : ""}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Mode</label>
                <ModeToggle value={pastMode} onChange={setPastMode} />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Session Length</label>
                <SessionLengthSelect
                  value={pastDuration}
                  onChange={v => { if (v !== "") setPastDurationOverride(v); }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Date</label>
                <MiniCalendar value={pastDate} onChange={setPastDate} maxDate={new Date()} />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Time</label>
                <input type="time" className="nm-input" style={{ width: "100%", padding: 12, borderRadius: 14, color: "var(--text-1)" }}
                  value={pastTime} onChange={e => setPastTime(e.target.value)} />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Status</label>
                <select className="nm-input" style={{ width: "100%", padding: 12, borderRadius: 14, color: "var(--text-1)" }}
                  value={pastStatus} onChange={e => setPastStatus(e.target.value)}>
                  <option value="COMPLETED">Completed</option>
                  <option value="CONFIRMED">Confirmed (attended, not yet completed)</option>
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 8 }}>Notes (optional)</label>
                <textarea className="nm-input" rows={3} placeholder="Session notes..."
                  style={{ width: "100%", padding: 12, borderRadius: 14, color: "var(--text-1)", resize: "vertical" }}
                  value={pastNotes} onChange={e => setPastNotes(e.target.value)} />
              </div>

              <div style={{ borderTop: "1px solid rgba(180,185,210,0.15)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Payment</p>
                <div style={{ display: "flex", gap: 10 }}>
                  {(["AWAITING", "PAID"] as const).map(s => (
                    <button key={s} type="button" onClick={() => setPastPayStatus(s)}
                      style={{ flex: 1, padding: "9px 0", borderRadius: 10, border: `1.5px solid ${pastPayStatus === s ? "var(--accent)" : "transparent"}`, background: pastPayStatus === s ? "var(--accent-surface)" : "transparent", color: pastPayStatus === s ? "var(--accent)" : "var(--text-2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                      {s === "AWAITING" ? "Awaiting Payment" : "Paid"}
                    </button>
                  ))}
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6 }}>Amount (₹) — leave blank to use service fee</label>
                  <input type="number" className="nm-input" placeholder="e.g. 800" value={pastPayAmount} onChange={e => setPastPayAmount(e.target.value)}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }} />
                </div>
                {pastPayStatus === "PAID" && (
                  <>
                    <div>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6 }}>Payment Method</label>
                      <select className="nm-input" value={pastPayMethod} onChange={e => setPastPayMethod(e.target.value)}
                        style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }}>
                        {["CASH","UPI","CARD","MANUAL_TRANSFER","INSURANCE"].map(m => <option key={m} value={m}>{m.replace("_"," ")}</option>)}
                      </select>
                    </div>
                    {bankAccounts.length > 0 && (
                      <div>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6 }}>Payment Credited To</label>
                        <select className="nm-input" style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }}
                          value={pastBankAccountId}
                          onChange={e => {
                            const acc = bankAccounts.find(b => b.id === Number(e.target.value));
                            setPastBankAccountId(acc ? acc.id : "");
                            setPastBankAccountName(acc ? acc.accountName : "");
                          }}>
                          <option value="">-- Select account --</option>
                          {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.accountName} — {b.bankName}{b.isDefault ? " (Default)" : ""}</option>)}
                        </select>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 8 }}>
                <button onClick={() => setPastModalOpen(false)} className="btn-nm" style={{ padding: "10px 20px", fontWeight: 600 }}>Cancel</button>
                <button onClick={handleAddPastSession} disabled={pastSaving || !pastDate || !pastTime || !pastType}
                  className="btn-nm-accent"
                  style={{ padding: "10px 20px", fontWeight: 700 }}>
                  {pastSaving ? "Saving..." : "Save Session"}
                </button>
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Set Session Price Modal */}
      {sessionPriceModal && typeof document !== "undefined" && createPortal(
        <div className="overlay-enter" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 9999 }} onClick={() => setSessionPriceModal(null)}>
          <div className="soft-card anim-scale-in" style={{ width: "100%", maxWidth: 360, padding: 32 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <h3 style={{ fontSize: 18, fontWeight: 800, color: "var(--text-1)" }}>Set Session Price</h3>
              <button onClick={() => setSessionPriceModal(null)} className="icon-btn"><X style={{ width: 20, height: 20 }} /></button>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 24 }}>
              Current price: <strong style={{ color: "var(--text-2)" }}>₹{sessionPriceModal.currentAmount}</strong>
            </p>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", marginBottom: 8 }}>New Amount (₹)</label>
            <input
              type="number" min="1" step="any" autoFocus
              value={sessionPriceInput}
              onChange={e => { setSessionPriceInput(e.target.value); setSessionPriceError(""); }}
              onKeyDown={e => { if (e.key === "Enter") handleSetSessionPrice(); }}
              className="nm-input no-icon"
              style={{ width: "100%", padding: "14px 16px", fontSize: 16, fontWeight: 700, marginBottom: 8, boxSizing: "border-box" }}
            />
            {sessionPriceError && <p style={{ fontSize: 12, color: "var(--danger)", marginBottom: 12 }}>{sessionPriceError}</p>}
            {sessionPriceInput && !sessionPriceError && parseFloat(sessionPriceInput) > 0 && parseFloat(sessionPriceInput) !== sessionPriceModal.currentAmount && (
              <p style={{ fontSize: 12, marginBottom: 12, color: parseFloat(sessionPriceInput) < sessionPriceModal.currentAmount ? "#15803d" : "#d97706" }}>
                {parseFloat(sessionPriceInput) < sessionPriceModal.currentAmount
                  ? `↓ Reduced by ₹${(sessionPriceModal.currentAmount - parseFloat(sessionPriceInput)).toFixed(0)}`
                  : `↑ Increased by ₹${(parseFloat(sessionPriceInput) - sessionPriceModal.currentAmount).toFixed(0)}`}
              </p>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button onClick={() => setSessionPriceModal(null)}
                className="btn-nm" style={{ flex: 1, padding: "12px", fontWeight: 600, fontSize: 14 }}>
                Cancel
              </button>
              <button onClick={handleSetSessionPrice} disabled={sessionPriceSaving || !sessionPriceInput}
                className="btn-nm-accent" style={{ flex: 2, padding: "12px", fontWeight: 700, fontSize: 14 }}>
                {sessionPriceSaving ? "Saving..." : "Confirm Price"}
              </button>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Edit Patient Modal */}
      {editPatientOpen && typeof document !== "undefined" && createPortal(
        <div className="overlay-enter" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 9999 }} onClick={() => setEditPatientOpen(false)}>
          <div className="soft-card anim-scale-in" style={{ width: "100%", maxWidth: 420, padding: 32 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ fontSize: 18, fontWeight: 800, color: "var(--text-1)" }}>Edit Patient Details</h3>
              <button onClick={() => setEditPatientOpen(false)} className="icon-btn"><X style={{ width: 20, height: 20 }} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {(["name", "phone", "email"] as const).map(field => (
                <div key={field}>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6, textTransform: "uppercase" }}>
                    {field === "name" ? "Full Name" : field === "phone" ? "Phone Number" : "Email Address (optional)"}
                  </label>
                  <input
                    className="nm-input"
                    type={field === "email" ? "email" : "text"}
                    value={editPatientForm[field]}
                    onChange={e => setEditPatientForm(prev => ({ ...prev, [field]: e.target.value }))}
                    style={{ width: "100%", padding: "10px 14px", borderRadius: 12, color: "var(--text-1)" }}
                  />
                </div>
              ))}
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <button onClick={() => setEditPatientOpen(false)}
                  className="btn-nm" style={{ flex: 1, padding: "11px 0", fontWeight: 600 }}>
                  Cancel
                </button>
                <button onClick={handleEditPatient} disabled={editPatientSaving || !editPatientForm.name.trim() || !editPatientForm.phone.trim()}
                  className="btn-nm-accent" style={{ flex: 2, padding: "11px 0", fontWeight: 700, fontSize: 14 }}>
                  {editPatientSaving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Edit Session Modal */}
      {editSessionOpen && typeof document !== "undefined" && createPortal(
        <div className="overlay-enter" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 9999 }} onClick={() => setEditSessionOpen(false)}>
          <div className="soft-card anim-scale-in" style={{ width: "100%", maxWidth: 460, maxHeight: "90vh", overflowY: "auto", padding: 32 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ fontSize: 18, fontWeight: 800, color: "var(--text-1)" }}>Edit Session</h3>
              <button onClick={() => setEditSessionOpen(false)} className="icon-btn"><X style={{ width: 20, height: 20 }} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6, textTransform: "uppercase" }}>Session Type</label>
                <select className="nm-input" value={editSessionForm.sessionType} onChange={e => setEditSessionForm(p => ({ ...p, sessionType: e.target.value }))}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }}>
                  <option value="">-- Keep existing --</option>
                  {services.map(s => <option key={s.id} value={s.id.toString()}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6, textTransform: "uppercase" }}>Mode</label>
                <select className="nm-input" value={editSessionForm.mode} onChange={e => setEditSessionForm(p => ({ ...p, mode: e.target.value }))}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }}>
                  <option value="">-- Keep existing --</option>
                  <option value="OFFLINE">In-person</option>
                  <option value="ONLINE">Online</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6, textTransform: "uppercase" }}>Date</label>
                <input type="date" className="nm-input" value={editSessionForm.appointmentDate}
                  onChange={e => setEditSessionForm(p => ({ ...p, appointmentDate: e.target.value }))}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6, textTransform: "uppercase" }}>Time</label>
                <input type="time" className="nm-input" value={editSessionForm.startTime}
                  onChange={e => setEditSessionForm(p => ({ ...p, startTime: e.target.value }))}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)" }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6, textTransform: "uppercase" }}>Session Length</label>
                <SessionLengthSelect keepExisting compact
                  value={editSessionForm.durationMinutes}
                  onChange={v => setEditSessionForm(p => ({ ...p, durationMinutes: v }))} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-3)", marginBottom: 6, textTransform: "uppercase" }}>Notes (optional)</label>
                <textarea className="nm-input" rows={3} value={editSessionForm.notes}
                  onChange={e => setEditSessionForm(p => ({ ...p, notes: e.target.value }))}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 12, color: "var(--text-1)", resize: "vertical" }} />
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button onClick={() => setEditSessionOpen(false)}
                  className="btn-nm" style={{ flex: 1, padding: "11px 0", fontWeight: 600 }}>
                  Cancel
                </button>
                <button onClick={handleEditSession} disabled={editSessionSaving}
                  className="btn-nm-accent" style={{ flex: 2, padding: "11px 0", fontWeight: 700, fontSize: 14 }}>
                  {editSessionSaving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Risk Flag Modal */}
      {riskModalOpen && typeof document !== "undefined" && createPortal(
        <div className="overlay-enter" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 9999 }}>
          <div className="soft-card anim-scale-in" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div className="icon-badge icon-badge--danger" style={{ width: 36, height: 36, borderRadius: "50%" }}>
                  <AlertCircle style={{ width: 18, height: 18 }} />
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: "var(--danger)" }}>Flag High Risk</h3>
              </div>
              <button onClick={() => setRiskModalOpen(false)} className="icon-btn"><X style={{ width: 20, height: 20 }} /></button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-2)", marginBottom: 8, textTransform: "uppercase" }}>Reason for Flagging</label>
                <textarea
                  value={riskReason}
                  onChange={e => setRiskReason(e.target.value)}
                  placeholder="E.g., Expressed suicidal ideation, severe crisis..."
                  rows={4}
                  className="soft-card-2"
                  style={{ width: "100%", padding: "12px 16px", borderRadius: 16, color: "var(--text-1)", outline: "none", fontFamily: "inherit", resize: "none" }}
                />
              </div>

              <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                <button
                  onClick={handleToggleRisk}
                  disabled={riskSaving || !riskReason.trim()}
                  style={{ flex: 1, padding: "14px", borderRadius: 50, border: "none", background: "var(--danger)", color: "#fff", fontWeight: 700, fontSize: 14, cursor: (!riskSaving && riskReason.trim()) ? "pointer" : "not-allowed", opacity: (!riskSaving && riskReason.trim()) ? 1 : 0.6 }}
                >
                  {riskSaving ? "Flagging..." : "Confirm Flag"}
                </button>
              </div>
            </div>
          </div>
        </div>
      , document.body)}

    </div>
  );
}
