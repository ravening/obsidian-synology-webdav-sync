/**
 * WebDAV multistatus Response Parser (pure).
 *
 * Converts a WebDAV `207 Multistatus` XML document into a {@link RemoteFileListing}
 * and provides the inverse {@link render} helper that emits an equivalent
 * well-formed multistatus document. Together they satisfy the round-trip
 * property (design Property 2) and the filtering/malformed-input rules
 * (design Property 3).
 *
 * Parsing rules (Req 5.1, 5.2, 5.4, 5.5, 5.6):
 *  - Include only `<response>` entries whose per-resource `<status>` indicates
 *    success (HTTP 2xx) AND that carry a path (href), a last-modified time
 *    (`getlastmodified`), and a size (`getcontentlength`).
 *  - Represent last-modified as a UTC epoch-millisecond timestamp and size as
 *    an integer in the range [0, 2^63-1].
 *  - Exclude any entry missing a required field or whose status indicates
 *    failure. A well-formed document with zero successful entries yields an
 *    empty listing.
 *  - Input that is not well-formed XML yields `{ ok: false, error: "malformed-xml" }`.
 *
 * XML parsing uses the platform `DOMParser`, which is available on both desktop
 * and mobile (and in the jsdom test environment).
 */

import type { FileMeta, RemoteFileListing } from "./types";

/**
 * The discriminated result of {@link parseMultistatus}.
 *
 * `ok: true` carries the parsed listing; `ok: false` signals that the input
 * could not be parsed as well-formed XML.
 */
export type ParseResult =
  | { ok: true; listing: RemoteFileListing }
  | { ok: false; error: "malformed-xml" };

/** Largest size representable per the spec: 2^63 - 1. */
const MAX_SIZE = 9223372036854775807; // stored as a float; see notes in parseSize.

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a WebDAV `207 Multistatus` XML document into a {@link RemoteFileListing}.
 *
 * @param xml the raw response body.
 * @returns `{ ok: true, listing }` on success, or
 *          `{ ok: false, error: "malformed-xml" }` when `xml` is not
 *          well-formed XML.
 */
export function parseMultistatus(xml: string): ParseResult {
  const doc = parseXml(xml);
  if (doc === null) {
    return { ok: false, error: "malformed-xml" };
  }

  const root = doc.documentElement;
  // A well-formed but non-multistatus document contains no response entries;
  // it yields an empty listing rather than an error.
  if (root === null) {
    return { ok: true, listing: { entries: [] } };
  }

  const entries: FileMeta[] = [];
  const responses = descendantsByLocalName(root, "response");
  for (const response of responses) {
    const entry = parseResponse(response);
    if (entry !== null) {
      entries.push(entry);
    }
  }

  return { ok: true, listing: { entries } };
}

/**
 * Extract a single {@link FileMeta} from a `<response>` element, or `null` if
 * the entry is incomplete or its status indicates failure.
 */
function parseResponse(response: Element): FileMeta | null {
  // Path comes from the resource href.
  const href = firstChildByLocalName(response, "href");
  const path = href === null ? "" : decodeHref(textOf(href));
  if (path === "") {
    return null;
  }

  // A response-level <status> (a direct child, not inside a propstat) that
  // indicates failure excludes the whole entry.
  const responseStatus = firstChildByLocalName(response, "status");
  if (responseStatus !== null && !isSuccessStatus(textOf(responseStatus))) {
    return null;
  }

  // Collect properties only from propstat blocks whose status is 2xx.
  let lastModified: number | null = null;
  let size: number | null = null;

  const propstats = childrenByLocalName(response, "propstat");
  for (const propstat of propstats) {
    const status = firstChildByLocalName(propstat, "status");
    if (status === null || !isSuccessStatus(textOf(status))) {
      continue;
    }
    const prop = firstChildByLocalName(propstat, "prop");
    if (prop === null) {
      continue;
    }
    if (lastModified === null) {
      const lm = firstChildByLocalName(prop, "getlastmodified");
      if (lm !== null) {
        lastModified = parseLastModified(textOf(lm));
      }
    }
    if (size === null) {
      const cl = firstChildByLocalName(prop, "getcontentlength");
      if (cl !== null) {
        size = parseSize(textOf(cl));
      }
    }
  }

  if (lastModified === null || size === null) {
    return null;
  }

  return { path, modifiedUtc: lastModified, size };
}

/**
 * Convert a WebDAV `getlastmodified` value (an HTTP-date) into UTC epoch ms.
 * Returns `null` when the value is empty or unparseable.
 */
function parseLastModified(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Convert a WebDAV `getcontentlength` value into a non-negative integer in
 * `[0, 2^63-1]`. Returns `null` for empty, non-numeric, negative, fractional,
 * or out-of-range values.
 */
function parseSize(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > MAX_SIZE) {
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Rendering (inverse of parseMultistatus, used by the round-trip property)
// ---------------------------------------------------------------------------

/**
 * Render a {@link RemoteFileListing} as a well-formed WebDAV `207 Multistatus`
 * document such that `parseMultistatus(render(listing)).listing` equals
 * `listing`.
 *
 * Each entry becomes a `<response>` carrying its href, a `200 OK` propstat with
 * `getlastmodified` (as an HTTP-date) and `getcontentlength`. Last-modified
 * values are emitted at second precision (the resolution of the WebDAV
 * HTTP-date format); callers relying on the round-trip property should supply
 * second-aligned timestamps.
 */
export function render(listing: RemoteFileListing): string {
  const body = listing.entries.map(renderEntry).join("\n");
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<d:multistatus xmlns:d="DAV:">\n' +
    body +
    (body === "" ? "" : "\n") +
    "</d:multistatus>\n"
  );
}

function renderEntry(entry: FileMeta): string {
  const href = encodeHref(entry.path);
  const lastModified = new Date(entry.modifiedUtc).toUTCString();
  const size = formatSize(entry.size);
  return (
    "  <d:response>\n" +
    "    <d:href>" +
    href +
    "</d:href>\n" +
    "    <d:propstat>\n" +
    "      <d:prop>\n" +
    "        <d:getlastmodified>" +
    lastModified +
    "</d:getlastmodified>\n" +
    "        <d:getcontentlength>" +
    size +
    "</d:getcontentlength>\n" +
    "      </d:prop>\n" +
    "      <d:status>HTTP/1.1 200 OK</d:status>\n" +
    "    </d:propstat>\n" +
    "  </d:response>"
  );
}

/**
 * Format a size as a plain decimal integer string. For the supported range
 * (`< 1e21`) JavaScript never uses exponential notation, so `String` is exact
 * relative to the float value.
 */
function formatSize(size: number): string {
  return String(size);
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/**
 * Parse `xml` with the platform `DOMParser`. Returns the parsed `Document`, or
 * `null` when the input is not well-formed XML (the parser emits a
 * `<parsererror>` element rather than throwing).
 */
function parseXml(xml: string): Document | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return null;
  }
  if (hasParserError(doc)) {
    return null;
  }
  return doc;
}

/** Detect the `<parsererror>` element browsers/jsdom inject on a parse failure. */
function hasParserError(doc: Document): boolean {
  const root = doc.documentElement;
  if (root === null) {
    return true;
  }
  if (localName(root) === "parsererror") {
    return true;
  }
  // A parsererror may also be nested within an otherwise present root.
  const nested = root.getElementsByTagName("*");
  for (let i = 0; i < nested.length; i++) {
    if (localName(nested[i]) === "parsererror") {
      return true;
    }
  }
  return false;
}

/** The namespace-agnostic local name of an element, lower-cased for matching. */
function localName(el: Element): string {
  return (el.localName ?? el.nodeName).toLowerCase();
}

/** All descendant elements with the given local name (namespace-agnostic). */
function descendantsByLocalName(root: Element, name: string): Element[] {
  const target = name.toLowerCase();
  const result: Element[] = [];
  if (localName(root) === target) {
    result.push(root);
  }
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (localName(all[i]) === target) {
      result.push(all[i]);
    }
  }
  return result;
}

/** Direct child elements with the given local name (namespace-agnostic). */
function childrenByLocalName(parent: Element, name: string): Element[] {
  const target = name.toLowerCase();
  const result: Element[] = [];
  const children = parent.children;
  for (let i = 0; i < children.length; i++) {
    if (localName(children[i]) === target) {
      result.push(children[i]);
    }
  }
  return result;
}

/** First direct child element with the given local name, or `null`. */
function firstChildByLocalName(parent: Element, name: string): Element | null {
  const matches = childrenByLocalName(parent, name);
  return matches.length > 0 ? matches[0] : null;
}

/** The trimmed text content of an element. */
function textOf(el: Element): string {
  return (el.textContent ?? "").trim();
}

/** Whether an HTTP status line (e.g. "HTTP/1.1 200 OK") indicates 2xx success. */
function isSuccessStatus(statusLine: string): boolean {
  const match = /\b([1-5]\d{2})\b/.exec(statusLine);
  if (match === null) {
    return false;
  }
  const code = Number(match[1]);
  return code >= 200 && code <= 299;
}

/**
 * Encode a vault-relative path for use in an `<d:href>`. The whole path is
 * percent-encoded (including separators) so that any character round-trips
 * exactly through {@link decodeHref}.
 */
function encodeHref(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Decode an `<d:href>` value back into a path. Falls back to the raw text if
 * the value is not valid percent-encoding (e.g. a real server href containing
 * a stray `%`).
 */
function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}
