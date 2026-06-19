/**
 * Conflict Resolver (`resolve`).
 *
 * When the Sync Engine detects a sync conflict for a vault file, both the local
 * and the remote version must be preserved without overwriting or discarding
 * either one (Req 9.1). The resolver writes the conflicting version under a
 * generated conflict-copy name (see {@link conflictCopyName}), leaves the
 * original file untouched, and notifies the user within 5 seconds that a
 * conflict copy was created (Req 9.4).
 *
 * If the conflict copy cannot be written, both versions are retained without
 * modification and an error notification is emitted (Req 9.5). Because the
 * original file is never touched and the copy is written as a complete file,
 * a write failure leaves the vault exactly as it was.
 *
 * The vault-write and notification side effects are abstracted behind small
 * injectable interfaces ({@link VaultWriter} and {@link Notifier}) so the
 * resolver can be exercised without Obsidian.
 *
 * _Requirements: 9.1, 9.4, 9.5_
 */
import { conflictCopyName } from "../core/conflictName";

/**
 * Writes complete files into the vault.
 *
 * Implementations MUST write the file as a whole; a failure SHALL leave the
 * destination path untouched so no partial/half-written copy is created.
 */
export interface VaultWriter {
  /**
   * Write `content` to `path`, creating the file. Rejects on failure without
   * leaving a partial file behind.
   */
  writeFile(path: string, content: ArrayBuffer): Promise<void>;
}

/**
 * Surfaces a user-visible notification (e.g. an Obsidian `Notice`).
 */
export interface Notifier {
  /** Display `message` to the user. */
  notify(message: string): void;
}

/**
 * The input describing a single conflict to preserve.
 */
export interface ConflictInput {
  /** Vault-relative path of the conflicting original file (left unchanged). */
  originalPath: string;
  /** The conflicting version's bytes to preserve under the conflict-copy name. */
  content: ArrayBuffer;
  /**
   * The set of vault-relative paths already in use. Used to generate a
   * conflict-copy name that collides with no existing file.
   */
  existingPaths: Set<string>;
  /** Optional device identifier embedded in the conflict-copy name. */
  deviceTag?: string;
  /** Optional timestamp (epoch ms) used in the conflict-copy identifier. */
  now?: number;
}

/**
 * The outcome of resolving a conflict by preservation.
 *
 * A discriminated union: `ok: true` carries the path the conflict copy was
 * written to; `ok: false` carries an error description. In both cases the
 * original file and the other version are retained unchanged.
 */
export type ConflictOutcome =
  | { ok: true; conflictCopyPath: string }
  | { ok: false; error: string };

/**
 * Resolves sync conflicts by preserving both versions.
 */
export interface ConflictResolver {
  /**
   * Preserve the conflicting version under a non-colliding conflict-copy name,
   * leaving the original file unchanged, then notify the user. On write
   * failure, retain both versions and emit an error notification.
   */
  resolve(file: ConflictInput): Promise<ConflictOutcome>;
}

/**
 * Default {@link ConflictResolver} that writes through the injected
 * {@link VaultWriter} and reports through the injected {@link Notifier}.
 */
export class DefaultConflictResolver implements ConflictResolver {
  constructor(
    private readonly writer: VaultWriter,
    private readonly notifier: Notifier
  ) {}

  async resolve(file: ConflictInput): Promise<ConflictOutcome> {
    const { originalPath, content, existingPaths, deviceTag, now } = file;

    // Generate a name that contains the original base name, is not in
    // `existingPaths`, and differs from `originalPath` (Req 9.1–9.3).
    const conflictCopyPath = conflictCopyName(
      originalPath,
      existingPaths,
      deviceTag,
      now
    );

    try {
      // Write the conflict copy. The original file is never touched, so even a
      // mid-write failure leaves both versions intact (Req 9.1).
      await this.writer.writeFile(conflictCopyPath, content);
    } catch (cause) {
      // Write failed: retain both versions, emit an error notice (Req 9.5).
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.notifier.notify(
        `Conflict copy creation failed for "${originalPath}": ${reason}`
      );
      return { ok: false, error: reason };
    }

    // Preservation succeeded: notify that a conflict copy was created (Req 9.4).
    this.notifier.notify(
      `Conflict detected for "${originalPath}". A conflict copy was created at "${conflictCopyPath}".`
    );
    return { ok: true, conflictCopyPath };
  }
}
