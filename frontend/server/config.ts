// Runtime configuration — every value is read lazily from process.env so the
// same build runs unchanged on Vercel, in `next dev`, and in scripts. The names
// are deliberately identical to the ones the old Spring Boot backend used
// (JWT_SECRET, RESEND_API_KEY, SUPERADMIN_EMAIL, ...), so an existing
// .env / Vercel project only needs DATABASE_URL added.

const PLACEHOLDER_SECRET = "CHANGE_ME_generate_a_real_256bit_secret_before_deploying";
const MIN_SECRET_BYTES = 32; // 256 bits — HS256's minimum key size

function str(name: string, fallback = ""): string {
    const v = process.env[name];
    return v === undefined || v === "" ? fallback : v;
}

export const config = {
    get databaseUrl(): string {
        // Vercel's Postgres/Neon integrations inject POSTGRES_URL; a hand-made
        // setup uses DATABASE_URL. Either works.
        return str("DATABASE_URL") || str("POSTGRES_URL") || str("POSTGRES_PRISMA_URL");
    },
    get dbPoolMax(): number {
        return Number(str("DB_POOL_MAX", "5")) || 5;
    },
    get jwtSecret(): string {
        return str("JWT_SECRET");
    },
    get jwtExpirationMs(): number {
        return Number(str("JWT_EXPIRATION", "28800000")) || 28800000;
    },
    get appBaseUrl(): string {
        return str("APP_BASE_URL", "http://localhost:3001").replace(/\/+$/, "");
    },
    // The practice runs on India time. All "today"/"now" decisions (is this
    // slot already past, which day is a holiday, what timestamp gets stored)
    // are made in this zone — the old backend pinned the JVM to the same one.
    get timezone(): string {
        return str("APP_TIMEZONE", "Asia/Kolkata");
    },
    get superadminEmail(): string {
        return str("SUPERADMIN_EMAIL");
    },
    get superadminPassword(): string {
        return str("SUPERADMIN_PASSWORD");
    },
    get superadminIpAllowlist(): string {
        return str("SUPERADMIN_IP_ALLOWLIST");
    },
    get resendApiKey(): string {
        return str("RESEND_API_KEY");
    },
    get resendFromEmail(): string {
        return str("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    },
    get twilioAccountSid(): string {
        return str("TWILIO_ACCOUNT_SID");
    },
    get twilioAuthToken(): string {
        return str("TWILIO_AUTH_TOKEN");
    },
    get twilioPhoneNumber(): string {
        return str("TWILIO_PHONE_NUMBER");
    },
    get twilioWhatsappNumber(): string {
        return str("TWILIO_WHATSAPP_NUMBER");
    },
    get telegramBotToken(): string {
        return str("TELEGRAM_BOT_TOKEN");
    },
    get telegramWebhookSecret(): string {
        return str("TELEGRAM_WEBHOOK_SECRET");
    },
    get chatBaseUrl(): string {
        return str("AI_BASE_URL", "https://integrate.api.nvidia.com");
    },
    get chatApiKey(): string {
        return str("AI_API_KEY");
    },
    get chatModel(): string {
        return str("AI_MODEL", "mistralai/mistral-medium-3.5-128b");
    },
    get platformUpiId(): string {
        return str("PLATFORM_UPI_ID");
    },
    get platformUpiQrBase64(): string {
        return str("PLATFORM_UPI_QR_BASE64");
    },
    get allowedOrigins(): string[] {
        return str("ALLOWED_ORIGINS")
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean);
    },
    // Vercel Functions reject request bodies over 4.5 MB, and attachments travel
    // as base64 inside JSON (~33% bigger), so ~3 MB of file is the real ceiling
    // on that platform. Raise it only when self-hosting.
    get maxAttachmentBytes(): number {
        return Number(str("MAX_ATTACHMENT_BYTES", String(3 * 1024 * 1024))) || 3 * 1024 * 1024;
    },
};

// Fails the first request outright on a misconfigured deploy, rather than
// silently signing tokens with a guessable secret. (Mirrors the old
// JwtUtil.validateSecret.)
export function validateJwtSecret(): void {
    const secret = config.jwtSecret;
    if (!secret || secret === PLACEHOLDER_SECRET) {
        throw new Error(
            "JWT_SECRET is not set (or is still the placeholder). Generate a real one, " +
                "e.g. `openssl rand -base64 64`, and set it as the JWT_SECRET environment variable."
        );
    }
    if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
        throw new Error("JWT_SECRET is too short — it must be at least 256 bits (32 bytes).");
    }
}
