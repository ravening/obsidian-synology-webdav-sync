import { Notice, Plugin, TFile } from "obsidian";

import { CredentialStore } from "./persistence/credentialStore";
import {
  RetryQueue,
  type QueueStorage,
} from "./core/retryQueue";
import { ErrorLog, type ErrorLogState } from "./core/errorLog";
import { StatusReporter, type StatusBarView } from "./ui/statusReporter";
import { WebDavSyncSettingTab } from "./ui/settingsTab";
import { validateSettings } from "./core/validateSettings";
import { RequestUrlTransport } from "./transport";
import { WebDAVClient } from "./client";
import {
  SyncEngine,
  type LocalVault,
  type SyncEngineClient,
} from "./engine";
import type { Notifier } from "./engine";
import type { ConnectionSettings, FileMeta, Transport } from "./core/types";

/**
 * The maximum time the plugin is allowed to spend initializing before it must
 * abort and report a load failure (Req 1.3, 1.4, 1.5). Five seconds, matching
 * the requirement's budget.
 */
export const INIT_BUDGET_MS = 5_000;

/** User-visible message shown when initialization fails or exceeds the budget (Req 1.5). */
export const LOAD_FAILURE_MESSAGE =
  "Synology WebDAV Sync failed to load. Your notes and settings are unchanged.";

/** Data-object key under which the serialized retry queue is persisted. */
export const RETRY_QUEUE_KEY = "retryQueue";

/** Interval, in milliseconds, at which due retry-queue changes are flushed (Req 8.5). */
export const RETRY_FLUSH_INTERVAL_MS = 30_000;

/** Data-object key under which the serialized error log is persisted. */
export const ERROR_LOG_KEY = "errorLog";

/** Whether a value is a plain object usable as the plugin data record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render an arbitrary thrown value as a human-readable description. */
function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Reject the supplied work if it does not settle within `budgetMs`.
 *
 * Used to enforce the 5-second initialization budget (Req 1.5). The work
 * promise continues running after a timeout, but because every state mutation
 * happens *after* the awaited load, a timeout means UI registration never ran
 * and nothing was changed.
 */
function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Initialization exceeded the ${budgetMs} ms budget.`));
    }, budgetMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * A {@link QueueStorage} backed by a single key within the plugin data object.
 *
 * Obsidian persists the entire plugin data object as one JSON blob through
 * `saveData()`/`loadData()`. To share that object with the credential store and
 * error log without clobbering their keys, this adapter performs a
 * read-modify-write of just its own key — the same pattern the
 * {@link CredentialStore} uses.
 */
class PluginDataQueueStorage implements QueueStorage {
  constructor(
    private readonly plugin: Plugin,
    private readonly key: string,
  ) {}

  async save(serialized: string): Promise<void> {
    const existing = await this.plugin.loadData();
    const data: Record<string, unknown> = isRecord(existing)
      ? { ...existing }
      : {};
    data[this.key] = serialized;
    await this.plugin.saveData(data);
  }

  async load(): Promise<string | null> {
    const data = await this.plugin.loadData();
    if (!isRecord(data)) return null;
    const value = data[this.key];
    return typeof value === "string" ? value : null;
  }
}

/**
 * A {@link LocalVault} adapter over Obsidian's `Vault` API.
 *
 * All file access uses the mobile-safe `Vault`/binary APIs (no Node `fs`), so
 * the same code path runs on desktop and mobile (Req 1.2, 4.6). This is the
 * seam the Sync Engine reads/writes through; vault *events* are wired in task
 * 19.2 and fetch-on-open is triggered in task 19.3.
 */
class ObsidianLocalVault implements LocalVault {
  constructor(private readonly plugin: Plugin) {}

  async listFiles(): Promise<FileMeta[]> {
    return this.plugin.app.vault.getFiles().map((file) => ({
      path: file.path,
      modifiedUtc: file.stat.mtime,
      size: file.stat.size,
    }));
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file === null || !("stat" in file)) {
      throw new Error(`Vault file not found: ${path}`);
    }
    return this.plugin.app.vault.readBinary(file as TFile);
  }

  async writeFile(path: string, content: ArrayBuffer): Promise<void> {
    const { vault } = this.plugin.app;
    const existing = vault.getAbstractFileByPath(path);
    if (existing !== null && "stat" in existing) {
      await vault.modifyBinary(existing as TFile, content);
      return;
    }
    // Ensure parent folders exist before creating the file.
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash > 0) {
      const parent = path.slice(0, lastSlash);
      if (vault.getAbstractFileByPath(parent) === null) {
        await vault.createFolder(parent).catch(() => {
          /* folder may have been created concurrently */
        });
      }
    }
    await vault.createBinary(path, content);
  }
}

/**
 * Plugin entry point and lifecycle owner.
 *
 * `onload` (task 19.1) registers the settings tab, commands, and a status-bar
 * item, then loads the persisted credential store, retry queue, and error log
 * within the 5-second initialization budget (Req 1.3, 1.4). If loading exceeds
 * the budget or fails, it aborts and surfaces a "failed to load" notice while
 * leaving notes and settings unchanged (Req 1.5).
 *
 * Vault event wiring (task 19.2) and fetch-on-open (task 19.3) plug into the
 * references established here — vault events forward to the Sync Engine, the
 * retry-queue flush timer runs, and fetch-on-open is triggered once the
 * workspace is ready when valid settings exist.
 */
export default class SynologyWebdavSyncPlugin extends Plugin {
  /** Loaded connection settings, or `null` when none are configured yet. */
  private connectionSettings: ConnectionSettings | null = null;

  /** Persists/loads connection settings via this plugin's data object. */
  private credentialStore!: CredentialStore;

  /** Bounded, persistent retry queue for offline per-change sync (Req 8.5–8.7). */
  private retryQueue!: RetryQueue;

  /** Bounded, newest-first error log surfaced by the status reporter (Req 10.4). */
  private errorLog!: ErrorLog;

  /** Drives the status-bar item and the error-log surface (Req 10). */
  private statusReporter!: StatusReporter;

  /** The single networking path used on desktop and mobile (Req 4.6). */
  private transport!: Transport;

  /** Orchestrates full sync, fetch-on-open, and per-change sync. */
  private syncEngine!: SyncEngine;

  async onload(): Promise<void> {
    try {
      await withBudget(this.initialize(), INIT_BUDGET_MS);
    } catch (err) {
      // Abort: nothing has been written, so notes and settings are unchanged
      // (Req 1.5). Surface a user-visible load-failure notice.
      console.error("Synology WebDAV Sync failed to initialize:", err);
      new Notice(LOAD_FAILURE_MESSAGE);
    }
  }

  onunload(): void {
    // Commands, the settings tab, the status-bar item, the vault event
    // listeners registered with registerEvent, and the retry-queue flush
    // interval registered with registerInterval are all torn down
    // automatically by Obsidian, so no explicit teardown is required here.
  }

  /**
   * Perform initialization within the budget: hydrate persisted state, then
   * register the UI surfaces and commands. Each step is ordered so that a
   * timeout (handled by {@link withBudget}) leaves the workspace untouched —
   * the slow work (reading the data object) happens before any registration.
   */
  private async initialize(): Promise<void> {
    // 1. Hydrate persisted state from the shared plugin data object.
    await this.loadPersistedState();

    // 2. Wire the status reporter onto a status-bar item (Req 10).
    const statusBarItem = this.addStatusBarItem();
    const statusBarView: StatusBarView = {
      setText: (text) => statusBarItem.setText(text),
      setTooltip: (tooltip) => statusBarItem.setAttr("aria-label", tooltip),
    };
    this.statusReporter = new StatusReporter(statusBarView, this.errorLog);

    // 3. Construct the Sync Engine and keep a reference for tasks 19.2/19.3.
    this.syncEngine = this.buildSyncEngine();

    // 4. Register the settings tab (loads stored settings into its fields on
    //    open, Req 2.6).
    this.addSettingTab(
      new WebDavSyncSettingTab(this.app, this, this.credentialStore),
    );

    // 5. Register commands.
    this.registerCommands();

    // 6. Wire vault events to the Sync Engine and start the retry-queue flush
    //    timer (Req 8.1–8.5).
    this.registerVaultEvents();
    this.startRetryFlushTimer();

    // 7. Once the workspace is ready, if valid settings exist, fetch remote
    //    changes (Req 7.1). Deferring via onLayoutReady keeps onload's 5 s
    //    budget unblocked (Req 1.5) — the fetch runs after load completes.
    //    fetchOnOpen also self-gates on valid settings (Req 7.7), but checking
    //    here avoids needless status churn when none are configured.
    this.app.workspace.onLayoutReady(() => {
      if (
        this.connectionSettings !== null &&
        validateSettings(this.connectionSettings).valid
      ) {
        void this.runFetchOnOpen();
      }
    });
  }

  /**
   * Register vault create/modify/delete/rename listeners that forward each
   * change to {@link SyncEngine.handleLocalChange} (Req 8.1–8.4).
   *
   * Only {@link TFile} events are forwarded; folder events are ignored because
   * per-change sync operates on files. `handleLocalChange` never throws (it
   * routes failures into the retry queue and error log internally), so the
   * handlers simply fire-and-forget the returned promise. Listeners are
   * registered through {@link Plugin.registerEvent} so Obsidian detaches them
   * automatically on unload.
   */
  private registerVaultEvents(): void {
    const { vault } = this.app;

    this.registerEvent(
      vault.on("create", (file) => {
        if (file instanceof TFile) {
          void this.syncEngine.handleLocalChange({
            kind: "create",
            path: file.path,
          });
        }
      }),
    );

    this.registerEvent(
      vault.on("modify", (file) => {
        if (file instanceof TFile) {
          void this.syncEngine.handleLocalChange({
            kind: "modify",
            path: file.path,
          });
        }
      }),
    );

    this.registerEvent(
      vault.on("delete", (file) => {
        if (file instanceof TFile) {
          void this.syncEngine.handleLocalChange({
            kind: "delete",
            path: file.path,
          });
        }
      }),
    );

    this.registerEvent(
      vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          void this.syncEngine.handleLocalChange({
            kind: "rename",
            path: file.path,
            fromPath: oldPath,
          });
        }
      }),
    );
  }

  /**
   * Start the 30-second timer that drains due changes from the retry queue
   * (Req 8.5). Registered through {@link Plugin.registerInterval} so Obsidian
   * clears it automatically on unload.
   */
  private startRetryFlushTimer(): void {
    this.registerInterval(
      window.setInterval(() => {
        void this.syncEngine.flushRetryQueue();
      }, RETRY_FLUSH_INTERVAL_MS),
    );
  }

  /**
   * Load the credential store, retry queue, and error log from the persisted
   * plugin data object. The credential store and retry queue read their own
   * keys; the error log is hydrated from the same data object so all three
   * share one blob without clobbering one another.
   */
  private async loadPersistedState(): Promise<void> {
    this.transport = new RequestUrlTransport();

    // Credential store (Req 2.6).
    this.credentialStore = new CredentialStore(this);
    this.connectionSettings = await this.credentialStore.load();

    // Retry queue, backed by its own key in the data object (Req 8.7).
    this.retryQueue = new RetryQueue(
      new PluginDataQueueStorage(this, RETRY_QUEUE_KEY),
    );
    await this.retryQueue.load();

    // Error log, hydrated from the shared data object (Req 10.4).
    const data = await this.loadData();
    const logState = isRecord(data) ? data[ERROR_LOG_KEY] : undefined;
    this.errorLog = isRecord(logState)
      ? ErrorLog.deserialize(logState as unknown as ErrorLogState)
      : new ErrorLog();
  }

  /**
   * Build the {@link SyncEngine} from the loaded state.
   *
   * The engine reaches the network through a thin {@link SyncEngineClient}
   * proxy that rebuilds a {@link WebDAVClient} from the *current* connection
   * settings on each call, so settings edited in the settings tab take effect
   * without rebuilding the engine. It reads/writes the vault through
   * {@link ObsidianLocalVault}, gates fetch-on-open on the live settings, and
   * shares the persisted {@link RetryQueue}.
   */
  private buildSyncEngine(): SyncEngine {
    const localVault = new ObsidianLocalVault(this);
    const notifier: Notifier = {
      notify: (message) => {
        new Notice(message);
      },
    };

    const requireClient = (): WebDAVClient => {
      if (this.connectionSettings === null) {
        throw new Error("No connection settings configured.");
      }
      return new WebDAVClient(this.connectionSettings, this.transport);
    };

    const client: SyncEngineClient = {
      listTree: (path) => requireClient().listTree(path),
      getFile: (path) => requireClient().getFile(path),
      putFile: (path, content) => requireClient().putFile(path, content),
      deleteFile: (path) => requireClient().deleteFile(path),
      moveFile: (from, to) => requireClient().moveFile(from, to),
    };

    return new SyncEngine(client, localVault, {
      getSettings: () => this.connectionSettings,
      notifier,
      retryQueue: this.retryQueue,
    });
  }

  /**
   * Register the plugin's commands. Manual full-sync and fetch commands wire
   * the Sync Engine to the status reporter; automatic fetch-on-open is added in
   * task 19.3.
   */
  private registerCommands(): void {
    this.addCommand({
      id: "synology-webdav-sync-now",
      name: "Synchronize vault now",
      callback: () => {
        void this.runFullSync();
      },
    });

    this.addCommand({
      id: "synology-webdav-fetch-remote",
      name: "Fetch remote changes",
      callback: () => {
        void this.runFetch();
      },
    });
  }

  /**
   * Run a full synchronization, reflecting progress/result through the status
   * reporter and persisting the retry queue and error log afterward.
   */
  private async runFullSync(): Promise<void> {
    if (this.connectionSettings === null) {
      new Notice("Configure your WebDAV connection settings first.");
      return;
    }
    const start = Date.now();
    this.statusReporter.setInProgress(start);
    try {
      const report = await this.syncEngine.fullSync();
      this.statusReporter.setSuccess(Date.now());
      new Notice(
        `Sync complete: ${report.uploaded} uploaded, ` +
          `${report.downloaded} downloaded, ${report.failed.length} failed.`,
      );
    } catch (err) {
      this.statusReporter.setError(Date.now(), describeError(err));
    } finally {
      await this.persistState();
    }
  }

  /** Manually fetch remote changes (the auto-on-open trigger is task 19.3). */
  private async runFetch(): Promise<void> {
    await this.syncEngine.fetchOnOpen();
    await this.persistState();
  }

  /**
   * Trigger fetch-on-open (Req 7.1) and reflect its progress and result through
   * the status reporter.
   *
   * {@link SyncEngine.fetchOnOpen} resolves even on failure (it notifies the
   * user internally per Req 7.5/7.6), so the surrounding status is driven here:
   * in-progress before the call, success once it resolves, error if it throws.
   * State is persisted afterward so any error-log entries written during the
   * fetch survive a restart (Req 10.4).
   */
  private async runFetchOnOpen(): Promise<void> {
    const start = Date.now();
    this.statusReporter.setInProgress(start);
    try {
      await this.syncEngine.fetchOnOpen();
      this.statusReporter.setSuccess(Date.now());
    } catch (err) {
      this.statusReporter.setError(Date.now(), describeError(err));
    } finally {
      await this.persistState();
    }
  }

  /**
   * Persist the retry queue and error log back into the shared plugin data
   * object so they survive a restart (Req 8.7, 10.4).
   */
  private async persistState(): Promise<void> {
    await this.retryQueue.persist();
    const existing = await this.loadData();
    const data: Record<string, unknown> = isRecord(existing)
      ? { ...existing }
      : {};
    data[ERROR_LOG_KEY] = this.errorLog.serialize();
    await this.saveData(data);
  }
}
