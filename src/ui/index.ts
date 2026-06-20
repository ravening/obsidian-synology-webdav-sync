/**
 * User interface layer.
 *
 * Holds the settings tab (connection fields, validation, save, and the Test
 * Connection control) and the status reporter (status-bar item and
 * newest-first error-log surface).
 */
export { StatusReporter, type StatusBarView } from "./statusReporter";
export {
  FolderBrowserController,
  classifyBrowserError,
  AUTH_ERROR_MESSAGE,
  TIMEOUT_ERROR_MESSAGE,
  CONNECTIVITY_ERROR_MESSAGE,
  type FolderBrowserClient,
  type BrowserState,
} from "./folderBrowserController";
export {
  FolderBrowserModal,
  FOLDER_BROWSER_TITLE,
  PARENT_FOLDER_LABEL,
  EMPTY_LISTING_MESSAGE,
  LOADING_MESSAGE,
  USE_THIS_FOLDER_LABEL,
  CREATE_FOLDER_LABEL,
  SAVE_VAULT_LOCATION_FAILED_MESSAGE,
  describeCurrentPath,
} from "./folderBrowserModal";
export {
  WebDavSyncSettingTab,
  loadConnectionSettings,
  saveConnectionSettings,
  runConnectionTest,
  defaultConnectionTestClientFactory,
  defaultFolderBrowserClientFactory,
  EMPTY_CONNECTION_SETTINGS,
  SETTINGS_SAVED_MESSAGE,
  VAULT_LOCATION_SAVED_MESSAGE,
  CHOOSE_REMOTE_FOLDER_LABEL,
  NO_REMOTE_FOLDER_MESSAGE,
  TEST_CONNECTION_LABEL,
  TEST_CONNECTION_RUNNING_LABEL,
  type SaveSettingsResult,
  type ConnectionTestClient,
  type ConnectionTestClientFactory,
  type FolderBrowserClientFactory,
} from "./settingsTab";
