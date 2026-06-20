import { describe, it, expect, vi } from "vitest";

import {
  WebDavSyncSettingTab,
  loadConnectionSettings,
  runConnectionTest,
  EMPTY_CONNECTION_SETTINGS,
  TEST_CONNECTION_LABEL,
  CHOOSE_REMOTE_FOLDER_LABEL,
  type ConnectionTestClient,
  type FolderBrowserClientFactory,
} from "./settingsTab";
import {
  FolderBrowserModal,
  USE_THIS_FOLDER_LABEL,
} from "./folderBrowserModal";
import type { FolderBrowserClient } from "./folderBrowserController";
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

  describe("connection settings survive a folder selection (regression)", () => {
    /** Click the first enabled button whose visible text equals `label`. */
    function clickButton(root: HTMLElement, label: string): void {
      const button = Array.from(
        root.querySelectorAll<HTMLButtonElement>("button"),
      ).find((el) => el.textContent === label && !el.disabled);
      if (button === undefined) {
        throw new Error(`No enabled button labelled "${label}" was found.`);
      }
      button.click();
    }

    /** Set an input's value and fire the `input` event the stub listens for. */
    function typeInto(input: HTMLInputElement, value: string): void {
      input.value = value;
      input.dispatchEvent(new Event("input"));
    }

    it("keeps the entered (unsaved) server URL, username, and password after selecting a remote folder", async () => {
      // Regression: re-rendering after a folder selection must not reload the
      // draft from the (empty) store, which previously wiped the fields.
      const store = new CredentialStore(makeDataStore());

      // A connection-test client that always succeeds, so the folder browser
      // control becomes enabled for the entered settings.
      const testFactory = (): ConnectionTestClient => ({
        async testConnection(): Promise<ConnectionTestResult> {
          return { kind: "success", message: "Connection succeeded." };
        },
      });

      // A folder-browser client that lists an empty root and accepts creates.
      const folderClient: FolderBrowserClient = {
        async listFolders(path: string) {
          return { path, folders: [] };
        },
        async makeCollection(): Promise<void> {},
      };
      const folderFactory: FolderBrowserClientFactory = () => folderClient;

      const tab = new WebDavSyncSettingTab(
        makeApp(),
        makePlugin(),
        store,
        testFactory,
        folderFactory,
      );

      tab.display();
      await flush();

      // The user types settings into the fields but never clicks "Save".
      const urlInput = tab.containerEl.querySelector<HTMLInputElement>(
        'input[type="url"]',
      )!;
      const passwordInput = tab.containerEl.querySelector<HTMLInputElement>(
        'input[type="password"]',
      )!;
      const usernameInput = Array.from(
        tab.containerEl.querySelectorAll<HTMLInputElement>("input"),
      ).find((el) => el.type !== "url" && el.type !== "password")!;

      typeInto(urlInput, STORED_SETTINGS.endpoint);
      typeInto(usernameInput, STORED_SETTINGS.username);
      typeInto(passwordInput, STORED_SETTINGS.password);

      // A successful connection test enables "Choose remote folder".
      clickButton(tab.containerEl, TEST_CONNECTION_LABEL);
      await flush();

      // Capture the modal instance opened by the tab so we can drive it.
      let modal: FolderBrowserModal | undefined;
      const realOpen = FolderBrowserModal.prototype.open;
      const openSpy = vi
        .spyOn(FolderBrowserModal.prototype, "open")
        .mockImplementation(function (this: FolderBrowserModal) {
          modal = this;
          return realOpen.call(this);
        });

      clickButton(tab.containerEl, CHOOSE_REMOTE_FOLDER_LABEL);
      await flush();

      expect(modal).toBeDefined();

      // Select the currently-browsed folder (the server root).
      clickButton(modal!.contentEl, USE_THIS_FOLDER_LABEL);
      await flush();

      openSpy.mockRestore();

      // The location was persisted.
      expect(await store.loadVaultLocation()).toBe("");

      // The connection fields, re-rendered after the selection, still hold the
      // values the user entered — they were not wiped by a store reload.
      const urlAfter = tab.containerEl.querySelector<HTMLInputElement>(
        'input[type="url"]',
      );
      const passwordAfter = tab.containerEl.querySelector<HTMLInputElement>(
        'input[type="password"]',
      );
      const usernameAfter = Array.from(
        tab.containerEl.querySelectorAll<HTMLInputElement>("input"),
      ).find((el) => el.type !== "url" && el.type !== "password");

      expect(urlAfter?.value).toBe(STORED_SETTINGS.endpoint);
      expect(usernameAfter?.value).toBe(STORED_SETTINGS.username);
      expect(passwordAfter?.value).toBe(STORED_SETTINGS.password);
    });
  });
});
