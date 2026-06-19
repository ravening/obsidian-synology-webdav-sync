/**
 * Status Reporter — drives a status-bar item and a newest-first error-log
 * surface (Req 10).
 *
 * The reporter keeps a pure, inspectable state model (the current
 * {@link SyncStatus}) and mirrors that state onto an injectable
 * {@link StatusBarView}. Keeping the view behind a tiny interface lets the
 * reporter be exercised in tests without any Obsidian runtime: a test can
 * supply a fake view and read back {@link StatusReporter.status} and
 * {@link StatusReporter.errorEntries}.
 *
 * State reflected (Req 10.1, 10.2, 10.3, 10.6):
 * - `idle`        — no synchronization has run yet.
 * - `in-progress` — a synchronization is running.
 * - `success`     — last synchronization completed; carries a completion
 *                   timestamp.
 * - `error`       — last synchronization failed; carries a failure timestamp
 *                   and a description of the cause.
 *
 * When an error status is set, the reporter also records an entry into the
 * backing {@link ErrorLog} (Req 10.4) and exposes the log newest-first via
 * {@link StatusReporter.errorEntries} (Req 10.5).
 */

import { ErrorLog } from "../core/errorLog";
import type { ErrorLogEntry, SyncStatus } from "../core/types";

/**
 * The minimal surface the reporter needs from a status-bar element. Obsidian's
 * `HTMLElement` status-bar item satisfies this structurally
 * (`setText`/`setAttribute`-style helpers can be adapted), but any object
 * implementing these methods works — including a test fake.
 */
export interface StatusBarView {
  /** Replace the visible status-bar text. */
  setText(text: string): void;
  /** Optionally set hover/tooltip detail for the status-bar item. */
  setTooltip?(tooltip: string): void;
}

/** Human-readable label shown in the status bar for each state. */
const STATE_LABEL: Record<SyncStatus["state"], string> = {
  idle: "Sync: idle",
  "in-progress": "Sync: in progress…",
  success: "Sync: success",
  error: "Sync: error",
};

/**
 * Format an epoch-millisecond UTC timestamp as a stable, human-readable
 * date-and-time string (ISO 8601, UTC). Used to satisfy the "includes the
 * completion/failure timestamp (date and time)" requirements (Req 10.2, 10.3).
 */
function formatTimestamp(timestampUtc: number): string {
  return new Date(timestampUtc).toISOString();
}

/**
 * Drives a status-bar item and a newest-first error-log surface.
 */
export class StatusReporter {
  private readonly view: StatusBarView;
  private readonly errorLog: ErrorLog;
  private current: SyncStatus;

  /**
   * @param view     The injectable status-bar surface to render onto.
   * @param errorLog The backing error log. Defaults to a fresh
   *   {@link ErrorLog} with the default capacity.
   */
  constructor(view: StatusBarView, errorLog: ErrorLog = new ErrorLog()) {
    this.view = view;
    this.errorLog = errorLog;
    // Idle until a synchronization has run (Req 10.6).
    this.current = { state: "idle" };
    this.render();
  }

  /**
   * Set the idle status, indicating no synchronization has occurred (Req 10.6).
   */
  setIdle(): void {
    this.current = { state: "idle" };
    this.render();
  }

  /**
   * Set the in-progress status while a synchronization is running (Req 10.1).
   *
   * @param now Epoch ms at which the operation started.
   */
  setInProgress(now: number): void {
    this.current = { state: "in-progress", timestampUtc: now };
    this.render();
  }

  /**
   * Set the success status, including the completion timestamp (Req 10.2).
   *
   * @param now Epoch ms at which the operation completed.
   */
  setSuccess(now: number): void {
    this.current = { state: "success", timestampUtc: now };
    this.render();
  }

  /**
   * Set the error status, including the failure timestamp and a description of
   * the cause (Req 10.3), and record the failure in the error log (Req 10.4).
   *
   * @param now         Epoch ms at which the failure was detected.
   * @param description Human-readable description of the failure cause.
   */
  setError(now: number, description: string): void {
    this.current = { state: "error", timestampUtc: now, description };
    this.errorLog.append(now, description);
    this.render();
  }

  /**
   * The current synchronization status. Returns a copy so callers cannot
   * mutate the reporter's internal state.
   */
  status(): SyncStatus {
    return { ...this.current };
  }

  /**
   * The recorded error entries ordered from most recent to oldest (Req 10.5).
   */
  errorEntries(): ErrorLogEntry[] {
    return this.errorLog.entries();
  }

  /**
   * Render the current state onto the status-bar view: a concise label in the
   * text and the full detail (including timestamp and cause) in the tooltip.
   */
  private render(): void {
    this.view.setText(this.statusText());
    this.view.setTooltip?.(this.statusDetail());
  }

  /** Build the concise status-bar text for the current state. */
  private statusText(): string {
    const { state, timestampUtc } = this.current;
    if (state === "success" && timestampUtc !== undefined) {
      return `${STATE_LABEL[state]} (${formatTimestamp(timestampUtc)})`;
    }
    if (state === "error" && timestampUtc !== undefined) {
      return `${STATE_LABEL[state]} (${formatTimestamp(timestampUtc)})`;
    }
    return STATE_LABEL[state];
  }

  /** Build the verbose tooltip detail for the current state. */
  private statusDetail(): string {
    const { state, timestampUtc, description } = this.current;
    switch (state) {
      case "idle":
        return "No synchronization has occurred yet.";
      case "in-progress":
        return "Synchronization in progress.";
      case "success":
        return timestampUtc !== undefined
          ? `Last synchronization succeeded at ${formatTimestamp(timestampUtc)}.`
          : "Last synchronization succeeded.";
      case "error": {
        const when =
          timestampUtc !== undefined
            ? ` at ${formatTimestamp(timestampUtc)}`
            : "";
        const cause = description ? `: ${description}` : "";
        return `Last synchronization failed${when}${cause}.`;
      }
    }
  }
}
