import type { Db } from "../db";
import { JsonObject, badRequest, notFound } from "../http";
import { today } from "../time";
import { MoodLog, SessionNote } from "../types";

// ── SOAP session notes ───────────────────────────────────────────────────────

export interface SessionNoteDto {
    id: number; appointmentId: number; patientId: number; content: string | null;
    subjective: string | null; objective: string | null; assessment: string | null; plan: string | null;
    createdAt: string | null; updatedAt: string | null;
}

const toDto = (n: SessionNote): SessionNoteDto => ({
    id: n.id, appointmentId: n.appointmentId, patientId: n.patientId, content: n.content,
    subjective: n.subjective, objective: n.objective, assessment: n.assessment, plan: n.plan,
    createdAt: n.createdAt, updatedAt: n.updatedAt,
});

const str = (body: JsonObject, key: string): string | null => {
    const v = body[key];
    return v === undefined || v === null ? null : String(v);
};

/** Create or update the SOAP note for an appointment (own tenant only). Fields not sent are left alone. */
export async function saveNote(db: Db, appointmentId: number, ownerId: number, body: JsonObject): Promise<SessionNoteDto> {
    const appt = await db.one<{ id: number; patientId: number }>(
        "SELECT id, patient_id FROM appointment WHERE id = $1 AND psychologist_id = $2", [appointmentId, ownerId]);
    if (!appt) throw notFound(`Appointment not found: ${appointmentId}`);

    const fields = {
        subjective: str(body, "subjective"), objective: str(body, "objective"),
        assessment: str(body, "assessment"), plan: str(body, "plan"),
        content: str(body, "content"), // legacy plain content (fallback)
    };
    const existing = await db.one<SessionNote>(
        "SELECT * FROM session_note WHERE appointment_id = $1 AND psychologist_id = $2", [appointmentId, ownerId]);
    if (existing) {
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== null) patch[k] = v;
        return toDto(await db.update<SessionNote>("session_note", existing.id, patch));
    }
    return toDto(await db.insert<SessionNote>("session_note", {
        psychologistId: ownerId, appointmentId: appt.id, patientId: appt.patientId, ...fields,
    }));
}

export async function getNoteByAppointment(db: Db, appointmentId: number, ownerId: number): Promise<SessionNoteDto | null> {
    const n = await db.one<SessionNote>(
        "SELECT * FROM session_note WHERE appointment_id = $1 AND psychologist_id = $2", [appointmentId, ownerId]);
    return n ? toDto(n) : null;
}

export async function getNotesByPatient(db: Db, patientId: number, ownerId: number): Promise<SessionNoteDto[]> {
    const rows = await db.many<SessionNote>(
        "SELECT * FROM session_note WHERE patient_id = $1 AND psychologist_id = $2 ORDER BY created_at DESC, id DESC", [patientId, ownerId]);
    return rows.map(toDto);
}

export async function deleteNote(db: Db, noteId: number, ownerId: number): Promise<void> {
    await db.exec("DELETE FROM session_note WHERE id = $1 AND psychologist_id = $2", [noteId, ownerId]);
}

// ── Mood check-ins ───────────────────────────────────────────────────────────

export interface MoodLogDto {
    id: number; patientId: number; appointmentId: number | null; moodScore: number; note: string | null;
    logDate: string; createdAt: string | null;
}

const toMoodDto = (m: MoodLog): MoodLogDto => ({
    id: m.id, patientId: m.patientId, appointmentId: m.appointmentId, moodScore: m.moodScore, note: m.note,
    logDate: m.logDate, createdAt: m.createdAt,
});

/** Public: a patient submits their mood via the tracking token (re-submitting updates the same row). */
export async function submitMoodLog(db: Db, trackingToken: string, moodScore: number, note: string | null): Promise<MoodLogDto> {
    if (moodScore < 1 || moodScore > 10) throw badRequest("Mood score must be between 1 and 10");
    const appt = await db.one<{ id: number; patientId: number; psychologistId: number }>(
        "SELECT id, patient_id, psychologist_id FROM appointment WHERE tracking_token = $1", [trackingToken]);
    if (!appt) throw notFound(`Appointment not found for token: ${trackingToken}`);

    const existing = await db.one<MoodLog>("SELECT * FROM mood_log WHERE appointment_id = $1", [appt.id]);
    if (existing) return toMoodDto(await db.update<MoodLog>("mood_log", existing.id, { moodScore, note }));
    return toMoodDto(await db.insert<MoodLog>("mood_log", {
        psychologistId: appt.psychologistId, appointmentId: appt.id, patientId: appt.patientId,
        moodScore, note, logDate: today(),
    }));
}

export async function getMoodLogsByPatient(db: Db, patientId: number, ownerId: number): Promise<MoodLogDto[]> {
    const rows = await db.many<MoodLog>(
        "SELECT * FROM mood_log WHERE patient_id = $1 AND psychologist_id = $2 ORDER BY log_date ASC, id ASC", [patientId, ownerId]);
    return rows.map(toMoodDto);
}

export async function getMoodLogByAppointment(db: Db, appointmentId: number, ownerId: number): Promise<MoodLogDto | null> {
    const m = await db.one<MoodLog>("SELECT * FROM mood_log WHERE appointment_id = $1 AND psychologist_id = $2", [appointmentId, ownerId]);
    return m ? toMoodDto(m) : null;
}
