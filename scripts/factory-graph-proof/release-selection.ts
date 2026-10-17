/**
 * Which staged built-in runner release a proof activates (W4H-28, validator Addendum Z2).
 *
 * Every boot of a kept deployment can stage a release; the proof must activate the one built from the bytes this
 * repository ships, never merely the newest. The expected digest is the bundled runner source's digest, computed
 * exactly as the boot stages it; the newest release WITH that digest is picked, and no match is a named failure.
 */
import { digestObject } from "../../src/extensions/v4/blobs";
import { referenceCodeRunnerPackageFiles } from "../../src/factory/reference-code/runner-packages";

export class ReleaseSelectionError extends Error {
  readonly code = "release_digest_mismatch";
  constructor(readonly expected: string, readonly staged: readonly string[]) {
    super(`release_digest_mismatch: no staged release has source digest ${expected} (staged: ${staged.join(", ") || "none"})`);
    this.name = "ReleaseSelectionError";
  }
}

interface StagedRelease { readonly id: string; readonly sourceDigest: string; readonly createdAt: string }

/** The source digest the boot stages for a built-in runner package. */
export async function expectedRunnerSourceDigest(manifestName: string): Promise<string> {
  return digestObject(await referenceCodeRunnerPackageFiles(manifestName));
}

/** The id of the newest staged release whose source digest is the expected one. */
export function selectStagedRelease(releases: Readonly<Record<string, StagedRelease>> | undefined, expectedSourceDigest: string): string {
  const all = Object.values(releases ?? {});
  const matching = all.filter((release) => release.sourceDigest === expectedSourceDigest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (matching.length === 0) throw new ReleaseSelectionError(expectedSourceDigest, all.map((release) => release.sourceDigest));
  return matching[0]!.id;
}
