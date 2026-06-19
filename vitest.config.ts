import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the Obsidian Synology WebDAV Sync plugin.
 *
 * - Runs in single-execution mode (no watch); `npm test` maps to `vitest run`.
 * - Uses the jsdom environment so platform DOM APIs (e.g. `DOMParser`,
 *   used by the Response Parser) are available in tests.
 * - Loads `test/setup.ts`, which installs fast-check defaults and the
 *   fake-timer helpers used by timeout/retry-interval tests.
 */
export default defineConfig({
  test: {
    // Single-run by default; watch must be opted into explicitly.
    watch: false,
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The published `obsidian` package ships only type declarations (no runtime
    // entry), so any module importing from it cannot be resolved by the test
    // runner. Alias it to a local stub; tests still override specific exports
    // with `vi.mock("obsidian", ...)`.
    alias: {
      obsidian: fileURLToPath(
        new URL("./test/__mocks__/obsidian.ts", import.meta.url),
      ),
    },
  },
});
