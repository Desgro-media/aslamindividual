import type { Db } from "../db";
import { tx } from "../db";
import { JsonObject, badRequest, isBlank, notFound, optBool } from "../http";
import { nowTs } from "../time";
import { Patient } from "../types";
import { config } from "../config";
import { resolveTenantStaffId } from "./staffResolution";

// ── Patients ─────────────────────────────────────────────────────────────────

export async function getAllPatients(db: Db, ownerId: number): Promise<Patient[]> {
    return db.many<Patient>("SELECT * FROM patient WHERE primary_psychologist_id = $1 ORDER BY id", [ownerId]);
}

export async function getPatientById(db: Db, id: number, ownerId: number): Promise<Patient> {
    const p = await db.one<Patient>("SELECT * FROM patient WHERE id = $1 AND primary_psychologist_id = $2", [id, ownerId]);
    if (!p) throw notFound("Patient not found");
    return p;
}

function asNullableString(body: JsonObject, field: string): string | null {
    const v = body[field];
    return v === undefined || v === null ? null : String(v);
}

/**
 * Create a client record from the dashboard. Only known fields are read from the
 * body — never an `id`, `primaryPsychologistId` or case status — so a crafted
 * request can't overwrite another tenant's patient or skip the workflow.
 */
export async function createPatient(db: Db, body: JsonObject, ownerId: number): Promise<Patient> {
    const name = asNullableString(body, "name");
    const phone = asNullableString(body, "phone");
    if (isBlank(name)) throw badRequest("name must not be blank");
    if (isBlank(phone)) throw badRequest("phone must not be blank");

    // Never trust a client-supplied doctor id directly — re-resolve it through
    // the tenant/role-validated path, so a client can never end up "assigned" to
    // a practitioner outside this tenant or to a non-psychologist row.
    let assignedDoctorId: number | null = null;
    if (body.assignedDoctorId !== undefined && body.assignedDoctorId !== null && body.assignedDoctorId !== "") {
        const requested = Number(body.assignedDoctorId);
        if (!Number.isInteger(requested)) throw badRequest("assignedDoctorId is invalid");
        assignedDoctorId = await resolveTenantStaffId(db, ownerId, ownerId, requested);
    }
    const source = asNullableString(body, "source");
    const riskFlag = optBool(body, "riskFlag") ?? false;
    return db.insert<Patient>("patient", {
        name,
        email: asNullableString(body, "email"),
        phone,
        riskFlag,
        riskReason: asNullableString(body, "riskReason"),
        riskFlaggedAt: riskFlag ? nowTs() : null,
        additionalNotes: asNullableString(body, "additionalNotes"),
        source: source && source.trim() ? source : "Direct",
        primaryPsychologistId: ownerId,
        assignedDoctorId,
    });
}

export async function updatePatientDetails(
    db: Db, id: number, ownerId: number, name: string | null, email: string | null, phone: string | null
): Promise<Patient> {
    await getPatientById(db, id, ownerId);
    return db.update<Patient>("patient", id, {
        name: name !== null && name.trim() ? name.trim() : undefined,
        email: email !== null ? (email.trim() === "" ? null : email.trim()) : undefined,
        phone: phone !== null && phone.trim() ? phone.trim() : undefined,
    });
}

export async function updateRiskFlag(db: Db, id: number, ownerId: number, riskFlag: boolean, riskReason: string | null): Promise<Patient> {
    await getPatientById(db, id, ownerId);
    return db.update<Patient>("patient", id, riskFlag
        ? { riskFlag: true, riskReason, riskFlaggedAt: nowTs() }
        : { riskFlag: false, riskReason: null, riskFlaggedAt: null });
}

export async function deletePatient(id: number, ownerId: number): Promise<void> {
    await tx(async (db) => {
        await getPatientById(db, id, ownerId);
        await db.exec("DELETE FROM notification_log WHERE appointment_id IN (SELECT id FROM appointment WHERE patient_id = $1)", [id]);
        await db.exec("DELETE FROM invoice_payment WHERE invoice_id IN (SELECT id FROM invoice WHERE patient_id = $1)", [id]);
        await db.exec("DELETE FROM invoice WHERE patient_id = $1", [id]);
        await db.exec("DELETE FROM mood_log WHERE patient_id = $1", [id]);
        await db.exec("DELETE FROM session_note WHERE patient_id = $1", [id]);
        await db.exec("DELETE FROM patient_attachment WHERE patient_id = $1", [id]);
        await db.exec(
            "DELETE FROM rebook_request WHERE original_appointment_id IN (SELECT id FROM appointment WHERE patient_id = $1) " +
            "OR new_appointment_id IN (SELECT id FROM appointment WHERE patient_id = $1)", [id]);
        await db.exec("DELETE FROM follow_up WHERE patient_id = $1", [id]);
        await db.exec("DELETE FROM case_status_log WHERE patient_id = $1", [id]);
        await db.exec("UPDATE appointment SET previous_appointment_id = NULL WHERE patient_id = $1", [id]);
        await db.exec("DELETE FROM appointment WHERE patient_id = $1", [id]);
        await db.exec("DELETE FROM patient WHERE id = $1", [id]);
    });
}

// ── File attachments ─────────────────────────────────────────────────────────
// Reports, scans, consent forms, referral letters. Same convention as every
// other upload in this app: the browser reads the file with
// FileReader.readAsDataURL and posts the data URL as JSON.

const EXTENSION_MIME: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", doc: "application/msword", xls: "application/vnd.ms-excel",
    ppt: "application/vnd.ms-powerpoint",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain", csv: "text/csv",
};
const EXTENSION_FAMILY: Record<string, string> = {
    pdf: "pdf", png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp",
    doc: "ole", xls: "ole", ppt: "ole", docx: "zip", xlsx: "zip", pptx: "zip", txt: "text", csv: "text",
};

export interface PatientAttachmentDto {
    id: number; patientId: number; fileName: string; fileType: string; fileSize: number; uploadedAt: string | null;
}

const toAttachmentDto = (a: { id: number; patientId: number; fileName: string; fileType: string; fileSize: number; uploadedAt: string | null }): PatientAttachmentDto => ({
    id: a.id, patientId: a.patientId, fileName: a.fileName, fileType: a.fileType, fileSize: a.fileSize, uploadedAt: a.uploadedAt,
});

function sanitizeFileName(raw: string | null): string {
    if (raw === null) return "attachment";
    let name = raw.replace(/\\/g, "/");
    const slash = name.lastIndexOf("/");
    if (slash >= 0) name = name.substring(slash + 1);
    // eslint-disable-next-line no-control-regex
    name = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (name.length > 255) name = name.substring(name.length - 255);
    return name === "" ? "attachment" : name;
}

function extensionOf(fileName: string): string | null {
    const dot = fileName.lastIndexOf(".");
    if (dot < 0 || dot === fileName.length - 1) return null;
    return fileName.substring(dot + 1).toLowerCase();
}

// Magic-byte family sniffing — the client's declared MIME is deliberately NOT trusted.
function sniffFamily(b: Buffer): string | null {
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
    if (b.length >= 6 && b.toString("latin1", 0, 4) === "GIF8" && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
    if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
    if (b.length >= 4 && b.toString("latin1", 0, 4) === "%PDF") return "pdf";
    if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) return "ole";
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return "zip";
    return null;
}

export async function uploadAttachment(
    db: Db, patientId: number, ownerId: number, rawFileName: string | null, fileDataValue: string | null
): Promise<PatientAttachmentDto> {
    await getPatientById(db, patientId, ownerId);
    if (!fileDataValue || !fileDataValue.trim()) throw badRequest("No file data provided");

    const sanitized = sanitizeFileName(rawFileName);
    const ext = extensionOf(sanitized);
    if (!ext || !(ext in EXTENSION_MIME)) {
        throw badRequest("Unsupported file type. Allowed: PDF, Word, Excel, PowerPoint, images, and text/CSV files.");
    }

    let payload = fileDataValue;
    const comma = fileDataValue.indexOf(",");
    if (fileDataValue.startsWith("data:") && comma > 0) payload = fileDataValue.substring(comma + 1);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.replace(/\s+/g, ""))) throw badRequest("File data is not valid base64");
    const decoded = Buffer.from(payload, "base64");

    if (decoded.length === 0) throw badRequest("File is empty");
    const max = config.maxAttachmentBytes;
    if (decoded.length > max) throw badRequest(`File exceeds the ${Math.floor(max / (1024 * 1024))}MB size limit`);

    const expected = EXTENSION_FAMILY[ext];
    if (expected !== "text" && sniffFamily(decoded) !== expected) {
        throw badRequest(`File content doesn't match its extension (.${ext})`);
    }

    const row = await db.one<{ id: number; patientId: number; fileName: string; fileType: string; fileSize: number; uploadedAt: string | null }>(
        `INSERT INTO patient_attachment (psychologist_id, patient_id, file_name, file_type, file_size, file_data, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, patient_id, file_name, file_type, file_size, uploaded_at`,
        [ownerId, patientId, sanitized, EXTENSION_MIME[ext], decoded.length, decoded.toString("base64"), nowTs()]
    );
    return toAttachmentDto(row!);
}

export async function getAttachments(db: Db, patientId: number, ownerId: number): Promise<PatientAttachmentDto[]> {
    // Confirms the patient belongs to this owner first — otherwise a made-up id
    // with zero attachments would silently return [] instead of 404.
    await getPatientById(db, patientId, ownerId);
    const rows = await db.many<PatientAttachmentDto>(
        `SELECT id, patient_id, file_name, file_type, file_size, uploaded_at FROM patient_attachment
          WHERE patient_id = $1 AND psychologist_id = $2 ORDER BY uploaded_at DESC, id DESC`, [patientId, ownerId]);
    return rows.map(toAttachmentDto);
}

export async function getAttachmentForDownload(
    db: Db, patientId: number, attachmentId: number, ownerId: number
): Promise<{ fileName: string; fileType: string; bytes: Buffer }> {
    const a = await db.one<{ fileName: string; fileType: string; fileData: string }>(
        "SELECT file_name, file_type, file_data FROM patient_attachment WHERE id = $1 AND patient_id = $2 AND psychologist_id = $3",
        [attachmentId, patientId, ownerId]);
    if (!a) throw notFound("Attachment not found");
    return { fileName: a.fileName, fileType: a.fileType, bytes: Buffer.from(a.fileData, "base64") };
}

export async function deleteAttachment(db: Db, patientId: number, attachmentId: number, ownerId: number): Promise<void> {
    const n = await db.exec(
        "DELETE FROM patient_attachment WHERE id = $1 AND patient_id = $2 AND psychologist_id = $3", [attachmentId, patientId, ownerId]);
    if (n === 0) throw notFound("Attachment not found");
}
