import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CONNECTION_SETTINGS_KEY,
  CredentialStore,
  type DataStore,
} from "./index";
import type { ConnectionSettings } from "../core/types";

/**
 * In-memory {@link DataStore} fake.
 *
 * Mirrors Obsidian's `saveData()` / `loadData()` by holding the plugin data
 * object in a single field. `saveData` overwrites it; `loadData` returns
 * whatever was last written (or `null` when nothing has been stored yet). No
 * cloning is performed, matching the contract the credential store relies on.
 */
function createInMemoryStore(initial: unknown = null): DataStore {
  let data: unknown = initial;
  return {
    async saveData(next: unknown): Promise<void> {
      data = next;
    },
    async loadData(): Promise<unknown> {
      return data;
    },
  };
}

/**
 * Arbitrary {@link ConnectionSettings}. The three fields are plain strings,
 * which is the only shape the credential store persists and reads back. Using
 * unconstrained strings (including empty ones) is stronger than restricting to
 * "valid" settings, since the store persists whatever it is given.
 */
const connectionSettingsArb: fc.Arbitrary<ConnectionSettings> = fc.record({
  endpoint: fc.string(),
  username: fc.string(),
  password: fc.string(),
});

describe("CredentialStore round-trip", () => {
  // Feature: obsidian-synology-webdav-sync, Property 11: For any valid ConnectionSettings, persisting them via the credential store and then loading them SHALL return settings equal to those saved.
  // Validates: Requirements 2.4
  it("returns saved settings unchanged after save then load", async () => {
    await fc.assert(
      fc.asyncProperty(connectionSettingsArb, async (settings) => {
        const store = new CredentialStore(createInMemoryStore());

        await store.save(settings);
        const loaded = await store.load();

        expect(loaded).toEqual(settings);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: obsidian-synology-webdav-sync, Property 11: For any valid ConnectionSettings, persisting them via the credential store and then loading them SHALL return settings equal to those saved.
  // Validates: Requirements 2.4
  it("preserves unrelated keys already present in the data object", async () => {
    await fc.assert(
      fc.asyncProperty(
        connectionSettingsArb,
        // An arbitrary pre-existing data object that must survive the save.
        fc.dictionary(
          fc.string().filter((k) => k !== CONNECTION_SETTINGS_KEY),
          fc.jsonValue(),
        ),
        async (settings, otherData) => {
          const backend = createInMemoryStore({ ...otherData });
          const store = new CredentialStore(backend);

          await store.save(settings);

          // Settings still round-trip.
          expect(await store.load()).toEqual(settings);

          // Unrelated keys are merged through untouched.
          const persisted = (await backend.loadData()) as Record<
            string,
            unknown
          >;
          for (const [key, value] of Object.entries(otherData)) {
            expect(persisted[key]).toEqual(value);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
