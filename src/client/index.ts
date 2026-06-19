/**
 * WebDAV client layer.
 *
 * A stateful adapter over the Transport that isolates Synology-specific
 * behavior: Basic auth headers, `Depth: 1` PROPFIND, bounded redirect
 * following (<=5), URL joining against the configured endpoint, the 30-second
 * timeout, and 401 -> auth-failure mapping. Exposes listing, get/put/delete/
 * move, MKCOL, and connection-test operations.
 */
export {
  WebDAVClient,
  WebDAVError,
  AuthError,
  RedirectLimitError,
  basicAuthHeader,
  base64Encode,
  REQUEST_TIMEOUT_MS,
  MAX_REDIRECTS,
  type WebDAVErrorKind,
} from "./webdavClient";
