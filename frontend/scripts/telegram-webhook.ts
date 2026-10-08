// Points your Telegram bot at this deployment's webhook (Telegram pushes updates
// instead of the old backend polling for them). Run once after deploying:
//   APP_BASE_URL=https://your-app.vercel.app npm run telegram:webhook
import "./_env";

async function main() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const base = process.env.APP_BASE_URL;
    if (!token || !base) {
        console.error("Set TELEGRAM_BOT_TOKEN and APP_BASE_URL first.");
        process.exit(1);
    }
    const url = `${base.replace(/\/+$/, "")}/api/v1/telegram/webhook`;
    const body: Record<string, string> = { url };
    if (process.env.TELEGRAM_WEBHOOK_SECRET) body.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    console.log(res.status, await res.text());
}

main();
