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
 * Compute SHA-256 checksums for all non-excluded files in a directory.
 * Returns a map of relative paths to hex-encoded SHA-256 hashes.
 */
export async function computePackageChecksums(
  dir: string,
): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  const glob = new Bun.Glob("**/*");

  for await (const relPath of glob.scan({ cwd: dir, dot: true })) {
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

export interface PackageVerifyResult {
  valid: boolean;
  mismatched: string[];
}

/**
 * Verify all file checksums in a directory against expected values.
 * Detects modifications (changed hash), additions (new files), and removals (missing files).
 */
export async function verifyPackageChecksums(
  dir: string,
  expected: Record<string, string>,
): Promise<PackageVerifyResult> {
  const current = await computePackageChecksums(dir);
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
