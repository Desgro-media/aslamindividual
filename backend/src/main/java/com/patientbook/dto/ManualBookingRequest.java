package com.patientbook.dto;

import com.patientbook.service.SessionDurations;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalTime;

// The dashboard's "Schedule Session" request — a practitioner/staff member
// booking a slot for a patient themselves. Deliberately its own type rather
// than a reuse of BookingRequest (the PUBLIC booking form's body):
//   * BookingRequest requires a public-link `slug`, which a dashboard call has
//     no use for, so it could never be @Valid'd here and this endpoint ran
//     with no validation at all (a missing startTime was a 500 NPE, oversized
//     fields were unchecked).
//   * durationMinutes and paymentHandledBy are decisions only an authenticated
//     practitioner may make. Kept off the public DTO, an anonymous patient
//     can't supply them — previously a public booking sending
//     paymentHandledBy=RECEPTION was confirmed with no payment collected.
@Data
public class ManualBookingRequest {

    @NotBlank
    @Size(max = 150)
    private String patientName;

    // Only used to create the patient row if the phone isn't known yet; an
    // existing patient is matched by phone and their stored email is kept.
    // No @Email here on purpose — a legacy patient with a malformed stored
    // email must still be schedulable.
    @Size(max = 150)
    private String patientEmail;

    @NotBlank
    @Size(max = 30)
    private String patientPhone;

    @NotNull
    private LocalDate appointmentDate;

    @NotNull
    private LocalTime startTime;

    @Size(max = 30)
    private String sessionType; // service ID as string

    @Size(max = 2000)
    private String notes;

    @Pattern(regexp = "ONLINE|OFFLINE", message = "Mode must be ONLINE or OFFLINE")
    private String mode;

    // Optional clinic staff member — validated server-side, see StaffResolutionService.
    private Long staffId;

    // "RECEPTION" defers payment collection to the front desk; null/"SELF" is
    // the normal pay-online path. See AppointmentService.
    @Pattern(regexp = "SELF|RECEPTION", message = "Payment handler must be SELF or RECEPTION")
    private String paymentHandledBy;

    // How long this session runs, chosen by the practitioner. Optional: omitted
    // means "use the selected service's own length" (default 60).
    @Min(value = SessionDurations.MIN_MINUTES, message = "Session length must be at least 15 minutes")
    @Max(value = SessionDurations.MAX_MINUTES, message = "Session length can't be more than 240 minutes")
    private Integer durationMinutes;
}
