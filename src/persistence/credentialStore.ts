/**
 * Credential store.
 *
 * Persists and loads {@link ConnectionSettings} through the plugin's data
 * store, which on Obsidian is backed by `Plugin.saveData()` / `Plugin.loadData()`
 * (Req 2.4, 2.6).
 *
 * To keep the store testable without a real Obsidian `Plugin` instance, the
 * backend is abstracted behind the small {@link DataStore} interface, which
 * mirrors the two methods the credential store needs. The production Obsidian
 * `Plugin` satisfies this interface structurally, so the plugin instance can be
 * passed directly; tests inject a simple in-memory fake.
 *
 * Obsidian's `saveData()` / `loadData()` persist the entire plugin data object
 * as a single JSON blob, and the design stores the connection settings, retry
 * queue, and error log in that same store. The credential store therefore
 * reads the existing data object, updates only its own key, and writes the
 * whole object back, so it never clobbers other persisted state.
 *
 * _Requirements: 2.4, 2.6_
 */

import type { ConnectionSettings } from "../core/types";
import { normalizeFolderPath } from "../core/vaultPath";

/**
 * The key under which the connection settings are stored within the plugin
 * data object.
 */
export const CONNECTION_SETTINGS_KEY = "connectionSettings";

/**
 * The key under which the Remote Vault Location {@link Folder_Path} is stored
 * within the plugin data object (Req 3.2, 5.1).
 */
export const VAULT_LOCATION_KEY = "remoteVaultLocation";

/**
 * An injectable persistence backend for the credential store.
 *
 * This mirrors the subset of Obsidian's `Plugin` API the credential store
 * relies on. The Obsidian `Plugin` class implements both methods, so a plugin
 * instance can be supplied directly in production; in tests a lightweight
 * in-memory implementation is injected instead.
 */
export interface DataStore {
  /** Persist the entire plugin data object. */
  saveData(data: unknown): Promise<void>;
  /** Read the entire plugin data object, or `null`/`undefined` when empty. */
  loadData(): Promise<unknown>;
}

/**
 * Whether a value is a plain object usable as the plugin data record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce an arbitrary stored value into a {@link ConnectionSettings}, or return
 * `null` when it is missing or not shaped like connection settings.
 *
 * The three fields are persisted and read back as strings; anything else is
 * treated as absent so a malformed or partial record never yields a
 * half-populated settings object.
 */
function toConnectionSettings(value: unknown): ConnectionSettings | null {
  if (!isRecord(value)) return null;
  const { endpoint, username, password } = value;
  if (
    typeof endpoint !== "string" ||
    typeof username !== "string" ||
    typeof password !== "string"
  ) {
    return null;
  }
  return { endpoint, username, password };
}

/**
 * Persists and loads {@link ConnectionSettings} through an injected
 * {@link DataStore}.
 *
 * @example
 * // Production: the Obsidian plugin instance satisfies DataStore.
 * const store = new CredentialStore(plugin);
 * await store.save({ endpoint, username, password });
 * const settings = await store.load();
 */
export class CredentialStore {
  private readonly store: DataStore;

  constructor(store: DataStore) {
    this.store = store;
  }

  /**
   * Persist the given connection settings (Req 2.4).
   *
   * Reads the existing plugin data object, updates only the connection-settings
   * key, and writes the whole object back so any other persisted state (retry
   * queue, error log) is preserved.
   */
  async save(settings: ConnectionSettings): Promise<void> {
    const existing = await this.store.loadData();
    const data: Record<string, unknown> = isRecord(existing)
      ? { ...existing }
      : {};
    data[CONNECTION_SETTINGS_KEY] = {
      endpoint: settings.endpoint,
      username: settings.username,
      password: settings.password,
    };
    await this.store.saveData(data);
  }

  /**
   * Load the persisted connection settings, or `null` when none have been
   * stored (Req 2.6).
   */
  async load(): Promise<ConnectionSettings | null> {
    const data = await this.store.loadData();
    if (!isRecord(data)) return null;
    return toConnectionSettings(data[CONNECTION_SETTINGS_KEY]);
  }

  /**
   * Persist the Remote Vault Location {@link Folder_Path} (Req 3.2, 5.1).
   *
   * Reads the existing plugin data object, re-applies {@link normalizeFolderPath}
   * defensively so the stored form is always canonical (the caller is expected
   * to have already validated/normalized via `validateFolderPath`, Req 5.7),
   * updates only the vault-location key, and writes the whole object back so any
   * other persisted state (connection settings, retry queue, error log) is
   * preserved (Req 5.4).
   */
  async saveVaultLocation(path: string): Promise<void> {
    const existing = await this.store.loadData();
    const data: Record<string, unknown> = isRecord(existing)
      ? { ...existing }
      : {};
    data[VAULT_LOCATION_KEY] = normalizeFolderPath(path);
    await this.store.saveData(data);
  }

  /**
   * Load the stored Remote Vault Location {@link Folder_Path}, or `null` when
   * none has been stored (Req 3.5, 3.7, 5.6).
   */
  async loadVaultLocation(): Promise<string | null> {
    const data = await this.store.loadData();
    if (!isRecord(data)) return null;
    const value = data[VAULT_LOCATION_KEY];
    return typeof value === "string" ? value : null;
  }
}
