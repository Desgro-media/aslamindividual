import { waitUntil } from "@vercel/functions";
import { config } from "../config";
import { getDb } from "../db";

// Outbound email (Resend), SMS + WhatsApp (Twilio) and Telegram — the same
// messages the Spring NotificationService sent, over plain REST so no SDK is
// needed. Every channel is optional: with no key configured it is skipped and
// the core booking flow is unaffected.
//
// On the old backend these were @Async. On a serverless platform the function
// may be frozen the instant the response is sent, so the work is handed to the
// platform's waitUntil() — the response goes out immediately and the
// notifications finish in the background.

export function background(task: Promise<unknown>): void {
    const safe = task.catch((err) => console.error("[notify] background task failed:", err?.message ?? err));
    try {
        waitUntil(safe);
    } catch {
        /* not running on Vercel (local dev / scripts): the promise just runs on its own */
    }
}

const esc = (s: string | null | undefined) =>
    (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ── Channels ─────────────────────────────────────────────────────────────────

async function sendEmail(to: string | null, subject: string, html: string): Promise<void> {
    if (!to) return;
    if (!config.resendApiKey) {
        console.log(`[notify] RESEND_API_KEY not set — skipping email to ${to} (${subject})`);
        return;
    }
    try {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: `PatientBook <${config.resendFromEmail}>`, to: [to], subject, html }),
        });
        if (!res.ok) console.error(`[notify] Failed to send email to ${to} via Resend: ${res.status} ${await res.text()}`);
        else console.log(`[notify] Email sent via Resend to ${to}`);
    } catch (err) {
        console.error(`[notify] Failed to send email to ${to} via Resend:`, (err as Error).message);
    }
}

function formatPhoneNumber(phone: string | null): string | null {
    if (phone && /^\d{10}$/.test(phone)) return "+91" + phone;
    if (phone && !phone.startsWith("+")) return "+" + phone;
    return phone;
}

async function twilioSend(to: string, from: string, body: string): Promise<void> {
    const sid = config.twilioAccountSid;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
            Authorization: "Basic " + Buffer.from(`${sid}:${config.twilioAuthToken}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

async function sendSmsAndWhatsapp(phone: string | null, text: string): Promise<void> {
    if (!config.twilioAccountSid || !config.twilioAuthToken || config.twilioAccountSid.includes("xxx")) return;
    const formatted = formatPhoneNumber(phone);
    if (!formatted) return;
    try {
        await twilioSend(formatted, config.twilioPhoneNumber, text);
        console.log(`[notify] SMS sent to ${formatted}`);
    } catch (err) {
        console.error(`[notify] SMS failed to ${formatted}:`, (err as Error).message);
    }
    try {
        await twilioSend(`whatsapp:${formatted}`, `whatsapp:${config.twilioWhatsappNumber}`, text);
        console.log(`[notify] WhatsApp sent to ${formatted}`);
    } catch (err) {
        console.error(`[notify] WhatsApp failed to ${formatted}:`, (err as Error).message);
    }
}

export async function telegramSend(chatId: string, text: string): Promise<void> {
    const token = config.telegramBotToken;
    if (!token || token === "xxx" || !chatId) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
        });
        if (!res.ok) console.error(`[notify] Failed to send Telegram message: ${res.status} ${await res.text()}`);
    } catch (err) {
        console.error("[notify] Failed to send Telegram message:", (err as Error).message);
    }
}

async function sendTelegramIfLinked(token: string, text: string): Promise<void> {
    const row = await getDb().one<{ telegramChatId: string | null }>(
        `SELECT p.telegram_chat_id FROM appointment a JOIN patient p ON p.id = a.patient_id WHERE a.tracking_token = $1`,
        [token]
    );
    if (row?.telegramChatId && row.telegramChatId.trim()) await telegramSend(row.telegramChatId, text);
}

// ── Templates ────────────────────────────────────────────────────────────────

const btn = (href: string, bg: string, label: string) =>
    `<a href='${href}' style='display:inline-block;padding:12px 28px;background:${bg};color:#fff;border-radius:50px;text-decoration:none;font-weight:600;font-size:14px;'>${label}</a>`;

function buildEmailHtml(title: string, name: string, message: string, date: string, time: string, ctaHtml: string, accent: string): string {
    return (
        "<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head>" +
        "<body style='margin:0;padding:0;background:#f0f2ff;font-family:Inter,-apple-system,sans-serif;'>" +
        "<table width='100%' cellpadding='0' cellspacing='0' style='padding:40px 20px;'><tr><td align='center'>" +
        "<table width='560' cellpadding='0' cellspacing='0' style='background:rgba(255,255,255,0.9);border-radius:24px;overflow:hidden;box-shadow:0 8px 40px rgba(79,110,247,0.10);border:1px solid rgba(200,210,255,0.5);'>" +
        `<tr><td style='background:${accent};padding:28px 36px;'>` +
        "<h1 style='margin:0;font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.03em;'>PatientBook</h1>" +
        `<p style='margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.80);'>${title}</p>` +
        "</td></tr>" +
        "<tr><td style='padding:36px 36px 28px;'>" +
        `<p style='margin:0 0 8px;font-size:22px;font-weight:800;color:#1b2048;letter-spacing:-0.02em;'>Hi ${esc(name)} 👋</p>` +
        `<p style='margin:0 0 28px;font-size:15px;color:#4a5282;line-height:1.65;'>${message}</p>` +
        "<div style='background:#f4f6ff;border-radius:16px;padding:20px 24px;margin-bottom:28px;border:1px solid rgba(180,196,255,0.4);'>" +
        "<table width='100%' cellpadding='0' cellspacing='0'>" +
        "<tr><td style='padding-bottom:12px;'>" +
        "<p style='margin:0;font-size:10px;font-weight:700;color:#8a90bc;text-transform:uppercase;letter-spacing:0.08em;'>Date</p>" +
        `<p style='margin:4px 0 0;font-size:15px;font-weight:600;color:#1b2048;'>${esc(date)}</p>` +
        "</td></tr><tr><td>" +
        "<p style='margin:0;font-size:10px;font-weight:700;color:#8a90bc;text-transform:uppercase;letter-spacing:0.08em;'>Time</p>" +
        `<p style='margin:4px 0 0;font-size:15px;font-weight:600;color:#1b2048;'>${esc(time)}</p>` +
        "</td></tr></table></div>" +
        `<div style='text-align:center;margin-bottom:8px;'>${ctaHtml}</div>` +
        "</td></tr>" +
        "<tr><td style='padding:20px 36px;border-top:1px solid rgba(180,196,255,0.3);'>" +
        "<p style='margin:0;font-size:12px;color:#8a90bc;text-align:center;'>Sent by PatientBook &mdash; secure appointment management</p>" +
        "</td></tr></table></td></tr></table></body></html>"
    );
}

function buildSimpleEmailHtml(title: string, name: string, message: string, ctaHtml: string, accent: string): string {
    return (
        "<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head>" +
        "<body style='margin:0;padding:0;background:#f0f2ff;font-family:Inter,-apple-system,sans-serif;'>" +
        "<table width='100%' cellpadding='0' cellspacing='0' style='padding:40px 20px;'><tr><td align='center'>" +
        "<table width='560' cellpadding='0' cellspacing='0' style='background:rgba(255,255,255,0.9);border-radius:24px;overflow:hidden;box-shadow:0 8px 40px rgba(79,110,247,0.10);border:1px solid rgba(200,210,255,0.5);'>" +
        `<tr><td style='background:${accent};padding:28px 36px;'>` +
        "<h1 style='margin:0;font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.03em;'>Mindesk</h1>" +
        `<p style='margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.80);'>${title}</p>` +
        "</td></tr>" +
        "<tr><td style='padding:36px 36px 28px;'>" +
        `<p style='margin:0 0 8px;font-size:22px;font-weight:800;color:#1b2048;letter-spacing:-0.02em;'>Hi ${esc(name)} 👋</p>` +
        `<p style='margin:0 0 28px;font-size:15px;color:#4a5282;line-height:1.65;'>${message}</p>` +
        `<div style='text-align:center;margin-bottom:8px;'>${ctaHtml}</div>` +
        "</td></tr>" +
        "<tr><td style='padding:20px 36px;border-top:1px solid rgba(180,196,255,0.3);'>" +
        "<p style='margin:0;font-size:12px;color:#8a90bc;text-align:center;'>Sent by Mindesk &mdash; secure practice management</p>" +
        "</td></tr></table></td></tr></table></body></html>"
    );
}

// ── Public API (same events the Spring service exposed) ──────────────────────

export interface ApptNotice {
    name: string;
    email: string | null;
    phone: string | null;
    date: string;
    time: string;
    token: string;
}

async function deliver(n: ApptNotice, subject: string, html: string, sms: string): Promise<void> {
    await sendEmail(n.email, subject, html);
    await sendSmsAndWhatsapp(n.phone, sms);
    await sendTelegramIfLinked(n.token, sms);
}

export function sendBookingApproved(n: ApptNotice): void {
    const link = `${config.appBaseUrl}/track/${n.token}`;
    const html = buildEmailHtml(
        "Appointment Confirmed ✓", n.name,
        "Great news! The doctor has approved your appointment. Please make sure to arrive on time.",
        n.date, n.time, btn(link, "#00c48c", "View Appointment Details"), "#00c48c"
    );
    const sms = `Great news, ${n.name}! Your appointment on ${n.date} at ${n.time} has been CONFIRMED. Details: ${link}`;
    background(deliver(n, "Appointment Confirmed ✓", html, sms));
}

export function sendPaymentLink(n: ApptNotice): void {
    const link = `${config.appBaseUrl}/track/${n.token}`;
    const html = buildEmailHtml(
        "Action Required: Complete Payment", n.name,
        "Your appointment has been booked! To confirm your slot, please complete the payment and upload your screenshot via the link below.",
        n.date, n.time, btn(link, "#f59e0b", "Pay Now to Confirm"), "#f59e0b"
    );
    const sms = `Hi ${n.name}! Your appointment on ${n.date} at ${n.time} is booked. Please complete payment and upload your screenshot to confirm: ${link}`;
    background(deliver(n, "Action Required: Complete Payment", html, sms));
}

export function sendBookingCancelled(n: ApptNotice, reason: string | null): void {
    const rebook = `${config.appBaseUrl}/track/${n.token}/rebook`;
    const reasonNote = reason && reason.trim()
        ? `<p style='margin:0 0 16px;padding:12px 16px;background:#fef2f2;border-left:3px solid #f43f5e;border-radius:8px;font-size:13px;color:#7f1d1d;'><strong>Reason:</strong> ${esc(reason)}</p>`
        : "";
    const html = buildEmailHtml(
        "Appointment Cancelled", n.name,
        "Unfortunately your appointment has been cancelled." + (reason ? ` Reason: ${esc(reason)}` : "") + " You can easily rebook a new slot.",
        n.date, n.time, reasonNote + btn(rebook, "#4f6ef7", "Book a New Slot"), "#f43f5e"
    );
    const sms = `Hi ${n.name}, your appointment on ${n.date} at ${n.time} was cancelled. Rebook here: ${rebook}`;
    background(deliver(n, "Appointment Cancelled", html, sms));
}

// Platform subscription emails (no appointment context)

export function sendSubscriptionActivatedEmail(name: string, email: string, periodEndDisplay: string): void {
    const html = buildSimpleEmailHtml(
        "Subscription Activated ✓", name,
        `Your payment has been verified and your subscription is now active through ${esc(periodEndDisplay)}. Thanks for staying with Mindesk!`,
        btn(`${config.appBaseUrl}/dashboard`, "#00c48c", "Go to Dashboard"), "#00c48c"
    );
    background(sendEmail(email, "Subscription Activated ✓", html));
}

export function sendPaymentRejectedEmail(name: string, email: string, reason: string | null): void {
    const reasonNote = reason && reason.trim()
        ? `<p style='margin:0 0 16px;padding:12px 16px;background:#fef2f2;border-left:3px solid #f43f5e;border-radius:8px;font-size:13px;color:#7f1d1d;'><strong>Reason:</strong> ${esc(reason)}</p>`
        : "";
    const html = buildSimpleEmailHtml(
        "Payment Verification Failed", name,
        "We couldn't verify the payment you submitted. Please double-check the details and resubmit from the Subscription page in your dashboard.",
        reasonNote + btn(`${config.appBaseUrl}/dashboard/subscription`, "#4f6ef7", "Resubmit Payment"), "#f43f5e"
    );
    background(sendEmail(email, "Payment Verification Failed", html));
}

export function sendStaffCredentialsChangedEmail(
    name: string, email: string, clinicName: string, emailChanged: boolean, passwordChanged: boolean
): void {
    const changed = emailChanged && passwordChanged ? "login email and password" : emailChanged ? "login email" : "password";
    const html = buildSimpleEmailHtml(
        "Your Login Details Changed", name,
        `${esc(clinicName)} updated your ${changed} for Mindesk` +
            (emailChanged ? `, so sign in with <strong>${esc(email)}</strong> from now on` : "") +
            ". Any devices you were signed in on have been signed out. " +
            "If you weren't expecting this, contact your clinic administrator.",
        btn(`${config.appBaseUrl}/login`, "#4f6ef7", "Sign In"), "#4f6ef7"
    );
    background(sendEmail(email, "Your Mindesk login details were updated", html));
}
