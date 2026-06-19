import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { parseMultistatus } from "./responseParser";
import type { FileMeta } from "./types";

/**
 * Property-based test for design Property 3 (parser filtering and malformed
 * input). Validates Requirements 5.4, 5.5, 5.6.
 *
 * Feature: obsidian-synology-webdav-sync, Property 3: For any generated
 * multistatus document (including documents with entries that have a non-2xx
 * per-resource status, entries missing path/last-modified/size, documents with
 * zero successful entries, and non-XML byte sequences), the parser SHALL
 * include exactly those <response> entries whose per-resource status is success
 * and that carry all three required fields; SHALL produce an empty listing when
 * no entry qualifies; and SHALL return malformed-xml with no listing when the
 * input is not well-formed XML.
 */

// ---------------------------------------------------------------------------
// Generators for the building blocks of a multistatus <response>.
// ---------------------------------------------------------------------------

/**
 * A non-empty vault-relative path. It is percent-encoded into the rendered
 * <href>, and the parser decodes it back, so any string round-trips exactly.
 */
const pathArb = fc.string({ minLength: 1, maxLength: 40 });

/**
 * Second-aligned UTC epoch-ms timestamp. The WebDAV HTTP-date format the parser
 * reads has second precision, so second-aligned values survive the
 * render-then-parse trip exactly.
 */
const msArb = fc
  .integer({ min: 0, max: 4_102_444_800 }) // 1970 .. ~2100, in seconds
  .map((seconds) => seconds * 1000);

/** A size that is a non-negative integer within the spec's [0, 2^63-1] range. */
const sizeArb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

/** A non-2xx HTTP status code used to mark an entry as a failure. */
const failCodeArb = fc.constantFrom(301, 400, 401, 403, 404, 409, 423, 500, 502, 503);

// ---------------------------------------------------------------------------
// Entry specs: a typed description of each <response> we render. Each spec is
// either kept by the parser (success + all fields) or dropped for a specific
// reason. expectedOf() computes the FileMeta the parser must emit, or null.
// ---------------------------------------------------------------------------

type EntrySpec =
  | { t: "keep"; path: string; ms: number; size: number }
  | { t: "drop-response-status"; path: string; ms: number; size: number; code: number }
  | { t: "drop-propstat-status"; path: string; ms: number; size: number; code: number }
  | { t: "drop-missing-lm"; path: string; size: number }
  | { t: "drop-missing-size"; path: string; ms: number }
  | { t: "drop-missing-path"; ms: number; size: number };

const entryArb: fc.Arbitrary<EntrySpec> = fc.oneof(
  fc.record({ t: fc.constant("keep" as const), path: pathArb, ms: msArb, size: sizeArb }),
  fc.record({
    t: fc.constant("drop-response-status" as const),
    path: pathArb,
    ms: msArb,
    size: sizeArb,
    code: failCodeArb,
  }),
  fc.record({
    t: fc.constant("drop-propstat-status" as const),
    path: pathArb,
    ms: msArb,
    size: sizeArb,
    code: failCodeArb,
  }),
  fc.record({ t: fc.constant("drop-missing-lm" as const), path: pathArb, size: sizeArb }),
  fc.record({ t: fc.constant("drop-missing-size" as const), path: pathArb, ms: msArb }),
  fc.record({ t: fc.constant("drop-missing-path" as const), ms: msArb, size: sizeArb }),
);

/** The FileMeta the parser must emit for a spec, or null when it must be dropped. */
function expectedOf(spec: EntrySpec): FileMeta | null {
  return spec.t === "keep"
    ? { path: spec.path, modifiedUtc: spec.ms, size: spec.size }
    : null;
}

// ---------------------------------------------------------------------------
// Rendering helpers. We render XML independently of the parser's own render()
// so we can also emit failure-status and missing-field entries it must reject.
// A per-document namespace prefix exercises the parser's prefix-agnostic
// (local-name) matching.
// ---------------------------------------------------------------------------

const prefixArb = fc.constantFrom("d", "D", "ns0", "webdav");

function el(prefix: string, name: string, text: string): string {
  return `<${prefix}:${name}>${text}</${prefix}:${name}>`;
}

function statusLine(code: number): string {
  return `HTTP/1.1 ${code} X`;
}

function httpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

function encodedHref(prefix: string, path: string): string {
  return el(prefix, "href", encodeURIComponent(path));
}

function successPropstat(prefix: string, props: string): string {
  return (
    `<${prefix}:propstat>` +
    `<${prefix}:prop>${props}</${prefix}:prop>` +
    el(prefix, "status", statusLine(200)) +
    `</${prefix}:propstat>`
  );
}

function renderEntry(spec: EntrySpec, p: string): string {
  switch (spec.t) {
    case "keep":
      return (
        encodedHref(p, spec.path) +
        successPropstat(
          p,
          el(p, "getlastmodified", httpDate(spec.ms)) +
            el(p, "getcontentlength", String(spec.size)),
        )
      );
    case "drop-response-status":
      // A response-level <status> indicating failure excludes the whole entry,
      // even though all fields are present in a 200 propstat.
      return (
        encodedHref(p, spec.path) +
        el(p, "status", statusLine(spec.code)) +
        successPropstat(
          p,
          el(p, "getlastmodified", httpDate(spec.ms)) +
            el(p, "getcontentlength", String(spec.size)),
        )
      );
    case "drop-propstat-status":
      // The propstat carrying the fields has a non-2xx status, so the fields
      // are not collected and the entry is incomplete -> dropped.
      return (
        encodedHref(p, spec.path) +
        `<${p}:propstat>` +
        `<${p}:prop>` +
        el(p, "getlastmodified", httpDate(spec.ms)) +
        el(p, "getcontentlength", String(spec.size)) +
        `</${p}:prop>` +
        el(p, "status", statusLine(spec.code)) +
        `</${p}:propstat>`
      );
    case "drop-missing-lm":
      return (
        encodedHref(p, spec.path) +
        successPropstat(p, el(p, "getcontentlength", String(spec.size)))
      );
    case "drop-missing-size":
      return (
        encodedHref(p, spec.path) +
        successPropstat(p, el(p, "getlastmodified", httpDate(spec.ms)))
      );
    case "drop-missing-path":
      // No <href> -> empty path -> dropped.
      return successPropstat(
        p,
        el(p, "getlastmodified", httpDate(spec.ms)) +
          el(p, "getcontentlength", String(spec.size)),
      );
  }
}

function renderDoc(specs: readonly EntrySpec[], p: string): string {
  const responses = specs
    .map((spec) => `<${p}:response>${renderEntry(spec, p)}</${p}:response>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<${p}:multistatus xmlns:${p}="DAV:">${responses}</${p}:multistatus>`
  );
}

// ---------------------------------------------------------------------------
// Malformed (not well-formed XML) generators. Each form is reliably malformed.
// ---------------------------------------------------------------------------

const tagNameArb = fc
  .array(fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h"), {
    minLength: 1,
    maxLength: 6,
  })
  .map((chars) => chars.join(""));

const alnumArb = fc.stringOf(
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
  { maxLength: 12 },
);

const malformedArb = fc.oneof(
  // Unclosed root element.
  fc.tuple(tagNameArb, alnumArb).map(([n, text]) => `<${n}>${text}`),
  // Mismatched open/close tags.
  fc.tuple(tagNameArb, alnumArb).map(([n, text]) => `<${n}>${text}</${n}x>`),
  // Unescaped raw ampersand in element text.
  fc.tuple(tagNameArb, alnumArb).map(([n, text]) => `<${n}>${text}&${text}</${n}>`),
  // Two root elements (junk after the document element).
  fc.tuple(tagNameArb, tagNameArb).map(([a, b]) => `<${a}/><${b}/>`),
  // Arbitrary bytes followed by an unterminated tag: always non-well-formed.
  fc.string().map((s) => `${s}<unclosed`),
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("parseMultistatus filtering and malformed input (Property 3)", () => {
  // Feature: obsidian-synology-webdav-sync, Property 3: For any generated
  // multistatus document (including documents with entries that have a non-2xx
  // per-resource status, entries missing path/last-modified/size, documents
  // with zero successful entries, and non-XML byte sequences), the parser SHALL
  // include exactly those <response> entries whose per-resource status is
  // success and that carry all three required fields; SHALL produce an empty
  // listing when no entry qualifies; and SHALL return malformed-xml with no
  // listing when the input is not well-formed XML.
  it("keeps exactly the successful, complete entries (empty when none qualify)", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 12 }), prefixArb, (specs, p) => {
        const xml = renderDoc(specs, p);
        const result = parseMultistatus(xml);

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }

        const expected = specs
          .map(expectedOf)
          .filter((meta): meta is FileMeta => meta !== null);

        expect(result.listing.entries).toEqual(expected);
      }),
    );
  });

  it("returns { ok: false, error: 'malformed-xml' } for input that is not well-formed XML", () => {
    fc.assert(
      fc.property(malformedArb, (xml) => {
        const result = parseMultistatus(xml);
        expect(result).toEqual({ ok: false, error: "malformed-xml" });
      }),
    );
  });
});
