import fc from "fast-check";
import { afterEach, vi } from "vitest";

/**
 * Global test setup.
 *
 * fast-check: enforce the design's minimum of 100 iterations for every
 * property-based test unless a test overrides `numRuns` explicitly. A verbose
 * report makes counterexamples easy to read when a property fails.
 */
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

/**
 * Fake-timer helpers for the 30-second request timeout (Req 4.7, 4.8) and the
 * 30-second retry-queue interval (Req 8.5). Tests opt in with `useFakeClock()`
 * so they can advance time deterministically without real waiting.
 */
export function useFakeClock(): void {
  vi.useFakeTimers();
}

/** Advance fake time and flush any pending microtasks (resolved promises). */
export async function advanceTime(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// Always restore real timers between tests so fake clocks never leak across
// test boundaries.
afterEach(() => {
  vi.useRealTimers();
});
