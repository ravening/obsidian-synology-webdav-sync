/**
 * Folder browser controller (pure, DOM-free).
 *
 * Holds all decision logic for the Folder Browser so the Obsidian `Modal` that
 * renders it can stay a thin view: navigation state, the single-flight guard
 * that prevents concurrent listing requests, case-insensitive display ordering,
 * new-folder-name validation, duplicate detection, and the mapping of
 * server-facing failures to user-visible messages. It performs no DOM or
 * network I/O of its own — it drives an injected {@link FolderBrowserClient}
 * (satisfied in production by `WebDAVClient`) and never imports Obsidian.
 *
 * Behavior (design "UI: FolderBrowserModal + FolderBrowserController"):
 *  - `navigate`, `navigateToParent`, and `refresh` each issue a single listing
 *    request. While a request is in flight (`loading === true`) any further
 *    listing request is a no-op (single-flight, Req 2.6). On success the
 *    displayed folders are replaced with `sortFolders(listing.folders)` and the
 *    current path advances to the listed path; on failure the current path and
 *    displayed folders are left unchanged and a `kind`-classified error message
 *    is recorded (Req 1.7, 2.7, 2.8, 2.9).
 *  - `createFolder` validates the name locally and checks it against the current
 *    listing for a duplicate *before* contacting the server (no server contact
 *    on an invalid or duplicate name, Req 4.5, 4.6); on a valid, non-duplicate
 *    name it issues exactly one `makeCollection` for the resolved child path and
 *    then refreshes the listing so the new folder appears (Req 4.3, 4.4). The
 *    `creating` guard disables re-entry while a create is in flight (Req 4.9),
 *    and a creation failure leaves the displayed listing unchanged (Req 4.7,
 *    4.8).
 *
 * _Requirements: 1.7, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_
 */

import {
  joinSegment,
  normalizeFolderPath,
  parentOf,
  sortFolders,
  validateFolderName,
  type RemoteFolder,
  type RemoteFolderListing,
} from "../core";

/**
 * The narrow slice of `WebDAVClient` the controller depends on. Keeping it an
 * interface (rather than the concrete client) lets the controller be unit- and
 * property-tested with an in-memory fake and keeps it free of any transport or
 * Obsidian dependency.
 */
export interface FolderBrowserClient {
  /** List the immediate child folders of `path` (Req 1.5, 2.1, 2.4). */
  listFolders(path: string): Promise<RemoteFolderListing>;
  /** Create a collection at `path` (Req 4.3). */
  makeCollection(path: string): Promise<void>;
}

/**
 * The observable state of the browser. The rendering `Modal` reads this after
 * every awaited controller call to redraw itself.
 */
export type BrowserState = {
  /** Normalized server-relative path of the folder currently being browsed. */
  currentPath: string;
  /** Sorted children of `currentPath` (Req 2.2). */
  folders: RemoteFolder[];
  /** Single-flight listing guard; true while a listing request is in flight (Req 2.6). */
  loading: boolean;
  /** Last error message, or `null` when the last operation succeeded (Req 1.7, 2.7–2.9, 4.7, 4.8). */
  error: string | null;
  /** Create-in-flight guard; true while a folder creation is in flight (Req 4.9). */
  creating: boolean;
};

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Name carried by the transport's no-response timeout error. The 30-second
 * budget (Req 2.7, 4.8) is enforced by the transport layer, which rejects with
 * an error whose `name` is this value; the controller detects a timeout by that
 * name rather than coupling to the transport module. Mirrors the same detection
 * the `WebDAVClient` connection test performs.
 */
const TRANSPORT_TIMEOUT_ERROR_NAME = "TransportTimeoutError";

/** User-visible message for an authentication failure (Req 2.9, 4.7). */
export const AUTH_ERROR_MESSAGE =
  "Authentication was rejected by the server. Check your username and password.";

/** User-visible message for a request timeout (Req 2.7, 4.8). */
export const TIMEOUT_ERROR_MESSAGE =
  "The request timed out: the server did not respond in time.";

/** User-visible message for a connectivity or server failure (Req 1.7, 2.8, 4.7). */
export const CONNECTIVITY_ERROR_MESSAGE =
  "The server could not be reached or returned an unexpected response.";

/** True when `error` is an object carrying the given WebDAV error `kind`. */
function hasErrorKind(error: unknown, kind: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error as { kind?: unknown }).kind === kind
  );
}

/** True when `error` is the transport's no-response timeout error. */
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === TRANSPORT_TIMEOUT_ERROR_NAME
  );
}

/**
 * Map a thrown server-facing failure to a non-empty, user-visible message by
 * its category: an `auth-failure` `kind` → the authentication message; a
 * transport timeout → the timeout message; everything else (connectivity,
 * server error, redirect limit, malformed XML) → the connectivity/server
 * message. Never string-matches; classification is by the error's discriminator
 * or name only.
 */
export function classifyBrowserError(error: unknown): string {
  if (hasErrorKind(error, "auth-failure")) {
    return AUTH_ERROR_MESSAGE;
  }
  if (isTimeoutError(error)) {
    return TIMEOUT_ERROR_MESSAGE;
  }
  return CONNECTIVITY_ERROR_MESSAGE;
}

/**
 * Build the duplicate-name message shown when a create is rejected locally
 * because a sibling of the same name already exists (Req 4.6).
 */
function duplicateMessage(name: string): string {
  return `A folder named "${name}" already exists here.`;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class FolderBrowserController {
  private readonly currentState: BrowserState;

  /**
   * @param client the listing/creation backend (production: `WebDAVClient`).
   * @param initialPath the folder to browse first; defaults to the server root
   *   (`""`). It is normalized so the controller always holds a canonical path.
   */
  constructor(
    private readonly client: FolderBrowserClient,
    initialPath = "",
  ) {
    this.currentState = {
      currentPath: normalizeFolderPath(initialPath),
      folders: [],
      loading: false,
      error: null,
      creating: false,
    };
  }

  /** A read-only snapshot of the current browser state. */
  get state(): Readonly<BrowserState> {
    return this.currentState;
  }

  /**
   * Browse into `path`, requesting its child folder listing (Req 2.4). A no-op
   * while a listing request is already in flight (single-flight, Req 2.6).
   */
  async navigate(path: string): Promise<void> {
    await this.loadListing(path);
  }

  /**
   * Browse up to the parent of the folder currently being browsed (Req 2.5). A
   * no-op while a listing request is already in flight (Req 2.6).
   */
  async navigateToParent(): Promise<void> {
    await this.loadListing(parentOf(this.currentState.currentPath));
  }

  /**
   * Re-request the listing of the folder currently being browsed (Req 4.4). A
   * no-op while a listing request is already in flight (Req 2.6).
   */
  async refresh(): Promise<void> {
    await this.loadListing(this.currentState.currentPath);
  }

  /**
   * Create a new child folder named `name` within the folder currently being
   * browsed, then refresh the listing so it appears (Req 4.3, 4.4).
   *
   * The name is validated locally and checked against the current listing for a
   * duplicate before any server contact (Req 4.5, 4.6): an invalid or duplicate
   * name records an error message and returns without issuing a request. A
   * second create while one is in flight is a no-op (the `creating` guard,
   * Req 4.9). A failed `makeCollection` leaves the displayed listing unchanged
   * and records a `kind`-classified error message (Req 4.7, 4.8).
   */
  async createFolder(name: string): Promise<void> {
    // Re-entry guard: a create already in flight (Req 4.9).
    if (this.currentState.creating) {
      return;
    }

    // Local validation — no server contact on an invalid name (Req 4.5).
    const validation = validateFolderName(name);
    if (!validation.valid) {
      this.currentState.error = validation.message;
      return;
    }

    // Duplicate detection against the loaded listing — no server contact on a
    // duplicate (Req 4.6). The match is exact, as the server stores the name
    // verbatim.
    const isDuplicate = this.currentState.folders.some(
      (folder) => folder.name === name,
    );
    if (isDuplicate) {
      this.currentState.error = duplicateMessage(name);
      return;
    }

    this.currentState.creating = true;
    this.currentState.error = null;
    try {
      await this.client.makeCollection(
        joinSegment(this.currentState.currentPath, name),
      );
      // Refresh so the created folder appears in the listing (Req 4.4). The
      // listing's own single-flight guard is clear here (loading === false),
      // and it records its own error on failure.
      await this.loadListing(this.currentState.currentPath);
    } catch (error) {
      // A creation failure leaves the displayed listing unchanged (Req 4.7, 4.8).
      this.currentState.error = classifyBrowserError(error);
    } finally {
      this.currentState.creating = false;
    }
  }

  /**
   * Shared listing routine for `navigate`/`navigateToParent`/`refresh`.
   *
   * Enforces the single-flight guard (Req 2.6): a no-op while a listing request
   * is already in flight. On success the current path advances to the listed
   * path and the displayed folders are replaced with the sorted children
   * (Req 2.2). On failure the current path and displayed folders are left
   * unchanged and a `kind`-classified error message is recorded (Req 1.7, 2.7,
   * 2.8, 2.9).
   */
  private async loadListing(path: string): Promise<void> {
    if (this.currentState.loading) {
      return;
    }

    this.currentState.loading = true;
    this.currentState.error = null;
    try {
      const listing = await this.client.listFolders(path);
      this.currentState.currentPath = normalizeFolderPath(listing.path);
      this.currentState.folders = sortFolders(listing.folders);
    } catch (error) {
      // Leave currentPath and folders untouched on failure (Req 1.7, 2.7–2.9).
      this.currentState.error = classifyBrowserError(error);
    } finally {
      this.currentState.loading = false;
    }
  }
}
