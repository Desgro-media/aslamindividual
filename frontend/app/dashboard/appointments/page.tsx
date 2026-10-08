"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef, Suspense } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import {
  Check, X, Search, RefreshCw, Calendar, Clock,
  AlertCircle, Phone, Mail, FileText, Tag,
  CheckCircle2, XCircle, Hourglass, Timer, Eye, PhoneCall, Video, MapPin, CalendarPlus, Stethoscope
} from "lucide-react";
import api from "../../../lib/api";
import MonthFilter, { monthKey, monthLabel } from "../../../components/MonthFilter";
import { SpotlightDiv } from "../../../components/Spotlight";
import NewBookingWizard from "../../../components/psyfos/NewBookingWizard";
import SessionWrapUpModal from "../../../components/psyfos/SessionWrapUpModal";
import CaseStatusChip from "../../../components/psyfos/CaseStatusChip";
import { useServiceNames } from "../../../components/psyfos/SessionBits";

type Appointment = {
  id: number;
  patientId?: number | null;
  patientName: string;
  patientEmail: string;
  patientPhone: string;
  appointmentDate: string;
  startTime: string;
  endTime: string;
  status: string;
  trackingToken: string;
  cancellationReason?: string;
  sessionType?: string;
  mode?: string; // ONLINE or OFFLINE
  notes?: string;
  paymentScreenshotBase64?: string;
  returningPatient?: boolean;
  patientCaseStatus?: "NEW_CASE" | "ONGOING" | "PERIODIC_FOLLOW_UP" | "TERMINATED" | "DROPPED";
  assignedDoctorId?: number;
  assignedDoctorName?: string | null;
};

const STATUS_CFG: Record<string, { label: string; textColor: string; bgColor: string; icon: React.ReactNode }> = {
  DEMO_CALL_PENDING:    { label: "Demo Call",        textColor: "#0369a1", bgColor: "rgba(14,165,233,0.12)", icon: <PhoneCall className="w-3 h-3" /> },
  PENDING:              { label: "Pending",          textColor: "var(--warning)", bgColor: "var(--warning-bg)", icon: <Hourglass className="w-3 h-3" /> },
  AWAITING_PAYMENT:     { label: "Awaiting Payment", textColor: "#c2410c", bgColor: "rgba(249,115,22,0.12)", icon: <Timer className="w-3 h-3" /> },
  PAYMENT_UNDER_REVIEW: { label: "Verifying Payment",textColor: "#0e7490", bgColor: "rgba(6,182,212,0.12)", icon: <Search className="w-3 h-3" /> },
  CONFIRMED:            { label: "Confirmed",        textColor: "var(--success)", bgColor: "var(--success-bg)", icon: <CheckCircle2 className="w-3 h-3" /> },
  COMPLETED:            { label: "Completed",        textColor: "var(--accent)", bgColor: "var(--accent-surface)", icon: <Check className="w-3 h-3" /> },
  CANCELLED:            { label: "Cancelled",        textColor: "var(--danger)", bgColor: "var(--danger-bg)", icon: <XCircle className="w-3 h-3" /> },
};

const FILTER_TABS = ["ALL", "DEMO_CALL_PENDING", "PENDING", "AWAITING_PAYMENT", "PAYMENT_UNDER_REVIEW", "CONFIRMED", "COMPLETED", "CANCELLED"];

function AppointmentsView() {
  const searchParams = useSearchParams();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // Deep-linked from Analytics' "Follow-ups Due" alerts (?patient=<id>) —
  // read once on mount, cleared via the chip below.
  const [patientIdFilter, setPatientIdFilter] = useState<number | null>(() => {
    const raw = searchParams.get("patient");
    return raw ? Number(raw) : null;
  });
  const [activeFilter, setActiveFilter] = useState("ALL");
  const [monthFilter, setMonthFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const [cancelDialog, setCancelDialog] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });
  const [cancelReason, setCancelReason] = useState("");
  const [verifyDialog, setVerifyDialog] = useState<{ open: boolean; id: number | null; screenshotBase64?: string }>({ open: false, id: null });
  const [actionLoading, setActionLoading] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [services, setServices] = useState<any[]>([]);
  const [convertDialog, setConvertDialog] = useState<{ open: boolean; id: number | null; sessionType?: string }>({ open: false, id: null });
  const [convertForm, setConvertForm] = useState({ appointmentDate: "", startTime: "", sessionType: "", mode: "OFFLINE" as "ONLINE" | "OFFLINE" });

  // Psyfos: the front-desk booking flow and the end-of-session wrap-up
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wrapUp, setWrapUp] = useState<Appointment | null>(null);
  const serviceNameFor = useServiceNames();

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (text: string, type: "success" | "error") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, type });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const fetchAppointments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/appointments");
      setAppointments(res.data);
    } catch {
      showToast("Failed to fetch appointments", "error");
    }
    setLoading(false);
  }, []);

  useEffect(() => { 
    fetchAppointments(); 
    // /services needs the Settings permission; a front-desk login without it
    // reads the booking catalogue instead (same names, only what can be booked).
    let canSettings = true;
    try {
      const u = JSON.parse(localStorage.getItem("user") || "null");
      canSettings = !u?.tenantId || (Array.isArray(u?.permissions) && u.permissions.includes("SETTINGS"));
    } catch { /* assume yes */ }
    (canSettings ? api.get("/services") : api.get("/appointments/service-options")
      .then(r => ({ data: (r.data ?? []).map((o: any) => ({ id: o.serviceId, name: o.name })) })))
      .then(res => setServices(res.data))
      .catch(() => {});
  }, [fetchAppointments]);

  const handleConfirm = async () => {
    if (!verifyDialog.id) return;
    setActionLoading(true);
    try {
      await api.patch(`/appointments/${verifyDialog.id}?status=CONFIRMED`);
      showToast("Payment verified and appointment confirmed!", "success");
      setVerifyDialog({ open: false, id: null });
      if (selected?.id === verifyDialog.id) setSelected(null);
      await fetchAppointments();
    } catch { showToast("Failed to confirm", "error"); }
    setActionLoading(false);
  };

  const handleConfirmDirect = async (id: number) => {
    setActionLoading(true);
    try {
      await api.patch(`/appointments/${id}?status=CONFIRMED`);
      showToast("Appointment confirmed!", "success");
      if (selected?.id === id) setSelected(null);
      await fetchAppointments();
    } catch { showToast("Failed to confirm", "error"); }
    setActionLoading(false);
  };

  const openVerifyDialog = (apt: Appointment) => {
    setVerifyDialog({ open: true, id: apt.id, screenshotBase64: apt.paymentScreenshotBase64 });
  };

  const openCancelDialog = (id: number) => {
    setCancelReason("");
    setCancelDialog({ open: true, id });
  };

  const handleCancel = async () => {
    if (!cancelDialog.id) return;
    setActionLoading(true);
    try {
      await api.patch(`/appointments/${cancelDialog.id}?status=CANCELLED&cancellationReason=${encodeURIComponent(cancelReason)}`);
      showToast("Appointment cancelled.", "success");
      setCancelDialog({ open: false, id: null });
      await fetchAppointments();
      if (selected?.id === cancelDialog.id) setSelected(prev => prev ? { ...prev, status: "CANCELLED", cancellationReason: cancelReason } : null);
    } catch { showToast("Failed to cancel", "error"); }
    setActionLoading(false);
  };

  const openConvertDialog = (apt: Appointment) => {
    setConvertForm({ appointmentDate: "", startTime: "", sessionType: apt.sessionType || "", mode: (apt.mode as "ONLINE" | "OFFLINE") || "OFFLINE" });
    setConvertDialog({ open: true, id: apt.id, sessionType: apt.sessionType });
  };

  const handleConvert = async () => {
    if (!convertDialog.id) return;
    if (!convertForm.appointmentDate || !convertForm.startTime) {
      showToast("Please select a date and time.", "error");
      return;
    }
    setActionLoading(true);
    try {
      await api.patch(`/appointments/${convertDialog.id}/convert`, {
        appointmentDate: convertForm.appointmentDate,
        startTime:       convertForm.startTime + ":00",
        sessionType:     convertForm.sessionType || null,
        mode:            convertForm.mode,
      });
      showToast("Demo call converted to appointment!", "success");
      setConvertDialog({ open: false, id: null });
      await fetchAppointments();
      if (selected?.id === convertDialog.id) setSelected(null);
    } catch { showToast("Failed to convert demo call.", "error"); }
    setActionLoading(false);
  };

  // Months (newest first) that actually have appointments, for the month filter
  const availableMonths = useMemo(
    () => Array.from(new Set(
      appointments.filter(a => a.appointmentDate).map(a => monthKey(a.appointmentDate))
    )).sort().reverse(),
    [appointments]
  );

  // Month filter applies first; status tabs, counts and search all read from it.
  // Demo-call requests have no date yet, so they only appear under "All time".
  const monthAppointments = useMemo(
    () => monthFilter
      ? appointments.filter(a => a.appointmentDate && monthKey(a.appointmentDate) === monthFilter)
      : appointments,
    [appointments, monthFilter]
  );

  const filtered = monthAppointments.filter(a => {
    const matchStatus = activeFilter === "ALL"
      || a.status === activeFilter
      || (activeFilter === "PENDING" && a.status === "DEMO_CALL_PENDING");
    const matchSearch = !search ||
      a.patientName.toLowerCase().includes(search.toLowerCase()) ||
      a.patientEmail.toLowerCase().includes(search.toLowerCase());
    const matchPatient = !patientIdFilter || a.patientId === patientIdFilter;
    return matchStatus && matchSearch && matchPatient;
  });

  const counts: Record<string, number> = { ALL: monthAppointments.length };
  FILTER_TABS.slice(1).forEach(s => { counts[s] = monthAppointments.filter(a => a.status === s).length; });
  counts["PENDING"] = monthAppointments.filter(a => a.status === "PENDING" || a.status === "DEMO_CALL_PENDING").length;

  // Per-patient chronological session number (grouped by email — the patient identifier).
  // Cancelled appointments are excluded so the count reflects real sessions.
  const sessionNumbers = useMemo(() => {
    const byPatient: Record<string, Appointment[]> = {};
    appointments.forEach(a => {
      if (a.status === "CANCELLED" || a.status === "DEMO_CALL_PENDING") return;
      if (!a.appointmentDate) return;
      const key = (a.patientPhone || "").trim();
      if (!key) return;
      (byPatient[key] ||= []).push(a);
    });
    const map: Record<number, number> = {};
    Object.values(byPatient).forEach(list => {
      [...list]
        .sort((x, y) =>
          new Date(`${x.appointmentDate}T${x.startTime}`).getTime() -
          new Date(`${y.appointmentDate}T${y.startTime}`).getTime()
        )
        .forEach((a, i) => { map[a.id] = i + 1; });
    });
    return map;
  }, [appointments]);

  const getDuration = (apt: Appointment) => {
    if (apt.status === "DEMO_CALL_PENDING" || !apt.startTime || !apt.endTime) return null;
    const [sh, sm] = apt.startTime.split(":").map(Number);
    const [eh, em] = apt.endTime.split(":").map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
  };

  const getSessionName = (sessionType?: string) => {
    if (!sessionType) return "General";
    const svc = services.find(s => String(s.id) === sessionType);
    if (svc) return svc.name;
    return serviceNameFor(sessionType);
  };

  // Missing/legacy mode defaults to OFFLINE, mirroring the backend's own
  // null-safe default (see AppointmentService.mapToDto).
  const ModeBadge = ({ mode }: { mode?: string }) => {
    const isOnline = mode === "ONLINE";
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700,
        color: isOnline ? "#0369a1" : "var(--text-2)",
      }}>
        {isOnline ? <Video style={{ width: 10, height: 10 }} /> : <MapPin style={{ width: 10, height: 10 }} />}
        {isOnline ? "Online" : "In-person"}
      </span>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }} className="anim-fade-up">

      {/* Toast */}
      {toast && typeof document !== "undefined" && createPortal(
        <div className="soft-card anim-fade-in" style={{
          position: "fixed", top: 24, right: 24, zIndex: 100,
          display: "flex", alignItems: "center", gap: 10,
          padding: "12px 20px", borderRadius: 16, fontSize: 13, fontWeight: 600,
          color: toast.type === "success" ? "var(--success)" : "var(--danger)",
          minWidth: 240
        }}>
          {toast.type === "success"
            ? <CheckCircle2 style={{ width: 16, height: 16 }} />
            : <AlertCircle style={{ width: 16, height: 16 }} />}
          {toast.text}
        </div>,
        document.body
      )}

      {/* Filter Tabs + Search */}
      <div className="soft-card anim-fade-up d1" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {FILTER_TABS.map(tab => {
            const isActive = activeFilter === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveFilter(tab)}
                className={`tab-pill${isActive ? " active" : ""}`}
                style={{
                  padding: "8px 14px", borderRadius: 50, fontSize: 12, fontWeight: 600,
                  border: "none", cursor: "pointer",
                  background: isActive ? "var(--accent)" : "var(--glass)",
                  color: isActive ? "#fff" : "var(--text-2)",
                  boxShadow: isActive
                    ? "0 4px 14px rgba(79,110,247,0.38), inset 0 1px 0 rgba(255,255,255,0.20)"
                    : "0 2px 8px var(--glass-shadow), inset 0 1px 0 var(--specular)",
                }}
              >
                {tab === "ALL" ? "All" : STATUS_CFG[tab]?.label}
                {counts[tab] > 0 && (
                  <span style={{
                    marginLeft: 6, padding: "1px 6px", borderRadius: 50, fontSize: 10,
                    background: isActive ? "rgba(255,255,255,0.25)" : "var(--sd)",
                    color: isActive ? "#fff" : "var(--text-2)"
                  }}>{counts[tab]}</span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
            <Search style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--text-3)" }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              type="text"
              placeholder="Search by name or email..."
              className="nm-input"
              style={{ paddingLeft: 40 }}
            />
          </div>
          {patientIdFilter && (
            <button
              onClick={() => setPatientIdFilter(null)}
              className="btn-nm"
              style={{ padding: "8px 14px", borderRadius: 50, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, color: "var(--accent)" }}
            >
              Filtered to one patient <X style={{ width: 12, height: 12 }} />
            </button>
          )}
          <MonthFilter months={availableMonths} value={monthFilter} onChange={setMonthFilter} />
          <button
            onClick={() => setWizardOpen(true)}
            className="btn-nm-accent"
            style={{ padding: "10px 18px", borderRadius: 14, flexShrink: 0, gap: 8, fontWeight: 700 }}
          >
            <CalendarPlus style={{ width: 14, height: 14 }} />
            New Booking
          </button>
          <button
            onClick={fetchAppointments}
            className="btn-nm"
            style={{ padding: "10px 18px", borderRadius: 14, flexShrink: 0 }}
          >
            <RefreshCw style={{ width: 14, height: 14, animation: loading ? "spinSlow 1s linear infinite" : "none" }} />
            Refresh
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="soft-card anim-fade-up d2" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ width: "100%", textAlign: "left", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(180,185,210,0.2)" }}>
                {["Patient", "Session", "Date & Time", "Duration", "Status", "Actions"].map((h, i) => (
                  <th key={h} style={{
                    padding: "14px 20px",
                    fontSize: 10, fontWeight: 700, color: "var(--text-3)",
                    textTransform: "uppercase", letterSpacing: "0.08em",
                    textAlign: i === 5 ? "right" : "left",
                    whiteSpace: "nowrap"
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && [0, 1, 2, 3, 4].map(i => (
                <tr key={i} style={{ borderBottom: "1px solid var(--glass-border-dim)" }}>
                  <td style={{ padding: "14px 20px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div className="skel" style={{ width: 36, height: 36, borderRadius: "50%" }} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div className="skel" style={{ width: 130, height: 12 }} />
                        <div className="skel" style={{ width: 90, height: 9 }} />
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: "14px 20px" }}><div className="skel" style={{ width: 80, height: 22, borderRadius: 8 }} /></td>
                  <td style={{ padding: "14px 20px" }}><div className="skel" style={{ width: 90, height: 12 }} /></td>
                  <td style={{ padding: "14px 20px" }}><div className="skel" style={{ width: 50, height: 12 }} /></td>
                  <td style={{ padding: "14px 20px" }}><div className="skel" style={{ width: 88, height: 22, borderRadius: 50 }} /></td>
                  <td style={{ padding: "14px 20px" }} />
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: "48px 24px", textAlign: "center" }}>
                    <Calendar style={{ width: 32, height: 32, color: "var(--text-3)", margin: "0 auto 10px" }} />
                    <p style={{ color: "var(--text-3)" }}>No appointments found.</p>
                  </td>
                </tr>
              )}
              {filtered.map((apt) => {
                const cfg = STATUS_CFG[apt.status] || STATUS_CFG.PENDING;
                const duration = getDuration(apt);
                const isRowSelected = selected?.id === apt.id;
                return (
                  <tr
                    key={apt.id}
                    onClick={() => setSelected(apt)}
                    className="list-row"
                    style={{
                      cursor: "pointer",
                      borderBottom: "1px solid var(--glass-border-dim)",
                      // undefined (not "transparent") when unselected, or the
                      // inline style would override the .list-row hover wash
                      background: isRowSelected ? "var(--accent-surface)" : undefined,
                    }}
                  >
                    <td style={{ padding: "14px 20px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div className="team-avatar" style={{ width: 36, height: 36, borderRadius: "50%", fontSize: 14 }}>
                          {apt.patientName.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <p style={{ fontWeight: 600, color: "var(--text-1)" }}>{apt.patientName}</p>
                            {sessionNumbers[apt.id] && (
                              <span style={{
                                fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 6,
                                background: "var(--sd)", color: "var(--text-2)", whiteSpace: "nowrap"
                              }}>
                                Session {sessionNumbers[apt.id]}
                              </span>
                            )}
                            {apt.returningPatient && (
                              <span style={{
                                fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 6,
                                background: "var(--accent-surface)", color: "var(--accent)",
                                display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap"
                              }}>
                                <RefreshCw style={{ width: 9, height: 9 }} /> Returning
                              </span>
                            )}
                            {apt.status !== "DEMO_CALL_PENDING" && apt.patientCaseStatus && (
                              <CaseStatusChip status={apt.patientCaseStatus} size="sm" />
                            )}
                          </div>
                          <p style={{ fontSize: 11, color: "var(--text-3)" }}>{apt.patientEmail}</p>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                        <div className="nm-inset-sm" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, fontSize: 11, color: "var(--text-2)" }}>
                          <Tag style={{ width: 11, height: 11, color: "var(--accent)" }} />
                          {getSessionName(apt.sessionType)}
                        </div>
                        {apt.status !== "DEMO_CALL_PENDING" && <ModeBadge mode={apt.mode} />}
                        {apt.status !== "DEMO_CALL_PENDING" && apt.assignedDoctorName && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--text-3)" }}>
                            <Stethoscope style={{ width: 10, height: 10 }} /> {apt.assignedDoctorName}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      {apt.status !== "DEMO_CALL_PENDING" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-1)", whiteSpace: "nowrap" }}>
                            <Calendar style={{ width: 12, height: 12, color: "var(--accent)" }} /> {apt.appointmentDate}
                          </span>
                          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-3)", whiteSpace: "nowrap" }}>
                            <Clock style={{ width: 12, height: 12 }} /> {apt.startTime}
                          </span>
                        </div>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--text-3)" }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      {duration != null ? (
                        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
                          <Timer style={{ width: 12, height: 12, color: "var(--text-3)" }} />
                          {duration} min
                        </span>
                      ) : <span style={{ color: "var(--text-3)" }}>—</span>}
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <div className="nm-inset-sm" style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        padding: "5px 10px", borderRadius: 50,
                        fontSize: 10, fontWeight: 700,
                        color: cfg.textColor,
                        textTransform: "uppercase", letterSpacing: "0.04em"
                      }}>
                        {cfg.icon} {cfg.label}
                      </div>
                    </td>
                    <td style={{ padding: "14px 20px", textAlign: "right" }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
                        <button
                          onClick={() => setSelected(apt)}
                          className="btn-nm"
                          style={{ width: 34, height: 34, borderRadius: "50%", padding: 0 }}
                          title="View Details"
                        >
                          <Eye style={{ width: 14, height: 14 }} />
                        </button>
                        {apt.status === "DEMO_CALL_PENDING" && (
                          <>
                            <button
                              onClick={() => openConvertDialog(apt)}
                              disabled={actionLoading}
                              className="btn-nm"
                              style={{ padding: "6px 12px", borderRadius: 10, fontSize: 11, fontWeight: 600, color: "#0369a1", background: "rgba(14,165,233,0.10)" }}
                              title="Convert to Appointment"
                            >
                              Convert
                            </button>
                            <button
                              onClick={() => openCancelDialog(apt.id)}
                              disabled={actionLoading}
                              style={{ width: 34, height: 34, borderRadius: "50%", border: "none", cursor: "pointer", background: "var(--danger-bg)", color: "var(--danger)", display: "flex", alignItems: "center", justifyContent: "center" }}
                              title="Cancel"
                            >
                              <X style={{ width: 14, height: 14 }} />
                            </button>
                          </>
                        )}
                        {(apt.status === "AWAITING_PAYMENT" || apt.status === "PENDING") && (
                          <>
                            <button
                              onClick={() => handleConfirmDirect(apt.id)}
                              disabled={actionLoading}
                              className="btn-nm"
                              style={{ padding: "6px 12px", borderRadius: 10, fontSize: 11, fontWeight: 600, color: "var(--success)", background: "var(--success-bg)" }}
                              title="Confirm (cash / in-person payment)"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => openCancelDialog(apt.id)}
                              disabled={actionLoading}
                              style={{ width: 34, height: 34, borderRadius: "50%", border: "none", cursor: "pointer", background: "var(--danger-bg)", color: "var(--danger)", display: "flex", alignItems: "center", justifyContent: "center" }}
                              title="Cancel"
                            >
                              <X style={{ width: 14, height: 14 }} />
                            </button>
                          </>
                        )}
                        {apt.status === "PAYMENT_UNDER_REVIEW" && (
                          <>
                            <button
                              onClick={() => openVerifyDialog(apt)}
                              disabled={actionLoading}
                              className="btn-nm"
                              style={{ padding: "6px 12px", borderRadius: 10, fontSize: 11, fontWeight: 600, color: "var(--success)", background: "var(--success-bg)" }}
                              title="Verify Payment & Confirm"
                            >
                              Verify
                            </button>
                            <button
                              onClick={() => openCancelDialog(apt.id)}
                              disabled={actionLoading}
                              style={{ width: 34, height: 34, borderRadius: "50%", border: "none", cursor: "pointer", background: "var(--danger-bg)", color: "var(--danger)", display: "flex", alignItems: "center", justifyContent: "center" }}
                              title="Cancel"
                            >
                              <X style={{ width: 14, height: 14 }} />
                            </button>
                          </>
                        )}
                        {apt.status === "CONFIRMED" && (
                          <>
                            <button
                              onClick={() => setWrapUp(apt)}
                              disabled={actionLoading}
                              className="btn-nm"
                              style={{ padding: "6px 12px", borderRadius: 10, fontSize: 11, fontWeight: 600, color: "var(--accent)" }}
                              title="Complete the session: notes, session status, next follow-up"
                            >
                              Complete
                            </button>
                            <button
                              onClick={() => openCancelDialog(apt.id)}
                              disabled={actionLoading}
                              style={{ width: 34, height: 34, borderRadius: "50%", border: "none", cursor: "pointer", background: "var(--danger-bg)", color: "var(--danger)", display: "flex", alignItems: "center", justifyContent: "center" }}
                              title="Cancel"
                            >
                              <X style={{ width: 14, height: 14 }} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loading && (
          <div style={{ padding: "10px 20px", borderTop: "1px solid rgba(180,185,210,0.2)", fontSize: 11, color: "var(--text-3)" }}>
            Showing {filtered.length} of {monthAppointments.length} appointments{monthFilter ? ` in ${monthLabel(monthFilter)}` : ""}
          </div>
        )}
      </div>

      {/* Detail Side Panel */}
      {selected && typeof document !== "undefined" && createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 40, display: "flex", justifyContent: "flex-end" }} onClick={() => setSelected(null)}>
          <div className="overlay-enter" style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.2)", backdropFilter: "blur(2px)" }} />
          <div
            className="anim-slide-r"
            style={{
              position: "relative", width: "100%", maxWidth: 420,
              background: "var(--bg)", height: "100%",
              overflow: "hidden", display: "flex", flexDirection: "column",
              boxShadow: "-8px 0 32px rgba(0,0,0,0.08)"
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Panel Header */}
            <div style={{ padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, borderBottom: "1px solid var(--card-border)" }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-1)" }}>Appointment Details</h3>
                <p style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>#{selected.id.toString().padStart(5, "0")}</p>
              </div>
              <button onClick={() => setSelected(null)} className="icon-btn" style={{ width: 36, height: 36, borderRadius: "50%" }}>
                <X style={{ width: 15, height: 15 }} />
              </button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>

              {/* Patient Info */}
              <div className="soft-card" style={{ padding: 20 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>Patient</p>
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
                  <div className="team-avatar" style={{ width: 52, height: 52, borderRadius: "50%", fontSize: 20 }}>
                    {selected.patientName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <p style={{ fontWeight: 700, fontSize: 16, color: "var(--text-1)" }}>{selected.patientName}</p>
                      {selected.returningPatient && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 6,
                          background: "var(--accent-surface)", color: "var(--accent)",
                          display: "inline-flex", alignItems: "center", gap: 4
                        }}>
                          <RefreshCw style={{ width: 9, height: 9 }} /> Returning
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                      <div className="soft-card-2" style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        padding: "4px 10px", borderRadius: 50,
                        fontSize: 10, fontWeight: 700,
                        color: STATUS_CFG[selected.status]?.textColor,
                        textTransform: "uppercase", letterSpacing: "0.04em"
                      }}>
                        {STATUS_CFG[selected.status]?.icon} {STATUS_CFG[selected.status]?.label}
                      </div>
                      {sessionNumbers[selected.id] && (
                        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)" }}>
                          Session {sessionNumbers[selected.id]}
                        </span>
                      )}
                      {selected.status !== "DEMO_CALL_PENDING" && selected.patientCaseStatus && (
                        <CaseStatusChip status={selected.patientCaseStatus} size="sm" />
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div className="soft-card-2" style={{ borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)" }}>
                    <Mail style={{ width: 14, height: 14, color: "var(--accent)", flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.patientEmail}</span>
                  </div>
                  <div className="soft-card-2" style={{ borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)" }}>
                    <Phone style={{ width: 14, height: 14, color: "var(--accent)", flexShrink: 0 }} />
                    <span>{selected.patientPhone || "—"}</span>
                  </div>
                </div>
              </div>

              {/* Session Details */}
              <div className="soft-card" style={{ padding: 20 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
                  {selected.status === "DEMO_CALL_PENDING" ? "Demo Call Details" : "Session Details"}
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {[
                    { icon: <Calendar style={{ width: 13, height: 13, color: "var(--accent)" }} />, label: "Date",     value: selected.status === "DEMO_CALL_PENDING" ? "—" : (selected.appointmentDate || "—") },
                    { icon: <Clock    style={{ width: 13, height: 13, color: "var(--accent)" }} />, label: "Time",     value: selected.status === "DEMO_CALL_PENDING" ? "—" : (selected.startTime || "—") },
                    { icon: <Timer    style={{ width: 13, height: 13, color: "var(--accent)" }} />, label: "End Time", value: selected.status === "DEMO_CALL_PENDING" ? "—" : (selected.endTime || "—") },
                    { icon: <Tag      style={{ width: 13, height: 13, color: "var(--accent)" }} />, label: "Session",  value: getSessionName(selected.sessionType) },
                    ...(selected.status !== "DEMO_CALL_PENDING" ? [{
                      icon: selected.mode === "ONLINE"
                        ? <Video style={{ width: 13, height: 13, color: "var(--accent)" }} />
                        : <MapPin style={{ width: 13, height: 13, color: "var(--accent)" }} />,
                      label: "Mode", value: selected.mode === "ONLINE" ? "Online" : "In-person",
                    }] : []),
                  ].map(item => (
                    <div key={item.label} className="soft-card-2" style={{ borderRadius: 12, padding: "12px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-3)", marginBottom: 6 }}>
                        {item.icon} {item.label}
                      </div>
                      <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Notes */}
              {selected.notes && (
                <div className="soft-card" style={{ padding: 20 }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                    <FileText style={{ width: 12, height: 12 }} /> Notes
                  </p>
                  <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6 }}>{selected.notes}</p>
                </div>
              )}

              {/* Cancellation Reason */}
              {selected.status === "CANCELLED" && selected.cancellationReason && (
                <div className="soft-card-2" style={{ borderRadius: 16, padding: 16, borderLeft: "3px solid var(--danger)" }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "var(--danger)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Cancellation Reason</p>
                  <p style={{ fontSize: 13, color: "var(--text-2)" }}>{selected.cancellationReason}</p>
                </div>
              )}

              {/* Token */}
              <div className="soft-card-2" style={{ borderRadius: 14, padding: "10px 14px" }}>
                <p style={{ fontSize: 10, color: "var(--text-3)", marginBottom: 4 }}>Tracking Token</p>
                <p style={{ fontSize: 11, fontFamily: "monospace", color: "var(--accent)", wordBreak: "break-all" }}>{selected.trackingToken}</p>
              </div>

              {/* Payment Screenshot */}
              {selected.paymentScreenshotBase64 && (
                <div className="soft-card" style={{ padding: 20 }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                    <Search style={{ width: 12, height: 12 }} /> Payment Screenshot
                  </p>
                  <div style={{ width: "100%", borderRadius: 12, overflow: "hidden", border: "1px solid var(--card-border)" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={selected.paymentScreenshotBase64} alt="Payment Screenshot" style={{ width: "100%", height: "auto", display: "block" }} />
                  </div>
                </div>
              )}
            </div>

            {/* Panel Actions */}
            {(selected.status === "DEMO_CALL_PENDING" || selected.status === "AWAITING_PAYMENT" || selected.status === "PENDING" || selected.status === "PAYMENT_UNDER_REVIEW" || selected.status === "CONFIRMED") && (
              <div style={{ padding: "16px 24px", display: "flex", gap: 12, flexShrink: 0, borderTop: "1px solid var(--card-border)" }}>
                {selected.status === "DEMO_CALL_PENDING" && (
                  <button
                    disabled={actionLoading}
                    onClick={() => openConvertDialog(selected)}
                    className="btn-nm-accent"
                    style={{ flex: 1 }}
                  >
                    <PhoneCall style={{ width: 14, height: 14 }} /> Convert to Appointment
                  </button>
                )}
                {(selected.status === "AWAITING_PAYMENT" || selected.status === "PENDING") && (
                  <button
                    disabled={actionLoading}
                    onClick={() => handleConfirmDirect(selected.id)}
                    className="btn-nm-accent"
                    style={{ flex: 1, background: "var(--success)" }}
                  >
                    <CheckCircle2 style={{ width: 14, height: 14 }} /> Confirm
                  </button>
                )}
                {selected.status === "PAYMENT_UNDER_REVIEW" && (
                  <button
                    disabled={actionLoading}
                    onClick={() => openVerifyDialog(selected)}
                    className="btn-nm-accent"
                    style={{ flex: 1, background: "var(--success)" }}
                  >
                    <CheckCircle2 style={{ width: 14, height: 14 }} /> Verify & Confirm
                  </button>
                )}
                {selected.status === "CONFIRMED" && (
                  <button
                    disabled={actionLoading}
                    onClick={() => setWrapUp(selected)}
                    className="btn-nm-accent"
                    style={{ flex: 1 }}
                  >
                    <CheckCircle2 style={{ width: 14, height: 14 }} /> Mark Complete
                  </button>
                )}
                <button
                  disabled={actionLoading}
                  onClick={() => openCancelDialog(selected.id)}
                  className="btn-nm"
                  style={{ padding: "12px 20px", color: "var(--danger)" }}
                >
                  <X style={{ width: 14, height: 14 }} /> Cancel
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* Cancel Dialog */}
      {cancelDialog.open && typeof document !== "undefined" && createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={() => setCancelDialog({ open: false, id: null })}>
          <div className="overlay-enter" style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)", backdropFilter: "blur(2px)" }} />
          <div className="soft-card anim-scale-in" style={{ position: "relative", width: "100%", maxWidth: 420, padding: "28px 24px" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
              <div className="icon-badge icon-badge--danger" style={{ width: 44, height: 44, borderRadius: "50%" }}>
                <AlertCircle style={{ width: 22, height: 22 }} />
              </div>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-1)" }}>Cancel Appointment</h3>
                <p style={{ fontSize: 12, color: "var(--text-3)" }}>Patient will be notified via email/SMS</p>
              </div>
            </div>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 8 }}>
              Reason (optional)
            </label>
            <textarea
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              rows={3}
              placeholder="Enter reason for cancellation..."
              className="nm-textarea"
              style={{ marginBottom: 20 }}
            />
            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={() => setCancelDialog({ open: false, id: null })} className="btn-nm" style={{ flex: 1 }}>
                Keep Appointment
              </button>
              <button
                disabled={actionLoading}
                onClick={handleCancel}
                style={{ flex: 1, padding: "12px 20px", borderRadius: 50, background: "var(--danger)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              >
                {actionLoading ? "Cancelling…" : "Confirm Cancel"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Convert Demo Dialog */}
      {convertDialog.open && typeof document !== "undefined" && createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={() => setConvertDialog({ open: false, id: null })}>
          <div className="overlay-enter" style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)", backdropFilter: "blur(2px)" }} />
          <div className="soft-card anim-scale-in" style={{ position: "relative", width: "100%", maxWidth: 440, padding: "28px 24px" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
              <div className="icon-badge icon-badge--accent" style={{ width: 44, height: 44, borderRadius: "50%" }}>
                <PhoneCall style={{ width: 22, height: 22 }} />
              </div>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-1)" }}>Convert to Appointment</h3>
                <p style={{ fontSize: 12, color: "var(--text-3)" }}>Set date, time and session type for this client</p>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 8 }}>Date *</label>
                <input
                  type="date"
                  className="nm-input"
                  value={convertForm.appointmentDate}
                  min={new Date().toISOString().split("T")[0]}
                  onChange={e => setConvertForm(f => ({ ...f, appointmentDate: e.target.value }))}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 8 }}>Time *</label>
                <input
                  type="time"
                  className="nm-input"
                  value={convertForm.startTime}
                  onChange={e => setConvertForm(f => ({ ...f, startTime: e.target.value }))}
                />
              </div>
              {services.length > 0 && (
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 8 }}>Session Type</label>
                  <select
                    className="nm-input"
                    value={convertForm.sessionType}
                    onChange={e => setConvertForm(f => ({ ...f, sessionType: e.target.value }))}
                  >
                    <option value="">— Keep existing —</option>
                    {services.map((s: any) => (
                      <option key={s.id} value={String(s.id)}>{s.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 8 }}>Mode</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {([
                    { v: "OFFLINE" as const, label: "In-person", Icon: MapPin },
                    { v: "ONLINE" as const, label: "Online", Icon: Video },
                  ]).map(({ v, label, Icon }) => (
                    <button key={v} type="button" onClick={() => setConvertForm(f => ({ ...f, mode: v }))}
                      className="btn-nm"
                      style={{
                        flex: 1, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                        background: convertForm.mode === v ? "var(--accent)" : undefined,
                        color: convertForm.mode === v ? "#fff" : undefined,
                      }}>
                      <Icon style={{ width: 13, height: 13 }} /> {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
              <button onClick={() => setConvertDialog({ open: false, id: null })} className="btn-nm" style={{ flex: 1 }}>
                Cancel
              </button>
              <button
                disabled={actionLoading || !convertForm.appointmentDate || !convertForm.startTime}
                onClick={handleConvert}
                style={{ flex: 1, padding: "12px 20px", borderRadius: 50, background: "#0369a1", color: "#fff", border: "none", cursor: actionLoading ? "not-allowed" : "pointer", fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: (!convertForm.appointmentDate || !convertForm.startTime) ? 0.5 : 1 }}
              >
                {actionLoading ? "Converting…" : "Confirm & Convert"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {wizardOpen && (
        <NewBookingWizard onClose={() => setWizardOpen(false)} onBooked={() => fetchAppointments()} />
      )}

      {wrapUp && (
        <SessionWrapUpModal
          appointment={{
            id: wrapUp.id, patientId: wrapUp.patientId ?? 0, patientName: wrapUp.patientName,
            assignedDoctorId: wrapUp.assignedDoctorId ?? 0, appointmentDate: wrapUp.appointmentDate,
            startTime: wrapUp.startTime, endTime: wrapUp.endTime, mode: wrapUp.mode, patientCaseStatus: wrapUp.patientCaseStatus,
          }}
          onClose={() => setWrapUp(null)}
          onDone={(res) => {
            setWrapUp(null);
            setSelected(null);
            const bits = ["Session completed"];
            if (res?.caseStatusChanged) bits.push("status updated");
            if (res?.followUp) bits.push(res.followUp.status === "BOOKED" ? "follow-up booked" : "follow-up set");
            showToast(bits.join(" · "), "success");
            fetchAppointments();
          }}
        />
      )}

      {/* Verify Dialog */}
      {verifyDialog.open && typeof document !== "undefined" && createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={() => setVerifyDialog({ open: false, id: null })}>
          <div className="overlay-enter" style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)", backdropFilter: "blur(2px)" }} />
          <div className="soft-card anim-scale-in" style={{ position: "relative", width: "100%", maxWidth: 500, padding: "28px 24px" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
              <div className="icon-badge" style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--accent-surface)", color: "var(--accent)" }}>
                <Search style={{ width: 22, height: 22 }} />
              </div>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-1)" }}>Verify Payment</h3>
                <p style={{ fontSize: 12, color: "var(--text-3)" }}>Please check the patient's payment screenshot</p>
              </div>
            </div>

            {verifyDialog.screenshotBase64 ? (
              <div style={{ width: "100%", borderRadius: 16, overflow: "hidden", marginBottom: 24, border: "1px solid var(--card-border)" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={verifyDialog.screenshotBase64} alt="Payment Screenshot" style={{ width: "100%", height: "auto", maxHeight: 400, objectFit: "contain", display: "block" }} />
              </div>
            ) : (
              <div className="soft-card-2" style={{ padding: 24, borderRadius: 16, textAlign: "center", marginBottom: 24 }}>
                <p style={{ fontSize: 13, color: "var(--text-3)" }}>No payment screenshot uploaded.</p>
              </div>
            )}

            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={() => setVerifyDialog({ open: false, id: null })} className="btn-nm" style={{ flex: 1 }}>
                Cancel
              </button>
              <button
                disabled={actionLoading}
                onClick={handleConfirm}
                style={{ flex: 1, padding: "12px 20px", borderRadius: 50, background: "#15803d", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              >
                {actionLoading ? "Confirming…" : "Confirm Payment & Approve"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default function AppointmentsPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "60vh" }} />}>
      <AppointmentsView />
    </Suspense>
  );
}
