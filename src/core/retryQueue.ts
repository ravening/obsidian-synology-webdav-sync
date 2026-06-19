/**
 * Retry queue (pure scheduling/bounds + injectable persistence).
 *
 * When an automatic per-change sync fails because the server is unreachable,
 * the change is enqueued here. The queue is a bounded, persistent collection of
 * pending changes that are retried on a fixed interval up to a maximum number
 * of attempts. Exhausted changes are retained (flagged failed) rather than
 * dropped so the user can be notified.
 *
 * The scheduling and bounds logic is pure and I/O-free so it can be verified
 * with property-based tests (design Property 8). Serialization is exposed as
 * pure functions ({@link serializeQueue} / {@link deserializeQueue}) so the
 * persist/load round-trip (design Property 9) is testable without I/O, while
 * the async {@link RetryQueue.persist} / {@link RetryQueue.load} methods talk to
 * an injected {@link QueueStorage} backend (the plugin data store in
 * production).
 *
 * _Requirements: 8.5, 8.6, 8.7_
 */

import type { ChangeKind, PendingChange } from "./types";

/** Maximum number of pending changes the queue will hold (Req 8.5). */
export const MAX_QUEUE_SIZE = 1000;

/** Maximum number of attempts before a change is flagged exhausted (Req 8.5, 8.6). */
export const MAX_ATTEMPTS = 10;

/** The retry interval, in milliseconds (30 seconds, Req 8.5). */
export const RETRY_INTERVAL_MS = 30_000;

/**
 * An injectable persistence backend for the retry queue.
 *
 * In production this is backed by the plugin's `saveData()` / `loadData()` data
 * store; in tests it is a simple in-memory fake. Keeping the backend behind
 * this interface lets the pure scheduling logic stay free of I/O.
 */
export interface QueueStorage {
  /** Persist the serialized queue contents. */
  save(serialized: string): Promise<void>;
  /** Read the serialized queue contents, or `null` when nothing is stored. */
  load(): Promise<string | null>;
}

/**
 * Produce a clean {@link PendingChange} copy, normalizing the optional
 * `fromPath` (omitted when not a rename) and clamping `attempts` into range.
 */
function normalizeChange(change: PendingChange): PendingChange {
  const normalized: PendingChange = {
    id: change.id,
    kind: change.kind as ChangeKind,
    path: change.path,
    attempts: clampAttempts(change.attempts),
    nextAttemptAt: change.nextAttemptAt,
  };
  if (change.fromPath !== undefined) {
    normalized.fromPath = change.fromPath;
  }
  return normalized;
}

/** Clamp an attempt count into the inclusive range `0 .. MAX_ATTEMPTS`. */
function clampAttempts(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 0) return 0;
  return Math.min(Math.trunc(attempts), MAX_ATTEMPTS);
}

/**
 * Serialize a list of pending changes to a JSON string.
 *
 * Pure and deterministic: the inverse of {@link deserializeQueue}. Used by both
 * the async {@link RetryQueue.persist} path and the persistence round-trip
 * property test.
 */
export function serializeQueue(changes: PendingChange[]): string {
  return JSON.stringify({
    version: 1,
    changes: changes.map(normalizeChange),
  });
}

/**
 * Deserialize a JSON string produced by {@link serializeQueue} back into a list
 * of pending changes. Malformed or empty input yields an empty list.
 */
export function deserializeQueue(serialized: string | null): PendingChange[] {
  if (!serialized) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return [];
  }
  const raw = (parsed as { changes?: unknown })?.changes;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => normalizeChange(entry as PendingChange));
}

/**
 * Whether a change has exhausted its retry attempts and is flagged failed.
 *
 * Exhausted changes are retained in the queue (Req 8.6) but are not returned by
 * {@link RetryQueue.due} because retrying them further serves no purpose.
 */
export function isExhausted(change: PendingChange): boolean {
  return change.attempts >= MAX_ATTEMPTS;
}

/**
 * A bounded, persistent FIFO of pending changes with scheduled retries.
 *
 * @example
 * const queue = new RetryQueue(storage);
 * await queue.load();
 * queue.enqueue({ id, kind: "modify", path, attempts: 0, nextAttemptAt: now });
 * for (const change of queue.due(Date.now())) { ...attempt the change... }
 * queue.recordResult(id, false); // failed → backoff + attempt advance
 * await queue.persist();
 */
export class RetryQueue {
  /** Insertion-ordered pending changes. */
  private changes: PendingChange[] = [];

  /** Optional persistence backend used by {@link persist} / {@link load}. */
  private readonly storage?: QueueStorage;

  constructor(storage?: QueueStorage) {
    this.storage = storage;
  }

  /**
   * Add a change to the queue.
   *
   * @returns `true` when the change was enqueued; `false` when the queue is at
   *   capacity (1000), in which case the queue is left unchanged (Req 8.5).
   */
  enqueue(change: PendingChange): boolean {
    if (this.changes.length >= MAX_QUEUE_SIZE) {
      return false;
    }
    this.changes.push(normalizeChange(change));
    return true;
  }

  /** The number of pending changes currently held. */
  size(): number {
    return this.changes.length;
  }

  /**
   * Return the changes that are eligible for a retry attempt at `now`: those
   * whose `nextAttemptAt <= now` that have not yet exhausted their attempts.
   *
   * The returned array contains copies so callers cannot mutate queue state.
   */
  due(now: number): PendingChange[] {
    return this.changes
      .filter((c) => !isExhausted(c) && c.nextAttemptAt <= now)
      .map((c) => ({ ...c }));
  }

  /**
   * Record the outcome of a retry attempt for the change with the given `id`.
   *
   * On success the change is resolved and removed from the queue. On failure
   * the attempt count is advanced (capped at {@link MAX_ATTEMPTS}) and
   * `nextAttemptAt` is advanced by at least {@link RETRY_INTERVAL_MS}; a change
   * that reaches {@link MAX_ATTEMPTS} is retained (flagged exhausted) rather
   * than dropped (Req 8.6).
   *
   * @param id      The id of the change whose attempt completed.
   * @param success Whether the attempt succeeded.
   * @param now     Optional clock anchor (epoch ms); defaults to `Date.now()`.
   *   Backoff is scheduled relative to the later of the existing schedule and
   *   this anchor, guaranteeing the next attempt advances by at least the retry
   *   interval.
   */
  recordResult(id: string, success: boolean, now: number = Date.now()): void {
    const index = this.changes.findIndex((c) => c.id === id);
    if (index === -1) return;

    if (success) {
      // Resolved — remove from the queue.
      this.changes.splice(index, 1);
      return;
    }

    const change = this.changes[index];
    change.attempts = clampAttempts(change.attempts + 1);
    // Advance the next attempt by at least the retry interval relative to the
    // later of the prior schedule and the supplied clock anchor.
    change.nextAttemptAt = Math.max(change.nextAttemptAt, now) + RETRY_INTERVAL_MS;
  }

  /** The changes that have exhausted their attempts and are flagged failed (Req 8.6). */
  exhausted(): PendingChange[] {
    return this.changes.filter(isExhausted).map((c) => ({ ...c }));
  }

  /**
   * A point-in-time copy of the queue contents. Pure; the returned objects are
   * copies, so mutating them does not affect the queue.
   */
  snapshot(): PendingChange[] {
    return this.changes.map(normalizeChange);
  }

  /**
   * Replace the queue contents from a list of changes (e.g. a deserialized
   * snapshot). Entries beyond {@link MAX_QUEUE_SIZE} are discarded so the
   * capacity bound is never exceeded after a load.
   */
  loadSnapshot(changes: PendingChange[]): void {
    this.changes = changes.slice(0, MAX_QUEUE_SIZE).map(normalizeChange);
  }

  /** Serialize the current queue contents to a JSON string. */
  toJSON(): string {
    return serializeQueue(this.changes);
  }

  /**
   * Persist the queue to the injected {@link QueueStorage} so its contents
   * survive an application restart (Req 8.7).
   *
   * @throws when no storage backend was provided to the constructor.
   */
  async persist(): Promise<void> {
    if (!this.storage) {
      throw new Error("RetryQueue.persist requires a storage backend");
    }
    await this.storage.save(this.toJSON());
  }

  /**
   * Load the queue contents from the injected {@link QueueStorage}, replacing
   * any in-memory contents (Req 8.7).
   *
   * @throws when no storage backend was provided to the constructor.
   */
  async load(): Promise<void> {
    if (!this.storage) {
      throw new Error("RetryQueue.load requires a storage backend");
    }
    const serialized = await this.storage.load();
    this.loadSnapshot(deserializeQueue(serialized));
  }
}
