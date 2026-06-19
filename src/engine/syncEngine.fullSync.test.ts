import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { SyncEngine, MAX_TRANSFER_RETRIES } from "./index";
import type { LocalVault, SyncEngineClient } from "./index";
import type { FileMeta, RemoteFileListing } from "../core/types";

/**
 * Property-based test for `SyncEngine.fullSync` report accounting.
 *
 * Feature: obsidian-synology-webdav-sync, Property 13: For any set of file
 * pairs processed by a full synchronization (with a fake Transport that fails
 * an arbitrary subset of transfers), the resulting SyncReport counts of
 * uploaded, downloaded, and failed SHALL equal the actual number of upload,
 * download, and exhausted-retry outcomes; the totals SHALL account for every
 * processed file exactly once; and the presence of any failed transfer SHALL
 * NOT prevent the remaining non-failing transfers from completing.
 *
 * Validates: Requirements 6.4, 6.6
 */
describe("SyncEngine.fullSync report accounting (Property 13)", () => {
  // A fixed epoch-ms anchor. Timestamps are separated by GAP (>> the 2000 ms
  // equality window) so each generated scenario lands on a single,
  // unambiguous decideAction outcome (upload / download / skip).
  const BASE_TIME = 1_700_000_000_000;
  const GAP = 10_000; // >> 2000 ms window, so no boundary ambiguity.

  /**
   * A single file scenario. `kind` fixes the action decideAction will choose;
   * `fail` marks transfers the fake client rejects on every attempt (ignored
   * for `skip`, which performs no transfer).
   */
  type ScenarioKind =
    | "upload-local-only" // local present, remote absent      -> upload
    | "upload-local-newer" // local newer than remote by GAP    -> upload
    | "download-remote-only" // remote present, local absent     -> download
    | "download-remote-newer" // remote newer than local by GAP  -> download
    | "skip"; // both present, identical timestamps             -> skip

  interface Scenario {
    kind: ScenarioKind;
    fail: boolean;
  }

  const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
    kind: fc.constantFrom<ScenarioKind>(
      "upload-local-only",
      "upload-local-newer",
      "download-remote-only",
      "download-remote-newer",
      "skip",
    ),
    fail: fc.boolean(),
  });

  const isUpload = (k: ScenarioKind): boolean =>
    k === "upload-local-only" || k === "upload-local-newer";
  const isDownload = (k: ScenarioKind): boolean =>
    k === "download-remote-only" || k === "download-remote-newer";

  /** Build an in-memory LocalVault and SyncEngineClient from scenarios. */
  function buildWorld(scenarios: Scenario[]) {
    // Unique, stable path per scenario index.
    const paths = scenarios.map((_, i) => `dir${i % 3}/file${i}.md`);
    const failSet = new Set<string>();

    const localFiles: FileMeta[] = [];
    const remoteEntries: FileMeta[] = [];

    scenarios.forEach((scenario, i) => {
      const path = paths[i];
      const { kind, fail } = scenario;

      switch (kind) {
        case "upload-local-only":
          localFiles.push({ path, modifiedUtc: BASE_TIME + GAP, size: 1 });
          // remote absent
          break;
        case "upload-local-newer":
          localFiles.push({ path, modifiedUtc: BASE_TIME + GAP, size: 1 });
          remoteEntries.push({ path, modifiedUtc: BASE_TIME, size: 1 });
          break;
        case "download-remote-only":
          remoteEntries.push({ path, modifiedUtc: BASE_TIME + GAP, size: 1 });
          // local absent
          break;
        case "download-remote-newer":
          remoteEntries.push({ path, modifiedUtc: BASE_TIME + GAP, size: 1 });
          localFiles.push({ path, modifiedUtc: BASE_TIME, size: 1 });
          break;
        case "skip":
          localFiles.push({ path, modifiedUtc: BASE_TIME, size: 1 });
          remoteEntries.push({ path, modifiedUtc: BASE_TIME, size: 1 });
          break;
      }

      // A failing transfer only applies to paths that are actually transferred.
      if (fail && (isUpload(kind) || isDownload(kind))) {
        failSet.add(path);
      }
    });

    const putCalls = new Map<string, number>();
    const getCalls = new Map<string, number>();
    const writes = new Set<string>();

    const localVault: LocalVault = {
      async listFiles() {
        return localFiles;
      },
      async readFile(_path: string) {
        // Reading the local source always succeeds; failures are injected at
        // the transport (put/get), not at the local read.
        return new ArrayBuffer(8);
      },
      async writeFile(path: string) {
        writes.add(path);
      },
    };

    const client: SyncEngineClient = {
      async listTree(): Promise<RemoteFileListing> {
        return { entries: remoteEntries };
      },
      async getFile(remotePath: string) {
        getCalls.set(remotePath, (getCalls.get(remotePath) ?? 0) + 1);
        if (failSet.has(remotePath)) {
          throw new Error(`download failed for ${remotePath}`);
        }
        return new ArrayBuffer(8);
      },
      async putFile(remotePath: string) {
        putCalls.set(remotePath, (putCalls.get(remotePath) ?? 0) + 1);
        if (failSet.has(remotePath)) {
          throw new Error(`upload failed for ${remotePath}`);
        }
      },
      async deleteFile() {
        /* unused by fullSync */
      },
      async moveFile() {
        /* unused by fullSync */
      },
    };

    return { paths, scenarios, failSet, localVault, client, putCalls, getCalls };
  }

  it("counts uploads, downloads and failures exactly, accounting for every processed file once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(scenarioArb, { minLength: 0, maxLength: 25 }),
        async (scenarios) => {
          const world = buildWorld(scenarios);
          const engine = new SyncEngine(world.client, world.localVault);

          const report = await engine.fullSync();

          // Expected outcomes derived independently from the scenarios.
          let expectedUploaded = 0;
          let expectedDownloaded = 0;
          let expectedFailed = 0;
          let nonSkip = 0;
          const expectedFailedPaths = new Set<string>();

          scenarios.forEach((scenario, i) => {
            const path = world.paths[i];
            const { kind, fail } = scenario;
            const transfer = isUpload(kind) || isDownload(kind);
            if (transfer) {
              nonSkip += 1;
              if (fail) {
                expectedFailed += 1;
                expectedFailedPaths.add(path);
              } else if (isUpload(kind)) {
                expectedUploaded += 1;
              } else {
                expectedDownloaded += 1;
              }
            }
          });

          // Counts equal the actual upload/download/exhausted-retry outcomes.
          expect(report.uploaded).toBe(expectedUploaded);
          expect(report.downloaded).toBe(expectedDownloaded);
          expect(report.failed.length).toBe(expectedFailed);

          // Every processed (non-skip) file is accounted for exactly once.
          expect(
            report.uploaded + report.downloaded + report.failed.length,
          ).toBe(nonSkip);

          // The reported failures are exactly the paths set to always fail.
          const reportedFailedPaths = new Set(
            report.failed.map((f) => f.path),
          );
          expect(reportedFailedPaths).toEqual(expectedFailedPaths);

          // Failures do not prevent the remaining transfers from completing:
          // every non-failing transfer was still counted as a success.
          const succeedingUploads = scenarios.filter(
            (s) => isUpload(s.kind) && !s.fail,
          ).length;
          const succeedingDownloads = scenarios.filter(
            (s) => isDownload(s.kind) && !s.fail,
          ).length;
          expect(report.uploaded).toBe(succeedingUploads);
          expect(report.downloaded).toBe(succeedingDownloads);

          // A failed transfer is attempted up to 4 times (1 + MAX_TRANSFER_RETRIES).
          for (const path of expectedFailedPaths) {
            const attempts =
              (world.putCalls.get(path) ?? 0) + (world.getCalls.get(path) ?? 0);
            expect(attempts).toBe(MAX_TRANSFER_RETRIES + 1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
