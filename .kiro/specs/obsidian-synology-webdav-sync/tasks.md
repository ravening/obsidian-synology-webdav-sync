# Implementation Plan: Obsidian Synology WebDAV Sync

## Overview

This plan implements the plugin bottom-up: first the project scaffolding and shared types, then the pure, I/O-free cores (each verified with a fast-check property test), then the I/O layers exercised through a `FakeTransport`, and finally the Settings UI and plugin lifecycle that wire vault events and fetch-on-open together. Each task builds on the previous ones and ends integrated into the plugin entry point, so no orphaned code remains.

All code is TypeScript. Property-based tests use **fast-check** with a minimum of **100 iterations** (`numRuns: 100`) and each carries a comment in the format `Feature: obsidian-synology-webdav-sync, Property {number}: {property_text}`. Sub-tasks marked with `*` are optional test tasks and can be skipped for a faster MVP.

## Tasks

- [x] 1. Scaffold the Obsidian plugin project and build/test tooling
  - [x] 1.1 Create project skeleton and build configuration
    - Add `package.json` with `obsidian` (devDependency), `esbuild`, `typescript`, and `fast-check`
    - Create `manifest.json` with `isDesktopOnly` set to `false`, plus id/name/version/minAppVersion
    - Add `tsconfig.json` (strict mode) and an `esbuild` config producing `main.js`, plus a `styles.css` placeholder
    - Create the `src/` directory layout described in the design (core/, transport, client, engine, ui)
    - _Requirements: 1.1, 1.3, 1.4_
  - [x] 1.2 Configure the test runner and fast-check
    - Add Vitest (or Jest) configured for single-run (no watch) execution
    - Wire `fast-check` and a fake-timer setup for timeout/retry-interval tests
    - Add an `npm test` script that runs tests once
    - _Requirements: 1.1_
  - [x] 1.3 Write smoke/static checks for platform compatibility
    - Assert `manifest.json` has `isDesktopOnly === false`
    - Static-check that no desktop-only modules (`fs`, `http`, `https`, `net`) are imported anywhere in `src/`
    - _Requirements: 1.1, 1.2, 4.6_

- [x] 2. Define shared data models
  - [x] 2.1 Implement core types and interfaces
    - Define `ConnectionSettings`, `FileMeta`, `RemoteFileListing`, `ChangeKind`, `PendingChange`, `ConnectionTestResult`, `ErrorLogEntry`, `SyncStatus`, `SyncAction`, `SyncReport`, `FailedTransfer`, `HttpRequest`, `HttpResponse`, `Transport`
    - _Requirements: 2.1, 2.2, 2.3, 5.2, 8.5_

- [x] 3. Implement the URL-join helper (pure)
  - [x] 3.1 Implement endpoint/path join with slash handling and per-segment encoding
    - Preserve scheme and host (origin); collapse to exactly one separator; percent-encode each path segment
    - _Requirements: 4.5_
  - [x] 3.2 Write property test for URL join
    - **Property 4: URL join resolves correctly against the endpoint**
    - **Validates: Requirements 4.5**

- [x] 4. Implement the Request Builder (pure)
  - [x] 4.1 Implement `buildPropfindBody`
    - Produce well-formed PROPFIND XML requesting path/href, `getlastmodified`, and `getcontentlength`
    - _Requirements: 5.3_
  - [x] 4.2 Write unit test for the PROPFIND body
    - Assert the body is well-formed XML and requests the three required properties
    - _Requirements: 5.3_

- [x] 5. Implement the Response Parser (pure)
  - [x] 5.1 Implement `parseMultistatus` and a `render` helper
    - Parse 207 Multistatus XML into `RemoteFileListing`; include only success-status entries with path/mtime/size; empty listing when none qualify; return `malformed-xml` on non-XML input; use `DOMParser`
    - Add a `render(listing)` helper that emits an equivalent well-formed multistatus document (used by the round-trip property)
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.6_
  - [x] 5.2 Write property test for parse round-trip
    - **Property 2: Multistatus parse round-trip preserves entries**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.7**
  - [x] 5.3 Write property test for parser filtering and malformed input
    - **Property 3: Parser excludes unsuccessful or incomplete entries and rejects malformed input**
    - **Validates: Requirements 5.4, 5.5, 5.6**

- [x] 6. Implement the sync decision function (pure)
  - [x] 6.1 Implement `decideAction(local, remote)`
    - Encode the 2000 ms inclusive equality window and the missing-on-one-side rules returning `upload`/`download`/`skip`
    - _Requirements: 6.1, 6.2, 6.3, 7.2, 7.3, 7.4_
  - [x] 6.2 Write property test for `decideAction`
    - **Property 1: Sync decision is correct across all file-pair states**
    - **Validates: Requirements 6.1, 6.2, 6.3, 7.2, 7.3, 7.4**

- [x] 7. Implement conflict-copy naming (pure)
  - [x] 7.1 Implement `conflictCopyName(originalPath, existingPaths)`
    - Embed the original base name plus a unique identifier; append further identifiers until the name is unique and differs from the original
    - _Requirements: 9.1, 9.2, 9.3_
  - [x] 7.2 Write property test for conflict naming
    - **Property 7: Conflict-copy names are unique and non-destructive**
    - **Validates: Requirements 9.1, 9.2, 9.3**

- [x] 8. Implement the Retry Queue (pure + persistence shape)
  - [x] 8.1 Implement bounded queue with scheduling and persist/load
    - Enforce capacity 1000 (`enqueue` returns false when full), cap attempts at 10 (keep exhausted entries flagged), advance `nextAttemptAt` by ≥30 s per failed attempt, expose `due(now)`, and serialize/deserialize for `persist`/`load`
    - _Requirements: 8.5, 8.6, 8.7_
  - [x] 8.2 Write property test for queue bounds and scheduling
    - **Property 8: Retry queue respects capacity, attempt, and scheduling bounds**
    - **Validates: Requirements 8.5, 8.6**
  - [x] 8.3 Write property test for queue persistence round-trip
    - **Property 9: Retry queue survives a persist/load round-trip**
    - **Validates: Requirements 8.7**

- [x] 9. Implement settings validation (pure)
  - [x] 9.1 Implement `validateSettings`
    - Reject endpoint without `http(s)://`, without host, or >2048 chars; reject empty or >255-char username/password; accept all-valid candidates
    - _Requirements: 2.7, 2.8_
  - [x] 9.2 Write property test for settings validation
    - **Property 10: Settings validation rejects invalid input without mutating the store**
    - **Validates: Requirements 2.7, 2.8**

- [x] 10. Implement the error log (pure + persistence shape)
  - [x] 10.1 Implement bounded, newest-first error log
    - Append entries with UTC timestamp and description; retain at least the 50 most recent; never discard a newer entry for an older one; return entries ordered newest-first
    - _Requirements: 10.4, 10.5_
  - [x] 10.2 Write property test for the error log
    - **Property 15: Error log is bounded and ordered newest-first**
    - **Validates: Requirements 10.4, 10.5**

- [x] 11. Checkpoint - Ensure all pure-core tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement the Transport and FakeTransport
  - [x] 12.1 Implement the production Transport over `requestUrl()`
    - Call `requestUrl({ throw: false })`, race against a 30 s timer, reject only on transport-level failure (unreachable/TLS/timeout), return status/headers/text/arrayBuffer
    - _Requirements: 4.6, 4.7, 4.8_
  - [x] 12.2 Implement `FakeTransport` test double
    - Record every `HttpRequest`; return scripted responses including redirect chains, 401s, malformed XML, and never-resolving promises for timeout tests
    - _Requirements: 4.6_
  - [x] 12.3 Write unit tests for the Transport timeout/rejection mapping
    - Never-resolving response yields a timeout after 30 s via fake clock; transport-level failure rejects
    - _Requirements: 4.7, 4.8_

- [x] 13. Implement the Credential Store
  - [x] 13.1 Implement save/load over the plugin data store
    - Persist and load `ConnectionSettings` via `saveData()`/`loadData()`
    - _Requirements: 2.4, 2.6_
  - [x] 13.2 Write property test for settings round-trip
    - **Property 11: Saved settings round-trip through the credential store**
    - **Validates: Requirements 2.4**

- [x] 14. Implement the WebDAV Client
  - [x] 14.1 Implement core client operations against the Transport
    - Add Basic auth to every request, send `Depth: 1` on PROPFIND, follow ≤5 redirects then abort with redirect-limit error, join URLs via the helper, map 401 to auth-failure and stop; implement `listDirectory`, `listTree`, `getFile`, `putFile`, `deleteFile`, `moveFile`, and `makeCollection` (recursive parents)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.9, 6.7_
  - [x] 14.2 Write property test for request invariants
    - **Property 5: Every request carries Basic auth and every PROPFIND uses Depth 1**
    - **Validates: Requirements 4.1, 4.2**
  - [x] 14.3 Write property test for redirect bounding
    - **Property 6: Redirect following is bounded at five**
    - **Validates: Requirements 4.3, 4.4**
  - [x] 14.4 Write unit tests for WebDAV operations
    - Timeout aborts with no vault write (Req 4.8); 401 mid-operation halts further requests (Req 4.9); MKCOL is issued for each missing parent before PUT on a deep path (Req 6.7)
    - _Requirements: 4.8, 4.9, 6.7_
  - [x] 14.5 Implement `testConnection`
    - Gate on missing required fields (return `missing-settings` without calling Transport); map outcomes to exactly one `ConnectionTestResult.kind` (success/auth-failure/connectivity-failure/timeout)
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [x] 14.6 Write property test for connection-test results
    - **Property 12: Connection test yields exactly one result and gates on missing settings**
    - **Validates: Requirements 3.6, 3.7**

- [x] 15. Implement the Sync Engine and Conflict Resolver
  - [x] 15.1 Implement `fullSync`
    - Compare via `decideAction`, upload/download accordingly, create remote parent dirs before upload, retry each transfer up to 3 extra attempts, continue past failures, and return a `SyncReport` (uploaded/downloaded/failed)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
  - [x] 15.2 Write property test for sync report accounting
    - **Property 13: Sync report accounts for every file and isolates failures**
    - **Validates: Requirements 6.4, 6.6**
  - [x] 15.3 Implement `fetchOnOpen`
    - Skip when settings are invalid/missing; retrieve listing within 30 s; download remote-newer and remote-only files; leave same-mtime files unchanged; notify on full failure (vault unchanged) and on partial failure (downloaded files retained)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - [x] 15.4 Write property test for the fetch-on-open settings gate
    - **Property 14: Fetch-on-open performs no work without valid settings**
    - **Validates: Requirements 7.7**
  - [x] 15.5 Implement `handleLocalChange` with retry-queue integration
    - Map create/modify→PUT, delete→DELETE, rename→MOVE within 5 s of detection; on connectivity failure enqueue to the retry queue, retry due changes every 30 s up to 10 attempts, surface an error when the queue is full or a change exhausts attempts
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_
  - [x] 15.6 Write unit tests for sync-engine flows
    - Per-file retry capped at 3 extra then failed (Req 6.5); fetch failure before any download leaves vault unchanged and notifies (Req 7.5); partial failure retains downloads and notifies (Req 7.6); each vault event issues PUT/PUT/DELETE/MOVE (Req 8.1–8.4)
    - _Requirements: 6.5, 7.5, 7.6, 8.1, 8.2, 8.3, 8.4_
  - [x] 15.7 Implement Conflict Resolver `resolve`
    - On conflict, preserve both versions: write the conflict copy under the generated name, keep the original unchanged, notify within 5 s; on write failure retain both versions and emit an error notice
    - _Requirements: 9.1, 9.4, 9.5_
  - [x] 15.8 Write unit tests for conflict resolution
    - Conflict-copy write failure retains both versions and emits an error notice
    - _Requirements: 9.5_

- [x] 16. Checkpoint - Ensure all client and engine tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Implement the Status Reporter
  - [x] 17.1 Implement status-bar item and error-log surface
    - Reflect idle/in-progress/success/error within the required latencies; success includes completion timestamp; error includes timestamp and cause; expose a newest-first error-log view backed by the error log
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - [x] 17.2 Write unit tests for status states
    - In-progress within 1 s of start; success status includes completion timestamp; error status includes timestamp and cause; idle when no sync has run
    - _Requirements: 10.1, 10.2, 10.3, 10.6_

- [x] 18. Implement the Settings UI
  - [x] 18.1 Implement the settings tab fields, validation, and save
    - Endpoint/username/masked-password inputs with the documented length limits; validate on save using `validateSettings`, persist via the credential store with a confirmation message, reject invalid input with a field-identifying message, and load stored settings into the fields on open
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
  - [x] 18.2 Implement the Test Connection control
    - Add a button that invokes `testConnection`, indicates the running state, disables itself while running to prevent a concurrent test, and displays exactly one result type
    - _Requirements: 3.1, 3.2, 3.6, 3.8_
  - [x] 18.3 Write unit tests for the Settings UI
    - Password field is masked; stored settings load into fields on open; Test Connection button disables while running
    - _Requirements: 2.3, 2.6, 3.8_

- [x] 19. Implement the plugin entry point and wiring
  - [x] 19.1 Implement `onload` lifecycle
    - Register the settings tab, commands, and status-bar item; load credential store, retry queue, and error log; complete within the 5 s budget and on failure abort with a "failed to load" message leaving notes/settings unchanged
    - _Requirements: 1.3, 1.4, 1.5, 2.6_
  - [x] 19.2 Wire vault events to the Sync Engine
    - Register create/modify/delete/rename listeners that call `handleLocalChange`; start the 30 s retry-queue timer and flush due changes
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 19.3 Wire fetch-on-open
    - After load with valid settings, trigger `fetchOnOpen` and route status/errors through the Status Reporter
    - _Requirements: 7.1, 7.7_
  - [x] 19.4 Write integration test for lifecycle and wiring
    - With `FakeTransport`, assert vault events propagate to WebDAV ops and fetch-on-open runs on load with valid settings and is skipped without them
    - _Requirements: 1.3, 7.1, 7.7, 8.1, 8.2, 8.3, 8.4_

- [x] 20. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP.
- Each property test maps to exactly one design correctness property, runs ≥100 fast-check iterations, and carries the required `Feature: obsidian-synology-webdav-sync, Property {number}: {property_text}` comment.
- I/O layers are tested through `FakeTransport`; no test requires a real network or device.
- Live-server and device behavior (manual connection test, macOS/iOS end-to-end, conflict and offline/retry scenarios) is covered by the design's manual procedures and is intentionally out of scope for automated coding tasks.
- Each task references the specific requirements clauses it implements for traceability.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3", "3.1", "4.1", "5.1", "6.1", "7.1", "8.1", "9.1", "10.1", "12.1", "12.2", "13.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "5.2", "5.3", "6.2", "7.2", "8.2", "8.3", "9.2", "10.2", "12.3", "13.2", "14.1", "15.7", "17.1", "18.1"] },
    { "id": 4, "tasks": ["14.2", "14.3", "14.4", "14.5", "15.8", "17.2"] },
    { "id": 5, "tasks": ["14.6", "15.1", "18.2"] },
    { "id": 6, "tasks": ["15.2", "15.3"] },
    { "id": 7, "tasks": ["15.4", "15.5", "18.3"] },
    { "id": 8, "tasks": ["15.6", "19.1"] },
    { "id": 9, "tasks": ["19.2"] },
    { "id": 10, "tasks": ["19.3"] },
    { "id": 11, "tasks": ["19.4"] }
  ]
}
```
