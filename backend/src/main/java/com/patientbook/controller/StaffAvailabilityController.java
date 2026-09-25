package com.patientbook.controller;

import com.patientbook.dto.AvailabilityBlockDto;
import com.patientbook.dto.DoctorDateOverrideDto;
import com.patientbook.dto.DoctorServicePriceDto;
import com.patientbook.entity.AppUser;
import com.patientbook.repository.ClinicHolidayRepository;
import com.patientbook.security.CurrentUserProvider;
import com.patientbook.service.DoctorAvailabilityService;
import com.patientbook.service.StaffService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

// Lets a clinic OWNER manage a specific staff member's services/pricing and
// availability directly, instead of requiring that staff member to log in
// and self-serve via /api/v1/me/**. Every method here starts with
// StaffService.requireClinicOwner (only the clinic's own tenant-root account
// may reach this) followed by requireOwnedStaff (the staffId must belong to
// the caller's own tenant) — the same two-check pattern StaffController
// itself uses, reused rather than re-implemented. The actual read/write
// logic is 100% shared with a doctor's own self-service flow
// (DoctorAvailabilityService is already parameterized by an explicit
// doctorId with no dependency on "current user"), so there is no separate
// admin-only code path to drift out of sync with the self-service one.
//
// Nested under /api/v1/staff so it inherits that prefix's existing
// StaffPermissionFilter exemption (see StaffPermissionFilter — /api/v1/staff
// is never gated there; authorization is enforced here instead, exactly
// like the rest of StaffController).
@RestController
@RequestMapping("/api/v1/staff/{staffId}")
@RequiredArgsConstructor
public class StaffAvailabilityController {

    private final DoctorAvailabilityService doctorAvailabilityService;
    private final StaffService staffService;
    private final CurrentUserProvider currentUserProvider;
    private final ClinicHolidayRepository clinicHolidayRepository;

    private AppUser requireOwnedStaff(Long staffId) {
        AppUser caller = currentUserProvider.getCurrentUser();
        staffService.requireClinicOwner(caller);
        return staffService.requireOwnedStaff(caller, staffId);
    }

    // Available slots on a specific staff member's own calendar — mirrors
    // DoctorController.getMySlots exactly (see its comments), just scoped to
    // staffId instead of the caller, so a clinic owner can pick a
    // colleague's open time when scheduling a session on their behalf
    // (see the dashboard's manual "Schedule Session" flow).
    @GetMapping("/slots")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<List<String>> getStaffSlots(@PathVariable Long staffId,
                                                        @RequestParam LocalDate date,
                                                        @RequestParam(required = false) String mode,
                                                        @RequestParam(required = false) Integer duration) {
        AppUser staff = requireOwnedStaff(staffId);
        boolean isHoliday = clinicHolidayRepository.findByHolidayDateAndPsychologistId(date, staff.getTenantId()).isPresent();
        return ResponseEntity.ok(doctorAvailabilityService.getAvailableSlotsForDoctor(staff.getId(), date, isHoliday, mode, duration));
    }

    // ── Services & pricing ──────────────────────────────────────────────

    @GetMapping("/services")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<List<DoctorServicePriceDto>> getStaffServices(@PathVariable Long staffId) {
        AppUser staff = requireOwnedStaff(staffId);
        return ResponseEntity.ok(doctorAvailabilityService.getAllDoctorServices(staff.getTenantId(), staff.getId()));
    }

    @PutMapping("/services")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<List<DoctorServicePriceDto>> saveStaffServices(@PathVariable Long staffId,
                                                                          @RequestBody List<DoctorServicePriceDto> updates) {
        AppUser staff = requireOwnedStaff(staffId);
        return ResponseEntity.ok(doctorAvailabilityService.saveDoctorServices(staff.getTenantId(), staff.getId(), updates));
    }

    // ── Weekly availability blocks ──────────────────────────────────────

    @GetMapping("/availability-blocks")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<Map<String, List<AvailabilityBlockDto>>> getStaffAvailabilityBlocks(@PathVariable Long staffId) {
        AppUser staff = requireOwnedStaff(staffId);
        return ResponseEntity.ok(doctorAvailabilityService.getAvailabilityBlocks(staff.getId()));
    }

    @PostMapping("/availability-blocks")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<List<AvailabilityBlockDto>> addStaffAvailabilityBlocks(@PathVariable Long staffId,
                                                                                  @RequestBody Map<String, Object> body) {
        AppUser staff = requireOwnedStaff(staffId);
        @SuppressWarnings("unchecked")
        List<String> days = (List<String>) body.get("daysOfWeek");
        String startTime = (String) body.get("startTime");
        String endTime   = (String) body.get("endTime");
        if (body.get("intervalMinutes") == null) throw new IllegalArgumentException("Session length is required");
        int interval     = Integer.parseInt(body.get("intervalMinutes").toString());
        String mode      = (String) body.get("mode");
        return ResponseEntity.ok(doctorAvailabilityService.addAvailabilityBlocks(
                staff.getId(), days, startTime, endTime, interval, mode));
    }

    @DeleteMapping("/availability-blocks/{blockId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<Void> removeStaffAvailabilityBlock(@PathVariable Long staffId, @PathVariable Long blockId) {
        AppUser staff = requireOwnedStaff(staffId);
        doctorAvailabilityService.removeAvailabilityBlock(blockId, staff.getId());
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/availability-blocks/day/{dayOfWeek}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<Void> clearStaffDayBlocks(@PathVariable Long staffId, @PathVariable String dayOfWeek,
                                                     @RequestParam(required = false) String mode) {
        AppUser staff = requireOwnedStaff(staffId);
        doctorAvailabilityService.clearDayBlocks(staff.getId(), dayOfWeek, mode);
        return ResponseEntity.noContent().build();
    }

    // ── Date-specific overrides ─────────────────────────────────────────

    @GetMapping("/date-overrides")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<List<DoctorDateOverrideDto>> getStaffDateOverrides(@PathVariable Long staffId) {
        AppUser staff = requireOwnedStaff(staffId);
        return ResponseEntity.ok(doctorAvailabilityService.getDateOverrides(staff.getId()));
    }

    @PostMapping("/date-overrides")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<DoctorDateOverrideDto> addStaffDateOverride(@PathVariable Long staffId,
                                                                       @RequestBody Map<String, Object> body) {
        AppUser staff = requireOwnedStaff(staffId);
        LocalDate date = LocalDate.parse((String) body.get("specificDate"));
        String slotTime = (String) body.get("slotTime");
        boolean available = body.get("available") == null || Boolean.parseBoolean(body.get("available").toString());
        String mode = (String) body.get("mode");
        return ResponseEntity.ok(doctorAvailabilityService.addDateOverride(
                staff.getId(), date, slotTime, available, mode));
    }

    @DeleteMapping("/date-overrides/{overrideId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<Void> removeStaffDateOverride(@PathVariable Long staffId, @PathVariable Long overrideId) {
        AppUser staff = requireOwnedStaff(staffId);
        doctorAvailabilityService.removeDateOverride(overrideId, staff.getId());
        return ResponseEntity.noContent().build();
    }
}
