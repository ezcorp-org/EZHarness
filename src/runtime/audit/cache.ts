import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FeatureFile } from "../../db/schema";
import type { SurfaceVerdicts } from "../../db/schema";
import {
  getClassification,
  pruneStaleClassifications,
  upsertClassification,
} from "../../db/queries/feature-classifications";

/**
 * Bytes of each file head folded into the content hash. Capped so a huge
 * source file can't blow memory on hashing — the goal is "did the
 * relevant API surface change", not "did any byte change". Combined with
 * sorted relpaths, the hash flips when files are added/removed/renamed
 * or when the head of any file changes.
 */
const HASH_FILE_HEAD_BYTES = 4_096;

/**
 * Stable per-feature content hash. Inputs:
 *   - sorted relpaths (catches add/remove/rename)
 *   - first 4 KiB of each file's bytes (catches imports/declarations
 *     near the top, which is what classification rules care about)
 */
export async function computeContentHash(
  files: FeatureFile[],
  projectRoot: string,
): Promise<string> {
  const sorted = [...files].sort((a, b) => a.relpath.localeCompare(b.relpath));
  const hasher = createHash("sha256");
  for (const f of sorted) {
    hasher.update("\x00path:");
    hasher.update(f.relpath);
    hasher.update("\x00head:");
    try {
      const file = Bun.file(join(projectRoot, f.relpath));
      const exists = await file.exists();
      if (!exists) {
        hasher.update("(missing)");
        continue;
      }
      const slice = file.slice(0, HASH_FILE_HEAD_BYTES);
      const buf = new Uint8Array(await slice.arrayBuffer());
      hasher.update(buf);
    } catch {
      hasher.update("(unreadable)");
    }
  }
  return hasher.digest("hex");
}

export interface CachedVerdict {
  surfaces: SurfaceVerdicts;
  rationale: string;
  fromCache: boolean;
}

/**
 * Cache wrapper: if a row exists for (featureId, contentHash), return it
 * without invoking `compute`. Otherwise compute, persist, and prune any
 * older hashes for this feature so the table stays single-row in steady
 * state.
 */
export async function withCache(
  featureId: string,
  contentHash: string,
  compute: () => Promise<{ surfaces: SurfaceVerdicts; rationale: string }>,
): Promise<CachedVerdict> {
  const hit = await getClassification(featureId, contentHash);
  if (hit) {
    return { surfaces: hit.surfaces, rationale: hit.rationale, fromCache: true };
  }
  const fresh = await compute();
  await upsertClassification({
    featureId,
    contentHash,
    surfaces: fresh.surfaces,
    rationale: fresh.rationale,
  });
  await pruneStaleClassifications(featureId, contentHash);
  return { ...fresh, fromCache: false };
}
