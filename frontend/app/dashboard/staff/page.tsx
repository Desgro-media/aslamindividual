"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Plus, Pencil, X, Loader2, Check, UserCog,
  ShieldCheck, ShieldOff, RefreshCw, Brain, UserCheck,
  User, Lock, Mail, AlertCircle, CheckCircle2, LogIn, LogOut,
  CalendarClock, DollarSign, AlertTriangle, Camera, KeyRound, Trash2,
} from "lucide-react";
import { SpotlightDiv } from "../../../components/Spotlight";
import {
  getAllStaff, createStaff, updateStaff, updatePermissions, updateStaffCredentials,
  deactivateStaff, deleteStaff, reactivateStaff, getAllAttendance, getActiveStaff,
  StaffMember, AttendanceRecord, CreateStaffPayload,
} from "../../../lib/staffApi";
import { getMyServices } from "../../../lib/profileApi";
import { readImageAsCompressedBase64 } from "../../../lib/imageUtils";
import AvailabilityEditor from "../../../components/AvailabilityEditor";
import StaffServicesEditor from "../../../components/StaffServicesEditor";

const ALL_PERMISSIONS = [
  { key: "APPOINTMENTS", label: "Appointments" },
  { key: "PATIENTS",     label: "Patients" },
  { key: "BILLING",      label: "Billing" },
  { key: "ANALYTICS",    label: "Analytics" },
  { key: "SETTINGS",     label: "Settings & Services" },
];

const ROLES = [
  { value: "ROLE_STAFF",        label: "Staff" },
  { value: "ROLE_RECEPTIONIST", label: "Receptionist" },
  { value: "ROLE_PSYCHOLOGIST", label: "Psychologist" },
];

// Common titles offered as a quick pick, keyed by role — the underlying
// field stays free text (see the input next to the dropdown below), so
// these are a starting point, not a closed list.
const JOB_TITLE_PRESETS: Record<string, string[]> = {
  ROLE_PSYCHOLOGIST: [
    "Senior Psychologist", "Primary Psychologist", "Consultant Psychologist",
    "Clinical Psychologist", "Associate Psychologist", "Counselling Psychologist",
  ],
  ROLE_RECEPTIONIST: ["Front Desk Executive", "Receptionist", "Office Coordinator"],
  ROLE_STAFF: ["Office Manager", "Billing Coordinator", "Administrative Staff"],
};

function roleBadge(role: string) {
  const map: Record<string, { label: string; cls: string }> = {
    ROLE_PSYCHOLOGIST: { label: "Psychologist", cls: "bg-purple-50 text-purple-700 border-purple-200" },
    ROLE_RECEPTIONIST: { label: "Receptionist", cls: "bg-blue-50 text-blue-700 border-blue-200" },
    ROLE_STAFF:         { label: "Staff",        cls: "bg-gray-100 text-gray-600 border-gray-200" },
  };
  const { label, cls } = map[role] ?? { label: role, cls: "bg-gray-100 text-gray-600 border-gray-200" };
  return <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>;
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes === 0) return "< 1m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

const emptyForm = (): CreateStaffPayload => ({
  name: "", username: "", password: "", jobTitle: "",
  role: "ROLE_STAFF", permissions: [], bio: "", bookable: false,
  profileImageUrl: "",
});

// Avatar that doubles as a photo picker when `onChange` is passed. The photo
// is a compressed base64 data URL held on the staff row itself
// (AppUser.profileImageUrl) — same convention as the owner's own photo in
// settings/page.tsx. Falls back to the member's initial, then to a generic
// icon while a new staff member is still unnamed.
function StaffAvatar({ name, photo, size = 42, onChange, onError }: {
  name: string;
  photo: string;
  size?: number;
  onChange?: (dataUrl: string) => void;
  onError?: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const editable = !!onChange;
  const initial = name.trim().charAt(0).toUpperCase();

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets the same file be re-picked after a failure
    if (!file) return;
    try {
      onChange?.(await readImageAsCompressedBase64(file));
    } catch (err: any) {
      onError?.(err?.message || "Failed to process image.");
    }
  };

  const badge = (extra: React.CSSProperties): React.CSSProperties => ({
    position: "absolute", width: 20, height: 20, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    border: "2px solid var(--card)", cursor: "pointer", padding: 0, ...extra,
  });

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <div className="team-avatar"
        onClick={editable ? () => inputRef.current?.click() : undefined}
        title={editable ? (photo ? "Change photo" : "Upload photo") : undefined}
        style={{
          width: size, height: size, borderRadius: "50%",
          fontSize: Math.round(size * 0.38), cursor: editable ? "pointer" : undefined,
        }}>
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt={name || "Staff photo"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : initial ? initial : <User style={{ width: size * 0.4, height: size * 0.4 }} />}
      </div>
      {editable && (
        <>
          <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handlePick} />
          <button type="button" onClick={() => inputRef.current?.click()}
            title={photo ? "Change photo" : "Upload photo"}
            style={badge({ bottom: -2, right: -2, background: "var(--accent)" })}>
            <Camera style={{ width: 10, height: 10, color: "#fff" }} />
          </button>
          {photo && (
            <button type="button" onClick={() => onChange?.("")} title="Remove photo"
              style={badge({ top: -2, right: -2, background: "var(--danger)" })}>
              <X style={{ width: 10, height: 10, color: "#fff" }} strokeWidth={3} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function StaffPage() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; isError: boolean } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [savingPermsFor, setSavingPermsFor] = useState<number | null>(null);
  const [scheduleModalFor, setScheduleModalFor] = useState<StaffMember | null>(null);
  // Staff have no self-service password reset (their logins belong to this
  // clinic), so this modal is the only place their email/password ever
  // changes. There is no self-service reset anywhere in the product.
  const [credentialsFor, setCredentialsFor] = useState<StaffMember | null>(null);
  const [scheduleTab, setScheduleTab] = useState<"services" | "availability">("services");
  // Whether each enabled psychologist has at least one priced/offered
  // service — a clinic staff doctor starts with zero (unlike solo
  // practitioners, who auto-offer the catalog), so this surfaces the
  // "invisible on the booking page" trap instead of letting it happen silently.
  const [servicesConfigured, setServicesConfigured] = useState<Record<number, boolean>>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (text: string, isError = false) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, isError });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const fetchStaff = useCallback(async () => {
    setLoading(true);
    try {
      setStaff(await getAllStaff());
    } catch {
      flash("Failed to load staff.", true);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshServicesConfigured = useCallback(async (members: StaffMember[]) => {
    const doctors = members.filter(m => m.role === "ROLE_PSYCHOLOGIST" && m.enabled);
    if (doctors.length === 0) return;
    const entries = await Promise.all(doctors.map(async d => {
      try {
        const services = await getMyServices(d.id);
        return [d.id, services.some(s => s.onlineOffered || s.offlineOffered)] as const;
      } catch {
        return [d.id, true] as const; // fail open — don't warn off a fetch error
      }
    }));
    setServicesConfigured(prev => ({ ...prev, ...Object.fromEntries(entries) }));
  }, []);

  useEffect(() => { refreshServicesConfigured(staff); }, [staff, refreshServicesConfigured]);

  useEffect(() => { fetchStaff(); }, [fetchStaff]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormError("");
    setShowModal(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.username.trim() || !form.password.trim()) {
      setFormError("Name, email, and password are required.");
      return;
    }
    if (form.password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      await createStaff(form);
      flash(`"${form.name}" added to your team.`);
      setShowModal(false);
      fetchStaff();
    } catch (err: any) {
      setFormError(err?.response?.data?.message || "Failed to create account.");
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (member: StaffMember) => {
    if (!window.confirm(`Deactivate ${member.name}? They won't be able to log in or take new bookings, but their history is kept.`)) return;
    try {
      await deactivateStaff(member.id);
      flash(`${member.name} deactivated.`);
      fetchStaff();
    } catch (err: any) {
      flash(err?.response?.data?.message || "Failed to deactivate.", true);
    }
  };

  const handleDelete = async (member: StaffMember) => {
    if (!window.confirm(
      `Permanently delete ${member.name}?\n\n` +
      `• Their login, availability and pricing are removed — this can't be undone.\n` +
      `• Past sessions, notes and invoices stay in your records, but will no longer show their name.\n` +
      `• Clients assigned to them become unassigned.\n\n` +
      `To keep their name on past records, use Deactivate instead.`
    )) return;
    try {
      await deleteStaff(member.id);
      flash(`${member.name} deleted.`);
      fetchStaff();
    } catch (err: any) {
      flash(err?.response?.data?.message || "Failed to delete.", true);
    }
  };

  const handleReactivate = async (member: StaffMember) => {
    try {
      await reactivateStaff(member.id);
      flash(`${member.name} reactivated.`);
      fetchStaff();
    } catch (err: any) {
      flash(err?.response?.data?.message || "Failed to reactivate.", true);
    }
  };

  const handleTogglePermission = async (member: StaffMember, key: string) => {
    const updated = member.permissions.includes(key)
      ? member.permissions.filter(p => p !== key)
      : [...member.permissions, key];
    setSavingPermsFor(member.id);
    try {
      await updatePermissions(member.id, updated);
      setStaff(prev => prev.map(s => s.id === member.id ? { ...s, permissions: updated } : s));
    } catch {
      flash("Failed to update permissions.", true);
    } finally {
      setSavingPermsFor(null);
    }
  };

  const toggleFormPermission = (key: string) => {
    setForm(f => ({
      ...f,
      permissions: f.permissions.includes(key) ? f.permissions.filter(p => p !== key) : [...f.permissions, key],
    }));
  };

  const psychologists = staff.filter(s => s.role === "ROLE_PSYCHOLOGIST");
  const others = staff.filter(s => s.role !== "ROLE_PSYCHOLOGIST");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }} className="anim-fade-up">

      {toast && typeof document !== "undefined" && createPortal(
        <div className="soft-card anim-fade-in" style={{
          position: "fixed", top: 24, right: 24, zIndex: 100,
          display: "flex", alignItems: "center", gap: 10,
          padding: "12px 20px", borderRadius: 16, fontSize: 13, fontWeight: 600,
          color: toast.isError ? "#b91c1c" : "#15803d", minWidth: 240,
        }}>
          {toast.isError ? <AlertCircle style={{ width: 16, height: 16 }} /> : <CheckCircle2 style={{ width: 16, height: 16 }} />}
          {toast.text}
        </div>,
        document.body
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-1)" }}>Staff Management</h1>
          <p style={{ fontSize: 13, color: "var(--text-3)", marginTop: 4 }}>
            Add practitioners and support staff, and control what they can see.
          </p>
        </div>
        <button onClick={openCreate} className="btn-nm-accent" style={{ padding: "12px 20px" }}>
          <Plus style={{ width: 16, height: 16 }} /> Add Staff
        </button>
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Loader2 style={{ width: 24, height: 24, color: "var(--accent)", animation: "spinSlow 1s linear infinite" }} />
        </div>
      ) : staff.length === 0 ? (
        <div className="soft-card" style={{ padding: "80px 40px", textAlign: "center" }}>
          <div className="icon-badge icon-badge--accent" style={{ width: 72, height: 72, borderRadius: "50%", margin: "0 auto 24px" }}>
            <UserCog style={{ width: 32, height: 32 }} />
          </div>
          <p style={{ fontSize: 16, fontWeight: 600, color: "var(--text-2)", marginBottom: 6 }}>No staff yet</p>
          <p style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 24 }}>Add your first team member to get started</p>
          <button onClick={openCreate} className="btn-nm-accent" style={{ padding: "12px 24px" }}>
            <Plus style={{ width: 16, height: 16 }} /> Add Staff
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {psychologists.length > 0 && (
            <div>
              <h2 style={{ fontSize: 12, fontWeight: 800, color: "#8075C4", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <Brain style={{ width: 14, height: 14 }} /> Psychologists
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {psychologists.map(m => (
                  <StaffCard key={m.id} member={m} savingPerms={savingPermsFor === m.id}
                    hasServicesConfigured={servicesConfigured[m.id]}
                    onTogglePermission={key => handleTogglePermission(m, key)}
                    onDeactivate={() => handleDeactivate(m)} onDelete={() => handleDelete(m)} onReactivate={() => handleReactivate(m)}
                    onManageSchedule={() => { setScheduleModalFor(m); setScheduleTab("services"); }}
                    onManageCredentials={() => setCredentialsFor(m)}
                    onRefresh={fetchStaff} flash={flash} />
                ))}
              </div>
            </div>
          )}
          {others.length > 0 && (
            <div>
              <h2 style={{ fontSize: 12, fontWeight: 800, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <UserCheck style={{ width: 14, height: 14 }} /> Support Staff
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {others.map(m => (
                  <StaffCard key={m.id} member={m} savingPerms={savingPermsFor === m.id}
                    onTogglePermission={key => handleTogglePermission(m, key)}
                    onDeactivate={() => handleDeactivate(m)} onDelete={() => handleDelete(m)} onReactivate={() => handleReactivate(m)}
                    onManageCredentials={() => setCredentialsFor(m)}
                    onRefresh={fetchStaff} flash={flash} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {showModal && typeof document !== "undefined" && createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div className="overlay-enter" style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }} onClick={() => setShowModal(false)} />
          <div className="soft-card anim-scale-in" style={{ position: "relative", width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--card-border)" }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--text-1)" }}>New Staff Account</h2>
              <button onClick={() => setShowModal(false)} className="icon-btn" style={{ width: 34, height: 34, borderRadius: "50%" }}>
                <X style={{ width: 14, height: 14 }} />
              </button>
            </div>

            <form onSubmit={handleCreate} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
              {formError && (
                <div className="soft-card-2" style={{ borderRadius: 12, padding: "10px 14px", color: "var(--danger)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  <AlertCircle style={{ width: 14, height: 14, flexShrink: 0 }} /> {formError}
                </div>
              )}

              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Role</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {ROLES.map(r => (
                    <button key={r.value} type="button" onClick={() => setForm(f => ({ ...f, role: r.value }))}
                      className="btn-nm" style={{
                        padding: "10px 8px", fontSize: 12, fontWeight: 600,
                        background: form.role === r.value ? "var(--accent)" : undefined,
                        color: form.role === r.value ? "#fff" : "var(--text-2)",
                      }}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Photo</label>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <StaffAvatar name={form.name} photo={form.profileImageUrl ?? ""} size={64}
                    onChange={url => setForm(f => ({ ...f, profileImageUrl: url }))}
                    onError={msg => setFormError(msg)} />
                  <p style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.5 }}>
                    Optional. JPG, PNG or WebP — resized automatically.<br />
                    {form.role === "ROLE_PSYCHOLOGIST" && "Shown to clients on your public booking page."}
                  </p>
                </div>
              </div>

              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Full Name</label>
                <div className="relative">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2" style={{ width: 14, height: 14, color: "var(--text-3)" }} />
                  <input className="nm-input" style={{ paddingLeft: 38 }} placeholder="Full name"
                    value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
              </div>

              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Job Title</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <select className="nm-input" style={{ maxWidth: 150, flexShrink: 0 }}
                    value="" onChange={e => { if (e.target.value) setForm(f => ({ ...f, jobTitle: e.target.value })); }}>
                    <option value="">Quick pick…</option>
                    {(JOB_TITLE_PRESETS[form.role] ?? []).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <input className="nm-input" style={{ flex: 1 }} placeholder="e.g. Clinical Psychologist, Front Desk"
                    value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} />
                </div>
              </div>

              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Login Email</label>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2" style={{ width: 14, height: 14, color: "var(--text-3)" }} />
                  <input type="email" className="nm-input" style={{ paddingLeft: 38 }} placeholder="staff@example.com"
                    value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required />
                </div>
              </div>

              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Password</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2" style={{ width: 14, height: 14, color: "var(--text-3)" }} />
                  <input type="password" className="nm-input" style={{ paddingLeft: 38 }} placeholder="At least 8 characters"
                    value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required />
                </div>
              </div>

              {form.role === "ROLE_PSYCHOLOGIST" && (
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>
                    Bookable (appears on your public booking page)
                  </label>
                  <button type="button" onClick={() => setForm(f => ({ ...f, bookable: !f.bookable }))}
                    className="btn-nm" style={{ padding: "8px 16px", fontSize: 12 }}>
                    {form.bookable ? <ShieldCheck style={{ width: 14, height: 14 }} /> : <ShieldOff style={{ width: 14, height: 14 }} />}
                    {form.bookable ? "Yes — clients can book them" : "No — hidden from booking page"}
                  </button>
                  <p style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>
                    Once created, set their services, pricing & availability from their card below — they log in themselves only to update their own bio.
                  </p>
                </div>
              )}

              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>
                  Dashboard Access
                  {form.role === "ROLE_PSYCHOLOGIST" && <span style={{ textTransform: "none", fontWeight: 400 }}> — Appointments &amp; Patients always included</span>}
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {ALL_PERMISSIONS.filter(p => !(form.role === "ROLE_PSYCHOLOGIST" && (p.key === "APPOINTMENTS" || p.key === "PATIENTS"))).map(perm => {
                    const active = form.permissions.includes(perm.key);
                    return (
                      <button key={perm.key} type="button" onClick={() => toggleFormPermission(perm.key)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 12,
                          border: `1px solid ${active ? "var(--accent)" : "var(--card-border)"}`,
                          background: active ? "rgba(79,110,247,0.08)" : "transparent",
                          color: active ? "var(--accent)" : "var(--text-3)", cursor: "pointer",
                        }}>
                        <div style={{ width: 14, height: 14, borderRadius: 4, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: active ? "var(--accent)" : "var(--card-border)" }}>
                          {active && <Check style={{ width: 9, height: 9, color: "#fff" }} strokeWidth={3} />}
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 500 }}>{perm.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <button type="submit" disabled={saving} className="btn-nm-accent" style={{ width: "100%", padding: "12px 0", marginTop: 4 }}>
                {saving ? <Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> : <Plus style={{ width: 14, height: 14 }} />}
                Create Account
              </button>
            </form>
          </div>
        </div>,
        document.body
      )}

      {credentialsFor && typeof document !== "undefined" && createPortal(
        <CredentialsModal member={credentialsFor} onClose={() => setCredentialsFor(null)}
          onSaved={fetchStaff} flash={flash} />,
        document.body
      )}

      {scheduleModalFor && typeof document !== "undefined" && createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div className="overlay-enter" style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }} onClick={() => { setScheduleModalFor(null); refreshServicesConfigured(staff); }} />
          <div className="soft-card anim-scale-in" style={{ position: "relative", width: "100%", maxWidth: 620, maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--card-border)" }}>
              <div>
                <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--text-1)" }}>{scheduleModalFor.name}</h2>
                <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>Services, pricing & availability</p>
              </div>
              <button onClick={() => { setScheduleModalFor(null); refreshServicesConfigured(staff); }} className="icon-btn" style={{ width: 34, height: 34, borderRadius: "50%" }}>
                <X style={{ width: 14, height: 14 }} />
              </button>
            </div>

            <div style={{ padding: "16px 24px 0" }}>
              <div className="soft-card-2" style={{ display: "flex", gap: 4, padding: 4, borderRadius: 14, width: "fit-content" }}>
                <button onClick={() => setScheduleTab("services")}
                  className={`tab-pill${scheduleTab === "services" ? " active" : ""}`}
                  style={{
                    padding: "8px 16px", borderRadius: 11, border: "none", cursor: "pointer",
                    fontWeight: 600, fontSize: 12, display: "flex", alignItems: "center", gap: 6,
                    background: scheduleTab === "services" ? "var(--card)" : "transparent",
                    color: scheduleTab === "services" ? "var(--text-1)" : "var(--text-3)",
                    boxShadow: scheduleTab === "services" ? "0 2px 8px var(--card-shadow-1)" : undefined,
                  }}>
                  <DollarSign style={{ width: 13, height: 13 }} /> Services & Pricing
                </button>
                <button onClick={() => setScheduleTab("availability")}
                  className={`tab-pill${scheduleTab === "availability" ? " active" : ""}`}
                  style={{
                    padding: "8px 16px", borderRadius: 11, border: "none", cursor: "pointer",
                    fontWeight: 600, fontSize: 12, display: "flex", alignItems: "center", gap: 6,
                    background: scheduleTab === "availability" ? "var(--card)" : "transparent",
                    color: scheduleTab === "availability" ? "var(--text-1)" : "var(--text-3)",
                    boxShadow: scheduleTab === "availability" ? "0 2px 8px var(--card-shadow-1)" : undefined,
                  }}>
                  <CalendarClock style={{ width: 13, height: 13 }} /> Availability
                </button>
              </div>
            </div>

            <div style={{ padding: 24 }}>
              {scheduleTab === "services"
                ? <StaffServicesEditor staffId={scheduleModalFor.id} />
                : <AvailabilityEditor staffId={scheduleModalFor.id} />}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Staff card ────────────────────────────────────────────────────────────
function StaffCard({ member, savingPerms, hasServicesConfigured, onTogglePermission, onDeactivate, onDelete, onReactivate, onManageSchedule, onManageCredentials, onRefresh, flash }: {
  member: StaffMember;
  savingPerms: boolean;
  hasServicesConfigured?: boolean;
  onTogglePermission: (key: string) => void;
  onDeactivate: () => void;
  onDelete: () => void;
  onReactivate: () => void;
  onManageSchedule?: () => void;
  onManageCredentials: () => void;
  onRefresh: () => void;
  flash: (text: string, isError?: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [role, setRole] = useState(member.role);
  const [jobTitle, setJobTitle] = useState(member.jobTitle ?? "");
  const [bookable, setBookable] = useState(member.bookable);
  const [photo, setPhoto] = useState(member.profileImageUrl ?? "");
  const [saving, setSaving] = useState(false);
  const isDoctor = member.role === "ROLE_PSYCHOLOGIST";
  const isDoctorEditing = role === "ROLE_PSYCHOLOGIST";

  const openEdit = () => {
    setName(member.name);
    setRole(member.role);
    setJobTitle(member.jobTitle ?? "");
    setBookable(member.bookable);
    setPhoto(member.profileImageUrl ?? "");
    setEditing(true);
  };

  const handleSave = async () => {
    if (!name.trim()) { flash("Name cannot be empty.", true); return; }
    setSaving(true);
    try {
      // "" is meaningful here — it clears an existing photo server-side
      // (StaffService.updateStaff only skips fields sent as null).
      await updateStaff(member.id, { name: name.trim(), role, jobTitle: jobTitle.trim(), bookable, profileImageUrl: photo });
      flash("Staff details updated.");
      setEditing(false);
      onRefresh();
    } catch (err: any) {
      flash(err?.response?.data?.message || "Failed to update.", true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SpotlightDiv className="soft-card p-5" style={{ opacity: member.enabled ? 1 : 0.6 }}>
      <div className="flex justify-between items-start" style={{ marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div className="flex items-center gap-3">
          <StaffAvatar name={member.name} photo={editing ? photo : (member.profileImageUrl ?? "")}
            size={editing ? 52 : 42}
            onChange={editing ? setPhoto : undefined}
            onError={msg => flash(msg, true)} />
          <div>
            {editing ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input value={name} onChange={e => setName(e.target.value)}
                  placeholder="Full name"
                  className="nm-input" style={{ fontSize: 12, padding: "6px 10px", width: 160 }} />
                <select value={role} onChange={e => setRole(e.target.value)}
                  className="nm-input" style={{ fontSize: 12, padding: "6px 10px" }}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <select value="" onChange={e => { if (e.target.value) setJobTitle(e.target.value); }}
                  className="nm-input" style={{ fontSize: 12, padding: "6px 10px", width: 110 }}>
                  <option value="">Quick pick…</option>
                  {(JOB_TITLE_PRESETS[role] ?? []).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <input value={jobTitle} onChange={e => setJobTitle(e.target.value)}
                  placeholder="Job title"
                  className="nm-input" style={{ fontSize: 12, padding: "6px 10px", width: 160 }} />
                {isDoctorEditing && (
                  <button type="button" onClick={() => setBookable(b => !b)} className="btn-nm" style={{ padding: "6px 12px", fontSize: 11 }}
                    title="Whether clients can book this practitioner on the public booking page">
                    {bookable ? <ShieldCheck style={{ width: 12, height: 12 }} /> : <ShieldOff style={{ width: 12, height: 12 }} />}
                    {bookable ? "Bookable" : "Not bookable"}
                  </button>
                )}
                <button onClick={handleSave} disabled={saving} className="btn-nm-accent" style={{ padding: "6px 14px", fontSize: 11 }}>
                  {saving ? "…" : "Save"}
                </button>
                <button onClick={() => setEditing(false)} disabled={saving} className="btn-nm" style={{ padding: "6px 12px", fontSize: 11 }}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <p style={{ fontWeight: 700, fontSize: 14, color: "var(--text-1)" }}>{member.name}</p>
                  {roleBadge(member.role)}
                  {isDoctor && (member.bookable ? (
                    <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border bg-green-50 text-green-700 border-green-200">Bookable</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200" title="Clients can't book this practitioner until Bookable is turned on">
                      <AlertTriangle style={{ width: 10, height: 10 }} /> Not bookable — hidden from clients
                    </span>
                  ))}
                  {isDoctor && member.enabled && hasServicesConfigured === false && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200" title="No service has a price set for this practitioner — the booking page will show an empty service list">
                      <AlertTriangle style={{ width: 10, height: 10 }} /> No services priced yet
                    </span>
                  )}
                  {!member.enabled && (
                    <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border bg-red-50 text-red-600 border-red-200">Deactivated</span>
                  )}
                </div>
                <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>
                  {member.username}{member.jobTitle ? ` · ${member.jobTitle}` : ""}
                </p>
              </>
            )}
          </div>
        </div>
        {!editing && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {onManageSchedule && (
              <button onClick={onManageSchedule} className="btn-nm" style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, gap: 6 }}
                title="Manage this practitioner's services, pricing & availability">
                <CalendarClock style={{ width: 13, height: 13, color: "var(--accent)" }} /> Schedule & Pricing
              </button>
            )}
            <button onClick={openEdit} className="icon-btn" title="Edit name, role & job title">
              <Pencil style={{ width: 14, height: 14 }} />
            </button>
            <button onClick={onManageCredentials} className="icon-btn" title="Change login email & password">
              <KeyRound style={{ width: 14, height: 14 }} />
            </button>
            {member.enabled ? (
              <button onClick={onDeactivate} className="icon-btn" title="Deactivate" style={{ color: "var(--danger)" }}>
                <ShieldOff style={{ width: 14, height: 14 }} />
              </button>
            ) : (
              <button onClick={onReactivate} className="icon-btn" title="Reactivate" style={{ color: "var(--success)" }}>
                <ShieldCheck style={{ width: 14, height: 14 }} />
              </button>
            )}
            <button onClick={onDelete} className="icon-btn" title="Delete permanently" aria-label={`Delete ${member.name}`} style={{ color: "var(--danger)" }}>
              <Trash2 style={{ width: 14, height: 14 }} />
            </button>
          </div>
        )}
      </div>

      <div>
        <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
          Dashboard Access {isDoctor && <span style={{ fontWeight: 400, textTransform: "none" }}>(Appointments &amp; Patients always included)</span>}
          {savingPerms && <span style={{ color: "var(--accent)", fontWeight: 400, textTransform: "none", marginLeft: 6 }}>saving…</span>}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {ALL_PERMISSIONS.filter(p => !(isDoctor && (p.key === "APPOINTMENTS" || p.key === "PATIENTS"))).map(perm => {
            const active = member.permissions.includes(perm.key);
            return (
              <button key={perm.key} onClick={() => onTogglePermission(perm.key)} disabled={savingPerms || !member.enabled}
                style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 10,
                  border: `1px solid ${active ? "var(--accent)" : "var(--card-border)"}`,
                  background: active ? "rgba(79,110,247,0.08)" : "transparent",
                  color: active ? "var(--accent)" : "var(--text-3)", cursor: member.enabled ? "pointer" : "not-allowed",
                  fontSize: 11, fontWeight: 500,
                }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: active ? "var(--accent)" : "var(--card-border)" }}>
                  {active && <Check style={{ width: 8, height: 8, color: "#fff" }} strokeWidth={3} />}
                </div>
                {perm.label}
              </button>
            );
          })}
        </div>
      </div>
    </SpotlightDiv>
  );
}

// ── Login details ─────────────────────────────────────────────────────────
// A clinic staff member can't reset their own password — their account belongs
// to the clinic. This modal is the replacement for a self-service reset:
// the admin sets the new email and/or password directly and passes it on.
function CredentialsModal({ member, onClose, onSaved, flash }: {
  member: StaffMember;
  onClose: () => void;
  onSaved: () => void;
  flash: (text: string, isError?: boolean) => void;
}) {
  const [email, setEmail] = useState(member.username);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Both halves are independent: leaving the password blank keeps the current
  // one, and leaving the email untouched keeps that. Matches what the endpoint
  // does with omitted fields — see updateStaffCredentials.
  const nextEmail = email.trim().toLowerCase();
  const emailChanged = nextEmail !== member.username.toLowerCase();
  const settingPassword = password.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!emailChanged && !settingPassword) {
      setError("Change the login email or set a new password first.");
      return;
    }
    if (settingPassword) {
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
      if (password !== confirm) { setError("Passwords don't match."); return; }
    }

    setSaving(true);
    try {
      await updateStaffCredentials(member.id, {
        ...(emailChanged ? { username: nextEmail } : {}),
        ...(settingPassword ? { password } : {}),
      });
      flash(`Login details updated for ${member.name}.`);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to update login details.");
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="overlay-enter" style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }} onClick={onClose} />
      <div className="soft-card anim-scale-in" style={{ position: "relative", width: "100%", maxWidth: 460, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--card-border)" }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--text-1)" }}>Login Details</h2>
            <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>{member.name}</p>
          </div>
          <button onClick={onClose} className="icon-btn" style={{ width: 34, height: 34, borderRadius: "50%" }}>
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
          {error && (
            <div className="soft-card-2" style={{ borderRadius: 12, padding: "10px 14px", color: "var(--danger)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <AlertCircle style={{ width: 14, height: 14, flexShrink: 0 }} /> {error}
            </div>
          )}

          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Login Email</label>
            <div className="relative">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2" style={{ width: 14, height: 14, color: "var(--text-3)" }} />
              <input type="email" className="nm-input" style={{ paddingLeft: 38 }} placeholder="staff@example.com"
                value={email} onChange={e => setEmail(e.target.value)} disabled={saving} required />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>
              New Password <span style={{ textTransform: "none", fontWeight: 400 }}>— leave blank to keep the current one</span>
            </label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2" style={{ width: 14, height: 14, color: "var(--text-3)" }} />
              <input type="password" className="nm-input" style={{ paddingLeft: 38 }} placeholder="At least 8 characters"
                value={password} onChange={e => setPassword(e.target.value)} disabled={saving} autoComplete="new-password" />
            </div>
          </div>

          {settingPassword && (
            <div className="anim-fade-in">
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Confirm Password</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2" style={{ width: 14, height: 14, color: "var(--text-3)" }} />
                <input type="password" className="nm-input" style={{ paddingLeft: 38 }} placeholder="Re-enter the new password"
                  value={confirm} onChange={e => setConfirm(e.target.value)} disabled={saving} autoComplete="new-password" />
              </div>
            </div>
          )}

          <div className="soft-card-2" style={{ borderRadius: 12, padding: "12px 14px", fontSize: 11, color: "var(--text-3)", lineHeight: 1.6 }}>
            {member.name.split(" ")[0]} will be signed out of any devices they&apos;re currently using, and we&apos;ll
            email {emailChanged ? <strong style={{ color: "var(--text-2)" }}>{nextEmail || "their new address"}</strong> : "them"} to let them know.
            Share the new password with them directly — it&apos;s never shown again here.
          </div>

          <button type="submit" disabled={saving || (!emailChanged && !settingPassword)} className="btn-nm-accent" style={{ width: "100%", padding: "12px 0" }}>
            {saving ? <Loader2 style={{ width: 14, height: 14, animation: "spinSlow 1s linear infinite" }} /> : <KeyRound style={{ width: 14, height: 14 }} />}
            Update Login Details
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Attendance tab ───────────────────────────────────────────────────────
function AttendanceTab() {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [active, setActive] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [all, activeNow] = await Promise.all([getAllAttendance(), getActiveStaff()]);
      setRecords(all);
      setActive(activeNow);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
        <Loader2 style={{ width: 24, height: 24, color: "var(--accent)", animation: "spinSlow 1s linear infinite" }} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success)" }} />
          <h2 style={{ fontSize: 12, fontWeight: 800, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Currently Active</h2>
          <span style={{ fontSize: 11, fontWeight: 700, background: "rgba(34,197,94,0.12)", color: "var(--success)", padding: "1px 8px", borderRadius: 20 }}>{active.length}</span>
          <button onClick={fetchData} className="icon-btn" style={{ marginLeft: "auto" }} title="Refresh">
            <RefreshCw style={{ width: 14, height: 14 }} />
          </button>
        </div>
        {active.length === 0 ? (
          <div className="soft-card-2" style={{ padding: 32, textAlign: "center", borderRadius: 16 }}>
            <p style={{ fontSize: 12, color: "var(--text-3)" }}>No staff currently logged in</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {active.map(rec => (
              <div key={rec.id} className="soft-card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12 }}>
                <div className="team-avatar" style={{ width: 36, height: 36, borderRadius: "50%", fontSize: 14 }}>
                  {rec.staffName.charAt(0).toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>{rec.staffName}</p>
                  <p style={{ fontSize: 11, color: "var(--success)", display: "flex", alignItems: "center", gap: 4 }}>
                    <LogIn style={{ width: 10, height: 10 }} /> {new Date(rec.loginTime + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 style={{ fontSize: 12, fontWeight: 800, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>Login History</h2>
        {records.length === 0 ? (
          <div className="soft-card-2" style={{ padding: 32, textAlign: "center", borderRadius: 16 }}>
            <p style={{ fontSize: 12, color: "var(--text-3)" }}>No records yet</p>
          </div>
        ) : (
          <div className="soft-card" style={{ overflow: "hidden" }}>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--soft-2, rgba(0,0,0,0.02))", borderBottom: "1px solid var(--card-border)" }}>
                  {["Staff", "Date", "Login", "Logout", "Worked", "Status"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map(rec => (
                  <tr key={rec.id} style={{ borderBottom: "1px solid var(--card-border)" }}>
                    <td style={{ padding: "10px 16px" }}>
                      <p style={{ fontWeight: 600, color: "var(--text-1)" }}>{rec.staffName}</p>
                      <p style={{ fontSize: 11, color: "var(--text-3)" }}>{rec.staffJobTitle || "Staff"}</p>
                    </td>
                    <td style={{ padding: "10px 16px", color: "var(--text-2)" }}>{rec.date}</td>
                    <td style={{ padding: "10px 16px", color: "var(--success)" }}>
                      {new Date(rec.loginTime + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td style={{ padding: "10px 16px", color: rec.logoutTime ? "var(--danger)" : "var(--text-3)" }}>
                      {rec.logoutTime ? new Date(rec.logoutTime + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                    </td>
                    <td style={{ padding: "10px 16px", color: "var(--text-1)", fontWeight: 600 }}>{formatDuration(rec.workMinutes)}</td>
                    <td style={{ padding: "10px 16px" }}>
                      {rec.logoutTime ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, background: "var(--card-border)", color: "var(--text-3)", padding: "2px 10px", borderRadius: 20 }}>
                          <LogOut style={{ width: 10, height: 10 }} /> Logged out
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, background: "rgba(34,197,94,0.12)", color: "var(--success)", padding: "2px 10px", borderRadius: 20 }}>
                          Active
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
