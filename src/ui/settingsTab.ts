/**
 * Settings UI tab.
 *
 * Renders the WebDAV connection fields (server endpoint, username, masked
 * password) inside an Obsidian {@link PluginSettingTab}, validates input on
 * save with {@link validateSettings}, persists valid settings through the
 * {@link CredentialStore} with a confirmation notice, rejects invalid input
 * with a field-identifying message, and loads any stored settings back into
 * the fields when the tab is opened. It also provides a "Test Connection"
 * button that runs the WebDAV client's `testConnection`, indicates the running
 * state, disables itself while the test runs to block a concurrent test, and
 * shows a single result message (Req 3.1, 3.2, 3.6, 3.8).
 *
 * The DOM rendering lives in {@link WebDavSyncSettingTab.display}, but the
 * pieces that carry the behavioral requirements — loading stored settings into
 * field values, the validate-then-save handler, and the running-state gated
 * connection test — are factored into the pure helpers {@link
 * loadConnectionSettings}, {@link saveConnectionSettings}, and {@link
 * runConnectionTest} so they can be unit-tested without a live Obsidian DOM
 * (task 18.3).
 *
 * _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.6, 3.8_
 */

import {
  App,
  type ButtonComponent,
  Notice,
  PluginSettingTab,
  Setting,
  type Plugin,
} from "obsidian";

import type { ConnectionSettings, ConnectionTestResult } from "../core/types";
import {
  MAX_CREDENTIAL_LENGTH,
  MAX_ENDPOINT_LENGTH,
  validateSettings,
} from "../core/validateSettings";
import { CredentialStore } from "../persistence/credentialStore";
import { WebDAVClient } from "../client";
import { RequestUrlTransport } from "../transport";

/**
 * The confirmation message shown after connection settings are saved
 * successfully (Req 2.5).
 */
export const SETTINGS_SAVED_MESSAGE = "Connection settings saved.";

/**
 * An empty set of connection settings, used as the initial field state when no
 * settings have been stored yet.
 */
export const EMPTY_CONNECTION_SETTINGS: ConnectionSettings = {
  endpoint: "",
  username: "",
  password: "",
};

/**
 * The outcome of attempting to save connection settings.
 *
 * On success the settings were validated and persisted. On failure the
 * candidate was rejected by validation; `field` identifies the offending input
 * and `message` is a UI-ready, field-identifying validation message. A failure
 * never touches the credential store, so the previously stored settings are
 * left unchanged (Req 2.7, 2.8).
 */
export type SaveSettingsResult =
  | { saved: true; message: string }
  | {
      saved: false;
      field: "endpoint" | "username" | "password";
      message: string;
    };

/**
 * Load the stored connection settings into a plain field-value object (Req 2.6).
 *
 * Reads the credential store and returns the persisted {@link
 * ConnectionSettings}, or {@link EMPTY_CONNECTION_SETTINGS} when nothing has
 * been stored yet. The returned object is a fresh copy that the settings tab
 * can mutate freely as the user edits the fields, so this is the single source
 * of truth for populating the inputs on open.
 *
 * @param store The credential store to read from.
 * @returns The stored settings, or empty defaults when none exist.
 */
export async function loadConnectionSettings(
  store: CredentialStore,
): Promise<ConnectionSettings> {
  const stored = await store.load();
  if (stored === null) {
    return { ...EMPTY_CONNECTION_SETTINGS };
  }
  return {
    endpoint: stored.endpoint,
    username: stored.username,
    password: stored.password,
  };
}

/**
 * Validate a candidate and, only if it is valid, persist it (Req 2.4, 2.7, 2.8).
 *
 * Runs {@link validateSettings} first. If the candidate is invalid the
 * credential store is never written — the stored settings are left unchanged —
 * and the offending field plus a field-identifying message are returned. If
 * the candidate is valid it is persisted through the store and a confirmation
 * message is returned (Req 2.5).
 *
 * This is the testable core of the save action: it has no dependency on the
 * Obsidian DOM, so a unit test can drive it with valid and invalid candidates
 * and an in-memory credential store.
 *
 * @param candidate The connection settings entered by the user.
 * @param store The credential store to persist to on success.
 * @returns A {@link SaveSettingsResult} describing success or the rejection.
 */
export async function saveConnectionSettings(
  candidate: ConnectionSettings,
  store: CredentialStore,
): Promise<SaveSettingsResult> {
  const validation = validateSettings(candidate);
  if (!validation.valid) {
    return {
      saved: false,
      field: validation.field,
      message: validation.message,
    };
  }
  await store.save(candidate);
  return { saved: true, message: SETTINGS_SAVED_MESSAGE };
}

/**
 * The idle label of the Test Connection button (Req 3.1).
 */
export const TEST_CONNECTION_LABEL = "Test connection";

/**
 * The label shown on the Test Connection button while a test is in progress,
 * which indicates the running state to the user (Req 3.8).
 */
export const TEST_CONNECTION_RUNNING_LABEL = "Testing…";

/**
 * The minimal client surface the Test Connection control depends on: a single
 * {@link ConnectionTestClient.testConnection} call that returns exactly one
 * {@link ConnectionTestResult} (Req 3.6). Narrowing the dependency to this
 * interface lets a unit test supply a fake without constructing a real
 * {@link WebDAVClient} or transport (task 18.3).
 */
export interface ConnectionTestClient {
  testConnection(): Promise<ConnectionTestResult>;
}

/**
 * Builds a {@link ConnectionTestClient} from the connection settings currently
 * entered in the fields. Injecting this factory into the settings tab lets a
 * test substitute a fake client/transport while production uses
 * {@link defaultConnectionTestClientFactory}.
 */
export type ConnectionTestClientFactory = (
  settings: ConnectionSettings,
) => ConnectionTestClient;

/**
 * The default factory: a production {@link WebDAVClient} bound to the entered
 * settings and the `requestUrl()`-backed {@link RequestUrlTransport}, which is
 * the single networking path used on both desktop and mobile.
 */
export const defaultConnectionTestClientFactory: ConnectionTestClientFactory = (
  settings,
) => new WebDAVClient(settings, new RequestUrlTransport());

/**
 * Run a connection test while signalling the running state (Req 3.8).
 *
 * This is the testable core of the Test Connection control: it flips the
 * running flag on before awaiting {@link ConnectionTestClient.testConnection}
 * and off again in a `finally` block, so the disable→run→re-enable sequence
 * holds even when the test rejects. The button wiring observes the flag via the
 * `setRunning` callback (disabling the button while `running` is true to block a
 * second concurrent test), and the single returned {@link ConnectionTestResult}
 * is surfaced as exactly one user-visible message (Req 3.6).
 *
 * @param client The client whose `testConnection` is invoked.
 * @param setRunning Called with `true` before the test and `false` after it.
 * @returns The single connection-test result.
 */
export async function runConnectionTest(
  client: ConnectionTestClient,
  setRunning: (running: boolean) => void,
): Promise<ConnectionTestResult> {
  setRunning(true);
  try {
    return await client.testConnection();
  } finally {
    setRunning(false);
  }
}

/**
 * The Obsidian settings tab for the plugin.
 *
 * Renders the connection fields and wires the save action to {@link
 * saveConnectionSettings}. The masked password input is produced by setting the
 * native input type to `password` (Req 2.3). On open, {@link display} populates
 * the fields from the credential store via {@link loadConnectionSettings}
 * (Req 2.6). A "Test Connection" button invokes the WebDAV client's
 * `testConnection`, disables itself while the test runs to prevent a concurrent
 * test, and surfaces a single result message (Req 3.1, 3.2, 3.6, 3.8).
 */
export class WebDavSyncSettingTab extends PluginSettingTab {
  private readonly store: CredentialStore;

  /**
   * The working copy of the settings bound to the input fields. Edits update
   * this draft; it is read by the save handler and is never written to the
   * store until validation passes.
   */
  private draft: ConnectionSettings = { ...EMPTY_CONNECTION_SETTINGS };

  /**
   * Builds the {@link ConnectionTestClient} used by the Test Connection button
   * from the current draft settings. Injected so a test can supply a fake;
   * defaults to a production client over the `requestUrl()` transport.
   */
  private readonly clientFactory: ConnectionTestClientFactory;

  constructor(
    app: App,
    plugin: Plugin,
    store: CredentialStore,
    clientFactory: ConnectionTestClientFactory = defaultConnectionTestClientFactory,
  ) {
    super(app, plugin);
    this.store = store;
    this.clientFactory = clientFactory;
  }

  /**
   * Build the settings UI and load any stored settings into the fields (Req 2.6).
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Render the fields from empty defaults first so the UI is responsive,
    // then asynchronously load the stored settings and populate them.
    this.draft = { ...EMPTY_CONNECTION_SETTINGS };
    void this.renderFields();
  }

  /**
   * Load stored settings, then render the connection fields and save control.
   */
  private async renderFields(): Promise<void> {
    this.draft = await loadConnectionSettings(this.store);

    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "WebDAV connection" });

    // --- Server endpoint URL (Req 2.1) ---
    new Setting(containerEl)
      .setName("Server endpoint URL")
      .setDesc('Your Synology WebDAV address, e.g. "https://nas.example.com:5006".')
      .addText((text) => {
        text.inputEl.type = "url";
        text.inputEl.maxLength = MAX_ENDPOINT_LENGTH;
        text
          .setPlaceholder("https://nas.example.com:5006")
          .setValue(this.draft.endpoint)
          .onChange((value) => {
            this.draft.endpoint = value;
          });
      });

    // --- Username (Req 2.2) ---
    new Setting(containerEl)
      .setName("Username")
      .setDesc("Your Synology WebDAV account username.")
      .addText((text) => {
        text.inputEl.maxLength = MAX_CREDENTIAL_LENGTH;
        text
          .setPlaceholder("username")
          .setValue(this.draft.username)
          .onChange((value) => {
            this.draft.username = value;
          });
      });

    // --- Password (Req 2.3) ---
    new Setting(containerEl)
      .setName("Password")
      .setDesc("Stored on this device. Obsidian plugin data is not encrypted at rest.")
      .addText((text) => {
        // Mask the entered characters (Req 2.3).
        text.inputEl.type = "password";
        text.inputEl.maxLength = MAX_CREDENTIAL_LENGTH;
        text
          .setPlaceholder("password")
          .setValue(this.draft.password)
          .onChange((value) => {
            this.draft.password = value;
          });
      });

    // --- Save control (Req 2.4, 2.5, 2.7, 2.8) ---
    new Setting(containerEl).addButton((button) => {
      button
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          void this.handleSave();
        });
    });

    // --- Test Connection control (Req 3.1, 3.2, 3.6, 3.8) ---
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc(
        "Check that the server is reachable and your credentials authenticate.",
      )
      .addButton((button) => {
        button.setButtonText(TEST_CONNECTION_LABEL).onClick(() => {
          void this.handleTestConnection(button);
        });
      });
  }

  /**
   * Validate and persist the current draft, surfacing the result to the user.
   *
   * Delegates to {@link saveConnectionSettings}; on success shows the
   * confirmation notice (Req 2.5), on failure shows the field-identifying
   * validation message (Req 2.7, 2.8).
   */
  private async handleSave(): Promise<void> {
    const result = await saveConnectionSettings(this.draft, this.store);
    new Notice(result.message);
  }

  /**
   * Run a connection test for the current draft settings and surface the
   * single result to the user (Req 3.1, 3.2, 3.6, 3.8).
   *
   * Builds a client from the entered settings via the injected factory, then
   * delegates the disable→run→re-enable sequence to {@link runConnectionTest}.
   * The `setRunning` callback disables the button and switches its label while
   * the test is in flight, which both indicates the running state and prevents
   * a second concurrent test (Req 3.8); it is re-enabled when the test settles.
   * Exactly one {@link ConnectionTestResult} message is shown as a notice
   * (Req 3.6).
   */
  private async handleTestConnection(button: ButtonComponent): Promise<void> {
    const client = this.clientFactory({ ...this.draft });
    const result = await runConnectionTest(client, (running) => {
      button.setDisabled(running);
      button.setButtonText(
        running ? TEST_CONNECTION_RUNNING_LABEL : TEST_CONNECTION_LABEL,
      );
    });
    new Notice(result.message);
  }
}
