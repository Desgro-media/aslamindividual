"use client";

import React, { useEffect, useState, useMemo, Suspense } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Users, Search, Phone, Mail, X, UserCircle2, UserPlus, Stethoscope, CalendarPlus } from "lucide-react";
import api from "../../../lib/api";
import { SpotlightLink } from "../../../components/Spotlight";
import NewBookingWizard from "../../../components/psyfos/NewBookingWizard";
import CaseStatusChip from "../../../components/psyfos/CaseStatusChip";
import { CASE_STATUS_OPTIONS } from "../../../lib/psyfos";

type Patient = {
  // email/phone are genuinely optional on the server (only name is required
  // when adding a patient by hand), so they're typed that way here — the old
  // `string` was a lie the search filter then crashed on.
  id: number; name: string; email?: string | null; phone?: string | null;
  riskFlag?: boolean; riskReason?: string; riskFlaggedAt?: string;
  assignedDoctorId?: number | null;
  caseStatus?: string;
};
type Appointment = {
  id: number; patientId?: number | null; patientName: string; patientEmail: string;
  appointmentDate: string; startTime: string; endTime: string;
  status: string; sessionType?: string; notes?: string; cancellationReason?: string;
  assignedDoctorId?: number | null; assignedDoctorName?: string | null; assignedDoctorJobTitle?: string | null;
};
type StaffDoctor = { id: number; name: string; jobTitle: string | null };

const EMPTY_FORM = { name: "", email: "", phone: "", doctorId: "" };

function PatientsView() {
  const searchParams = useSearchParams();
  const [patients, setPatients]         = useState<Patient[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading]           = useState(true);
  // Seeded once from the header's global quick-search (?q=), then a normal
  // local filter — the URL param is only ever read on first mount.
  const [search, setSearch]             = useState(() => searchParams.get("q") ?? "");

  const [showModal, setShowModal] = useState(false);
  const [form, setForm]           = useState(EMPTY_FORM);
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState("");
  // A clinic staff row (tenantId set) is always clinic context; a tenant
  // root is clinic context only if they signed up as CLINIC — a solo
  // practitioner already knows who "the doctor" is, so the badge would
  // just be noise for them.
  const [isClinicContext, setIsClinicContext] = useState(false);
  // The logged-in user's own id/name — needed to resolve "Myself" in the
  // doctor picker/badge without a round-trip, and because staffDoctors
  // below only ever lists OTHER staff, never the caller's own row.
  const [ownUser, setOwnUser] = useState<StaffDoctor | null>(null);
  // Psyfos: a therapist's list is "My Clients" (their own caseload) with a
  // switch to the whole clinic roster; everyone else sees the full roster as before.
  const [isTherapist, setIsTherapist] = useState(false);
  const [identityReady, setIdentityReady] = useState(false);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [canBook, setCanBook] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  // A receptionist/support login has no calendar of their own: it can never be
  // the "treating doctor" of a client, so it is never offered as "Myself".
  const [isPractitioner, setIsPractitioner] = useState(true);

  useEffect(() => {
    try {
      const user = JSON.parse(localStorage.getItem("user") || "null");
      if (user) {
        setIsClinicContext(!!user.tenantId || user.accountType === "CLINIC");
        setOwnUser({ id: user.id, name: user.name || user.username, jobTitle: user.jobTitle ?? null });
        const practitioner = !user.tenantId || user.role === "ROLE_PSYCHOLOGIST";
        setIsPractitioner(practitioner);
        setIsTherapist(!!user.tenantId && user.role === "ROLE_PSYCHOLOGIST");
        const perms: string[] = Array.isArray(user.permissions) ? user.permissions : [];
        setCanBook(!user.tenantId || user.role === "ROLE_PSYCHOLOGIST" || perms.includes("APPOINTMENTS"));
      }
    } catch { /* default to hidden if we can't tell */ }
    setIdentityReady(true);
  }, []);

  // Roster of bookable psychologists in this clinic, for the doctor picker
  // on the Add Patient modal below. GET /staff only succeeds for a clinic
  // OWNER — it 403s for staff logins and individual practitioners, both of
  // whom don't need a picker anyway, so a rejection here just leaves it
  // empty and hidden, same as every other optional block on this page.
  const [staffDoctors, setStaffDoctors] = useState<StaffDoctor[]>([]);
  useEffect(() => {
    api.get("/appointments/therapists")
      .then(r => setStaffDoctors((r.data ?? []).map((t: any) => ({ id: t.id, name: t.name, jobTitle: t.jobTitle }))))
      .catch(() => {});
  }, []);

  const loadAll = React.useCallback(() => {
    if (!identityReady) return;
    setLoading(true);
    Promise.all([
      api.get(isTherapist && scope === "mine" ? "/me/clients" : "/patients"),
      api.get("/appointments"),
    ]).then(([pRes, aRes]) => {
      setPatients(pRes.data);
      setAppointments(aRes.data);
    }).catch(console.error).finally(() => setLoading(false));
  }, [identityReady, isTherapist, scope]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const filtered = useMemo(() => {
    // Every field here is optional in practice — a patient added from the
    // dashboard only needs a name, and public bookings can arrive without an
    // email. Matching with `?.` rather than assuming a string is what keeps
    // typing in the search box from throwing on the first patient that's
    // missing one (which blanked the whole page, not just that card).
    const q = search.trim().toLowerCase();
    const result = patients.filter(p =>
      (statusFilter === "ALL" || (p.caseStatus ?? "NEW_CASE") === statusFilter) &&
      (!q ||
        p.name?.toLowerCase().includes(q) ||
        p.email?.toLowerCase().includes(q) ||
        p.phone?.toLowerCase().includes(q))
    );
    return result.sort((a, b) => (b.riskFlag ? 1 : 0) - (a.riskFlag ? 1 : 0));
  }, [patients, search, statusFilter]);

  const getPatientStats = (patientId: number) => {
    const apts = appointments.filter(a => a.patientId === patientId);
    return {
      total:     apts.length,
      completed: apts.filter(a => a.status === "COMPLETED").length,
      pending:   apts.filter(a => a.status === "AWAITING_PAYMENT" || a.status === "PAYMENT_UNDER_REVIEW").length,
    };
  };

  // Resolves a doctor id (from Patient.assignedDoctorId or an appointment)
  // into a display label — staffDoctors only ever lists OTHER staff, so the
  // owner's own id has to be checked separately via ownUser.
  const resolveDoctorLabel = (doctorId?: number | null): { name: string; jobTitle: string | null } | null => {
    if (doctorId == null) return null;
    if (ownUser && doctorId === ownUser.id) return ownUser;
    const s = staffDoctors.find(d => d.id === doctorId);
    return s ?? null;
  };

  // The treating doctor for a patient card. Prefers the explicit
  // assignment made at (or after) patient creation; falls back to the most
  // recent non-cancelled appointment's assigned doctor for patients created
  // before that field existed, where the relationship only lives on the
  // appointment.
  const getPatientDoctor = (patient: Patient): { name: string; jobTitle: string | null } | null => {
    const direct = resolveDoctorLabel(patient.assignedDoctorId);
    if (direct) return direct;
    const apts = appointments
      .filter(a => a.patientId === patient.id && a.status !== "CANCELLED" && a.assignedDoctorName)
      .sort((a, b) => (b.appointmentDate + b.startTime).localeCompare(a.appointmentDate + a.startTime));
    const latest = apts[0];
    return latest ? { name: latest.assignedDoctorName!, jobTitle: latest.assignedDoctorJobTitle ?? null } : null;
  };

  const openModal = () => {
    // Defaults to the caller themselves in a clinic — always an explicit,
    // valid choice, never left ambiguous — but stays blank (no picker at
    // all) for a solo practitioner, who has no one else to assign to.
    setForm({ ...EMPTY_FORM, doctorId: ownUser && isPractitioner ? String(ownUser.id) : "" });
    setFormError("");
    setShowModal(true);
  };

  const closeModal = () => { setShowModal(false); setFormError(""); };

  const handleSubmit = async () => {
    setFormError("");
    if (!form.name.trim() || !form.phone.trim()) {
      setFormError("Name and phone number are required."); return;
    }
    setSaving(true);
    try {
      await api.post("/patients", {
        name: form.name, email: form.email, phone: form.phone,
        assignedDoctorId: form.doctorId ? Number(form.doctorId) : undefined,
      });
      loadAll();
      closeModal();
    } catch {
      setFormError("Failed to add patient. Please try again.");
    } finally { setSaving(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }} className="anim-fade-up">

      {/* ── Add Patient Modal ─────────────────────────────────────────────── */}
      {showModal && typeof document !== "undefined" && createPortal(
        <div className="overlay-enter" style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}
          onClick={closeModal}>
          <div className="soft-card anim-scale-in"
            style={{ width: "100%", maxWidth: 440, position: "relative" }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={{ padding: "24px 28px 20px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 4 }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-1)" }}>Add New Patient</h2>
                <button type="button" onClick={closeModal} className="icon-btn" style={{ padding: 4 }}>
                  <X style={{ width: 18, height: 18 }} />
                </button>
              </div>
              <p style={{ fontSize: 12, color: "var(--text-3)" }}>Enter the basic details to create a patient record.</p>
            </div>

            {/* Fields */}
            <div style={{ padding: "0 28px", display: "flex", flexDirection: "column", gap: 14 }}>
              {(["name", "email", "phone"] as const).map(field => (
                <div key={field} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                    {field === "name" ? "Full Name" : field === "email" ? "Email Address (optional)" : "Phone Number"}
                  </label>
                  <input
                    className="nm-input"
                    type={field === "email" ? "email" : "text"}
                    placeholder={field === "name" ? "e.g. Jasna Ahmed" : field === "email" ? "patient@email.com" : "+91 98765 43210"}
                    value={form[field]}
                    onChange={e => setForm(prev => ({ ...prev, [field]: e.target.value }))}
                    style={{ borderRadius: 12 }}
                  />
                </div>
              ))}

              {staffDoctors.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                    Doctor
                  </label>
                  <select
                    className="nm-input"
                    value={form.doctorId}
                    onChange={e => setForm(prev => ({ ...prev, doctorId: e.target.value }))}
                    style={{ borderRadius: 12 }}
                  >
                    {!isPractitioner && <option value="">Not assigned yet</option>}
                    {ownUser && isPractitioner && <option value={ownUser.id}>Myself{ownUser.jobTitle ? ` — ${ownUser.jobTitle}` : ""}</option>}
                    {staffDoctors.filter(d => !(isPractitioner && ownUser && d.id === ownUser.id)).map(d => (
                      <option key={d.id} value={d.id}>{d.name}{d.jobTitle ? ` — ${d.jobTitle}` : ""}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: "20px 28px 24px" }}>
              {formError && (
                <p style={{ fontSize: 12, color: "var(--danger)", fontWeight: 600, marginBottom: 12 }}>{formError}</p>
              )}
              <button type="button" onClick={handleSubmit} disabled={saving} className="btn-nm-accent"
                style={{ width: "100%", padding: "12px 0" }}>
                {saving ? "Adding..." : "Add Patient"}
              </button>
            </div>

          </div>
        </div>
      , document.body)}

      {/* ── Search + Stats ─────────────────────────────────────────────────── */}
      <div className="soft-card anim-fade-up d1" style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <Search style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--text-3)" }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            type="text"
            placeholder="Search patients..."
            className="nm-input"
            style={{ paddingLeft: 40 }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, flexWrap: "wrap" }}>
          {isTherapist && (
            <div style={{ display: "flex", gap: 6 }}>
              {([{ v: "mine" as const, label: "My clients" }, { v: "all" as const, label: "All clinic clients" }]).map(o => (
                <button key={o.v} type="button" onClick={() => setScope(o.v)} className="tab-pill"
                  style={{
                    padding: "8px 14px", borderRadius: 50, fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
                    background: scope === o.v ? "var(--accent)" : "var(--glass)", color: scope === o.v ? "#fff" : "var(--text-2)",
                  }}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <select className="nm-input no-icon" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ width: 215 }} aria-label="Filter by session status">
            <option value="ALL">All session statuses</option>
            {CASE_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div className="soft-card-2" style={{ borderRadius: 50, padding: "8px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <Users style={{ width: 14, height: 14, color: "var(--accent)" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>{filtered.length}</span>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>{isTherapist && scope === "mine" ? "clients" : "patients"}</span>
          </div>
          {canBook && (
            <button onClick={() => setWizardOpen(true)} className="btn-nm"
              style={{ padding: "9px 18px", fontSize: 13, fontWeight: 700 }}>
              <CalendarPlus style={{ width: 14, height: 14, color: "var(--accent)" }} />
              New Booking
            </button>
          )}
          <button onClick={openModal} className="btn-nm-accent"
            style={{ padding: "9px 18px", fontSize: 13 }}>
            <UserPlus style={{ width: 14, height: 14 }} />
            Add Patient
          </button>
        </div>
      </div>

      {/* ── Patient Grid ───────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 20 }}>
          {[...Array(6)].map((_, i) => (
            <div key={i} className="soft-card" style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
                <div className="skel" style={{ width: 52, height: 52, borderRadius: "50%" }} />
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="skel" style={{ height: 14, width: "70%" }} />
                  <div className="skel" style={{ height: 10, width: "50%" }} />
                </div>
              </div>
              <div className="skel" style={{ height: 34, width: "100%", marginBottom: 8, borderRadius: 10 }} />
              <div className="skel" style={{ height: 34, width: "100%", borderRadius: 10 }} />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 20 }}>
          {filtered.length === 0 && (
            <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "60px 0" }}>
              <UserCircle2 style={{ width: 48, height: 48, color: "var(--text-3)", margin: "0 auto 12px" }} />
              <p style={{ color: "var(--text-2)", fontWeight: 600 }}>{isTherapist && scope === "mine" && patients.length === 0 ? "No clients on your caseload yet" : "No patients found"}</p>
              <p style={{ color: "var(--text-3)", fontSize: 13 }}>{isTherapist && scope === "mine" && patients.length === 0 ? "Clients appear here once a session is booked with you." : "Try a different search"}</p>
            </div>
          )}
          {filtered.map((patient, i) => {
            const stats = getPatientStats(patient.id);
            return (
              <SpotlightLink
                href={`/dashboard/patients/${patient.id}`}
                key={patient.id}
                className={`soft-card card-hover anim-fade-up d${Math.min(i + 1, 6)}`}
                style={{ padding: 24, textDecoration: "none", color: "inherit" }}
              >
                {patient.riskFlag && (
                  <div className="stat-chip" style={{ display: "flex", gap: 8, padding: "7px 12px", background: "var(--danger-bg)", border: "1px solid var(--danger-brd)", marginBottom: 14 }}>
                    <span style={{ fontSize: 14 }}>🚨</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--danger)", textTransform: "uppercase", letterSpacing: "0.05em" }}>High Risk Patient</span>
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
                  <div className="team-avatar" style={{
                    width: 52, height: 52, borderRadius: "50%", fontSize: 20,
                    background: patient.riskFlag ? "var(--danger-bg)" : "var(--accent-surface)",
                    color: patient.riskFlag ? "var(--danger)" : "var(--accent)",
                    boxShadow: patient.riskFlag ? "0 0 0 2px var(--danger-brd)" : undefined
                  }}>
                    {patient.name.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{patient.name}</h3>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                      <p style={{ fontSize: 11, color: "var(--text-3)" }}>ID #{patient.id.toString().padStart(4, "0")}</p>
                      <CaseStatusChip status={patient.caseStatus} size="sm" />
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                  <div className="soft-card-2" style={{ borderRadius: 10, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-2)" }}>
                    <Mail style={{ width: 12, height: 12, color: "var(--accent)", flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{patient.email || "—"}</span>
                  </div>
                  <div className="soft-card-2" style={{ borderRadius: 10, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-2)" }}>
                    <Phone style={{ width: 12, height: 12, color: "var(--accent)", flexShrink: 0 }} />
                    <span>{patient.phone || "—"}</span>
                  </div>
                  {isClinicContext && (() => {
                    const doctor = getPatientDoctor(patient);
                    return (
                      <div className="soft-card-2" style={{ borderRadius: 10, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-2)" }}>
                        <Stethoscope style={{ width: 12, height: 12, color: "var(--accent)", flexShrink: 0 }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {doctor
                            ? `${doctor.name}${doctor.jobTitle ? ` · ${doctor.jobTitle}` : ""}`
                            : "No doctor assigned yet"}
                        </span>
                      </div>
                    );
                  })()}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, paddingTop: 14, borderTop: "1px solid var(--card-border)" }}>
                  {[
                    { label: "Total",   value: stats.total,     color: "var(--text-1)" },
                    { label: "Done",    value: stats.completed, color: "var(--accent)" },
                    { label: "Pending", value: stats.pending,   color: "var(--warning)" },
                  ].map(s => (
                    <div key={s.label} className="soft-card-2" style={{ borderRadius: 12, padding: "10px 6px", textAlign: "center" }}>
                      <p style={{ fontSize: 18, fontWeight: 800, color: s.color }}>{s.value}</p>
                      <p style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>{s.label}</p>
                    </div>
                  ))}
                </div>
              </SpotlightLink>
            );
          })}
        </div>
      )}
      {wizardOpen && <NewBookingWizard onClose={() => setWizardOpen(false)} onBooked={() => loadAll()} />}
    </div>
  );
}

export default function PatientsPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "60vh" }} />}>
      <PatientsView />
    </Suspense>
  );
}