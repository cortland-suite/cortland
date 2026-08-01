import path from "node:path";
import { PIPELINE_FILE } from "./config.js";

export const RESULT_SUFFIX = ".result.md";
export const ERROR_SUFFIX = ".error.md";

export function resultPath(inputPath: string): string {
  return inputPath + RESULT_SUFFIX;
}

export function errorPath(inputPath: string): string {
  return inputPath + ERROR_SUFFIX;
}

/** Files the watcher must never treat as pipeline input. */
export function shouldIgnore(baseName: string): boolean {
  return (
    baseName.startsWith(".") || // dotfiles, .DS_Store, .icloud placeholders
    baseName === PIPELINE_FILE ||
    baseName.endsWith(RESULT_SUFFIX) ||
    baseName.endsWith(ERROR_SUFFIX)
  );
}

/**
 * iCloud represents a not-yet-downloaded (dataless) file as ".<name>.icloud".
 * Returns the real file name, or null if this isn't a placeholder.
 */
export function icloudPlaceholderTarget(baseName: string): string | null {
  const match = /^\.(.+)\.icloud$/.exec(baseName);
  return match ? match[1] : null;
}

export function describeInput(inputPath: string): string {
  return path.basename(inputPath);
}
