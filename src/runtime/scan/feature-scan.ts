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
  /**
   * Project-relative directory path this feature was derived from
   * (e.g. `src/chat/attachments` or `web/src/components`). The rescan
   * endpoint matches existing rows by this immutable identity FIRST,
   * so a user-renamed feature stays linked to its source dir instead
   * of getting silently shadowed by a fresh agent row.
   */
  originPath: string;
  /** Project-relative file paths under the feature's directory, sorted. */
  files: string[];
}

/** Source roots scanned in this exact order — first-seen slug wins. */
const STATIC_SOURCE_ROOTS = ["src", "web/src"] as const;

/** Empty / single-file features are skipped (noise). */
const MIN_FILES_PER_FEATURE = 2;

/**
 * DoS / runaway-scan caps. Mirror the convention from
 * `src/runtime/commands/discovery.ts` (COMMAND_COUNT_MAX = 500,
 * COMMAND_BODY_MAX_BYTES = 64 KiB).
 *
 * Rationale per audit defects D1 + D2:
 *   - `MAX_DEPTH` bounds the recursion so a pathological-deep tree
 *     (or a symlink chain that survives the cycle check by happening
 *     to point at a fresh-each-time realpath) can't wedge the thread.
 *   - `MAX_FILES_PER_FEATURE` bounds the per-feature `out: string[]`
 *     so a 100k-file `src/__tests__` directory doesn't allocate a
 *     huge array, exhaust the DB statement-parameter limit on
 *     `replaceAgentFiles`, or balloon the chat-prompt system note.
 *   - `MAX_TOTAL_FILES` bounds the whole scan output regardless of
 *     how many features participated.
 *
 * When a cap is hit the scanner truncates the offending feature's
 * file list and continues — better to ship a partial-but-useful
 * result than to fail the whole scan.
 */
const MAX_DEPTH = 16;
const MAX_FILES_PER_FEATURE = 5_000;
const MAX_TOTAL_FILES = 50_000;

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

/**
 * Recursively collect every file relpath under `absStart`.
 *
 * Cycle protection: tracks the realpath of each visited directory in
 * the `seen` set so two intra-project symlinks pointing at each other
 * (e.g. `a/sym → ../b` + `b/sym → ../a`) terminate cleanly. Each
 * directory is realpath'd ONCE per walk; descendants reached via a
 * previously-visited realpath are skipped. (`listFilteredChildren`
 * already realpaths each entry for the inside-root predicate, but
 * doesn't expose the result, so we re-realpath here.)
 *
 * Hard caps:
 *   - `depth > MAX_DEPTH` aborts the subtree (returns silently).
 *   - `out.length >= MAX_FILES_PER_FEATURE` truncates this feature.
 *   - `totalCount.value >= MAX_TOTAL_FILES` aborts the whole scan.
 *
 * `totalCount` is shared across every feature in a scan via the
 * caller-supplied object so we get a global ceiling, not a per-feature
 * one.
 */
async function walkFilesUnder(
  realRoot: string,
  absStart: string,
  relStart: string,
  out: string[],
  seen: Set<string>,
  totalCount: { value: number },
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  if (out.length >= MAX_FILES_PER_FEATURE) return;
  if (totalCount.value >= MAX_TOTAL_FILES) return;

  const children = await listFilteredChildren(realRoot, absStart, relStart);
  for (const c of children) {
    if (out.length >= MAX_FILES_PER_FEATURE) return;
    if (totalCount.value >= MAX_TOTAL_FILES) return;

    if (c.kind === "file") {
      out.push(c.relPath);
      totalCount.value += 1;
      continue;
    }

    // Realpath dirs before descending; skip if we've been here already
    // via any other path (cycle guard). A `realpath` failure is treated
    // as "skip" — listFilteredChildren already filtered escaping
    // symlinks, so a failure here is a transient FS error, not a
    // security boundary breach.
    let realDir: string;
    try {
      realDir = await realpath(c.abs);
    } catch {
      continue;
    }
    if (seen.has(realDir)) continue;
    seen.add(realDir);

    await walkFilesUnder(realRoot, c.abs, c.relPath, out, seen, totalCount, depth + 1);
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
  // Shared global file counter so MAX_TOTAL_FILES bounds the scan,
  // not the per-feature subtree.
  const totalCount = { value: 0 };

  for (const rootRel of roots) {
    if (totalCount.value >= MAX_TOTAL_FILES) break;
    const absRoot = join(realRoot, rootRel);
    const children = await listFilteredChildren(realRoot, absRoot, rootRel);
    // Sort children for deterministic slug-claim order. readdir order
    // is FS-defined; without sorting, the "first seen wins" rule would
    // produce different prefixes across runs.
    children.sort((a, b) => a.relPath.localeCompare(b.relPath));

    for (const dir of children) {
      if (dir.kind !== "dir") continue;
      if (totalCount.value >= MAX_TOTAL_FILES) break;
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

      // Cycle-guard set is per-feature: a sym-cycle inside featA
      // shouldn't shadow any same-realpath under featB (they shouldn't
      // overlap in practice, but per-feature is the safer default).
      // Seed with the feature's root realpath so a child symlink
      // pointing back at the parent is caught on the first descent.
      const seen = new Set<string>();
      try {
        seen.add(await realpath(dir.abs));
      } catch {
        // Unreachable in practice — listFilteredChildren already
        // realpath'd this entry — but skip rather than throw.
        continue;
      }

      const files: string[] = [];
      await walkFilesUnder(
        realRoot,
        dir.abs,
        dir.relPath,
        files,
        seen,
        totalCount,
        /* depth */ 0,
      );
      if (files.length < MIN_FILES_PER_FEATURE) continue;
      files.sort();

      seenSlugs.add(slug);
      features.push({
        name: slug,
        description: `Files under ${featureRelPath}`,
        originPath: featureRelPath,
        files,
      });
    }
  }

  features.sort((a, b) => a.name.localeCompare(b.name));
  return features;
}
