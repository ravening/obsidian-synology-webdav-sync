import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  RetryQueue,
  serializeQueue,
  deserializeQueue,
  type QueueStorage,
} from "./retryQueue";
import type { ChangeKind, PendingChange } from "./types";

/**
 * Property-based test for the retry-queue persist/load round-trip.
 *
 * Feature: obsidian-synology-webdav-sync, Property 9: For any retry-queue
 * contents, calling persist() and then load() into a fresh queue SHALL
 * reconstruct an equal queue (same set of pending changes with identical id,
 * kind, path, fromPath, attempts, and nextAttemptAt).
 *
 * Validates: Requirements 8.7
 */

/**
 * An in-memory {@link QueueStorage} fake used to drive persist -> load without
 * touching real I/O. It mirrors the production data store: `save` records the
 * serialized blob and `load` returns it (or `null` before anything is saved).
 */
class InMemoryQueueStorage implements QueueStorage {
  private data: string | null = null;

  async save(serialized: string): Promise<void> {
    this.data = serialized;
  }

  async load(): Promise<string | null> {
    return this.data;
  }
}

const changeKindArb: fc.Arbitrary<ChangeKind> = fc.constantFrom(
  "create",
  "modify",
  "delete",
  "rename",
);

/**
 * Generate an array of already-normalized PendingChange values:
 * - ids are made distinct (index-based) so the reconstructed contents can be
 *   compared unambiguously;
 * - `attempts` is an integer in 0..10 (the queue's clamp range) so the clamp is
 *   the identity and the round-trip is exact;
 * - `fromPath` is present only for a `rename` (matching the data model), and
 *   omitted otherwise so the normalized shape matches the generated shape;
 * - `nextAttemptAt` is a finite integer epoch-ms value.
 */
const changesArb: fc.Arbitrary<PendingChange[]> = fc
  .array(
    fc.record({
      kind: changeKindArb,
      path: fc.string(),
      fromPath: fc.string(),
      attempts: fc.integer({ min: 0, max: 10 }),
      nextAttemptAt: fc.integer({ min: 0, max: 4_000_000_000_000 }),
    }),
    { maxLength: 50 },
  )
  .map((raw) =>
    raw.map((entry, index): PendingChange => {
      const change: PendingChange = {
        id: `change-${index}`,
        kind: entry.kind,
        path: entry.path,
        attempts: entry.attempts,
        nextAttemptAt: entry.nextAttemptAt,
      };
      if (entry.kind === "rename") {
        change.fromPath = entry.fromPath;
      }
      return change;
    }),
  );

/** Order-independent comparison key: sort changes by their unique id. */
const byId = (changes: PendingChange[]): PendingChange[] =>
  [...changes].sort((a, b) => a.id.localeCompare(b.id));

describe("RetryQueue persistence round-trip (Property 9)", () => {
  it("persist() then load() into a fresh queue reconstructs an equal queue", async () => {
    await fc.assert(
      fc.asyncProperty(changesArb, async (changes) => {
        const storage = new InMemoryQueueStorage();

        // Populate a source queue and persist it through the storage backend.
        const source = new RetryQueue(storage);
        for (const change of changes) {
          expect(source.enqueue(change)).toBe(true);
        }
        await source.persist();

        // Reconstruct into a completely fresh queue from the same storage.
        const reloaded = new RetryQueue(storage);
        await reloaded.load();

        // The reconstructed contents equal the originals (id, kind, path,
        // fromPath, attempts, nextAttemptAt), independent of ordering.
        expect(byId(reloaded.snapshot())).toEqual(byId(changes));
      }),
    );
  });

  it("serializeQueue/deserializeQueue is an exact inverse for arbitrary contents", () => {
    fc.assert(
      fc.property(changesArb, (changes) => {
        const reconstructed = deserializeQueue(serializeQueue(changes));
        expect(byId(reconstructed)).toEqual(byId(changes));
      }),
    );
  });

  it("round-trips an empty queue to an empty queue", async () => {
    const storage = new InMemoryQueueStorage();
    const source = new RetryQueue(storage);
    await source.persist();

    const reloaded = new RetryQueue(storage);
    await reloaded.load();

    expect(reloaded.snapshot()).toEqual([]);
  });

  it("preserves fromPath for a rename change across the round-trip", async () => {
    const storage = new InMemoryQueueStorage();
    const source = new RetryQueue(storage);
    source.enqueue({
      id: "r1",
      kind: "rename",
      path: "notes/new.md",
      fromPath: "notes/old.md",
      attempts: 3,
      nextAttemptAt: 1_700_000_000_000,
    });
    await source.persist();

    const reloaded = new RetryQueue(storage);
    await reloaded.load();

    expect(reloaded.snapshot()).toEqual([
      {
        id: "r1",
        kind: "rename",
        path: "notes/new.md",
        fromPath: "notes/old.md",
        attempts: 3,
        nextAttemptAt: 1_700_000_000_000,
      },
    ]);
  });
});
