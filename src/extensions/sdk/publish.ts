/**
 * Extension publish workflow -- validates, authenticates, and publishes
 * extensions to the marketplace from the CLI.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { getPublishToken } from "./config";
import { generateSlug } from "../manifest";
import { loadManifest } from "../loader";
import { computePackageChecksums } from "../checksum";
import { initDb } from "../../db/connection";
import { createListing, getListingBySlug } from "../../db/queries/marketplace";
import { createVersion, getVersion } from "../../db/queries/marketplace-versions";
import type { ExtensionManifestV2 } from "../types";
import { logger } from "../../logger";
const log = logger.child("ext-sdk");

export interface PublishOptions {
  extDir?: string; // defaults to cwd
  token?: string; // --token flag override
  skipTests?: boolean; // skip test run (for testing publish flow itself)
}

/**
 * Publish an extension to the marketplace.
 * Runs a linear validation pipeline that fails fast with clear errors.
 */
export async function publishExtension(opts?: PublishOptions): Promise<void> {
  const extDir = opts?.extDir ?? process.cwd();

  // 1. Resolve token
  const token = await getPublishToken(opts?.token);
  if (!token) {
    throw new Error(
      "No publish token found. Generate one at Settings > Developer, then run: " +
        "ezcorp ext publish --token <token> or save to ~/.ezcorp/config.json",
    );
  }

  // 2. Verify token against DB
  await initDb();
  const userId = await verifyToken(token);

  // 3. Read and validate manifest
  const manifest = await loadManifest(extDir);

  // 5. Check entrypoint exists (if declared)
  if (manifest.entrypoint) {
    const entrypointFile = Bun.file(join(extDir, manifest.entrypoint));
    if (!(await entrypointFile.exists())) {
      throw new Error(`Entrypoint file not found: ${manifest.entrypoint}`);
    }
  }

  // 6. Run tests (unless skipped)
  if (!opts?.skipTests) {
    const { runExtensionTests } = await import("./test-runner");
    const exitCode = await runExtensionTests({ extDir });
    if (exitCode !== 0) {
      throw new Error("Tests failed. Fix test failures before publishing.");
    }
  }

  // 7. Check for existing version
  const slug = generateSlug(manifest.name);
  let listing = await getListingBySlug(slug);

  if (listing) {
    const existingVersion = await getVersion(listing.id, manifest.version);
    if (existingVersion) {
      throw new Error(
        `Version ${manifest.version} already published. Bump version in ezcorp.config.ts.`,
      );
    }
  }

  // 8. Compute checksums
  const packageChecksums = await computePackageChecksums(extDir);

  // 9. Create listing if new
  if (!listing) {
    listing = await createListing({
      authorId: userId,
      name: manifest.name,
      description: manifest.description,
      category: ((manifest as unknown as Record<string, unknown>).category as string) ?? "Other",
      tags: ((manifest as unknown as Record<string, unknown>).tags as string[]) ?? [],
      latestVersion: manifest.version,
    });
  }

  // 10. Create version record with checksums in manifest
  const manifestWithChecksums = { ...manifest, packageChecksums };
  await createVersion(
    listing.id,
    manifest.version,
    manifestWithChecksums as ExtensionManifestV2,
    (manifest as unknown as Record<string, unknown>).changelog as string | undefined,
  );

  // 11. Success
  log.info("Published extension", { name: manifest.name, version: manifest.version });
}

/**
 * SHA-256 hex digest of a publish token.
 * Must stay in sync with `hashApiKey` in
 * web/src/lib/server/security/api-keys.ts (not importable here -- it depends
 * on SvelteKit's $server alias), which the settings/developer route uses to
 * hash the token at rest.
 */
function hashPublishToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Verify a publish token against stored token hashes in settings.
 * Returns the userId associated with the token.
 */
async function verifyToken(token: string): Promise<string> {
  // Tokens are stored hashed as publish:token:{userId} -> { tokenHash, createdAt }.
  // We need to scan settings for a matching token. Since we don't have a
  // reverse index, we check all publish:token:* settings.
  // In practice this is a small set (one per developer user).
  const { getAllSettings } = await import("../../db/queries/settings");
  const allSettings = await getAllSettings();

  const presentedHash = Buffer.from(hashPublishToken(token), "hex");

  for (const [key, value] of Object.entries(allSettings)) {
    if (!key.startsWith("publish:token:")) continue;
    const stored = value as { tokenHash?: unknown; createdAt?: number };
    // Legacy plaintext rows ({ token }) have no tokenHash and are treated as
    // invalid -- re-issue the token at Settings > Developer.
    if (typeof stored.tokenHash !== "string") continue;
    const storedHash = Buffer.from(stored.tokenHash, "hex");
    if (storedHash.length !== presentedHash.length) continue;
    if (timingSafeEqual(storedHash, presentedHash)) {
      return key.replace("publish:token:", "");
    }
  }

  throw new Error("Invalid publish token");
}
