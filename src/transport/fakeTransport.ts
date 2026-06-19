/**
 * In-memory `Transport` test double.
 *
 * `FakeTransport` lets unit, integration, and property-based tests drive the
 * WebDAV client and sync engine without a network (Req 4.6). It does two
 * things:
 *
 *  - **Records** every {@link HttpRequest} it receives, in order, so tests can
 *    assert on what was sent (method, URL, headers, body, Basic auth, `Depth`,
 *    redirect-following counts, request ordering, and so on).
 *  - **Returns scripted responses.** Responses can be scripted three ways and
 *    are resolved in this order of precedence per call:
 *      1. a per-request handler function (most flexible), then
 *      2. the next entry of a FIFO queue of scripted responses, then
 *      3. a single default response.
 *    If none is configured the transport throws, so a missing script surfaces
 *    loudly rather than silently returning an empty body.
 *
 * A scripted entry is either a ready {@link HttpResponse}, a transport-level
 * rejection (unreachable host / TLS error), or a never-resolving promise used
 * to exercise the 30-second timeout (Req 4.7, 4.8) in combination with the
 * test runner's fake clock.
 *
 * Helper factories ({@link okResponse}, {@link redirectResponse},
 * {@link unauthorizedResponse}, {@link malformedXmlResponse}) build the common
 * scripted shapes — including redirect chains via repeated 3xx responses with
 * `Location` headers (Req 4.3, 4.4) — without each test hand-rolling the
 * `HttpResponse` fields.
 */
import type { HttpRequest, HttpResponse, Transport } from "../core/types";

/**
 * A scripted outcome for a single `send()` call.
 *
 *  - A plain {@link HttpResponse} resolves normally (any status, including 3xx
 *    and 401, since the production transport never throws on status).
 *  - `{ reject }` rejects the promise to model a transport-level failure such
 *    as an unreachable host or TLS error.
 *  - `{ neverResolve: true }` returns a promise that never settles, so a
 *    timeout race (against a fake clock) is the only way the call completes.
 */
export type ScriptedResponse =
  | HttpResponse
  | { reject: unknown }
  | { neverResolve: true };

/**
 * A handler that produces a scripted outcome from the incoming request. It may
 * return synchronously or asynchronously. Returning `undefined` defers to the
 * queue / default response, letting a handler answer only the requests it
 * cares about.
 */
export type RequestHandler = (
  request: HttpRequest,
  timeoutMs: number,
  callIndex: number,
) => ScriptedResponse | undefined | Promise<ScriptedResponse | undefined>;

/** Convert a UTF-8 string into the `ArrayBuffer` half of an `HttpResponse`. */
function toArrayBuffer(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  // Copy into a standalone ArrayBuffer so the result is not a view over a
  // larger/shared buffer.
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

/**
 * Build a successful (or arbitrary-status) `HttpResponse` from a text body.
 * `text` and `arrayBuffer` are kept consistent automatically.
 */
export function okResponse(
  text = "",
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers,
    text,
    arrayBuffer: toArrayBuffer(text),
  };
}

/**
 * Build a 3xx redirect response pointing at `location`. Chain several of these
 * (via {@link FakeTransport.enqueue}) to model a redirect sequence and verify
 * the client follows at most five (Req 4.3, 4.4).
 */
export function redirectResponse(
  location: string,
  status = 302,
  headers: Record<string, string> = {},
): HttpResponse {
  return okResponse("", status, { Location: location, ...headers });
}

/** Build a 401 Unauthorized response, optionally with a body. */
export function unauthorizedResponse(text = ""): HttpResponse {
  return okResponse(text, 401);
}

/**
 * Build a 207 Multi-Status response whose body is deliberately not well-formed
 * XML, for exercising the parser's `malformed-xml` path (Req 5.6).
 */
export function malformedXmlResponse(
  text = "<multistatus><response>not closed",
  status = 207,
): HttpResponse {
  return okResponse(text, status, { "Content-Type": "application/xml" });
}

function isReject(value: ScriptedResponse): value is { reject: unknown } {
  return typeof value === "object" && value !== null && "reject" in value;
}

function isNeverResolve(
  value: ScriptedResponse,
): value is { neverResolve: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "neverResolve" in value &&
    value.neverResolve === true
  );
}

/**
 * Test double implementing the {@link Transport} interface.
 */
export class FakeTransport implements Transport {
  /** Every request received, in the order `send()` was called. */
  readonly requests: HttpRequest[] = [];

  /** The `timeoutMs` argument passed to each corresponding `send()` call. */
  readonly timeouts: number[] = [];

  private readonly queue: ScriptedResponse[] = [];
  private handler?: RequestHandler;
  private defaultResponse?: ScriptedResponse;

  /**
   * @param scripted Optional initial queue of scripted responses, consumed
   *   FIFO across successive `send()` calls.
   */
  constructor(scripted: ScriptedResponse[] = []) {
    this.queue.push(...scripted);
  }

  /** Append one scripted response to the FIFO queue. Returns `this`. */
  enqueue(response: ScriptedResponse): this {
    this.queue.push(response);
    return this;
  }

  /** Append several scripted responses to the FIFO queue. Returns `this`. */
  enqueueAll(responses: ScriptedResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  /**
   * Install a per-request handler, taking precedence over the queue and the
   * default. Return `undefined` from the handler to defer to them. Returns
   * `this`.
   */
  onRequest(handler: RequestHandler): this {
    this.handler = handler;
    return this;
  }

  /**
   * Set the fallback response used when neither the handler nor the queue
   * provides one. Returns `this`.
   */
  setDefault(response: ScriptedResponse): this {
    this.defaultResponse = response;
    return this;
  }

  /** Number of requests recorded so far. */
  get callCount(): number {
    return this.requests.length;
  }

  /** The most recently recorded request, or `undefined` if none. */
  get lastRequest(): HttpRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  /** Clear recorded requests and any queued/handler/default scripting. */
  reset(): void {
    this.requests.length = 0;
    this.timeouts.length = 0;
    this.queue.length = 0;
    this.handler = undefined;
    this.defaultResponse = undefined;
  }

  async send(request: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
    const callIndex = this.requests.length;
    this.requests.push(request);
    this.timeouts.push(timeoutMs);

    let outcome: ScriptedResponse | undefined;

    if (this.handler) {
      outcome = await this.handler(request, timeoutMs, callIndex);
    }

    if (outcome === undefined && this.queue.length > 0) {
      outcome = this.queue.shift();
    }

    if (outcome === undefined) {
      outcome = this.defaultResponse;
    }

    if (outcome === undefined) {
      throw new Error(
        `FakeTransport: no scripted response for ${request.method} ${request.url} (call #${callIndex}). ` +
          "Enqueue a response, set a handler, or set a default.",
      );
    }

    if (isNeverResolve(outcome)) {
      // Never settles: the caller's timeout race must resolve/reject instead.
      return new Promise<HttpResponse>(() => {});
    }

    if (isReject(outcome)) {
      return Promise.reject(outcome.reject);
    }

    return outcome;
  }
}
