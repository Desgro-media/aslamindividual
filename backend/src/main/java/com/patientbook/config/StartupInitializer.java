package com.patientbook.config;

import com.patientbook.entity.AppUser;
import com.patientbook.entity.Subscription;
import com.patientbook.repository.AppUserRepository;
import com.patientbook.repository.AppointmentRepository;
import com.patientbook.repository.DoctorAvailabilityBlockRepository;
import com.patientbook.repository.DoctorDateOverrideRepository;
import com.patientbook.repository.DoctorServicePriceRepository;
import com.patientbook.repository.DoctorWeeklySlotRepository;
import com.patientbook.repository.SubscriptionRepository;
import com.patientbook.security.Roles;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;

// Runs on every startup, idempotently:
//  1. Grandfathers every pre-existing practitioner (anyone with no Subscription
//     row yet) as ACTIVE with no forced expiry — launching the trial/paid
//     system must never lock out an account that was already using the
//     product, only new signups from here on get the 14-day trial.
//  2. Seeds the single superadmin account from SUPERADMIN_EMAIL/PASSWORD env
//     vars, if configured and not already created. There is no signup path
//     for this role — this is the only way it's ever provisioned.
//  3. Backfills Appointment.assignedDoctorId (added for clinic staff support)
//     from the pre-existing psychologistId column, for every row from before
//     the column existed.
//  4. Backfills the online/offline session-mode columns (added across
//     Appointment, DoctorServicePrice, DoctorAvailabilityBlock,
//     DoctorWeeklySlot, DoctorDateOverride) for every row that predates
//     this feature — see each backfill method below for the exact
//     semantics. All four queries are permanently idempotent (they only
//     ever match pre-migration rows), so running them every boot is safe.
//  5. Relaxes the NOT NULL constraint on DoctorServicePrice's legacy
//     price/offered columns (see relaxLegacyServicePriceConstraints) —
//     required precondition for #4 above and for every future write.
@Component
@RequiredArgsConstructor
@Slf4j
public class StartupInitializer implements ApplicationRunner {

    private final AppUserRepository appUserRepository;
    private final SubscriptionRepository subscriptionRepository;
    private final AppointmentRepository appointmentRepository;
    private final DoctorAvailabilityBlockRepository availabilityBlockRepository;
    private final DoctorWeeklySlotRepository weeklySlotRepository;
    private final DoctorDateOverrideRepository dateOverrideRepository;
    private final DoctorServicePriceRepository servicePriceRepository;
    private final JdbcTemplate jdbcTemplate;
    private final PasswordEncoder passwordEncoder;

    @Value("${superadmin.email:}")
    private String superadminEmail;

    @Value("${superadmin.password:}")
    private String superadminPassword;

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        relaxLegacyServicePriceConstraints();
        grandfatherExistingTenants();
        seedSuperAdmin();
        backfillAssignedDoctorId();
        backfillSessionModes();
    }

    // DoctorServicePrice.price/offered predate the online/offline mode
    // split and are no longer mapped by the entity — Hibernate's INSERT
    // for a brand-new row simply omits them. Both columns were originally
    // created NOT NULL with no default, so without this, every doctor's
    // very first save through the new per-mode pricing UI would fail with
    // a constraint violation (caught live via a real insert against the
    // dev DB — this is not a hypothetical). Relaxing (not dropping) the
    // constraint keeps the columns intact as a harmless, still-idempotent
    // backfill source (see DoctorServicePriceRepository) while letting new
    // rows leave them null. Must run before backfillSessionModes() and
    // before any request can write a new DoctorServicePrice row.
    // On a brand-new database the legacy columns never existed (the entity
    // no longer maps them), so create them first — otherwise the ALTERs below
    // and DoctorServicePriceRepository's backfill fail on a fresh install.
    private void relaxLegacyServicePriceConstraints() {
        jdbcTemplate.execute("ALTER TABLE doctor_service_price ADD COLUMN IF NOT EXISTS price numeric(38,2)");
        jdbcTemplate.execute("ALTER TABLE doctor_service_price ADD COLUMN IF NOT EXISTS offered boolean");
        jdbcTemplate.execute("ALTER TABLE doctor_service_price ALTER COLUMN price DROP NOT NULL");
        jdbcTemplate.execute("ALTER TABLE doctor_service_price ALTER COLUMN offered DROP NOT NULL");
    }

    private void backfillAssignedDoctorId() {
        int updated = appointmentRepository.backfillAssignedDoctorIdFromPsychologistId();
        if (updated > 0) {
            log.info("Backfilled assignedDoctorId on {} pre-existing appointment(s)", updated);
        }
    }

    // Every pre-existing row across these five tables predates the
    // online/offline mode feature. OFFLINE is the correct default for all
    // of them except whole-day DoctorDateOverride blocks, which are
    // channel-independent and correctly stay mode=NULL (handled entirely
    // by that query's WHERE clause, not here).
    private void backfillSessionModes() {
        int appts = appointmentRepository.backfillModeToOffline();
        if (appts > 0) log.info("Backfilled mode=OFFLINE on {} pre-existing appointment(s)", appts);

        int blocks = availabilityBlockRepository.backfillModeToOffline();
        if (blocks > 0) log.info("Backfilled mode=OFFLINE on {} pre-existing availability block(s)", blocks);

        int weeklySlots = weeklySlotRepository.backfillModeToOffline();
        if (weeklySlots > 0) log.info("Backfilled mode=OFFLINE on {} pre-existing legacy weekly slot(s)", weeklySlots);

        int overrides = dateOverrideRepository.backfillModeToOffline();
        if (overrides > 0) log.info("Backfilled mode=OFFLINE on {} pre-existing slot-specific date override(s)", overrides);

        int servicePrices = servicePriceRepository.backfillOfflineFromLegacyPrice();
        if (servicePrices > 0) log.info("Backfilled offlinePrice/offlineOffered on {} pre-existing doctor service price row(s)", servicePrices);
    }

    private void grandfatherExistingTenants() {
        // tenantId IS NULL excludes clinic staff-doctors, who share the
        // PSYCHOLOGIST role string but don't have (or need) their own
        // independent Subscription row — see AppUserRepository.
        List<AppUser> tenants = appUserRepository.findByRoleAndTenantIdIsNullOrderByCreatedAtDesc(Roles.PSYCHOLOGIST);
        int created = 0;
        for (AppUser tenant : tenants) {
            if (subscriptionRepository.existsByPsychologistId(tenant.getId())) continue;
            subscriptionRepository.save(Subscription.builder()
                    .psychologistId(tenant.getId())
                    .status("ACTIVE")
                    .currentPeriodEnd(null) // no forced expiry — grandfathered
                    .build());
            created++;
        }
        if (created > 0) {
            log.info("Grandfathered {} pre-existing account(s) with an unrestricted ACTIVE subscription", created);
        }
    }

    private void seedSuperAdmin() {
        if (!StringUtils.hasText(superadminEmail) || !StringUtils.hasText(superadminPassword)) {
            log.warn("SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD not set — no superadmin account will be seeded. " +
                    "Set both env vars and restart to provision one.");
            return;
        }
        String email = superadminEmail.trim().toLowerCase();
        if (appUserRepository.existsByUsernameAndRole(email, Roles.SUPERADMIN)) {
            return;
        }
        if (appUserRepository.findByUsername(email).isPresent()) {
            log.error("SUPERADMIN_EMAIL {} is already registered as a regular account — refusing to seed a " +
                    "superadmin with the same email. Use a distinct email for the superadmin account.", email);
            return;
        }

        AppUser admin = AppUser.builder()
                .username(email)
                .password(passwordEncoder.encode(superadminPassword))
                .name("Super Admin")
                .role(Roles.SUPERADMIN)
                .slug(uniqueAdminSlug())
                .bookable(false)
                .build();
        appUserRepository.save(admin);
        log.info("Seeded superadmin account for {}", email);
    }

    // The superadmin row still needs a unique, non-null slug to satisfy
    // AppUser's schema, even though it's never reachable via /book/{slug}
    // (PublicController/AppointmentService only resolve slugs scoped to
    // ROLE_PSYCHOLOGIST).
    private String uniqueAdminSlug() {
        String base = "superadmin";
        String candidate = base;
        int suffix = 1;
        while (appUserRepository.existsBySlug(candidate)) {
            suffix++;
            candidate = base + "-" + suffix;
        }
        return candidate;
    }
}
