/**
 * Persistence layer.
 *
 * Stores that persist plugin state across Obsidian sessions through the
 * plugin's data store (`saveData()` / `loadData()`). The credential store holds
 * the WebDAV connection settings (Req 2.4, 2.6).
 */
export {
  CredentialStore,
  CONNECTION_SETTINGS_KEY,
  VAULT_LOCATION_KEY,
  type DataStore,
} from "./credentialStore";
