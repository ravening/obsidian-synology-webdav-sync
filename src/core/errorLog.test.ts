import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ErrorLog,
  DEFAULT_ERROR_LOG_CAPACITY,
  type ErrorLogEntry,
} from "./index";

/**
 * Property-based test for the bounded, newest-first error log.
 *
 * Feature: obsidian-synology-webdav-sync, Property 15: For any sequence of logged error entries, the error log SHALL retain at least the 50 most recent entries, SHALL never discard a newer entry in favor of an older one, and SHALL present entries ordered from most recent to oldest (non-increasing by timestamp).
 *
 * Validates: Requirements 10.4, 10.5
 */
describe("ErrorLog (Property 15)", () => {
  // An append is a (timestampUtc, description) pair. Timestamps are drawn from
  // a deliberately small pool so the generated sequences contain plenty of
  // duplicate and out-of-order timestamps, exercising the implementation's
  // seq-based deterministic tie-break for equal timestamps.
  const append = (): fc.Arbitrary<ErrorLogEntry> =>
    fc.record({
      timestampUtc: fc.integer({ min: 0, max: 40 }),
      description: fc.string(),
    });

  // Sequences range from empty up to well beyond the capacity (50), so the
  // bound and eviction behavior are exercised.
  const appendSequence = (): fc.Arbitrary<ErrorLogEntry[]> =>
    fc.array(append(), { minLength: 0, maxLength: 160 });

  /**
   * Reference model: assign each append a monotonic insertion sequence, then
   * order newest-first (descending timestamp, then descending insertion
   * sequence to break ties) and keep the newest `capacity` entries. This
   * mirrors the implementation's deterministic tie-break without depending on
   * its internals.
   */
  function expectedRetained(
    appends: ErrorLogEntry[],
    capacity: number,
  ): { kept: ErrorLogEntry[]; dropped: Array<{ ts: number; seq: number }> } {
    const stored = appends.map((entry, seq) => ({ ...entry, seq }));
    const newestFirst = [...stored].sort((a, b) =>
      b.timestampUtc !== a.timestampUtc
        ? b.timestampUtc - a.timestampUtc
        : b.seq - a.seq,
    );
    const keptStored = newestFirst.slice(0, capacity);
    const droppedStored = newestFirst.slice(capacity);
    return {
      kept: keptStored.map(({ timestampUtc, description }) => ({
        timestampUtc,
        description,
      })),
      dropped: droppedStored.map(({ timestampUtc, seq }) => ({
        ts: timestampUtc,
        seq,
      })),
    };
  }

  it("retains the most recent entries (>= 50), evicts only older ones, and presents them newest-first", () => {
    fc.assert(
      fc.property(appendSequence(), (appends) => {
        const log = new ErrorLog(); // default capacity = 50
        for (const { timestampUtc, description } of appends) {
          log.append(timestampUtc, description);
        }

        const got = log.entries();

        // (a) Newest-first ordering: non-increasing by timestamp (Req 10.5).
        for (let i = 1; i < got.length; i++) {
          expect(got[i].timestampUtc).toBeLessThanOrEqual(
            got[i - 1].timestampUtc,
          );
        }

        // (b) Bounded: never holds more than the capacity, and holds every
        //     entry when the sequence is within the bound (Req 10.4).
        const expectedSize = Math.min(
          appends.length,
          DEFAULT_ERROR_LOG_CAPACITY,
        );
        expect(log.size()).toBe(expectedSize);
        expect(got.length).toBe(expectedSize);

        // (c) The retained set is exactly the newest min(N, capacity) appended
        //     entries (with the seq-based tie-break for equal timestamps).
        const { kept, dropped } = expectedRetained(
          appends,
          DEFAULT_ERROR_LOG_CAPACITY,
        );
        expect(got).toEqual(kept);

        // (d) No newer entry is discarded in favor of an older one: every
        //     dropped entry is older (timestamp, then insertion seq) than
        //     every retained entry.
        if (dropped.length > 0) {
          const retainedStored = appends
            .map((entry, seq) => ({ ts: entry.timestampUtc, seq }))
            .sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : b.seq - a.seq))
            .slice(0, DEFAULT_ERROR_LOG_CAPACITY);
          const oldestRetained = retainedStored[retainedStored.length - 1];
          for (const d of dropped) {
            const dropOlder =
              d.ts < oldestRetained.ts ||
              (d.ts === oldestRetained.ts && d.seq < oldestRetained.seq);
            expect(dropOlder).toBe(true);
          }
        }
      }),
    );
  });
});
