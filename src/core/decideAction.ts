/**
 * Pure sync decision logic.
 *
 * `decideAction` is the heart of sync correctness. It compares the local and
 * remote metadata for a single file and decides whether to upload, download,
 * or skip the transfer. It performs no I/O and is deterministic, so it can be
 * verified exhaustively with property-based tests.
 */

import type { FileMeta, SyncAction } from "./types";

/**
 * The equality window, in milliseconds. When both a local file and its remote
 * counterpart are present and their last-modified timestamps differ by this
 * amount or less (inclusive), the two are treated as synchronized and neither
 * is transferred (Req 6.3).
 */
export const EQUALITY_WINDOW_MS = 2000;

/**
 * Decide the sync action for a single file pair.
 *
 * Rules (design Property 1, Requirements 6.1, 6.2, 6.3, 7.2, 7.3, 7.4):
 * - `upload` when the remote is absent, OR the local timestamp is more than
 *   {@link EQUALITY_WINDOW_MS} ms newer than the remote.
 * - `download` when the local is absent, OR the remote timestamp is more than
 *   {@link EQUALITY_WINDOW_MS} ms newer than the local.
 * - `skip` when both are present and their timestamps differ by
 *   {@link EQUALITY_WINDOW_MS} ms or less (inclusive of exactly the window).
 * - `skip` when both are absent (the degenerate edge case: nothing to do).
 *
 * @param local  The local file's metadata, or `null` if it does not exist locally.
 * @param remote The remote file's metadata, or `null` if it does not exist remotely.
 * @returns The chosen {@link SyncAction}: `"upload"`, `"download"`, or `"skip"`.
 */
export function decideAction(
  local: FileMeta | null,
  remote: FileMeta | null,
): SyncAction {
  // Neither side has the file — nothing to transfer.
  if (local === null && remote === null) {
    return "skip";
  }

  // Present locally but absent remotely — upload the local copy.
  if (remote === null) {
    return "upload";
  }

  // Present remotely but absent locally — download the remote copy.
  if (local === null) {
    return "download";
  }

  // Both present: compare timestamps against the inclusive equality window.
  const delta = local.modifiedUtc - remote.modifiedUtc;

  if (delta > EQUALITY_WINDOW_MS) {
    // Local is more than the window newer than remote.
    return "upload";
  }

  if (-delta > EQUALITY_WINDOW_MS) {
    // Remote is more than the window newer than local.
    return "download";
  }

  // Timestamps differ by the window or less — treat as synchronized.
  return "skip";
}
