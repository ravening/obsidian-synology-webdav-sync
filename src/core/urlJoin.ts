/**
 * URL-join helper (pure).
 *
 * Joins a configured WebDAV endpoint URL with a vault-relative path so that the
 * resulting request URL resolves correctly against the server regardless of
 * whether the endpoint carries a trailing slash (Req 4.5, design Property 4).
 *
 * Behavior guaranteed by this helper:
 *  - The endpoint's scheme and host (its origin) are preserved unchanged.
 *  - Exactly one `/` separator is placed between the endpoint base path and the
 *    resolved vault path — never a missing separator and never a doubled one.
 *  - Each segment of the vault-relative path is percent-encoded individually,
 *    so reserved characters (spaces, `#`, `?`, non-ASCII, ...) are escaped while
 *    the `/` separators between segments are kept literal.
 *
 * This module is pure and performs no I/O.
 */

/**
 * Join a configured endpoint URL with a vault-relative path.
 *
 * @param endpoint - The configured WebDAV server endpoint (e.g.
 *   `https://nas.example:5006/dav` or `https://nas.example:5006/dav/`). Must be
 *   an absolute http(s) URL.
 * @param vaultRelativePath - A vault-relative path using forward slashes (e.g.
 *   `notes/My File.md`). Leading and trailing slashes are tolerated.
 * @returns The fully-resolved, per-segment-encoded request URL.
 */
export function joinUrl(endpoint: string, vaultRelativePath: string): string {
  const url = new URL(endpoint);

  // Origin preserves scheme + host (+ port). Strip any trailing slash(es) from
  // the endpoint's base path so we can reattach exactly one separator below.
  const origin = url.origin;
  const basePath = url.pathname.replace(/\/+$/, "");

  // Encode each non-empty segment of the vault-relative path individually,
  // keeping the `/` separators literal. Empty segments (from leading, trailing,
  // or doubled slashes in the input) are dropped so they cannot introduce
  // doubled separators in the output.
  const encodedPath = vaultRelativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${origin}${basePath}/${encodedPath}`;
}
