import esbuild from "esbuild";
import process from "process";

const banner = `/*
This is a generated bundle for the Synology WebDAV Sync plugin.
If you want to view the source, please visit the project repository.
*/`;

const production = process.argv[2] === "production";

// Modules provided by the Obsidian runtime / Electron / CodeMirror that must
// not be bundled. Note: Node built-ins are intentionally NOT listed here
// because this plugin must run on mobile and must never depend on them.
const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external,
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  banner: { js: banner },
  platform: "browser",
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
