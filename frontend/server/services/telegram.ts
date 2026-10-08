import { getDb } from "../db";
import { telegramSend } from "./notifications";

// The Spring backend long-polled Telegram's getUpdates every 3 seconds from a
// @Scheduled task. A serverless function can't hold a poller, so Telegram now
// pushes updates to POST /api/v1/telegram/webhook instead (register it once with
// `npm run telegram:webhook`). The behaviour on each message is unchanged:
// `/start <tracking token>` links the patient's Telegram chat to their appointment.

interface TelegramUpdate {
    update_id?: number;
    message?: { text?: string; chat?: { id?: number } };
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    const text = update.message?.text;
    const chatIdRaw = update.message?.chat?.id;
    if (!text || chatIdRaw === undefined) return;
    const chatId = String(chatIdRaw);

    if (text.startsWith("/start ")) {
        await handleStartCommand(chatId, text.substring("/start ".length).trim());
    } else if (text === "/start") {
        await telegramSend(chatId,
            "Welcome to the Psychologist Clinic Bot! Please click the 'Get Updates on Telegram' button from your appointment tracking page to link your account.");
    }
}

async function handleStartCommand(chatId: string, token: string): Promise<void> {
    const db = getDb();
    const row = await db.one<{ patientId: number; patientName: string; appointmentDate: string; startTime: string; status: string }>(
        `SELECT p.id AS patient_id, p.name AS patient_name, a.appointment_date, a.start_time, a.status
           FROM appointment a JOIN patient p ON p.id = a.patient_id WHERE a.tracking_token = $1`, [token]);
    if (!row) {
        await telegramSend(chatId, "Sorry, I couldn't find an appointment with that tracking token.");
        return;
    }
    await db.exec("UPDATE patient SET telegram_chat_id = $1 WHERE id = $2", [chatId, row.patientId]);
    await telegramSend(chatId,
        `Hi ${row.patientName}! 👋\n\nYour Telegram is now connected. Your appointment request for ${row.appointmentDate} at ${row.startTime} is currently *${row.status}*.\n\nWe will notify you here when the status changes.`);
}
