import { describe, it, expect } from "vitest";
import { WebDAVClient, AuthError, REQUEST_TIMEOUT_MS } from "./webdavClient";
import {
  FakeTransport,
  okResponse,
  unauthorizedResponse,
} from "../transport/fakeTransport";
import { TransportTimeoutError } from "../transport/requestUrlTransport";
import type { ConnectionSettings, HttpRequest } from "../core";

/**
 * Unit tests for {@link WebDAVClient} operations (Req 4.8, 4.9, 6.7).
 *
 * These exercise client-observable behavior through a {@link FakeTransport}
 * test double (no network):
 *
 *  - Req 4.8: a transport-level failure (timeout/unreachable) during an
 *    operation aborts the operation by rejecting, and the client performs no
 *    further work. The WebDAV client never writes the vault itself, so "without
 *    altering local files" is observed as: the operation rejects and no
 *    successful completion occurs.
 *  - Req 4.9: a `401` encountered mid-operation throws {@link AuthError} and the
 *    operation halts immediately — the transport is not called again afterward.
 *  - Req 6.7: a deep `putFile` issues an `MKCOL` for every missing parent
 *    segment, in order, before the `PUT` of the file.
 */

const settings: ConnectionSettings = {
  endpoint: "https://nas.example.com/dav/",
  username: "user",
  password: "pass",
};

/** Build a client bound to the given transport with the standard settings. */
function clientWith(transport: FakeTransport): WebDAVClient {
  return new WebDAVClient(settings, transport);
}

/** The URL of every recorded request, in order. */
function urls(transport: FakeTransport): string[] {
  return transport.requests.map((r: HttpRequest) => r.url);
}

/** The method of every recorded request, in order. */
function methods(transport: FakeTransport): string[] {
  return transport.requests.map((r: HttpRequest) => r.method);
}

// ---------------------------------------------------------------------------
// Req 4.8 — a transport timeout/failure aborts the operation with no vault write
// ---------------------------------------------------------------------------

describe("WebDAVClient timeout/transport-failure handling (Req 4.8)", () => {
  it("getFile rejects when the transport times out and issues no further requests", async () => {
    const transport = new FakeTransport();
    // Model the 30 s timeout as a transport-level rejection (the production
    // transport rejects with TransportTimeoutError when no response arrives).
    transport.enqueue({ reject: new TransportTimeoutError(REQUEST_TIMEOUT_MS) });
    const client = clientWith(transport);

    await expect(client.getFile("note.md")).rejects.toBeInstanceOf(
      TransportTimeoutError,
    );

    // The failure aborts the operation: exactly one request was attempted and
    // nothing followed it (the client performed no further work / no write).
    expect(transport.callCount).toBe(1);
    expect(methods(transport)).toEqual(["GET"]);
    // The client requested the operation under the 30 s timeout budget.
    expect(transport.timeouts).toEqual([REQUEST_TIMEOUT_MS]);
  });

  it("putFile rejects when the transport times out and does not complete successfully", async () => {
    const transport = new FakeTransport();
    // A flat path has no parent, so the PUT is the only request; reject it.
    transport.enqueue({ reject: new TransportTimeoutError(REQUEST_TIMEOUT_MS) });
    const client = clientWith(transport);

    const body = new TextEncoder().encode("hello").buffer;
    await expect(client.putFile("note.md", body)).rejects.toBeInstanceOf(
      TransportTimeoutError,
    );

    // No successful completion: the single PUT failed and nothing followed it.
    expect(transport.callCount).toBe(1);
    expect(methods(transport)).toEqual(["PUT"]);
  });
});

// ---------------------------------------------------------------------------
// Req 4.9 — a 401 mid-operation throws AuthError and halts further requests
// ---------------------------------------------------------------------------

describe("WebDAVClient 401 handling halts the operation (Req 4.9)", () => {
  it("listTree stops issuing requests after a 401 on a nested PROPFIND", async () => {
    // First PROPFIND (the root) succeeds and reports a subdirectory, so the
    // client would normally descend and issue a second PROPFIND. That second
    // request returns 401 and must halt the whole operation.
    const rootListing =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<d:multistatus xmlns:d="DAV:">\n' +
      "  <d:response>\n" +
      "    <d:href>/dav/sub/</d:href>\n" +
      "    <d:propstat>\n" +
      "      <d:prop>\n" +
      "        <d:getlastmodified>Tue, 01 Jan 2030 00:00:00 GMT</d:getlastmodified>\n" +
      "        <d:getcontentlength>0</d:getcontentlength>\n" +
      "      </d:prop>\n" +
      "      <d:status>HTTP/1.1 200 OK</d:status>\n" +
      "    </d:propstat>\n" +
      "  </d:response>\n" +
      "</d:multistatus>\n";

    const transport = new FakeTransport();
    transport.enqueue(okResponse(rootListing, 207));
    transport.enqueue(unauthorizedResponse());
    const client = clientWith(transport);

    await expect(client.listTree("")).rejects.toBeInstanceOf(AuthError);

    // Exactly two requests: the successful root PROPFIND and the 401 nested
    // PROPFIND. Nothing was issued after the 401.
    expect(transport.callCount).toBe(2);
    expect(methods(transport)).toEqual(["PROPFIND", "PROPFIND"]);
    expect(transport.lastRequest?.url).toBe("https://nas.example.com/dav/sub");
  });

  it("putFile stops before the PUT when the first MKCOL returns 401", async () => {
    // A deep path triggers MKCOL for each parent before the PUT. The first
    // MKCOL returns 401, so no further MKCOL and no PUT must be sent.
    const transport = new FakeTransport();
    transport.enqueue(unauthorizedResponse());
    const client = clientWith(transport);

    const body = new TextEncoder().encode("data").buffer;
    await expect(client.putFile("a/b/file.md", body)).rejects.toBeInstanceOf(
      AuthError,
    );

    expect(transport.callCount).toBe(1);
    expect(methods(transport)).toEqual(["MKCOL"]);
    // The PUT was never issued.
    expect(methods(transport)).not.toContain("PUT");
  });
});

// ---------------------------------------------------------------------------
// Req 6.7 — MKCOL for each missing parent, in order, before the PUT
// ---------------------------------------------------------------------------

describe("WebDAVClient creates parent collections before upload (Req 6.7)", () => {
  it("issues MKCOL for each ancestor segment top-down before the PUT on a deep path", async () => {
    const transport = new FakeTransport();
    // Every request succeeds (201 Created is a valid 2xx success).
    transport.setDefault(okResponse("", 201));
    const client = clientWith(transport);

    const body = new TextEncoder().encode("contents").buffer;
    await client.putFile("a/b/c/file.md", body);

    // Recorded requests: MKCOL a, MKCOL a/b, MKCOL a/b/c, then PUT the file.
    expect(methods(transport)).toEqual(["MKCOL", "MKCOL", "MKCOL", "PUT"]);
    expect(urls(transport)).toEqual([
      "https://nas.example.com/dav/a",
      "https://nas.example.com/dav/a/b",
      "https://nas.example.com/dav/a/b/c",
      "https://nas.example.com/dav/a/b/c/file.md",
    ]);

    // Each parent MKCOL was issued before the PUT, in ancestor order.
    const recordedMethods = methods(transport);
    const putIndex = recordedMethods.indexOf("PUT");
    const mkcolIndexes = recordedMethods
      .map((m, i) => (m === "MKCOL" ? i : -1))
      .filter((i) => i >= 0);
    expect(mkcolIndexes).toEqual([0, 1, 2]);
    for (const i of mkcolIndexes) {
      expect(i).toBeLessThan(putIndex);
    }
  });
});
