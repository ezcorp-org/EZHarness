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
 * Mirrors the layout documented in `docs/extensions/data-storage.md`.
 */
export function extensionDataRoot(name: string, cwd: string = process.cwd()): string {
  return resolve(cwd, ".ezcorp", "extension-data", name);
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
  /** Absolute path on disk. Guaranteed to live under `extensionDataRoot(name)`. */
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
 *
 * File existence is NOT checked here — the caller decides how to handle
 * missing files (the HTTP route returns 404, the rehydrator silently skips).
 * This keeps the resolver deterministic for path-only tests and avoids
 * redundant stat calls on hot paths.
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

  return { absPath: absCandidate, mimeType: mimeTypeForPath(absCandidate) };
}
