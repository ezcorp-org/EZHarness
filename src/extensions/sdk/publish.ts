/**
 * Extension publish workflow -- validates, authenticates, and publishes
 * extensions to the marketplace from the CLI.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { sealPublishedRelease, validateWire } from "@ezcorp/extension-contract";
import { getPublishToken } from "./config";
import { generateSlug } from "../manifest";
import { getCliExtensionRunner, verifyCliExtension } from "../cli-control";
import { getUserById } from "../../db/queries/users";
import { initDb } from "../../db/connection";
import { createListing, getListingBySlug } from "../../db/queries/marketplace";
import { createVersion, getVersion } from "../../db/queries/marketplace-versions";
import type { ExtensionManifestV2 } from "../types";
import { logger } from "../../logger";
const log = logger.child("ext-sdk");

export interface PublishOptions {
  extDir?: string;     // defaults to cwd
  token?: string;      // --token flag override
  skipTests?: boolean;
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
      "ezcorp ext publish --token <token> or save to ~/.ezcorp/config.json"
    );
  }

  // 2. Verify token against DB
  await initDb();
  const userId = await verifyToken(token);

  if (opts?.skipTests) throw new Error("Release verification cannot be skipped");
  const user = await getUserById(userId);
  if (user?.status !== "active") throw new Error("An active publisher account is required");
  const build = validateWire("buildResult", await verifyCliExtension(extDir));
  if (build.state !== "succeeded" || !build.manifest || !build.artifactDigest) throw new Error("Isolated build or tests failed; nothing was published");
  const artifacts = await getCliExtensionRunner().collectArtifacts(build.artifactDigest);
  const release = await sealPublishedRelease(build, artifacts);
  const manifest = build.manifest;
  const slug = generateSlug(manifest.name);
  let listing = await getListingBySlug(slug);
  if (listing && listing.authorId !== userId) throw new Error("Only the listing author can publish a version");
  if (listing && await getVersion(listing.id, manifest.version)) throw new Error("Version already published. Bump the extension version.");
  if (await verifyToken(token) !== userId || (await getUserById(userId))?.status !== "active") throw new Error("Publisher authorization changed during verification");
  if (!listing) listing = await createListing({ authorId: userId, name: manifest.name, description: manifest.description, category: manifest.category ?? "Other", tags: manifest.tags ?? [], latestVersion: manifest.version });
  await createVersion(listing.id, manifest.version, manifest as ExtensionManifestV2, undefined, release);
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
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
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
