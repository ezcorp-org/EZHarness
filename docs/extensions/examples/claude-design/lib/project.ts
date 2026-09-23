// Project & path helpers for the claude-design extension.
// Centralizes the `.ezcorp/extension-data/claude-design/` layout so
// every callsite uses the same path conventions.
//
// IO routes through `@ezcorp/sdk/runtime` fs helpers (Phase 3
// host-mediated reverse-RPC). Raw `node:fs` is poisoned by the
// sandbox-preload at module-load. The `.git` walk in production
// reads `EZCORP_PROJECT_ROOT` injected by the host at spawn time
// (`src/extensions/registry.ts`). Test/CLI contexts fall back to the
// SDK's `resolveProjectRoot` walk, which returns the starting directory
// inside the sandbox or outside any git repository.

import { fsMkdir, getToolContext, resolveProjectRoot } from "@ezcorp/sdk/runtime";
import { basename, join } from "node:path";

const EXT_NAME = "claude-design";

export function findProjectRoot(from: string = process.cwd()): string {
  // (1) Host-injected — production fast path.
  const fromEnv = getToolContext()?.projectRoot ?? process.env.EZCORP_PROJECT_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  // (2) The SDK's lazy git walk — only reached in test / CLI contexts. It
  // returns `from` when no repository encloses it or `node:fs` is poisoned.
  return resolveProjectRoot(from);
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
