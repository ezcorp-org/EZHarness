// Write generated images to disk so we can serve them via a short URL
// instead of embedding base64 in the tool result. Base64 in the tool
// result blows past the model's context window on the next turn
// (1024×1024 PNG ≈ 2 MB → ~2.7 MB when base64-encoded → easily eats
// 100k+ tokens).
//
// Layout (per docs/extensions/data-storage.md): user-visible persistent
// state goes under `<projectRoot>/.ezcorp/extension-data/<name>/`.
// We write to the `generated/` subdir; the server route serves from
// the same extension-data root.
//
// IO routes through `@ezcorp/sdk/runtime` fs helpers (Phase 3
// host-mediated reverse-RPC). Raw `node:fs` / `Bun.file` / `Bun.write`
// are poisoned by the sandbox-preload, so a top-level `node:fs/promises`
// import would crash the subprocess at boot ("Transport closed").

import { fsMkdir, fsWrite } from "@ezcorp/sdk/runtime";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const EXTENSION_NAME = "openai-image-gen-2";

function extFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "png";
  }
}

export interface SavedImage {
  /** Relative path under the extension's data dir (always forward-slash). */
  relPath: string;
  /** HTTP URL the UI can GET to display this image. */
  url: string;
}

export async function saveImageToDisk(
  b64: string,
  mimeType: string,
  opts: { projectRoot?: string } = {},
): Promise<SavedImage> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const ext = extFromMimeType(mimeType);
  const id = randomUUID();
  const relPath = `generated/${id}.${ext}`;
  const absDir = join(projectRoot, ".ezcorp", "extension-data", EXTENSION_NAME, "generated");
  const absFile = join(absDir, `${id}.${ext}`);
  await fsMkdir(absDir, { recursive: true });
  // atob(b64) → binary string → Uint8Array of bytes.
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await fsWrite(absFile, bytes);
  return { relPath, url: `/api/ext-files/${EXTENSION_NAME}/${relPath}` };
}
