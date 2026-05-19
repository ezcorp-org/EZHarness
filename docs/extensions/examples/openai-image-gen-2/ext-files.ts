// Resolver for `/api/ext-files/openai-image-gen-2/<relPath>` URLs.
//
// The tool emits these URLs in `formatResult` (see image-storage.ts) and
// the model sees them in prior turns. Making the same form a valid input
// to the `edit` tool closes the loop: the model can pass back what it saw.
//
// Mirrors the contract of `src/chat/attachments/ext-files-resolver.ts`
// locally — the extension is a separate Bun subprocess package and must
// not import from the host's `src/` tree. The allowlist here is a single
// entry (this extension's own name) by design.
//
// File existence is intentionally NOT checked in `resolveExtFileUrl`: we
// keep the resolver deterministic for path-only tests, and the caller
// decides how to surface a missing file (validation error vs network
// error). `readExtFileBytes` is the I/O side and can throw.

import { resolve, relative, normalize, sep } from "node:path";
import { fsExists, fsRead } from "@ezcorp/sdk/runtime";
import { EXTENSION_NAME } from "./image-storage";

const ALLOWED_EXTENSION_NAME = EXTENSION_NAME;
const URL_PREFIX = `/api/ext-files/${ALLOWED_EXTENSION_NAME}/`;

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export interface ResolvedExtFile {
  /** Absolute path on disk. Guaranteed to live under the extension's data root. */
  absPath: string;
  /** Content-type derived from the file extension. */
  mimeType: string;
}

function mimeTypeForPath(filePath: string): string {
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function extensionDataRoot(cwd: string): string {
  return resolve(cwd, ".ezcorp", "extension-data", ALLOWED_EXTENSION_NAME);
}

/** True for any string this module would attempt to resolve. Cheap, no I/O. */
export function isExtFileUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith(URL_PREFIX);
}

/**
 * Three accepted input URL forms for the `edit` tool, validated symmetrically
 * across the BYOK and Codex paths so callers see the same rejection message
 * regardless of which auth path is active.
 *
 * Kept here (next to `isExtFileUrl`) because the rules are about URL
 * acceptance and the canonical "ext-files" form is owned by this module.
 */
export function isAcceptedImageRef(ref: unknown): ref is string {
  return (
    typeof ref === "string" &&
    (ref.startsWith("data:image/") || ref.startsWith("https://") || isExtFileUrl(ref))
  );
}

/** Single source of truth for the help text listing the three accepted forms. */
export const ACCEPTED_IMAGE_REF_HELP =
  "images must be data:image/ URIs, https:// URLs, or /api/ext-files/openai-image-gen-2/<relPath> URLs.";

/**
 * Resolve a `/api/ext-files/openai-image-gen-2/<relPath>` URL to an absolute
 * disk path after applying allowlist + containment checks.
 *
 * Returns `null` (never throws) when:
 *   - `url` is not a string or doesn't start with the expected prefix
 *   - the extension name segment is not this extension's name
 *   - the relative path is empty/`.`/escapes the data root via `..` or
 *     leading-slash tricks
 */
export function resolveExtFileUrl(
  url: string | undefined,
  cwd: string = process.cwd(),
): ResolvedExtFile | null {
  if (!url || typeof url !== "string") return null;
  if (!url.startsWith(URL_PREFIX)) return null;
  const relPath = url.slice(URL_PREFIX.length);
  if (!relPath || relPath === "/" || relPath === ".") return null;

  const root = extensionDataRoot(cwd);
  const absCandidate = resolve(root, normalize(relPath));
  const rel = relative(root, absCandidate);
  // `rel` starting with ".." (or containing "../" mid-path) means the
  // caller escaped the root via traversal or a leading slash.
  //
  // No `realpath`/`lstat` symlink check by design — this extension owns
  // every byte that lands in its data root (writes happen in
  // `image-storage.ts` via the host-mediated `fsWrite` SDK helper), so
  // a symlink pointing outward could only be created by an out-of-band
  // actor with filesystem access, which is outside the threat model.
  // Mirrors the host's `src/chat/attachments/ext-files-resolver.ts`
  // semantics for consistency.
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
  if (rel === "" || rel === ".") return null;

  return { absPath: absCandidate, mimeType: mimeTypeForPath(absCandidate) };
}

/**
 * Read the bytes for an already-resolved ext-files path. Throws if the
 * file doesn't exist — the caller (validation layer in each client) wraps
 * that into the right error code so the model gets a clear message.
 */
export async function readExtFileBytes(
  absPath: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (!(await fsExists(absPath))) {
    throw new Error(`ext-files: file does not exist on disk: ${absPath}`);
  }
  const bytes = (await fsRead(absPath, { encoding: "binary" })) as Uint8Array;
  return { bytes, mimeType: mimeTypeForPath(absPath) };
}
