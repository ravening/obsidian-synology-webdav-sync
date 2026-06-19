import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { FakeTransport, okResponse } from "../transport/fakeTransport";
import { render, type ConnectionSettings } from "../core";
import { WebDAVClient, basicAuthHeader } from "./webdavClient";

/**
 * Property-based test for design Property 5 (request invariants).
 *
 * Feature: obsidian-synology-webdav-sync, Property 5: For any ConnectionSettings
 * and any WebDAV client operation, the HttpRequest handed to the Transport SHALL
 * include an `Authorization: Basic <base64(username + ":" + password)>` header
 * derived from those settings; and for any directory-listing operation, every
 * PROPFIND request observed by the Transport SHALL carry the header `Depth: 1`.
 *
 * Validates: Requirements 4.1, 4.2
 */

/** Case-insensitive header lookup (server/request header casing is not fixed). */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key];
    }
  }
  return undefined;
}

/**
 * A valid, well-formed (empty) 207 Multistatus body so `listDirectory`'s parse
 * step succeeds. Other operations ignore the body.
 */
const EMPTY_MULTISTATUS = render({ entries: [] });

/** Arbitrary absolute http(s) endpoint, with or without a trailing slash. */
const endpointArb: fc.Arbitrary<string> = fc
  .record({
    scheme: fc.constantFrom("http", "https"),
    host: fc.constantFrom("nas.example.com", "192.168.1.10", "synology.local"),
    port: fc.option(fc.constantFrom(5005, 5006, 8080), { nil: undefined }),
    basePath: fc.constantFrom("", "/dav", "/dav/webdav", "/remote.php/dav"),
    trailingSlash: fc.boolean(),
  })
  .map(({ scheme, host, port, basePath, trailingSlash }) => {
    const portPart = port === undefined ? "" : `:${port}`;
    const slash = trailingSlash ? "/" : "";
    return `${scheme}://${host}${portPart}${basePath}${slash}`;
  });

/** Arbitrary ConnectionSettings, including non-ASCII credentials. */
const settingsArb: fc.Arbitrary<ConnectionSettings> = fc.record({
  endpoint: endpointArb,
  username: fc.string({ minLength: 1, maxLength: 255 }),
  password: fc.string({ minLength: 1, maxLength: 255 }),
});

/** Arbitrary vault-relative path with one or more safe segments. */
const pathArb: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(
      "notes",
      "My File.md",
      "attach",
      "deep",
      "a",
      "file.txt",
      "sub dir",
    ),
    { minLength: 1, maxLength: 4 },
  )
  .map((segments) => segments.join("/"));

/** The set of client operations exercised by the property. */
const operations: ReadonlyArray<{
  name: string;
  run: (client: WebDAVClient, path: string) => Promise<unknown>;
}> = [
  { name: "listDirectory", run: (c, p) => c.listDirectory(p) },
  { name: "getFile", run: (c, p) => c.getFile(p) },
  { name: "putFile", run: (c, p) => c.putFile(p, new ArrayBuffer(8)) },
  { name: "deleteFile", run: (c, p) => c.deleteFile(p) },
  { name: "moveFile", run: (c, p) => c.moveFile(p, `${p}-moved`) },
  { name: "makeCollection", run: (c, p) => c.makeCollection(p) },
];

describe("WebDAVClient request invariants (Property 5)", () => {
  it("attaches Basic auth to every request and Depth:1 to every PROPFIND across all operations (Req 4.1, 4.2)", async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        pathArb,
        async (settings, path) => {
          const expectedAuth = basicAuthHeader(
            settings.username,
            settings.password,
          );

          for (const operation of operations) {
            // Fresh transport per operation: a default 207 success keeps every
            // op on its happy path (PROPFIND bodies parse; others 2xx).
            const transport = new FakeTransport().setDefault(
              okResponse(EMPTY_MULTISTATUS, 207),
            );
            const client = new WebDAVClient(settings, transport);

            await operation.run(client, path);

            // Each operation must have produced at least one request.
            expect(transport.requests.length).toBeGreaterThan(0);

            for (const request of transport.requests) {
              // Req 4.1: every request carries Basic auth derived from settings.
              expect(headerValue(request.headers, "Authorization")).toBe(
                expectedAuth,
              );
              // Req 4.2: every PROPFIND directory listing carries Depth: 1.
              if (request.method === "PROPFIND") {
                expect(headerValue(request.headers, "Depth")).toBe("1");
              }
            }
          }
        },
      ),
    );
  });

  it("issues a PROPFIND with Depth:1 for a directory listing (Req 4.2)", async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, pathArb, async (settings, path) => {
        const transport = new FakeTransport().setDefault(
          okResponse(EMPTY_MULTISTATUS, 207),
        );
        const client = new WebDAVClient(settings, transport);

        await client.listDirectory(path);

        const propfinds = transport.requests.filter(
          (r) => r.method === "PROPFIND",
        );
        // A directory listing performs exactly one Depth:1 PROPFIND.
        expect(propfinds.length).toBeGreaterThan(0);
        for (const request of propfinds) {
          expect(headerValue(request.headers, "Depth")).toBe("1");
        }
      }),
    );
  });
});
