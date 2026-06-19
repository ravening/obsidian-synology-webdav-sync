import { describe, it, expect } from "vitest";

import {
  WebDavSyncSettingTab,
  loadConnectionSettings,
  runConnectionTest,
  EMPTY_CONNECTION_SETTINGS,
  type ConnectionTestClient,
} from "./settingsTab";
import {
  CredentialStore,
  type DataStore,
} from "../persistence/credentialStore";
import type {
  ConnectionSettings,
  ConnectionTestResult,
} from "../core/types";
import { App, Plugin } from "obsidian";

/**
 * The published `obsidian` types declare `App` and `Plugin` as abstract, but
 * the test stub (test/__mocks__/obsidian.ts) provides concrete implementations
 * at runtime. These factories construct the stub instances while satisfying the
 * abstract type declarations under `tsc`.
 */
const makeApp = (): App => new (App as unknown as new () => App)();
const makePlugin = (): Plugin => new (Plugin as unknown as new () => Plugin)();

/**
 * Unit tests for the Settings UI (Req 2.3, 2.6, 3.8).
 *
 * The behavioral requirements are exercised through the settings tab and its
 * extracted helpers:
 * - Password masking (Req 2.3) is checked by rendering the real tab via
 *   {@link WebDavSyncSettingTab.display} (against minimal Obsidian DOM stubs)
 *   and asserting the rendered password input uses `type="password"`.
 * - Loading stored settings on open (Req 2.6) is checked both at the helper
 *   level ({@link loadConnectionSettings}) and by asserting `display()`
 *   populates the field values from the store.
 * - The disable-while-running guarantee (Req 3.8) is checked through
 *   {@link runConnectionTest}, whose `setRunning` callback is the single source
 *   the button wiring observes to disable itself.
 */

/** An in-memory {@link DataStore} backing a {@link CredentialStore} in tests. */
function makeDataStore(initial: unknown = null): DataStore {
  let data: unknown = initial;
  return {
    async saveData(value: unknown): Promise<void> {
      data = value;
    },
    async loadData(): Promise<unknown> {
      return data;
    },
  };
}

/** Flush pending microtasks/timers so async `display()` rendering completes. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const STORED_SETTINGS: ConnectionSettings = {
  endpoint: "https://nas.example.com:5006",
  username: "alice",
  password: "s3cret-pw",
};

describe("Settings UI", () => {
  describe("password field masking (Req 2.3)", () => {
    it("renders the password input with type 'password' so characters are masked", async () => {
      // Validates: Requirements 2.3
      const store = new CredentialStore(makeDataStore());
      const tab = new WebDavSyncSettingTab(makeApp(), makePlugin(), store);

      tab.display();
      await flush();

      const passwordInputs = tab.containerEl.querySelectorAll(
        'input[type="password"]',
      );
      // Exactly the password field is masked.
      expect(passwordInputs).toHaveLength(1);
      // The endpoint and username fields are not masked.
      expect(
        tab.containerEl.querySelectorAll('input[type="password"]').length,
      ).toBeLessThan(tab.containerEl.querySelectorAll("input").length);
    });
  });

  describe("loading stored settings on open (Req 2.6)", () => {
    it("loadConnectionSettings returns the stored settings", async () => {
      // Validates: Requirements 2.6
      const dataStore = makeDataStore();
      const store = new CredentialStore(dataStore);
      await store.save(STORED_SETTINGS);

      const loaded = await loadConnectionSettings(store);

      expect(loaded).toEqual(STORED_SETTINGS);
      // The returned object is a fresh copy the tab can mutate freely.
      loaded.endpoint = "mutated";
      const reloaded = await loadConnectionSettings(store);
      expect(reloaded.endpoint).toBe(STORED_SETTINGS.endpoint);
    });

    it("loadConnectionSettings returns empty defaults when nothing is stored", async () => {
      // Validates: Requirements 2.6
      const store = new CredentialStore(makeDataStore());

      const loaded = await loadConnectionSettings(store);

      expect(loaded).toEqual(EMPTY_CONNECTION_SETTINGS);
    });

    it("display() populates the input fields from the stored settings", async () => {
      // Validates: Requirements 2.6
      const store = new CredentialStore(makeDataStore());
      await store.save(STORED_SETTINGS);
      const tab = new WebDavSyncSettingTab(makeApp(), makePlugin(), store);

      tab.display();
      await flush();

      const urlInput = tab.containerEl.querySelector<HTMLInputElement>(
        'input[type="url"]',
      );
      const passwordInput = tab.containerEl.querySelector<HTMLInputElement>(
        'input[type="password"]',
      );
      // The username field is the remaining (default-type) text input.
      const textInputs = Array.from(
        tab.containerEl.querySelectorAll<HTMLInputElement>("input"),
      ).filter((el) => el.type !== "url" && el.type !== "password");

      expect(urlInput?.value).toBe(STORED_SETTINGS.endpoint);
      expect(passwordInput?.value).toBe(STORED_SETTINGS.password);
      expect(textInputs.map((el) => el.value)).toContain(
        STORED_SETTINGS.username,
      );
    });
  });

  describe("Test Connection disables while running (Req 3.8)", () => {
    const SUCCESS: ConnectionTestResult = {
      kind: "success",
      message: "Connection succeeded.",
    };

    /**
     * A fake client whose `testConnection` returns a pending promise the test
     * resolves/rejects manually, so the running window can be inspected.
     */
    function makeDeferredClient(): {
      client: ConnectionTestClient;
      resolve: (result: ConnectionTestResult) => void;
      reject: (error: unknown) => void;
      started: () => boolean;
    } {
      let resolveFn!: (result: ConnectionTestResult) => void;
      let rejectFn!: (error: unknown) => void;
      let started = false;
      const pending = new Promise<ConnectionTestResult>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      return {
        client: {
          testConnection(): Promise<ConnectionTestResult> {
            started = true;
            return pending;
          },
        },
        resolve: resolveFn,
        reject: rejectFn,
        started: () => started,
      };
    }

    it("signals running=true before the test resolves and running=false after", async () => {
      // Validates: Requirements 3.8
      const { client, resolve } = makeDeferredClient();
      const states: boolean[] = [];

      const runPromise = runConnectionTest(client, (running) => {
        states.push(running);
      });

      // The test is in flight: running was signalled true and not yet false.
      await flush();
      expect(states).toEqual([true]);

      resolve(SUCCESS);
      const result = await runPromise;

      // After settling, running was signalled false.
      expect(states).toEqual([true, false]);
      expect(result).toEqual(SUCCESS);
    });

    it("re-enables (running=false) even when the test rejects", async () => {
      // Validates: Requirements 3.8
      const { client, reject } = makeDeferredClient();
      const states: boolean[] = [];

      const runPromise = runConnectionTest(client, (running) => {
        states.push(running);
      });

      await flush();
      expect(states).toEqual([true]);

      const failure = new Error("network down");
      reject(failure);

      await expect(runPromise).rejects.toBe(failure);
      // The running flag is cleared in the finally block on rejection too.
      expect(states).toEqual([true, false]);
    });

    it("does not invoke the client until the run begins", async () => {
      // Validates: Requirements 3.8
      const { client, resolve, started } = makeDeferredClient();

      expect(started()).toBe(false);
      const runPromise = runConnectionTest(client, () => {});
      expect(started()).toBe(true);

      resolve(SUCCESS);
      await runPromise;
    });
  });
});
