/**
 * Pure new-folder-name validation.
 *
 * `validateFolderName` checks a candidate new folder name against the
 * documented rules (Requirements 4.2, 4.5): the name must be 1 to 255
 * characters long and must contain neither a forward slash (`"/"`) nor a
 * backslash (`"\\"`). It performs no I/O and no duplicate check — duplicate
 * detection needs the current folder listing and is handled by the
 * FolderBrowserController. The result identifies the rejection reason so the
 * Folder Browser can display a validation message identifying the name as
 * invalid (Req 4.5).
 */

/** Maximum length, in characters, of a new folder name (Req 4.2, 4.5). */
export const MAX_FOLDER_NAME_LENGTH = 255;

/**
 * The reason a candidate folder name was rejected.
 *
 * - `empty` — the name has zero length.
 * - `too-long` — the name exceeds {@link MAX_FOLDER_NAME_LENGTH} characters.
 * - `illegal-char` — the name contains a `"/"` or `"\\"` separator character.
 */
export type FolderNameRejection = "empty" | "too-long" | "illegal-char";

/**
 * The result of validating a candidate folder name.
 *
 * On success the candidate satisfies every rule. On failure the result
 * identifies the {@link FolderNameRejection} and carries a human-readable
 * message suitable for the Folder Browser.
 */
export type FolderNameValidationResult =
  | { valid: true }
  | { valid: false; reason: FolderNameRejection; message: string };

/** A reusable "this candidate is valid" result. */
const VALID: FolderNameValidationResult = { valid: true };

/**
 * Validate a new folder name (Req 4.2, 4.5).
 *
 * Rules:
 * - The name MUST NOT be empty.
 * - The name MUST NOT exceed {@link MAX_FOLDER_NAME_LENGTH} characters.
 * - The name MUST contain neither `"/"` nor `"\\"`.
 *
 * The function is pure: it reads only the candidate and returns a result. It
 * performs no I/O and no duplicate check. Rules are checked empty → too-long →
 * illegal-char, and the first violation found is returned.
 *
 * @param name The candidate folder name to validate.
 * @returns A {@link FolderNameValidationResult} that is either `{ valid: true }`
 *   or identifies the rejection reason and a UI-ready message.
 */
export function validateFolderName(name: string): FolderNameValidationResult {
  if (name.length === 0) {
    return {
      valid: false,
      reason: "empty",
      message: "Folder name must not be empty.",
    };
  }

  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return {
      valid: false,
      reason: "too-long",
      message: `Folder name must be at most ${MAX_FOLDER_NAME_LENGTH} characters.`,
    };
  }

  if (name.includes("/") || name.includes("\\")) {
    return {
      valid: false,
      reason: "illegal-char",
      message: 'Folder name must not contain "/" or "\\".',
    };
  }

  return VALID;
}
