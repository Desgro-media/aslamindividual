package com.patientbook.service;

import java.time.LocalTime;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Single home for everything that reasons about "how long is a session" so the
// booking, editing, slot-listing and availability-block paths can't drift apart.
// A session's length is never stored on its own — it is simply
// (endTime - startTime) on the Appointment — so every path that writes an
// endTime must go through endOf() below.
public final class SessionDurations {

    public static final int MIN_MINUTES = 15;
    public static final int MAX_MINUTES = 240;
    public static final int DEFAULT_MINUTES = 60;

    private static final int MINUTES_PER_DAY = 24 * 60;

    // "1 hr", "1.5 hours", "1h30m" — unit must not be followed by another letter
    // (a plain \b would fail on "1h30m" because 'h' and '3' are both word chars).
    private static final Pattern HOURS = Pattern.compile("(\\d+(?:\\.\\d+)?)\\s*(?:hours|hour|hrs|hr|h)(?![a-z])");
    private static final Pattern MINUTES = Pattern.compile("(\\d+(?:\\.\\d+)?)\\s*(?:minutes|minute|mins|min|m)(?![a-z])");
    private static final Pattern BARE_NUMBER = Pattern.compile("(\\d+(?:\\.\\d+)?)");

    private SessionDurations() {}

    public static boolean isValid(int minutes) {
        return minutes >= MIN_MINUTES && minutes <= MAX_MINUTES;
    }

    // For a length supplied by a client (the doctor's pick in the UI). Anything
    // outside the supported range is rejected rather than silently clamped, so a
    // typo never turns into a different booking than the one the doctor saw.
    public static int requireValid(int minutes) {
        if (!isValid(minutes)) {
            throw new IllegalArgumentException(
                    "Session length must be between " + MIN_MINUTES + " and " + MAX_MINUTES + " minutes");
        }
        return minutes;
    }

    // ClinicService.duration is free text typed on the Services page ("50 min",
    // "1 hr", "1.5 hours"). The old parse just stripped non-digits, so "1 hr"
    // became 1 minute and "1.5 hours" became 15. Falls back to the default when
    // the text can't be understood or lands outside the supported range.
    public static int parseServiceDuration(String text) {
        if (text == null || text.isBlank()) return DEFAULT_MINUTES;
        String s = text.trim().toLowerCase();

        double total = 0;
        boolean found = false;
        Matcher h = HOURS.matcher(s);
        if (h.find()) { total += Double.parseDouble(h.group(1)) * 60; found = true; }
        Matcher m = MINUTES.matcher(s);
        if (m.find()) { total += Double.parseDouble(m.group(1)); found = true; }
        if (!found) {
            Matcher n = BARE_NUMBER.matcher(s);
            if (n.find()) { total = Double.parseDouble(n.group(1)); found = true; }
        }
        if (!found) return DEFAULT_MINUTES;

        long minutes = Math.round(total);
        return isValid((int) Math.min(minutes, Integer.MAX_VALUE)) ? (int) minutes : DEFAULT_MINUTES;
    }

    // start + minutes, refusing anything that would wrap past midnight.
    // LocalTime.plusMinutes wraps silently (23:30 + 60 -> 00:30), which would
    // leave endTime < startTime and make every overlap check below wrong.
    public static LocalTime endOf(LocalTime start, int minutes) {
        int startMinute = start.getHour() * 60 + start.getMinute();
        if (startMinute + minutes >= MINUTES_PER_DAY) {
            throw new IllegalArgumentException(
                    "A session can't run past midnight — choose an earlier start time or a shorter session length.");
        }
        return start.plusMinutes(minutes);
    }

    // Whole minutes from start to end; <= 0 for a placeholder/zero-length row
    // (e.g. a demo-call request, which stores 00:00–00:00 until it's scheduled).
    public static int minutesBetween(LocalTime start, LocalTime end) {
        if (start == null || end == null) return 0;
        return (end.getHour() * 60 + end.getMinute()) - (start.getHour() * 60 + start.getMinute());
    }

    // Half-open interval overlap: back-to-back sessions (one ends 10:00, the
    // next starts 10:00) do NOT overlap.
    public static boolean overlaps(LocalTime aStart, LocalTime aEnd, LocalTime bStart, LocalTime bEnd) {
        return aStart.isBefore(bEnd) && bStart.isBefore(aEnd);
    }
}
