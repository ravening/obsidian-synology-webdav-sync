/**
 * WebDAV folder-listing parser (pure).
 *
 * Extracts the immediate *child collections* (directories) of a browsed folder
 * from a WebDAV `207 Multistatus` document, the opposite slice of
 * {@link parseMultistatus} (which keeps only file entries). It provides the
 * display ordering {@link sortFolders} and the inverse {@link renderFolderListing}
 * helper that emits an equivalent well-formed multistatus document, so the two
 * satisfy the round-trip property (design Property 5).
 *
 * Parsing rules (Req 1.6, 2.1, 2.2):
 *  - Keep only collection entries: a `<response>` is a collection when its
 *    successful `propstat` carries `<resourcetype><collection/></resourcetype>`
 *    OR its `<href>` ends with a trailing `"/"` (the Synology fallback signal,
 *    mirroring how `WebDAVClient.listTree` decides whether to descend).
 *  - Drop the directory's own self-entry: a `Depth: 1` PROPFIND returns the
 *    requested directory itself, whose normalized path equals `requestPath`.
 *  - Each surviving child yields its display name (the last path segment) and
 *    its normalized, server-relative folder path.
 *  - Input that is not well-formed XML yields `{ ok: false, error: "malformed-xml" }`.
 *
 * XML parsing uses the platform `DOMParser`, available on both desktop and
 * mobile (and in the jsdom test environment), with the same namespace-agnostic
 * local-name traversal already proven in {@link responseParser}.
 */

import type { RemoteFolder, RemoteFolderListing } from "./types";

/**
 * The discriminated result of {@link parseFolderListing}.
 *
 * `ok: true` carries the parsed folder listing; `ok: false` signals that the
 * input could not be parsed as well-formed XML.
 */
export type FolderListingParseResult =
  | { ok: true; listing: RemoteFolderListing }
  | { ok: false; error: "malformed-xml" };

// ---------------------------------------------------------------------------
// Path normalization (local, mirrors core path rules Req 5.2)
// ---------------------------------------------------------------------------

/**
 * Normalize a server-relative Folder_Path: convert `"\\"` to `"/"`, collapse
 * repeated `"/"` into one, and strip leading/trailing `"/"`. The root (and any
 * all-slash input) normalizes to the empty string.
 *
 * Kept local so this module is self-contained and does not couple to the
 * parallel `vaultPath` module; it follows the same rules as the canonical
 * `normalizeFolderPath`.
 */
function normalize(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** The display name of a normalized folder path (its last segment). */
function lastSegment(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a WebDAV `207 Multistatus` document into the immediate child folders of
 * `requestPath`.
 *
 * @param xml the raw response body.
 * @param requestPath the path that was listed (its self-entry is excluded).
 * @returns `{ ok: true, listing }` on success, or
 *          `{ ok: false, error: "malformed-xml" }` when `xml` is not
 *          well-formed XML.
 */
export function parseFolderListing(
  xml: string,
  requestPath: string,
): FolderListingParseResult {
  const doc = parseXml(xml);
  if (doc === null) {
    return { ok: false, error: "malformed-xml" };
  }

  const selfPath = normalize(requestPath);
  const root = doc.documentElement;
  // A well-formed but non-multistatus document contains no response entries;
  // it yields an empty listing rather than an error.
  if (root === null) {
    return { ok: true, listing: { path: selfPath, folders: [] } };
  }

  const folders: RemoteFolder[] = [];
  const responses = descendantsByLocalName(root, "response");
  for (const response of responses) {
    const folder = parseResponse(response, selfPath);
    if (folder !== null) {
      folders.push(folder);
    }
  }

  return { ok: true, listing: { path: selfPath, folders } };
}

/**
 * Extract a single child {@link RemoteFolder} from a `<response>` element, or
 * `null` when the entry is not a collection, carries no path, or is the
 * directory's own self-entry.
 */
function parseResponse(response: Element, selfPath: string): RemoteFolder | null {
  const hrefEl = firstChildByLocalName(response, "href");
  if (hrefEl === null) {
    return null;
  }
  const rawHref = textOf(hrefEl);
  if (rawHref === "") {
    return null;
  }

  // A trailing slash on the raw href is the fallback collection signal.
  const trailingSlash = rawHref.endsWith("/");

  const path = normalize(decodeHref(rawHref));
  if (path === "") {
    // The server endpoint root carries no name and is never a child.
    return null;
  }

  const collection = trailingSlash || hasCollectionResourcetype(response);
  if (!collection) {
    return null;
  }

  // Drop the directory's own self-entry so it does not list itself as a child.
  if (path === selfPath) {
    return null;
  }

  return { name: lastSegment(path), path };
}

/**
 * Whether a `<response>` declares a `<collection/>` resourcetype within a
 * successful (`2xx`) propstat block.
 */
function hasCollectionResourcetype(response: Element): boolean {
  const propstats = childrenByLocalName(response, "propstat");
  for (const propstat of propstats) {
    const status = firstChildByLocalName(propstat, "status");
    if (status !== null && !isSuccessStatus(textOf(status))) {
      continue;
    }
    const prop = firstChildByLocalName(propstat, "prop");
    if (prop === null) {
      continue;
    }
    const resourcetype = firstChildByLocalName(prop, "resourcetype");
    if (resourcetype === null) {
      continue;
    }
    if (firstChildByLocalName(resourcetype, "collection") !== null) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sorting (display ordering)
// ---------------------------------------------------------------------------

/**
 * Sort folders ascending, case-insensitive, by name (Req 2.2). Pure and stable:
 * the input is not mutated and equal-keyed entries preserve their input order.
 */
export function sortFolders(folders: RemoteFolder[]): RemoteFolder[] {
  return folders
    .map((folder, index) => ({ folder, index }))
    .sort((a, b) => {
      const an = a.folder.name.toLowerCase();
      const bn = b.folder.name.toLowerCase();
      if (an < bn) {
        return -1;
      }
      if (an > bn) {
        return 1;
      }
      // Stable: fall back to the original index for equal keys.
      return a.index - b.index;
    })
    .map((entry) => entry.folder);
}

// ---------------------------------------------------------------------------
// Rendering (inverse of parseFolderListing, used by the round-trip property)
// ---------------------------------------------------------------------------

/**
 * Render a {@link RemoteFolderListing} as a well-formed WebDAV `207 Multistatus`
 * document such that `parseFolderListing(renderFolderListing(listing), listing.path)`
 * recovers a listing whose `folders` preserve each child's name and path.
 *
 * The document includes the directory's own self-entry (so the parser exercises
 * self-entry exclusion) and emits a `<collection/>` resourcetype on the
 * self-entry and on every child, mirroring {@link responseParser.render}.
 */
export function renderFolderListing(listing: RemoteFolderListing): string {
  const self = renderEntry(listing.path);
  const children = listing.folders.map((folder) => renderEntry(folder.path));
  const body = [self, ...children].join("\n");
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<d:multistatus xmlns:d="DAV:">\n' +
    body +
    "\n" +
    "</d:multistatus>\n"
  );
}

function renderEntry(path: string): string {
  const href = encodeHref(path);
  return (
    "  <d:response>\n" +
    "    <d:href>" +
    href +
    "</d:href>\n" +
    "    <d:propstat>\n" +
    "      <d:prop>\n" +
    "        <d:resourcetype><d:collection/></d:resourcetype>\n" +
    "      </d:prop>\n" +
    "      <d:status>HTTP/1.1 200 OK</d:status>\n" +
    "    </d:propstat>\n" +
    "  </d:response>"
  );
}

// ---------------------------------------------------------------------------
// XML helpers (mirrors responseParser's namespace-agnostic traversal)
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
 * Encode a server-relative folder path for use in an `<d:href>`. The whole path
 * is percent-encoded (including separators) so any character round-trips exactly
 * through {@link decodeHref}, mirroring {@link responseParser}.
 */
function encodeHref(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Decode an `<d:href>` value back into a path. Falls back to the raw text if the
 * value is not valid percent-encoding (e.g. a real server href containing a
 * stray `%`).
 */
function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}
