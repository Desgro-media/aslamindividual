package com.patientbook.service;

import com.patientbook.dto.AvailabilityBlockDto;
import com.patientbook.dto.AvailabilitySummaryDto;
import com.patientbook.dto.DoctorDateOverrideDto;
import com.patientbook.dto.DoctorServicePriceDto;
import com.patientbook.dto.DoctorWeeklySlotDto;
import com.patientbook.entity.*;
import com.patientbook.repository.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.*;
import java.util.stream.Collectors;

// Everything here operates on ONE practitioner's own availability/pricing —
// see DoctorController, which resolves that practitioner from the
// authenticated caller (never from a client-supplied id).
//
// Online/offline session mode is a second, independent dimension on top of
// that existing per-doctor scoping: every availability table (block, legacy
// weekly slot, date override) and DoctorServicePrice now carries a `mode`
// discriminator, so a clinic's multiple staff doctors each get fully
// independent online/offline calendars and price sheets automatically,
// with no clinic-specific branching needed anywhere below.
@Service
@RequiredArgsConstructor
public class DoctorAvailabilityService {

    private static final String ONLINE = "ONLINE";
    private static final String OFFLINE = "OFFLINE";

    private final AppUserRepository userRepository;
    private final DoctorWeeklySlotRepository weeklySlotRepository;
    private final DoctorDateOverrideRepository dateOverrideRepository;
    private final DoctorServicePriceRepository servicePriceRepository;
    private final ClinicServiceRepository clinicServiceRepository;
    private final DoctorAvailabilityBlockRepository blockRepository;
    private final AppointmentRepository appointmentRepository;

    private static final DateTimeFormatter HH_MM = DateTimeFormatter.ofPattern("HH:mm");

    private static String resolveMode(String mode) {
        return mode != null ? mode : OFFLINE;
    }

    // ── Public: get services offered by a doctor, in EITHER mode (for the
    // booking form's session-type step). Each entry carries both modes'
    // price + offered flag; the caller (frontend, once a mode is picked)
    // filters/displays by whichever mode the client actually chose. ──────
    // Individual practitioners have no separate "offered" opt-in step for
    // OFFLINE — every Active catalog service is bookable automatically,
    // using a per-doctor price override if one was ever saved (legacy
    // data), else the catalog's own fee. ONLINE has no catalog-level
    // fallback for anyone — it's always an explicit per-service opt-in,
    // individual or clinic staff alike, since it's a brand-new concept no
    // pre-existing doctor ever configured.
    // Clinic doctors/staff still opt in to OFFLINE per-service too, since
    // several practitioners share one catalog and don't all offer the same
    // things.
    public List<DoctorServicePriceDto> getDoctorOfferedServices(Long psychologistId) {
        AppUser doctor = userRepository.findById(psychologistId)
                .orElseThrow(() -> new ResourceNotFoundException("Doctor not found: " + psychologistId));
        boolean isIndividual = doctor.getTenantId() == null && doctor.getAccountType() != AccountType.CLINIC;

        if (isIndividual) {
            Map<Long, DoctorServicePrice> overrides = servicePriceRepository.findByPsychologistId(psychologistId).stream()
                    .collect(Collectors.toMap(dsp -> dsp.getClinicService().getId(), dsp -> dsp));
            return clinicServiceRepository.findByPsychologistIdAndActiveTrueOrderByDisplayOrderAscCreatedAtAsc(psychologistId).stream()
                    .map(svc -> toIndividualDto(svc, overrides.get(svc.getId())))
                    .filter(dto -> dto.isOnlineOffered() || dto.isOfflineOffered())
                    .collect(Collectors.toList());
        }

        return servicePriceRepository.findByPsychologistId(psychologistId).stream()
                .filter(dsp -> dsp.isOnlineOffered() || dsp.isOfflineOffered())
                .map(this::toConfiguredDto)
                .collect(Collectors.toList());
    }

    // ── Get all of a doctor's services with prices (including not-offered) —
    // powers the Services-page pricing editor. Shows the TRUE effective
    // state (including the individual auto-offline-fallback), so the
    // editor never lies about what's actually live on the booking page. ──
    // tenantId scopes the shared service CATALOG (which services exist at
    // all — clinic-wide); doctorId scopes which of those this specific
    // practitioner has priced/offered. For an individual these are the same
    // value, so behavior is unchanged.
    public List<DoctorServicePriceDto> getAllDoctorServices(Long tenantId, Long doctorId) {
        AppUser doctor = userRepository.findById(doctorId)
                .orElseThrow(() -> new ResourceNotFoundException("Doctor not found: " + doctorId));
        boolean isIndividual = doctor.getTenantId() == null && doctor.getAccountType() != AccountType.CLINIC;

        List<com.patientbook.entity.ClinicService> allServices =
                clinicServiceRepository.findByPsychologistIdAndActiveTrueOrderByDisplayOrderAscCreatedAtAsc(tenantId);
        Map<Long, DoctorServicePrice> configMap = servicePriceRepository.findByPsychologistId(doctorId).stream()
                .collect(Collectors.toMap(dsp -> dsp.getClinicService().getId(), dsp -> dsp));

        return allServices.stream()
                .map(svc -> isIndividual
                        ? toIndividualDto(svc, configMap.get(svc.getId()))
                        : toClinicStaffDto(svc, configMap.get(svc.getId())))
                .collect(Collectors.toList());
    }

    // Individual doctor + a given catalog service: no row yet means
    // "auto-offered offline at the catalog fee, online not yet configured"
    // — this is the one place the individual zero-config fallback lives.
    private DoctorServicePriceDto toIndividualDto(com.patientbook.entity.ClinicService svc, DoctorServicePrice override) {
        boolean offlineOffered = override == null || override.isOfflineOffered();
        boolean onlineOffered = override != null && override.isOnlineOffered();
        BigDecimal offlinePrice = (override != null && override.getOfflinePrice() != null)
                ? override.getOfflinePrice()
                : (svc.getFee() != null ? svc.getFee() : BigDecimal.ZERO);
        BigDecimal onlinePrice = override != null ? override.getOnlinePrice() : null;
        return DoctorServicePriceDto.builder()
                .id(override != null ? override.getId() : null)
                .clinicServiceId(svc.getId())
                .serviceName(svc.getName())
                .serviceDescription(svc.getDescription())
                .serviceDuration(svc.getDuration())
                .serviceIcon(svc.getIcon())
                .onlinePrice(onlinePrice)
                .offlinePrice(offlinePrice)
                .onlineOffered(onlineOffered)
                .offlineOffered(offlineOffered)
                .build();
    }

    // Clinic staff + a given catalog service: no row means "not offered in
    // either mode" — explicit per-service opt-in, no catalog fallback.
    private DoctorServicePriceDto toClinicStaffDto(com.patientbook.entity.ClinicService svc, DoctorServicePrice override) {
        return DoctorServicePriceDto.builder()
                .id(override != null ? override.getId() : null)
                .clinicServiceId(svc.getId())
                .serviceName(svc.getName())
                .serviceDescription(svc.getDescription())
                .serviceDuration(svc.getDuration())
                .serviceIcon(svc.getIcon())
                .onlinePrice(override != null ? override.getOnlinePrice() : null)
                .offlinePrice(override != null ? override.getOfflinePrice() : null)
                .onlineOffered(override != null && override.isOnlineOffered())
                .offlineOffered(override != null && override.isOfflineOffered())
                .build();
    }

    private DoctorServicePriceDto toConfiguredDto(DoctorServicePrice dsp) {
        return DoctorServicePriceDto.builder()
                .id(dsp.getId())
                .clinicServiceId(dsp.getClinicService().getId())
                .serviceName(dsp.getClinicService().getName())
                .serviceDescription(dsp.getClinicService().getDescription())
                .serviceDuration(dsp.getClinicService().getDuration())
                .serviceIcon(dsp.getClinicService().getIcon())
                .onlinePrice(dsp.getOnlinePrice())
                .offlinePrice(dsp.getOfflinePrice())
                .onlineOffered(dsp.isOnlineOffered())
                .offlineOffered(dsp.isOfflineOffered())
                .build();
    }

    // ── Save all of a doctor's service prices at once ─────────────────────────
    // tenantId scopes which service ids are even valid to price (the shared
    // catalog); doctorId is whose DoctorServicePrice rows get written. The
    // incoming DTOs always carry the full current state (including the
    // individual effective-default the GET above computed), so a save that
    // only touches one mode's toggle never clobbers the other mode's data.
    @Transactional
    public List<DoctorServicePriceDto> saveDoctorServices(Long tenantId, Long doctorId,
                                                          List<DoctorServicePriceDto> updates) {
        AppUser doctor = userRepository.findById(doctorId)
                .orElseThrow(() -> new ResourceNotFoundException("Doctor not found: " + doctorId));

        for (DoctorServicePriceDto dto : updates) {
            // Ownership-checked — a service id belonging to a different tenant is rejected.
            com.patientbook.entity.ClinicService svc =
                    clinicServiceRepository.findByIdAndPsychologistId(dto.getClinicServiceId(), tenantId)
                            .orElseThrow(() -> new ResourceNotFoundException("Service not found: " + dto.getClinicServiceId()));

            BigDecimal onlinePrice = dto.getOnlinePrice() != null ? dto.getOnlinePrice() : BigDecimal.ZERO;
            BigDecimal offlinePrice = dto.getOfflinePrice() != null ? dto.getOfflinePrice() : BigDecimal.ZERO;

            Optional<DoctorServicePrice> existing =
                    servicePriceRepository.findByPsychologistIdAndClinicServiceId(doctorId, svc.getId());

            if (existing.isPresent()) {
                DoctorServicePrice dsp = existing.get();
                dsp.setOnlinePrice(onlinePrice);
                dsp.setOfflinePrice(offlinePrice);
                dsp.setOnlineOffered(dto.isOnlineOffered());
                dsp.setOfflineOffered(dto.isOfflineOffered());
                servicePriceRepository.save(dsp);
            } else {
                servicePriceRepository.save(DoctorServicePrice.builder()
                        .psychologist(doctor)
                        .clinicService(svc)
                        .onlinePrice(onlinePrice)
                        .offlinePrice(offlinePrice)
                        .onlineOffered(dto.isOnlineOffered())
                        .offlineOffered(dto.isOfflineOffered())
                        .build());
            }
        }

        return getAllDoctorServices(tenantId, doctorId);
    }

    // ── Get weekly schedule for the caller's own account ──────────────────────
    public Map<String, List<DoctorWeeklySlotDto>> getDoctorWeeklySchedule(Long psychologistId) {
        List<DoctorWeeklySlot> slots = weeklySlotRepository.findByPsychologistId(psychologistId);
        Map<String, List<DoctorWeeklySlotDto>> schedule = new LinkedHashMap<>();
        String[] days = {"MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"};
        for (String day : days) {
            schedule.put(day, new ArrayList<>());
        }
        for (DoctorWeeklySlot slot : slots) {
            DoctorWeeklySlotDto dto = DoctorWeeklySlotDto.builder()
                    .id(slot.getId())
                    .dayOfWeek(slot.getDayOfWeek())
                    .slotTime(slot.getSlotTime())
                    .active(slot.isActive())
                    .build();
            schedule.computeIfAbsent(slot.getDayOfWeek(), k -> new ArrayList<>()).add(dto);
        }
        // Sort slots within each day
        schedule.values().forEach(list -> list.sort(Comparator.comparing(DoctorWeeklySlotDto::getSlotTime)));
        return schedule;
    }

    // ── Add a weekly slot to the caller's own account ──────────────────────────
    @Transactional
    public DoctorWeeklySlotDto addWeeklySlot(Long psychologistId, String dayOfWeek, String slotTime) {
        AppUser psychologist = userRepository.findById(psychologistId)
                .orElseThrow(() -> new ResourceNotFoundException("Doctor not found: " + psychologistId));
        DoctorWeeklySlot slot = weeklySlotRepository.save(DoctorWeeklySlot.builder()
                .psychologist(psychologist)
                .dayOfWeek(dayOfWeek.toUpperCase())
                .slotTime(slotTime)
                .active(true)
                .mode(OFFLINE)
                .build());
        return DoctorWeeklySlotDto.builder()
                .id(slot.getId()).dayOfWeek(slot.getDayOfWeek())
                .slotTime(slot.getSlotTime()).active(slot.isActive()).build();
    }

    // ── Remove a weekly slot (ownership-checked) ────────────────────────────────
    @Transactional
    public void removeWeeklySlot(Long slotId, Long psychologistId) {
        weeklySlotRepository.deleteByIdAndPsychologistId(slotId, psychologistId);
    }

    // ── Get date overrides for the caller's own account (both modes, tagged) ──
    public List<DoctorDateOverrideDto> getDateOverrides(Long psychologistId) {
        return dateOverrideRepository
                .findByPsychologistIdAndSpecificDateGreaterThanEqual(psychologistId, LocalDate.now())
                .stream()
                .map(o -> DoctorDateOverrideDto.builder()
                        .id(o.getId())
                        .specificDate(o.getSpecificDate())
                        .slotTime(o.getSlotTime())
                        .available(o.isAvailable())
                        .mode(o.getMode())
                        .build())
                .collect(Collectors.toList());
    }

    // ── Add a date override to the caller's own account ─────────────────────────
    // mode is nullable ONLY for a whole-day block (slotTime == null) —
    // "applies to both calendars" is unambiguous there (leave/holiday).
    // A slot-specific override (adding or pulling one specific time) must
    // name an explicit mode, since leaving it ambiguous risks silently
    // affecting a calendar the doctor never reviewed.
    @Transactional
    public DoctorDateOverrideDto addDateOverride(Long psychologistId, LocalDate date,
                                                  String slotTime, boolean available, String mode) {
        if (slotTime != null && mode == null) {
            throw new IllegalArgumentException("mode is required when setting a specific slot time");
        }
        AppUser psychologist = userRepository.findById(psychologistId)
                .orElseThrow(() -> new ResourceNotFoundException("Doctor not found: " + psychologistId));
        DoctorDateOverride override = dateOverrideRepository.save(DoctorDateOverride.builder()
                .psychologist(psychologist)
                .specificDate(date)
                .slotTime(slotTime)
                .available(available)
                .mode(mode)
                .build());
        return DoctorDateOverrideDto.builder()
                .id(override.getId()).specificDate(override.getSpecificDate())
                .slotTime(override.getSlotTime()).available(override.isAvailable())
                .mode(override.getMode())
                .build();
    }

    // ── Delete a date override (ownership-checked) ───────────────────────────────
    @Transactional
    public void removeDateOverride(Long overrideId, Long psychologistId) {
        dateOverrideRepository.deleteByIdAndPsychologistId(overrideId, psychologistId);
    }

    // ── Get all availability blocks for the caller's own account (both
    // modes, tagged) — the Settings UI groups these client-side by mode
    // rather than issuing a separate fetch per tab. ───────────────────────
    public Map<String, List<AvailabilityBlockDto>> getAvailabilityBlocks(Long psychologistId) {
        List<DoctorAvailabilityBlock> blocks =
                blockRepository.findByPsychologistIdOrderByDayOfWeekAscStartTimeAsc(psychologistId);
        String[] days = {"MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"};
        Map<String, List<AvailabilityBlockDto>> result = new LinkedHashMap<>();
        for (String day : days) result.put(day, new ArrayList<>());
        for (DoctorAvailabilityBlock b : blocks) {
            AvailabilityBlockDto dto = AvailabilityBlockDto.builder()
                    .id(b.getId())
                    .dayOfWeek(b.getDayOfWeek())
                    .startTime(b.getStartTime())
                    .endTime(b.getEndTime())
                    .intervalMinutes(b.getIntervalMinutes())
                    .mode(resolveMode(b.getMode()))
                    .build();
            result.computeIfAbsent(b.getDayOfWeek(), k -> new ArrayList<>()).add(dto);
        }
        return result;
    }

    // ── Add availability blocks (one per selected day) to the caller's own account ─
    // Skips a day if an identical block (same day+start+end+interval+mode)
    // already exists — "Apply to selected days" is meant to be safely
    // repeatable (double-click, re-applying an unchanged preset), not a
    // source of duplicate rows that clutter the weekly view and generate
    // redundant deletes.
    @Transactional
    public List<AvailabilityBlockDto> addAvailabilityBlocks(Long psychologistId, List<String> daysOfWeek,
                                                            String startTime, String endTime,
                                                            int intervalMinutes, String mode) {
        // Everything is validated BEFORE anything is saved. This used to trust
        // the request body completely: an interval of 0 (or a negative one) was
        // stored as-is and then made getAvailableSlotsForDoctor loop forever on
        // every later slot fetch — including the public booking page's —
        // pinning a server thread per request; unparseable times failed the
        // same fetch with a 500 instead of failing here with a clear 400.
        if (daysOfWeek == null || daysOfWeek.isEmpty()) {
            throw new IllegalArgumentException("Select at least one day");
        }
        LocalTime start = parseBlockTime(startTime, "Start time");
        LocalTime end = parseBlockTime(endTime, "End time");
        if (!start.isBefore(end)) {
            throw new IllegalArgumentException("Start time must be before end time");
        }
        SessionDurations.requireValid(intervalMinutes);
        if (mode != null && !ONLINE.equals(mode) && !OFFLINE.equals(mode)) {
            throw new IllegalArgumentException("Mode must be ONLINE or OFFLINE");
        }
        Set<String> validDays = Arrays.stream(DayOfWeek.values()).map(Enum::name).collect(Collectors.toSet());
        List<String> days = new ArrayList<>();
        for (String day : daysOfWeek) {
            String upper = day == null ? "" : day.trim().toUpperCase();
            if (!validDays.contains(upper)) {
                throw new IllegalArgumentException("Invalid day of week: " + day);
            }
            if (!days.contains(upper)) days.add(upper);
        }
        String startHhMm = start.format(HH_MM);
        String endHhMm = end.format(HH_MM);

        AppUser psychologist = userRepository.findById(psychologistId)
                .orElseThrow(() -> new ResourceNotFoundException("Doctor not found: " + psychologistId));
        String resolvedMode = resolveMode(mode);
        List<AvailabilityBlockDto> created = new ArrayList<>();
        for (String upperDay : days) {
            boolean alreadyExists = blockRepository.findByPsychologistIdAndDayOfWeekAndMode(psychologistId, upperDay, resolvedMode)
                    .stream()
                    .anyMatch(b -> startHhMm.equals(b.getStartTime()) && endHhMm.equals(b.getEndTime()) && intervalMinutes == b.getIntervalMinutes());
            if (alreadyExists) continue;

            DoctorAvailabilityBlock block = blockRepository.save(
                    DoctorAvailabilityBlock.builder()
                            .psychologist(psychologist)
                            .dayOfWeek(upperDay)
                            .startTime(startHhMm)
                            .endTime(endHhMm)
                            .intervalMinutes(intervalMinutes)
                            .mode(resolvedMode)
                            .build());
            created.add(AvailabilityBlockDto.builder()
                    .id(block.getId())
                    .dayOfWeek(block.getDayOfWeek())
                    .startTime(block.getStartTime())
                    .endTime(block.getEndTime())
                    .intervalMinutes(block.getIntervalMinutes())
                    .mode(block.getMode())
                    .build());
        }
        return created;
    }

    private static LocalTime parseBlockTime(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(label + " is required");
        }
        try {
            return LocalTime.parse(value.trim());
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException(label + " must be in HH:mm format");
        }
    }

    // ── Delete a single availability block (ownership-checked) ──────────────────
    @Transactional
    public void removeAvailabilityBlock(Long blockId, Long psychologistId) {
        blockRepository.deleteByIdAndPsychologistId(blockId, psychologistId);
    }

    // ── Clear all blocks for a day+mode on the caller's own account ───────────
    // Scoped by mode so clearing one calendar's Monday never touches the
    // other calendar's Monday.
    @Transactional
    public void clearDayBlocks(Long psychologistId, String dayOfWeek, String mode) {
        blockRepository.deleteByPsychologistIdAndDayOfWeekAndMode(psychologistId, dayOfWeek.toUpperCase(), resolveMode(mode));
    }

    // ── Compute available slots for a doctor, in a given mode, on a given
    // date ─────────────────────────────────────────────────────────────
    // Used by the public booking endpoint and the dashboard's manual-scheduling
    // slot pickers. Only the OPEN-WINDOW sources (legacy weekly slots, blocks,
    // overrides) are mode-filtered. Existing appointments are looked up here
    // across ALL modes for this doctor — a doctor is one physical person and
    // can't run a same-time ONLINE and OFFLINE session simultaneously, so
    // booked-slot conflict checking is deliberately mode-agnostic.
    //
    // sessionMinutes is the length the caller intends to book (the doctor's
    // pick in manual scheduling). A start time is only offered if a session of
    // that length starting there would not collide with an existing
    // appointment — matching the authoritative overlap check at booking time,
    // so the picker never offers a time the booking would then reject. Null
    // (the public flow, which doesn't know the length yet) still hides any
    // start time that falls inside an existing appointment.
    public List<String> getAvailableSlotsForDoctor(Long psychologistId, LocalDate date,
                                                    boolean isHoliday, String mode, Integer sessionMinutes) {
        if (isHoliday) return Collections.emptyList();
        String resolvedMode = resolveMode(mode);
        int candidateMinutes = sessionMinutes != null ? SessionDurations.requireValid(sessionMinutes) : 1;

        String dayOfWeek = date.getDayOfWeek().name();
        Set<String> slots = new LinkedHashSet<>();

        // 1. Legacy individual weekly slots (backward compat) — this model
        // has no create UI anymore, so it only ever contributes to OFFLINE.
        weeklySlotRepository
                .findByPsychologistIdAndDayOfWeekAndModeAndActiveTrue(psychologistId, dayOfWeek, resolvedMode)
                .forEach(s -> slots.add(s.getSlotTime()));

        // 2. New block-based availability — generate slots from each block
        // that belongs to the requested mode's calendar. Walks integer
        // minutes-of-day rather than LocalTime: LocalTime.plusMinutes wraps at
        // midnight, so a late block (e.g. 20:00–23:45 every 2h) never satisfied
        // `time < end` again after wrapping and looped forever.
        for (DoctorAvailabilityBlock block : blockRepository.findByPsychologistIdAndDayOfWeekAndMode(psychologistId, dayOfWeek, resolvedMode)) {
            int interval = block.getIntervalMinutes();
            if (interval <= 0) continue; // corrupt row — would never advance
            LocalTime blockStart = tryParseTime(block.getStartTime());
            LocalTime blockEnd = tryParseTime(block.getEndTime());
            if (blockStart == null || blockEnd == null) continue;
            int endMinute = blockEnd.getHour() * 60 + blockEnd.getMinute();
            for (int t = blockStart.getHour() * 60 + blockStart.getMinute(); t < endMinute; t += interval) {
                slots.add(String.format("%02d:%02d", t / 60, t % 60)); // "HH:mm"
            }
        }

        // 3. Apply date-specific overrides — a null-mode row (whole-day
        // block) applies here too, alongside rows tagged for this mode.
        for (DoctorDateOverride override : dateOverrideRepository
                .findByPsychologistIdAndSpecificDateAndMode(psychologistId, date, resolvedMode)) {
            if (override.isAvailable() && override.getSlotTime() != null) {
                slots.add(override.getSlotTime());
            } else if (!override.isAvailable()) {
                // null slotTime = entire day blocked (for this mode, or both if mode is null)
                if (override.getSlotTime() == null) return Collections.emptyList();
                slots.remove(override.getSlotTime());
            }
        }

        // 4. Remove slots that collide with an existing (non-cancelled)
        // appointment, and — for today — slots whose start time has already
        // passed, so patients/staff can't book into the past. A slot that can't
        // be parsed as HH:mm, or whose session would run past midnight, can
        // never be booked, so it is dropped rather than offered.
        List<Appointment> active = appointmentRepository.findByAppointmentDateAndAssignedDoctorId(date, psychologistId)
                .stream()
                .filter(a -> !"CANCELLED".equals(a.getStatus()))
                .collect(Collectors.toList());
        boolean isToday = date.isEqual(LocalDate.now());
        LocalTime now = LocalTime.now();
        return slots.stream()
                .filter(s -> {
                    LocalTime start = tryParseTime(s);
                    if (start == null) return false;
                    if (isToday && !start.isAfter(now)) return false;
                    if (start.getHour() * 60 + start.getMinute() + candidateMinutes >= 24 * 60) return false;
                    LocalTime end = start.plusMinutes(candidateMinutes);
                    return active.stream().noneMatch(a ->
                            start.equals(a.getStartTime())
                                    || SessionDurations.overlaps(start, end, a.getStartTime(), a.getEndTime()));
                })
                .sorted()
                .collect(Collectors.toList());
    }

    private static LocalTime tryParseTime(String value) {
        try {
            return value == null ? null : LocalTime.parse(value);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    // ── Summarize which dates could possibly have a slot, for a given mode ──
    // Lets the public booking calendar disable days up front (in addition
    // to past dates and holidays) instead of only finding out after the
    // user picks a date and the per-date slots call comes back empty.
    // Deliberately schedule-only, not booked-slot-aware — a fully booked
    // day still counts as "enabled" here (existing per-date fetch already
    // reports "no slots available" for that case); this only answers
    // "does this doctor's schedule ever offer this day at all".
    public AvailabilitySummaryDto getAvailabilitySummary(Long psychologistId, String mode) {
        String resolvedMode = resolveMode(mode);

        Set<String> weekdays = new LinkedHashSet<>();
        blockRepository.findByPsychologistIdOrderByDayOfWeekAscStartTimeAsc(psychologistId).stream()
                .filter(b -> resolvedMode.equals(resolveMode(b.getMode())))
                .forEach(b -> weekdays.add(b.getDayOfWeek()));
        // Legacy weekly slots have no create UI and only ever feed OFFLINE
        // (see DoctorWeeklySlot) — matches getAvailableSlotsForDoctor.
        if (OFFLINE.equals(resolvedMode)) {
            weeklySlotRepository.findByPsychologistId(psychologistId).stream()
                    .filter(DoctorWeeklySlot::isActive)
                    .forEach(s -> weekdays.add(s.getDayOfWeek()));
        }

        Set<String> blockedDates = new LinkedHashSet<>();
        Set<String> extraDates = new LinkedHashSet<>();
        for (DoctorDateOverride o : dateOverrideRepository.findByPsychologistIdAndSpecificDateGreaterThanEqual(psychologistId, LocalDate.now())) {
            boolean appliesToThisMode = o.getMode() == null || resolvedMode.equals(o.getMode());
            if (!appliesToThisMode) continue;
            if (!o.isAvailable() && o.getSlotTime() == null) {
                blockedDates.add(o.getSpecificDate().toString()); // whole-day block
            } else if (o.isAvailable() && o.getSlotTime() != null) {
                extraDates.add(o.getSpecificDate().toString()); // ad hoc extra slot on an otherwise-off day
            }
        }

        return AvailabilitySummaryDto.builder()
                .enabledWeekdays(new ArrayList<>(weekdays))
                .extraDates(new ArrayList<>(extraDates))
                .blockedDates(new ArrayList<>(blockedDates))
                .build();
    }

    // ── Resolve a specific doctor's BOOKABLE price for a service+mode,
    // rejecting anything the doctor hasn't actually opted into ───────────
    // doctorId scopes the per-doctor DoctorServicePrice row (each staff
    // member can price the same service differently, per mode); tenantId
    // scopes the catalog-fee fallback (clinic-wide), used only for the
    // individual+no-row+OFFLINE exception. Never trust a client-supplied
    // mode/price combo without this check — see AppointmentService and
    // InvoiceService, the only two callers.
    public BigDecimal resolveBookablePrice(Long tenantId, Long doctorId, Long clinicServiceId, String mode) {
        String resolvedMode = resolveMode(mode);
        boolean online = ONLINE.equals(resolvedMode);

        if (doctorId != null && clinicServiceId != null) {
            Optional<DoctorServicePrice> dspOpt =
                    servicePriceRepository.findByPsychologistIdAndClinicServiceId(doctorId, clinicServiceId);
            if (dspOpt.isPresent()) {
                DoctorServicePrice dsp = dspOpt.get();
                boolean offered = online ? dsp.isOnlineOffered() : dsp.isOfflineOffered();
                if (offered) {
                    BigDecimal price = online ? dsp.getOnlinePrice() : dsp.getOfflinePrice();
                    return price != null ? price : BigDecimal.ZERO;
                }
                throw new IllegalArgumentException(
                        "This practitioner does not offer this service " + (online ? "online" : "in person"));
            }
        }

        // No configured row at all — the individual, zero-config,
        // OFFLINE-only auto-fallback. ONLINE never falls back to the
        // catalog; it must always be explicitly configured.
        if (!online && doctorId != null && clinicServiceId != null && tenantId != null) {
            AppUser doctor = userRepository.findById(doctorId).orElse(null);
            boolean isIndividual = doctor != null && doctor.getTenantId() == null && doctor.getAccountType() != AccountType.CLINIC;
            if (isIndividual) {
                return clinicServiceRepository.findByIdAndPsychologistId(clinicServiceId, tenantId)
                        .map(s -> s.getFee() != null ? s.getFee() : BigDecimal.ZERO)
                        .orElseThrow(() -> new IllegalArgumentException("Service not found: " + clinicServiceId));
            }
        }

        throw new IllegalArgumentException(
                "This practitioner does not offer this service " + (online ? "online" : "in person"));
    }

    // ── Update the caller's own profile (bio, bookable, profileImageUrl) ──────
    @Transactional
    public AppUser updateDoctorProfile(Long psychologistId, String bio,
                                       boolean bookable, String profileImageUrl) {
        AppUser user = userRepository.findById(psychologistId)
                .orElseThrow(() -> new ResourceNotFoundException("User not found: " + psychologistId));
        if (bio != null) user.setBio(bio);
        user.setBookable(bookable);
        if (profileImageUrl != null) user.setProfileImageUrl(profileImageUrl);
        return userRepository.save(user);
    }
}
