/**
 * Pure, I/O-free logic.
 *
 * This layer holds deterministic cores that are verified with property-based
 * tests: shared data models, the URL-join helper, the PROPFIND request
 * builder, the multistatus response parser, the `decideAction` sync decision
 * function, conflict-copy naming, the retry queue, settings validation, and
 * the error log. No module here performs network or filesystem I/O.
 */
export * from "./types";
export { parseMultistatus, render, type ParseResult } from "./responseParser";
export {
  parseFolderListing,
  sortFolders,
  renderFolderListing,
  type FolderListingParseResult,
} from "./folderListing";
export * from "./conflictName";
export * from "./decideAction";
export * from "./urlJoin";
export * from "./requestBuilder";
export * from "./retryQueue";
export * from "./errorLog";
export * from "./validateSettings";
export * from "./vaultPath";
export * from "./folderName";
