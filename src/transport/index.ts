/**
 * HTTP transport layer.
 *
 * The only modules that perform network I/O. The production implementation
 * wraps Obsidian's `requestUrl()` (which bypasses CORS on desktop and mobile)
 * and races it against a 30-second timeout. A `FakeTransport` test double is
 * used to exercise the WebDAV client and sync engine without a network.
 */
export {
  RequestUrlTransport,
  TransportTimeoutError,
} from "./requestUrlTransport";

export {
  FakeTransport,
  okResponse,
  redirectResponse,
  unauthorizedResponse,
  malformedXmlResponse,
  type ScriptedResponse,
  type RequestHandler,
} from "./fakeTransport";
