import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { joinUrl } from "./urlJoin";

/**
 * Property-based tests for {@link joinUrl} (design Property 4, Req 4.5).
 *
 * Generators model the full input space the property must hold over:
 *  - endpoints varying scheme (http/https), host, optional port, optional base
 *    path, and the presence or absence of a trailing slash;
 *  - vault-relative paths with multiple segments containing characters that
 *    require percent-encoding (spaces, `#`, `?`, non-ASCII, ...).
 */

const schemeArb = fc.constantFrom("http", "https");

// Simple DNS-like hostnames. Each label starts with a letter (so no label is
// all-numeric, which the WHATWG URL parser would treat as a malformed IPv4).
const labelArb = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc
      .string({ minLength: 0, maxLength: 7 })
      .map((s) => s.replace(/[^a-z0-9]/gi, "").toLowerCase())
  )
  .map(([first, rest]) => first + rest);

const hostArb = fc
  .array(labelArb, { minLength: 1, maxLength: 3 })
  .map((labels) => labels.join("."));

const portArb = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: null });

// Optional base path with one or more clean segments, e.g. "/dav" or "/a/b".
const basePathArb = fc.option(
  fc
    .array(
      fc
        .string({ minLength: 1, maxLength: 6 })
        .map((s) => s.replace(/[^a-z0-9]/gi, "").toLowerCase())
        .filter((s) => s.length > 0),
      { minLength: 1, maxLength: 3 }
    )
    .filter((segs) => segs.every((s) => s.length > 0))
    .map((segs) => "/" + segs.join("/")),
  { nil: "" }
);

interface EndpointParts {
  scheme: string;
  host: string;
  port: number | null;
  basePath: string;
  trailingSlash: boolean;
}

const endpointArb: fc.Arbitrary<EndpointParts> = fc.record({
  scheme: schemeArb,
  host: hostArb,
  port: portArb,
  basePath: basePathArb,
  trailingSlash: fc.boolean(),
});

function buildEndpoint(parts: EndpointParts): string {
  const authority = parts.port === null ? parts.host : `${parts.host}:${parts.port}`;
  const base = `${parts.scheme}://${authority}${parts.basePath}`;
  return parts.trailingSlash ? `${base}/` : base;
}

// Vault-relative path: multiple segments containing characters that need
// percent-encoding. Each segment is non-empty; segments are joined by "/".
const segmentArb = fc
  .string({ minLength: 1, maxLength: 12, unit: "grapheme" })
  .filter((s) => s.length > 0 && !s.includes("/"));

const vaultPathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 5 })
  .map((segs) => segs.join("/"));

describe("joinUrl (Property 4: URL join resolves correctly against the endpoint)", () => {
  // Feature: obsidian-synology-webdav-sync, Property 4: For any configured endpoint (with or without a trailing slash) and any vault-relative path, the joined request URL SHALL preserve the endpoint's scheme and host (origin), contain exactly one `/` separator between the endpoint base path and the resolved path (no missing and no doubled separators), and percent-encode each path segment of the vault-relative path.
  // Validates: Requirements 4.5
  it("preserves origin, uses a single separator, and percent-encodes each segment", () => {
    fc.assert(
      fc.property(endpointArb, vaultPathArb, (parts, vaultPath) => {
        const endpoint = buildEndpoint(parts);
        const result = joinUrl(endpoint, vaultPath);

        const endpointUrl = new URL(endpoint);
        const resultUrl = new URL(result);

        // (1) Origin (scheme + host + port) is preserved unchanged.
        expect(resultUrl.origin).toBe(endpointUrl.origin);
        expect(resultUrl.protocol).toBe(endpointUrl.protocol);
        expect(resultUrl.host).toBe(endpointUrl.host);

        // The endpoint base path with any trailing slash(es) stripped.
        const basePath = endpointUrl.pathname.replace(/\/+$/, "");

        // Expected per-segment encoding of the vault path.
        const expectedEncoded = vaultPath
          .split("/")
          .filter((s) => s.length > 0)
          .map((s) => encodeURIComponent(s))
          .join("/");

        // (2) Exactly one separator between base path and resolved path: the
        // full output path equals basePath + "/" + encodedPath, and there is
        // no doubled separator at the join boundary.
        const expectedPath = `${basePath}/${expectedEncoded}`;
        const resultPath = result.slice(resultUrl.origin.length);
        expect(resultPath).toBe(expectedPath);

        // No doubled separator introduced at the boundary between base and path.
        expect(resultPath.includes("//")).toBe(false);

        // (3) Each vault segment is individually percent-encoded and present
        // (separators between segments stay literal "/").
        for (const seg of vaultPath.split("/").filter((s) => s.length > 0)) {
          expect(resultPath).toContain(encodeURIComponent(seg));
        }
      }),
      { numRuns: 100 }
    );
  });
});
