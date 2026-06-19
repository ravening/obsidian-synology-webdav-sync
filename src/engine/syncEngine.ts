/**
 * Sync Engine.
 *
 * Orchestrates synchronization between the local Obsidian vault and the remote
 * WebDAV server. This module implements `fullSync` (Req 6): it enumerates local
 * and remote files, pairs them by path, and uses the pure {@link decideAction}
 * decision function to choose whether to upload, download, or skip each pair.
 *
 * I/O is abstracted behind two small injectable interfaces so the engine can be
 * exercised without Obsidian or a live network:
 *
 *  - {@link LocalVault} models the local vault (list/read/write files).
 *  - {@link SyncEngineClient} is the minimal slice of the WebDAV client the
 *    engine needs. The production {@link WebDAVClient} satisfies it structurally,
 *    and tests can inject a fake (e.g. a `FakeTransport`-backed client or a hand
 *    written double) that fails an arbitrary subset of transfers.
 *
 * Per-file resilience (Req 6.5, 6.6): each individual transfer is retried up to
 * {@link MAX_TRANSFER_RETRIES} additional times (so up to 4 attempts total)
 * before the file is classified as failed. A failed transfer never stops the
 * run; failures are accumulated and reported. The returned {@link SyncReport}
 * accounts for every processed file exactly once.
 *
 * Remote parent directories are created on demand by the client's `putFile`
 * (which issues MKCOL for missing parents), satisfying Req 6.7 without extra
 * work here.
 *
 * _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
 */
import { decideAction } from "../core/decideAction";
import { validateSettings } from "../core/validateSettings";
import {
  RetryQueue,
  MAX_ATTEMPTS,
  RETRY_INTERVAL_MS,
} from "../core/retryQueue";
import type {
  ChangeKind,
  ConnectionSettings,
  FileMeta,
  PendingChange,
  RemoteFileListing,
  SyncReport,
} from "../core/types";
import type { Notifier } from "./conflictResolver";

/**
 * The number of *additional* retry attempts made for a single transfer after
 * the initial attempt fails, before the file is classified as failed
 * (Req 6.5). With 3 additional attempts the engine tries each transfer up to 4
 * times in total.
 */
export const MAX_TRANSFER_RETRIES = 3;

/**
 * A single local change detected in the vault that must be propagated to the
 * WebDAV server by {@link SyncEngine.handleLocalChange} (Req 8.1–8.4).
 *
 * This is the *unqueued* form of a change as it is first observed from an
 * Obsidian vault event. When propagation fails because the server is
 * unreachable it is converted into the queued {@link PendingChange} form (which
 * adds an `id`, `attempts`, and `nextAttemptAt`) and held in the
 * {@link RetryQueue} (Req 8.5).
 *
 *  - `create` / `modify` — the file at {@link path} should be uploaded (PUT).
 *  - `delete`            — the remote file at {@link path} should be removed.
 *  - `rename`            — the remote file should move from {@link fromPath}
 *                          to {@link path} (MOVE).
 */
export interface LocalChange {
  /** The kind of change to apply remotely. */
  kind: ChangeKind;
  /** Vault-relative destination path (the new path for a rename). */
  path: string;
  /** Original vault-relative path; required for a `rename`. */
  fromPath?: string;
}

/**
 * The local vault abstraction the Sync Engine depends on.
 *
 * Implementations wrap Obsidian's `Vault`/`DataAdapter` in production and are
 * replaced by a simple in-memory fake in tests. All paths are vault-relative
 * and normalized with forward slashes, matching {@link FileMeta.path}.
 */
export interface LocalVault {
  /** Enumerate every file in the vault as {@link FileMeta}. */
  listFiles(): Promise<FileMeta[]>;
  /** Read the complete bytes of the file at `path`. */
  readFile(path: string): Promise<ArrayBuffer>;
  /**
   * Write `content` to `path` as a complete file, creating parent folders as
   * needed. Implementations MUST NOT leave a partial file on failure.
   */
  writeFile(path: string, content: ArrayBuffer): Promise<void>;
}

/**
 * The minimal slice of the WebDAV client the Sync Engine requires.
 *
 * The production {@link WebDAVClient} implements every method of this interface
 * (and more), so it can be injected directly. Tests inject a structural double
 * that records calls and can fail a chosen subset of transfers. `putFile`
 * creates any missing remote parent collections itself (Req 6.7).
 */
export interface SyncEngineClient {
  /** Recursively list the remote subtree rooted at `remotePath`. */
  listTree(remotePath: string): Promise<RemoteFileListing>;
  /** Fetch a remote file's bytes. */
  getFile(remotePath: string): Promise<ArrayBuffer>;
  /** Upload bytes to `remotePath`, creating missing parent collections first. */
  putFile(remotePath: string, content: ArrayBuffer): Promise<void>;
  /** Delete the remote file at `remotePath`. */
  deleteFile(remotePath: string): Promise<void>;
  /** Move/rename a remote file from `fromPath` to `toPath`. */
  moveFile(fromPath: string, toPath: string): Promise<void>;
}

/** Optional construction-time configuration for the Sync Engine. */
export interface SyncEngineOptions {
  /**
   * The remote path to treat as the sync root when listing the server. Defaults
   * to `""` (the configured endpoint's base path).
   */
  rootPath?: string;

  /**
   * The connection settings used to gate {@link SyncEngine.fetchOnOpen}.
   *
   * Fetch-on-open performs no work unless valid settings exist (Req 7.7).
   * Validity is determined with the pure {@link validateSettings} function. Use
   * this when the settings are known at construction time; for settings that
   * may change after construction prefer {@link getSettings}.
   *
   * `null`/`undefined` means "no settings configured" and causes fetch-on-open
   * to skip entirely.
   */
  settings?: ConnectionSettings | null;

  /**
   * A provider that returns the current connection settings (or `null` when
   * none are configured), evaluated each time {@link SyncEngine.fetchOnOpen}
   * runs. When supplied this takes precedence over {@link settings}, letting
   * the engine observe settings that change after construction without
   * rebuilding it. Like {@link settings}, validity is checked with
   * {@link validateSettings} (Req 7.7).
   */
  getSettings?: () => ConnectionSettings | null | undefined;

  /**
   * Sink for user-visible notifications emitted by {@link SyncEngine.fetchOnOpen}
   * on full failure (Req 7.5) and partial failure (Req 7.6). Reuses the
   * {@link Notifier} interface from the Conflict Resolver. When omitted,
   * notifications are silently dropped.
   */
  notifier?: Notifier;

  /**
   * The bounded, persistent {@link RetryQueue} used by
   * {@link SyncEngine.handleLocalChange} to hold changes that could not be
   * pushed because the server was unreachable, and drained by
   * {@link SyncEngine.flushRetryQueue} (Req 8.5–8.7).
   *
   * Injected so tests can inspect queue state and the plugin can supply a
   * persistence-backed instance. When omitted, the engine lazily creates an
   * in-memory queue (no persistence) on first use so per-change sync still
   * functions; prefer supplying one explicitly when durability is required.
   */
  retryQueue?: RetryQueue;

  /**
   * Clock used to stamp queued changes and to anchor retry scheduling. Injected
   * for deterministic tests; defaults to {@link Date.now}.
   */
  now?: () => number;

  /**
   * Generates the unique id for a newly queued {@link PendingChange}. Injected
   * for deterministic tests; defaults to a time-and-counter based generator.
   */
  generateId?: () => string;
}

/** The result of attempting a single transfer (with retries applied). */
type TransferResult = { ok: true } | { ok: false; error: string };

/**
 * Render an arbitrary thrown value as a human-readable failure description.
 * `Error` instances contribute their `message`; anything else is coerced to a
 * string. Used for the failure causes surfaced in reports and notifications.
 */
function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Coordinates full-vault synchronization between a {@link LocalVault} and a
 * remote WebDAV server reached through a {@link SyncEngineClient}.
 */
export class SyncEngine {
  private readonly rootPath: string;
  private readonly settings: ConnectionSettings | null;
  private readonly getSettings?: () => ConnectionSettings | null | undefined;
  private readonly notifier?: Notifier;
  private readonly now: () => number;
  private readonly generateId: () => string;
  /** Lazily created when no {@link RetryQueue} was injected. */
  private retryQueue?: RetryQueue;
  /** Monotonic counter feeding the default id generator. */
  private idCounter = 0;

  constructor(
    private readonly client: SyncEngineClient,
    private readonly localVault: LocalVault,
    options: SyncEngineOptions = {},
  ) {
    this.rootPath = options.rootPath ?? "";
    this.settings = options.settings ?? null;
    this.getSettings = options.getSettings;
    this.notifier = options.notifier;
    this.now = options.now ?? (() => Date.now());
    this.retryQueue = options.retryQueue;
    this.generateId =
      options.generateId ??
      (() => `chg-${this.now()}-${(this.idCounter += 1)}`);
  }

  /**
   * Synchronize the entire vault with the server (Req 6).
   *
   * Steps:
   *  1. Enumerate local files and the remote subtree in parallel.
   *  2. Pair entries by vault-relative path (a file may exist on one side only).
   *  3. For each pair, call {@link decideAction}:
   *     - `upload`   — read the local file and PUT it (parents created by the
   *                    client, Req 6.7); count toward `uploaded` on success.
   *     - `download` — GET the remote file and write it into the vault; count
   *                    toward `downloaded` on success.
   *     - `skip`     — the two sides are within the equality window; transfer
   *                    nothing (Req 6.3).
   *  4. Each transfer is retried up to {@link MAX_TRANSFER_RETRIES} extra times;
   *     if it still fails the file is recorded in `failed` and the run continues
   *     (Req 6.5, 6.6).
   *
   * @returns A {@link SyncReport} with the counts of uploaded and downloaded
   *   files and the list of failed transfers. Every processed file contributes
   *   to exactly one of these outcomes (Req 6.4).
   */
  async fullSync(): Promise<SyncReport> {
    const report: SyncReport = { uploaded: 0, downloaded: 0, failed: [] };

    // 1. Enumerate both sides. A failure here aborts the run before any
    //    transfer is attempted (nothing has been changed yet).
    const [localFiles, remoteListing] = await Promise.all([
      this.localVault.listFiles(),
      this.client.listTree(this.rootPath),
    ]);

    // 2. Index by path and build the union of all paths, preserving a stable
    //    order (local files first, then remote-only files).
    const localByPath = new Map<string, FileMeta>();
    for (const file of localFiles) {
      localByPath.set(file.path, file);
    }
    const remoteByPath = new Map<string, FileMeta>();
    for (const file of remoteListing.entries) {
      remoteByPath.set(file.path, file);
    }

    const allPaths: string[] = [];
    const seen = new Set<string>();
    for (const path of localByPath.keys()) {
      if (!seen.has(path)) {
        seen.add(path);
        allPaths.push(path);
      }
    }
    for (const path of remoteByPath.keys()) {
      if (!seen.has(path)) {
        seen.add(path);
        allPaths.push(path);
      }
    }

    // 3 & 4. Decide and transfer each pair, isolating per-file failures.
    for (const path of allPaths) {
      const local = localByPath.get(path) ?? null;
      const remote = remoteByPath.get(path) ?? null;
      const action = decideAction(local, remote);

      if (action === "upload") {
        const result = await this.withRetry(() => this.upload(path));
        if (result.ok) {
          report.uploaded += 1;
        } else {
          report.failed.push({ path, error: result.error });
        }
      } else if (action === "download") {
        const result = await this.withRetry(() => this.download(path));
        if (result.ok) {
          report.downloaded += 1;
        } else {
          report.failed.push({ path, error: result.error });
        }
      }
      // `skip` (and any non-transfer action) leaves both sides untouched and
      // contributes to none of the report counts (Req 6.3).
    }

    return report;
  }

  /**
   * Fetch remote changes when the application opens (Req 7).
   *
   * This is a download-only pass: it pulls remote files that are newer than or
   * absent from the vault and leaves everything else untouched. It never
   * uploads. The flow is:
   *
   *  1. Gate on valid settings. If no settings are configured, or the
   *     configured settings fail {@link validateSettings}, the method returns
   *     immediately without making a single client or vault call, leaving the
   *     vault unchanged (Req 7.7).
   *  2. Retrieve the remote listing via {@link SyncEngineClient.listTree}
   *     (the client applies the 30 s per-request timeout, Req 7.1). If this
   *     fails before any file has been downloaded, notify the user of the
   *     failure and leave the vault unchanged (Req 7.5).
   *  3. For each remote entry, pair it with its local counterpart and consult
   *     {@link decideAction}:
   *     - `download` — the remote is newer than, or absent from, the vault
   *       (Req 7.2, 7.3): GET the remote bytes and write them into the vault.
   *     - `skip` — the two sides are within the equality window, i.e. the same
   *       last-modified time (Req 7.4): leave the local file unchanged.
   *     Remote-only files pair against a `null` local and therefore download.
   *  4. If a download fails, stop and notify. When at least one file was
   *     already written this is a partial failure: the downloaded files are
   *     retained and the notification identifies it as partial (Req 7.6).
   *     When nothing had been downloaded yet it is a full failure handled like
   *     step 2 (Req 7.5).
   *
   * Notifications are emitted through the injected {@link Notifier}; when none
   * was supplied they are dropped. The method always resolves (it never
   * throws), so callers can fire it during plugin load without guarding it.
   */
  async fetchOnOpen(): Promise<void> {
    // 1. Settings gate (Req 7.7). No client or vault call happens before this
    //    check passes, so invalid/missing settings leave the vault untouched.
    const settings = this.resolveSettings();
    if (settings === null || !validateSettings(settings).valid) {
      return;
    }

    // 2. Retrieve the remote listing within the request budget (Req 7.1). A
    //    failure here is a full failure: nothing has been written (Req 7.5).
    let remoteListing: RemoteFileListing;
    try {
      remoteListing = await this.client.listTree(this.rootPath);
    } catch (cause) {
      this.notifyFullFailure(describeError(cause));
      return;
    }

    // Index local files by path so each remote entry can be paired with its
    // local counterpart. Listing the vault is a read; it changes nothing.
    const localFiles = await this.localVault.listFiles();
    const localByPath = new Map<string, FileMeta>();
    for (const file of localFiles) {
      localByPath.set(file.path, file);
    }

    // 3 & 4. Download remote-newer and remote-only files; leave same-mtime
    //        files unchanged. Stop on the first failure, retaining whatever
    //        was already written.
    let downloaded = 0;
    for (const remote of remoteListing.entries) {
      const local = localByPath.get(remote.path) ?? null;
      if (decideAction(local, remote) !== "download") {
        // `skip` (same-mtime, Req 7.4) and any non-download action leave the
        // local file unchanged.
        continue;
      }

      try {
        const content = await this.client.getFile(remote.path);
        await this.localVault.writeFile(remote.path, content);
        downloaded += 1;
      } catch (cause) {
        const reason = describeError(cause);
        if (downloaded > 0) {
          // Partial failure: keep the files already downloaded (Req 7.6).
          this.notifyPartialFailure(downloaded, reason);
        } else {
          // Failure before any download: vault unchanged (Req 7.5).
          this.notifyFullFailure(reason);
        }
        return;
      }
    }
  }

  /**
   * Propagate a single detected local change to the WebDAV server (Req 8).
   *
   * The change is applied promptly — there is no artificial delay, so the
   * remote operation is issued well within the 5-second budget of detection
   * (Req 8.1–8.4):
   *
   *  - `create` / `modify` — read the file's bytes from the vault and PUT them
   *    to {@link LocalChange.path} (Req 8.1, 8.2).
   *  - `delete`            — DELETE the remote file at {@link LocalChange.path}
   *    (Req 8.3).
   *  - `rename`            — MOVE the remote file from
   *    {@link LocalChange.fromPath} to {@link LocalChange.path} (Req 8.4).
   *
   * If the operation fails because the server is unreachable (the client
   * rejects), the change is enqueued into the {@link RetryQueue} for later
   * retry (Req 8.5). When the queue is at capacity (1000 entries) the enqueue
   * is refused and an error notification is surfaced so the user knows the
   * change is not pending (Req 8.5, queue-at-capacity). The method never throws.
   */
  async handleLocalChange(change: LocalChange): Promise<void> {
    try {
      await this.applyChange(change.kind, change.path, change.fromPath);
    } catch (cause) {
      // Connectivity failure: queue the change for retry (Req 8.5).
      this.enqueueForRetry(change, describeError(cause));
    }
  }

  /**
   * Re-attempt every change that is due for a retry at `now`, advancing the
   * retry schedule for each (Req 8.5). Exposed so the plugin can drive it on a
   * 30-second timer (task 19.2) and so it is independently testable.
   *
   * For each due change the corresponding remote operation is replayed:
   *  - on success the change is resolved and removed from the queue;
   *  - on failure the attempt count and 30-second backoff are advanced via
   *    {@link RetryQueue.recordResult}; a change that thereby reaches the
   *    {@link MAX_ATTEMPTS}-attempt limit is retained in the queue (flagged
   *    failed) and an error notification identifying the file is surfaced
   *    (Req 8.6).
   *
   * @param now Optional clock anchor (epoch ms); defaults to the injected
   *   clock. Used both to select due changes and to anchor backoff so behavior
   *   is deterministic in tests.
   */
  async flushRetryQueue(now: number = this.now()): Promise<void> {
    const queue = this.ensureRetryQueue();
    for (const pending of queue.due(now)) {
      try {
        await this.applyChange(pending.kind, pending.path, pending.fromPath);
        queue.recordResult(pending.id, true, now);
      } catch {
        queue.recordResult(pending.id, false, now);
        // A due change is not yet exhausted, so this failure pushes it to one
        // more attempt; if that reaches the cap the change is now exhausted.
        if (pending.attempts + 1 >= MAX_ATTEMPTS) {
          this.notifyRetryExhausted(pending.path);
        }
      }
    }
  }

  // -- Internals ------------------------------------------------------------

  /**
   * Issue the remote operation for a change of the given `kind`. `create` and
   * `modify` read the local bytes and PUT them; `delete` removes the remote
   * file; `rename` moves it from `fromPath` to `path`. Rejects (propagating the
   * client error) so callers can decide whether to queue or record a retry.
   */
  private async applyChange(
    kind: ChangeKind,
    path: string,
    fromPath?: string,
  ): Promise<void> {
    switch (kind) {
      case "create":
      case "modify": {
        const content = await this.localVault.readFile(path);
        await this.client.putFile(path, content);
        return;
      }
      case "delete":
        await this.client.deleteFile(path);
        return;
      case "rename":
        await this.client.moveFile(fromPath ?? path, path);
        return;
    }
  }

  /**
   * Convert a failed {@link LocalChange} into a queued {@link PendingChange} and
   * add it to the retry queue (Req 8.5). The first retry is scheduled one
   * {@link RETRY_INTERVAL_MS} into the future. When the queue is full the
   * enqueue is refused and an error notification is surfaced (Req 8.5).
   */
  private enqueueForRetry(change: LocalChange, _reason: string): void {
    const queue = this.ensureRetryQueue();
    const now = this.now();
    const pending: PendingChange = {
      id: this.generateId(),
      kind: change.kind,
      path: change.path,
      attempts: 0,
      nextAttemptAt: now + RETRY_INTERVAL_MS,
    };
    if (change.fromPath !== undefined) {
      pending.fromPath = change.fromPath;
    }
    if (!queue.enqueue(pending)) {
      // Queue at capacity (1000): the change cannot be made pending (Req 8.5).
      this.notifier?.notify(
        `Could not queue sync of "${change.path}": the retry queue is full ` +
          `(1000 pending changes). The change was not saved for retry.`,
      );
    }
  }

  /**
   * Return the injected {@link RetryQueue}, lazily creating an in-memory one
   * (without persistence) the first time it is needed when none was supplied.
   */
  private ensureRetryQueue(): RetryQueue {
    if (!this.retryQueue) {
      this.retryQueue = new RetryQueue();
    }
    return this.retryQueue;
  }

  /**
   * Notify the user that a queued change has exhausted its retry attempts and
   * remains failed in the queue (Req 8.6).
   */
  private notifyRetryExhausted(path: string): void {
    this.notifier?.notify(
      `Synchronization of "${path}" failed after ${MAX_ATTEMPTS} attempts. ` +
        `The change remains queued and was not synced.`,
    );
  }

  /**
   * Resolve the connection settings to gate fetch-on-open against. A {@link
   * SyncEngineOptions.getSettings} provider, when supplied, takes precedence
   * and is evaluated on each call so settings changes are observed; otherwise
   * the construction-time {@link SyncEngineOptions.settings} value is used.
   * Returns `null` when no settings are configured.
   */
  private resolveSettings(): ConnectionSettings | null {
    if (this.getSettings) {
      return this.getSettings() ?? null;
    }
    return this.settings;
  }

  /**
   * Notify the user that fetch-on-open failed before any file was downloaded,
   * leaving the vault unchanged (Req 7.5).
   */
  private notifyFullFailure(reason: string): void {
    this.notifier?.notify(
      `Fetch on open failed: ${reason}. The vault was left unchanged.`,
    );
  }

  /**
   * Notify the user that fetch-on-open failed after downloading one or more
   * files, which are retained (Req 7.6).
   */
  private notifyPartialFailure(downloaded: number, reason: string): void {
    const noun = downloaded === 1 ? "file" : "files";
    this.notifier?.notify(
      `Fetch on open partially failed after downloading ${downloaded} ${noun}: ` +
        `${reason}. The downloaded files were retained.`,
    );
  }

  /** Read the local file and upload it to the same remote path. */
  private async upload(path: string): Promise<void> {
    const content = await this.localVault.readFile(path);
    await this.client.putFile(path, content);
  }

  /** Download the remote file and write it into the vault at the same path. */
  private async download(path: string): Promise<void> {
    const content = await this.client.getFile(path);
    await this.localVault.writeFile(path, content);
  }

  /**
   * Run a single transfer, retrying it up to {@link MAX_TRANSFER_RETRIES}
   * additional times on failure (Req 6.5). Returns `{ ok: true }` on the first
   * success or `{ ok: false, error }` carrying the most recent failure cause
   * once all attempts are exhausted (Req 6.6). This never throws, so the caller
   * can continue with the remaining files.
   */
  private async withRetry(
    operation: () => Promise<void>,
  ): Promise<TransferResult> {
    let lastError = "Transfer failed.";
    // Initial attempt (attempt 0) plus MAX_TRANSFER_RETRIES retries.
    for (let attempt = 0; attempt <= MAX_TRANSFER_RETRIES; attempt += 1) {
      try {
        await operation();
        return { ok: true };
      } catch (cause) {
        lastError = describeError(cause);
      }
    }
    return { ok: false, error: lastError };
  }
}
