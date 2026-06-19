/**
 * Test stub for the `obsidian` runtime module.
 *
 * The published `obsidian` npm package ships only type declarations; its real
 * implementation is injected by the Obsidian app at runtime and is therefore
 * unavailable under the test runner. The vitest config aliases `"obsidian"` to
 * this file so that modules importing from `"obsidian"` resolve during tests.
 *
 * Individual tests still override the pieces they need with `vi.mock("obsidian",
 * ...)`; this stub only needs to provide resolvable named exports.
 */

/**
 * Placeholder for Obsidian's `requestUrl`. Tests that exercise the transport
 * replace this via `vi.mock`, so the default here simply fails loudly if it is
 * ever called unmocked.
 */
export function requestUrl(): never {
  throw new Error(
    "obsidian.requestUrl was called without being mocked in a test",
  );
}

/**
 * Minimal DOM stubs for the settings tab.
 *
 * The real Obsidian app augments `HTMLElement` with helpers like `empty()` and
 * `createEl()` and ships UI primitives (`Setting`, `PluginSettingTab`,
 * `ButtonComponent`, `Notice`). These are unavailable under the test runner, so
 * the settings-tab unit tests (task 18.3) need lightweight implementations that
 * render real jsdom elements. The stubs below are intentionally small: enough
 * for {@link PluginSettingTab.display} to build the connection fields so a test
 * can query the rendered DOM (e.g. assert the password input is masked), but no
 * more. Existing exports (notably `requestUrl`) are left untouched.
 */

/** Augment a jsdom element with the Obsidian DOM helpers the settings tab uses. */
function augmentEl(el: HTMLElement): HTMLElement {
  const anyEl = el as unknown as Record<string, unknown>;
  if (typeof anyEl.empty !== "function") {
    anyEl.empty = function (this: HTMLElement): void {
      while (this.firstChild) this.removeChild(this.firstChild);
    };
  }
  if (typeof anyEl.createEl !== "function") {
    anyEl.createEl = function (
      this: HTMLElement,
      tag: string,
      opts?: { text?: string },
    ): HTMLElement {
      const child = document.createElement(tag);
      if (opts?.text !== undefined) child.textContent = opts.text;
      this.appendChild(child);
      return augmentEl(child);
    };
  }
  return el;
}

/** Stub for Obsidian's `App`; only used as a constructor argument. */
export class App {}

/**
 * Stub for Obsidian's `TFile`.
 *
 * The plugin entry point guards vault events with `file instanceof TFile`
 * (folder events are ignored), and the local-vault adapter reads `file.path`
 * and `file.stat`. This stub carries just those fields so tests can create file
 * instances that pass the `instanceof` guard and satisfy the adapter.
 */
export class TFile {
  path: string;
  stat: { mtime: number; size: number; ctime: number };
  constructor(
    path = "",
    stat: { mtime: number; size: number; ctime: number } = {
      mtime: 0,
      size: 0,
      ctime: 0,
    },
  ) {
    this.path = path;
    this.stat = stat;
  }
}

/**
 * Stub for Obsidian's `Plugin`.
 *
 * Originally this was an empty marker used only as a constructor argument by
 * the settings-tab tests (which still call `new Plugin()` with no arguments —
 * the optional parameters below keep that working). The lifecycle/wiring
 * integration test (task 19.4) constructs the real plugin against this base, so
 * the stub now provides the small slice of the `Plugin` API the entry point
 * uses: an `app` reference, in-memory `loadData`/`saveData`, a status-bar item
 * factory, and the `addSettingTab`/`addCommand`/`registerEvent`/
 * `registerInterval` registration hooks. Each registration is recorded so a
 * test can inspect or tear it down; none of this affects the existing settings
 * tests, which never touch these members.
 */
export class Plugin {
  /** The Obsidian `App` the plugin runs against (supplied by Obsidian). */
  app: unknown;
  /** The plugin manifest (supplied by Obsidian). */
  manifest: unknown;

  /** In-memory backing for `loadData`/`saveData`. */
  private _data: unknown = null;

  /** Event references handed to `registerEvent`, in registration order. */
  readonly _registeredEvents: unknown[] = [];
  /** Interval ids handed to `registerInterval`, in registration order. */
  readonly _registeredIntervals: number[] = [];
  /** Commands handed to `addCommand`, in registration order. */
  readonly _commands: unknown[] = [];
  /** Setting tabs handed to `addSettingTab`, in registration order. */
  readonly _settingTabs: unknown[] = [];

  constructor(app?: unknown, manifest?: unknown) {
    this.app = app;
    this.manifest = manifest;
  }

  async loadData(): Promise<unknown> {
    return this._data;
  }

  async saveData(data: unknown): Promise<void> {
    this._data = data;
  }

  addStatusBarItem(): { setText(text: string): void; setAttr(name: string, value: string): void } {
    return {
      setText(_text: string): void {},
      setAttr(_name: string, _value: string): void {},
    };
  }

  addSettingTab(tab: unknown): void {
    this._settingTabs.push(tab);
  }

  addCommand(command: unknown): unknown {
    this._commands.push(command);
    return command;
  }

  registerEvent(eventRef: unknown): void {
    this._registeredEvents.push(eventRef);
  }

  registerInterval(id: number): number {
    this._registeredIntervals.push(id);
    return id;
  }
}

/**
 * Records the messages passed to `new Notice(...)` so tests can assert which
 * confirmation/result message the settings tab surfaced.
 */
export class Notice {
  static messages: string[] = [];
  constructor(message: string) {
    Notice.messages.push(message);
  }
}

/** Stub text input control mirroring Obsidian's `TextComponent`. */
export class TextComponent {
  inputEl: HTMLInputElement;
  private changeCb: ((value: string) => void) | undefined;
  constructor(containerEl: HTMLElement) {
    this.inputEl = document.createElement("input");
    this.inputEl.addEventListener("input", () => {
      this.changeCb?.(this.inputEl.value);
    });
    containerEl.appendChild(this.inputEl);
  }
  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  onChange(cb: (value: string) => void): this {
    this.changeCb = cb;
    return this;
  }
}

/** Stub button control mirroring Obsidian's `ButtonComponent`. */
export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  disabled = false;
  constructor(containerEl: HTMLElement) {
    this.buttonEl = document.createElement("button");
    containerEl.appendChild(this.buttonEl);
  }
  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }
  setCta(): this {
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.buttonEl.disabled = disabled;
    return this;
  }
  onClick(cb: () => void): this {
    this.buttonEl.addEventListener("click", cb);
    return this;
  }
}

/** Stub for Obsidian's `Setting` row that renders its controls into the DOM. */
export class Setting {
  settingEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = augmentEl(document.createElement("div"));
    containerEl.appendChild(this.settingEl);
  }
  setName(_name: string): this {
    return this;
  }
  setDesc(_desc: string): this {
    return this;
  }
  addText(cb: (text: TextComponent) => void): this {
    cb(new TextComponent(this.settingEl));
    return this;
  }
  addButton(cb: (button: ButtonComponent) => void): this {
    cb(new ButtonComponent(this.settingEl));
    return this;
  }
}

/** Stub for Obsidian's `PluginSettingTab`, providing an augmented `containerEl`. */
export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement;
  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = augmentEl(document.createElement("div"));
  }
  display(): void {}
  hide(): void {}
}
