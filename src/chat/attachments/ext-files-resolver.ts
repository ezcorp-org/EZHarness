/**
 * Shared resolver for `/api/ext-files/<name>/<relPath>` URLs.
 *
 * Two callers:
 *   1. the HTTP GET route (`web/src/routes/api/ext-files/...`) — serves bytes
 *      to the UI.
 *   2. the history rehydrator (`history-rehydrate.ts`) — reads the same bytes
 *      into `ImageContent` parts so the model sees prior-turn generated images
 *      on subsequent turns.
 *
 * Centralising the allowlist + containment check keeps the two paths from
 * diverging. Any future extension that stores binary artifacts gets added
 * here once and is immediately visible to both.
 */

import { resolve, relative, normalize, sep } from "node:path";
import { realpathSync } from "node:fs";
import { extensionDataDir } from "../../extensions/extension-data-dir";

// Hard allowlist. Keep tight — anything added here exposes that extension's
// disk state to authenticated users AND feeds bytes into the LLM on every
// subsequent turn. Pair new entries with a review of the extension's output
// format.
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "openai-image-gen-2",
]);

export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Absolute path of the extension's data root under the given project root.
 *
 * The layout literal lives in `src/extensions/extension-data-dir.ts` — the
 * same module the uninstall `rm -rf` and the sandbox work-dir read, so this
 * resolver cannot drift into serving a directory the other two don't mean.
 * `resolve` is kept here because this signature takes a `cwd` that may be
 * relative, which `join` alone would not absolutize.
 */
export function extensionDataRoot(name: string, cwd: string = process.cwd()): string {
  return resolve(extensionDataDir(name, cwd));
}

/**
 * Content-type for a file path based on its lowercase extension.
 * Falls back to `application/octet-stream` for unknown extensions.
 */
export function mimeTypeForPath(filePath: string): string {
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export interface ResolvedExtFile {
  /** Canonical (realpath'd) absolute path on disk. Guaranteed to live
   *  under `extensionDataRoot(name)` AFTER symlink resolution. */
  absPath: string;
  /** Content-type derived from the file extension. */
  mimeType: string;
}

/**
 * Resolve a `name` + `relPath` pair to an absolute path on disk after applying
 * allowlist + containment checks.
 *
 * Returns `null` (never throws) when any of the following holds:
 *   - `name` is falsy or not in `ALLOWED_EXTENSIONS`
 *   - `relPath` is empty, `/`, or `.`
 *   - the resolved path escapes the extension's data root via `..`, symlinks,
 *     or a leading slash
 *   - the file (or the data root) does not exist
 *
 * Symlink containment is asserted on REAL paths (F4): the lexical
 * `..`/prefix checks alone can't see a symlink planted inside the data dir
 * that points outside it (e.g. at the DB dir + JWT secret), and both
 * callers follow links when they read. `realpathSync` requires the file to
 * exist, so a missing file now resolves to `null` — both callers already
 * treat that the same as a missing file on disk (the HTTP route returns
 * 404, the rehydrator silently skips). Intra-root symlinks remain allowed:
 * the test is on the canonical path, not "is a symlink".
 */
export function resolveExtFilesPath(
  name: string | undefined,
  relPath: string | undefined,
  cwd: string = process.cwd(),
): ResolvedExtFile | null {
  if (!name || !ALLOWED_EXTENSIONS.has(name)) return null;
  if (!relPath || relPath === "/" || relPath === ".") return null;

  const root = extensionDataRoot(name, cwd);
  const absCandidate = resolve(root, normalize(relPath));
  const rel = relative(root, absCandidate);
  // `rel` starting with ".." (or containing "../" mid-path) means the
  // caller escaped the root via traversal or a leading slash.
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
  // Degenerate case: `relPath` resolved to the root itself.
  if (rel === "" || rel === ".") return null;

  // F4: re-assert containment on canonical paths — the checks above are
  // purely lexical and a planted symlink would pass them while pointing
  // outside the root. ENOENT (missing file / root / dangling link) →
  // null, matching the missing-file behavior of both callers. The
  // returned `absPath` is the CANONICAL path so downstream reads can't
  // be redirected by a link re-pointed after this check; the mime type
  // stays keyed on the REQUESTED name (what the URL promised).
  try {
    const realRoot = realpathSync(root);
    const realAbs = realpathSync(absCandidate);
    if (!realAbs.startsWith(realRoot + sep)) return null;
    return { absPath: realAbs, mimeType: mimeTypeForPath(absCandidate) };
  } catch {
    return null;
  }
}
