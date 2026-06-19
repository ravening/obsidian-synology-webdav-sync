import { describe, it, expect, vi, beforeEach } from "vitest";
import { advanceTime, useFakeClock } from "../../test/setup";
import type { HttpRequest } from "../core/types";

/**
 * Unit tests for the production {@link RequestUrlTransport} (Req 4.7, 4.8).
 *
 * The transport wraps Obsidian's `requestUrl()` and races it against a timeout.
 * Because `requestUrl` is provided by the Obsidian runtime (not available under
 * the test runner), the entire `obsidian` module is mocked so each test can
 * hand the transport a controllable promise:
 *
 *   - a never-resolving promise to exercise the 30-second timeout race,
 *   - a rejected promise to model a transport-level failure, and
 *   - a resolved `RequestUrlResponse`-like object for the happy path.
 */

// `vi.hoisted` makes the mock function available to the hoisted `vi.mock`
// factory below while still letting the tests reference it directly.
const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));

vi.mock("obsidian", () => ({
  requestUrl: requestUrlMock,
}));

import {
  RequestUrlTransport,
  TransportTimeoutError,
} from "./requestUrlTransport";

const sampleRequest: HttpRequest = {
  url: "https://nas.example.com/dav/",
  method: "PROPFIND",
  headers: { Depth: "1", Authorization: "Basic dXNlcjpwYXNz" },
};

/** Build a minimal `RequestUrlResponse`-like object for the success path. */
function fakeRequestUrlResponse(text: string, status: number) {
  const arrayBuffer = new TextEncoder().encode(text).buffer;
  return {
    status,
    headers: { "Content-Type": "application/xml" },
    text,
    arrayBuffer,
  };
}

describe("RequestUrlTransport", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("rejects with TransportTimeoutError after the timeout elapses when no response arrives (Req 4.7, 4.8)", async () => {
    useFakeClock();
    // `requestUrl` never settles, so the timeout race is the only way out.
    requestUrlMock.mockReturnValue(new Promise(() => {}));

    const transport = new RequestUrlTransport();
    const pending = transport.send(sampleRequest, 30_000);
    // Assert on the rejection up front so the promise always has a handler,
    // avoiding an unhandled-rejection warning while time advances.
    const assertion = expect(pending).rejects.toBeInstanceOf(
      TransportTimeoutError,
    );

    // Before the timeout fires the promise must still be pending: advancing
    // just short of 30s does not reject.
    await advanceTime(29_999);
    // Crossing the 30s boundary triggers the timeout.
    await advanceTime(1);

    await assertion;
  });

  it("includes the timeout duration in the timeout error message (Req 4.7)", async () => {
    useFakeClock();
    requestUrlMock.mockReturnValue(new Promise(() => {}));

    const transport = new RequestUrlTransport();
    const pending = transport.send(sampleRequest, 30_000);
    const assertion = expect(pending).rejects.toThrow(/30000/);

    await advanceTime(30_000);

    await assertion;
  });

  it("propagates a transport-level failure when requestUrl rejects (Req 4.8)", async () => {
    const networkError = new Error("getaddrinfo ENOTFOUND nas.example.com");
    requestUrlMock.mockRejectedValue(networkError);

    const transport = new RequestUrlTransport();

    await expect(transport.send(sampleRequest, 30_000)).rejects.toBe(
      networkError,
    );
  });

  it("maps a resolved requestUrl response onto the HttpResponse shape without rejecting", async () => {
    const body = "<multistatus></multistatus>";
    requestUrlMock.mockResolvedValue(fakeRequestUrlResponse(body, 207));

    const transport = new RequestUrlTransport();
    const response = await transport.send(sampleRequest, 30_000);

    expect(response.status).toBe(207);
    expect(response.headers).toEqual({ "Content-Type": "application/xml" });
    expect(response.text).toBe(body);
    expect(new TextDecoder().decode(response.arrayBuffer)).toBe(body);
  });

  it("returns non-2xx responses normally rather than throwing (throw: false)", async () => {
    requestUrlMock.mockResolvedValue(fakeRequestUrlResponse("", 401));

    const transport = new RequestUrlTransport();
    const response = await transport.send(sampleRequest, 30_000);

    expect(response.status).toBe(401);
    // Confirm the transport opted out of requestUrl's throw-on-error behavior.
    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ throw: false }),
    );
  });
});
