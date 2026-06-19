import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ConnectionSettings } from "../core";
import { FakeTransport, okResponse, redirectResponse } from "../transport";
import { MAX_REDIRECTS, RedirectLimitError, WebDAVClient } from "./index";

/**
 * Feature: obsidian-synology-webdav-sync, Property 6: For any redirect chain
 * returned by the Transport, the client follows up to 5 consecutive redirects
 * to a final response when the chain length is 5 or fewer, and aborts with a
 * redirect-limit error performing no local file writes when the chain exceeds
 * 5 redirects.
 *
 * Validates: Requirements 4.3, 4.4
 *
 * Counting semantics (see webdavClient.ts `request`): the redirect counter is
 * incremented once per redirect response observed, and a RedirectLimitError is
 * thrown the moment the counter exceeds MAX_REDIRECTS (5). So a chain of N
 * redirect responses followed by a final success:
 *   - N <= 5: every redirect is followed, the final response is returned, and
 *     the Transport is called exactly N + 1 times.
 *   - N >  5: the (MAX_REDIRECTS + 1)th = 6th request returns a redirect, the
 *     counter becomes 6 > 5, and the client aborts. The Transport is therefore
 *     called at most MAX_REDIRECTS + 1 = 6 times, and no further work runs.
 *
 * `getFile` is used as the operation under test because it performs no XML
 * parsing and no local file writes, so "no local file writes" is structurally
 * guaranteed: any write would have to flow through code the client never
 * reaches once it aborts.
 */

const settings: ConnectionSettings = {
  endpoint: "https://nas.example.com/webdav",
  username: "user",
  password: "secret",
};

describe("WebDAVClient redirect bounding (Property 6)", () => {
  it("follows <=5 redirects to a final response and aborts beyond 5", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Chain length spanning both sides of the limit (0..10).
        fc.integer({ min: 0, max: 10 }),
        async (chainLength) => {
          const transport = new FakeTransport();
          // N redirect responses, each pointing somewhere new, then a success.
          for (let i = 0; i < chainLength; i++) {
            transport.enqueue(redirectResponse(`/redirected/${i}`, 302));
          }
          transport.enqueue(okResponse("final-body", 200));

          const client = new WebDAVClient(settings, transport);

          if (chainLength <= MAX_REDIRECTS) {
            // Resolves to the final response, having walked the whole chain.
            const body = await client.getFile("/note.md");
            expect(new TextDecoder().decode(body)).toBe("final-body");
            // Exactly one request per redirect plus one for the final response.
            expect(transport.callCount).toBe(chainLength + 1);
          } else {
            // Aborts with a redirect-limit error.
            await expect(client.getFile("/note.md")).rejects.toBeInstanceOf(
              RedirectLimitError,
            );
            // Stopped as soon as the limit was exceeded: at most 6 requests,
            // and never the final success response (no writes/parsing reached).
            expect(transport.callCount).toBe(MAX_REDIRECTS + 1);
            expect(transport.callCount).toBeLessThanOrEqual(MAX_REDIRECTS + 1);
          }
        },
      ),
    );
  });
});
