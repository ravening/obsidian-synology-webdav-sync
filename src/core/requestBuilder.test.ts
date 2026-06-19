import { describe, it, expect } from "vitest";
import { buildPropfindBody } from "./index";

/**
 * Unit tests for the PROPFIND request builder (Req 5.3).
 *
 * The builder must emit a well-formed XML document that requests the three
 * properties the response parser needs to construct a `RemoteFileListing`
 * entry: the resource path/identity (`displayname`, carried alongside each
 * `<D:href>`), the last-modified time (`getlastmodified`), and the size
 * (`getcontentlength`).
 */
describe("buildPropfindBody", () => {
  it("produces well-formed XML (no parser error)", () => {
    const body = buildPropfindBody();
    const doc = new DOMParser().parseFromString(body, "application/xml");

    // A jsdom/browser DOMParser reports XML well-formedness errors by
    // inserting a <parsererror> element rather than throwing.
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
  });

  it("is a PROPFIND request rooted at <D:propfind> in the DAV: namespace", () => {
    const body = buildPropfindBody();
    const doc = new DOMParser().parseFromString(body, "application/xml");

    expect(doc.documentElement.localName).toBe("propfind");
    expect(doc.documentElement.namespaceURI).toBe("DAV:");
  });

  it("requests the resource path/identity (displayname) property", () => {
    const body = buildPropfindBody();
    const doc = new DOMParser().parseFromString(body, "application/xml");

    const props = doc.getElementsByTagNameNS("DAV:", "displayname");
    expect(props.length).toBe(1);
  });

  it("requests the last-modified time (getlastmodified) property", () => {
    const body = buildPropfindBody();
    const doc = new DOMParser().parseFromString(body, "application/xml");

    const props = doc.getElementsByTagNameNS("DAV:", "getlastmodified");
    expect(props.length).toBe(1);
  });

  it("requests the size (getcontentlength) property", () => {
    const body = buildPropfindBody();
    const doc = new DOMParser().parseFromString(body, "application/xml");

    const props = doc.getElementsByTagNameNS("DAV:", "getcontentlength");
    expect(props.length).toBe(1);
  });

  it("nests the requested properties inside a <D:prop> element", () => {
    const body = buildPropfindBody();
    const doc = new DOMParser().parseFromString(body, "application/xml");

    const prop = doc.getElementsByTagNameNS("DAV:", "prop");
    expect(prop.length).toBe(1);

    for (const name of ["displayname", "getlastmodified", "getcontentlength"]) {
      const el = doc.getElementsByTagNameNS("DAV:", name)[0];
      expect(el?.parentNode).toBe(prop[0]);
    }
  });
});
