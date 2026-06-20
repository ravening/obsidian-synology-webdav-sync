# Requirements Document

## Introduction

This feature adds remote folder selection to the existing Obsidian Synology WebDAV Sync plugin. Today the plugin can collect connection details and verify connectivity, but it always treats the configured server endpoint as the storage location and gives the user no way to choose a specific folder on the WebDAV server for vault data.

This feature lets the user, after a successful connection, browse the folder structure on the WebDAV server, navigate into folders, and select one folder as the remote vault location where the plugin stores and syncs vault data. When the desired folder does not yet exist, the user can create a new folder on the server from within the same flow. The selected remote folder is persisted with the connection settings and becomes the base path the rest of the plugin (Sync Engine, fetch-on-open, automatic sync) uses for every remote operation.

The feature must run on every platform Obsidian supports, including mobile, using only mobile-compatible APIs, and must reuse the existing WebDAV client, transport, and settings infrastructure.

## Glossary

- **Plugin**: The Obsidian community plugin that synchronizes an Obsidian vault with a Synology NAS WebDAV server.
- **WebDAV_Server**: The remote Synology NAS endpoint that speaks the WebDAV protocol, identified by a server endpoint URL.
- **Connection_Settings**: The set of user-provided values consisting of server endpoint URL, username, and password.
- **WebDAV_Client**: The existing component that issues authenticated WebDAV requests (PROPFIND, MKCOL, and others) against the WebDAV_Server.
- **Settings_UI**: The Plugin configuration screen presented within Obsidian settings.
- **Folder_Browser**: The component of the Settings_UI that displays remote folders and lets the user navigate between them.
- **Remote_Folder**: A collection (directory) located on the WebDAV_Server, identified by a server-relative folder path.
- **Folder_Path**: A server-relative path, using forward-slash separators, that identifies a Remote_Folder relative to the server endpoint URL.
- **Remote_Folder_Listing**: A structured representation of the immediate child folders contained directly within a single Remote_Folder.
- **Remote_Vault_Location**: The single Remote_Folder, identified by its Folder_Path, that the Plugin uses as the base path for storing and synchronizing vault data.
- **Credential_Store**: The mechanism the Plugin uses to persist Connection_Settings and the Remote_Vault_Location between Obsidian sessions.
- **Connection_Test**: The existing user-initiated operation that verifies the Plugin can reach and authenticate with the WebDAV_Server.
- **Mobile_Platform**: An Obsidian installation running on iOS.
- **Desktop_Platform**: An Obsidian installation running on macOS.

## Requirements

### Requirement 1: Access Folder Browsing After a Successful Connection

**User Story:** As a user who has connected to my server, I want to open a folder browser, so that I can choose where my vault data is stored on the WebDAV server.

#### Acceptance Criteria

1. THE Settings_UI SHALL provide a control that opens the Folder_Browser.
2. WHILE no Connection_Test has succeeded for the current Connection_Settings, THE Settings_UI SHALL disable the control that opens the Folder_Browser.
3. WHEN a Connection_Test succeeds for the current Connection_Settings, THE Settings_UI SHALL enable the control that opens the Folder_Browser within 1 second of displaying the success result.
4. WHEN the user changes the server endpoint URL, the username, or the password after a successful Connection_Test, THE Settings_UI SHALL disable the control that opens the Folder_Browser until a Connection_Test succeeds for the changed Connection_Settings.
5. WHEN the user activates the control that opens the Folder_Browser, THE Folder_Browser SHALL request the Remote_Folder_Listing of the server endpoint root using the WebDAV_Client.
6. WHEN the WebDAV_Client returns the Remote_Folder_Listing of the requested location, THE Folder_Browser SHALL display each Remote_Folder contained in that location within 2 seconds of receiving the listing.
7. IF the WebDAV_Client does not return the Remote_Folder_Listing within 10 seconds of the request, OR returns an error, THEN THE Folder_Browser SHALL display an error message indicating that the folder listing could not be retrieved and SHALL retain the previously selected Folder_Path unchanged.

### Requirement 2: Browse Remote Folders

**User Story:** As a user, I want to see the folders on my server and move between them, so that I can find the folder I want to use.

#### Acceptance Criteria

1. WHEN the Folder_Browser requests a Remote_Folder_Listing for a Remote_Folder, THE WebDAV_Client SHALL retrieve the immediate child folders of that Remote_Folder within 30 seconds.
2. WHEN the Folder_Browser receives a Remote_Folder_Listing, THE Folder_Browser SHALL display each child Remote_Folder contained in the Remote_Folder_Listing in ascending, case-insensitive alphabetical order by Remote_Folder name.
3. WHEN the Folder_Browser displays a Remote_Folder_Listing that contains zero child folders, THE Folder_Browser SHALL display an indication that the current Remote_Folder contains no child folders.
4. WHEN the user selects a displayed child Remote_Folder to navigate into, THE Folder_Browser SHALL request the Remote_Folder_Listing of the selected child Remote_Folder using the WebDAV_Client.
5. WHERE the Remote_Folder currently being browsed has a parent Remote_Folder, THE Folder_Browser SHALL provide a control that navigates to the parent Remote_Folder.
6. WHILE a Remote_Folder_Listing request is in progress, THE Folder_Browser SHALL display a loading indication and SHALL prevent initiation of a second concurrent Remote_Folder_Listing request.
7. IF a Remote_Folder_Listing request does not complete within 30 seconds, THEN THE Folder_Browser SHALL terminate the request and display a message identifying a timeout failure, and SHALL leave the Remote_Folder currently being browsed unchanged.
8. IF a Remote_Folder_Listing request fails because the WebDAV_Server is unreachable or returns an error status, THEN THE Folder_Browser SHALL display a message identifying the failure cause and SHALL leave the Remote_Folder currently being browsed unchanged.
9. IF a Remote_Folder_Listing request fails because authentication is rejected by the WebDAV_Server, THEN THE Folder_Browser SHALL display a message identifying an authentication failure and SHALL leave the Remote_Folder currently being browsed unchanged.
10. WHEN the Folder_Browser receives a Remote_Folder_Listing, THE Folder_Browser SHALL display the Folder_Path of the Remote_Folder currently being browsed.

### Requirement 3: Select a Remote Folder as the Vault Location

**User Story:** As a user, I want to pick a folder as my remote vault location, so that the plugin stores my notes in the folder I choose.

#### Acceptance Criteria

1. WHILE a Remote_Folder is being browsed, THE Folder_Browser SHALL provide an enabled control that selects the Remote_Folder currently being browsed as the Remote_Vault_Location.
2. WHEN the user selects the Remote_Folder currently being browsed as the Remote_Vault_Location, THE Plugin SHALL persist the Folder_Path of the selected Remote_Folder as the Remote_Vault_Location in the Credential_Store within 2 seconds.
3. WHEN the Plugin successfully persists the Remote_Vault_Location, THE Settings_UI SHALL display the persisted Folder_Path of the Remote_Vault_Location and a confirmation message indicating the Remote_Vault_Location was saved within 2 seconds.
4. IF persisting the Remote_Vault_Location to the Credential_Store fails, THEN THE Plugin SHALL display an error indication and SHALL retain the previously persisted Remote_Vault_Location unchanged.
5. WHEN the Plugin starts and a Remote_Vault_Location exists in the Credential_Store, THE Settings_UI SHALL display the stored Folder_Path of the Remote_Vault_Location within 2 seconds.
6. WHEN the user persists a Remote_Vault_Location, THE Plugin SHALL use the persisted Folder_Path as the base path for subsequent remote operations performed against the WebDAV_Server.
7. IF the Plugin starts and no Remote_Vault_Location exists in the Credential_Store, THEN THE Settings_UI SHALL display an indication that no Remote_Vault_Location has been selected within 2 seconds.

### Requirement 4: Create a New Remote Folder

**User Story:** As a user, I want to create a new folder on the server when the one I want does not exist, so that I can store my vault in a fresh location without leaving the plugin.

#### Acceptance Criteria

1. THE Folder_Browser SHALL provide a control that creates a new child Remote_Folder within the Remote_Folder currently being browsed.
2. THE Folder_Browser SHALL provide an input field for the new folder name that accepts 1 to 255 characters.
3. WHEN the user submits a new folder name of 1 to 255 characters composed only of characters permitted in a Folder_Path, THE WebDAV_Client SHALL create, within the Remote_Folder currently being browsed, a new child Remote_Folder named exactly as submitted within 30 seconds.
4. WHEN the WebDAV_Client reports that the new child Remote_Folder was created successfully, THE Folder_Browser SHALL request the Remote_Folder_Listing of the Remote_Folder currently being browsed so that the created folder appears in the displayed listing.
5. IF the user submits a new folder name that is empty, that exceeds 255 characters, or that contains a forward slash or a backslash, THEN THE Folder_Browser SHALL display a validation message identifying the new folder name as invalid and SHALL NOT contact the WebDAV_Server.
6. IF the user submits a new folder name that matches the name of an existing child Remote_Folder within the Remote_Folder currently being browsed, THEN THE Folder_Browser SHALL display a message indicating that a folder with the submitted name already exists and SHALL NOT create a duplicate Remote_Folder.
7. IF folder creation fails because the WebDAV_Server is unreachable, returns an error status, or rejects authentication, THEN THE Folder_Browser SHALL display a message identifying the failure cause and SHALL leave the displayed Remote_Folder_Listing unchanged.
8. IF folder creation does not complete within 30 seconds, THEN THE Folder_Browser SHALL terminate the request, display a message identifying a timeout failure, and SHALL leave the displayed Remote_Folder_Listing unchanged.
9. WHILE a folder creation request is in progress, THE Folder_Browser SHALL disable the control that creates a new child Remote_Folder.

### Requirement 5: Persist and Validate the Remote Vault Location

**User Story:** As a user, I want my chosen folder to be remembered and used safely, so that my vault stays in the same place across sessions and devices.

#### Acceptance Criteria

1. THE Plugin SHALL store the Remote_Vault_Location as a Folder_Path of 0 to 2048 characters in the Credential_Store.
2. WHEN the Plugin persists a Folder_Path as the Remote_Vault_Location, THE Plugin SHALL normalize the Folder_Path by converting backslash separators to forward-slash separators, collapsing consecutive forward slashes into a single forward slash, and removing any trailing forward slash, except where the Folder_Path is the server endpoint root.
3. WHEN the WebDAV_Client constructs a request for a vault file, THE Plugin SHALL resolve the request path against the previously loaded Remote_Vault_Location Folder_Path so that the resolved path is a descendant of the Remote_Vault_Location.
4. IF the stored Remote_Vault_Location is changed to a different Folder_Path, THEN THE Plugin SHALL persist the new Folder_Path and SHALL use the new Folder_Path as the base path for subsequent remote operations.
5. WHERE the user has not selected a Remote_Vault_Location, THE Plugin SHALL treat the server endpoint root as the Remote_Vault_Location for subsequent remote operations.
6. WHEN the Plugin starts, THE Plugin SHALL load the stored Remote_Vault_Location Folder_Path from the Credential_Store as the previously loaded Remote_Vault_Location for subsequent remote operations.
7. IF a Folder_Path submitted for persistence exceeds 2048 characters or contains a parent-directory traversal segment (".."), THEN THE Plugin SHALL reject the Folder_Path, retain the previously persisted Remote_Vault_Location unchanged, and display an error indication.
8. IF resolving a request path against the Remote_Vault_Location would produce a resolved path that is not a descendant of the Remote_Vault_Location, THEN THE Plugin SHALL NOT issue the request and SHALL display an error indication.
