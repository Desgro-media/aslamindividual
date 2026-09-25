package com.patientbook.service;

import com.patientbook.dto.AppointmentDto;
import com.patientbook.dto.BookingRequest;
import com.patientbook.dto.ConvertDemoRequest;
import com.patientbook.dto.DemoBookingRequest;
import com.patientbook.dto.InvoiceDto;
import com.patientbook.dto.ManualBookingRequest;
import com.patientbook.dto.RebookRequestDto;
import com.patientbook.entity.Appointment;
import com.patientbook.entity.AppUser;
import com.patientbook.entity.Patient;
import com.patientbook.repository.AppointmentRepository;
import com.patientbook.repository.AppUserRepository;
import com.patientbook.repository.ClinicServiceRepository;
import com.patientbook.repository.MoodLogRepository;
import com.patientbook.repository.NotificationLogRepository;
import com.patientbook.repository.PatientRepository;
import com.patientbook.repository.SessionNoteRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class AppointmentService {

    private final AppointmentRepository appointmentRepository;
    private final PatientRepository patientRepository;
    private final NotificationService notificationService;
    private final AppUserRepository userRepository;
    private final DoctorAvailabilityService doctorAvailabilityService;
    private final ClinicServiceRepository clinicServiceRepository;
    private final StaffResolutionService staffResolutionService;
    private final SubscriptionService subscriptionService;
    private final LeadService leadService;

    @Lazy
    @Autowired
    private InvoiceService invoiceService;

    @Autowired
    private com.patientbook.repository.InvoiceRepository invoiceRepository;

    @Autowired
    private com.patientbook.repository.InvoicePaymentRepository invoicePaymentRepository;

    @Autowired
    private NotificationLogRepository notificationLogRepository;

    @Autowired
    private SessionNoteRepository sessionNoteRepository;

    @Autowired
    private MoodLogRepository moodLogRepository;

    // ── Book a new appointment (public, via a practitioner's own booking link) ──
    @Transactional
    public AppointmentDto bookAppointment(BookingRequest request) {
        AppUser owner = userRepository.findBySlugAndRole(request.getSlug(), com.patientbook.security.Roles.PSYCHOLOGIST)
                .orElseThrow(() -> new ResourceNotFoundException("No such booking link"));
        requireAcceptingBookings(owner.getId());
        // Validates request.getStaffId() belongs to this clinic and is
        // actually bookable before trusting it — this is what stops a client
        // from booking against a practitioner in a different clinic (the
        // read-side staff/services/slots endpoints in PublicController use
        // the same validator, so both sides agree on who's bookable).
        Long assignedDoctorId = staffResolutionService.resolveBookableDoctorId(owner, request.getStaffId());
        // A public booking never gets a custom length or deferred payment —
        // those are practitioner-only decisions (see scheduleManually).
        return bookAppointmentForOwner(request, owner.getId(), assignedDoctorId, null, false);
    }

    // A lapsed subscription blocks new bookings from reaching this
    // practitioner (both the public booking form and the demo-call request),
    // same as it blocks their own dashboard — see SubscriptionAccessFilter.
    // Deliberately NOT applied to scheduleManually/bookAppointmentForOwner:
    // that path is already unreachable while lapsed since it sits behind the
    // authenticated dashboard API, which SubscriptionAccessFilter gates
    // directly; duplicating the check there would be redundant.
    private void requireAcceptingBookings(Long tenantId) {
        if (!subscriptionService.isAccessAllowed(tenantId)) {
            throw new IllegalStateException("This practitioner isn't currently accepting new bookings.");
        }
    }

    // ── Manual scheduling from the dashboard ───────────────────────────────
    @Transactional
    public AppointmentDto scheduleManually(ManualBookingRequest request, Long tenantId, Long callerOwnId) {
        Long assignedDoctorId = staffResolutionService.resolveTenantStaffId(tenantId, callerOwnId, request.getStaffId());

        BookingRequest booking = new BookingRequest();
        booking.setPatientName(request.getPatientName());
        booking.setPatientEmail(request.getPatientEmail());
        booking.setPatientPhone(request.getPatientPhone());
        booking.setAppointmentDate(request.getAppointmentDate());
        booking.setStartTime(request.getStartTime());
        booking.setSessionType(request.getSessionType());
        booking.setNotes(request.getNotes());
        booking.setMode(request.getMode());

        // Only meaningful here — the therapist explicitly chose "pass to
        // receptionist" instead of the patient paying online.
        boolean toReception = "RECEPTION".equals(request.getPaymentHandledBy());
        return bookAppointmentForOwner(booking, tenantId, assignedDoctorId, request.getDurationMinutes(), toReception);
    }

    // requestedDurationMinutes: the practitioner's chosen session length, or
    // null to use the selected service's own length. Only ever non-null from
    // the authenticated dashboard path (or a rebook carrying over the original
    // appointment's length) — never from a public request body.
    @Transactional
    public AppointmentDto bookAppointmentForOwner(BookingRequest request, Long tenantId, Long assignedDoctorId,
                                                  Integer requestedDurationMinutes, boolean toReception) {

        // 1. Find or create patient (identified by phone, scoped to this tenant —
        // shared across every staff member in a clinic)
        // Normalize email: treat blank string as null to avoid unique-constraint collisions
        String normalizedEmail = (request.getPatientEmail() != null && !request.getPatientEmail().isBlank())
                ? request.getPatientEmail().trim() : null;

        Patient patient = patientRepository.findByPhoneAndPrimaryPsychologistId(request.getPatientPhone(), tenantId)
                .orElseGet(() -> {
                    Patient newPatient = Patient.builder()
                            .name(request.getPatientName())
                            .email(normalizedEmail)
                            .phone(request.getPatientPhone())
                            .primaryPsychologistId(tenantId)
                            .build();
                    return patientRepository.save(newPatient);
                });

        // 2. Determine session duration — the practitioner's explicit pick if
        // there is one, else the selected service's own length (default 60).
        // The service catalog is tenant-wide, so that lookup is keyed by tenantId.
        int slotDuration = requestedDurationMinutes != null
                ? SessionDurations.requireValid(requestedDurationMinutes)
                : resolveSessionDurationMinutes(request.getSessionType(), tenantId);

        // 2b. Resolve + validate mode against what this doctor actually
        // offers, BEFORE anything is persisted — fail closed rather than
        // create the appointment and risk mischarging it. Also closes the
        // trust boundary on a client-supplied sessionType the assigned
        // doctor never opted into at all (see
        // DoctorAvailabilityService.resolveBookablePrice — never trust a
        // client-supplied mode/service combo without this check).
        String mode = request.getMode() != null ? request.getMode() : "OFFLINE";
        if (request.getSessionType() != null) {
            try {
                Long serviceId = Long.parseLong(request.getSessionType());
                doctorAvailabilityService.resolveBookablePrice(tenantId, assignedDoctorId, serviceId, mode);
            } catch (NumberFormatException ignored) {
                // sessionType is a legacy name string, not a service id — nothing to validate
            }
        }

        // 2c. Reject if this exact slot was just taken by another booking —
        // the client's earlier slot fetch only reflects availability at
        // fetch time, and this is a same-transaction, authoritative check
        // right before the row is inserted. Deliberately mode-agnostic —
        // one physical doctor can't run two sessions at once regardless of
        // channel, see DoctorAvailabilityService's slot-conflict note.
        // The practitioner row is locked first so two simultaneous requests
        // for the same doctor can't both pass this check and both insert.
        LocalTime newEndTime = SessionDurations.endOf(request.getStartTime(), slotDuration);
        userRepository.findByIdForUpdate(assignedDoctorId);
        assertSlotFree(assignedDoctorId, request.getAppointmentDate(), request.getStartTime(), newEndTime, null,
                "This slot was just booked — please choose another time.");

        // 3. Generate a unique 25-char tracking token
        String trackingToken = UUID.randomUUID().toString().replace("-", "").substring(0, 25);

        // 4. Link to the patient's last active session for journey tracking
        List<Appointment> previousActive = appointmentRepository.findMostRecentActiveByPatientId(patient.getId());
        Long previousAppointmentId = previousActive.isEmpty() ? null : previousActive.get(0).getId();

        // toReception (param) is only ever true from manual dashboard
        // scheduling — the therapist explicitly chose "pass to receptionist"
        // instead of the patient paying online. It is a method parameter, not
        // a field of the request body, so a public booking can never set it.

        // 5. Build and save the appointment
        Appointment appointment = Appointment.builder()
                .patient(patient)
                .appointmentDate(request.getAppointmentDate())
                .startTime(request.getStartTime())
                .endTime(newEndTime)
                // A walk-in passed to reception is happening regardless of
                // when the balance gets settled — confirm it immediately and
                // track the money independently via Invoice.status, rather
                // than gating confirmation on payment like the self-pay path.
                .status(toReception ? "CONFIRMED" : "AWAITING_PAYMENT")
                .trackingToken(trackingToken)
                .sessionType(request.getSessionType())
                .mode(mode)
                .notes(request.getNotes())
                .previousAppointmentId(previousAppointmentId)
                .psychologistId(tenantId)
                .assignedDoctorId(assignedDoctorId)
                .build();

        appointment = appointmentRepository.save(appointment);

        // 5b. If this contact submitted the public booking form's first step
        // as a lead, this booking is that lead converting — flip it rather
        // than leave it dangling. No-op for every other path here (manual
        // dashboard scheduling, rebooking) that never had a lead to begin
        // with. See LeadService.convertLead.
        leadService.convertLead(request.getPatientPhone(), tenantId, patient.getId(), appointment.getId());

        // 6. Create invoice — uses per-doctor, per-mode pricing
        InvoiceDto invoice = invoiceService.createInvoiceForAppointment(
                appointment.getId(), null, toReception ? "RECEPTION" : "SELF");

        // Extract data BEFORE transaction ends — prevents lazy-load in async thread
        String patientName  = patient.getName();
        String patientEmail = patient.getEmail();
        String patientPhone = patient.getPhone();
        String apptDate     = appointment.getAppointmentDate().toString();
        String apptTime     = appointment.getStartTime().toString();
        String token        = appointment.getTrackingToken();

        // Free service, or payment explicitly deferred to reception — the
        // appointment is already confirmed, just notify. Otherwise (fee > 0,
        // self-pay) it stays AWAITING_PAYMENT until the patient pays online,
        // so send the payment link instead — sending that link to someone
        // reception is expected to collect cash from in person would open a
        // second, unwatched payment channel on the same invoice.
        if (toReception || invoice.getAmount() == null || invoice.getAmount().compareTo(BigDecimal.ZERO) == 0) {
            if (!"CONFIRMED".equals(appointment.getStatus())) {
                appointment.setStatus("CONFIRMED");
                appointment = appointmentRepository.save(appointment);
            }
            notificationService.sendBookingApproved(patientName, patientEmail, patientPhone, apptDate, apptTime, token);
        } else {
            notificationService.sendPaymentLink(patientName, patientEmail, patientPhone, apptDate, apptTime, token);
        }

        return mapToDto(appointment);
    }

    // ── Track appointment by token ─────────────────────────────────────────
    public AppointmentDto getAppointmentByToken(String token) {
        Appointment appointment = appointmentRepository.findByTrackingToken(token)
                .orElseThrow(() -> new ResourceNotFoundException("Appointment not found for token: " + token));
        return mapToDto(appointment);
    }

    // ── Rebook a cancelled appointment ─────────────────────────────────────
    @Transactional
    public AppointmentDto rebookAppointment(String token, RebookRequestDto request) {
        Appointment oldAppointment = appointmentRepository.findByTrackingToken(token)
                .orElseThrow(() -> new ResourceNotFoundException("Appointment not found"));

        if (!"CANCELLED".equals(oldAppointment.getStatus())) {
            throw new IllegalStateException("Only CANCELLED appointments can be rebooked");
        }

        BookingRequest newRequest = new BookingRequest();
        newRequest.setPatientName(oldAppointment.getPatient().getName());
        newRequest.setPatientEmail(oldAppointment.getPatient().getEmail());
        newRequest.setPatientPhone(oldAppointment.getPatient().getPhone());
        newRequest.setAppointmentDate(request.getNewAppointmentDate());
        newRequest.setStartTime(request.getNewStartTime());
        newRequest.setSessionType(oldAppointment.getSessionType());
        newRequest.setMode(oldAppointment.getMode());
        newRequest.setNotes(oldAppointment.getNotes());

        // Tenant AND the specific practitioner are both carried over from the
        // existing (already-verified) appointment, not re-derived from client
        // input — a rebook must land back with the same doctor, not silently
        // fall back to the clinic owner. The session length is carried over
        // too: the practitioner may have set it for this specific booking, and
        // a patient rebooking after a cancellation shouldn't quietly reset it
        // to the service default. (Server-derived from the stored appointment,
        // never from the request body.)
        Long carriedAssignedDoctorId = oldAppointment.getAssignedDoctorId() != null
                ? oldAppointment.getAssignedDoctorId() : oldAppointment.getPsychologistId();
        int originalMinutes = SessionDurations.minutesBetween(oldAppointment.getStartTime(), oldAppointment.getEndTime());
        Integer carriedDuration = SessionDurations.isValid(originalMinutes) ? originalMinutes : null;
        return bookAppointmentForOwner(newRequest, oldAppointment.getPsychologistId(), carriedAssignedDoctorId,
                carriedDuration, false);
    }

    // ── Get appointments for a practitioner (always scoped to the caller) ──
    public List<AppointmentDto> getAppointmentsByPsychologist(Long psychologistId) {
        return appointmentRepository.findByPsychologistId(psychologistId).stream()
                .map(this::mapToDto)
                .collect(Collectors.toList());
    }

    // ── Update appointment status (confirm / cancel / complete) ───────────
    @Transactional
    public AppointmentDto updateAppointmentStatus(Long id, Long ownerId, String status, String cancellationReason, BigDecimal fee) {
        Appointment appointment = appointmentRepository.findByIdAndPsychologistId(id, ownerId)
                .orElseThrow(() -> new ResourceNotFoundException("Appointment not found: " + id));

        appointment.setStatus(status);

        if ("CANCELLED".equals(status) && cancellationReason != null) {
            appointment.setCancellationReason(cancellationReason);
        }

        appointment = appointmentRepository.save(appointment);

        String patientName  = appointment.getPatient().getName();
        String patientEmail = appointment.getPatient().getEmail();
        String patientPhone = appointment.getPatient().getPhone();
        String apptDate     = appointment.getAppointmentDate() != null ? appointment.getAppointmentDate().toString() : "TBD";
        String apptTime     = appointment.getStartTime() != null ? appointment.getStartTime().toString() : "TBD";
        String token        = appointment.getTrackingToken();
        String reason       = appointment.getCancellationReason();
        Long   apptId       = appointment.getId();

        if ("AWAITING_PAYMENT".equals(status)) {
            InvoiceDto inv = invoiceService.createInvoiceForAppointment(apptId, fee);
            if (inv.getAmount() == null || inv.getAmount().compareTo(BigDecimal.ZERO) == 0) {
                appointment.setStatus("CONFIRMED");
                appointment = appointmentRepository.save(appointment);
                notificationService.sendBookingApproved(patientName, patientEmail, patientPhone, apptDate, apptTime, token);
            } else {
                notificationService.sendPaymentLink(patientName, patientEmail, patientPhone, apptDate, apptTime, token);
            }
        } else if ("CONFIRMED".equals(status)) {
            try {
                invoiceService.markAppointmentInvoiceAsPaid(apptId, "MANUAL_TRANSFER");
            } catch (Exception ignored) {}
            notificationService.sendBookingApproved(patientName, patientEmail, patientPhone, apptDate, apptTime, token);
        } else if ("CANCELLED".equals(status)) {
            notificationService.sendBookingCancelled(patientName, patientEmail, patientPhone, apptDate, apptTime, token, reason);
        } else if ("COMPLETED".equals(status)) {
            invoiceService.createInvoiceForAppointment(apptId);
        }

        return mapToDto(appointment);
    }

    @Transactional
    public AppointmentDto reportPaymentMade(String token, String paymentScreenshotBase64) {
        Appointment appointment = appointmentRepository.findByTrackingToken(token)
                .orElseThrow(() -> new ResourceNotFoundException("Appointment not found"));

        if (!"AWAITING_PAYMENT".equals(appointment.getStatus()) && !"PENDING".equals(appointment.getStatus())) {
            throw new IllegalStateException("Appointment is not awaiting payment");
        }

        appointment.setStatus("PAYMENT_UNDER_REVIEW");
        appointment.setPaymentScreenshotBase64(paymentScreenshotBase64);
        appointment = appointmentRepository.save(appointment);

        return mapToDto(appointment);
    }

    @Transactional
    public AppointmentDto updateAppointmentNotes(Long id, Long ownerId, String notes) {
        Appointment appointment = appointmentRepository.findByIdAndPsychologistId(id, ownerId)
                .orElseThrow(() -> new ResourceNotFoundException("Appointment not found: " + id));
        appointment.setNotes(notes);
        appointment = appointmentRepository.save(appointment);
        return mapToDto(appointment);
    }

    @Transactional(readOnly = true)
    public List<AppointmentDto> getAppointmentsByPatientIdAndPsychologist(Long patientId, Long psychologistId) {
        return appointmentRepository.findByPatientIdAndPsychologistId(patientId, psychologistId)
                .stream()
                .map(this::mapToDto)
                .collect(Collectors.toList());
    }

    @Transactional
    public AppointmentDto submitRating(String token, Integer rating, String feedback) {
        Appointment appointment = appointmentRepository.findByTrackingToken(token)
                .orElseThrow(() -> new ResourceNotFoundException("Invalid tracking token."));

        if (!"COMPLETED".equals(appointment.getStatus())) {
            throw new IllegalStateException("Only completed sessions can be rated.");
        }

        appointment.setRating(rating);
        appointment.setFeedback(feedback);
        appointment = appointmentRepository.save(appointment);
        return mapToDto(appointment);
    }

    // ── Request a demo call (public, via a practitioner's own link) ───────
    @Transactional
    public AppointmentDto requestDemoCall(DemoBookingRequest request) {
        AppUser owner = userRepository.findBySlugAndRole(request.getSlug(), com.patientbook.security.Roles.PSYCHOLOGIST)
                .orElseThrow(() -> new ResourceNotFoundException("No such booking link"));
        requireAcceptingBookings(owner.getId());

        String demoEmail = (request.getPatientEmail() != null && !request.getPatientEmail().isBlank())
                ? request.getPatientEmail().trim() : null;
        Patient patient = patientRepository.findByPhoneAndPrimaryPsychologistId(request.getPatientPhone(), owner.getId())
                .orElseGet(() -> patientRepository.save(Patient.builder()
                        .name(request.getPatientName())
                        .email(demoEmail)
                        .phone(request.getPatientPhone())
                        .primaryPsychologistId(owner.getId())
                        .build()));

        String trackingToken = UUID.randomUUID().toString().replace("-", "").substring(0, 25);

        String combinedNotes = request.getPreferredTime() != null && !request.getPreferredTime().isBlank()
                ? "Preferred time: " + request.getPreferredTime()
                  + (request.getNotes() != null && !request.getNotes().isBlank() ? "\n" + request.getNotes() : "")
                : request.getNotes();

        Appointment appointment = Appointment.builder()
                .patient(patient)
                .status("DEMO_CALL_PENDING")
                .trackingToken(trackingToken)
                .sessionType(request.getServiceInterest())
                .notes(combinedNotes)
                .appointmentDate(java.time.LocalDate.of(1970, 1, 1))
                .startTime(java.time.LocalTime.MIDNIGHT)
                .endTime(java.time.LocalTime.MIDNIGHT)
                .psychologistId(owner.getId())
                .build();

        return mapToDto(appointmentRepository.save(appointment));
    }

    // ── Convert a demo call to a real appointment ──────────────────────────
    @Transactional
    public AppointmentDto convertDemoToAppointment(Long id, Long tenantId, ConvertDemoRequest request) {
        Appointment appointment = appointmentRepository.findByIdAndPsychologistId(id, tenantId)
                .orElseThrow(() -> new ResourceNotFoundException("Appointment not found: " + id));

        if (!"DEMO_CALL_PENDING".equals(appointment.getStatus())) {
            throw new IllegalStateException("Only demo call requests can be converted to appointments");
        }

        int slotDuration = resolveSessionDurationMinutes(request.getSessionType(), tenantId);
        Long assignedDoctorId = staffResolutionService.resolveTenantStaffId(tenantId, tenantId, request.getStaffId());

        String resolvedSessionType = (request.getSessionType() != null && !request.getSessionType().isBlank())
                ? request.getSessionType() : appointment.getSessionType();
        String mode = request.getMode() != null ? request.getMode() : "OFFLINE";
        if (resolvedSessionType != null) {
            try {
                Long serviceId = Long.parseLong(resolvedSessionType);
                doctorAvailabilityService.resolveBookablePrice(tenantId, assignedDoctorId, serviceId, mode);
            } catch (NumberFormatException ignored) {
                // resolvedSessionType is a legacy name string (e.g. a demo call's serviceInterest), not a service id
            }
        }

        appointment.setAppointmentDate(request.getAppointmentDate());
        appointment.setStartTime(request.getStartTime());
        appointment.setEndTime(SessionDurations.endOf(request.getStartTime(), slotDuration));
        appointment.setSessionType(resolvedSessionType);
        appointment.setMode(mode);
        appointment.setAssignedDoctorId(assignedDoctorId);
        appointment.setStatus("AWAITING_PAYMENT");
        appointment = appointmentRepository.save(appointment);

        InvoiceDto invoice = invoiceService.createInvoiceForAppointment(appointment.getId());

        String patientName  = appointment.getPatient().getName();
        String patientEmail = appointment.getPatient().getEmail();
        String patientPhone = appointment.getPatient().getPhone();
        String apptDate     = appointment.getAppointmentDate().toString();
        String apptTime     = appointment.getStartTime().toString();
        String token        = appointment.getTrackingToken();

        if (invoice.getAmount() == null || invoice.getAmount().compareTo(BigDecimal.ZERO) == 0) {
            appointment.setStatus("CONFIRMED");
            appointment = appointmentRepository.save(appointment);
            notificationService.sendBookingApproved(patientName, patientEmail, patientPhone, apptDate, apptTime, token);
        } else {
            notificationService.sendPaymentLink(patientName, patientEmail, patientPhone, apptDate, apptTime, token);
        }

        return mapToDto(appointment);
    }

    // ── Delete an appointment ──────────────────────────────────────────────
    @Transactional
    public void deleteAppointment(Long id, Long ownerId) {
        if (!appointmentRepository.existsByIdAndPsychologistId(id, ownerId)) {
            throw new ResourceNotFoundException("Appointment not found: " + id);
        }
        notificationLogRepository.deleteByAppointmentId(id);
        sessionNoteRepository.deleteByAppointmentId(id);
        moodLogRepository.deleteByAppointmentId(id);
        invoicePaymentRepository.deleteByInvoice_Appointment_Id(id);
        invoiceRepository.deleteByAppointmentId(id);
        appointmentRepository.deleteById(id);
    }

    // ── Update appointment details ─────────────────────────────────────────
    // durationMinutes: the practitioner's new session length, or null to keep
    // whatever the appointment already has. This used to recompute the end
    // time from the service's default length whenever a start time was sent —
    // and the dashboard's edit form always sends one — so any edit, even
    // fixing a typo in the notes, silently reset a custom session length.
    @Transactional
    public AppointmentDto updateAppointmentDetails(Long id, Long ownerId, LocalDate date, LocalTime startTime,
                                                    String sessionType, String notes, String mode,
                                                    Integer durationMinutes) {
        Appointment appt = appointmentRepository.findByIdAndPsychologistId(id, ownerId)
                .orElseThrow(() -> new ResourceNotFoundException("Appointment not found: " + id));
        if (mode != null && !"ONLINE".equals(mode) && !"OFFLINE".equals(mode)) {
            throw new IllegalArgumentException("Mode must be ONLINE or OFFLINE");
        }

        if (date != null || startTime != null || durationMinutes != null) {
            LocalDate newDate = date != null ? date : appt.getAppointmentDate();
            LocalTime newStart = startTime != null ? startTime : appt.getStartTime();
            int currentMinutes = SessionDurations.minutesBetween(appt.getStartTime(), appt.getEndTime());
            int minutes;
            if (durationMinutes != null) {
                minutes = SessionDurations.requireValid(durationMinutes);
            } else if (SessionDurations.isValid(currentMinutes)) {
                minutes = currentMinutes; // keep the length the practitioner already set
            } else {
                // Placeholder/corrupt row (e.g. a demo-call request, stored 00:00–00:00):
                // there is no real length to keep, so fall back to the service's.
                minutes = resolveSessionDurationMinutes(sessionType != null ? sessionType : appt.getSessionType(), ownerId);
            }
            LocalTime newEnd = SessionDurations.endOf(newStart, minutes);

            // Only re-check the calendar if the occupied range actually moved —
            // a notes-only save on a row that already overlaps something (legacy
            // data) must not start failing.
            boolean rangeChanged = !newDate.equals(appt.getAppointmentDate())
                    || !newStart.equals(appt.getStartTime()) || !newEnd.equals(appt.getEndTime());
            if (rangeChanged && !"CANCELLED".equals(appt.getStatus())) {
                Long doctorId = appt.getAssignedDoctorId() != null ? appt.getAssignedDoctorId() : appt.getPsychologistId();
                userRepository.findByIdForUpdate(doctorId);
                assertSlotFree(doctorId, newDate, newStart, newEnd, appt.getId(),
                        "That time overlaps another session on this doctor's calendar — choose a different time or a shorter session length.");
            }
            appt.setAppointmentDate(newDate);
            appt.setStartTime(newStart);
            appt.setEndTime(newEnd);
        }
        if (sessionType != null) appt.setSessionType(sessionType);
        if (mode != null) appt.setMode(mode);
        if (notes != null) appt.setNotes(notes);
        return mapToDto(appointmentRepository.save(appt));
    }

    // ── Record a past session (always under the caller's own tenant) ──────
    @Transactional
    public AppointmentDto recordPastSession(Long patientId, Long tenantId, Long callerOwnId, Long requestedStaffId,
                                            LocalDate date, LocalTime time,
                                            String sessionType, String notes, String status, String mode,
                                            Integer durationMinutes) {
        Patient patient = patientRepository.findByIdAndPrimaryPsychologistId(patientId, tenantId)
                .orElseThrow(() -> new ResourceNotFoundException("Patient not found: " + patientId));
        if (mode != null && !"ONLINE".equals(mode) && !"OFFLINE".equals(mode)) {
            throw new IllegalArgumentException("Mode must be ONLINE or OFFLINE");
        }

        int slotDuration = durationMinutes != null
                ? SessionDurations.requireValid(durationMinutes)
                : resolveSessionDurationMinutes(sessionType, tenantId);
        String resolvedStatus = (status != null && !status.isBlank()) ? status : "COMPLETED";
        Long assignedDoctorId = staffResolutionService.resolveTenantStaffId(tenantId, callerOwnId, requestedStaffId);

        // This records something that already happened, potentially under a
        // service/mode combo the doctor no longer offers today — no
        // resolveBookablePrice validation here (unlike live booking); the
        // invoice-creation call below already degrades gracefully to a
        // zero fee if the combo can't be resolved, same as an unparseable
        // sessionType.
        Appointment appt = Appointment.builder()
                .patient(patient)
                .appointmentDate(date)
                .startTime(time)
                .endTime(SessionDurations.endOf(time, slotDuration))
                .status(resolvedStatus)
                .sessionType(sessionType)
                .mode(mode != null ? mode : "OFFLINE")
                .notes(notes)
                .trackingToken(UUID.randomUUID().toString().replace("-", "").substring(0, 25))
                .psychologistId(tenantId)
                .assignedDoctorId(assignedDoctorId)
                .build();

        appt = appointmentRepository.save(appt);
        invoiceService.createInvoiceForAppointment(appt.getId());
        return mapToDto(appt);
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    // The selected service's own length (its free-text duration, e.g. "50 min",
    // "1 hr", "1.5 hours"); default 60. This is only the DEFAULT — the
    // practitioner can override it per appointment.
    private int resolveSessionDurationMinutes(String sessionType, Long ownerId) {
        if (sessionType == null) return SessionDurations.DEFAULT_MINUTES;
        try {
            Long serviceId = Long.parseLong(sessionType);
            return clinicServiceRepository.findByIdAndPsychologistId(serviceId, ownerId)
                    .map(s -> SessionDurations.parseServiceDuration(s.getDuration()))
                    .orElse(SessionDurations.DEFAULT_MINUTES);
        } catch (NumberFormatException ignored) {
            return SessionDurations.DEFAULT_MINUTES;
        }
    }

    // Authoritative calendar-conflict check for one practitioner on one date.
    // `excludeAppointmentId` lets an edit ignore the appointment being moved.
    // Mode-agnostic on purpose (one person can't run two sessions at once) and
    // keyed by the specific practitioner, not the tenant, so two doctors in the
    // same clinic can be booked at the same time.
    private void assertSlotFree(Long doctorId, LocalDate date, LocalTime start, LocalTime end,
                                Long excludeAppointmentId, String conflictMessage) {
        boolean overlaps = appointmentRepository.findByAppointmentDateAndAssignedDoctorId(date, doctorId)
                .stream()
                .filter(a -> !"CANCELLED".equals(a.getStatus()))
                .filter(a -> excludeAppointmentId == null || !excludeAppointmentId.equals(a.getId()))
                .anyMatch(a -> SessionDurations.overlaps(start, end, a.getStartTime(), a.getEndTime()));
        if (overlaps) {
            throw new IllegalStateException(conflictMessage);
        }
    }

    public AppointmentDto mapToDto(Appointment appointment) {
        boolean returningPatient = appointment.getPreviousAppointmentId() != null;

        AppUser owner = userRepository.findById(appointment.getPsychologistId()).orElse(null);
        String psychologistName = owner != null ? owner.getName() : null;
        String psychologistSlug = owner != null ? owner.getSlug() : null;

        // Which specific practitioner this appointment is with — falls back
        // to the tenant owner for pre-assignedDoctorId rows (should only
        // happen in the brief window before StartupInitializer's backfill).
        Long assignedDoctorId = appointment.getAssignedDoctorId() != null
                ? appointment.getAssignedDoctorId() : appointment.getPsychologistId();
        AppUser assignedDoctor = assignedDoctorId.equals(appointment.getPsychologistId())
                ? owner : userRepository.findById(assignedDoctorId).orElse(null);
        String assignedDoctorName = assignedDoctor != null ? assignedDoctor.getName() : null;
        String assignedDoctorJobTitle = assignedDoctor != null ? assignedDoctor.getJobTitle() : null;

        return AppointmentDto.builder()
                .id(appointment.getId())
                .patientId(appointment.getPatient().getId())
                .patientName(appointment.getPatient().getName())
                .patientEmail(appointment.getPatient().getEmail())
                .patientPhone(appointment.getPatient().getPhone())
                .appointmentDate(appointment.getAppointmentDate())
                .startTime(appointment.getStartTime())
                .endTime(appointment.getEndTime())
                .status(appointment.getStatus())
                .trackingToken(appointment.getTrackingToken())
                .cancellationReason(appointment.getCancellationReason())
                .sessionType(appointment.getSessionType())
                .mode(appointment.getMode() != null ? appointment.getMode() : "OFFLINE")
                .notes(appointment.getNotes())
                .rating(appointment.getRating())
                .feedback(appointment.getFeedback())
                .telegramConnected(appointment.getPatient().getTelegramChatId() != null
                        && !appointment.getPatient().getTelegramChatId().isEmpty())
                .fee(invoiceRepository.findByAppointmentId(appointment.getId())
                        .map(com.patientbook.entity.Invoice::getAmount).orElse(null))
                .paymentScreenshotBase64(appointment.getPaymentScreenshotBase64())
                .previousAppointmentId(appointment.getPreviousAppointmentId())
                .returningPatient(returningPatient)
                .psychologistId(appointment.getPsychologistId())
                .psychologistName(psychologistName)
                .psychologistSlug(psychologistSlug)
                .assignedDoctorId(assignedDoctorId)
                .assignedDoctorName(assignedDoctorName)
                .assignedDoctorJobTitle(assignedDoctorJobTitle)
                .build();
    }
}
