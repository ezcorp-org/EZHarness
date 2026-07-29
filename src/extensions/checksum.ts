/**
 * SHA-256 checksum computation and verification for extension files.
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";

export async function computeChecksum(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  return hasher.digest("hex");
}

export async function verifyChecksum(filePath: string, expected: string): Promise<boolean> {
  const actual = await computeChecksum(filePath);
  return actual === expected;
}

// ── Full-package Checksums ───────────────────────────────────────────

/** Path segments (VCS/dependency dirs, tool junk files) excluded from package checksums. */
const CHECKSUM_EXCLUDE = new Set([
  ".git",
  ".gitignore",
  ".DS_Store",
  ".gitmodules",
  ".gitattributes",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  "node_modules",
]);

/**
 * Algorithm version stamped on newly-recorded package checksums.
 * `v2` hashes dotfiles (not in the exclude set); the pre-versioning
 * baseline ("v1", represented by an absent/non-"v2" tag) skipped ALL
 * dotfiles. Verify uses the tag to compare a baseline the same way it
 * was recorded, so the dotfile-coverage upgrade can't retroactively
 * flag a pre-existing install as "modified".
 */
export const PACKAGE_CHECKSUM_ALGO = "v2";

/**
 * Compute SHA-256 checksums for all non-excluded files in a directory.
 * Returns a map of relative paths to hex-encoded SHA-256 hashes.
 *
 * `includeDotfiles` defaults to true (the `v2` algorithm). Pass false to
 * reproduce the legacy (`v1`) scan for verifying an old baseline.
 */
export async function computePackageChecksums(
  dir: string,
  opts?: { includeDotfiles?: boolean },
): Promise<Record<string, string>> {
  const includeDotfiles = opts?.includeDotfiles ?? true;
  const checksums: Record<string, string> = {};
  const glob = new Bun.Glob("**/*");

  for await (const relPath of glob.scan({ cwd: dir, dot: includeDotfiles })) {
    // Check each path component against exclusion set. Dotfiles NOT in the
    // exclusion set are hashed — they can carry runtime behavior (e.g. a
    // required dotfile or a .env read by the entrypoint) and must be covered
    // by the integrity check.
    const parts = relPath.split("/");
    if (parts.some((p) => CHECKSUM_EXCLUDE.has(p))) continue;

    // Ensure it's a regular file (not directory)
    const fullPath = join(dir, relPath);
    try {
      const s = await stat(fullPath);
      if (!s.isFile()) continue;
    } catch {
      continue;
    }

    checksums[relPath] = await computeChecksum(fullPath);
  }

  return checksums;
}

/**
 * The checksum block a persisted extension manifest carries: the
 * entrypoint hash plus the full-package baseline and the algorithm tag it
 * was recorded with.
 */
export interface ManifestChecksumFields {
  /** Absent when the manifest declares no entrypoint (agent-/skill-kind). */
  checksum?: string;
  packageChecksums: Record<string, string>;
  packageChecksumsAlgo: string;
}

/**
 * Compute the checksum block for an extension's source directory.
 *
 * EVERY path that persists a manifest — first install, same-source
 * refresh (`installer.ts`) and the bundled boot refresh (`bundled.ts`) —
 * must write this block. It carries integrity data, but it is also the
 * ONLY part of a persisted manifest that moves when an extension's CODE
 * changes without its `ezcorp.config.ts` changing: `ExtensionRegistry.reload()`
 * hashes the persisted manifest to decide whether a live subprocess is
 * still serving current code, so a manifest written without these fields
 * makes an edited entrypoint invisible to the upgrade path and the stale
 * subprocess keeps answering until its idle timeout.
 */
export async function computeManifestChecksums(
  dir: string,
  entrypoint: string | undefined,
): Promise<ManifestChecksumFields> {
  const packageChecksums = await computePackageChecksums(dir);
  const base = { packageChecksums, packageChecksumsAlgo: PACKAGE_CHECKSUM_ALGO };
  if (!entrypoint) return base;
  const checksum = await computeChecksum(join(dir, entrypoint.replace(/^\.\//, "")));
  return { checksum, ...base };
}

export interface PackageVerifyResult {
  valid: boolean;
  mismatched: string[];
}

/**
 * Verify all file checksums in a directory against expected values.
 * Detects modifications (changed hash), additions (new files), and removals (missing files).
 *
 * `algo` is the version the baseline was recorded with. A baseline
 * recorded before dotfile-hashing (absent / not `v2`) is verified WITHOUT
 * dotfiles so the upgrade doesn't retroactively flag those installs as
 * "files added"; `v2` baselines are verified with full dotfile coverage.
 */
export async function verifyPackageChecksums(
  dir: string,
  expected: Record<string, string>,
  algo?: string,
): Promise<PackageVerifyResult> {
  const includeDotfiles = algo === PACKAGE_CHECKSUM_ALGO;
  const current = await computePackageChecksums(dir, { includeDotfiles });
  const mismatched: string[] = [];

  // Check for modified or removed files
  for (const [path, hash] of Object.entries(expected)) {
    if (!(path in current)) {
      mismatched.push(path); // removed
    } else if (current[path] !== hash) {
      mismatched.push(path); // modified
    }
  }

  // Check for added files
  for (const path of Object.keys(current)) {
    if (!(path in expected)) {
      mismatched.push(path); // added
    }
  }

  return { valid: mismatched.length === 0, mismatched };
}
