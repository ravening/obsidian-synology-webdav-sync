import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Platform-compatibility smoke / static checks (Task 1.3).
 *
 * These guard the plugin's cross-platform promise:
 *  - `manifest.json` must declare `isDesktopOnly: false` so the plugin installs
 *    and runs on mobile as well as desktop (Req 1.1).
 *  - No source file under `src/` may import a desktop-only Node built-in
 *    (`fs`, `http`, `https`, `net`). On mobile these modules do not exist, so
 *    any reference would break the plugin there. All network and file access
 *    must instead flow through Obsidian's `requestUrl()` and `Vault` APIs
 *    (Req 1.2, 4.6).
 *
 * The import scan is a static text check: it parses each `.ts` file for
 * `import`/`require`/dynamic-`import()` statements and inspects the module
 * specifier, rather than executing any code.
 */

const repoRoot = resolve(__dirname, "..");
const srcDir = join(repoRoot, "src");

/** Node built-in modules that are unavailable on the mobile platform. */
const FORBIDDEN_MODULES = ["fs", "http", "https", "net"];

/** Recursively collect every TypeScript source file under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract the set of module specifiers imported by a source file, covering:
 *  - `import ... from "specifier"`
 *  - `import "specifier"`
 *  - `export ... from "specifier"`
 *  - `require("specifier")`
 *  - dynamic `import("specifier")`
 */
function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns: RegExp[] = [
    /\bimport\s+(?:[^'"]*?\bfrom\s*)?["']([^"']+)["']/g,
    /\bexport\s+[^'"]*?\bfrom\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * Normalize a module specifier and decide whether it references a forbidden
 * desktop-only built-in. Matches both bare (`fs`) and `node:`-prefixed
 * (`node:fs`) forms, including submodule paths like `fs/promises`.
 */
function isForbiddenModule(specifier: string): string | null {
  const withoutPrefix = specifier.startsWith("node:")
    ? specifier.slice("node:".length)
    : specifier;
  const topLevel = withoutPrefix.split("/")[0];
  return FORBIDDEN_MODULES.includes(topLevel) ? topLevel : null;
}

describe("platform compatibility", () => {
  it("declares isDesktopOnly === false in manifest.json", () => {
    const manifestPath = join(repoRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      isDesktopOnly?: unknown;
    };
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it("does not import desktop-only Node built-ins anywhere in src/", () => {
    const files = collectTsFiles(srcDir);
    // Sanity check: the scan actually found source files to inspect.
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const specifier of extractImportSpecifiers(source)) {
        const forbidden = isForbiddenModule(specifier);
        if (forbidden) {
          const relative = file.slice(repoRoot.length + 1);
          violations.push(`${relative} imports "${specifier}" (${forbidden})`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it.each(FORBIDDEN_MODULES)(
    'detects a forbidden import of "%s" (self-check of the scanner)',
    (mod) => {
      const sample = `import something from "${mod}";`;
      const found = extractImportSpecifiers(sample)
        .map(isForbiddenModule)
        .filter((m): m is string => m !== null);
      expect(found).toContain(mod);
    },
  );
});
