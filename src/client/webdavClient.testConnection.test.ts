import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  FakeTransport,
  okResponse,
  unauthorizedResponse,
  type ScriptedResponse,
} from "../transport/fakeTransport";
import { render, type ConnectionSettings } from "../core";
import { WebDAVClient } from "./webdavClient";

/**
 * Property-based test for design Property 12 (connection-test results).
 *
 * Feature: obsidian-synology-webdav-sync, Property 12: For any simulated
 * transport outcome (successful auth, 401, network failure, no-response
 * timeout) the connection test SHALL produce exactly one
 * ConnectionTestResult.kind from the allowed set {success, auth-failure,
 * connectivity-failure, timeout, missing-settings}; and for any settings with
 * at least one empty required field, the result SHALL be missing-settings and
 * the Transport SHALL never be invoked.
 *
 * Validates: Requirements 3.6, 3.7
 */

/** The exhaustive set of allowed ConnectionTestResult.kind values (Req 3.6). */
const ALLOWED_KINDS = [
  "success",
  "auth-failure",
  "connectivity-failure",
  "timeout",
  "missing-settings",
] as const;

/** A valid, well-formed (empty) 207 Multistatus body for the success path. */
const EMPTY_MULTISTATUS = render({ entries: [] });

/** Ensure a generated credential is not empty/whitespace so it passes the gate. */
function nonBlank(value: string): string {
  return value.trim() === "" ? "x" : value;
}

/** Settings whose required fields are all populated (pass the missing gate). */
const validSettingsArb: fc.Arbitrary<ConnectionSettings> = fc.record({
  endpoint: fc.constantFrom(
    "http://nas.example.com",
    "https://nas.example.com:5006/dav",
    "https://synology.local/remote.php/dav/",
    "http://192.168.1.10:5005",
  ),
  username: fc.string({ minLength: 1, maxLength: 255 }).map(nonBlank),
  password: fc.string({ minLength: 1, maxLength: 255 }).map(nonBlank),
});

/**
 * A tagged simulated transport outcome plus the ConnectionTestResult.kind the
 * connection test must produce for it.
 */
type Outcome = {
  /** The scripted response the FakeTransport returns for the PROPFIND call. */
  scripted: ScriptedResponse;
  /** The single expected result kind. */
  expected: (typeof ALLOWED_KINDS)[number];
};

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  // success: a 2xx / 207 Multi-Status response.
  fc.constantFrom(200, 201, 204, 207).map((status) => ({
    scripted: okResponse(EMPTY_MULTISTATUS, status),
    expected: "success" as const,
  })),
  // auth-failure: 401 Unauthorized.
  fc.constant({
    scripted: unauthorizedResponse(),
    expected: "auth-failure" as const,
  }),
  // timeout: a rejection whose error name marks it a transport timeout.
  fc.constant({
    scripted: {
      reject: Object.assign(new Error("timed out"), {
        name: "TransportTimeoutError",
      }),
    },
    expected: "timeout" as const,
  }),
  // connectivity-failure via a transport-level rejection (unreachable host).
  fc.constant({
    scripted: { reject: new Error("ECONNREFUSED") },
    expected: "connectivity-failure" as const,
  }),
  // connectivity-failure via a reachable server returning a non-2xx/non-207
  // status that is neither 401 (auth) nor a redirect (3xx).
  fc.constantFrom(400, 403, 404, 500, 502, 503).map((status) => ({
    scripted: okResponse("", status),
    expected: "connectivity-failure" as const,
  })),
);

describe("WebDAVClient.testConnection results (Property 12)", () => {
  it("produces exactly one allowed result kind matching each simulated transport outcome (Req 3.6)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validSettingsArb,
        outcomeArb,
        async (settings, outcome) => {
          const transport = new FakeTransport().setDefault(outcome.scripted);
          const client = new WebDAVClient(settings, transport);

          const result = await client.testConnection();

          // Exactly one result is produced and its kind is in the allowed set.
          expect(ALLOWED_KINDS).toContain(result.kind);
          // The kind matches the kind the simulated outcome should map to.
          expect(result.kind).toBe(outcome.expected);
          // A populated-settings test does reach the Transport.
          expect(transport.callCount).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns missing-settings without invoking the Transport when a required field is empty (Req 3.7)", async () => {
    // Generates settings where at least one required field is empty/whitespace.
    const blankArb = fc.constantFrom("", " ", "   ", "\t", "\n", "  \t ");
    const maybeBlankArb = fc.oneof(
      blankArb,
      fc.string({ minLength: 1, maxLength: 32 }).map(nonBlank),
    );
    const incompleteSettingsArb = fc
      .record({
        endpoint: maybeBlankArb,
        username: maybeBlankArb,
        password: maybeBlankArb,
      })
      .filter(
        (s) =>
          s.endpoint.trim() === "" ||
          s.username.trim() === "" ||
          s.password.trim() === "",
      );

    await fc.assert(
      fc.asyncProperty(incompleteSettingsArb, async (settings) => {
        // A default is set so any (unexpected) call would resolve, yet the gate
        // must prevent the Transport from ever being invoked.
        const transport = new FakeTransport().setDefault(
          okResponse(EMPTY_MULTISTATUS, 207),
        );
        const client = new WebDAVClient(settings, transport);

        const result = await client.testConnection();

        // Req 3.7: missing-settings result, and the Transport is never invoked.
        expect(result.kind).toBe("missing-settings");
        expect(transport.callCount).toBe(0);
        // The kind is still within the allowed set (Req 3.6).
        expect(ALLOWED_KINDS).toContain(result.kind);
      }),
      { numRuns: 100 },
    );
  });
});
