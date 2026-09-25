package com.patientbook.controller;

import com.patientbook.dto.AppointmentDto;
import com.patientbook.dto.BookingRequest;
import com.patientbook.dto.ConvertDemoRequest;
import com.patientbook.dto.DemoBookingRequest;
import com.patientbook.dto.ManualBookingRequest;
import com.patientbook.dto.RebookRequestDto;
import com.patientbook.security.CurrentUserProvider;
import com.patientbook.service.AppointmentService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;

@RestController
@RequestMapping("/api/v1")
@RequiredArgsConstructor
public class AppointmentController {

    private final AppointmentService appointmentService;
    private final CurrentUserProvider currentUserProvider;

    // ── Public endpoints ────────────────────────────────────────────────────

    @PostMapping("/appointments")
    public ResponseEntity<AppointmentDto> bookAppointment(@Valid @RequestBody BookingRequest request) {
        return ResponseEntity.ok(appointmentService.bookAppointment(request));
    }

    // ── Manual scheduling from the dashboard (the practitioner/staff booking
    // a slot for a patient themselves, not the public booking form) — always
    // under the caller's own tenant, never a client-supplied tenant. An
    // optional request.staffId picks which clinic staff member the
    // appointment is with (validated to belong to the caller's own tenant);
    // omitted, it defaults to the caller's own calendar. ──────────────────
    @PostMapping("/appointments/manual")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<AppointmentDto> scheduleManually(@Valid @RequestBody ManualBookingRequest request) {
        return ResponseEntity.ok(appointmentService.scheduleManually(
                request, currentUserProvider.getCurrentTenantId(), currentUserProvider.getCurrentUserId()));
    }

    @PostMapping("/demo-booking")
    public ResponseEntity<AppointmentDto> requestDemoCall(@Valid @RequestBody DemoBookingRequest request) {
        return ResponseEntity.ok(appointmentService.requestDemoCall(request));
    }

    @GetMapping("/track/{token}")
    public ResponseEntity<AppointmentDto> trackAppointment(@PathVariable String token) {
        return ResponseEntity.ok(appointmentService.getAppointmentByToken(token));
    }

    @PostMapping("/track/{token}/rebook")
    public ResponseEntity<AppointmentDto> rebookAppointment(
            @PathVariable String token,
            @Valid @RequestBody RebookRequestDto request) {
        return ResponseEntity.ok(appointmentService.rebookAppointment(token, request));
    }

    @PostMapping("/track/{token}/rating")
    public ResponseEntity<AppointmentDto> submitRating(
            @PathVariable String token,
            @RequestBody java.util.Map<String, Object> payload) {
        Integer rating = (Integer) payload.get("rating");
        String feedback = (String) payload.get("feedback");
        return ResponseEntity.ok(appointmentService.submitRating(token, rating, feedback));
    }

    @PostMapping("/track/{token}/report-payment")
    public ResponseEntity<AppointmentDto> reportPayment(
            @PathVariable String token,
            @RequestBody java.util.Map<String, String> payload) {
        String paymentScreenshotBase64 = payload.get("paymentScreenshotBase64");
        return ResponseEntity.ok(appointmentService.reportPaymentMade(token, paymentScreenshotBase64));
    }

    // ── Record a past session (always under the caller's own account) ─────
    @PostMapping("/appointments/past")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<AppointmentDto> recordPastSession(@RequestBody java.util.Map<String, String> body) {
        if (body.get("patientId") == null || body.get("appointmentDate") == null || body.get("startTime") == null) {
            throw new IllegalArgumentException("patientId, appointmentDate, and startTime are required");
        }
        Long patientId     = Long.parseLong(body.get("patientId"));
        LocalDate date     = LocalDate.parse(body.get("appointmentDate"));
        String timeStr     = body.get("startTime").length() == 4 ? "0" + body.get("startTime") : body.get("startTime");
        LocalTime time     = LocalTime.parse(timeStr);
        String sessionType = body.get("sessionType");
        String notes       = body.getOrDefault("notes", "");
        String status      = body.getOrDefault("status", "COMPLETED");
        String mode        = body.get("mode");
        Long staffId       = body.get("staffId") != null && !body.get("staffId").isBlank()
                ? Long.parseLong(body.get("staffId")) : null;

        Integer durationMinutes = parseOptionalMinutes(body.get("durationMinutes"));

        Long tenantId = currentUserProvider.getCurrentTenantId();
        Long callerOwnId = currentUserProvider.getCurrentUserId();
        return ResponseEntity.ok(appointmentService.recordPastSession(
                patientId, tenantId, callerOwnId, staffId, date, time, sessionType, notes, status, mode, durationMinutes));
    }

    // Blank/absent -> null ("keep / use the service default"). A non-numeric
    // value throws NumberFormatException, which GlobalExceptionHandler maps to a 400.
    private static Integer parseOptionalMinutes(String raw) {
        return raw == null || raw.isBlank() ? null : Integer.valueOf(raw.trim());
    }

    // ── Protected endpoints — always scoped to the caller's own account ───

    @GetMapping("/appointments")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<List<AppointmentDto>> getAllAppointments() {
        return ResponseEntity.ok(appointmentService.getAppointmentsByPsychologist(currentUserProvider.getCurrentTenantId()));
    }

    @PatchMapping("/appointments/{id}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<AppointmentDto> updateStatus(
            @PathVariable Long id,
            @RequestParam String status,
            @RequestParam(required = false) String cancellationReason,
            @RequestParam(required = false) BigDecimal fee) {
        return ResponseEntity.ok(appointmentService.updateAppointmentStatus(
                id, currentUserProvider.getCurrentTenantId(), status, cancellationReason, fee));
    }

    @PatchMapping("/appointments/{id}/convert")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<AppointmentDto> convertDemoToAppointment(
            @PathVariable Long id,
            @Valid @RequestBody ConvertDemoRequest request) {
        return ResponseEntity.ok(appointmentService.convertDemoToAppointment(
                id, currentUserProvider.getCurrentTenantId(), request));
    }

    @PatchMapping("/appointments/{id}/notes")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<AppointmentDto> updateNotes(
            @PathVariable Long id,
            @RequestBody java.util.Map<String, String> payload) {
        return ResponseEntity.ok(appointmentService.updateAppointmentNotes(
                id, currentUserProvider.getCurrentTenantId(), payload.get("notes")));
    }

    @DeleteMapping("/appointments/{id}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<Void> deleteAppointment(@PathVariable Long id) {
        appointmentService.deleteAppointment(id, currentUserProvider.getCurrentTenantId());
        return ResponseEntity.noContent().build();
    }

    @PatchMapping("/appointments/{id}/details")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<AppointmentDto> updateAppointmentDetails(
            @PathVariable Long id,
            @RequestBody java.util.Map<String, String> body) {
        LocalDate date     = body.get("appointmentDate") != null ? LocalDate.parse(body.get("appointmentDate")) : null;
        LocalTime time     = body.get("startTime")       != null ? LocalTime.parse(body.get("startTime"))       : null;
        String sessionType = body.get("sessionType");
        String notes       = body.get("notes");
        String mode        = body.get("mode");
        Integer durationMinutes = parseOptionalMinutes(body.get("durationMinutes"));
        return ResponseEntity.ok(appointmentService.updateAppointmentDetails(
                id, currentUserProvider.getCurrentTenantId(), date, time, sessionType, notes, mode, durationMinutes));
    }
}
