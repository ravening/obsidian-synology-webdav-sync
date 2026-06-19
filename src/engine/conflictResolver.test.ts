import { describe, it, expect, vi } from "vitest";
import {
  DefaultConflictResolver,
  type ConflictInput,
  type Notifier,
  type VaultWriter,
} from "./conflictResolver";

/**
 * Unit tests for {@link DefaultConflictResolver.resolve}.
 *
 * Focus is the write-failure path (Req 9.5): when the {@link VaultWriter}
 * rejects, both versions must be retained (the original is never written), an
 * error notice naming the affected file is emitted, and `{ ok: false }` is
 * returned. A complementary success-path test covers Req 9.1/9.4 (and exercises
 * the non-colliding name generation of Req 9.2).
 *
 * VaultWriter and Notifier are replaced with `vi.fn()` spies; a fixed
 * `deviceTag`/`now` make the generated conflict-copy name deterministic.
 */

/** Build a small ArrayBuffer from an ASCII string for test content. */
function bufferFrom(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

/** Construct a resolver wired to spy fakes, returning the spies for assertions. */
function makeResolver(writeFile: VaultWriter["writeFile"]) {
  const writer: VaultWriter = { writeFile: vi.fn(writeFile) };
  const notifier: Notifier = { notify: vi.fn() };
  const resolver = new DefaultConflictResolver(writer, notifier);
  return { resolver, writer, notifier };
}

const FIXED_DEVICE_TAG = "device-A";
const FIXED_NOW = Date.UTC(2024, 0, 2, 3, 4, 5, 678); // deterministic timestamp

function baseInput(overrides: Partial<ConflictInput> = {}): ConflictInput {
  return {
    originalPath: "notes/todo.md",
    content: bufferFrom("conflicting body"),
    existingPaths: new Set<string>(["notes/todo.md"]),
    deviceTag: FIXED_DEVICE_TAG,
    now: FIXED_NOW,
    ...overrides,
  };
}

describe("DefaultConflictResolver.resolve", () => {
  describe("write-failure path (Req 9.5)", () => {
    it("retains both versions, emits an error notice, and returns ok:false when the write rejects", async () => {
      const failure = new Error("disk full");
      const { resolver, writer, notifier } = makeResolver(() =>
        Promise.reject(failure)
      );
      const input = baseInput();

      const outcome = await resolver.resolve(input);

      // Returns a failure outcome carrying the error description.
      expect(outcome.ok).toBe(false);
      if (outcome.ok === false) {
        expect(outcome.error).toContain("disk full");
      }

      // The original file is NEVER written: writeFile was attempted exactly
      // once, and only ever for a conflict-copy path (not originalPath).
      expect(writer.writeFile).toHaveBeenCalledTimes(1);
      const writtenPaths = (writer.writeFile as ReturnType<typeof vi.fn>).mock
        .calls.map((call) => call[0] as string);
      expect(writtenPaths).not.toContain(input.originalPath);
      expect(writtenPaths[0]).toContain("todo"); // conflict copy of the base name

      // An error notice naming the affected file / failure is emitted.
      expect(notifier.notify).toHaveBeenCalledTimes(1);
      const message = (notifier.notify as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(message).toContain(input.originalPath);
      expect(message.toLowerCase()).toContain("conflict copy");
      expect(message.toLowerCase()).toContain("failed");
    });

    it("surfaces a non-Error rejection reason in the outcome and notice", async () => {
      const { resolver, notifier } = makeResolver(() =>
        Promise.reject("permission denied")
      );

      const outcome = await resolver.resolve(baseInput());

      expect(outcome.ok).toBe(false);
      if (outcome.ok === false) {
        expect(outcome.error).toBe("permission denied");
      }
      const message = (notifier.notify as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(message).toContain("permission denied");
    });
  });

  describe("success path (Req 9.1, 9.4)", () => {
    it("writes a generated conflict copy, leaves the original untouched, notifies, and returns ok:true", async () => {
      const { resolver, writer, notifier } = makeResolver(() =>
        Promise.resolve()
      );
      const input = baseInput();

      const outcome = await resolver.resolve(input);

      // Returns success carrying the generated conflict-copy path.
      expect(outcome.ok).toBe(true);
      if (outcome.ok !== true) return;
      const { conflictCopyPath } = outcome;

      // The generated name: contains the original base name, is not an existing
      // path, and differs from the original (Req 9.2/9.3 non-destructiveness).
      expect(conflictCopyPath).toContain("todo");
      expect(input.existingPaths.has(conflictCopyPath)).toBe(false);
      expect(conflictCopyPath).not.toBe(input.originalPath);

      // Exactly one write occurred, to the conflict-copy path, with the
      // conflicting content. The original file path is never written.
      expect(writer.writeFile).toHaveBeenCalledTimes(1);
      expect(writer.writeFile).toHaveBeenCalledWith(
        conflictCopyPath,
        input.content
      );
      const writtenPaths = (writer.writeFile as ReturnType<typeof vi.fn>).mock
        .calls.map((call) => call[0] as string);
      expect(writtenPaths).not.toContain(input.originalPath);

      // Notifies that a conflict copy was created for the affected file.
      expect(notifier.notify).toHaveBeenCalledTimes(1);
      const message = (notifier.notify as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(message).toContain(input.originalPath);
      expect(message).toContain(conflictCopyPath);
      expect(message.toLowerCase()).toContain("conflict copy");
    });

    it("generates a name that avoids a colliding first candidate", async () => {
      // Pre-populate existingPaths with the deterministic first-candidate name
      // so the resolver must append an extra identifier to stay non-destructive.
      const firstCandidate = `notes/todo (conflict ${new Date(FIXED_NOW)
        .toISOString()
        .replace(/[:.]/g, "-")} ${FIXED_DEVICE_TAG}).md`;
      const existingPaths = new Set<string>(["notes/todo.md", firstCandidate]);
      const { resolver } = makeResolver(() => Promise.resolve());

      const outcome = await resolver.resolve(baseInput({ existingPaths }));

      expect(outcome.ok).toBe(true);
      if (outcome.ok !== true) return;
      expect(outcome.conflictCopyPath).not.toBe(firstCandidate);
      expect(existingPaths.has(outcome.conflictCopyPath)).toBe(false);
    });
  });
});
