// Project & path helpers for the claude-design extension.
// Centralizes the `.ezcorp/extension-data/claude-design/` layout so
// every callsite uses the same path conventions.
//
// IO routes through `@ezcorp/sdk/runtime` fs helpers (Phase 3
// host-mediated reverse-RPC). Raw `node:fs` is poisoned by the
// sandbox-preload at module-load. The `.git` walk in production
// reads `EZCORP_PROJECT_ROOT` injected by the host at spawn time
// (`src/extensions/registry.ts:108`). Test/CLI contexts fall back to a
// lazy `require("node:fs")` walk — the require throws inside the
// sandbox but is swallowed; outside, it works as before.

import { fsMkdir } from "@ezcorp/sdk/runtime";
import { basename, dirname, join } from "node:path";

const EXT_NAME = "claude-design";

export function findProjectRoot(from: string = process.cwd()): string {
  // (1) Host-injected — production fast path.
  const fromEnv = process.env.EZCORP_PROJECT_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  // (2) Lazy fs walk — only reached in test / CLI contexts where the
  // sandbox-preload poison isn't active. A static `import {existsSync}
  // from "fs"` would fire at module-load time even for the production
  // path (1) above — so we require it on demand.
  let fs: typeof import("node:fs");
  try {
    fs = require("node:fs") as typeof import("node:fs");
  } catch {
    return from;
  }
  let dir = from;
  while (true) {
    if (fs.existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

export async function dataDir(root: string = findProjectRoot()): Promise<string> {
  const dir = join(root, ".ezcorp", "extension-data", EXT_NAME);
  await fsMkdir(dir, { recursive: true });
  return dir;
}

export async function projectsDir(root?: string): Promise<string> {
  return join(await dataDir(root), "projects");
}

export async function projectDir(slug: string, root?: string): Promise<string> {
  const dir = join(await projectsDir(root), slug);
  await fsMkdir(join(dir, "drafts"), { recursive: true });
  return dir;
}

export async function handoffsDir(root?: string): Promise<string> {
  return join(await dataDir(root), "handoffs");
}

/** Default project slug — basename of the project root. */
export function defaultProjectSlug(root: string = findProjectRoot()): string {
  return basename(root) || "project";
}

/** Derive the cardType-relative URL for a draft, used by the canvas
 *  card's iframeSrc. Encoded segments — see SDK's extensionDataUrl. */
export function draftIframeUrl(slug: string, draftFile: string): string {
  return (
    "/api/extensions/" +
    encodeURIComponent(EXT_NAME) +
    "/data/projects/" +
    encodeURIComponent(slug) +
    "/drafts/" +
    encodeURIComponent(draftFile)
  );
}
