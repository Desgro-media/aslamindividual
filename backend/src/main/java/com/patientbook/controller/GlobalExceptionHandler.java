package com.patientbook.controller;

import com.patientbook.service.ResourceNotFoundException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.time.format.DateTimeParseException;
import java.util.Map;

@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler {

    // Record doesn't exist OR belongs to a different account — both look
    // identical to the caller. See ResourceNotFoundException for why.
    @ExceptionHandler(ResourceNotFoundException.class)
    public ResponseEntity<Map<String, String>> handleNotFound(ResourceNotFoundException ex) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("message", ex.getMessage()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, String>> handleBadInput(IllegalArgumentException ex) {
        return ResponseEntity.badRequest().body(Map.of("message", ex.getMessage()));
    }

    // Bean-validation failures on an @Valid @RequestBody — a malformed email
    // or too-short password on /auth/signup, a bad field on any other DTO.
    //
    // Without this, Spring's default body ({"timestamp","status","error","path"})
    // carries no "message" field at all, so every frontend error path fell
    // through to its own generic fallback, which routinely blamed the wrong
    // thing — a client showing "something went wrong" when the real problem
    // was one field it could have named.
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, String>> handleValidation(MethodArgumentNotValidException ex) {
        String message = ex.getBindingResult().getFieldErrors().stream()
                .findFirst()
                .map(GlobalExceptionHandler::describeFieldError)
                .orElse("Please check the details you entered and try again.");
        return ResponseEntity.badRequest().body(Map.of("message", message));
    }

    // Jakarta's built-in messages are sentence fragments starting lowercase
    // ("must not be blank"), which read as nonsense on their own — those get
    // the field name prefixed. Messages we wrote ourselves on the annotation
    // ("Password must be at least 8 characters") already name their subject
    // and start uppercase, so they're passed through untouched.
    private static String describeFieldError(org.springframework.validation.FieldError error) {
        String message = error.getDefaultMessage();
        if (message == null || message.isBlank()) return error.getField() + " is invalid";
        return Character.isLowerCase(message.charAt(0)) ? error.getField() + " " + message : message;
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<Map<String, String>> handleConflict(IllegalStateException ex) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("message", ex.getMessage()));
    }

    // Two concurrent writes to the same row (e.g. a submission approved
    // and rejected in the same instant by two admin tabs) — same 409
    // semantics as the PENDING-status conflict above, just caught at the
    // DB layer instead of the status check.
    @ExceptionHandler(OptimisticLockingFailureException.class)
    public ResponseEntity<Map<String, String>> handleOptimisticLock(OptimisticLockingFailureException ex) {
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(Map.of("message", "This record was just updated elsewhere. Please refresh and try again."));
    }

    // Safety net for FK violations we didn't anticipate (e.g. a future
    // referencing table added without matching cleanup in its controller) —
    // surfaces as a real 409 instead of falling through to the generic 500
    // below, which used to hide the actual cause from the client entirely.
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<Map<String, String>> handleDataIntegrityViolation(DataIntegrityViolationException ex) {
        log.error("Data integrity violation", ex);
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(Map.of("message", "This record is still referenced by other data and can't be deleted."));
    }

    // Re-throw so Spring Security's AccessDeniedHandler returns the correct 403.
    @ExceptionHandler(AccessDeniedException.class)
    public void handleAccessDenied(AccessDeniedException ex) throws AccessDeniedException {
        throw ex;
    }

    // Thrown directly by AuthenticationManager.authenticate() inside
    // AuthController (login happens via a plain method call, not the
    // security filter chain, so it lands here like any other controller
    // exception) — covers a wrong password (BadCredentialsException), an
    // unknown email (Spring Security's DaoAuthenticationProvider already
    // masks this as BadCredentialsException by default — verified, not
    // assumed), and a deactivated staff account (DisabledException, see
    // UserDetailsServiceImpl). Without this handler all three fell through
    // to the generic RuntimeException handler below and returned a bare 500.
    //
    // Deliberately ignores ex.getMessage() and always returns the same fixed
    // string — Spring Security's enabled/locked/expired checks run BEFORE
    // password verification, so a distinct "account disabled" message here
    // would let anyone probe arbitrary emails (with any password) to find
    // out which specific staff accounts have been deactivated, the same
    // enumeration risk the default BadCredentials-masking already closes for
    // "does this email have an account at all."
    @ExceptionHandler(AuthenticationException.class)
    public ResponseEntity<Map<String, String>> handleAuthentication(AuthenticationException ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("message", "Invalid email or password"));
    }

    @ExceptionHandler({DateTimeParseException.class, NumberFormatException.class})
    public ResponseEntity<Map<String, String>> handleParsing(Exception ex) {
        return ResponseEntity.badRequest().body(Map.of("message", "Invalid date/time or number format: " + ex.getMessage()));
    }

    // A request body Jackson can't bind — text where a number belongs
    // ("durationMinutes": "abc"), a malformed date, broken JSON. Both this and
    // the query-param case below are RuntimeExceptions, so without their own
    // handlers they fell into the catch-all at the bottom and came back as a
    // 500 "unexpected error" for what is plainly the caller's mistake. The
    // message is fixed on purpose: Jackson's own text quotes the offending
    // payload and internal class names.
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, String>> handleUnreadableBody(HttpMessageNotReadableException ex) {
        return ResponseEntity.badRequest()
                .body(Map.of("message", "The request could not be read — please check the values you entered."));
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, String>> handleParamTypeMismatch(MethodArgumentTypeMismatchException ex) {
        return ResponseEntity.badRequest().body(Map.of("message", "Invalid value for '" + ex.getName() + "'."));
    }

    // Deliberately does NOT return ex.getMessage() to the client — an
    // uncaught RuntimeException here is by definition unexpected, and its
    // message can contain internal details (SQL, file paths, library
    // internals). Log the real one server-side; the client only ever sees a
    // generic message.
    @ExceptionHandler(RuntimeException.class)
    public ResponseEntity<Map<String, String>> handleRuntime(RuntimeException ex) {
        log.error("Unhandled RuntimeException", ex);
        return ResponseEntity
                .status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("message", "An unexpected error occurred"));
    }
}
