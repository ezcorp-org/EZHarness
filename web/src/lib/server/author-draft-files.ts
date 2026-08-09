/**
 * The extension-author draft file allowlist and its reader — one copy.
 *
 * The same seven-entry set and the same "read the draft dir" loop lived
 * in `+page.server.ts` AND in the draft API route, and both loops ended
 * in a bare catch that skipped unreadable files. A file that could not
 * be read silently vanished from the map, so the editor showed a short
 * file list and the author edited (and installed) an extension while
 * looking at less than all of it, with nothing on screen to say so.
 *
 * `readAuthorDraftFiles` returns the unreadable names alongside the
 * files so callers can SHOW them. Skipping is still the right behavior
 * — one bad file must not 500 the whole editor — but skipping silently
 * is not.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Files the author flow can create and edit. Mirrors the scaffolder's
 * keys plus the `.gitignore` dotfile; the draft PUT allowlist and the
 * subprocess-side `ALLOWED_DRAFT_FILES` in the bundled extension are
 * the same set.
 */
export const AUTHOR_DRAFT_FILES: ReadonlySet<string> = new Set([
  "ezcorp.config.ts",
  "index.ts",
  "index.test.ts",
  "README.md",
  "package.json",
  "tsconfig.json",
  ".gitignore",
]);

export interface AuthorDraftFileMap {
  /** relpath → content, for every allowlisted file that read cleanly. */
  files: Record<string, string>;
  /**
   * Allowlisted files that EXIST but could not be read, each with the
   * reason. Never silently dropped — the caller renders these.
   */
  unreadable: Array<{ name: string; error: string }>;
}

/**
 * Read a draft directory's file map. The filesystem is the source of
 * truth; the DB payload only holds the (advisory) draftDir pointer.
 */
export function readAuthorDraftFiles(dir: string): AuthorDraftFileMap {
  const files: Record<string, string> = {};
  const unreadable: Array<{ name: string; error: string }> = [];
  if (!existsSync(dir)) return { files, unreadable };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    return {
      files,
      unreadable: [{ name: ".", error: e instanceof Error ? e.message : String(e) }],
    };
  }

  for (const name of entries) {
    if (!AUTHOR_DRAFT_FILES.has(name)) continue;
    try {
      files[name] = readFileSync(join(dir, name), "utf8");
    } catch (e) {
      unreadable.push({
        name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { files, unreadable };
}
