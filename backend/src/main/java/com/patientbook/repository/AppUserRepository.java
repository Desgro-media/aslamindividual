package com.patientbook.repository;

import com.patientbook.entity.AppUser;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface AppUserRepository extends JpaRepository<AppUser, Long> {
    Optional<AppUser> findByUsername(String username);

    // Resolves the practitioner behind a public booking link, e.g. /book/{slug}.
    // Scoped to ROLE_PSYCHOLOGIST so the seeded superadmin account (which also
    // needs a unique slug to satisfy this table's schema) can never be
    // resolved as a public-facing booking page — see PublicController.
    Optional<AppUser> findBySlugAndRole(String slug, String role);

    boolean existsBySlug(String slug);

    boolean existsByUsernameAndRole(String username, String role);

    // Superadmin tenant list / startup grandfathering — every tenant-ROOT
    // practitioner account (never a clinic's staff row, never the superadmin
    // itself). tenantId IS NULL is what distinguishes a real tenant from a
    // staff doctor who merely shares the PSYCHOLOGIST role string.
    List<AppUser> findByRoleAndTenantIdIsNullOrderByCreatedAtDesc(String role);

    // A clinic's staff roster, for the Staff Management dashboard.
    List<AppUser> findByTenantIdOrderByNameAsc(Long tenantId);

    // Ownership-checked staff lookup — a miss (wrong id OR belongs to a
    // different clinic) is treated identically, see ResourceNotFoundException.
    Optional<AppUser> findByIdAndTenantId(Long id, Long tenantId);

    // The public, bookable roster for a clinic's booking page. Explicitly
    // role-filtered (not just bookable=true) as defense in depth — a
    // receptionist/support-staff row should never be able to appear here even
    // if some future bug on the write side left bookable=true set on one.
    List<AppUser> findByTenantIdAndRoleAndBookableTrueAndEnabledTrue(Long tenantId, String role);

    // Ownership-checked, role-restricted staff lookup — used wherever a
    // client-supplied id is being validated as "a specific bookable doctor
    // within this clinic" (see StaffResolutionService), so a receptionist id
    // can never be resolved as a practitioner even if it were somehow left
    // bookable=true.
    Optional<AppUser> findByIdAndTenantIdAndRole(Long id, Long tenantId, String role);

    // Row lock on the practitioner, taken at the start of any booking/edit that
    // checks their calendar for overlaps. The overlap check is read-then-insert,
    // so without this two simultaneous requests for the same doctor could both
    // see a free slot and both insert. Holding the lock until the transaction
    // commits serializes bookings per practitioner (other doctors are unaffected).
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT u FROM AppUser u WHERE u.id = :id")
    Optional<AppUser> findByIdForUpdate(@Param("id") Long id);
}
