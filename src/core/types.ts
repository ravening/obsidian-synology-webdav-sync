/**
 * Shared data models and interfaces for the Obsidian Synology WebDAV Sync plugin.
 *
 * These are the pure, platform-agnostic types referenced across every layer
 * (core logic, transport, WebDAV client, sync engine, and UI). Nothing in this
 * module imports a desktop-only API; the types are usable on both desktop and
 * mobile.
 */

// ---------------------------------------------------------------------------
// Connection settings (Req 2.1, 2.2, 2.3)
// ---------------------------------------------------------------------------

/**
 * User-provided WebDAV connection details, persisted in the credential store.
 */
export interface ConnectionSettings {
  /** Server endpoint URL: 1..2048 chars, http(s) scheme + host. */
  endpoint: string;
  /** Username: 1..255 chars. */
  username: string;
  /** Password: 1..255 chars (masked in the UI). */
  password: string;
}

// ---------------------------------------------------------------------------
// File metadata and remote listings (Req 5.1, 5.2)
// ---------------------------------------------------------------------------

/**
 * A remote or local file's identity used for sync decisions.
 */
export interface FileMeta {
  /** Vault-relative path, normalized with forward slashes. */
  path: string;
  /** Last-modified time as epoch milliseconds, UTC. */
  modifiedUtc: number;
  /** Size in bytes; integer in the range 0 .. 2^63-1. */
  size: number;
}

/**
 * A structured representation of the files present on the WebDAV server.
 */
export interface RemoteFileListing {
  entries: FileMeta[];
}

// ---------------------------------------------------------------------------
// Remote folder listings (Req 1.6, 2.1)
// ---------------------------------------------------------------------------

/** A single child collection (directory) on the WebDAV server. */
export interface RemoteFolder {
  /** Display name (the last path segment), e.g. "Notes". */
  name: string;
  /** Server-relative, normalized Folder_Path of this folder, e.g. "vault/Notes". */
  path: string;
}

/** The immediate child folders of a single browsed Remote_Folder. */
export interface RemoteFolderListing {
  /** The normalized Folder_Path of the folder that was listed. */
  path: string;
  /** Immediate child folders only (no files, no self-entry). */
  folders: RemoteFolder[];
}

// ---------------------------------------------------------------------------
// Pending changes / retry queue (Req 8.5)
// ---------------------------------------------------------------------------

/** The kind of local change that must be propagated to the server. */
export type ChangeKind = "create" | "modify" | "delete" | "rename";

/**
 * A change queued for retry when the server is unreachable.
 */
export interface PendingChange {
  /** Unique identifier for the queued change. */
  id: string;
  /** The kind of change to apply remotely. */
  kind: ChangeKind;
  /** Vault-relative path of the affected file. */
  path: string;
  /** Original path for a rename change. */
  fromPath?: string;
  /** Number of attempts made so far; 0..10. */
  attempts: number;
  /** Epoch ms at which the change is next eligible for retry. */
  nextAttemptAt: number;
}

// ---------------------------------------------------------------------------
// Connection test (Req 3.x)
// ---------------------------------------------------------------------------

/**
 * The single, exclusive result of a connection test.
 */
export interface ConnectionTestResult {
  kind:
    | "success"
    | "auth-failure"
    | "connectivity-failure"
    | "timeout"
    | "missing-settings";
  message: string;
}

// ---------------------------------------------------------------------------
// Error log and status (Req 10.x)
// ---------------------------------------------------------------------------

/**
 * A single recorded synchronization error.
 */
export interface ErrorLogEntry {
  /** Failure timestamp as epoch milliseconds, UTC. */
  timestampUtc: number;
  /** Human-readable description of the failure cause. */
  description: string;
}

/**
 * The current synchronization status surfaced in the status bar.
 */
export interface SyncStatus {
  state: "idle" | "in-progress" | "success" | "error";
  /** Completion or failure timestamp as epoch milliseconds, UTC. */
  timestampUtc?: number;
  /** Description of the current state (e.g. failure cause). */
  description?: string;
}

// ---------------------------------------------------------------------------
// Sync decisions and reporting (Req 6.x)
// ---------------------------------------------------------------------------

/**
 * The action chosen by `decideAction` for a single file pair.
 */
export type SyncAction =
  | "upload"
  | "download"
  | "skip"
  | "conflict"
  | "delete-remote";

/**
 * A file that failed to transfer during a full synchronization.
 */
export interface FailedTransfer {
  /** Vault-relative path of the file that failed. */
  path: string;
  /** Description of the cause of the failure. */
  error: string;
}

/**
 * The outcome of a full synchronization run.
 */
export interface SyncReport {
  uploaded: number;
  downloaded: number;
  failed: FailedTransfer[];
}

// ---------------------------------------------------------------------------
// Transport (Req 4.6, 4.7, 4.8)
// ---------------------------------------------------------------------------

/**
 * A platform-agnostic HTTP request handed to the Transport.
 */
export interface HttpRequest {
  url: string;
  /** HTTP method, e.g. GET, PUT, DELETE, PROPFIND, MKCOL, MOVE. */
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}

/**
 * A platform-agnostic HTTP response returned by the Transport.
 */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

/**
 * The single module that performs network I/O. Wraps Obsidian `requestUrl()`.
 *
 * Implementations never throw on a non-2xx status; they return the response so
 * the WebDAV client can interpret the status code. They reject only on
 * transport-level failure (unreachable host, TLS error, timeout).
 */
export interface Transport {
  send(request: HttpRequest, timeoutMs: number): Promise<HttpResponse>;
}
