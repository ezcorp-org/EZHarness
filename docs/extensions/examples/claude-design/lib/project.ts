// Project & path helpers for the claude-design extension.
// Centralizes the `.ezcorp/extension-data/claude-design/` layout so
// every callsite uses the same path conventions.

import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const EXT_NAME = "claude-design";

export function findProjectRoot(from: string = process.cwd()): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

export function dataDir(root: string = findProjectRoot()): string {
  const dir = join(root, ".ezcorp", "extension-data", EXT_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectsDir(root?: string): string {
  return join(dataDir(root), "projects");
}

export function projectDir(slug: string, root?: string): string {
  const dir = join(projectsDir(root), slug);
  mkdirSync(join(dir, "drafts"), { recursive: true });
  return dir;
}

export function handoffsDir(root?: string): string {
  return join(dataDir(root), "handoffs");
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
