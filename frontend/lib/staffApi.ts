import api from "./api";

export interface StaffMember {
    id: number;
    name: string;
    username: string;
    jobTitle: string | null;
    role: string; // ROLE_PSYCHOLOGIST | ROLE_RECEPTIONIST | ROLE_STAFF
    permissions: string[];
    bio: string | null;
    bookable: boolean;
    profileImageUrl: string | null;
    enabled: boolean;
    createdAt: string;
}

export interface AttendanceRecord {
    id: number;
    staffId: number;
    staffName: string;
    staffUsername: string;
    staffJobTitle: string | null;
    loginTime: string;
    logoutTime: string | null;
    workMinutes: number | null;
    date: string;
}

export interface CreateStaffPayload {
    name: string;
    username: string;
    password: string;
    jobTitle?: string;
    role: string;
    permissions: string[];
    bio?: string;
    bookable?: boolean;
    profileImageUrl?: string;
}

export type UpdateStaffPayload = Partial<Omit<CreateStaffPayload, "username">>;

export const getAllStaff = () => api.get<StaffMember[]>("/staff").then(r => r.data);

export const createStaff = (payload: CreateStaffPayload) =>
    api.post<StaffMember>("/staff", payload).then(r => r.data);

export const updateStaff = (id: number, payload: UpdateStaffPayload) =>
    api.put<StaffMember>(`/staff/${id}`, payload).then(r => r.data);

export const updatePermissions = (id: number, permissions: string[]) =>
    api.put<StaffMember>(`/staff/${id}/permissions`, permissions).then(r => r.data);

// Sign-in details. Send only the field being changed — an omitted/blank one is
// left alone server-side, so setting a new password can't silently rewrite the
// login email. This is the only way a staff password is ever changed: staff
// have no self-service reset — nobody in this product does.
// Both changes sign the staff member out of any devices they're logged in on.
export const updateStaffCredentials = (id: number, payload: { username?: string; password?: string }) =>
    api.patch<StaffMember>(`/staff/${id}/credentials`, payload).then(r => r.data);

// Deactivates (reversible) — see StaffService.deactivateStaff. Blocks login and
// public bookability without losing historical appointment/invoice/note
// attribution. For permanent removal see deleteStaff below.
export const deactivateStaff = (id: number) =>
    api.delete<StaffMember>(`/staff/${id}`).then(r => r.data);

// Permanent removal (see StaffService.deleteStaff): the login and the person's own
// schedule/pricing are deleted; past sessions, notes and invoices stay but lose the
// doctor's name. The server refuses while they still have upcoming sessions.
export const deleteStaff = (id: number) =>
    api.delete(`/staff/${id}`, { params: { permanent: true } }).then(() => undefined);

export const reactivateStaff = (id: number) =>
    api.post<StaffMember>(`/staff/${id}/reactivate`).then(r => r.data);

export const getAllAttendance = () => api.get<AttendanceRecord[]>("/staff/attendance").then(r => r.data);

export const getActiveStaff = () => api.get<AttendanceRecord[]>("/staff/attendance/active").then(r => r.data);

export const getAttendanceByDate = (date: string) =>
    api.get<AttendanceRecord[]>(`/staff/attendance/date/${date}`).then(r => r.data);

export const getAttendanceForStaff = (staffId: number) =>
    api.get<AttendanceRecord[]>(`/staff/attendance/staff/${staffId}`).then(r => r.data);
