# Requirements Document

## Introduction

This feature is an Obsidian community plugin that synchronizes an Obsidian vault with a Synology NAS WebDAV server. It provides a free, self-hosted alternative to paid sync services for users who work across desktop (macOS) and mobile (iOS) devices. The plugin collects WebDAV connection details from the user, validates connectivity against Synology-specific WebDAV behavior, and keeps the vault and the remote server consistent by fetching remote changes when the application opens and pushing local changes when files are created or modified.

The plugin must run on every platform Obsidian supports, including mobile, which requires using only mobile-compatible APIs and declaring the plugin as not desktop-only.

## Glossary

- **Plugin**: The Obsidian community plugin defined by this specification.
- **Vault**: The local collection of files and folders managed by Obsidian on a single device.
- **Vault_File**: Any single file within the Vault, including notes, attachments, and configuration files.
- **WebDAV_Server**: The remote Synology NAS endpoint that speaks the WebDAV protocol, identified by a server endpoint URL.
- **Connection_Settings**: The set of user-provided values consisting of server endpoint URL, username, and password.
- **Credential_Store**: The mechanism the Plugin uses to persist Connection_Settings between Obsidian sessions.
- **Sync_Engine**: The component of the Plugin responsible for transferring files between the Vault and the WebDAV_Server.
- **Settings_UI**: The Plugin configuration screen presented within Obsidian settings.
- **Connection_Test**: A user-initiated operation that verifies the Plugin can reach and authenticate with the WebDAV_Server.
- **WebDAV_Response_Parser**: The component that converts WebDAV XML multistatus responses into structured remote file listings.
- **WebDAV_Request_Builder**: The component that constructs WebDAV XML request bodies, such as PROPFIND requests.
- **Remote_File_Listing**: A structured representation of the files and folders present on the WebDAV_Server.
- **Sync_Conflict**: A condition where a Vault_File and its remote counterpart have both changed since the last successful synchronization.
- **Mobile_Platform**: An Obsidian installation running on iOS.
- **Desktop_Platform**: An Obsidian installation running on macOS.

## Requirements

### Requirement 1: Cross-Platform Installation

**User Story:** As an Obsidian user with a MacBook and an iPhone, I want the Plugin to install and run on both devices, so that I can sync my notes everywhere I work.

#### Acceptance Criteria

1. THE Plugin SHALL declare a manifest value of `isDesktopOnly` equal to false.
2. WHERE the Plugin runs on a Mobile_Platform, THE Plugin SHALL invoke only APIs that are available on the Mobile_Platform and SHALL NOT invoke any API that is exclusive to the Desktop_Platform.
3. WHEN the Plugin is loaded on a Desktop_Platform, THE Plugin SHALL complete initialization within 5 seconds and register its commands and settings interface without raising a load error.
4. WHEN the Plugin is loaded on a Mobile_Platform, THE Plugin SHALL complete initialization within 5 seconds and register its commands and settings interface without raising a load error.
5. IF initialization does not complete within 5 seconds on a Desktop_Platform or a Mobile_Platform, THEN THE Plugin SHALL abort the initialization, display a user-visible message indicating that the Plugin failed to load, and leave the user's existing notes and settings unchanged.

### Requirement 2: Configure Connection Settings

**User Story:** As a user, I want to enter my Synology WebDAV server address and credentials, so that the Plugin can connect to my server.

#### Acceptance Criteria

1. THE Settings_UI SHALL provide an input field for the server endpoint URL that accepts 1 to 2048 characters.
2. THE Settings_UI SHALL provide an input field for the username that accepts 1 to 255 characters.
3. THE Settings_UI SHALL provide an input field for the password that accepts 1 to 255 characters and masks the entered characters from display.
4. WHEN the user saves valid Connection_Settings, THE Plugin SHALL persist the Connection_Settings in the Credential_Store.
5. WHEN the user saves valid Connection_Settings, THE Plugin SHALL display a confirmation message indicating the Connection_Settings were saved.
6. WHEN the Plugin starts and Connection_Settings exist in the Credential_Store, THE Plugin SHALL load the stored Connection_Settings into the Settings_UI input fields within 2 seconds.
7. IF the user saves a server endpoint URL that does not begin with the scheme "http://" or "https://", or that lacks a host component, or that exceeds 2048 characters, THEN THE Plugin SHALL display a validation message identifying the server endpoint URL field as invalid and SHALL reject the save without modifying the stored Connection_Settings.
8. IF the user saves Connection_Settings with a username or password that is empty or that exceeds 255 characters, THEN THE Plugin SHALL display a validation message identifying the empty or out-of-range field and SHALL reject the save without modifying the stored Connection_Settings.

### Requirement 3: Test Connection

**User Story:** As a user, I want to test my connection before relying on the Plugin, so that I can confirm my settings work with my Synology server.

#### Acceptance Criteria

1. THE Settings_UI SHALL provide a control that initiates a Connection_Test.
2. WHEN the user initiates a Connection_Test with Connection_Settings whose required fields (server address, username, and password) are all populated and that authenticate successfully against the WebDAV_Server, THE Plugin SHALL display a success result within 30 seconds of initiation.
3. IF a Connection_Test fails because authentication is rejected by the WebDAV_Server, THEN THE Plugin SHALL display a result identifying an authentication failure, and THE Plugin SHALL retain the existing Connection_Settings unchanged.
4. IF a Connection_Test fails because the WebDAV_Server is unreachable, THEN THE Plugin SHALL display a result identifying a connectivity failure, and THE Plugin SHALL retain the existing Connection_Settings unchanged.
5. IF a Connection_Test does not receive a response from the WebDAV_Server within 30 seconds of initiation, THEN THE Plugin SHALL terminate the Connection_Test and display a timeout result.
6. WHEN the Plugin displays a Connection_Test result, THE Plugin SHALL display exactly one result type (success, authentication failure, connectivity failure, timeout, or missing-settings failure) for that Connection_Test.
7. IF the user initiates a Connection_Test while one or more required Connection_Settings fields (server address, username, or password) are empty, THEN THE Plugin SHALL display a result identifying a missing or invalid settings failure without contacting the WebDAV_Server.
8. WHILE a Connection_Test is in progress, THE Settings_UI SHALL indicate that the Connection_Test is running and SHALL prevent initiation of a second concurrent Connection_Test.

### Requirement 4: Synology WebDAV Compatibility

**User Story:** As a Synology NAS owner, I want the Plugin to work with my server's WebDAV implementation, so that I can sync where other plugins fail to connect.

#### Acceptance Criteria

1. WHEN the Plugin sends a request to the WebDAV_Server, THE Plugin SHALL include an Authorization header using HTTP Basic authentication derived from the stored Connection_Settings.
2. WHEN the Plugin requests a directory listing, THE Plugin SHALL send a PROPFIND request with a Depth header value of 1.
3. WHEN the WebDAV_Server returns a redirect response, THE Plugin SHALL follow the redirect to the indicated location up to a maximum of 5 consecutive redirects.
4. IF the Plugin reaches the maximum of 5 consecutive redirects without receiving a final response, THEN THE Plugin SHALL abort the request and present an error message indicating the redirect limit was exceeded, without altering local files.
5. WHERE the server endpoint URL omits a trailing path separator, THE Plugin SHALL construct request URLs that resolve correctly against the WebDAV_Server.
6. WHEN the Plugin issues a request from a Mobile_Platform, THE Plugin SHALL use an HTTP transport that bypasses browser cross-origin restrictions.
7. WHEN the Plugin sends a request to the WebDAV_Server, THE Plugin SHALL apply a request timeout of 30 seconds.
8. IF a request to the WebDAV_Server does not complete within the 30 second timeout, THEN THE Plugin SHALL abort the request and present an error message indicating the connection timed out, without altering local files.
9. IF the WebDAV_Server rejects a request because the credentials in the Connection_Settings are invalid, THEN THE Plugin SHALL present an error message indicating authentication failed and SHALL NOT proceed with the sync operation.

### Requirement 5: Parse WebDAV Responses

**User Story:** As a user, I want the Plugin to correctly interpret my server's responses, so that remote files are recognized accurately.

#### Acceptance Criteria

1. WHEN the WebDAV_Server returns a well-formed multistatus response, THE WebDAV_Response_Parser SHALL produce a Remote_File_Listing containing one entry for each resource whose per-resource status indicates success, where each entry includes the resource path, last modified time, and size.
2. WHEN the WebDAV_Response_Parser extracts an entry, THE WebDAV_Response_Parser SHALL represent the last modified time as a UTC timestamp and the size as an integer count of bytes in the range 0 to 9,223,372,036,854,775,807.
3. WHEN the WebDAV_Request_Builder constructs a PROPFIND request, THE WebDAV_Request_Builder SHALL produce a request body that is well-formed XML and that requests the resource path, last modified time, and size properties.
4. IF the WebDAV_Server returns a response body that is not well-formed XML, THEN THE WebDAV_Response_Parser SHALL return a parse error indicating that the response could not be parsed as XML and SHALL NOT produce a Remote_File_Listing.
5. IF a multistatus entry is missing the path, last modified time, or size, or its per-resource status indicates failure, THEN THE WebDAV_Response_Parser SHALL exclude that entry from the Remote_File_Listing.
6. WHEN the WebDAV_Server returns a well-formed multistatus response containing zero successful resource entries, THE WebDAV_Response_Parser SHALL produce an empty Remote_File_Listing.
7. FOR ALL Remote_File_Listing values, building a PROPFIND request from a listing and parsing an equivalent server response SHALL preserve each entry's path, last modified time, and size (round-trip property).

### Requirement 6: Full Vault Synchronization

**User Story:** As a user, I want to sync my entire vault to the server, so that all my notes and attachments are backed up remotely.

#### Acceptance Criteria

1. WHEN the user initiates a full synchronization, THE Sync_Engine SHALL upload every Vault_File that is absent from the WebDAV_Server or whose last-modified timestamp is more recent than its remote counterpart's last-modified timestamp.
2. WHEN the user initiates a full synchronization, THE Sync_Engine SHALL download every remote file that is absent from the Vault or whose last-modified timestamp is more recent than its local Vault_File counterpart's last-modified timestamp.
3. WHEN a Vault_File and its remote counterpart on the WebDAV_Server have last-modified timestamps that differ by 2 seconds or less, THE Sync_Engine SHALL treat the two files as synchronized and SHALL NOT transfer either file.
4. WHEN a full synchronization completes, THE Sync_Engine SHALL report the count of files uploaded, the count of files downloaded, and the count of files that failed to transfer.
5. IF a single Vault_File transfer fails during a full synchronization, THEN THE Sync_Engine SHALL retry that transfer up to 3 additional attempts before classifying the Vault_File as failed.
6. IF a Vault_File transfer remains failed after all retry attempts, THEN THE Sync_Engine SHALL continue transferring the remaining files and SHALL report the failed Vault_File with an error indication describing the cause of the failure.
7. WHEN the Sync_Engine uploads a Vault_File whose parent directory does not exist on the WebDAV_Server, THE Sync_Engine SHALL create the required remote directories before uploading the Vault_File.

### Requirement 7: Fetch Remote Changes on Application Open

**User Story:** As a user, I want my device to pull the latest notes when I open Obsidian, so that I start with up-to-date content.

#### Acceptance Criteria

1. WHEN the Plugin finishes loading and valid Connection_Settings exist, THE Sync_Engine SHALL retrieve a Remote_File_Listing from the WebDAV_Server within 30 seconds.
2. WHEN a remote file has a later last modified time than its local counterpart, THE Sync_Engine SHALL download the remote file into the Vault.
3. WHEN a remote file is absent from the Vault, THE Sync_Engine SHALL download the remote file into the Vault.
4. WHEN a remote file has the same last modified time as its local counterpart, THE Sync_Engine SHALL leave the local Vault_File unchanged.
5. IF the retrieval of the Remote_File_Listing does not complete within 30 seconds or fails before any file is downloaded, THEN THE Plugin SHALL display a notification identifying the failure and SHALL leave the Vault unchanged.
6. IF the fetch on application open fails after one or more files have been downloaded, THEN THE Plugin SHALL retain the downloaded files and SHALL display a notification identifying the partial failure.
7. IF the Plugin finishes loading and no valid Connection_Settings exist, THEN THE Sync_Engine SHALL skip the fetch on application open and SHALL leave the Vault unchanged.

### Requirement 8: Automatic Synchronization of Local Changes

**User Story:** As a user, I want my edits to upload automatically, so that I do not have to trigger sync manually after every change.

#### Acceptance Criteria

1. WHEN the user creates a Vault_File, THE Sync_Engine SHALL upload the created Vault_File to the WebDAV_Server within 5 seconds of detecting the change.
2. WHEN the user modifies a Vault_File, THE Sync_Engine SHALL upload the modified Vault_File to the WebDAV_Server within 5 seconds of detecting the change.
3. WHEN the user deletes a Vault_File, THE Sync_Engine SHALL delete the corresponding remote file on the WebDAV_Server within 5 seconds of detecting the change.
4. WHEN the user renames a Vault_File, THE Sync_Engine SHALL update the corresponding remote file path on the WebDAV_Server within 5 seconds of detecting the change.
5. IF an automatic upload, deletion, or path update fails because the WebDAV_Server is unreachable, THEN THE Sync_Engine SHALL add the change to a retry queue holding up to 1000 pending changes and SHALL retry each queued change at intervals of 30 seconds, up to 10 attempts, until the change succeeds.
6. IF a queued change has not succeeded after 10 retry attempts, THEN THE Sync_Engine SHALL retain the change in the retry queue and SHALL display an error notification indicating that synchronization of that Vault_File failed.
7. WHILE pending changes exist in the retry queue, THE Sync_Engine SHALL preserve the queued changes across application restarts.

### Requirement 9: Conflict Handling

**User Story:** As a user editing on two devices, I want the Plugin to handle conflicting changes safely, so that I do not silently lose edits.

#### Acceptance Criteria

1. WHEN the Sync_Engine detects a Sync_Conflict for a Vault_File, THE Sync_Engine SHALL preserve both the local version and the remote version without overwriting or discarding either version.
2. WHEN the Sync_Engine preserves a conflicting version, THE Sync_Engine SHALL store the preserved version under a conflict copy file name that includes the original Vault_File base name plus a unique identifier, while retaining the original Vault_File name unchanged.
3. IF the generated conflict copy file name matches an existing Vault_File name, THEN THE Sync_Engine SHALL append an additional unique identifier so that no existing Vault_File is overwritten.
4. WHEN a Sync_Conflict is resolved by preservation, THE Plugin SHALL display, within 5 seconds of preservation completing, a notification that identifies the affected Vault_File and indicates that a conflict copy was created.
5. IF the Sync_Engine cannot write the conflict copy, THEN THE Sync_Engine SHALL retain both the local version and the remote version without modification and THE Plugin SHALL display an error notification indicating that conflict copy creation failed for the affected Vault_File.

### Requirement 10: Synchronization Status and Errors

**User Story:** As a user, I want to see sync status and error details, so that I know whether my notes are safely synced.

#### Acceptance Criteria

1. WHILE a synchronization operation is in progress, THE Plugin SHALL display a status indicator showing the in-progress state, updated within 1 second of the operation starting.
2. WHEN a synchronization operation completes successfully, THE Plugin SHALL replace the in-progress indicator with a success status that includes the completion timestamp (date and time), within 1 second of completion.
3. IF a synchronization operation fails, THEN THE Plugin SHALL replace the in-progress indicator with an error status within 1 second of detecting the failure, and the error status SHALL include the failure timestamp and a description identifying the failure cause (for example, authentication failure, network unavailable, or remote server error).
4. WHEN a synchronization error occurs, THE Plugin SHALL record an entry in an error log that includes the failure timestamp and the failure description, retaining at least the 50 most recent entries.
5. WHEN the user opens the error log from the Settings_UI, THE Plugin SHALL display the recorded error entries ordered from most recent to oldest.
6. IF no synchronization operation has been performed since the Plugin was loaded, THEN THE Plugin SHALL display an idle status indicating that no synchronization has occurred.
