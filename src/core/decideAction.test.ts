import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decideAction, EQUALITY_WINDOW_MS } from "./index";
import type { FileMeta } from "./index";

/**
 * Property-based test for `decideAction`.
 *
 * Feature: obsidian-synology-webdav-sync, Property 1: For any pair of
 * FileMeta | null values (local, remote), decideAction(local, remote) SHALL be:
 * upload when the remote is absent or the local timestamp is more than 2000 ms
 * newer than the remote; download when the local is absent or the remote
 * timestamp is more than 2000 ms newer than the local; skip when both are
 * present and their timestamps differ by 2000 ms or less (the equality window,
 * inclusive of exactly 2000 ms); and the function SHALL never transfer either
 * file when it returns skip.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 7.2, 7.3, 7.4
 */
describe("decideAction (Property 1)", () => {
  // A base time around which we cluster timestamps so the generated pairs
  // repeatedly land on and around the inclusive 2000 ms equality boundary.
  const BASE_TIME = 1_700_000_000_000; // a fixed epoch-ms anchor

  // Offsets chosen to exercise the exact boundary (±2000), just inside
  // (±1, 0), and just outside (±2001) the equality window.
  const boundaryOffsets = [-2001, -2000, -1, 0, 1, 2000, 2001];

  // A FileMeta generator whose timestamp is deliberately clustered around the
  // 2000 ms boundary: it picks either one of the boundary offsets or a random
  // small offset, applied to the shared base time.
  const clusteredMeta = (): fc.Arbitrary<FileMeta> =>
    fc
      .record({
        path: fc.string(),
        offset: fc.oneof(
          fc.constantFrom(...boundaryOffsets),
          fc.integer({ min: -5000, max: 5000 }),
        ),
        size: fc.nat(),
      })
      .map(({ path, offset, size }) => ({
        path,
        modifiedUtc: BASE_TIME + offset,
        size,
      }));

  // local/remote are each either a clustered FileMeta or null.
  const metaOrNull = (): fc.Arbitrary<FileMeta | null> =>
    fc.option(clusteredMeta(), { nil: null });

  it("returns the spec-mandated action for every file-pair state", () => {
    fc.assert(
      fc.property(metaOrNull(), metaOrNull(), (local, remote) => {
        const action = decideAction(local, remote);

        if (local === null && remote === null) {
          // Degenerate edge case: nothing to do on either side.
          expect(action).toBe("skip");
          return;
        }

        if (remote === null) {
          // Present locally, absent remotely -> upload (Req 6.1).
          expect(action).toBe("upload");
          return;
        }

        if (local === null) {
          // Present remotely, absent locally -> download (Req 6.2, 7.3).
          expect(action).toBe("download");
          return;
        }

        // Both present: compare against the inclusive equality window.
        const delta = local.modifiedUtc - remote.modifiedUtc;

        if (delta > EQUALITY_WINDOW_MS) {
          // Local strictly more than the window newer -> upload (Req 6.1).
          expect(action).toBe("upload");
        } else if (-delta > EQUALITY_WINDOW_MS) {
          // Remote strictly more than the window newer -> download (Req 6.2, 7.2).
          expect(action).toBe("download");
        } else {
          // |delta| <= 2000 ms -> treat as synchronized, skip (Req 6.3, 7.4).
          expect(action).toBe("skip");
          // When skip is returned, neither file is transferred: the action is
          // exactly "skip" and never an upload/download/conflict/delete.
          expect(action).not.toBe("upload");
          expect(action).not.toBe("download");
        }
      }),
    );
  });

  it("treats a delta of exactly +2000 ms as skip (inclusive upper boundary)", () => {
    const remote: FileMeta = { path: "a.md", modifiedUtc: BASE_TIME, size: 1 };
    const local: FileMeta = {
      path: "a.md",
      modifiedUtc: BASE_TIME + EQUALITY_WINDOW_MS,
      size: 1,
    };
    expect(decideAction(local, remote)).toBe("skip");
  });

  it("treats a delta of exactly -2000 ms as skip (inclusive lower boundary)", () => {
    const remote: FileMeta = {
      path: "a.md",
      modifiedUtc: BASE_TIME + EQUALITY_WINDOW_MS,
      size: 1,
    };
    const local: FileMeta = { path: "a.md", modifiedUtc: BASE_TIME, size: 1 };
    expect(decideAction(local, remote)).toBe("skip");
  });

  it("uploads when local is 2001 ms newer (just outside the window)", () => {
    const remote: FileMeta = { path: "a.md", modifiedUtc: BASE_TIME, size: 1 };
    const local: FileMeta = {
      path: "a.md",
      modifiedUtc: BASE_TIME + EQUALITY_WINDOW_MS + 1,
      size: 1,
    };
    expect(decideAction(local, remote)).toBe("upload");
  });

  it("downloads when remote is 2001 ms newer (just outside the window)", () => {
    const local: FileMeta = { path: "a.md", modifiedUtc: BASE_TIME, size: 1 };
    const remote: FileMeta = {
      path: "a.md",
      modifiedUtc: BASE_TIME + EQUALITY_WINDOW_MS + 1,
      size: 1,
    };
    expect(decideAction(local, remote)).toBe("download");
  });
});
