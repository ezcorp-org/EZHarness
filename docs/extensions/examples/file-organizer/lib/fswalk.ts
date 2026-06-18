// ── fswalk.ts — pure walk planner + hashcache decision logic ────────
//
// Directory traversal is split into a PURE planner (this module) and the
// host's raw-node:fs executor (the daemon). The planner decides: which
// dirents to descend, when to stop (depth bound, work budget), how to
// break symlink loops (visited inode set), and when a file must be
// re-hashed (size/mtime changed vs the hashcache). IO is injected via a
// `DirReader` so the planner is unit-testable with an in-memory tree.

import { join } from "node:path";

/** One directory entry from the injected reader. */
export interface WalkDirent {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  /** inode id for loop detection (dev+ino composite). */
  inodeKey: string;
  size: number;
  mtimeMs: number;
  nlink: number;
}

/** Injected directory reader. Returns the immediate children of `dir`. */
export interface DirReader {
  read(dir: string): Promise<WalkDirent[]>;
}

export interface WalkOptions {
  /** Max directory depth below the root (root = depth 0). */
  maxDepth: number;
  /** Max files+dirs to VISIT per tick (work budget). */
  budget: number;
  /** Ignore predicate — true ⇒ skip this path and its subtree. */
  isIgnored: (path: string) => boolean;
  /** Round-robin cursor: resume after this path (skip already-seen). */
  resumeAfter?: string | null;
}

export interface WalkResult {
  /** Files discovered (non-dir, within budget). */
  files: WalkDirent[];
  /** Where to resume next tick (last visited path), or null when complete. */
  cursor: string | null;
  /** True when the whole tree was walked (cursor exhausted). */
  complete: boolean;
  /** Count of dirents visited (for budget accounting / circuit-breaker). */
  visited: number;
}

/**
 * Walk a directory tree breadth-controlled with a depth bound, symlink
 * loop break (visited-inode set), and a per-tick work budget. When the
 * budget is hit mid-walk, returns a `cursor` so the next tick resumes
 * roughly where it left off (round-robin fairness across large trees).
 *
 * Symlinked DIRECTORIES are never descended (v1 policy); symlinked files
 * are reported (so the daemon can record `isSymlink` + skip them in
 * rules). Already-visited inodes are skipped (hardlink/loop safety).
 */
export async function walk(
  root: string,
  reader: DirReader,
  opts: WalkOptions,
): Promise<WalkResult> {
  const files: WalkDirent[] = [];
  const visitedInodes = new Set<string>();
  let visited = 0;
  let cursor: string | null = null;
  let resumeReached = opts.resumeAfter == null;

  // Explicit stack of (dir, depth) so recursion depth can't blow the
  // JS stack on a deep tree.
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.shift()!;
    if (opts.isIgnored(dir)) continue;

    let entries: WalkDirent[];
    try {
      entries = await reader.read(dir);
    } catch {
      // ESTALE/EIO/permission — skip this dir, never treat as "empty/deleted".
      continue;
    }
    // Deterministic order so the cursor is stable across ticks.
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    for (const e of entries) {
      if (opts.isIgnored(e.path)) continue;

      // Round-robin resume: skip everything up to and including the
      // resume cursor, then start collecting.
      if (!resumeReached) {
        if (e.path === opts.resumeAfter) resumeReached = true;
        continue;
      }

      // Loop break: a previously-visited inode (symlink cycle / hardlink).
      if (visitedInodes.has(e.inodeKey)) continue;
      visitedInodes.add(e.inodeKey);

      visited++;
      cursor = e.path;

      if (e.isDirectory && !e.isSymlink) {
        if (depth + 1 <= opts.maxDepth) stack.push({ dir: e.path, depth: depth + 1 });
      } else if (e.isFile || e.isSymlink) {
        files.push(e);
      }

      if (visited >= opts.budget) {
        // Budget exhausted mid-walk — resume here next tick.
        return { files, cursor, complete: false, visited };
      }
    }
  }

  // Walked everything in range — reset the cursor for a fresh pass.
  return { files, cursor: null, complete: true, visited };
}

// ── Hashcache decision ──────────────────────────────────────────────

/** Cached hash record per path. */
export interface HashCacheEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export type HashCache = Record<string, HashCacheEntry>;

/** Default ceiling above which files are NOT hashed for dedup (too big). */
export const DEFAULT_MAX_HASH_BYTES = 256 * 1024 * 1024; // 256MB

/**
 * Decide whether a file needs re-hashing. Returns:
 *   - "skip": file exceeds `maxHashBytes` — never hashed (lazy/large).
 *   - "hit":  the cache entry's size+mtime match — reuse cached sha256.
 *   - "miss": no entry or size/mtime changed — must re-hash.
 *
 * This is THE perf lever: we only re-stream a file when its size or mtime
 * moved since the last hash.
 */
export function hashDecision(
  file: { path: string; size: number; mtimeMs: number },
  cache: HashCache,
  maxHashBytes: number = DEFAULT_MAX_HASH_BYTES,
): "skip" | "hit" | "miss" {
  if (file.size > maxHashBytes) return "skip";
  const e = cache[file.path];
  if (e && e.size === file.size && e.mtimeMs === file.mtimeMs) return "hit";
  return "miss";
}

/** Update the hashcache with a fresh hash. Returns a NEW cache (pure). */
export function updateHashCache(
  cache: HashCache,
  path: string,
  entry: HashCacheEntry,
): HashCache {
  return { ...cache, [path]: entry };
}

/**
 * Build a content-hash → paths index from a hashcache snapshot, for
 * duplicate detection. Only paths with a known sha256 participate. Pure.
 */
export function buildDuplicateIndex(cache: HashCache): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const [path, e] of Object.entries(cache)) {
    const arr = idx.get(e.sha256) ?? [];
    arr.push(path);
    idx.set(e.sha256, arr);
  }
  return idx;
}

/**
 * For every duplicate group (same sha256, >1 path) decide which copies are
 * REDUNDANT — i.e. safe to quarantine — keeping exactly ONE canonical copy
 * per hash. The canonical is the OLDEST copy (smallest `mtimeMs`); ties
 * break on the lexicographically smallest path so the choice is fully
 * deterministic across ticks. Returns the set of NON-canonical paths.
 *
 * This is the data-safety guard for `duplicate-killer`: flagging every
 * member of a hash group (the naive `length > 1`) would quarantine ALL
 * copies in fully-auto. Keeping one canonical means a dedup never deletes
 * the last instance of a file's content.
 */
export function duplicatePathsToRemove(cache: HashCache): Set<string> {
  const remove = new Set<string>();
  for (const paths of buildDuplicateIndex(cache).values()) {
    if (paths.length <= 1) continue;
    let canonical = paths[0]!;
    for (const p of paths) {
      const cm = cache[canonical]!.mtimeMs;
      const pm = cache[p]!.mtimeMs;
      // Oldest wins; tie-break on lexicographically smallest path.
      if (pm < cm || (pm === cm && p < canonical)) canonical = p;
    }
    for (const p of paths) if (p !== canonical) remove.add(p);
  }
  return remove;
}

/**
 * The set of content hashes that appear on MORE THAN ONE path in the
 * cache (i.e. the hash of every file belonging to a duplicate group).
 * A file whose sha256 is in this set is a "known" duplicate-group member
 * — used to exclude both the kept canonical and the removed copies from
 * the `unclassified` alert. Pure.
 */
export function duplicateHashes(cache: HashCache): Set<string> {
  const dupes = new Set<string>();
  for (const [hash, paths] of buildDuplicateIndex(cache)) {
    if (paths.length > 1) dupes.add(hash);
  }
  return dupes;
}

/** Resolve a destination path for a route under a subfolder of the root. */
export function joinRoot(root: string, ...segments: string[]): string {
  return join(root, ...segments);
}

// ── Stability gate ──────────────────────────────────────────────────

/**
 * Partial-download / in-progress suffixes the daemon never acts on.
 *
 * NOTE: `.tmp` is intentionally NOT here. A bare `.tmp` file is a
 * legitimate junk-sweep target (and the stability gate already defers any
 * file still being written). The genuinely-transient markers are the
 * browser/download partials below plus the `~$` office-lock prefix.
 */
export const UNSTABLE_SUFFIXES = [".crdownload", ".part", ".partial", ".download"] as const;

/** True for transient/partial-write names that must be skipped until done. */
export function isUnstableName(name: string): boolean {
  if (name.startsWith("~$")) return true; // Office lock files
  return UNSTABLE_SUFFIXES.some((s) => name.toLowerCase().endsWith(s));
}

/** Per-path stability tracking: how many consecutive ticks size+mtime held. */
export interface StabilityState {
  size: number;
  mtimeMs: number;
  quietTicks: number;
}

export type StabilityMap = Record<string, StabilityState>;

/**
 * Update stability tracking for a file and report whether it is now
 * STABLE (quiescent for `requiredTicks`). A size/mtime change resets the
 * counter. Returns the new state + a `stable` flag. Pure.
 */
export function tickStability(
  prev: StabilityState | undefined,
  file: { size: number; mtimeMs: number },
  requiredTicks: number,
): { state: StabilityState; stable: boolean } {
  const unchanged = prev !== undefined && prev.size === file.size && prev.mtimeMs === file.mtimeMs;
  const quietTicks = unchanged ? prev.quietTicks + 1 : 0;
  const state: StabilityState = { size: file.size, mtimeMs: file.mtimeMs, quietTicks };
  return { state, stable: quietTicks >= requiredTicks };
}
