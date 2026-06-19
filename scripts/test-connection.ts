/**
 * Dev-only connectivity probe.
 *
 * Runs the real {@link WebDAVClient} against a live server by injecting a
 * Node-based {@link Transport} in place of Obsidian's `requestUrl()` (which
 * only exists inside the app). This reuses the production client logic — Basic
 * auth, `Depth: 1` PROPFIND, redirect following, and the `testConnection`
 * result mapping — so a success here means the plugin's own code can talk to
 * your server.
 *
 * This file lives outside `src/` and intentionally uses Node's `https`/`http`,
 * which are NOT allowed in the plugin itself (mobile-safe rule). It is for
 * local testing only and is never bundled into the plugin.
 *
 * Usage (self-signed certs are accepted by default for local testing):
 *   WEBDAV_ENDPOINT="https://192.168.1.224:5006/" \
 *   WEBDAV_USERNAME="alice" \
 *   WEBDAV_PASSWORD="secret" \
 *   npx tsx scripts/test-connection.ts
 */
import http from "node:http";
import https from "node:https";
import { JSDOM } from "jsdom";

import { WebDAVClient } from "../src/client/webdavClient";
import type {
  HttpRequest,
  HttpResponse,
  Transport,
} from "../src/core/types";

// The response parser uses the browser's `DOMParser`, which exists inside
// Obsidian but is not a Node global. Provide one from jsdom (already a dev
// dependency) so the parsing path runs exactly as it does in the app.
if (typeof (globalThis as { DOMParser?: unknown }).DOMParser === "undefined") {
  (globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM().window.DOMParser;
}

/** A {@link Transport} backed by Node's http/https for local testing only. */
class NodeTransport implements Transport {
  /** Accept self-signed certificates (common on Synology HTTPS / port 5006). */
  constructor(private readonly insecureTLS: boolean = true) {}

  send(request: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
    const url = new URL(request.url);
    const agentModule = url.protocol === "https:" ? https : http;

    return new Promise<HttpResponse>((resolve, reject) => {
      const req = agentModule.request(
        url,
        {
          method: request.method,
          headers: request.headers,
          // Only meaningful for https; ignored for http.
          rejectUnauthorized: !this.insecureTLS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk as Buffer));
          res.on("end", () => {
            const bodyBuffer = Buffer.concat(chunks);
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              headers[key] = Array.isArray(value)
                ? value.join(", ")
                : (value ?? "");
            }
            resolve({
              status: res.statusCode ?? 0,
              headers,
              text: bodyBuffer.toString("utf8"),
              arrayBuffer: bodyBuffer.buffer.slice(
                bodyBuffer.byteOffset,
                bodyBuffer.byteOffset + bodyBuffer.byteLength,
              ),
            });
          });
        },
      );

      // Mirror the production transport's timeout-as-rejection behavior.
      req.setTimeout(timeoutMs, () => {
        req.destroy(
          Object.assign(new Error(`Request timed out after ${timeoutMs} ms`), {
            name: "TransportTimeoutError",
          }),
        );
      });
      req.on("error", reject);

      if (request.body !== undefined) {
        req.write(
          typeof request.body === "string"
            ? request.body
            : Buffer.from(request.body),
        );
      }
      req.end();
    });
  }
}

async function main(): Promise<void> {
  const endpoint = process.env.WEBDAV_ENDPOINT ?? "https://192.168.1.224:5006/";
  const username = (process.env.WEBDAV_USERNAME ?? "").trim();
  const password = (process.env.WEBDAV_PASSWORD ?? "").trim();

  if (username === "" || password === "") {
    // Report exactly what the script can see so the problem is easy to spot.
    // The password value is never printed — only whether it is present.
    console.error("Missing required environment variables.");
    console.error(
      `  WEBDAV_ENDPOINT = ${
        process.env.WEBDAV_ENDPOINT ? endpoint : "(unset, using default)"
      }`,
    );
    console.error(
      `  WEBDAV_USERNAME = ${username === "" ? "(MISSING)" : username}`,
    );
    console.error(
      `  WEBDAV_PASSWORD = ${password === "" ? "(MISSING)" : "(set)"}`,
    );
    console.error(
      "\nThe variables must be visible to THIS process. Either export them " +
        "first:\n" +
        '  export WEBDAV_USERNAME="alice"\n' +
        '  export WEBDAV_PASSWORD="secret"\n' +
        "  npx tsx scripts/test-connection.ts\n" +
        "or prefix them on a single line (bash/zsh):\n" +
        '  WEBDAV_USERNAME="alice" WEBDAV_PASSWORD="secret" npx tsx scripts/test-connection.ts',
    );
    process.exit(2);
  }

  console.log(`Testing connection to ${endpoint} as "${username}"...`);

  const client = new WebDAVClient(
    { endpoint, username, password },
    new NodeTransport(true),
  );

  const result = await client.testConnection();
  console.log(`\nResult: ${result.kind}`);
  console.log(result.message);

  if (result.kind === "success") {
    // Show the top-level listing as extra confirmation.
    const listing = await client.listDirectory("");
    console.log(`\nRemote entries found: ${listing.entries.length}`);
    for (const entry of listing.entries.slice(0, 20)) {
      console.log(`  ${entry.path} (${entry.size} bytes)`);
    }
  }

  process.exit(result.kind === "success" ? 0 : 1);
}

void main();
