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
import type { FolderBrowserClient } from "./folderBrowserController";
import { FolderBrowserModal } from "./folderBrowserModal";

/**
 * The confirmation message shown after connection settings are saved
 * successfully (Req 2.5).
 */
export const SETTINGS_SAVED_MESSAGE = "Connection settings saved.";

/**
 * The label of the control that opens the Folder Browser (Req 1.1).
 */
export const CHOOSE_REMOTE_FOLDER_LABEL = "Choose remote folder";

/**
 * The indication shown in the "Remote vault location" section when no
 * Remote_Vault_Location has been persisted yet (Req 3.7).
 */
export const NO_REMOTE_FOLDER_MESSAGE = "No remote folder selected yet";

/**
 * The confirmation message shown after a Remote_Vault_Location is selected and
 * persisted from the Folder Browser (Req 3.3).
 */
export const VAULT_LOCATION_SAVED_MESSAGE = "Remote vault location saved.";

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
 * Builds a {@link FolderBrowserClient} for the verified connection settings,
 * used by the Folder Browser to list folders and create collections.
 *
 * The Test Connection control only needs a `testConnection` call, but the
 * Folder Browser needs the richer `listFolders`/`makeCollection` surface, which
 * the production {@link WebDAVClient} already provides. Injecting this factory
 * (mirroring {@link ConnectionTestClientFactory}) lets a test substitute an
 * in-memory fake while production builds a real client over the
 * `requestUrl()`-backed {@link RequestUrlTransport}.
 */
export type FolderBrowserClientFactory = (
  settings: ConnectionSettings,
) => FolderBrowserClient;

/**
 * The default factory: a production {@link WebDAVClient} bound to the verified
 * settings and the `requestUrl()`-backed {@link RequestUrlTransport}. The
 * client structurally satisfies {@link FolderBrowserClient} (it exposes
 * `listFolders` and `makeCollection`), so no adapter is required.
 */
export const defaultFolderBrowserClientFactory: FolderBrowserClientFactory = (
  settings,
) => new WebDAVClient(settings, new RequestUrlTransport());

/**
 * Decide whether the control that opens the Folder Browser should be enabled
 * (Req 1.2, 1.4).
 *
 * The control is enabled exactly when a connection test has succeeded for the
 * settings currently entered in the fields: a `verifiedSettings` snapshot must
 * exist, and the live `draft`'s endpoint, username, and password must all match
 * that snapshot. Any difference — meaning the user edited a field after the
 * test — or the absence of a snapshot yields `false`, so editing the endpoint,
 * username, or password re-disables the control until another test succeeds
 * (Req 1.4). This is a pure predicate with no DOM dependency so it can be unit-
 * and property-tested in isolation (task 9.2).
 *
 * @param verifiedSettings The settings the most recent successful test ran
 *   against, or `null` when no test has succeeded for the current session.
 * @param draft The settings currently entered in the fields.
 * @returns `true` iff a snapshot exists and the draft matches it on all three
 *   connection fields.
 */
export function isFolderBrowsingEnabled(
  verifiedSettings: ConnectionSettings | null,
  draft: ConnectionSettings,
): boolean {
  if (verifiedSettings === null) {
    return false;
  }
  return (
    verifiedSettings.endpoint === draft.endpoint &&
    verifiedSettings.username === draft.username &&
    verifiedSettings.password === draft.password
  );
}

/**
 * Run a connection test while signalling the running state (Req 3.8) and
 * recording the verification snapshot used to gate folder browsing (Req 1.3).
 *
 * This is the testable core of the Test Connection control: it flips the
 * running flag on before awaiting {@link ConnectionTestClient.testConnection}
 * and off again in a `finally` block, so the disable→run→re-enable sequence
 * holds even when the test rejects. The button wiring observes the flag via the
 * `setRunning` callback (disabling the button while `running` is true to block a
 * second concurrent test), and the single returned {@link ConnectionTestResult}
 * is surfaced as exactly one user-visible message (Req 3.6).
 *
 * When `testedSettings` and `onVerified` are supplied, a `success` result
 * records a snapshot of the tested settings through `onVerified` so the Folder
 * Browser control can be enabled for exactly those settings (Req 1.3); any
 * other result clears the snapshot (`null`) so the control stays disabled until
 * a test succeeds for the current settings (Req 1.2).
 *
 * @param client The client whose `testConnection` is invoked.
 * @param setRunning Called with `true` before the test and `false` after it.
 * @param testedSettings The settings the test is running against; snapshotted
 *   on success.
 * @param onVerified Called after the test settles with a snapshot of the tested
 *   settings on success, or `null` otherwise.
 * @returns The single connection-test result.
 */
export async function runConnectionTest(
  client: ConnectionTestClient,
  setRunning: (running: boolean) => void,
  testedSettings?: ConnectionSettings,
  onVerified?: (snapshot: ConnectionSettings | null) => void,
): Promise<ConnectionTestResult> {
  setRunning(true);
  try {
    const result = await client.testConnection();
    if (onVerified !== undefined) {
      onVerified(
        result.kind === "success" && testedSettings !== undefined
          ? { ...testedSettings }
          : null,
      );
    }
    return result;
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

  /**
   * Builds the {@link FolderBrowserClient} used by the Folder Browser from the
   * verified connection settings. Injected so a test can supply a fake;
   * defaults to a production {@link WebDAVClient} over the `requestUrl()`
   * transport.
   */
  private readonly folderBrowserClientFactory: FolderBrowserClientFactory;

  /**
   * The connection settings the most recent successful connection test ran
   * against, or `null` when no test has succeeded for the current settings. The
   * "Choose remote folder" control is enabled only while this snapshot matches
   * the live {@link draft} (Req 1.2, 1.3, 1.4), as decided by
   * {@link isFolderBrowsingEnabled}.
   */
  private verifiedSettings: ConnectionSettings | null = null;

  /**
   * The stored Remote_Vault_Location {@link Folder_Path} loaded from the
   * credential store, or `null` when none has been persisted (Req 3.5, 3.7).
   */
  private currentVaultLocation: string | null = null;

  /**
   * The "Choose remote folder" button, retained so its enabled state can be
   * refreshed as the draft and verification snapshot change (Req 1.2–1.4).
   */
  private chooseFolderButton: ButtonComponent | null = null;

  constructor(
    app: App,
    plugin: Plugin,
    store: CredentialStore,
    clientFactory: ConnectionTestClientFactory = defaultConnectionTestClientFactory,
    folderBrowserClientFactory: FolderBrowserClientFactory = defaultFolderBrowserClientFactory,
  ) {
    super(app, plugin);
    this.store = store;
    this.clientFactory = clientFactory;
    this.folderBrowserClientFactory = folderBrowserClientFactory;
  }

  /**
   * Build the settings UI and load any stored settings into the fields (Req 2.6).
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Render the fields from empty defaults first so the UI is responsive,
    // then asynchronously load the stored settings and populate them. A fresh
    // display starts with no verified snapshot so folder browsing is disabled
    // until a connection test succeeds for the current settings (Req 1.2).
    this.draft = { ...EMPTY_CONNECTION_SETTINGS };
    this.verifiedSettings = null;
    this.chooseFolderButton = null;
    void this.renderFields();
  }

  /**
   * Load stored settings, then render the connection fields and save control.
   */
  private async renderFields(): Promise<void> {
    this.draft = await loadConnectionSettings(this.store);
    this.currentVaultLocation = await this.store.loadVaultLocation();

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
            this.onDraftFieldChange();
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
            this.onDraftFieldChange();
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
            this.onDraftFieldChange();
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

    // --- Remote vault location section (Req 1.1, 1.2, 3.5, 3.7) ---
    containerEl.createEl("h2", { text: "Remote vault location" });

    new Setting(containerEl)
      .setName("Current remote folder")
      .setDesc(
        this.currentVaultLocation !== null && this.currentVaultLocation !== ""
          ? this.currentVaultLocation
          : NO_REMOTE_FOLDER_MESSAGE,
      );

    new Setting(containerEl)
      .setName("Choose remote folder")
      .setDesc(
        "Browse the server and pick the folder to store your vault. Available after a successful connection test.",
      )
      .addButton((button) => {
        this.chooseFolderButton = button;
        button.setButtonText(CHOOSE_REMOTE_FOLDER_LABEL).onClick(() => {
          this.handleChooseRemoteFolder();
        });
        // Gate the control on a successful test for the current settings
        // (Req 1.2): disabled until a snapshot matches the live draft.
        this.refreshFolderBrowsingState();
      });
  }

  /**
   * Re-evaluate and apply the enabled state of the "Choose remote folder"
   * control from the current verification snapshot and draft (Req 1.2–1.4).
   */
  private refreshFolderBrowsingState(): void {
    this.chooseFolderButton?.setDisabled(
      !isFolderBrowsingEnabled(this.verifiedSettings, this.draft),
    );
  }

  /**
   * Handle an edit to any connection field: invalidate the verification
   * snapshot once the live draft no longer matches it, then refresh the
   * folder-browsing control so it re-disables until a fresh test succeeds for
   * the changed settings (Req 1.4).
   */
  private onDraftFieldChange(): void {
    if (
      this.verifiedSettings !== null &&
      !isFolderBrowsingEnabled(this.verifiedSettings, this.draft)
    ) {
      this.verifiedSettings = null;
    }
    this.refreshFolderBrowsingState();
  }

  /**
   * Open the Folder Browser for the verified connection settings (Req 1.5).
   *
   * Builds a {@link FolderBrowserClient} from the verified snapshot (falling
   * back to the live draft only if no snapshot is held, though the control is
   * gated so this should not occur), opens the {@link FolderBrowserModal}
   * injecting that client and the {@link CredentialStore}, and supplies an
   * `onSelected` callback that the modal invokes after it persists the chosen
   * location. The callback updates the displayed location, re-renders the
   * fields, and shows the confirmation notice (Req 3.3).
   */
  private handleChooseRemoteFolder(): void {
    const settings = this.verifiedSettings ?? this.draft;
    const client = this.folderBrowserClientFactory(settings);
    const modal = new FolderBrowserModal(
      this.app,
      client,
      this.store,
      (savedPath) => {
        // Reflect the newly persisted Remote_Vault_Location and confirm the
        // save to the user (Req 3.3). Re-rendering the fields re-reads the
        // stored location from the credential store.
        this.currentVaultLocation = savedPath;
        new Notice(VAULT_LOCATION_SAVED_MESSAGE);
        void this.renderFields();
      },
    );
    modal.open();
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
    const testedSettings = { ...this.draft };
    const client = this.clientFactory(testedSettings);
    const result = await runConnectionTest(
      client,
      (running) => {
        button.setDisabled(running);
        button.setButtonText(
          running ? TEST_CONNECTION_RUNNING_LABEL : TEST_CONNECTION_LABEL,
        );
      },
      testedSettings,
      (snapshot) => {
        // A successful test records the tested settings so the Folder Browser
        // control can be enabled for exactly those settings (Req 1.3); any
        // other result clears it so the control stays disabled (Req 1.2).
        this.verifiedSettings = snapshot;
        this.refreshFolderBrowsingState();
      },
    );
    new Notice(result.message);
  }
}
