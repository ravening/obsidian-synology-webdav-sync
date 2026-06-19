/**
 * WebDAV Client.
 *
 * A stateful adapter over a {@link Transport} that isolates the Synology-specific
 * behavior required by the design (design "WebDAV Client" section, Req 4):
 *
 *  - Adds an `Authorization: Basic <base64(username + ":" + password)>` header to
 *    every request, derived from the injected {@link ConnectionSettings}
 *    (Req 4.1). Base64 is computed over the UTF-8 byte encoding of the
 *    credentials using a self-contained encoder, so it works on mobile (no Node
 *    `Buffer`) and handles non-ASCII credentials correctly.
 *  - Sends `Depth: 1` on every `PROPFIND` directory listing (Req 4.2).
 *  - Follows `301/302/307/308` redirects up to a maximum of 5 consecutive
 *    redirects, then aborts with a {@link RedirectLimitError} without performing
 *    any local write (Req 4.3, 4.4).
 *  - Joins request URLs against the configured endpoint via {@link joinUrl}
 *    (Req 4.5).
 *  - Maps a `401` response to a {@link AuthError} and stops the operation
 *    (Req 4.9).
 *  - Uses the injected {@link Transport} with a 30-second timeout (Req 4.7); the
 *    transport itself enforces the timeout and rejects on transport-level
 *    failure.
 *
 * Pure XML building/parsing is delegated to the request builder and response
 * parser cores; this module performs no XML work of its own.
 *
 * _Requirements: 4.1, 4.2, 4.3, 4.4, 4.9, 6.7_
 */
import {
  buildPropfindBody,
  joinUrl,
  parseMultistatus,
  type ConnectionSettings,
  type ConnectionTestResult,
  type HttpRequest,
  type HttpResponse,
  type RemoteFileListing,
  type Transport,
} from "../core";

/** The request timeout applied to every Transport call, in milliseconds (Req 4.7). */
export const REQUEST_TIMEOUT_MS = 30000;

/** Maximum number of consecutive redirects the client will follow (Req 4.3, 4.4). */
export const MAX_REDIRECTS = 5;

/** HTTP status codes treated as redirects to follow (Req 4.3). */
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/**
 * Name carried by the timeout error the production Transport rejects with when
 * no response arrives within the timeout window (see
 * `TransportTimeoutError` in `../transport/requestUrlTransport`). The connection
 * test distinguishes a timeout from a generic connectivity failure by this name
 * rather than importing the production transport, which pulls in the desktop/
 * mobile `obsidian` module. Detecting by name keeps the client free of that
 * dependency and lets a `FakeTransport` reproduce a timeout simply by rejecting
 * with any error whose `name` is `"TransportTimeoutError"` (Req 3.5).
 */
const TRANSPORT_TIMEOUT_ERROR_NAME = "TransportTimeoutError";

/**
 * Decide whether a thrown/rejected value represents a no-response timeout (as
 * opposed to any other transport-level failure). True when the value is an
 * object whose `name` property equals {@link TRANSPORT_TIMEOUT_ERROR_NAME},
 * which covers both the production `TransportTimeoutError` instance and any
 * test double that sets the same `name` (Req 3.5).
 */
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === TRANSPORT_TIMEOUT_ERROR_NAME
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Discriminator for the failure categories the client raises, so callers (the
 * Sync Engine, Status Reporter) can map them to a single user-visible
 * classification without string matching.
 */
export type WebDAVErrorKind =
  | "auth-failure"
  | "redirect-limit"
  | "malformed-xml"
  | "server-error";

/** Base error for every failure surfaced by the WebDAV client. */
export class WebDAVError extends Error {
  readonly kind: WebDAVErrorKind;
  /** The final HTTP status, when the failure originated from a response. */
  readonly status?: number;

  constructor(kind: WebDAVErrorKind, message: string, status?: number) {
    super(message);
    this.name = "WebDAVError";
    this.kind = kind;
    this.status = status;
  }
}

/** Raised when the server rejects credentials with a `401` (Req 4.9). */
export class AuthError extends WebDAVError {
  constructor(message = "Authentication failed.") {
    super("auth-failure", message, 401);
    this.name = "AuthError";
  }
}

/** Raised when a request exceeds the maximum redirect count (Req 4.4). */
export class RedirectLimitError extends WebDAVError {
  constructor(message = `Redirect limit of ${MAX_REDIRECTS} exceeded.`) {
    super("redirect-limit", message);
    this.name = "RedirectLimitError";
  }
}

// ---------------------------------------------------------------------------
// Base64 / Basic auth (mobile-safe, UTF-8 aware)
// ---------------------------------------------------------------------------

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode a UTF-8 string into bytes without relying on Node `Buffer`. */
function utf8Bytes(input: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input);
  }
  // Manual UTF-8 fallback for any environment lacking TextEncoder.
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    // Combine surrogate pairs into a single code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Standard Base64-encode a byte array using a self-contained alphabet table.
 * Avoids `btoa` (binary-string only) and Node `Buffer` so the same code path
 * runs on desktop, mobile, and in tests.
 */
export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < len ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < len ? BASE64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

/**
 * Build the value of the `Authorization` header for HTTP Basic auth from the
 * given credentials (Req 4.1). The credentials are joined as `username:password`,
 * encoded as UTF-8, and Base64-encoded.
 */
export function basicAuthHeader(
  username: string,
  password: string,
): string {
  return `Basic ${base64Encode(utf8Bytes(`${username}:${password}`))}`;
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/** Case-insensitive header lookup (server header casing is not guaranteed). */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Split a path into its non-empty forward-slash segments. */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** The parent directory path of `remotePath`, or "" when it has no parent. */
function parentPathOf(remotePath: string): string {
  const segments = segmentsOf(remotePath);
  if (segments.length <= 1) {
    return "";
  }
  return segments.slice(0, -1).join("/");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Options for an internal request. */
interface RequestOptions {
  body?: string | ArrayBuffer;
  /** Extra headers merged after auth (e.g. `Depth`, `Destination`). */
  headers?: Record<string, string>;
}

/**
 * Stateful WebDAV client bound to a single set of {@link ConnectionSettings}
 * and a single {@link Transport}.
 */
export class WebDAVClient {
  constructor(
    private readonly settings: ConnectionSettings,
    private readonly transport: Transport,
  ) {}

  // -- Directory listing ----------------------------------------------------

  /**
   * List a single directory level with a `PROPFIND` `Depth: 1` request and
   * parse the multistatus response into a {@link RemoteFileListing} (Req 4.2,
   * 5.1). Throws {@link WebDAVError} `malformed-xml` if the body is not
   * well-formed XML.
   */
  async listDirectory(remotePath: string): Promise<RemoteFileListing> {
    const response = await this.request("PROPFIND", remotePath, {
      body: buildPropfindBody(),
      headers: { Depth: "1", "Content-Type": "application/xml" },
    });
    this.assertOk(response, "PROPFIND", remotePath);

    const result = parseMultistatus(response.text);
    if (!result.ok) {
      throw new WebDAVError(
        "malformed-xml",
        `Could not parse multistatus response for ${remotePath}.`,
      );
    }
    return result.listing;
  }

  /**
   * Recursively list a subtree by repeating `Depth: 1` `PROPFIND` calls, one
   * per directory (Synology rejects `Depth: infinity`, design Research
   * Summary). Collection entries (hrefs ending in `/`) are descended into;
   * file entries are collected. A visited set guards against cycles.
   */
  async listTree(remotePath: string): Promise<RemoteFileListing> {
    const entries = new Map<string, RemoteFileListing["entries"][number]>();
    const visited = new Set<string>();
    const queue: string[] = [remotePath];

    while (queue.length > 0) {
      const dir = queue.shift() as string;
      const key = normalizeDirKey(dir);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      const listing = await this.listDirectory(dir);
      for (const entry of listing.entries) {
        const relative = this.hrefToRelativePath(entry.path);
        // Skip the directory's own self-entry returned by Depth:1.
        if (normalizeDirKey(relative) === key) {
          continue;
        }
        if (entry.path.endsWith("/")) {
          // A collection: descend into it.
          queue.push(relative);
        } else {
          entries.set(relative, { ...entry, path: relative });
        }
      }
    }

    return { entries: Array.from(entries.values()) };
  }

  // -- File transfer --------------------------------------------------------

  /** Fetch a file's bytes with `GET` (Req 4.9 auth handling applies). */
  async getFile(remotePath: string): Promise<ArrayBuffer> {
    const response = await this.request("GET", remotePath);
    this.assertOk(response, "GET", remotePath);
    return response.arrayBuffer;
  }

  /**
   * Upload a file with `PUT`, creating any missing parent collections first so
   * a deep path resolves (Req 6.7). Parent creation is issued before the PUT.
   */
  async putFile(remotePath: string, content: ArrayBuffer): Promise<void> {
    const parent = parentPathOf(remotePath);
    if (parent !== "") {
      await this.makeCollection(parent);
    }
    const response = await this.request("PUT", remotePath, {
      body: content,
      headers: { "Content-Type": "application/octet-stream" },
    });
    this.assertOk(response, "PUT", remotePath);
  }

  /** Delete a remote file with `DELETE`. A `404` is treated as already gone. */
  async deleteFile(remotePath: string): Promise<void> {
    const response = await this.request("DELETE", remotePath);
    if (response.status === 404) {
      return;
    }
    this.assertOk(response, "DELETE", remotePath);
  }

  /**
   * Move/rename a remote file with `MOVE`, setting `Destination` to the fully
   * resolved URL of the target path and `Overwrite: T`.
   */
  async moveFile(fromPath: string, toPath: string): Promise<void> {
    const destination = joinUrl(this.settings.endpoint, toPath);
    const response = await this.request("MOVE", fromPath, {
      headers: { Destination: destination, Overwrite: "T" },
    });
    this.assertOk(response, "MOVE", fromPath);
  }

  /**
   * Create a collection at `remotePath` with `MKCOL`, creating each missing
   * ancestor collection first (top-down) so the full path exists (Req 6.7). An
   * existing collection (`405 Method Not Allowed`) is treated as success, which
   * makes the operation idempotent.
   */
  async makeCollection(remotePath: string): Promise<void> {
    const segments = segmentsOf(remotePath);
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      const response = await this.request("MKCOL", current);
      // 2xx => created; 405 => already exists; both are acceptable.
      if (response.status === 405) {
        continue;
      }
      this.assertOk(response, "MKCOL", current);
    }
  }

  // -- Connection test ------------------------------------------------------

  /**
   * Verify that the server is reachable and the stored credentials
   * authenticate, returning exactly one {@link ConnectionTestResult} (Req 3.6).
   *
   * Behavior:
   *
   *  - **missing-settings (Req 3.7):** if the endpoint, username, or password is
   *    empty or whitespace-only, return immediately *without contacting the
   *    Transport at all*. This is gated before any network call so an
   *    incompletely configured test never reaches the server.
   *  - **success (Req 3.2):** the request resolves with an expected status — any
   *    `2xx` or a `207 Multi-Status` (the normal PROPFIND result).
   *  - **auth-failure (Req 3.3):** the request hits a `401`, which
   *    {@link request} surfaces as an {@link AuthError}.
   *  - **timeout (Req 3.5):** the Transport rejects with a timeout error
   *    (detected via {@link isTimeoutError}); the no-response case.
   *  - **connectivity-failure (Req 3.4):** any other Transport-level rejection
   *    (unreachable host, TLS error) or any other non-success status from a
   *    reachable server.
   *
   * Exactly one of these kinds is returned for any given call (Req 3.6).
   */
  async testConnection(): Promise<ConnectionTestResult> {
    // Req 3.7: gate on missing required fields before any network I/O.
    const endpoint = this.settings.endpoint?.trim() ?? "";
    const username = this.settings.username?.trim() ?? "";
    const password = this.settings.password?.trim() ?? "";
    if (endpoint === "" || username === "" || password === "") {
      const missing: string[] = [];
      if (endpoint === "") missing.push("server address");
      if (username === "") missing.push("username");
      if (password === "") missing.push("password");
      return {
        kind: "missing-settings",
        message: `Cannot test connection: missing required ${
          missing.length === 1 ? "field" : "fields"
        } (${missing.join(", ")}).`,
      };
    }

    try {
      // A Depth:1 PROPFIND on the base path mirrors how the rest of the client
      // talks to Synology (Req 4.2); a reachable, authenticating server answers
      // with a 207 multistatus (or another 2xx).
      const response = await this.request("PROPFIND", "", {
        body: buildPropfindBody(),
        headers: { Depth: "1", "Content-Type": "application/xml" },
      });

      if (
        (response.status >= 200 && response.status <= 299) ||
        response.status === 207
      ) {
        return {
          kind: "success",
          message: "Connection succeeded.",
        };
      }

      // Reachable server, but the response was not an expected success. There
      // is no dedicated result kind for an unexpected status, so it is reported
      // as a connectivity failure that names the status (Req 3.4, 3.6).
      return {
        kind: "connectivity-failure",
        message: `Connection failed: server responded with status ${response.status}.`,
      };
    } catch (error) {
      // 401 -> authentication failure (Req 3.3).
      if (error instanceof AuthError) {
        return {
          kind: "auth-failure",
          message: "Connection failed: authentication was rejected.",
        };
      }
      // No response within the timeout window (Req 3.5).
      if (isTimeoutError(error)) {
        return {
          kind: "timeout",
          message: `Connection timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
        };
      }
      // Any other transport-level failure: unreachable host, TLS error, or a
      // client error such as the redirect limit (Req 3.4).
      const detail = error instanceof Error ? error.message : String(error);
      return {
        kind: "connectivity-failure",
        message: `Connection failed: the server could not be reached (${detail}).`,
      };
    }
  }

  // -- Internals ------------------------------------------------------------

  /**
   * Execute a single logical request: attach Basic auth and any extra headers,
   * send via the Transport with the 30 s timeout, follow redirects up to the
   * limit, and map `401` to {@link AuthError}.
   */
  private async request(
    method: string,
    remotePath: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    let url = joinUrl(this.settings.endpoint, remotePath);
    const headers: Record<string, string> = {
      Authorization: basicAuthHeader(
        this.settings.username,
        this.settings.password,
      ),
      ...(options.headers ?? {}),
    };

    let redirects = 0;
    // Loop following redirects; bounded by MAX_REDIRECTS (Req 4.3, 4.4).
    for (;;) {
      const request: HttpRequest = {
        url,
        method,
        headers,
        body: options.body,
      };
      const response = await this.transport.send(request, REQUEST_TIMEOUT_MS);

      // 401 stops the operation immediately (Req 4.9).
      if (response.status === 401) {
        throw new AuthError();
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        redirects += 1;
        if (redirects > MAX_REDIRECTS) {
          throw new RedirectLimitError();
        }
        const location = headerValue(response.headers, "Location");
        if (location === undefined || location === "") {
          // A redirect with no target cannot be followed; treat as an error.
          throw new WebDAVError(
            "server-error",
            `Redirect response from ${url} had no Location header.`,
            response.status,
          );
        }
        // Resolve the (possibly relative) Location against the current URL.
        url = new URL(location, url).toString();
        continue;
      }

      return response;
    }
  }

  /** Throw a {@link WebDAVError} when a final response is not a 2xx success. */
  private assertOk(
    response: HttpResponse,
    method: string,
    remotePath: string,
  ): void {
    if (response.status >= 200 && response.status <= 299) {
      return;
    }
    throw new WebDAVError(
      "server-error",
      `${method} ${remotePath} failed with status ${response.status}.`,
      response.status,
    );
  }

  /**
   * Convert a server href (absolute URL or absolute path) returned by the
   * parser into a path relative to the configured endpoint, so it can be fed
   * back into {@link joinUrl} for recursive listing.
   */
  private hrefToRelativePath(href: string): string {
    let pathname = href;
    try {
      pathname = new URL(href, this.settings.endpoint).pathname;
    } catch {
      // Not a parseable URL; fall back to the raw href.
    }
    const base = new URL(this.settings.endpoint).pathname.replace(/\/+$/, "");
    if (base !== "" && pathname.startsWith(base)) {
      pathname = pathname.slice(base.length);
    }
    return pathname;
  }
}

/** Normalize a directory path to a comparison key (no surrounding slashes). */
function normalizeDirKey(path: string): string {
  return segmentsOf(path).join("/");
}
