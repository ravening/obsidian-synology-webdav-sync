import { describe, it, expect, vi } from "vitest";
import { StatusReporter, type StatusBarView } from "./statusReporter";

/**
 * Unit tests for {@link StatusReporter} status states (Req 10.1, 10.2, 10.3, 10.6).
 *
 * Each test injects a fake {@link StatusBarView} (with spied `setText`/
 * `setTooltip`) so the assertions can confirm both the inspectable state model
 * (`status()` / `errorEntries()`) and that the view is updated.
 */

/** Build a fake status-bar view with spied methods. */
function makeFakeView(): StatusBarView & {
  setText: ReturnType<typeof vi.fn>;
  setTooltip: ReturnType<typeof vi.fn>;
} {
  return {
    setText: vi.fn(),
    setTooltip: vi.fn(),
  };
}

describe("StatusReporter status states", () => {
  it("is idle when no synchronization has run (Req 10.6)", () => {
    // Validates: Requirements 10.6
    const view = makeFakeView();
    const reporter = new StatusReporter(view);

    expect(reporter.status().state).toBe("idle");
    // The view is rendered on construction.
    expect(view.setText).toHaveBeenCalled();
    expect(view.setText).toHaveBeenLastCalledWith("Sync: idle");
  });

  it("enters in-progress when a sync starts (Req 10.1)", () => {
    // Validates: Requirements 10.1
    const view = makeFakeView();
    const reporter = new StatusReporter(view);

    const now = Date.now();
    reporter.setInProgress(now);

    expect(reporter.status().state).toBe("in-progress");
    expect(reporter.status().timestampUtc).toBe(now);
    // The view text is updated to reflect the in-progress state.
    expect(view.setText).toHaveBeenLastCalledWith("Sync: in progress…");
  });

  it("reports success with the completion timestamp (Req 10.2)", () => {
    // Validates: Requirements 10.2
    const view = makeFakeView();
    const reporter = new StatusReporter(view);

    const now = 1_700_000_000_000;
    reporter.setSuccess(now);

    const status = reporter.status();
    expect(status.state).toBe("success");
    expect(status.timestampUtc).toBe(now);
    // The view text reflects success and includes the timestamp.
    const text = view.setText.mock.calls.at(-1)?.[0] as string;
    expect(text).toContain("Sync: success");
    expect(text).toContain(new Date(now).toISOString());
  });

  it("reports error with timestamp and cause and records an error entry (Req 10.3)", () => {
    // Validates: Requirements 10.3
    const view = makeFakeView();
    const reporter = new StatusReporter(view);

    const now = 1_700_000_500_000;
    const description = "PROPFIND failed: 401 Unauthorized";
    reporter.setError(now, description);

    const status = reporter.status();
    expect(status.state).toBe("error");
    expect(status.timestampUtc).toBe(now);
    expect(status.description).toBe(description);

    // An error entry is recorded and surfaced (newest-first).
    const entries = reporter.errorEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ timestampUtc: now, description });

    // The view text reflects the error and includes the timestamp.
    const text = view.setText.mock.calls.at(-1)?.[0] as string;
    expect(text).toContain("Sync: error");
    expect(text).toContain(new Date(now).toISOString());
  });

  it("records multiple error entries newest-first (Req 10.3)", () => {
    // Validates: Requirements 10.3
    const view = makeFakeView();
    const reporter = new StatusReporter(view);

    reporter.setError(1_000, "older failure");
    reporter.setError(2_000, "newer failure");

    const entries = reporter.errorEntries();
    expect(entries).toEqual([
      { timestampUtc: 2_000, description: "newer failure" },
      { timestampUtc: 1_000, description: "older failure" },
    ]);
  });
});
