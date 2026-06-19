import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  MAX_ATTEMPTS,
  MAX_QUEUE_SIZE,
  RETRY_INTERVAL_MS,
  RetryQueue,
  isExhausted,
} from "./index";
import type { ChangeKind, PendingChange } from "./index";

/**
 * Property-based test for the retry queue's capacity, attempt, and scheduling
 * bounds. Validates Requirements 8.5, 8.6.
 *
 * Feature: obsidian-synology-webdav-sync, Property 8: For any sequence of
 * `enqueue` and `recordResult(success=false)` operations, the retry queue SHALL
 * maintain `size() <= 1000`; `enqueue` SHALL return `false` (and not grow the
 * queue) once 1000 entries are held; no entry's `attempts` SHALL exceed 10; a
 * change driven to 10 failed attempts SHALL remain in the queue (flagged
 * failed) rather than being silently dropped; and `due(now)` SHALL return only
 * entries whose `nextAttemptAt <= now`, with each failed attempt advancing
 * `nextAttemptAt` by at least the 30-second retry interval.
 */

// ---------------------------------------------------------------------------
// Operation model. Each step is either an enqueue (with a fresh distinct id) or
// a failed recordResult targeting an id that may or may not exist in the queue.
// ---------------------------------------------------------------------------

const kindArb: fc.Arbitrary<ChangeKind> = fc.constantFrom(
  "create",
  "modify",
  "delete",
  "rename",
);

type Op =
  // Enqueue a change; the concrete id is assigned during the run so ids stay
  // distinct. `slot` selects which previously-seen id the queue might reference.
  | { t: "enqueue"; kind: ChangeKind; path: string; nextOffset: number }
  // Fail the attempt for the id at `slot` among ids enqueued so far (a no-op
  // when the slot has already been removed or never existed).
  | { t: "fail"; slot: number; now: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    t: fc.constant("enqueue" as const),
    kind: kindArb,
    path: fc.string({ maxLength: 20 }),
    // nextAttemptAt anchored within a bounded window so the due() clock checks
    // exercise both eligible and not-yet-eligible entries.
    nextOffset: fc.integer({ min: -RETRY_INTERVAL_MS, max: RETRY_INTERVAL_MS }),
  }),
  fc.record({
    t: fc.constant("fail" as const),
    slot: fc.nat({ max: 50 }),
    now: fc.integer({ min: 0, max: 5_000_000 }),
  }),
);

// A base clock so all timestamps are realistic epoch-ms-like values.
const BASE = 1_700_000_000_000;

describe("RetryQueue bounds and scheduling (Property 8)", () => {
  // Validates: Requirements 8.5, 8.6
  it("respects capacity, attempt caps, retention, and 30s scheduling", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 200 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (ops, dueClockOffset) => {
          const queue = new RetryQueue();
          const ids: string[] = [];
          let counter = 0;

          for (const op of ops) {
            if (op.t === "enqueue") {
              const id = `c${counter++}`;
              const change: PendingChange = {
                id,
                kind: op.kind,
                path: op.path,
                attempts: 0,
                nextAttemptAt: BASE + op.nextOffset,
              };
              const sizeBefore = queue.size();
              const accepted = queue.enqueue(change);

              if (sizeBefore >= MAX_QUEUE_SIZE) {
                // Past capacity: enqueue is rejected and the queue is unchanged.
                expect(accepted).toBe(false);
                expect(queue.size()).toBe(sizeBefore);
              } else {
                expect(accepted).toBe(true);
                expect(queue.size()).toBe(sizeBefore + 1);
                ids.push(id);
              }
            } else {
              // Fail the attempt for some previously-seen id. Capture its prior
              // schedule so we can assert the >= 30s advance for entries that
              // were actually present and not yet exhausted.
              if (ids.length > 0) {
                const id = ids[op.slot % ids.length];
                const now = BASE + op.now;
                const before = queue
                  .snapshot()
                  .find((c) => c.id === id);
                queue.recordResult(id, false, now);

                if (before && !isExhausted(before)) {
                  const after = queue.snapshot().find((c) => c.id === id);
                  // A non-exhausted change is never dropped on failure.
                  expect(after).toBeDefined();
                  if (after) {
                    expect(after.attempts).toBe(before.attempts + 1);
                    // nextAttemptAt advances by at least the retry interval
                    // relative to both the prior schedule and the clock.
                    expect(after.nextAttemptAt).toBeGreaterThanOrEqual(
                      before.nextAttemptAt + RETRY_INTERVAL_MS,
                    );
                    expect(after.nextAttemptAt).toBeGreaterThanOrEqual(
                      now + RETRY_INTERVAL_MS,
                    );
                  }
                }
              }
            }

            // Invariants that must hold after every operation.
            expect(queue.size()).toBeLessThanOrEqual(MAX_QUEUE_SIZE);
            for (const c of queue.snapshot()) {
              expect(c.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
              expect(c.attempts).toBeGreaterThanOrEqual(0);
            }
          }

          // due(now) returns only eligible, non-exhausted entries.
          const dueNow = BASE + dueClockOffset;
          const due = queue.due(dueNow);
          const dueIds = new Set(due.map((c) => c.id));
          for (const c of due) {
            expect(c.nextAttemptAt).toBeLessThanOrEqual(dueNow);
            expect(isExhausted(c)).toBe(false);
          }
          // Every queue entry that is eligible and not exhausted must appear in
          // due(); exhausted ones are retained but excluded.
          for (const c of queue.snapshot()) {
            if (!isExhausted(c) && c.nextAttemptAt <= dueNow) {
              expect(dueIds.has(c.id)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 8.6
  it("retains a change driven to 10 failed attempts (flagged failed, not dropped)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), kindArb, (path, kind) => {
        const queue = new RetryQueue();
        const id = "exhaust-me";
        queue.enqueue({ id, kind, path, attempts: 0, nextAttemptAt: BASE });

        // Drive the change past MAX_ATTEMPTS failures.
        for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
          queue.recordResult(id, false, BASE);
        }

        const change = queue.snapshot().find((c) => c.id === id);
        // Retained in the queue rather than dropped.
        expect(change).toBeDefined();
        // attempts capped at MAX_ATTEMPTS and flagged exhausted.
        expect(change?.attempts).toBe(MAX_ATTEMPTS);
        expect(change && isExhausted(change)).toBe(true);
        // Exhausted changes are excluded from due() but still present.
        expect(queue.due(Number.MAX_SAFE_INTEGER).some((c) => c.id === id)).toBe(
          false,
        );
        expect(queue.exhausted().some((c) => c.id === id)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
