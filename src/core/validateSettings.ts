/**
 * Pure settings validation.
 *
 * `validateSettings` checks a candidate {@link ConnectionSettings} against the
 * documented field rules (Requirements 2.7, 2.8). It performs no I/O and never
 * mutates any store — it is a pure function over the candidate, returning a
 * result that identifies which field (if any) is invalid so the UI can show a
 * field-identifying validation message (design Property 10).
 */

import type { ConnectionSettings } from "./types";

/** Maximum allowed length, in characters, of the server endpoint URL (Req 2.1, 2.7). */
export const MAX_ENDPOINT_LENGTH = 2048;

/** Maximum allowed length, in characters, of the username and password (Req 2.2, 2.3, 2.8). */
export const MAX_CREDENTIAL_LENGTH = 255;

/**
 * The field of a {@link ConnectionSettings} candidate that a validation result
 * refers to.
 */
export type SettingsField = "endpoint" | "username" | "password";

/**
 * The reason a {@link ConnectionSettings} candidate was rejected.
 *
 * - `missing-scheme` — endpoint does not begin with `http://` or `https://`.
 * - `missing-host` — endpoint lacks a host component.
 * - `too-long` — the field exceeds its maximum length.
 * - `empty` — a required credential field is empty.
 */
export type SettingsValidationReason =
  | "missing-scheme"
  | "missing-host"
  | "too-long"
  | "empty";

/**
 * The result of validating a candidate {@link ConnectionSettings}.
 *
 * On success the candidate satisfies every rule. On failure the result
 * identifies the offending {@link SettingsField} and the {@link
 * SettingsValidationReason}, plus a human-readable message suitable for the
 * Settings UI.
 */
export type SettingsValidationResult =
  | { valid: true }
  | {
      valid: false;
      field: SettingsField;
      reason: SettingsValidationReason;
      message: string;
    };

/** A reusable "this candidate is valid" result. */
const VALID: SettingsValidationResult = { valid: true };

/**
 * Build an invalid result for a single field.
 */
function invalid(
  field: SettingsField,
  reason: SettingsValidationReason,
  message: string,
): SettingsValidationResult {
  return { valid: false, field, reason, message };
}

/**
 * Determine whether an endpoint string has a non-empty host component after
 * its `http://` or `https://` scheme.
 *
 * Uses the platform `URL` parser, which is available on both desktop and
 * mobile. The parser is the authority on what constitutes a host; a value such
 * as `https://` or `http:///path` parses with an empty `hostname`, which we
 * treat as missing.
 */
function hasHost(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.hostname.length > 0;
  } catch {
    // `URL` throws on inputs it cannot parse (e.g. `https://` with no host).
    return false;
  }
}

/**
 * Validate a candidate {@link ConnectionSettings}.
 *
 * Rules (design Property 10, Requirements 2.7, 2.8):
 * - The endpoint MUST begin with the scheme `http://` or `https://`, MUST have
 *   a host component, and MUST NOT exceed {@link MAX_ENDPOINT_LENGTH} characters.
 * - The username MUST be non-empty and MUST NOT exceed {@link MAX_CREDENTIAL_LENGTH}
 *   characters.
 * - The password MUST be non-empty and MUST NOT exceed {@link MAX_CREDENTIAL_LENGTH}
 *   characters.
 *
 * The function is pure: it reads only the candidate and returns a result. It
 * never mutates any store. Fields are checked endpoint → username → password,
 * and the first violation found is returned.
 *
 * @param candidate The connection settings to validate.
 * @returns A {@link SettingsValidationResult} that is either `{ valid: true }`
 *   or identifies the invalid field, the reason, and a UI-ready message.
 */
export function validateSettings(
  candidate: ConnectionSettings,
): SettingsValidationResult {
  const { endpoint, username, password } = candidate;

  // --- Endpoint (Req 2.7) ---
  if (endpoint.length > MAX_ENDPOINT_LENGTH) {
    return invalid(
      "endpoint",
      "too-long",
      `Server endpoint URL must be at most ${MAX_ENDPOINT_LENGTH} characters.`,
    );
  }
  if (!/^https?:\/\//.test(endpoint)) {
    return invalid(
      "endpoint",
      "missing-scheme",
      'Server endpoint URL must begin with "http://" or "https://".',
    );
  }
  if (!hasHost(endpoint)) {
    return invalid(
      "endpoint",
      "missing-host",
      "Server endpoint URL must include a host.",
    );
  }

  // --- Username (Req 2.8) ---
  if (username.length === 0) {
    return invalid("username", "empty", "Username must not be empty.");
  }
  if (username.length > MAX_CREDENTIAL_LENGTH) {
    return invalid(
      "username",
      "too-long",
      `Username must be at most ${MAX_CREDENTIAL_LENGTH} characters.`,
    );
  }

  // --- Password (Req 2.8) ---
  if (password.length === 0) {
    return invalid("password", "empty", "Password must not be empty.");
  }
  if (password.length > MAX_CREDENTIAL_LENGTH) {
    return invalid(
      "password",
      "too-long",
      `Password must be at most ${MAX_CREDENTIAL_LENGTH} characters.`,
    );
  }

  return VALID;
}
