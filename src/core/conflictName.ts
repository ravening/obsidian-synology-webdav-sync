/**
 * Conflict-copy naming (pure).
 *
 * When the sync engine detects a conflict it preserves both the local and the
 * remote version. The preserved copy is written under a generated name that
 * keeps the original file's base name, embeds a unique identifier (a timestamp
 * plus a device tag), never collides with an existing vault path, and never
 * equals the original path so the original file is left untouched.
 *
 * _Requirements: 9.1, 9.2, 9.3_
 */

/** The decomposed parts of a vault-relative path. */
interface PathParts {
  /** Directory portion including the trailing slash, or "" when at the root. */
  dir: string;
  /** File base name without the extension. */
  base: string;
  /** File extension including the leading dot, or "" when there is none. */
  ext: string;
}

/**
 * Split a vault-relative path into directory, base name, and extension.
 *
 * A leading dot (e.g. `.gitignore`) is treated as part of the base name rather
 * than an extension, so dotfiles keep their full name in the conflict copy.
 */
function splitPath(path: string): PathParts {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const fileName = slash >= 0 ? path.slice(slash + 1) : path;

  const dot = fileName.lastIndexOf(".");
  const hasExt = dot > 0; // dot > 0 keeps dotfiles intact
  const base = hasExt ? fileName.slice(0, dot) : fileName;
  const ext = hasExt ? fileName.slice(dot) : "";

  return { dir, base, ext };
}

/**
 * Render a filesystem-safe identifier from a timestamp and a device tag.
 *
 * Colons and dots from the ISO timestamp are replaced so the identifier is
 * safe to embed in a file name on every platform.
 */
function makeIdentifier(timestampUtc: number, deviceTag: string): string {
  const stamp = new Date(timestampUtc).toISOString().replace(/[:.]/g, "-");
  return `${stamp} ${deviceTag}`;
}

/**
 * Generate a conflict-copy name for `originalPath` that does not collide with
 * any member of `existingPaths` and differs from `originalPath` itself.
 *
 * The returned name contains the original file's base name and embeds a unique
 * identifier (timestamp + device tag). If a generated name still collides with
 * an existing path (or equals the original), an additional identifier is
 * appended until the name is unique, so no existing file is overwritten and the
 * original file's name is never changed.
 *
 * @param originalPath  The vault-relative path of the conflicting file.
 * @param existingPaths The set of vault-relative paths already in use.
 * @param deviceTag     Optional device identifier embedded in the copy name.
 * @param now           Optional timestamp (epoch ms) used in the identifier.
 */
export function conflictCopyName(
  originalPath: string,
  existingPaths: Set<string>,
  deviceTag: string = defaultDeviceTag(),
  now: number = Date.now()
): string {
  const { dir, base, ext } = splitPath(originalPath);
  const identifier = makeIdentifier(now, deviceTag);

  // First candidate: base name + a single unique identifier.
  let candidate = `${dir}${base} (conflict ${identifier})${ext}`;

  // Append further identifiers until the name is unique and differs from the
  // original. The growing suffix guarantees termination even if the timestamp
  // and device tag repeat across calls.
  let counter = 1;
  while (existingPaths.has(candidate) || candidate === originalPath) {
    candidate = `${dir}${base} (conflict ${identifier} ${counter})${ext}`;
    counter += 1;
  }

  return candidate;
}

/**
 * A short, unique-ish device tag used when the caller does not supply one.
 *
 * The conflict-copy uniqueness loop does not depend on this value being
 * collision-free; it only needs to embed a device identifier per Req 9.2.
 */
function defaultDeviceTag(): string {
  return Math.random().toString(36).slice(2, 8);
}
