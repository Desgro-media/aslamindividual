"use client";

import React, { useEffect, useState, useMemo } from "react";
import { Target, Search, Phone, Mail, CheckCircle2, Circle, CalendarPlus } from "lucide-react";
import api from "../../../lib/api";
import NewBookingWizard from "../../../components/psyfos/NewBookingWizard";

type Lead = {
  id: number;
  name: string;
  email?: string | null;
  phone: string;
  notes?: string | null;
  status: string; // NEW or CONVERTED
  createdAt: string;
};

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // Client Enquiry -> Client Details -> booking: an enquiry opens the booking
  // flow with its details already filled in.
  const [booking, setBooking] = useState<Lead | null>(null);

  const loadLeads = () => {
    api.get("/leads")
      .then(res => setLeads(res.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  };
  useEffect(() => { loadLeads(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter(l =>
      !q ||
      l.name?.toLowerCase().includes(q) ||
      l.email?.toLowerCase().includes(q) ||
      l.phone?.toLowerCase().includes(q)
    );
  }, [leads, search]);

  const newCount = leads.filter(l => l.status === "NEW").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }} className="anim-fade-up">

      {/* ── Search + Stats ─────────────────────────────────────────────────── */}
      <div className="soft-card anim-fade-up d1" style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <Search style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--text-3)" }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            type="text"
            placeholder="Search leads..."
            className="nm-input"
            style={{ paddingLeft: 40 }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div className="soft-card-2" style={{ borderRadius: 50, padding: "8px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <Target style={{ width: 14, height: 14, color: "var(--accent)" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>{filtered.length}</span>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>leads</span>
          </div>
          {newCount > 0 && (
            <div className="soft-card-2" style={{ borderRadius: 50, padding: "8px 16px", display: "flex", alignItems: "center", gap: 8 }}>
              <Circle style={{ width: 10, height: 10, color: "var(--warning)", fill: "var(--warning)" }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>{newCount}</span>
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>uncontacted</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Leads List ─────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[...Array(4)].map((_, i) => (
            <div key={i} className="soft-card" style={{ padding: 18 }}>
              <div className="skel" style={{ height: 14, width: "40%", marginBottom: 8 }} />
              <div className="skel" style={{ height: 10, width: "60%" }} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="soft-card" style={{ textAlign: "center", padding: "60px 0" }}>
          <Target style={{ width: 48, height: 48, color: "var(--text-3)", margin: "0 auto 12px" }} />
          <p style={{ color: "var(--text-2)", fontWeight: 600 }}>No leads yet</p>
          <p style={{ color: "var(--text-3)", fontSize: 13 }}>
            Leads appear here as soon as someone fills in their details on your booking page.
          </p>
        </div>
      ) : (
        <div className="soft-card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--card-border)" }}>
                  {["Name", "Contact", "Note", "Status", "Received", ""].map(h => (
                    <th key={h} style={{
                      textAlign: "left", padding: "14px 20px", fontSize: 11, fontWeight: 700,
                      color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((lead, i) => (
                  <tr key={lead.id} style={{ borderBottom: i === filtered.length - 1 ? "none" : "1px solid var(--card-border)" }}>
                    <td style={{ padding: "16px 20px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div className="team-avatar" style={{ width: 34, height: 34, borderRadius: "50%", fontSize: 13, background: "var(--accent-surface)", color: "var(--accent)" }}>
                          {lead.name.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>{lead.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: "16px 20px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
                          <Phone style={{ width: 11, height: 11, color: "var(--text-3)" }} />
                          {lead.phone}
                        </div>
                        {lead.email && (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-3)" }}>
                            <Mail style={{ width: 11, height: 11, color: "var(--text-3)" }} />
                            {lead.email}
                          </div>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: "16px 20px", maxWidth: 280 }}>
                      <span style={{ fontSize: 12, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                        {lead.notes || "—"}
                      </span>
                    </td>
                    <td style={{ padding: "16px 20px" }}>
                      {lead.status === "CONVERTED" ? (
                        <span className="stat-chip" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", background: "var(--accent-surface)", borderRadius: 50 }}>
                          <CheckCircle2 style={{ width: 12, height: 12, color: "var(--accent)" }} />
                          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>Converted</span>
                        </span>
                      ) : (
                        <span className="stat-chip" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", background: "var(--warning-bg)", borderRadius: 50 }}>
                          <Circle style={{ width: 8, height: 8, color: "var(--warning)", fill: "var(--warning)" }} />
                          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--warning)" }}>New</span>
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "16px 20px", fontSize: 12, color: "var(--text-3)" }}>
                      {new Date(lead.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                    </td>
                    <td style={{ padding: "16px 20px", textAlign: "right" }}>
                      {lead.status !== "CONVERTED" && (
                        <button onClick={() => setBooking(lead)} className="btn-nm" style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, gap: 6, color: "var(--accent)" }}>
                          <CalendarPlus style={{ width: 13, height: 13 }} /> Book session
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {booking && (
        <NewBookingWizard
          prefill={{ name: booking.name, phone: booking.phone, email: booking.email ?? "", notes: booking.notes ?? "" }}
          onClose={() => setBooking(null)}
          onBooked={() => loadLeads()}
        />
      )}
    </div>
  );
}
