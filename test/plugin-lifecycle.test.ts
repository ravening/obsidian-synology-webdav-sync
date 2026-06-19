import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  FakeTransport,
  okResponse,
  type ScriptedResponse,
} from "../src/transport/fakeTransport";
import type { HttpRequest } from "../src/core/types";

/**
 * Integration test for the plugin lifecycle and wiring (task 19.4).
 *
 * The plugin entry point (`src/main.ts`) constructs its production transport
 * (`RequestUrlTransport`) internally, so there is no seam to inject a
 * `FakeTransport` directly. Instead we drive the transport from the bottom: the
 * production transport's only dependency is Obsidian's `requestUrl()`, which we
 * route into a {@link FakeTransport}. The fake therefore records every
 * {@link HttpRequest} the plugin actually puts on the wire (method, URL,
 * headers, body) and returns scripted responses, exactly as in the lower-level
 * client/engine tests.
 *
 * With that in place we assert two wiring behaviors end-to-end through a real
 * `onload`:
 *
 *  1. Vault create/modify/delete/rename events propagate to the corresponding
 *     WebDAV operations PUT / PUT / DELETE / MOVE (Req 8.1–8.4), and folder
 *     (non-`TFile`) events are ignored.
 *  2. Fetch-on-open runs once the workspace is ready when valid settings exist
 *     (a PROPFIND reaches the server, Req 7.1) and is skipped entirely when no
 *     valid settings exist (no request is made, Req 7.7). Initialization
 *     completes without raising a load error (Req 1.3).
 *
 * Validates: Requirements 1.3, 7.1, 7.7, 8.1, 8.2, 8.3, 8.4
 */

// A FakeTransport shared with the mocked `requestUrl`. Hoisted so the
// `vi.mock("obsidian")` factory (which is itself hoisted above the imports) can
// reference it; each test installs a fresh instance in `beforeEach`.
const hoisted = vi.hoisted(() => ({
  fake: null as FakeTransport | null,
}));

// Keep every real export of the stub (Notice, Plugin, App, TFile, the UI
// primitives, the DOM augmentation) and override only `requestUrl`, routing it
// into the FakeTransport so the production transport records and is scripted.
vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    requestUrl: (req: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: string | ArrayBuffer;
    }) => {
      const fake = hoisted.fake;
      if (fake === null) {
        throw new Error("FakeTransport was not installed for this test");
      }
      const request: HttpRequest = {
        url: req.url,
        method: req.method,
        headers: req.headers ?? {},
        body: req.body,
      };
      // The production transport applies the 30 s timeout itself; the fake
      // resolves immediately so the timeout never fires.
      return fake.send(request, 30_000);
    },
  };
});

// Imported after the mock is declared. The stub classes (TFile, the plugin
// base) resolve through the mocked module, so `instanceof TFile` matches the
// instances the plugin sees.
import { TFile } from "obsidian";
import SynologyWebdavSyncPlugin from "../src/main";

/** A well-formed but empty WebDAV multistatus body for PROPFIND responses. */
const EMPTY_MULTISTATUS =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:multistatus xmlns:d="DAV:"></d:multistatus>';

const VALID_SETTINGS = {
  endpoint: "https://nas.example.com:5006",
  username: "alice",
  password: "s3cret-pw",
};

/** A minimal Obsidian `Vault` whose events the test can emit on demand. */
class FakeVault {
  readonly files = new Map<string, TFile>();
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  /** Register a file so the local-vault adapter can read it during a PUT. */
  addFile(path: string): TFile {
    const file = new TFile(path, { mtime: 1_000, size: 4, ctime: 1_000 });
    this.files.set(path, file);
    return file;
  }

  on(name: string, cb: (...args: unknown[]) => void): { name: string } {
    const list = this.handlers.get(name) ?? [];
    list.push(cb);
    this.handlers.set(name, list);
    return { name };
  }

  /** Emit a vault event to every registered handler (Obsidian's dispatch). */
  emit(name: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(name) ?? []) {
      cb(...args);
    }
  }

  getFiles(): TFile[] {
    return Array.from(this.files.values());
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.files.get(path) ?? null;
  }

  async readBinary(_file: TFile): Promise<ArrayBuffer> {
    return new ArrayBuffer(4);
  }

  async createBinary(path: string, _content: ArrayBuffer): Promise<void> {
    this.files.set(path, new TFile(path, { mtime: 2_000, size: 4, ctime: 2_000 }));
  }

  async modifyBinary(_file: TFile, _content: ArrayBuffer): Promise<void> {}

  async createFolder(_path: string): Promise<void> {}
}

/** A minimal `Workspace` whose layout-ready callback the test triggers. */
class FakeWorkspace {
  private readonly callbacks: Array<() => void> = [];

  onLayoutReady(cb: () => void): void {
    this.callbacks.push(cb);
  }

  /** Fire the deferred fetch-on-open trigger registered during onload. */
  triggerLayoutReady(): void {
    for (const cb of this.callbacks) {
      cb();
    }
  }
}

/** Build the Obsidian `App` surface the plugin reads (vault + workspace). */
function makeApp(vault: FakeVault, workspace: FakeWorkspace): {
  vault: FakeVault;
  workspace: FakeWorkspace;
} {
  return { vault, workspace };
}

/**
 * Construct the plugin against the fake app. The published `obsidian` types are
 * stricter than the runtime stub, so the app/manifest are cast; at runtime the
 * stub `Plugin` constructor simply stores them.
 */
function makePlugin(
  vault: FakeVault,
  workspace: FakeWorkspace,
): SynologyWebdavSyncPlugin {
  const app = makeApp(vault, workspace);
  const manifest = { id: "synology-webdav-sync", version: "0.1.0" };
  return new SynologyWebdavSyncPlugin(
    app as unknown as ConstructorParameters<typeof SynologyWebdavSyncPlugin>[0],
    manifest as unknown as ConstructorParameters<
      typeof SynologyWebdavSyncPlugin
    >[1],
  );
}

/** Flush pending microtasks and the macrotask queue so async wiring settles. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The methods recorded by the fake transport, in order. */
function methodsSentTo(fake: FakeTransport): string[] {
  return fake.requests.map((r) => r.method);
}

describe("plugin lifecycle and wiring (task 19.4)", () => {
  let plugin: SynologyWebdavSyncPlugin | null = null;

  beforeEach(() => {
    const fake = new FakeTransport();
    // Answer a PROPFIND with an empty (but well-formed) multistatus so
    // fetch-on-open's listing succeeds; answer every other method 200 OK.
    fake.onRequest((req): ScriptedResponse => {
      if (req.method === "PROPFIND") {
        return okResponse(EMPTY_MULTISTATUS, 207, {
          "Content-Type": "application/xml",
        });
      }
      return okResponse("", 200);
    });
    hoisted.fake = fake;
  });

  afterEach(() => {
    // Clear the 30 s retry-flush interval the plugin registered so no timer
    // leaks across tests.
    if (plugin !== null) {
      for (const id of (plugin as unknown as { _registeredIntervals: number[] })
        ._registeredIntervals) {
        clearInterval(id);
      }
    }
    plugin = null;
    hoisted.fake = null;
    vi.restoreAllMocks();
  });

  it("propagates vault create/modify/delete/rename events to PUT/PUT/DELETE/MOVE (Req 8.1–8.4)", async () => {
    const fake = hoisted.fake as FakeTransport;
    const vault = new FakeVault();
    const workspace = new FakeWorkspace();
    vault.addFile("note.md"); // present so create/modify can read its bytes

    plugin = makePlugin(vault, workspace);
    // Valid settings must exist for per-change sync to reach the network.
    await plugin.saveData({ connectionSettings: VALID_SETTINGS });

    await plugin.onload();

    // A folder (non-TFile) create must be ignored by the file-only guard.
    vault.emit("create", { path: "folder" });
    await flush();
    expect(fake.requests).toHaveLength(0);

    // create -> PUT
    vault.emit("create", vault.getAbstractFileByPath("note.md"));
    await flush();
    // modify -> PUT
    vault.emit("modify", vault.getAbstractFileByPath("note.md"));
    await flush();
    // delete -> DELETE
    vault.emit("delete", vault.getAbstractFileByPath("note.md"));
    await flush();
    // rename -> MOVE
    vault.emit("rename", new TFile("renamed.md"), "note.md");
    await flush();

    expect(methodsSentTo(fake)).toEqual(["PUT", "PUT", "DELETE", "MOVE"]);

    // The create/modify PUTs target the changed file's path...
    const put = fake.requests[0];
    expect(put.url).toContain("note.md");
    // ...and every request carries HTTP Basic auth derived from the settings.
    for (const request of fake.requests) {
      expect(request.headers.Authorization ?? "").toMatch(/^Basic /);
    }

    // The MOVE renames from the old path to the new path.
    const move = fake.requests[3];
    expect(move.url).toContain("note.md");
    expect(move.headers.Destination ?? "").toContain("renamed.md");
  });

  it("runs fetch-on-open on load when valid settings exist (Req 1.3, 7.1)", async () => {
    const fake = hoisted.fake as FakeTransport;
    const vault = new FakeVault();
    const workspace = new FakeWorkspace();

    plugin = makePlugin(vault, workspace);
    await plugin.saveData({ connectionSettings: VALID_SETTINGS });

    // Initialization completes without throwing (Req 1.3).
    await expect(plugin.onload()).resolves.toBeUndefined();

    // Nothing is fetched until the workspace signals it is ready.
    expect(fake.requests).toHaveLength(0);

    workspace.triggerLayoutReady();
    await flush();

    // Fetch-on-open retrieves the remote listing via PROPFIND (Req 7.1).
    expect(methodsSentTo(fake)).toContain("PROPFIND");
    const propfind = fake.requests.find((r) => r.method === "PROPFIND");
    expect(propfind?.headers.Depth).toBe("1");
    expect(propfind?.headers.Authorization ?? "").toMatch(/^Basic /);
  });

  it("skips fetch-on-open on load when no valid settings exist (Req 7.7)", async () => {
    const fake = hoisted.fake as FakeTransport;
    const vault = new FakeVault();
    const workspace = new FakeWorkspace();

    // No settings persisted at all.
    plugin = makePlugin(vault, workspace);
    await expect(plugin.onload()).resolves.toBeUndefined();

    workspace.triggerLayoutReady();
    await flush();

    // No listing is fetched and the vault is left untouched (Req 7.7).
    expect(fake.requests).toHaveLength(0);
  });
});
