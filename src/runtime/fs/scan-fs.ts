import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/**
 * Shared filesystem-walk helpers for project-relative listings.
 *
 * Used by:
 *   - `web/src/routes/api/mentions/search/+server.ts` — `@[file:…]`
 *     autocomplete
 *   - `src/runtime/scan/feature-scan.ts` — Feature Index scanner
 *
 * Refactored out of the +server.ts inline helpers to keep both call
 * sites in sync. Adding a new exclusion (or fixing a symlink-escape
 * bug) here updates every caller; copy-paste would let them drift.
 *
 * .gitignore parsing is a known gap (see Open Questions in the
 * Feature Index design doc). For now both call sites share the same
 * coarse exclusion set + dotfile filter; if/when a `.gitignore`
 * helper lands it MUST live here so both sites pick it up at once.
 */

/**
 * Directory basenames that never appear in mention autocomplete or
 * scanner output. Hidden dotfiles are filtered separately by the
 * starts-with-"." check inside listFilteredChildren.
 */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".ezcorp",
]);

/**
 * True when `absPath` resolves (after realpath) to a location at or
 * under `realRoot`. Filters out symlinks that escape the project root
 * and any path that fails to resolve (deleted, permission-denied, …).
 *
 * Caller is responsible for passing a `realRoot` that has already been
 * realpath'd — keeping the realpath out of the inner loop is a hot-path
 * concern for autocomplete.
 */
export async function realpathInsideRoot(
  realRoot: string,
  absPath: string,
): Promise<boolean> {
  try {
    const real = await realpath(absPath);
    return real === realRoot || real.startsWith(realRoot + "/");
  } catch {
    return false;
  }
}

export interface FsChild {
  /** Basename of the entry. */
  name: string;
  /** Project-relative path with `/` separators (POSIX-style). */
  relPath: string;
  /** Absolute filesystem path. */
  abs: string;
  /** "file" includes regular files and symbolic links that survive the realpath check. */
  kind: "file" | "dir";
}

/**
 * List the direct children of `absDir`, applying the project-scan
 * filters consistent across the autocomplete + scanner call sites:
 *   - skip dotfiles / dot-dirs (`.gitignore`, `.git`, `.ezcorp`, `.env`, …)
 *   - skip {@link EXCLUDED_DIR_NAMES}
 *   - skip entries whose realpath escapes `realRoot`
 *
 * Returns `[]` rather than throwing on:
 *   - `absDir` itself escaping the root
 *   - `readdir` failure (missing dir, permission denied)
 *
 * Both call sites prefer silent skip over a thrown exception — a missing
 * `web/src` shouldn't 500 the autocomplete or abort the scanner.
 */
export async function listFilteredChildren(
  realRoot: string,
  absDir: string,
  relDirPrefix: string,
): Promise<FsChild[]> {
  if (!(await realpathInsideRoot(realRoot, absDir))) return [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: FsChild[] = [];
  for (const d of entries) {
    if (d.name.startsWith(".")) continue;
    if (EXCLUDED_DIR_NAMES.has(d.name)) continue;
    const abs = join(absDir, d.name);
    if (!(await realpathInsideRoot(realRoot, abs))) continue;
    const relPath = relDirPrefix ? `${relDirPrefix}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.push({ name: d.name, relPath, abs, kind: "dir" });
    } else if (d.isFile() || d.isSymbolicLink()) {
      out.push({ name: d.name, relPath, abs, kind: "file" });
    }
  }
  return out;
}
