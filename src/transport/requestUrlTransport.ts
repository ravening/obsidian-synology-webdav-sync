/**
 * Production HTTP transport.
 *
 * The single module that performs real network I/O. It wraps Obsidian's
 * `requestUrl()` API, which issues requests from the native layer and bypasses
 * browser cross-origin restrictions on both desktop and mobile (Req 4.6).
 *
 * Two behaviors distinguish it from a raw `fetch`:
 *
 *  - It calls `requestUrl({ ..., throw: false })` so a non-2xx status (e.g. a
 *    401 or a 3xx redirect) is returned as a normal `HttpResponse` rather than
 *    thrown. The WebDAV client interprets the status code itself.
 *  - It races the request against a timeout (30 seconds in production, Req 4.7).
 *    If no response arrives in time the request is abandoned and the promise
 *    rejects with a timeout error so callers can abort without touching local
 *    files (Req 4.8). It likewise rejects on any other transport-level failure
 *    such as an unreachable host or a TLS error.
 */
import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { HttpRequest, HttpResponse, Transport } from "../core/types";

/**
 * Error raised when a request does not receive a response within `timeoutMs`.
 */
export class TransportTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = "TransportTimeoutError";
  }
}

/**
 * Transport implementation backed by Obsidian's `requestUrl()`.
 */
export class RequestUrlTransport implements Transport {
  async send(request: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TransportTimeoutError(timeoutMs));
      }, timeoutMs);
    });

    // `throw: false` ensures non-2xx responses resolve normally; the promise
    // only rejects on a genuine transport-level failure (unreachable host,
    // TLS error). The timeout promise covers the no-response case.
    const network = requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      throw: false,
    }).then((response: RequestUrlResponse) => toHttpResponse(response));

    try {
      return await Promise.race([network, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * Map an Obsidian `RequestUrlResponse` onto the platform-agnostic
 * `HttpResponse` shape consumed by the rest of the plugin.
 */
function toHttpResponse(response: RequestUrlResponse): HttpResponse {
  return {
    status: response.status,
    headers: response.headers,
    text: response.text,
    arrayBuffer: response.arrayBuffer,
  };
}
