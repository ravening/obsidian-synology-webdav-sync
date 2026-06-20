import { describe, expect, it } from "vitest";

import { WebDAVClient, AuthError, WebDAVError } from "./webdavClient";
import {
  FakeTransport,
  okResponse,
  unauthorizedResponse,
  malformedXmlResponse,
} from "../transport/fakeTransport";
import type { ConnectionSettings } from "../core/types";

/**
 * Regression tests for `WebDAVClient.listFolders` against realistic WebDAV
 * `207 Multistatus` responses.
 *
 * These pin two bugs that previously made the remote folder browser show an
 * empty list (or break navigation) on a real server:
 *
 *  1. Collections must be detected from `<resourcetype><collection/>` — the
 *     PROPFIND body now requests `<resourcetype/>`, so the server returns it.
 *  2. Server `<href>` values carry the endpoint's mount-point prefix
 *     (e.g. `/webdav/Notes/`). `listFolders` must strip that prefix so the
 *     returned paths are endpoint-relative (`Notes`), the directory's own
 *     self-entry is dropped, and navigating into a child does not double the
 *     prefix.
 */

const ENDPOINT = "https://nas.example.com:5006/webdav";

const SETTINGS: ConnectionSettings = {
  endpoint: ENDPOINT,
  username: "alice",
  password: "secret",
};

/**
 * A Synology-style multistatus body. Hrefs are absolute paths carrying the
 * `/webdav` mount prefix; directories declare a `<d:collection/>` resourcetype
 * and a trailing-slash href, files declare neither.
 */
function multistatus(entries: { href: string; collection: boolean }[]): string {
  const responses = entries
    .map(({ href, collection }) => {
      const resourcetype = collection
        ? "<d:resourcetype><d:collection/></d:resourcetype>"
        : "<d:resourcetype/>";
      return (
        "<d:response>" +
        `<d:href>${href}</d:href>` +
        "<d:propstat>" +
        `<d:prop>${resourcetype}</d:prop>` +
        "<d:status>HTTP/1.1 200 OK</d:status>" +
        "</d:propstat>" +
        "</d:response>"
      );
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`
  );
}

function multistatusResponse(
  entries: { href: string; collection: boolean }[],
): ReturnType<typeof okResponse> {
  return okResponse(multistatus(entries), 207, {
    "Content-Type": "application/xml",
  });
}

describe("WebDAVClient.listFolders", () => {
  it("requests resourcetype in the PROPFIND body", async () => {
    const transport = new FakeTransport().setDefault(multistatusResponse([]));
    const client = new WebDAVClient(SETTINGS, transport);

    await client.listFolders("");

    const body = String(transport.lastRequest?.body ?? "");
    expect(body).toContain("resourcetype");
  });

  it("lists child collections of the server root, stripping the mount prefix and dropping the self-entry", async () => {
    const transport = new FakeTransport().setDefault(
      multistatusResponse([
        { href: "/webdav/", collection: true }, // self-entry
        { href: "/webdav/Notes/", collection: true },
        { href: "/webdav/Photos/", collection: true },
        { href: "/webdav/todo.md", collection: false }, // a file: excluded
      ]),
    );
    const client = new WebDAVClient(SETTINGS, transport);

    const listing = await client.listFolders("");

    expect(listing.path).toBe("");
    expect(listing.folders).toEqual([
      { name: "Notes", path: "Notes" },
      { name: "Photos", path: "Photos" },
    ]);
  });

  it("returns endpoint-relative child paths so navigating one level deeper hits the correct URL", async () => {
    const transport = new FakeTransport().setDefault(
      multistatusResponse([
        { href: "/webdav/Notes/", collection: true }, // self-entry
        { href: "/webdav/Notes/Daily/", collection: true },
      ]),
    );
    const client = new WebDAVClient(SETTINGS, transport);

    const listing = await client.listFolders("Notes");

    expect(listing.folders).toEqual([{ name: "Daily", path: "Notes/Daily" }]);

    // The request URL must not double the mount prefix.
    const url = transport.lastRequest?.url ?? "";
    expect(url).toBe("https://nas.example.com:5006/webdav/Notes");
    expect(url).not.toContain("/webdav/webdav");
  });

  it("detects collections via a trailing-slash href even without a resourcetype", async () => {
    const transport = new FakeTransport().setDefault(
      multistatusResponse([
        { href: "/webdav/", collection: false },
        { href: "/webdav/Archive/", collection: false }, // trailing slash only
      ]),
    );
    const client = new WebDAVClient(SETTINGS, transport);

    const listing = await client.listFolders("");

    expect(listing.folders).toEqual([{ name: "Archive", path: "Archive" }]);
  });

  it("handles full-URL hrefs by extracting and relativizing the path", async () => {
    const transport = new FakeTransport().setDefault(
      multistatusResponse([
        {
          href: "https://nas.example.com:5006/webdav/",
          collection: true,
        },
        {
          href: "https://nas.example.com:5006/webdav/Work/",
          collection: true,
        },
      ]),
    );
    const client = new WebDAVClient(SETTINGS, transport);

    const listing = await client.listFolders("");

    expect(listing.folders).toEqual([{ name: "Work", path: "Work" }]);
  });

  it("maps a 401 to AuthError", async () => {
    const transport = new FakeTransport().setDefault(unauthorizedResponse());
    const client = new WebDAVClient(SETTINGS, transport);

    await expect(client.listFolders("")).rejects.toBeInstanceOf(AuthError);
  });

  it("throws WebDAVError('malformed-xml') on an unparseable body", async () => {
    const transport = new FakeTransport().setDefault(malformedXmlResponse());
    const client = new WebDAVClient(SETTINGS, transport);

    await expect(client.listFolders("")).rejects.toMatchObject({
      kind: "malformed-xml",
    });
    await expect(client.listFolders("")).rejects.toBeInstanceOf(WebDAVError);
  });
});
