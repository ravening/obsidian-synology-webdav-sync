import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { conflictCopyName } from "./conflictName";

/**
 * Property-based tests for {@link conflictCopyName} (design Property 7,
 * Req 9.1, 9.2, 9.3).
 *
 * The generators model the full input space the property must hold over:
 *  - original vault paths with and without directory prefixes, with and
 *    without extensions, and dotfiles (leading-dot names like `.gitignore`);
 *  - arbitrary sets of existing vault paths, optionally seeded with the
 *    original path itself and with the first candidate name the function would
 *    produce, so the append-another-identifier collision loop is exercised.
 *
 * To engineer a collision with the first candidate we replicate the function's
 * path-splitting and identifier formatting using a fixed `deviceTag` and `now`
 * passed into the function. The replicated logic is only used to *force* a
 * collision; the assertions below check the actual contract regardless of
 * whether the seeded candidate matches.
 */

// --- Generators -----------------------------------------------------------

// A non-empty filesystem-friendly token (letters/digits, no slash or dot).
const tokenArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => s.replace(/[^a-z0-9]/gi, ""))
  .filter((s) => s.length > 0);

// A file name covering the four shapes: plain, with extension, dotfile, and
// dotfile with extension.
const fileNameArb: fc.Arbitrary<string> = fc.oneof(
  // plain: "notes"
  tokenArb,
  // with extension: "notes.md"
  fc.tuple(tokenArb, tokenArb).map(([b, e]) => `${b}.${e}`),
  // multi-dot: "archive.tar.gz"
  fc.tuple(tokenArb, tokenArb, tokenArb).map(([b, m, e]) => `${b}.${m}.${e}`),
  // dotfile: ".gitignore"
  tokenArb.map((b) => `.${b}`),
  // dotfile with extension: ".env.local"
  fc.tuple(tokenArb, tokenArb).map(([b, e]) => `.${b}.${e}`)
);

// Optional directory prefix, e.g. "" or "folder/" or "a/b/".
const dirArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc
    .array(tokenArb, { minLength: 1, maxLength: 3 })
    .map((segs) => segs.join("/") + "/")
);

const originalPathArb: fc.Arbitrary<string> = fc
  .tuple(dirArb, fileNameArb)
  .map(([dir, name]) => `${dir}${name}`);

// Arbitrary unrelated existing paths.
const existingPathArb: fc.Arbitrary<string> = fc
  .tuple(dirArb, fileNameArb)
  .map(([dir, name]) => `${dir}${name}`);

// A filesystem-safe device tag (no slash so it cannot alter path structure).
const deviceTagArb = fc
  .string({ minLength: 1, maxLength: 6 })
  .map((s) => s.replace(/[^a-z0-9]/gi, ""))
  .filter((s) => s.length > 0);

// A timestamp that renders to a valid ISO string (epoch ms, 1970..~2100).
const nowArb = fc.integer({ min: 0, max: 4_102_444_800_000 });

// --- Helpers that mirror the implementation (used only to force collisions) ---

function splitBase(path: string): string {
  const slash = path.lastIndexOf("/");
  const fileName = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function firstCandidate(
  originalPath: string,
  deviceTag: string,
  now: number
): string {
  const slash = originalPath.lastIndexOf("/");
  const dir = slash >= 0 ? originalPath.slice(0, slash + 1) : "";
  const fileName = slash >= 0 ? originalPath.slice(slash + 1) : originalPath;
  const dot = fileName.lastIndexOf(".");
  const hasExt = dot > 0;
  const base = hasExt ? fileName.slice(0, dot) : fileName;
  const ext = hasExt ? fileName.slice(dot) : "";
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const identifier = `${stamp} ${deviceTag}`;
  return `${dir}${base} (conflict ${identifier})${ext}`;
}

// --- Property -------------------------------------------------------------

describe("conflictCopyName (Property 7: conflict-copy names are unique and non-destructive)", () => {
  // Feature: obsidian-synology-webdav-sync, Property 7: For any original vault path and any set of existing vault paths, conflictCopyName(originalPath, existingPaths) SHALL return a name that (a) contains the original file's base name, (b) is not a member of existingPaths, and (c) is different from originalPath, so that no existing file is overwritten and the original file's name is never changed.
  // Validates: Requirements 9.1, 9.2, 9.3
  it("contains the original base name, avoids existing paths, and differs from the original", () => {
    fc.assert(
      fc.property(
        originalPathArb,
        fc.array(existingPathArb, { maxLength: 12 }),
        deviceTagArb,
        nowArb,
        fc.boolean(),
        fc.boolean(),
        (originalPath, extras, deviceTag, now, seedOriginal, seedCandidate) => {
          const existing = new Set<string>(extras);

          // Optionally seed the set with the original path so the function must
          // produce a name that still differs from it.
          if (seedOriginal) existing.add(originalPath);

          // Optionally seed the set with the exact first candidate the function
          // would generate, forcing the append-another-identifier loop.
          if (seedCandidate) {
            existing.add(firstCandidate(originalPath, deviceTag, now));
          }

          const result = conflictCopyName(originalPath, existing, deviceTag, now);

          // (a) contains the original file's base name
          const base = splitBase(originalPath);
          expect(result).toContain(base);

          // (b) is not a member of existingPaths
          expect(existing.has(result)).toBe(false);

          // (c) differs from the original path
          expect(result).not.toBe(originalPath);
        }
      ),
      { numRuns: 100 }
    );
  });
});
