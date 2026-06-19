import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { SyncEngine } from "./index";
import type {
  LocalVault,
  SyncEngineClient,
  SyncEngineOptions,
} from "./index";
import type { Notifier } from "./index";
import type { ConnectionSettings } from "../core/types";
import { validateSettings } from "../core/validateSettings";

/**
 * Property-based test for the fetch-on-open settings gate.
 *
 * Feature: obsidian-synology-webdav-sync, Property 14: For any ConnectionSettings
 * missing one or more required fields, fetchOnOpen() SHALL make no Transport
 * calls and SHALL perform no vault writes (the vault is left unchanged).
 *
 * Validates: Requirements 7.7
 *
 * The engine gates fetch-on-open on `validateSettings` (a pure check). When the
 * resolved settings are missing entirely (no settings configured) or invalid,
 * `fetchOnOpen()` must return immediately without touching either dependency.
 * To prove that, the LocalVault and SyncEngineClient fakes below record every
 * method invocation and throw loudly if ever called; the assertion is that the
 * total recorded call count is exactly zero.
 */
describe("SyncEngine.fetchOnOpen settings gate (Property 14)", () => {
  /** A LocalVault/SyncEngineClient pair that records and rejects every call. */
  function buildRecordingWorld() {
    let calls = 0;
    const log: string[] = [];

    const record = (method: string): never => {
      calls += 1;
      log.push(method);
      // Fail loudly: the gate must short-circuit before any dependency is used.
      throw new Error(
        `fetchOnOpen unexpectedly invoked ${method} despite invalid settings`,
      );
    };

    const localVault: LocalVault = {
      async listFiles() {
        return record("LocalVault.listFiles");
      },
      async readFile() {
        return record("LocalVault.readFile");
      },
      async writeFile() {
        return record("LocalVault.writeFile");
      },
    };

    const client: SyncEngineClient = {
      async listTree() {
        return record("SyncEngineClient.listTree");
      },
      async getFile() {
        return record("SyncEngineClient.getFile");
      },
      async putFile() {
        return record("SyncEngineClient.putFile");
      },
      async deleteFile() {
        return record("SyncEngineClient.deleteFile");
      },
      async moveFile() {
        return record("SyncEngineClient.moveFile");
      },
    };

    // The notifier must also stay untouched: gating happens before any work,
    // so there is no failure to report (Req 7.7, distinct from 7.5/7.6).
    let notifyCalls = 0;
    const notifier: Notifier = {
      notify() {
        notifyCalls += 1;
      },
    };

    return {
      localVault,
      client,
      notifier,
      callCount: () => calls,
      notifyCount: () => notifyCalls,
      log,
    };
  }

  // -- Generators of invalid / missing settings -----------------------------

  // Otherwise-valid field values used to isolate a single defect.
  const VALID_ENDPOINT = "https://nas.example.com";
  const VALID_USERNAME = "user";
  const VALID_PASSWORD = "pass";

  /** Endpoints that do not begin with http:// or https://. */
  const badSchemeEndpointArb: fc.Arbitrary<string> = fc.constantFrom(
    "ftp://nas.example.com",
    "ws://nas.example.com",
    "nas.example.com",
    "//nas.example.com",
    "httpx://nas.example.com",
    "file:///etc/hosts",
    " https://nas.example.com", // leading space defeats the ^https?:// anchor
  );

  // Endpoints with a scheme but no host component. Note the WHATWG `URL`
  // parser collapses extra slashes, so `http:///some/resource` is parsed as
  // host `some` (and is therefore valid); only a bare scheme is truly
  // host-less.
  const missingHostEndpointArb: fc.Arbitrary<string> = fc.constantFrom(
    "https://",
    "http://",
  );

  /** A string strictly longer than `len` characters. */
  const overLength = (prefix: string, len: number, extra: number): string =>
    prefix + "a".repeat(len - prefix.length + extra);

  /**
   * A single-defect invalid `ConnectionSettings`. Each branch keeps the other
   * fields valid so the named defect is the sole reason for rejection.
   */
  const invalidSettingsArb: fc.Arbitrary<ConnectionSettings> = fc.oneof(
    // endpoint: empty
    fc.constant<ConnectionSettings>({
      endpoint: "",
      username: VALID_USERNAME,
      password: VALID_PASSWORD,
    }),
    // endpoint: bad scheme
    badSchemeEndpointArb.map((endpoint) => ({
      endpoint,
      username: VALID_USERNAME,
      password: VALID_PASSWORD,
    })),
    // endpoint: missing host
    missingHostEndpointArb.map((endpoint) => ({
      endpoint,
      username: VALID_USERNAME,
      password: VALID_PASSWORD,
    })),
    // endpoint: over 2048 chars
    fc.integer({ min: 1, max: 200 }).map((extra) => ({
      endpoint: overLength("https://nas.example.com/", 2048, extra),
      username: VALID_USERNAME,
      password: VALID_PASSWORD,
    })),
    // username: empty
    fc.constant<ConnectionSettings>({
      endpoint: VALID_ENDPOINT,
      username: "",
      password: VALID_PASSWORD,
    }),
    // username: over 255 chars
    fc.integer({ min: 1, max: 200 }).map((extra) => ({
      endpoint: VALID_ENDPOINT,
      username: "u".repeat(255 + extra),
      password: VALID_PASSWORD,
    })),
    // password: empty
    fc.constant<ConnectionSettings>({
      endpoint: VALID_ENDPOINT,
      username: VALID_USERNAME,
      password: "",
    }),
    // password: over 255 chars
    fc.integer({ min: 1, max: 200 }).map((extra) => ({
      endpoint: VALID_ENDPOINT,
      username: VALID_USERNAME,
      password: "p".repeat(255 + extra),
    })),
    // multiple defects at once (all fields bad)
    fc.constant<ConnectionSettings>({
      endpoint: "not-a-url",
      username: "",
      password: "",
    }),
  );

  /**
   * How the (invalid or absent) settings are injected into the engine. This
   * covers both the construction-time `settings` option and the dynamic
   * `getSettings` provider, including the "no settings configured" cases where
   * settings are `null`/`undefined`.
   */
  type Injection =
    | { tag: "invalid-via-settings"; settings: ConnectionSettings }
    | { tag: "invalid-via-getSettings"; settings: ConnectionSettings }
    | { tag: "settings-null" }
    | { tag: "getSettings-null" }
    | { tag: "getSettings-undefined" };

  const injectionArb: fc.Arbitrary<Injection> = fc.oneof(
    invalidSettingsArb.map(
      (settings): Injection => ({ tag: "invalid-via-settings", settings }),
    ),
    invalidSettingsArb.map(
      (settings): Injection => ({ tag: "invalid-via-getSettings", settings }),
    ),
    fc.constant<Injection>({ tag: "settings-null" }),
    fc.constant<Injection>({ tag: "getSettings-null" }),
    fc.constant<Injection>({ tag: "getSettings-undefined" }),
  );

  function optionsFor(
    injection: Injection,
    notifier: Notifier,
  ): SyncEngineOptions {
    switch (injection.tag) {
      case "invalid-via-settings":
        return { settings: injection.settings, notifier };
      case "invalid-via-getSettings":
        return { getSettings: () => injection.settings, notifier };
      case "settings-null":
        return { settings: null, notifier };
      case "getSettings-null":
        return { getSettings: () => null, notifier };
      case "getSettings-undefined":
        return { getSettings: () => undefined, notifier };
    }
  }

  it("makes no client calls and no vault writes when settings are missing or invalid", async () => {
    await fc.assert(
      fc.asyncProperty(injectionArb, async (injection) => {
        // Sanity: any injected settings really are rejected by the gate, so a
        // passing test reflects the gate working — not an accidentally valid input.
        if (
          injection.tag === "invalid-via-settings" ||
          injection.tag === "invalid-via-getSettings"
        ) {
          expect(validateSettings(injection.settings).valid).toBe(false);
        }

        const world = buildRecordingWorld();
        const engine = new SyncEngine(
          world.client,
          world.localVault,
          optionsFor(injection, world.notifier),
        );

        // Must resolve without throwing and without touching any dependency.
        await expect(engine.fetchOnOpen()).resolves.toBeUndefined();

        // Zero client calls (listTree/getFile/putFile/...) and zero vault
        // calls (listFiles/readFile/writeFile): the engine never touched
        // either dependency (Req 7.7).
        expect(world.callCount()).toBe(0);
        expect(world.log).toEqual([]);
        // Gating precedes any failure path, so nothing is reported either.
        expect(world.notifyCount()).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
