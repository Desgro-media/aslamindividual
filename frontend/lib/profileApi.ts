import api from './api';

// Most functions here operate on the logged-in practitioner's own account
// (/me/**). Availability, date overrides, and service pricing also accept an
// optional trailing `staffId` — when a clinic owner passes their own staff
// member's id, the call is redirected to /staff/{staffId}/** instead, which
// is ownership-checked server-side (see StaffAvailabilityController). This
// lets the exact same UI components manage either "my own" schedule or a
// clinic owner managing a staff member's schedule on their behalf.

// mode is optional — omit it for the mode-agnostic manual-scheduling flows
// that haven't been updated to collect it yet; the backend defaults to
// OFFLINE server-side. staffId is optional like the rest of this file — pass
// a clinic owner's chosen staff member's id to read THEIR calendar instead
// of the caller's own (see StaffAvailabilityController.getStaffSlots).
// durationMinutes is optional — pass the session length being booked and only
// start times where a session that long fits without colliding with another
// appointment come back.
export const getMySlots = async (date: string, mode?: 'ONLINE' | 'OFFLINE', staffId?: number, durationMinutes?: number): Promise<string[]> => {
    const qs = `date=${date}${mode ? `&mode=${mode}` : ''}${durationMinutes ? `&duration=${durationMinutes}` : ''}`;
    const res = await api.get(staffId ? `/staff/${staffId}/slots?${qs}` : `/me/slots?${qs}`);
    return res.data;
};

// ── Doctor Services & Pricing ───────────────────────────────────────────────

export interface DoctorServicePrice {
    id: number | null;
    clinicServiceId: number;
    serviceName: string;
    serviceDescription: string;
    serviceDuration: string;
    serviceIcon: string;
    onlinePrice: number | null;
    offlinePrice: number | null;
    onlineOffered: boolean;
    offlineOffered: boolean;
}

export const getMyServices = async (staffId?: number): Promise<DoctorServicePrice[]> => {
    const res = await api.get(staffId ? `/staff/${staffId}/services` : '/me/services');
    return res.data;
};

export const saveMyServices = async (services: {
    clinicServiceId: number;
    onlinePrice: number;
    offlinePrice: number;
    onlineOffered: boolean;
    offlineOffered: boolean;
}[], staffId?: number): Promise<DoctorServicePrice[]> => {
    const res = await api.put(staffId ? `/staff/${staffId}/services` : '/me/services', services);
    return res.data;
};

// ── Availability Blocks ─────────────────────────────────────────────────────

export interface AvailabilityBlock {
    id: number;
    dayOfWeek: string;
    startTime: string; // "09:00"
    endTime: string;   // "11:00"
    intervalMinutes: number;
    mode: 'ONLINE' | 'OFFLINE';
}

// Returns blocks for BOTH calendars in one call, each tagged with `mode` —
// group/filter client-side per the active Settings tab rather than
// refetching per tab switch.
export const getAvailabilityBlocks = async (staffId?: number): Promise<Record<string, AvailabilityBlock[]>> => {
    const res = await api.get(staffId ? `/staff/${staffId}/availability-blocks` : '/me/availability-blocks');
    return res.data;
};

export const addAvailabilityBlocks = async (
    daysOfWeek: string[],
    startTime: string,
    endTime: string,
    intervalMinutes: number,
    mode: 'ONLINE' | 'OFFLINE',
    staffId?: number
): Promise<AvailabilityBlock[]> => {
    const res = await api.post(staffId ? `/staff/${staffId}/availability-blocks` : '/me/availability-blocks', {
        daysOfWeek, startTime, endTime, intervalMinutes, mode,
    });
    return res.data;
};

export const removeAvailabilityBlock = async (blockId: number, staffId?: number): Promise<void> => {
    await api.delete(staffId ? `/staff/${staffId}/availability-blocks/${blockId}` : `/me/availability-blocks/${blockId}`);
};

// Scoped by mode — clearing one calendar's day never touches the other.
export const clearDayBlocks = async (dayOfWeek: string, mode: 'ONLINE' | 'OFFLINE', staffId?: number): Promise<void> => {
    const base = staffId ? `/staff/${staffId}` : '/me';
    await api.delete(`${base}/availability-blocks/day/${dayOfWeek}?mode=${mode}`);
};

// ── Date Overrides ───────────────────────────────────────────────────────────

export interface DateOverride {
    id: number;
    specificDate: string;
    slotTime: string | null;
    available: boolean;
    // null = applies to both calendars (whole-day leave/holiday only —
    // any override with a slotTime must carry an explicit mode).
    mode: 'ONLINE' | 'OFFLINE' | null;
}

export const getDateOverrides = async (staffId?: number): Promise<DateOverride[]> => {
    const res = await api.get(staffId ? `/staff/${staffId}/date-overrides` : '/me/date-overrides');
    return res.data;
};

export const addDateOverride = async (
    data: { specificDate: string; slotTime?: string; available: boolean; mode?: 'ONLINE' | 'OFFLINE' },
    staffId?: number
): Promise<DateOverride> => {
    const res = await api.post(staffId ? `/staff/${staffId}/date-overrides` : '/me/date-overrides', data);
    return res.data;
};

export const removeDateOverride = async (overrideId: number, staffId?: number): Promise<void> => {
    await api.delete(staffId ? `/staff/${staffId}/date-overrides/${overrideId}` : `/me/date-overrides/${overrideId}`);
};

// ── Profile ──────────────────────────────────────────────────────────────────

export interface MyProfile {
    id: number;
    username: string;
    name: string;
    slug: string;
    jobTitle: string | null;
    bio: string | null;
    bookable: boolean;
    profileImageUrl: string | null;
}

export const getMyProfile = async (): Promise<MyProfile> => {
    const res = await api.get('/me/profile');
    return res.data;
};

export const updateMyProfile = async (data: { bio?: string; bookable?: boolean; profileImageUrl?: string }): Promise<MyProfile> => {
    const res = await api.patch('/me/profile', data);
    return res.data;
};

// ── Bank Accounts ───────────────────────────────────────────────────────────

export interface BankAccount {
    id: number;
    accountName: string;
    bankName: string | null;
    accountNumber: string | null;
    ifscCode: string | null;
    upiId: string | null;
    qrCodeBase64: string | null;
    isDefault: boolean;
    active: boolean;
}

export const getBankAccounts = async (): Promise<BankAccount[]> => {
    const res = await api.get('/bank-accounts');
    return res.data;
};

export const createBankAccount = async (data: Partial<BankAccount>): Promise<BankAccount> => {
    const res = await api.post('/bank-accounts', data);
    return res.data;
};

export const updateBankAccount = async (id: number, data: Partial<BankAccount>): Promise<BankAccount> => {
    const res = await api.put(`/bank-accounts/${id}`, data);
    return res.data;
};

export const setDefaultBankAccount = async (id: number): Promise<void> => {
    await api.patch(`/bank-accounts/${id}/set-default`);
};

export const deleteBankAccount = async (id: number): Promise<void> => {
    await api.delete(`/bank-accounts/${id}`);
};
