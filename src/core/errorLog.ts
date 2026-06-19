/**
 * Pure, bounded, newest-first error log.
 *
 * The error log records synchronization failures, each with a UTC timestamp
 * and a human-readable description. It is one of the plugin's pure cores: it
 * performs no I/O and is deterministic, so its behavior can be verified with
 * property-based tests (design Property 15).
 *
 * Guarantees (Req 10.4, 10.5):
 * - Bounded: retains at least the {@link DEFAULT_ERROR_LOG_CAPACITY} (50) most
 *   recent entries.
 * - Non-destructive toward newer data: when the log is full, the oldest entry
 *   is dropped — a newer entry is never discarded in favor of an older one.
 * - Newest-first: {@link ErrorLog.entries} returns entries ordered from most
 *   recent to oldest (non-increasing by timestamp).
 *
 * The {@link ErrorLog.serialize}/{@link ErrorLog.deserialize} pair defines the
 * persistence shape used by the plugin data store so the log survives restarts.
 */

import type { ErrorLogEntry } from "./types";

/**
 * The default and minimum number of most-recent entries the log retains
 * (Req 10.4). The log keeps at least this many entries; once this many are
 * held, appending a newer entry evicts the single oldest entry.
 */
export const DEFAULT_ERROR_LOG_CAPACITY = 50;

/**
 * The serialized, persistence-friendly shape of an {@link ErrorLog}.
 *
 * Entries are stored newest-first, matching the in-memory ordering, so the
 * persisted form can be displayed directly without re-sorting.
 */
export interface ErrorLogState {
  /** Maximum number of entries retained. */
  capacity: number;
  /** Recorded entries, ordered newest-first. */
  entries: ErrorLogEntry[];
}

/**
 * An internal entry augmented with a monotonic insertion sequence number. The
 * sequence provides a deterministic tie-break for entries that share an
 * identical timestamp: among equal timestamps, the more recently appended
 * entry is considered newer.
 */
interface StoredEntry extends ErrorLogEntry {
  seq: number;
}

/**
 * Order two stored entries newest-first: descending by timestamp, then
 * descending by insertion sequence to break ties deterministically.
 */
function newestFirst(a: StoredEntry, b: StoredEntry): number {
  if (b.timestampUtc !== a.timestampUtc) {
    return b.timestampUtc - a.timestampUtc;
  }
  return b.seq - a.seq;
}

/**
 * A bounded, newest-first log of synchronization errors.
 */
export class ErrorLog {
  /** Maximum number of entries retained. */
  private readonly capacity: number;

  /** Entries kept sorted newest-first. */
  private items: StoredEntry[];

  /** Monotonic counter assigning each appended entry a unique sequence. */
  private seqCounter: number;

  /**
   * Create an error log.
   *
   * @param capacity The maximum number of entries to retain. Defaults to
   *   {@link DEFAULT_ERROR_LOG_CAPACITY} (50). Must be a positive integer.
   */
  constructor(capacity: number = DEFAULT_ERROR_LOG_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `ErrorLog capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.capacity = capacity;
    this.items = [];
    this.seqCounter = 0;
  }

  /**
   * Append a new error entry.
   *
   * The entry is inserted in newest-first order. If the log already holds
   * {@link capacity} entries, the single oldest entry is evicted after the
   * insertion, guaranteeing a newer entry is never discarded in favor of an
   * older one (Req 10.4).
   *
   * @param timestampUtc Failure timestamp as epoch milliseconds, UTC.
   * @param description  Human-readable description of the failure cause.
   */
  append(timestampUtc: number, description: string): void {
    const entry: StoredEntry = {
      timestampUtc,
      description,
      seq: this.seqCounter++,
    };

    // Insert and keep the list sorted newest-first.
    this.items.push(entry);
    this.items.sort(newestFirst);

    // Enforce the bound by dropping the oldest entries (tail of a
    // newest-first list). Only ever removes entries older than every retained
    // entry, so a newer entry is never discarded in favor of an older one.
    if (this.items.length > this.capacity) {
      this.items.length = this.capacity;
    }
  }

  /**
   * Append an existing {@link ErrorLogEntry}.
   *
   * Convenience wrapper over {@link append}.
   */
  appendEntry(entry: ErrorLogEntry): void {
    this.append(entry.timestampUtc, entry.description);
  }

  /**
   * Return the recorded entries ordered from most recent to oldest
   * (non-increasing by timestamp) (Req 10.5).
   *
   * The returned array is a fresh copy of plain {@link ErrorLogEntry} values;
   * mutating it does not affect the log.
   */
  entries(): ErrorLogEntry[] {
    return this.items.map(({ timestampUtc, description }) => ({
      timestampUtc,
      description,
    }));
  }

  /** The number of entries currently retained. */
  size(): number {
    return this.items.length;
  }

  /**
   * Produce the persistence-friendly {@link ErrorLogState} for this log.
   *
   * Entries are emitted newest-first.
   */
  serialize(): ErrorLogState {
    return {
      capacity: this.capacity,
      entries: this.entries(),
    };
  }

  /**
   * Reconstruct an {@link ErrorLog} from a persisted {@link ErrorLogState}.
   *
   * The reconstructed log preserves newest-first ordering and re-applies the
   * capacity bound. Malformed or oversized state is normalized: entries are
   * re-sorted newest-first and trimmed to capacity.
   */
  static deserialize(state: ErrorLogState): ErrorLog {
    const capacity =
      Number.isInteger(state?.capacity) && state.capacity >= 1
        ? state.capacity
        : DEFAULT_ERROR_LOG_CAPACITY;

    const log = new ErrorLog(capacity);
    const entries = Array.isArray(state?.entries) ? state.entries : [];

    // Append oldest-first so insertion sequence numbers increase with age,
    // keeping the tie-break consistent with the original insertion order.
    const oldestFirst = [...entries].sort(
      (a, b) => a.timestampUtc - b.timestampUtc,
    );
    for (const entry of oldestFirst) {
      log.append(entry.timestampUtc, entry.description);
    }

    return log;
  }
}
