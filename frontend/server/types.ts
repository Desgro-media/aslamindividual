// Row shapes (camelCased column names) for every table. `string` columns that
// hold dates/times are the raw Postgres text — see db.ts.

export type AccountType = "INDIVIDUAL" | "CLINIC";

export const Roles = {
    PSYCHOLOGIST: "ROLE_PSYCHOLOGIST",
    RECEPTIONIST: "ROLE_RECEPTIONIST",
    STAFF: "ROLE_STAFF",
    SUPERADMIN: "ROLE_SUPERADMIN",
} as const;

export interface AppUser {
    id: number;
    bio: string | null;
    bookable: boolean;
    createdAt: string | null;
    jobTitle: string | null;
    name: string | null;
    password: string;
    profileImageUrl: string | null;
    role: string;
    slug: string | null;
    updatedAt: string | null;
    username: string;
    accountType: AccountType | null;
    permissions: string | null;
    tenantId: number | null;
    enabled: boolean;
    phone: string | null;
    credentialsChangedAt: string | null;
}

export type CaseStatus = "NEW_CASE" | "ONGOING" | "PERIODIC_FOLLOW_UP" | "TERMINATED" | "DROPPED";
export const CASE_STATUSES: CaseStatus[] = ["NEW_CASE", "ONGOING", "PERIODIC_FOLLOW_UP", "TERMINATED", "DROPPED"];

export interface Patient {
    id: number;
    additionalNotes: string | null;
    createdAt: string | null;
    email: string | null;
    name: string;
    phone: string;
    primaryPsychologistId: number;
    riskFlag: boolean;
    riskFlaggedAt: string | null;
    riskReason: string | null;
    source: string;
    telegramChatId: string | null;
    updatedAt: string | null;
    assignedDoctorId: number | null;
    caseStatus: CaseStatus;
    caseStatusUpdatedAt: string | null;
    caseStatusReason: string | null;
}

export interface Appointment {
    id: number;
    appointmentDate: string;
    cancellationReason: string | null;
    createdAt: string | null;
    endTime: string;
    feedback: string | null;
    googleCalendarEventId: string | null;
    notes: string | null;
    paymentScreenshotBase64: string | null;
    previousAppointmentId: number | null;
    psychologistId: number;
    rating: number | null;
    sessionType: string | null;
    startTime: string;
    status: string;
    trackingToken: string;
    updatedAt: string | null;
    patientId: number;
    assignedDoctorId: number | null;
    mode: string | null;
}

export interface ClinicService {
    id: number;
    active: boolean;
    createdAt: string | null;
    description: string | null;
    displayOrder: number;
    duration: string;
    fee: number | null;
    icon: string | null;
    name: string;
    psychologistId: number;
    updatedAt: string | null;
    category: string;
}

export interface ClinicSettings {
    id: number;
    address: string | null;
    bankAccountName: string | null;
    clinicName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    demoCallNumber: string | null;
    doctorName: string | null;
    paymentQrCodeUrl: string | null;
    psychologistId: number;
}

export interface ClinicHoliday {
    id: number;
    holidayDate: string;
    psychologistId: number;
    reason: string | null;
}

export interface BankAccount {
    id: number;
    accountName: string | null;
    accountNumber: string | null;
    active: boolean;
    bankName: string | null;
    ifscCode: string | null;
    isDefault: boolean;
    psychologistId: number;
    qrCodeBase64: string | null;
    upiId: string | null;
}

export interface DoctorServicePrice {
    id: number;
    clinicServiceId: number;
    psychologistId: number;
    offlineOffered: boolean;
    offlinePrice: number | null;
    onlineOffered: boolean;
    onlinePrice: number | null;
}

export interface AvailabilityBlock {
    id: number;
    dayOfWeek: string;
    endTime: string;
    intervalMinutes: number;
    startTime: string;
    psychologistId: number;
    mode: string | null;
}

export interface DateOverride {
    id: number;
    available: boolean;
    slotTime: string | null;
    specificDate: string;
    psychologistId: number;
    mode: string | null;
}

export interface WeeklySlot {
    id: number;
    active: boolean;
    dayOfWeek: string;
    slotTime: string;
    psychologistId: number;
    mode: string | null;
}

export interface Invoice {
    id: number;
    amount: number;
    bankAccountId: number | null;
    bankAccountName: string | null;
    createdAt: string | null;
    discountAmount: number | null;
    discountReason: string | null;
    paidAt: string | null;
    paymentMethod: string | null;
    psychologistId: number;
    remark: string | null;
    status: string;
    updatedAt: string | null;
    appointmentId: number;
    patientId: number;
    paymentHandledBy: string;
    version: number;
}

export interface InvoicePayment {
    id: number;
    amount: number;
    bankAccountId: number | null;
    bankAccountName: string | null;
    collectedByStaffId: number | null;
    createdAt: string | null;
    paidAt: string;
    paymentMethod: string | null;
    remark: string | null;
    invoiceId: number;
}

export interface Lead {
    id: number;
    appointmentId: number | null;
    convertedAt: string | null;
    createdAt: string | null;
    email: string | null;
    name: string;
    notes: string | null;
    patientId: number | null;
    phone: string;
    practitionerId: number;
    status: string;
    updatedAt: string | null;
}

export interface MoodLog {
    id: number;
    createdAt: string | null;
    logDate: string;
    moodScore: number;
    note: string | null;
    psychologistId: number;
    appointmentId: number | null;
    patientId: number;
}

export interface PatientAttachment {
    id: number;
    fileData: string;
    fileName: string;
    fileSize: number;
    fileType: string;
    psychologistId: number;
    uploadedAt: string | null;
    patientId: number;
}

export interface PaymentSubmission {
    id: number;
    amountClaimed: number | null;
    createdAt: string | null;
    psychologistId: number;
    reviewNote: string | null;
    reviewedAt: string | null;
    reviewedByAdminId: number | null;
    screenshotBase64: string | null;
    status: string;
    upiTransactionRef: string;
    version: number;
}

export interface SessionNote {
    id: number;
    assessment: string | null;
    content: string | null;
    createdAt: string | null;
    objective: string | null;
    plan: string | null;
    psychologistId: number;
    subjective: string | null;
    updatedAt: string | null;
    appointmentId: number;
    patientId: number;
}

export interface StaffAttendance {
    id: number;
    date: string;
    loginTime: string;
    logoutTime: string | null;
    workMinutes: number | null;
    staffId: number;
}

export interface Subscription {
    id: number;
    amount: number | null;
    createdAt: string | null;
    currentPeriodEnd: string | null;
    plan: string | null;
    psychologistId: number;
    status: string;
    trialEndDate: string | null;
    trialStartDate: string | null;
    updatedAt: string | null;
    currentPeriodStart: string | null;
}

export interface FollowUp {
    id: number;
    psychologistId: number;
    patientId: number;
    doctorId: number | null;
    sourceAppointmentId: number | null;
    dueDate: string;
    dueTime: string | null;
    note: string | null;
    status: "PENDING" | "BOOKED" | "DONE" | "CANCELLED";
    appointmentId: number | null;
    createdBy: number | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface CaseStatusLog {
    id: number;
    psychologistId: number;
    patientId: number;
    appointmentId: number | null;
    changedBy: number | null;
    fromStatus: CaseStatus | null;
    toStatus: CaseStatus;
    reason: string | null;
    createdAt: string | null;
}
