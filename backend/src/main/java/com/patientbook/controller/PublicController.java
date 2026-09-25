package com.patientbook.controller;

import com.patientbook.dto.BankAccountDto;
import com.patientbook.dto.ClinicServiceDto;
import com.patientbook.dto.DoctorServicePriceDto;
import com.patientbook.dto.StaffPublicDto;
import com.patientbook.entity.AccountType;
import com.patientbook.entity.AppUser;
import com.patientbook.entity.ClinicHoliday;
import com.patientbook.entity.ClinicService;
import com.patientbook.entity.ClinicSettings;
import com.patientbook.entity.Lead;
import com.patientbook.dto.LeadRequest;
import com.patientbook.repository.AppUserRepository;
import com.patientbook.repository.ClinicServiceRepository;
import com.patientbook.repository.PatientRepository;
import com.patientbook.service.BankAccountService;
import com.patientbook.service.DoctorAvailabilityService;
import com.patientbook.service.LeadService;
import com.patientbook.service.ResourceNotFoundException;
import com.patientbook.service.SettingsService;
import com.patientbook.service.StaffResolutionService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

// The entire unauthenticated, patient-facing surface — every read here is
// scoped by a practitioner's public slug (never a raw numeric id), and an
// unknown slug always 404s rather than leaking whether an id exists.
@RestController
@RequestMapping("/api/v1/public/{slug}")
@RequiredArgsConstructor
public class PublicController {

    private final AppUserRepository appUserRepository;
    private final SettingsService settingsService;
    private final ClinicServiceRepository clinicServiceRepository;
    private final BankAccountService bankAccountService;
    private final DoctorAvailabilityService doctorAvailabilityService;
    private final PatientRepository patientRepository;
    private final com.patientbook.repository.ClinicHolidayRepository clinicHolidayRepository;
    private final StaffResolutionService staffResolutionService;
    private final com.patientbook.service.SubscriptionService subscriptionService;
    private final LeadService leadService;

    @GetMapping("/info")
    public ResponseEntity<Map<String, Object>> getInfo(@PathVariable String slug) {
        AppUser owner = resolveOwner(slug);
        ClinicSettings settings = settingsService.getSettings(owner.getId());

        Map<String, Object> info = new HashMap<>();
        info.put("slug", owner.getSlug());
        info.put("name", owner.getName());
        info.put("jobTitle", owner.getJobTitle());
        info.put("bio", owner.getBio());
        info.put("profileImageUrl", owner.getProfileImageUrl());
        info.put("bookable", owner.isBookable());
        // Tenant-wide billing gate, distinct from "bookable" above (which is
        // this one practitioner's personal toggle) — a clinic's whole staff
        // roster goes un-bookable together when the OWNER's subscription
        // lapses, since billing is per-tenant, not per-staff-member.
        info.put("acceptingBookings", subscriptionService.isAccessAllowed(owner.getId()));
        // INDIVIDUAL or CLINIC — tells the booking wizard whether to render a
        // practitioner-picker step. Pre-clinic-feature accounts have no
        // accountType set; treat that as INDIVIDUAL (their actual behavior).
        info.put("accountType", owner.getAccountType() != null ? owner.getAccountType().name() : AccountType.INDIVIDUAL.name());
        info.put("clinicName", settings.getClinicName());
        info.put("address", settings.getAddress());
        info.put("contactPhone", settings.getContactPhone());
        info.put("contactEmail", settings.getContactEmail());
        info.put("paymentQrCodeUrl", settings.getPaymentQrCodeUrl());
        info.put("demoCallNumber", settings.getDemoCallNumber());
        return ResponseEntity.ok(info);
    }

    // The clinic's bookable staff roster (the tenant-root row itself, if it's
    // bookable, plus every enabled+bookable staff member). For an INDIVIDUAL
    // account this is just that one practitioner — the frontend only shows a
    // picker when info.accountType === 'CLINIC', so this list is otherwise
    // unused for individuals.
    @GetMapping("/staff")
    public ResponseEntity<List<StaffPublicDto>> getBookableStaff(@PathVariable String slug) {
        AppUser owner = resolveOwner(slug);
        List<StaffPublicDto> roster = new ArrayList<>();
        if (owner.isBookable() && owner.isEnabled()) {
            roster.add(toStaffDto(owner));
        }
        appUserRepository.findByTenantIdAndRoleAndBookableTrueAndEnabledTrue(owner.getId(), com.patientbook.security.Roles.PSYCHOLOGIST)
                .forEach(staff -> roster.add(toStaffDto(staff)));
        return ResponseEntity.ok(roster);
    }

    // The full catalog (name/description/duration/fee/icon) — used by the
    // demo-call "service interest" picker.
    @GetMapping("/services/catalog")
    public ResponseEntity<List<ClinicServiceDto>> getServiceCatalog(@PathVariable String slug) {
        AppUser owner = resolveOwner(slug);
        List<ClinicServiceDto> services = clinicServiceRepository
                .findByPsychologistIdAndActiveTrueOrderByDisplayOrderAscCreatedAtAsc(owner.getId())
                .stream().map(this::toDto).collect(Collectors.toList());
        return ResponseEntity.ok(services);
    }

    // Priced/offered services for the actual booking flow. An optional
    // staffId picks a specific clinic staff member's pricing (validated to
    // belong to this tenant and be bookable); omitted, defaults to the
    // tenant owner — the only path an INDIVIDUAL booking ever takes.
    @GetMapping("/services")
    public ResponseEntity<List<DoctorServicePriceDto>> getOfferedServices(
            @PathVariable String slug, @RequestParam(required = false) Long staffId) {
        AppUser owner = resolveOwner(slug);
        Long doctorId = staffResolutionService.resolveBookableDoctorId(owner, staffId);
        return ResponseEntity.ok(doctorAvailabilityService.getDoctorOfferedServices(doctorId));
    }

    // Lets the booking calendar disable days that have no chance of a slot
    // for the selected mode, before the user even picks a date.
    @GetMapping("/availability-summary")
    public ResponseEntity<com.patientbook.dto.AvailabilitySummaryDto> getAvailabilitySummary(
            @PathVariable String slug, @RequestParam(required = false) Long staffId,
            @RequestParam(required = false) String mode) {
        AppUser owner = resolveOwner(slug);
        Long doctorId = staffResolutionService.resolveBookableDoctorId(owner, staffId);
        return ResponseEntity.ok(doctorAvailabilityService.getAvailabilitySummary(doctorId, mode));
    }

    @GetMapping("/slots")
    public ResponseEntity<List<String>> getSlots(
            @PathVariable String slug, @RequestParam LocalDate date, @RequestParam(required = false) Long staffId,
            @RequestParam(required = false) String mode) {
        AppUser owner = resolveOwner(slug);
        Long doctorId = staffResolutionService.resolveBookableDoctorId(owner, staffId);
        // Holiday/closure is a clinic-wide setting; slot-conflict is scoped
        // to the specific practitioner so two different doctors in the same
        // clinic can be booked at the same time. Booked-slot exclusion is
        // deliberately mode-agnostic (see DoctorAvailabilityService) — only
        // the open-window calendar lookup is mode-filtered. No `duration`
        // param on the public side: patients never choose the session length.
        boolean isHoliday = clinicHolidayRepository.findByHolidayDateAndPsychologistId(date, owner.getId()).isPresent();
        return ResponseEntity.ok(doctorAvailabilityService.getAvailableSlotsForDoctor(doctorId, date, isHoliday, mode, null));
    }

    @GetMapping("/holidays")
    public ResponseEntity<List<ClinicHoliday>> getHolidays(@PathVariable String slug) {
        AppUser owner = resolveOwner(slug);
        return ResponseEntity.ok(clinicHolidayRepository.findByPsychologistId(owner.getId()));
    }

    @GetMapping("/bank-accounts")
    public ResponseEntity<List<BankAccountDto>> getBankAccounts(@PathVariable String slug) {
        AppUser owner = resolveOwner(slug);
        return ResponseEntity.ok(bankAccountService.getActiveBankAccounts(owner.getId()));
    }

    // Returning-patient check on the booking form
    @GetMapping("/patients/check")
    public ResponseEntity<Map<String, Object>> checkReturningPatient(@PathVariable String slug, @RequestParam String phone) {
        AppUser owner = resolveOwner(slug);
        Map<String, Object> result = new HashMap<>();
        result.put("exists", patientRepository.findByPhoneAndPrimaryPsychologistId(phone.trim(), owner.getId()).isPresent());
        return ResponseEntity.ok(result);
    }

    // Captures a prospective client as soon as they submit the first step of
    // the booking wizard (name/email/phone/notes) — well before they've
    // picked a session or confirmed a slot. If they go on to complete the
    // booking, AppointmentService flips this same row to CONVERTED rather
    // than leaving it as a dangling duplicate contact.
    @PostMapping("/leads")
    public ResponseEntity<Lead> createLead(@PathVariable String slug, @Valid @RequestBody LeadRequest request) {
        return ResponseEntity.ok(leadService.createLead(slug, request));
    }

    private AppUser resolveOwner(String slug) {
        return appUserRepository.findBySlugAndRole(slug, com.patientbook.security.Roles.PSYCHOLOGIST)
                .orElseThrow(() -> new ResourceNotFoundException("No such booking link"));
    }

    private StaffPublicDto toStaffDto(AppUser staff) {
        return StaffPublicDto.builder()
                .id(staff.getId())
                .name(staff.getName())
                .jobTitle(staff.getJobTitle())
                .bio(staff.getBio())
                .profileImageUrl(staff.getProfileImageUrl())
                .build();
    }

    private ClinicServiceDto toDto(ClinicService svc) {
        ClinicServiceDto dto = new ClinicServiceDto();
        dto.setId(svc.getId());
        dto.setName(svc.getName());
        dto.setDescription(svc.getDescription());
        dto.setDuration(svc.getDuration());
        dto.setFee(svc.getFee());
        dto.setIcon(svc.getIcon());
        dto.setActive(svc.isActive());
        dto.setDisplayOrder(svc.getDisplayOrder());
        dto.setCreatedAt(svc.getCreatedAt() != null ? svc.getCreatedAt().toString() : null);
        return dto;
    }
}
