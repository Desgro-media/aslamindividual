package com.patientbook.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalTime;

@Data
public class BookingRequest {
    @NotBlank
    @Size(max = 150)
    private String patientName;

    @Email
    @Size(max = 150)
    private String patientEmail;

    @NotBlank
    @Size(max = 30)
    private String patientPhone;

    @NotNull
    private LocalDate appointmentDate;

    @NotNull
    private LocalTime startTime;

    // Optional fields from the booking wizard
    @Size(max = 30)
    private String sessionType; // service ID as string
    @Size(max = 2000)
    private String notes;       // Patient's optional message / reason for visit

    // ONLINE or OFFLINE — which calendar/price this booking used. Null is
    // treated as OFFLINE server-side (old cached clients, or callers that
    // predate this feature, e.g. record-past-session). Always re-validated
    // against the resolved doctor's actual offerings before it's trusted,
    // never taken at face value — see AppointmentService.bookAppointmentForOwner.
    @Pattern(regexp = "ONLINE|OFFLINE", message = "Mode must be ONLINE or OFFLINE")
    private String mode;

    // Which practitioner's public booking link this came through — the
    // server resolves this to an owner id, never trusts a raw numeric id
    // from the client.
    @NotBlank
    @Size(max = 100)
    private String slug;

    // Optional — which specific staff member (within a clinic) this booking
    // is for. Always validated server-side (see StaffResolutionService)
    // before use; never trusted as-is. Null/omitted for individual
    // practitioners and for a clinic's default/first-available booking.
    private Long staffId;

    // Manual-only options (payment deferred to reception, a custom session
    // length) live on ManualBookingRequest, NOT here: this class is the public
    // booking form's body, so anything on it is settable by an anonymous
    // visitor. paymentHandledBy used to sit here and let a patient skip
    // payment by sending "RECEPTION".
}
