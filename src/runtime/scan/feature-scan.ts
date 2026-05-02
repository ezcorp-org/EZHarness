import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { listFilteredChildren } from "../fs/scan-fs";

/**
 * Deterministic Feature Index scanner.
 *
 * Walks a project's filesystem and groups files into "features"
 * (immediate child directories under known source roots). Drives the
 * "Scan features" button on the per-project settings page.
 *
 * Conscious non-goals — the design doc deferred these to keep the
 * scanner sub-second:
 *   - LLM-driven discovery
 *   - Cross-cutting feature membership computed from imports
 *   - Auto-refresh on file changes
 *
 * The output is fed into `replaceAgentFiles()` (DB query) per feature;
 * user-pinned files survive every rescan. See
 * docs/plans/2026-05-01-feature-index-design.md.
 *
 * Filtering is delegated to `listFilteredChildren` in the shared
 * `runtime/fs/scan-fs` module so the scanner and the `@[file:…]`
 * autocomplete cannot drift on what counts as a project file.
 */

export interface ScannedFeature {
  /** Slug — unique within the result set (collision-prefixed, see below). */
  name: string;
  /** Placeholder description users can edit later. */
  description: string;
  /** Project-relative file paths under the feature's directory, sorted. */
  files: string[];
}

/** Source roots scanned in this exact order — first-seen slug wins. */
const STATIC_SOURCE_ROOTS = ["src", "web/src"] as const;

/** Empty / single-file features are skipped (noise). */
const MIN_FILES_PER_FEATURE = 2;

/**
 * List the source roots that actually exist under `realRoot`, expanding
 * `packages/*​/src` at runtime. Order matters for slug-collision rules:
 * the first source root to claim a slug keeps it bare; later collisions
 * get a leading-segment prefix (e.g., `web-components`).
 */
async function listSourceRoots(realRoot: string): Promise<string[]> {
  const roots: string[] = [];
  for (const r of STATIC_SOURCE_ROOTS) {
    if (existsSync(join(realRoot, r))) roots.push(r);
  }
  const pkgsDir = join(realRoot, "packages");
  if (existsSync(pkgsDir)) {
    const pkgChildren = await listFilteredChildren(realRoot, pkgsDir, "packages");
    // Sort for deterministic ordering — readdir order is FS-defined and
    // would otherwise make slug-collision outcomes flaky in tests.
    pkgChildren.sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const child of pkgChildren) {
      if (child.kind !== "dir") continue;
      const candidateAbs = join(realRoot, child.relPath, "src");
      if (existsSync(candidateAbs)) roots.push(`${child.relPath}/src`);
    }
  }
  return roots;
}

/** Recursively collect every file relpath under `absStart`. */
async function walkFilesUnder(
  realRoot: string,
  absStart: string,
  relStart: string,
  out: string[],
): Promise<void> {
  const children = await listFilteredChildren(realRoot, absStart, relStart);
  for (const c of children) {
    if (c.kind === "file") {
      out.push(c.relPath);
    } else {
      await walkFilesUnder(realRoot, c.abs, c.relPath, out);
    }
  }
}

/**
 * Scan `projectRoot` and return the discovered feature buckets.
 *
 * Algorithm:
 *   1. Resolve realpath of `projectRoot` (handles symlinked checkouts).
 *   2. Walk known source roots: `src/`, `web/src/`, `packages/*​/src/`.
 *      Roots that don't exist are silently skipped.
 *   3. Each immediate child directory under a source root is a feature
 *      candidate. Slug = directory basename.
 *   4. Slug collision rule: if a later root produces a slug already
 *      claimed by an earlier root, prefix the LATER one with the
 *      leading segment of its source root (e.g., `web-components`
 *      from `web/src/components` when `src/components` already
 *      claimed `components`). If the prefixed slug also collides,
 *      the duplicate is skipped — better to drop a corner case than
 *      produce a non-unique slug.
 *   5. Recursively collect every file under the feature directory
 *      (delegating filtering to `listFilteredChildren`).
 *   6. Skip features with fewer than 2 files (empty / single-file
 *      directories are noise).
 *   7. Output is sorted by slug for stable UI rendering.
 *
 * On unreachable / missing `projectRoot` returns `[]` rather than
 * throwing — the REST endpoint can surface "no features found" without
 * a 500.
 */
export async function scanFeatures(projectRoot: string): Promise<ScannedFeature[]> {
  if (!projectRoot) return [];
  let realRoot: string;
  try {
    realRoot = await realpath(projectRoot);
  } catch {
    return [];
  }

  const roots = await listSourceRoots(realRoot);
  const seenSlugs = new Set<string>();
  const features: ScannedFeature[] = [];

  for (const rootRel of roots) {
    const absRoot = join(realRoot, rootRel);
    const children = await listFilteredChildren(realRoot, absRoot, rootRel);
    // Sort children for deterministic slug-claim order. readdir order
    // is FS-defined; without sorting, the "first seen wins" rule would
    // produce different prefixes across runs.
    children.sort((a, b) => a.relPath.localeCompare(b.relPath));

    for (const dir of children) {
      if (dir.kind !== "dir") continue;
      const dirName = dir.name;
      const featureRelPath = dir.relPath;

      // Slug collision: prefix with the leading segment of the source
      // root. For `src/components` → "src"; `web/src/components` →
      // "web"; `packages/foo/src/components` → "packages".
      let slug = dirName;
      if (seenSlugs.has(slug)) {
        const rootLeading = rootRel.split("/")[0]!;
        slug = `${rootLeading}-${dirName}`;
        // Pathological: even the prefixed slug collided. Drop rather
        // than produce a non-unique slug — caller's DB write would
        // fail the per-project UNIQUE(name) constraint anyway.
        if (seenSlugs.has(slug)) continue;
      }

      const files: string[] = [];
      await walkFilesUnder(realRoot, dir.abs, dir.relPath, files);
      if (files.length < MIN_FILES_PER_FEATURE) continue;
      files.sort();

      seenSlugs.add(slug);
      features.push({
        name: slug,
        description: `Files under ${featureRelPath}`,
        files,
      });
    }
  }

  features.sort((a, b) => a.name.localeCompare(b.name));
  return features;
}
