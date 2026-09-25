package com.patientbook.service;

import org.junit.jupiter.api.Test;

import java.time.LocalTime;

import static org.junit.jupiter.api.Assertions.*;

class SessionDurationsTest {

    @Test
    void parsesPlainMinuteStrings() {
        assertEquals(50, SessionDurations.parseServiceDuration("50 min"));
        assertEquals(80, SessionDurations.parseServiceDuration("80 minutes"));
        assertEquals(45, SessionDurations.parseServiceDuration("45"));
    }

    // The old parser stripped every non-digit, so "1 hr" came out as 1 minute
    // and "1.5 hours" as 15.
    @Test
    void parsesHourStringsInsteadOfStrippingDigits() {
        assertEquals(60, SessionDurations.parseServiceDuration("1 hr"));
        assertEquals(90, SessionDurations.parseServiceDuration("1.5 hours"));
        assertEquals(120, SessionDurations.parseServiceDuration("2 hrs"));
        assertEquals(90, SessionDurations.parseServiceDuration("1h30m"));
        assertEquals(90, SessionDurations.parseServiceDuration("1 hr 30 min"));
    }

    @Test
    void unusableOrOutOfRangeDurationsFallBackToDefault() {
        assertEquals(SessionDurations.DEFAULT_MINUTES, SessionDurations.parseServiceDuration(null));
        assertEquals(SessionDurations.DEFAULT_MINUTES, SessionDurations.parseServiceDuration("  "));
        assertEquals(SessionDurations.DEFAULT_MINUTES, SessionDurations.parseServiceDuration("varies"));
        assertEquals(SessionDurations.DEFAULT_MINUTES, SessionDurations.parseServiceDuration("0 min"));
        assertEquals(SessionDurations.DEFAULT_MINUTES, SessionDurations.parseServiceDuration("5 min"));
        assertEquals(SessionDurations.DEFAULT_MINUTES, SessionDurations.parseServiceDuration("99999999999 min"));
        assertEquals(SessionDurations.DEFAULT_MINUTES, SessionDurations.parseServiceDuration("10 hrs"));
    }

    @Test
    void requireValidEnforcesRange() {
        assertEquals(15, SessionDurations.requireValid(15));
        assertEquals(240, SessionDurations.requireValid(240));
        assertThrows(IllegalArgumentException.class, () -> SessionDurations.requireValid(14));
        assertThrows(IllegalArgumentException.class, () -> SessionDurations.requireValid(241));
        assertThrows(IllegalArgumentException.class, () -> SessionDurations.requireValid(0));
        assertThrows(IllegalArgumentException.class, () -> SessionDurations.requireValid(-30));
    }

    @Test
    void endOfAddsMinutes() {
        assertEquals(LocalTime.of(10, 30), SessionDurations.endOf(LocalTime.of(9, 0), 90));
        assertEquals(LocalTime.of(23, 59), SessionDurations.endOf(LocalTime.of(22, 59), 60));
    }

    // LocalTime.plusMinutes wraps silently (23:30 + 60 -> 00:30), which would
    // store endTime < startTime and break every overlap check.
    @Test
    void endOfRejectsSessionsThatWouldPassMidnight() {
        assertThrows(IllegalArgumentException.class, () -> SessionDurations.endOf(LocalTime.of(23, 30), 60));
        assertThrows(IllegalArgumentException.class, () -> SessionDurations.endOf(LocalTime.of(22, 0), 120)); // ends exactly 24:00
    }

    @Test
    void backToBackSessionsDoNotOverlap() {
        LocalTime nine = LocalTime.of(9, 0), ten = LocalTime.of(10, 0), eleven = LocalTime.of(11, 0);
        assertFalse(SessionDurations.overlaps(nine, ten, ten, eleven));
        assertFalse(SessionDurations.overlaps(ten, eleven, nine, ten));
    }

    @Test
    void overlappingAndContainedSessionsAreDetected() {
        LocalTime nine = LocalTime.of(9, 0);
        LocalTime nineThirty = LocalTime.of(9, 30);
        LocalTime ten = LocalTime.of(10, 0);
        LocalTime tenThirty = LocalTime.of(10, 30);
        assertTrue(SessionDurations.overlaps(nine, tenThirty, ten, LocalTime.of(11, 0)));   // 9:00-10:30 vs 10:00-11:00
        assertTrue(SessionDurations.overlaps(nine, LocalTime.of(11, 0), nineThirty, ten));  // fully contained
        assertTrue(SessionDurations.overlaps(nine, ten, nine, ten));                        // identical
    }

    @Test
    void minutesBetweenHandlesPlaceholderRows() {
        assertEquals(90, SessionDurations.minutesBetween(LocalTime.of(9, 0), LocalTime.of(10, 30)));
        assertEquals(0, SessionDurations.minutesBetween(LocalTime.MIDNIGHT, LocalTime.MIDNIGHT));
        assertEquals(0, SessionDurations.minutesBetween(null, LocalTime.NOON));
    }
}
