import { describe, it, expect, vi } from "vitest";
import { SyncEngine, MAX_TRANSFER_RETRIES } from "./index";
import type {
  LocalVault,
  SyncEngineClient,
  LocalChange,
  Notifier,
} from "./index";
import type {
  ConnectionSettings,
  FileMeta,
  RemoteFileListing,
} from "../core/types";

/**
 * Example-based unit tests for the Sync Engine flows.
 *
 * These complement the property-based tests (`syncEngine.fullSync.test.ts`,
 * `syncEngine.fetchOnOpen.test.ts`) by pinning down the concrete behaviors
 * called out in task 15.6 with hand-picked scenarios:
 *
 *  - per-file retry is capped at {@link MAX_TRANSFER_RETRIES} extra attempts
 *    before a transfer is classified as failed (Req 6.5);
 *  - a fetch-on-open failure before any download leaves the vault unchanged and
 *    notifies the user (Req 7.5);
 *  - a fetch-on-open failure after at least one download retains the downloaded
 *    files and notifies the user of the partial failure (Req 7.6);
 *  - each vault event issues exactly the right remote operation —
 *    create/modify → PUT, delete → DELETE, rename → MOVE (Req 8.1–8.4).
 */

const BASE_TIME = 1_700_000_000_000;
/** A gap well beyond the 2000 ms equality window so decisions are unambiguous. */
const GAP = 10_000;

/** Valid settings so the fetch-on-open gate (Req 7.7) does not short-circuit. */
const VALID_SETTINGS: ConnectionSettings = {
  endpoint: "https://nas.example.com",
  username: "u",
  password: "p",
};

/** An empty remote listing helper. */
function listing(entries: FileMeta[]): RemoteFileListing {
  return { entries };
}

describe("SyncEngine.fullSync per-file retry cap (Req 6.5)", () => {
  it("retries an always-failing upload exactly 3 extra times then marks it failed", async () => {
    // local present, remote absent -> decideAction returns "upload".
    const path = "notes/always-fails.md";
    const local: FileMeta = { path, modifiedUtc: BASE_TIME, size: 1 };

    const putFile = vi.fn(async () => {
      throw new Error("upload boom");
    });

    const localVault: LocalVault = {
      listFiles: vi.fn(async () => [local]),
      readFile: vi.fn(async () => new ArrayBuffer(8)),
      writeFile: vi.fn(async () => {}),
    };
    const client: SyncEngineClient = {
      listTree: vi.fn(async () => listing([])),
      getFile: vi.fn(async () => new ArrayBuffer(8)),
      putFile,
      deleteFile: vi.fn(async () => {}),
      moveFile: vi.fn(async () => {}),
    };

    const engine = new SyncEngine(client, localVault);
    const report = await engine.fullSync();

    // 1 initial attempt + MAX_TRANSFER_RETRIES = 4 total.
    expect(putFile).toHaveBeenCalledTimes(MAX_TRANSFER_RETRIES + 1);
    expect(report.uploaded).toBe(0);
    expect(report.downloaded).toBe(0);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].path).toBe(path);
    expect(report.failed[0].error).toBe("upload boom");
  });

  it("retries an always-failing download exactly 3 extra times then marks it failed", async () => {
    // remote present, local absent -> decideAction returns "download".
    const path = "notes/remote-only.md";
    const remote: FileMeta = { path, modifiedUtc: BASE_TIME, size: 1 };

    const getFile = vi.fn(async () => {
      throw new Error("download boom");
    });

    const localVault: LocalVault = {
      listFiles: vi.fn(async () => []),
      readFile: vi.fn(async () => new ArrayBuffer(8)),
      writeFile: vi.fn(async () => {}),
    };
    const client: SyncEngineClient = {
      listTree: vi.fn(async () => listing([remote])),
      getFile,
      putFile: vi.fn(async () => {}),
      deleteFile: vi.fn(async () => {}),
      moveFile: vi.fn(async () => {}),
    };

    const engine = new SyncEngine(client, localVault);
    const report = await engine.fullSync();

    expect(getFile).toHaveBeenCalledTimes(MAX_TRANSFER_RETRIES + 1);
    // Nothing should have been written, since every download attempt failed.
    expect(localVault.writeFile).not.toHaveBeenCalled();
    expect(report.downloaded).toBe(0);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].path).toBe(path);
    expect(report.failed[0].error).toBe("download boom");
  });

  it("counts a transfer that succeeds on the 2nd attempt as a success (not failed)", async () => {
    // local newer than remote by GAP -> "upload"; fails once then succeeds.
    const path = "notes/recovers.md";
    const local: FileMeta = { path, modifiedUtc: BASE_TIME + GAP, size: 1 };
    const remote: FileMeta = { path, modifiedUtc: BASE_TIME, size: 1 };

    let attempts = 0;
    const putFile = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient");
      }
    });

    const localVault: LocalVault = {
      listFiles: vi.fn(async () => [local]),
      readFile: vi.fn(async () => new ArrayBuffer(8)),
      writeFile: vi.fn(async () => {}),
    };
    const client: SyncEngineClient = {
      listTree: vi.fn(async () => listing([remote])),
      getFile: vi.fn(async () => new ArrayBuffer(8)),
      putFile,
      deleteFile: vi.fn(async () => {}),
      moveFile: vi.fn(async () => {}),
    };

    const engine = new SyncEngine(client, localVault);
    const report = await engine.fullSync();

    // Exactly 2 attempts: the first fails, the second succeeds (no further retries).
    expect(putFile).toHaveBeenCalledTimes(2);
    expect(report.uploaded).toBe(1);
    expect(report.failed).toHaveLength(0);
  });
});

describe("SyncEngine.fetchOnOpen full failure before any download (Req 7.5)", () => {
  it("leaves the vault unchanged and notifies when listTree rejects", async () => {
    const writeFile = vi.fn(async () => {});
    const localVault: LocalVault = {
      listFiles: vi.fn(async () => []),
      readFile: vi.fn(async () => new ArrayBuffer(8)),
      writeFile,
    };
    const client: SyncEngineClient = {
      listTree: vi.fn(async () => {
        throw new Error("listing unreachable");
      }),
      getFile: vi.fn(async () => new ArrayBuffer(8)),
      putFile: vi.fn(async () => {}),
      deleteFile: vi.fn(async () => {}),
      moveFile: vi.fn(async () => {}),
    };
    const notify = vi.fn();
    const notifier: Notifier = { notify };

    const engine = new SyncEngine(client, localVault, {
      settings: VALID_SETTINGS,
      notifier,
    });

    await expect(engine.fetchOnOpen()).resolves.toBeUndefined();

    // No download was attempted and nothing was written: vault unchanged.
    expect(client.getFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();

    // The user is notified of a full failure that leaves the vault unchanged.
    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0][0] as string;
    expect(message).toContain("listing unreachable");
    expect(message).toContain("left unchanged");
  });

  it("leaves the vault unchanged and notifies when the first download fails before any write", async () => {
    const remote: FileMeta = {
      path: "notes/first.md",
      modifiedUtc: BASE_TIME + GAP,
      size: 1,
    };
    const writeFile = vi.fn(async () => {});
    const localVault: LocalVault = {
      listFiles: vi.fn(async () => []),
      readFile: vi.fn(async () => new ArrayBuffer(8)),
      writeFile,
    };
    const client: SyncEngineClient = {
      listTree: vi.fn(async () => listing([remote])),
      getFile: vi.fn(async () => {
        throw new Error("get failed");
      }),
      putFile: vi.fn(async () => {}),
      deleteFile: vi.fn(async () => {}),
      moveFile: vi.fn(async () => {}),
    };
    const notify = vi.fn();
    const notifier: Notifier = { notify };

    const engine = new SyncEngine(client, localVault, {
      settings: VALID_SETTINGS,
      notifier,
    });

    await engine.fetchOnOpen();

    // The download was attempted but failed before any write occurred.
    expect(client.getFile).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();

    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0][0] as string;
    expect(message).toContain("get failed");
    expect(message).toContain("left unchanged");
  });
});

describe("SyncEngine.fetchOnOpen partial failure retains downloads (Req 7.6)", () => {
  it("keeps the already-downloaded file and notifies of a partial failure", async () => {
    // Two remote-only files -> both decide "download". The first succeeds, the
    // second's getFile rejects, so the run stops after one successful write.
    const first: FileMeta = {
      path: "notes/first.md",
      modifiedUtc: BASE_TIME + GAP,
      size: 1,
    };
    const second: FileMeta = {
      path: "notes/second.md",
      modifiedUtc: BASE_TIME + GAP,
      size: 1,
    };

    const writeFile = vi.fn(async () => {});
    const localVault: LocalVault = {
      listFiles: vi.fn(async () => []),
      readFile: vi.fn(async () => new ArrayBuffer(8)),
      writeFile,
    };

    const getFile = vi.fn(async (remotePath: string) => {
      if (remotePath === second.path) {
        throw new Error("second download failed");
      }
      return new ArrayBuffer(8);
    });
    const client: SyncEngineClient = {
      listTree: vi.fn(async () => listing([first, second])),
      getFile,
      putFile: vi.fn(async () => {}),
      deleteFile: vi.fn(async () => {}),
      moveFile: vi.fn(async () => {}),
    };
    const notify = vi.fn();
    const notifier: Notifier = { notify };

    const engine = new SyncEngine(client, localVault, {
      settings: VALID_SETTINGS,
      notifier,
    });

    await engine.fetchOnOpen();

    // The first file was downloaded and written; the second failed.
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(first.path, expect.any(ArrayBuffer));
    // The written file is retained (not rolled back).
    expect(writeFile).not.toHaveBeenCalledWith(
      second.path,
      expect.anything(),
    );

    // The user is notified of a partial failure.
    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0][0] as string;
    expect(message).toContain("partially failed");
    expect(message).toContain("second download failed");
  });
});

describe("SyncEngine.handleLocalChange issues the right remote op (Req 8.1–8.4)", () => {
  function buildWorld() {
    const putFile = vi.fn(async () => {});
    const deleteFile = vi.fn(async () => {});
    const moveFile = vi.fn(async () => {});
    const readFile = vi.fn(async () => new ArrayBuffer(8));

    const localVault: LocalVault = {
      listFiles: vi.fn(async () => []),
      readFile,
      writeFile: vi.fn(async () => {}),
    };
    const client: SyncEngineClient = {
      listTree: vi.fn(async () => listing([])),
      getFile: vi.fn(async () => new ArrayBuffer(8)),
      putFile,
      deleteFile,
      moveFile,
    };
    const engine = new SyncEngine(client, localVault);
    return { engine, putFile, deleteFile, moveFile, readFile };
  }

  it("create -> PUT (Req 8.1)", async () => {
    const { engine, putFile, deleteFile, moveFile } = buildWorld();
    const change: LocalChange = { kind: "create", path: "notes/new.md" };

    await engine.handleLocalChange(change);

    expect(putFile).toHaveBeenCalledTimes(1);
    expect(putFile).toHaveBeenCalledWith("notes/new.md", expect.any(ArrayBuffer));
    expect(deleteFile).not.toHaveBeenCalled();
    expect(moveFile).not.toHaveBeenCalled();
  });

  it("modify -> PUT (Req 8.2)", async () => {
    const { engine, putFile, deleteFile, moveFile } = buildWorld();
    const change: LocalChange = { kind: "modify", path: "notes/edit.md" };

    await engine.handleLocalChange(change);

    expect(putFile).toHaveBeenCalledTimes(1);
    expect(putFile).toHaveBeenCalledWith(
      "notes/edit.md",
      expect.any(ArrayBuffer),
    );
    expect(deleteFile).not.toHaveBeenCalled();
    expect(moveFile).not.toHaveBeenCalled();
  });

  it("delete -> DELETE (Req 8.3)", async () => {
    const { engine, putFile, deleteFile, moveFile } = buildWorld();
    const change: LocalChange = { kind: "delete", path: "notes/gone.md" };

    await engine.handleLocalChange(change);

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith("notes/gone.md");
    expect(putFile).not.toHaveBeenCalled();
    expect(moveFile).not.toHaveBeenCalled();
  });

  it("rename -> MOVE(fromPath, path) (Req 8.4)", async () => {
    const { engine, putFile, deleteFile, moveFile } = buildWorld();
    const change: LocalChange = {
      kind: "rename",
      path: "notes/new-name.md",
      fromPath: "notes/old-name.md",
    };

    await engine.handleLocalChange(change);

    expect(moveFile).toHaveBeenCalledTimes(1);
    expect(moveFile).toHaveBeenCalledWith("notes/old-name.md", "notes/new-name.md");
    expect(putFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
