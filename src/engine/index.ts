/**
 * Sync engine layer.
 *
 * Orchestrates full synchronization, fetch-on-open, and per-change automatic
 * sync. Owns the timestamp-comparison decision logic and delegates conflict
 * preservation to the Conflict Resolver and offline retries to the Retry
 * Queue.
 */
export {
  DefaultConflictResolver,
  type ConflictResolver,
  type ConflictInput,
  type ConflictOutcome,
  type VaultWriter,
  type Notifier,
} from "./conflictResolver";

export {
  SyncEngine,
  MAX_TRANSFER_RETRIES,
  type LocalChange,
  type LocalVault,
  type SyncEngineClient,
  type SyncEngineOptions,
} from "./syncEngine";
