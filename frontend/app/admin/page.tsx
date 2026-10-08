"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ShieldCheck, Mail, Lock, LogIn } from "lucide-react";
import api from "../../lib/api";
import { storeSession, syncSessionCookie, clearSession } from "../../lib/authSession";

// Deliberately not linked from the public site or the regular /login page —
// the only account that can ever authenticate here is the single seeded
// superadmin (see backend StartupInitializer). Posts to the exact same
// /api/v1/auth/login as every other account; there is no separate auth
// mechanism, just a role check on the response.
function SuperAdminLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("token");
    const user = localStorage.getItem("user");
    if (!token || !user) {
      setCheckingSession(false);
      if (searchParams.get("expired") === "1") setNotice("Your session expired. Please sign in again.");
      return;
    }
    api.get("/auth/me")
      .then((res) => {
        if (res.data.role !== "ROLE_SUPERADMIN") {
          // Show the form, but leave their session alone. This used to
          // clearSession() here, which meant merely opening this URL signed a
          // practitioner out of their own dashboard — a destructive side
          // effect of navigation, and an easy one to trigger by accident when
          // switching between the two consoles. Signing in below replaces the
          // session anyway; navigating away should cost them nothing.
          setNotice("You're signed in with a practitioner account. Sign in below with an admin account to continue.");
          setCheckingSession(false);
          return;
        }
        syncSessionCookie();
        router.replace("/admin/dashboard");
      })
      .catch(() => {
        clearSession();
        setCheckingSession(false);
      });
  }, [router, searchParams]);

  if (checkingSession) {
    return <div className="min-h-screen bg-[#0A1211]" />;
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.post("/auth/login", { email, password });
      if (res.data.role !== "ROLE_SUPERADMIN") {
        setError("This account is not authorized for admin access.");
        setLoading(false);
        return;
      }
      storeSession(res.data.token, {
        id: res.data.id,
        username: res.data.username,
        name: res.data.name,
        role: res.data.role,
      });
      router.push("/admin/dashboard");
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setError(
        status === 429
          ? "Too many sign-in attempts from this network. Please wait a few minutes and try again."
          : status === undefined || status >= 500
            ? "Couldn't reach the server. Please try again in a moment."
            : "Invalid email or password"
      );
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col overflow-hidden bg-[#0A1211] text-white">
      <div
        className="absolute inset-0 z-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 70% 55% at 20% 0%, rgba(196,90,90,0.25) 0%, transparent 60%), radial-gradient(ellipse 50% 45% at 100% 20%, rgba(128,117,196,0.20) 0%, transparent 65%)",
        }}
      />

      <div className="relative z-10 flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[420px] rounded-[28px] border border-white/10 bg-white/[0.03] backdrop-blur-xl px-9 py-12 shadow-2xl shadow-black/40 anim-scale-in">

          <div className="text-center mb-9">
            <div className="w-16 h-16 rounded-full border border-white/10 bg-white/[0.04] flex items-center justify-center mx-auto mb-5">
              <div className="w-11 h-11 rounded-full bg-[#c45a5a]/15 flex items-center justify-center">
                <ShieldCheck className="w-5 h-5 text-[#e88f8f]" />
              </div>
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">Superadmin</h1>
            <p className="text-sm text-white/50">Restricted access</p>
          </div>

          {notice && !error && (
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 mb-6 text-white/70 text-[13px] text-center">
              {notice}
            </div>
          )}
          {error && (
            <div className="rounded-xl border border-[#fb4b6e]/25 bg-[#fb4b6e]/10 px-4 py-3 mb-6 text-[#ff8fa3] text-[13px] text-center">
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} className="flex flex-col gap-5">
            <div>
              <label className="block text-[11px] font-semibold text-white/40 uppercase tracking-[0.08em] mb-2">Email</label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/35 pointer-events-none" />
                <input
                  type="email"
                  className="w-full rounded-xl border border-white/12 bg-white/[0.04] pl-11 pr-4 py-3.5 text-[14px] text-white placeholder:text-white/30 outline-none transition-colors focus:border-[#c45a5a] focus:bg-white/[0.06]"
                  placeholder="admin@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-white/40 uppercase tracking-[0.08em] mb-2">Password</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/35 pointer-events-none" />
                <input
                  type="password"
                  className="w-full rounded-xl border border-white/12 bg-white/[0.04] pl-11 pr-4 py-3.5 text-[14px] text-white placeholder:text-white/30 outline-none transition-colors focus:border-[#c45a5a] focus:bg-white/[0.06]"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={loading || !email || !password}
              className="mt-2 w-full inline-flex items-center justify-center gap-2 rounded-full bg-[#c45a5a] py-3.5 text-[14px] font-semibold text-white transition-all hover:bg-[#d16b6b] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "Signing in..." : (<><LogIn className="w-4 h-4" /> Sign In</>)}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function SuperAdminLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0A1211]" />}>
      <SuperAdminLoginForm />
    </Suspense>
  );
}
