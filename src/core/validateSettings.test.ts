import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  validateSettings,
  MAX_ENDPOINT_LENGTH,
  MAX_CREDENTIAL_LENGTH,
  type ConnectionSettings,
  type SettingsField,
} from "./index";

/**
 * Property-based test for `validateSettings`.
 *
 * Feature: obsidian-synology-webdav-sync, Property 10: For any `ConnectionSettings` candidate that violates a rule — endpoint not beginning with `http://` or `https://`, endpoint lacking a host, endpoint longer than 2048 characters, or username/password that is empty or longer than 255 characters — validation SHALL reject the save and the stored `ConnectionSettings` SHALL be unchanged; and for any candidate satisfying all rules, validation SHALL accept it.
 *
 * Validates: Requirements 2.7, 2.8
 *
 * `validateSettings` is pure and mutates nothing, so the "stored settings are
 * unchanged" guarantee is asserted by confirming the function does not mutate
 * the candidate it is given (we snapshot the candidate and compare afterwards).
 */
describe("validateSettings (Property 10)", () => {
  // --- Generators for the pieces of a valid candidate ---------------------

  /** A valid endpoint: http(s) scheme + real host, comfortably within length. */
  const validEndpoint = (): fc.Arbitrary<string> =>
    fc
      .tuple(
        fc.constantFrom("http://", "https://"),
        fc.domain(),
        fc.oneof(
          fc.constant(""),
          fc.constant("/"),
          fc
            .array(fc.stringMatching(/^[a-z0-9]+$/), { minLength: 1, maxLength: 3 })
            .map((segs) => "/" + segs.join("/")),
        ),
      )
      .map(([scheme, host, path]) => `${scheme}${host}${path}`)
      .filter((url) => url.length <= MAX_ENDPOINT_LENGTH);

  /** A valid credential: non-empty, at most MAX_CREDENTIAL_LENGTH chars. */
  const validCredential = (): fc.Arbitrary<string> =>
    fc.string({ minLength: 1, maxLength: MAX_CREDENTIAL_LENGTH });

  /** A fully valid ConnectionSettings candidate. */
  const validSettings = (): fc.Arbitrary<ConnectionSettings> =>
    fc.record({
      endpoint: validEndpoint(),
      username: validCredential(),
      password: validCredential(),
    });

  // --- Generators for invalid candidates ----------------------------------
  // Each invalid candidate violates exactly one rule while every other field
  // stays valid, so the first violation found is the one we target. We tag
  // each candidate with the field we expect the validator to flag.

  interface InvalidCase {
    candidate: ConnectionSettings;
    expectedField: SettingsField;
  }

  /** Endpoint that does not begin with http:// or https:// (missing scheme). */
  const badScheme = (): fc.Arbitrary<InvalidCase> =>
    fc
      .tuple(
        fc
          .string({ maxLength: 64 })
          // Anything that is not an http(s) scheme prefix and stays in length.
          .filter((s) => !/^https?:\/\//.test(s)),
        validCredential(),
        validCredential(),
      )
      .map(([endpoint, username, password]) => ({
        candidate: { endpoint, username, password },
        expectedField: "endpoint" as const,
      }));

  /**
   * Endpoint with a valid scheme but no host component.
   *
   * Note: for the special schemes http/https, the platform `URL` parser
   * collapses extra slashes (e.g. `https:///path` resolves to host `path`), so
   * the only genuinely host-less endpoints are the bare scheme prefixes, which
   * the parser rejects outright.
   */
  const missingHost = (): fc.Arbitrary<InvalidCase> =>
    fc
      .tuple(
        fc.constantFrom("http://", "https://"),
        validCredential(),
        validCredential(),
      )
      .map(([endpoint, username, password]) => ({
        candidate: { endpoint, username, password },
        expectedField: "endpoint" as const,
      }));

  /** Endpoint longer than MAX_ENDPOINT_LENGTH characters. */
  const overLongEndpoint = (): fc.Arbitrary<InvalidCase> =>
    fc
      .tuple(
        fc.integer({ min: 1, max: 200 }),
        validCredential(),
        validCredential(),
      )
      .map(([extra, username, password]) => {
        const base = "https://example.com/";
        const padLength = MAX_ENDPOINT_LENGTH - base.length + extra;
        const endpoint = base + "a".repeat(padLength);
        return {
          candidate: { endpoint, username, password },
          expectedField: "endpoint" as const,
        };
      });

  /** Empty username (other fields valid). */
  const emptyUsername = (): fc.Arbitrary<InvalidCase> =>
    fc.tuple(validEndpoint(), validCredential()).map(([endpoint, password]) => ({
      candidate: { endpoint, username: "", password },
      expectedField: "username" as const,
    }));

  /** Username longer than MAX_CREDENTIAL_LENGTH characters. */
  const overLongUsername = (): fc.Arbitrary<InvalidCase> =>
    fc
      .tuple(
        validEndpoint(),
        fc.string({
          minLength: MAX_CREDENTIAL_LENGTH + 1,
          maxLength: MAX_CREDENTIAL_LENGTH + 100,
        }),
        validCredential(),
      )
      .map(([endpoint, username, password]) => ({
        candidate: { endpoint, username, password },
        expectedField: "username" as const,
      }));

  /** Empty password (endpoint and username valid). */
  const emptyPassword = (): fc.Arbitrary<InvalidCase> =>
    fc.tuple(validEndpoint(), validCredential()).map(([endpoint, username]) => ({
      candidate: { endpoint, username, password: "" },
      expectedField: "password" as const,
    }));

  /** Password longer than MAX_CREDENTIAL_LENGTH characters. */
  const overLongPassword = (): fc.Arbitrary<InvalidCase> =>
    fc
      .tuple(
        validEndpoint(),
        validCredential(),
        fc.string({
          minLength: MAX_CREDENTIAL_LENGTH + 1,
          maxLength: MAX_CREDENTIAL_LENGTH + 100,
        }),
      )
      .map(([endpoint, username, password]) => ({
        candidate: { endpoint, username, password },
        expectedField: "password" as const,
      }));

  const invalidSettings = (): fc.Arbitrary<InvalidCase> =>
    fc.oneof(
      badScheme(),
      missingHost(),
      overLongEndpoint(),
      emptyUsername(),
      overLongUsername(),
      emptyPassword(),
      overLongPassword(),
    );

  // --- Properties ----------------------------------------------------------

  it("accepts every candidate that satisfies all rules", () => {
    fc.assert(
      fc.property(validSettings(), (candidate) => {
        const snapshot = structuredClone(candidate);
        const result = validateSettings(candidate);

        expect(result.valid).toBe(true);
        // Purity: the candidate is never mutated, so the store is unchanged.
        expect(candidate).toEqual(snapshot);
      }),
    );
  });

  it("rejects every rule-violating candidate and flags a sensible field", () => {
    fc.assert(
      fc.property(invalidSettings(), ({ candidate, expectedField }) => {
        const snapshot = structuredClone(candidate);
        const result = validateSettings(candidate);

        expect(result.valid).toBe(false);
        if (result.valid === false) {
          expect(result.field).toBe(expectedField);
          // A non-empty, UI-ready message accompanies the rejection.
          expect(typeof result.message).toBe("string");
          expect(result.message.length).toBeGreaterThan(0);
        }
        // Purity: the candidate is never mutated, so the store is unchanged.
        expect(candidate).toEqual(snapshot);
      }),
    );
  });
});
