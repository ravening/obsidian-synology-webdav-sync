/**
 * WebDAV Request Builder (pure).
 *
 * Produces well-formed WebDAV request bodies. The only consumer-facing output
 * today is the PROPFIND body used to enumerate a directory's resources. The
 * builder is deterministic and performs no I/O, so it can be exercised with
 * fast unit and property tests.
 *
 * _Requirements: 5.3_
 */

/**
 * Build a well-formed PROPFIND request body.
 *
 * The returned XML requests exactly the properties the response parser needs
 * to construct a `RemoteFileListing` entry:
 *
 * - the resource path/href (carried by each `<D:response>`'s `<D:href>`),
 *   requested here via the standard `<D:displayname>` property so servers that
 *   omit optional properties still return the resource identity;
 * - `<D:getlastmodified>` — the last-modified time; and
 * - `<D:getcontentlength>` — the size in bytes.
 *
 * The body is a complete XML document with an explicit declaration so it is
 * well-formed for any conforming WebDAV server (including Synology's).
 *
 * @returns A well-formed PROPFIND XML request body.
 */
export function buildPropfindBody(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:propfind xmlns:D="DAV:">',
    "  <D:prop>",
    "    <D:displayname/>",
    "    <D:getlastmodified/>",
    "    <D:getcontentlength/>",
    "  </D:prop>",
    "</D:propfind>",
  ].join("\n");
}
