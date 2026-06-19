import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { parseMultistatus, render } from "./responseParser";
import type { FileMeta, RemoteFileListing } from "./types";

/**
 * Feature: obsidian-synology-webdav-sync, Property 2: For any RemoteFileListing,
 * rendering it as an equivalent well-formed WebDAV 207 Multistatus response and
 * parsing that response yields a listing whose entries preserve each original
 * entry's path, last-modified time (as a UTC epoch-ms timestamp), and size (as
 * an integer in [0, 2^63-1]). Equivalently, parseMultistatus(render(listing)).listing
 * equals listing.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.7
 *
 * Generator alignment with what render/parse actually support:
 *  - last-modified is emitted as an HTTP-date (second precision), so timestamps
 *    are generated second-aligned (multiples of 1000 ms) within a representable
 *    Date range so Date.parse(toUTCString(t)) === t exactly.
 *  - sizes are non-negative integers within the safe/representable range so
 *    String(size) round-trips through the parser's integer validation.
 *  - paths are non-empty unicode strings (no lone surrogates) that round-trip
 *    through encodeURIComponent/decodeURIComponent; render encodes the whole
 *    href. The parser excludes empty paths, so paths are constrained to be
 *    non-empty, and paths are kept unique within a listing so the
 *    order-preserving array equality is unambiguous.
 */

// Second-aligned UTC timestamp within a clearly representable range
// (1970-01-01 .. 9999-12-31). Date#toUTCString preserves second precision,
// and Date.parse recovers the exact second-aligned epoch ms.
const secondAlignedMs: fc.Arbitrary<number> = fc
  .date({
    min: new Date("1970-01-01T00:00:00.000Z"),
    max: new Date("9999-12-31T23:59:59.000Z"),
  })
  .map((d) => Math.floor(d.getTime() / 1000) * 1000);

// Non-negative integer size that String() renders exactly (no exponent) and
// that survives the parser's integer/range validation. maxSafeNat keeps every
// value exactly representable as a JS number.
const size: fc.Arbitrary<number> = fc.maxSafeNat();

// Non-empty unicode path. fullUnicodeString avoids lone surrogates so
// encodeURIComponent never throws, and every code point round-trips through
// encode/decode. encodeURIComponent percent-encodes all whitespace, so the
// parser's text trimming never alters the decoded path.
const path: fc.Arbitrary<string> = fc.fullUnicodeString({ minLength: 1 });

const fileMeta: fc.Arbitrary<FileMeta> = fc.record({
  path,
  modifiedUtc: secondAlignedMs,
  size,
});

// Unique paths within a listing keeps the round-trip equality unambiguous.
const remoteFileListing: fc.Arbitrary<RemoteFileListing> = fc
  .uniqueArray(fileMeta, { selector: (e) => e.path })
  .map((entries) => ({ entries }));

describe("responseParser round-trip (Property 2)", () => {
  it("parseMultistatus(render(listing)).listing equals listing", () => {
    fc.assert(
      fc.property(remoteFileListing, (listing) => {
        const result = parseMultistatus(render(listing));
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.listing).toEqual(listing);
        }
      }),
    );
  });
});
