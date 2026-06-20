# Implementation Plan: Remote Folder Selection

## Overview

This plan extends the existing Obsidian Synology WebDAV Sync plugin with remote folder selection, built bottom-up so each step integrates into the previous ones with no orphaned code. First the shared types, then the pure, I/O-free `src/core` path/name/listing helpers (each verified with a fast-check property test), then the new client read path (`listFolders`) and credential-store persistence exercised through the existing fakes, then the DOM-free `FolderBrowserController`, then the Obsidian `Modal` and settings-tab control that wire it to the UI, and finally the engine integration that resolves every remote request path against the loaded Remote Vault Location.

All code is TypeScript and follows the existing conventions: co-located `*.test.ts` files, pure DOM-free helpers favored for testability, and mobile-compatible Obsidian APIs only (`Modal`, `Setting`, `requestUrl`). Property-based tests use **fast-check** with a minimum of **100 iterations** (`numRuns: 100`) and each carries a comment in the format `Feature: remote-folder-selection, Property {number}: {property_text}`. Sub-tasks marked with `*` are optional test tasks and can be skipped for a faster MVP.

## Tasks

- [x] 1. Define shared data models for remote folders
  - [x] 1.1 Add `RemoteFolder` and `RemoteFolderListing` types
    - Add `RemoteFolder` (`name`, server-relative normalized `path`) and `RemoteFolderListing` (`path`, `folders`) to `src/core/types.ts`
    - Export them from `src/core/index.ts` alongside the existing types
    - _Requirements: 1.6, 2.1_

- [x] 2. Implement the vault-path algebra (pure, I/O-free)
  - [x] 2.1 Implement `src/core/vaultPath.ts`
    - Implement `normalizeFolderPath` (convert `\`→`/`, collapse repeated `/`, strip leading/trailing `/`, root → `""`)
    - Implement `validateFolderPath` (reject normalized form >2048 chars or containing a `".."` segment; otherwise return `{ valid: true, normalized }`)
    - Implement `resolveVaultPath` (reject request paths containing `".."` before joining, join + normalize against base, confirm descendant containment; `base === ""` means server root)
    - Implement `isDescendant`, `parentOf`, and `joinSegment`; export `MAX_FOLDER_PATH_LENGTH`
    - Export the module from `src/core/index.ts`
    - _Requirements: 5.2, 5.1, 5.3, 5.5, 5.7, 5.8, 2.4, 2.5, 4.3_

  - [ ]* 2.2 Write property test for path normalization
    - **Property 1: Folder path normalization is canonical and idempotent**
    - **Validates: Requirements 5.2**

  - [ ]* 2.3 Write property test for persistence validation
    - **Property 3: Over-long or traversing paths are rejected for persistence**
    - **Validates: Requirements 5.1, 5.7**

  - [ ]* 2.4 Write property test for request-path resolution
    - **Property 2: Resolved request paths stay within the vault location**
    - **Validates: Requirements 3.6, 5.3, 5.5, 5.8**

  - [ ]* 2.5 Write property test for navigation inverse
    - **Property 4: Navigating into a child and back to the parent is an identity**
    - **Validates: Requirements 2.4, 2.5, 4.3**

- [x] 3. Implement folder-name validation (pure)
  - [x] 3.1 Implement `src/core/folderName.ts`
    - Implement `validateFolderName` (accept 1..255 characters with no `"/"` or `"\"`; reject empty/over-length/slash with a `reason`); export `MAX_FOLDER_NAME_LENGTH`
    - Export the module from `src/core/index.ts`
    - _Requirements: 4.2, 4.5_

  - [ ]* 3.2 Write property test for folder-name validation
    - **Property 7: New folder name validation enforces length and character rules**
    - **Validates: Requirements 4.2, 4.5**

- [x] 4. Implement the folder-listing parser and sort (pure)
  - [x] 4.1 Implement `src/core/folderListing.ts`
    - Implement `parseFolderListing(xml, requestPath)` using the namespace-agnostic `DOMParser` approach from `responseParser.ts`: keep only collection entries (`<collection/>` in resourcetype, or trailing-slash href), drop the directory's own self-entry, return name + normalized path per child; return `{ ok: false, error: "malformed-xml" }` on non-XML input
    - Implement `sortFolders` (ascending, case-insensitive, stable) and an inverse `renderFolderListing` helper (emits an equivalent well-formed 207 Multistatus document including the self-entry, for the round-trip test), mirroring `responseParser.render`
    - Export the module from `src/core/index.ts`
    - _Requirements: 1.6, 2.1, 2.2_

  - [ ]* 4.2 Write property test for listing parse round-trip
    - **Property 5: Folder listing parse round-trip**
    - **Validates: Requirements 1.6, 2.1**

  - [ ]* 4.3 Write property test for folder ordering
    - **Property 6: Folders are displayed in case-insensitive ascending order**
    - **Validates: Requirements 2.2**

- [x] 5. Checkpoint - Ensure all pure-core tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement `WebDAVClient.listFolders`
  - [x] 6.1 Add the `listFolders(remotePath)` method to `src/client/webdavClient.ts`
    - Issue the same authenticated `PROPFIND`/`Depth: 1` request as `listDirectory` (reusing the existing request path, 30s timeout, redirect handling, and 401→`AuthError` mapping), but route the body through `parseFolderListing` instead of `parseMultistatus`
    - Convert a `{ ok: false, error: "malformed-xml" }` parse result into a `WebDAVError("malformed-xml")`
    - _Requirements: 1.5, 2.1_

  - [ ]* 6.2 Write unit tests for `listFolders`
    - Using `FakeTransport`: child folders are returned and sorted; a 401 maps to `AuthError`; a malformed body throws `WebDAVError("malformed-xml")`; a never-resolving response times out at 30s
    - _Requirements: 2.1, 2.7, 2.8, 2.9_

- [x] 7. Implement Remote Vault Location persistence in the Credential Store
  - [x] 7.1 Add `saveVaultLocation` / `loadVaultLocation` to `src/persistence/credentialStore.ts`
    - Export `VAULT_LOCATION_KEY`; `saveVaultLocation` reads the data object, re-applies `normalizeFolderPath` defensively, updates only its own key, and writes the whole object back to preserve connection settings, retry queue, and error log; `loadVaultLocation` returns the stored path or `null`
    - _Requirements: 3.2, 5.1, 5.4, 5.6, 3.5, 3.7_

  - [ ]* 7.2 Write property test for vault-location persistence
    - **Property 9: Vault location persistence round-trips and is last-write-wins**
    - **Validates: Requirements 3.2, 5.4**

  - [ ]* 7.3 Write property test for failure invariance on persistence
    - **Property 10: A failed or rejected persistence leaves the stored location unchanged**
    - **Validates: Requirements 3.4, 5.7**

- [x] 8. Implement the `FolderBrowserController` (pure, DOM-free)
  - [x] 8.1 Implement `FolderBrowserController` and `FolderBrowserClient` interface
    - Create the controller in `src/ui/folderBrowserController.ts` holding `BrowserState` (`currentPath`, `folders`, `loading`, `error`, `creating`)
    - Implement `navigate(path)`, `navigateToParent()` (via `parentOf`), and `refresh()`: each is a no-op while `loading` is true (single-flight); on success replace folders with `sortFolders(listing.folders)`; on failure set a `kind`-classified error message and leave `currentPath`/`folders` unchanged
    - Implement `createFolder(name)`: `validateFolderName` → duplicate check against current `folders` (no server contact on invalid/duplicate) → `makeCollection(joinSegment(currentPath, name))` → `refresh()`; disable via `creating` guard while in flight
    - _Requirements: 1.7, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [ ]* 8.2 Write property test for duplicate-name creation guard
    - **Property 8: A duplicate name never triggers a server create**
    - **Validates: Requirements 4.6, 4.5**

  - [ ]* 8.3 Write property test for listing/creation failure invariance
    - **Property 11: A failed listing or creation leaves the browsed folder unchanged**
    - **Validates: Requirements 1.7, 2.7, 2.8, 2.9, 4.7, 4.8**

  - [ ]* 8.4 Write unit tests for navigation, single-flight, and error mapping
    - Navigating into a child calls `listFolders` with the child path; a second request while one is pending is a no-op (one call issued); representative `AuthError`/timeout/server-error map to the expected user messages
    - _Requirements: 2.4, 2.6, 2.7, 2.8, 2.9_

- [x] 9. Implement settings-tab gating and the "Choose remote folder" control
  - [x] 9.1 Add the gating helper and control to `src/ui/settingsTab.ts`
    - Implement the pure helper `isFolderBrowsingEnabled(verifiedSettings, draft)` (true iff a snapshot exists and the draft endpoint/username/password all equal it)
    - Extend `runConnectionTest` so success records `connectionVerified` and a snapshot of the tested settings; clear `connectionVerified` from the field `onChange` handlers when the live draft differs
    - Render a "Remote vault location" section showing the stored `Folder_Path` (or "No remote folder selected yet") and a "Choose remote folder" button enabled only when `isFolderBrowsingEnabled` is true
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.5, 3.7_

  - [ ]* 9.2 Write property test for the gating predicate
    - **Property 12: Folder browsing is enabled only for verified, unchanged settings**
    - **Validates: Requirements 1.2, 1.4**

  - [ ]* 9.3 Write unit tests for gating wiring and location display
    - The control exists and becomes enabled after a successful `runConnectionTest`; changing a field re-disables it; start-up shows the stored path or the "none selected" indication
    - _Requirements: 1.1, 1.3, 3.5, 3.7_

- [x] 10. Implement `FolderBrowserModal` and wire it to the settings tab
  - [x] 10.1 Implement `FolderBrowserModal` and open it from the settings tab
    - Create `src/ui/folderBrowserModal.ts` extending Obsidian `Modal`; it owns only DOM rendering/event wiring and delegates all decisions to `FolderBrowserController`
    - Render the current `Folder_Path`, the sorted child folders (with an empty-state indication), a loading indication, a parent-navigation control when a parent exists, a "New folder" input + create control, and a "Use this folder" select control
    - On open, inject the existing `clientFactory` and `CredentialStore`, list the server root (`""`); on "Use this folder" call `validateFolderPath` then `saveVaultLocation`, then have the tab re-render the stored path with a confirmation notice
    - _Requirements: 1.5, 1.6, 2.3, 2.10, 3.1, 3.2, 3.3, 4.1_

  - [ ]* 10.2 Write unit tests for the modal-driven flows
    - Opening calls `listFolders("")`; selecting persists the normalized path and shows confirmation; a valid create issues one `makeCollection(joinSegment(current, name))` then refreshes; the create control is disabled while a create is in flight
    - _Requirements: 1.5, 3.1, 3.3, 4.1, 4.4, 4.9_

- [x] 11. Wire the Remote Vault Location into the Sync Engine
  - [x] 11.1 Resolve every remote request path against the loaded base
    - On plugin load (`src/main.ts`), read the stored location via `loadVaultLocation` and supply it as the Sync Engine base (`""` when none stored)
    - Wrap the injected `SyncEngineClient` so every path argument is run through `resolveVaultPath(base, path)`; a containment failure throws before any request is issued and is routed through the existing error log / status reporter
    - _Requirements: 3.6, 5.3, 5.4, 5.5, 5.6, 5.8_

  - [ ]* 11.2 Write unit/integration tests for engine integration
    - A missing location resolves the base to `""` (server root); start-up loads the stored normalized location as the base; a request that would escape the base is refused and never reaches the transport (asserted via `FakeTransport`)
    - _Requirements: 5.5, 5.6, 5.8_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP.
- Each property test maps to exactly one design correctness property, runs ≥100 fast-check iterations, and carries the required `Feature: remote-folder-selection, Property {number}: {property_text}` comment.
- The new client read path and persistence are tested through the existing `FakeTransport`/in-memory data-store fakes; no test requires a real network or device.
- Behavior decisions live in pure, DOM-free helpers (`vaultPath`, `folderName`, `folderListing`, `FolderBrowserController`, `isFolderBrowsingEnabled`); the `Modal` only renders, mirroring the existing settings-tab helper pattern.
- UI-timing and live-device behavior (the 1s/2s display latencies, manual on-device browsing) are covered by the design's example tests and manual procedures and are intentionally out of scope for automated coding tasks.
- Each task references the specific requirements clauses it implements for traceability.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "7.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2", "4.2", "4.3", "6.1", "7.2", "7.3", "8.1", "9.1", "11.1"] },
    { "id": 3, "tasks": ["6.2", "8.2", "8.3", "8.4", "9.2", "9.3", "10.1", "11.2"] },
    { "id": 4, "tasks": ["10.2"] }
  ]
}
```
