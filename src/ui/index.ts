/**
 * User interface layer.
 *
 * Holds the settings tab (connection fields, validation, save, and the Test
 * Connection control) and the status reporter (status-bar item and
 * newest-first error-log surface).
 */
export { StatusReporter, type StatusBarView } from "./statusReporter";
export {
  WebDavSyncSettingTab,
  loadConnectionSettings,
  saveConnectionSettings,
  runConnectionTest,
  defaultConnectionTestClientFactory,
  EMPTY_CONNECTION_SETTINGS,
  SETTINGS_SAVED_MESSAGE,
  TEST_CONNECTION_LABEL,
  TEST_CONNECTION_RUNNING_LABEL,
  type SaveSettingsResult,
  type ConnectionTestClient,
  type ConnectionTestClientFactory,
} from "./settingsTab";
