/**
 * Folder browser modal (Obsidian `Modal`, view-only).
 *
 * A thin Obsidian `Modal` that lets the user browse the WebDAV server's folder
 * tree, navigate into child folders and back to a parent, create a new child
 * folder, and select the folder currently being browsed as the
 * Remote_Vault_Location. It owns *only* DOM rendering and event wiring: every
 * decision (which path to list, sort order, name validation, duplicate
 * detection, the single-flight/create guards, and error-message classification)
 * is delegated to a {@link FolderBrowserController}, which is driven through an
 * injected {@link FolderBrowserClient} (production: `WebDAVClient`).
 *
 * The modal re-renders its DOM from `controller.state` after every awaited
 * controller call, so the loading indication (Req 2.6), the sorted child
 * folders with an empty-state indication (Req 2.2, 2.3), the current
 * Folder_Path (Req 2.10), the parent-navigation control when a parent exists
 * (Req 2.5), and any error message (Req 1.7, 2.7–2.9, 4.7, 4.8) always reflect
 * the controller's latest state. On open it lists the server endpoint root
 * (`""`, Req 1.5); on "Use this folder" it validates the path with
 * {@link validateFolderPath} and persists it with
 * {@link CredentialStore.saveVaultLocation} (Req 3.2), then hands the saved
 * path back to the settings tab so it can re-render the stored location with a
 * confirmation notice (Req 3.3).
 *
 * Only mobile-compatible Obsidian APIs are used (`Modal`, `Setting`, `Notice`).
 *
 * _Requirements: 1.5, 1.6, 2.3, 2.10, 3.1, 3.2, 3.3, 4.1_
 */

import { type App, Modal, Notice, Setting } from "obsidian";

import { validateFolderPath } from "../core";
import type { CredentialStore } from "../persistence/credentialStore";
import {
  FolderBrowserController,
  type FolderBrowserClient,
} from "./folderBrowserController";

/** Heading shown at the top of the folder browser. */
export const FOLDER_BROWSER_TITLE = "Choose remote folder";

/** Label of the control that lists the parent folder (Req 2.5). */
export const PARENT_FOLDER_LABEL = "Parent folder";

/** Indication shown when the browsed folder has no child folders (Req 2.3). */
export const EMPTY_LISTING_MESSAGE = "This folder contains no subfolders.";

/** Indication shown while a listing request is in flight (Req 2.6). */
export const LOADING_MESSAGE = "Loading…";

/** Label of the control that selects the browsed folder (Req 3.1). */
export const USE_THIS_FOLDER_LABEL = "Use this folder";

/** Label of the control that closes the browser without selecting (Req 3.1). */
export const CANCEL_LABEL = "Cancel";

/** Label of the control that creates a new child folder (Req 4.1). */
export const CREATE_FOLDER_LABEL = "Create folder";

/** Error notice shown when persisting the selected location fails (Req 3.4). */
export const SAVE_VAULT_LOCATION_FAILED_MESSAGE =
  "Could not save the remote folder. The previous selection is unchanged.";

/**
 * How the modal renders the Folder_Path of the folder currently being browsed
 * (Req 2.10). The server endpoint root (`""`) is shown as a friendly label
 * rather than an empty string.
 */
export function describeCurrentPath(path: string): string {
  return path === "" ? "/ (server root)" : path;
}

/**
 * An Obsidian `Modal` that browses the remote folder tree and selects the
 * Remote_Vault_Location.
 *
 * All behavior is delegated to {@link FolderBrowserController}; this class only
 * renders the controller's state and wires DOM events back to it.
 */
export class FolderBrowserModal extends Modal {
  private readonly controller: FolderBrowserController;
  private readonly store: CredentialStore;

  /**
   * Called with the normalized, persisted Folder_Path once the user selects a
   * folder and it has been saved. The settings tab uses it to re-render the
   * stored location and show the confirmation notice (Req 3.3).
   */
  private readonly onSelected: (path: string) => void;

  /** The current value of the "new folder name" input, tracked via onChange. */
  private newFolderName = "";

  /**
   * @param app the Obsidian app (supplied by the settings tab).
   * @param client the listing/creation backend (production: `WebDAVClient`).
   * @param store the credential store used to persist the selected location.
   * @param onSelected invoked with the saved Folder_Path after a successful
   *   selection so the settings tab can refresh and confirm (Req 3.3).
   */
  constructor(
    app: App,
    client: FolderBrowserClient,
    store: CredentialStore,
    onSelected: (path: string) => void,
  ) {
    super(app);
    this.controller = new FolderBrowserController(client);
    this.store = store;
    this.onSelected = onSelected;
  }

  /**
   * On open, list the server endpoint root (`""`, Req 1.5) and render the
   * result. The listing is started before the first render so the loading
   * indication is shown while it is in flight (Req 2.6).
   */
  onOpen(): void {
    void this.runListing(this.controller.navigate(""));
  }

  /** Clear the rendered DOM when the modal closes. */
  onClose(): void {
    this.contentEl.empty();
  }

  /**
   * Render the loading state, await a listing/creation call, then re-render the
   * settled state. Because the controller flips its `loading`/`creating` guard
   * synchronously before awaiting, the first render reflects the in-flight
   * indication and the second reflects the result (Req 2.6, 4.9).
   */
  private async runListing(action: Promise<void>): Promise<void> {
    this.render();
    await action;
    this.render();
  }

  /**
   * Redraw the whole modal body from the controller's current state. Pure view
   * logic — it reads {@link FolderBrowserController.state} and wires events back
   * to the controller; it makes no decisions of its own.
   *
   * Child folders (and the parent-navigation entry) are rendered as single
   * clickable rows — a folder icon, the name, and a chevron — so navigation is
   * one tap on the row rather than a separate "open" button per folder.
   */
  private render(): void {
    const state = this.controller.state;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.classList.add("wd-folder-browser");

    contentEl.createEl("h2", { text: FOLDER_BROWSER_TITLE });

    // Current Folder_Path of the folder being browsed (Req 2.10).
    contentEl.createEl("div", {
      cls: "wd-fb-breadcrumb",
      text: describeCurrentPath(state.currentPath),
    });

    // Last error message, if any (Req 1.7, 2.7–2.9, 4.7, 4.8).
    if (state.error !== null) {
      contentEl.createEl("div", { cls: "wd-fb-error", text: state.error });
    }

    // Loading indication while a listing request is in flight (Req 2.6).
    if (state.loading) {
      contentEl.createEl("div", { cls: "wd-fb-loading", text: LOADING_MESSAGE });
    }

    const list = contentEl.createEl("div", { cls: "wd-fb-list" });

    // Parent-navigation row, only when a parent exists (Req 2.5).
    if (state.currentPath !== "") {
      this.renderRow(list, {
        icon: "↑",
        label: PARENT_FOLDER_LABEL,
        cls: "wd-fb-row wd-fb-row-parent",
        disabled: state.loading,
        onClick: () => {
          void this.runListing(this.controller.navigateToParent());
        },
      });
    }

    // Child folders (already sorted by the controller, Req 2.2), or an
    // empty-state indication when there are none (Req 2.3).
    if (state.folders.length === 0) {
      if (!state.loading) {
        list.createEl("div", { cls: "wd-fb-empty", text: EMPTY_LISTING_MESSAGE });
      }
    } else {
      for (const folder of state.folders) {
        this.renderRow(list, {
          icon: "📁",
          label: folder.name,
          chevron: true,
          cls: "wd-fb-row wd-fb-row-folder",
          disabled: state.loading,
          onClick: () => {
            void this.runListing(this.controller.navigate(folder.path));
          },
        });
      }
    }

    // New-folder input + create control (Req 4.1). The create control is
    // disabled while a create is in flight (Req 4.9).
    this.newFolderName = "";
    new Setting(contentEl)
      .setName("New folder")
      .addText((text) => {
        text.setPlaceholder("New folder name");
        text.onChange((value) => {
          this.newFolderName = value;
        });
      })
      .addButton((button) => {
        button.setButtonText(CREATE_FOLDER_LABEL);
        button.setDisabled(state.creating || state.loading);
        button.onClick(() => {
          void this.runListing(this.controller.createFolder(this.newFolderName));
        });
      });

    // Action row: select the folder currently being browsed as the
    // Remote_Vault_Location (Req 3.1), or cancel without selecting.
    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(CANCEL_LABEL);
        button.onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText(USE_THIS_FOLDER_LABEL);
        button.setCta();
        button.onClick(() => {
          void this.handleUseThisFolder();
        });
      });
  }

  /**
   * Render a single clickable navigation row (a folder icon, a label, and an
   * optional trailing chevron). The whole row is the click target; while a
   * listing is in flight the row is marked disabled and does not navigate
   * (the controller's single-flight guard would no-op anyway, Req 2.6).
   */
  private renderRow(
    parent: HTMLElement,
    opts: {
      icon: string;
      label: string;
      cls: string;
      disabled: boolean;
      chevron?: boolean;
      onClick: () => void;
    },
  ): void {
    const row = parent.createEl("div", { cls: opts.cls });
    row.createEl("span", { cls: "wd-fb-icon", text: opts.icon });
    row.createEl("span", { cls: "wd-fb-name", text: opts.label });
    if (opts.chevron === true) {
      row.createEl("span", { cls: "wd-fb-chevron", text: "›" });
    }
    if (opts.disabled) {
      row.classList.add("wd-fb-row-disabled");
      return;
    }
    row.addEventListener("click", opts.onClick);
  }

  /**
   * Persist the folder currently being browsed as the Remote_Vault_Location.
   *
   * Validates the path with {@link validateFolderPath} (Req 5.7); on rejection
   * a notice is shown and nothing is persisted. On success the normalized path
   * is saved through the credential store (Req 3.2); a store failure surfaces an
   * error notice and leaves the previously stored location unchanged (Req 3.4).
   * After a successful save the modal hands the saved path back to the settings
   * tab (so it can re-render and confirm, Req 3.3) and closes.
   */
  private async handleUseThisFolder(): Promise<void> {
    const validation = validateFolderPath(this.controller.state.currentPath);
    if (!validation.valid) {
      new Notice(validation.message);
      return;
    }

    try {
      await this.store.saveVaultLocation(validation.normalized);
    } catch {
      new Notice(SAVE_VAULT_LOCATION_FAILED_MESSAGE);
      return;
    }

    this.onSelected(validation.normalized);
    this.close();
  }
}
