// ── quarantine.ts — reversible-delete planning + prune selection ────
//
// Deletes are NEVER hard. A "delete" moves the file into
// `.trash/<id>/<basename>` and records an undo manifest entry. Only the
// TTL/size-cap prune ever hard-deletes. This module is pure: it PLANS the
// trash move + manifest record and SELECTS prune victims; the host
// applier executes the plan with raw node:fs.

import { basename, extname, join } from "node:path";

/** One undo-ledger entry: where a quarantined file came from. */
export interface QuarantineEntry {
  id: string;
  originalPath: string;
  /** Path inside `.trash/<id>/` where the file now lives. */
  trashPath: string;
  proposalId: string | null;
  reason: string;
  deletedAt: string;
  /** Daemon batch (fully-auto) — undo-last-batch groups on this. */
  batchId: string | null;
  size: number;
  /** TTL expiry (ms epoch). Past this the prune may hard-delete it. */
  expiresAtMs: number;
}

/** On-disk `.trash/manifest.json`. */
export interface QuarantineManifest {
  entries: QuarantineEntry[];
  schemaVersion: number;
}

export const QUARANTINE_SCHEMA_VERSION = 1;

export function emptyManifest(): QuarantineManifest {
  return { entries: [], schemaVersion: QUARANTINE_SCHEMA_VERSION };
}

// ── Non-overwrite suffix resolution ─────────────────────────────────

/**
 * Given a desired path and a predicate telling whether a candidate path
 * already exists, return a collision-free path by inserting ` (2)`,
 * ` (3)`, … before the extension. Deterministic. Caps at 9999 attempts
 * (then appends a random-ish suffix) so it always terminates.
 */
export function resolveNonOverwrite(
  desiredPath: string,
  exists: (p: string) => boolean,
): string {
  if (!exists(desiredPath)) return desiredPath;
  const dir = desiredPath.slice(0, desiredPath.length - basename(desiredPath).length);
  const ext = extname(desiredPath);
  const stem = basename(desiredPath).slice(0, basename(desiredPath).length - ext.length);
  for (let n = 2; n <= 9999; n++) {
    const candidate = `${dir}${stem} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${dir}${stem} (${Date.now()})${ext}`;
}

// ── Quarantine plan ─────────────────────────────────────────────────

export interface QuarantinePlan {
  /** Directory `.trash/<id>/` to create. */
  trashDir: string;
  /** Final path inside trash (collision-resolved). */
  trashPath: string;
  entry: QuarantineEntry;
}

/**
 * Plan a quarantine move. `trashRoot` is the absolute `.trash/`
 * directory; `id` is a fresh quarantine id. `exists` lets us pick a
 * collision-free leaf inside the per-id dir (normally none, but defensive).
 */
export function planQuarantine(
  input: {
    trashRoot: string;
    id: string;
    originalPath: string;
    proposalId: string | null;
    reason: string;
    batchId: string | null;
    size: number;
    now: number;
    ttlMs: number;
  },
  exists: (p: string) => boolean,
): QuarantinePlan {
  const trashDir = join(input.trashRoot, input.id);
  const desired = join(trashDir, basename(input.originalPath));
  const trashPath = resolveNonOverwrite(desired, exists);
  const entry: QuarantineEntry = {
    id: input.id,
    originalPath: input.originalPath,
    trashPath,
    proposalId: input.proposalId,
    reason: input.reason,
    deletedAt: new Date(input.now).toISOString(),
    batchId: input.batchId,
    size: input.size,
    expiresAtMs: input.now + input.ttlMs,
  };
  return { trashDir, trashPath, entry };
}

/** Append an entry to the manifest. Pure. */
export function recordQuarantine(
  manifest: QuarantineManifest,
  entry: QuarantineEntry,
): QuarantineManifest {
  return { ...manifest, entries: [...manifest.entries, entry] };
}

// ── Restore plan ────────────────────────────────────────────────────

export interface RestorePlan {
  trashPath: string;
  /** Collision-resolved restore destination. */
  restorePath: string;
  entry: QuarantineEntry;
}

/**
 * Plan a restore of a quarantined entry back to its original location,
 * resolving collisions with a non-overwrite suffix. Returns null when the
 * id isn't in the manifest.
 */
export function planRestore(
  manifest: QuarantineManifest,
  id: string,
  exists: (p: string) => boolean,
): RestorePlan | null {
  const entry = manifest.entries.find((e) => e.id === id);
  if (!entry) return null;
  const restorePath = resolveNonOverwrite(entry.originalPath, exists);
  return { trashPath: entry.trashPath, restorePath, entry };
}

/** Remove an entry from the manifest by id. Pure. */
export function removeEntry(manifest: QuarantineManifest, id: string): QuarantineManifest {
  return { ...manifest, entries: manifest.entries.filter((e) => e.id !== id) };
}

// ── Prune selection (TTL + size cap) ────────────────────────────────

/**
 * Select quarantine entries to HARD-DELETE during a prune. Two triggers:
 *   1. TTL — any entry whose `expiresAtMs <= now`.
 *   2. Size cap — if total quarantine bytes exceed `capBytes` (0 = off),
 *      evict oldest-first (LRU by deletedAt) until under the cap.
 *
 * Entries pinned by `protectedIds` (e.g. an in-flight restore) are NEVER
 * selected. Pure — returns the ids to delete.
 */
export function selectPruneVictims(
  manifest: QuarantineManifest,
  opts: { now: number; capBytes: number; protectedIds?: ReadonlySet<string> },
): string[] {
  const protectedIds = opts.protectedIds ?? new Set<string>();
  const victims = new Set<string>();

  // 1. TTL sweep.
  for (const e of manifest.entries) {
    if (protectedIds.has(e.id)) continue;
    if (e.expiresAtMs <= opts.now) victims.add(e.id);
  }

  // 2. Size-cap LRU eviction (only if a cap is set).
  if (opts.capBytes > 0) {
    const remaining = manifest.entries
      .filter((e) => !victims.has(e.id) && !protectedIds.has(e.id))
      .sort((a, b) => new Date(a.deletedAt).getTime() - new Date(b.deletedAt).getTime());
    let total = remaining.reduce((sum, e) => sum + e.size, 0);
    for (const e of remaining) {
      if (total <= opts.capBytes) break;
      victims.add(e.id);
      total -= e.size;
    }
  }

  return [...victims];
}
