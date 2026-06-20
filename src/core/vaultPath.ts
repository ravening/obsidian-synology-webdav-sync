/**
 * Vault-path algebra (pure, I/O-free).
 *
 * The Remote Vault Location is a server-relative `Folder_Path` that the rest of
 * the plugin prepends to every remote operation. This module holds the path
 * math the feature needs — normalization, traversal rejection, and
 * descendant-containment resolution — kept deterministic and free of any
 * network or filesystem I/O so it can be exhaustively property-tested,
 * consistent with `urlJoin`, `validateSettings`, and `decideAction`.
 *
 * Conventions used throughout this module:
 *  - A normalized `Folder_Path` uses forward-slash separators, has no doubled
 *    separators, and has no leading or trailing `/`.
 *  - The server endpoint root is represented by the empty string `""`.
 */

/** Maximum length, in characters, of a stored Folder_Path (Req 5.1, 5.7). */
export const MAX_FOLDER_PATH_LENGTH = 2048;

/**
 * Normalize a Folder_Path (Req 5.2): convert `"\"` to `"/"`, collapse repeated
 * `"/"` into one, and strip any leading or trailing `"/"`. The server endpoint
 * root (e.g. `"/"`, `""`, or `"//"`) normalizes to the empty string `""`.
 *
 * Note: this is purely separator-level normalization. It does NOT resolve or
 * remove `"."`/`".."` segments — traversal handling is the responsibility of
 * {@link validateFolderPath} and {@link resolveVaultPath}, which must be able
 * to detect a `".."` segment rather than silently collapse it.
 *
 * The result never has a leading or trailing slash; the root is `""`. The
 * function is idempotent: `normalizeFolderPath(normalizeFolderPath(p))` always
 * equals `normalizeFolderPath(p)`.
 */
export function normalizeFolderPath(path: string): string {
  return path
    .replace(/\\/g, "/") // backslash separators → forward slashes
    .replace(/\/+/g, "/") // collapse consecutive separators
    .replace(/^\//, "") // strip a leading separator
    .replace(/\/$/, ""); // strip a trailing separator
}

/** The reason a candidate Folder_Path was rejected for persistence. */
export type FolderPathRejection = "too-long" | "traversal";

/**
 * The result of validating a Folder_Path submitted for persistence.
 *
 * On success the result carries the normalized form ready to store. On failure
 * it identifies the {@link FolderPathRejection} reason and a UI-ready message.
 */
export type FolderPathValidationResult =
  | { valid: true; normalized: string }
  | { valid: false; reason: FolderPathRejection; message: string };

/**
 * True when a normalized path contains a parent-directory traversal segment.
 *
 * A traversal segment is a path component equal exactly to `".."`. Because
 * normalization is separator-only, any `".."` written by the caller survives
 * and is detected here rather than being silently resolved away.
 */
function hasTraversalSegment(normalized: string): boolean {
  if (normalized === "") {
    return false;
  }
  return normalized.split("/").some((segment) => segment === "..");
}

/**
 * Validate a Folder_Path submitted for persistence (Req 5.1, 5.7).
 *
 * The path is first normalized; the candidate is rejected when the normalized
 * form exceeds {@link MAX_FOLDER_PATH_LENGTH} characters (`"too-long"`) or
 * contains a `".."` traversal segment (`"traversal"`). On success the
 * normalized path is returned for the caller to store.
 *
 * The function is pure: it reads only the candidate and returns a result. It
 * never mutates any store.
 */
export function validateFolderPath(path: string): FolderPathValidationResult {
  const normalized = normalizeFolderPath(path);

  if (normalized.length > MAX_FOLDER_PATH_LENGTH) {
    return {
      valid: false,
      reason: "too-long",
      message: `Folder path must be at most ${MAX_FOLDER_PATH_LENGTH} characters.`,
    };
  }

  if (hasTraversalSegment(normalized)) {
    return {
      valid: false,
      reason: "traversal",
      message: 'Folder path must not contain a parent-directory ("..") segment.',
    };
  }

  return { valid: true, normalized };
}

/**
 * The result of resolving a request path against the Remote Vault Location.
 *
 * On success it carries the joined, normalized server-relative path. On failure
 * (`"escapes-base"`) the request would resolve outside the base, so the caller
 * must refuse to issue the request (Req 5.8).
 */
export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; reason: "escapes-base" };

/**
 * Resolve a vault-relative request path against the Remote Vault Location base
 * (Req 5.3, 5.5, 5.8).
 *
 * The base is the previously loaded Remote Vault Location; `base === ""` means
 * the server endpoint root (Req 5.5). The request path is rejected outright
 * when it contains a `".."` traversal segment, before any join is attempted, so
 * a traversal can never reach the network. Otherwise the request is joined onto
 * the base, normalized, and confirmed to be a descendant of (or equal to) the
 * base via {@link isDescendant}.
 *
 * @returns `{ ok: true, path }` with the resolved server-relative path when the
 *   result is contained within the base, otherwise `{ ok: false, reason:
 *   "escapes-base" }`.
 */
export function resolveVaultPath(
  base: string,
  requestPath: string,
): ResolveResult {
  const normalizedBase = normalizeFolderPath(base);
  const normalizedRequest = normalizeFolderPath(requestPath);

  // Reject any traversal in the request before joining (Req 5.8). Because the
  // request can never introduce a "..", the join below cannot escape the base.
  if (hasTraversalSegment(normalizedRequest)) {
    return { ok: false, reason: "escapes-base" };
  }

  const joined =
    normalizedBase === ""
      ? normalizedRequest
      : normalizedRequest === ""
        ? normalizedBase
        : normalizeFolderPath(`${normalizedBase}/${normalizedRequest}`);

  // Defensive containment check: the resolved path must stay under the base.
  if (!isDescendant(normalizedBase, joined)) {
    return { ok: false, reason: "escapes-base" };
  }

  return { ok: true, path: joined };
}

/**
 * True when `candidate` is the base itself or a descendant nested under it
 * (Req 5.3). Both arguments are normalized before comparison.
 *
 * The root base (`""`) contains every path. Otherwise `candidate` must either
 * equal the base or begin with `base + "/"` so that a sibling sharing a name
 * prefix (e.g. base `"vault"`, candidate `"vault-2"`) is not treated as a
 * descendant.
 */
export function isDescendant(base: string, candidate: string): boolean {
  const normalizedBase = normalizeFolderPath(base);
  const normalizedCandidate = normalizeFolderPath(candidate);

  if (normalizedBase === "") {
    return true;
  }
  if (normalizedCandidate === normalizedBase) {
    return true;
  }
  return normalizedCandidate.startsWith(`${normalizedBase}/`);
}

/**
 * The parent of a normalized folder path, or `""` when it has no parent
 * (Req 2.5). A single-segment path (e.g. `"Notes"`) and the root (`""`) both
 * have the root `""` as their parent.
 */
export function parentOf(path: string): string {
  const normalized = normalizeFolderPath(path);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return "";
  }
  return normalized.slice(0, lastSlash);
}

/**
 * Append a single child segment to a base path, normalizing the result
 * (Req 2.4, 4.3). When the base is the root (`""`) the result is just the
 * normalized segment; an empty segment leaves the base unchanged.
 */
export function joinSegment(base: string, segment: string): string {
  const normalizedBase = normalizeFolderPath(base);
  const normalizedSegment = normalizeFolderPath(segment);

  if (normalizedBase === "") {
    return normalizedSegment;
  }
  if (normalizedSegment === "") {
    return normalizedBase;
  }
  return normalizeFolderPath(`${normalizedBase}/${normalizedSegment}`);
}
