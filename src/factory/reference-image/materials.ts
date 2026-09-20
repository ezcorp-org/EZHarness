/**
 * Sealing what a generation guest wrote into its material mount.
 *
 * A guest may emit at most a mebibyte over the control channel for its whole
 * life, and a 1,024-pixel variant is larger than that, so the bytes leave
 * through the mount instead. Everything in that directory is untrusted input:
 * it is the one place the guest can write, and a guest that wanted to could
 * plant a symlink, a device node, or a file it never declared.
 *
 * Three rules make the read-back trustworthy, and none of them is optional.
 *
 * The walk and every open go through `listRunnerMaterials` and
 * `openRunnerMaterial`. This module calls no `readdir` and no `open` of its
 * own, because those helpers are where `O_NOFOLLOW`, the regular-file check and
 * the non-blocking open live, and a second implementation would be a second
 * place for that to be got wrong.
 *
 * The set the guest declared and the set on disk must agree exactly. An extra
 * file is a guest writing something it did not admit to, and a missing one is a
 * claim about bytes that are not there; both are refused rather than
 * reconciled.
 *
 * Every file's digest is recomputed from the bytes read back and compared with
 * what the guest claimed. Without that, a truncated write is indistinguishable
 * from a complete one, and a partial PNG still decodes into a picture.
 *
 * Read back only after the guest is confirmed stopped. A running guest can swap
 * a directory component between the walk and the open, and nothing on this side
 * can close that race.
 */
import { createHash } from "node:crypto";

import { listRunnerMaterials, openRunnerMaterial } from "@ezcorp/extension-runner";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";

import {
  FACTORY_MATERIAL_LIMITS,
  factoryMaterialDigest,
  type FactoryMaterialChunk,
  type FactoryMaterialIdentity,
  type FactoryMaterialRecord,
  type FactoryMaterialScope,
} from "../artifact-materials.ts";

/**
 * Exactly the three calls this module makes, and no more.
 *
 * `FactoryMaterialService` also lists and reads; sealing needs neither.
 * Depending on the whole surface would make every caller and every double
 * implement methods this code never reaches, which is how a test double stops
 * resembling the thing it stands for. `FactoryAttemptMaterials` satisfies this
 * structurally, so the production path passes one unchanged.
 */
export interface GuestMaterialSink {
  begin(identity: FactoryMaterialIdentity, mediaType: string, totalBytes: number, chunkCount: number, signal?: AbortSignal): Promise<FactoryMaterialRecord>;
  writeChunk(identity: FactoryMaterialIdentity, chunk: FactoryMaterialChunk, content: Uint8Array, signal?: AbortSignal): Promise<FactoryMaterialRecord>;
  seal(identity: FactoryMaterialIdentity, digest: string, signal?: AbortSignal): Promise<FactoryArtifactReference>;
}

/** What the guest said it left behind, reported over the control channel. */
export interface GuestMaterialClaim {
  /** Relative to the material root, with forward slashes. */
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly mediaType: string;
}

export interface SealedGuestMaterial {
  readonly path: string;
  readonly objectName: string;
  readonly version: number;
  readonly digest: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly artifact: FactoryArtifactReference;
}

export class ReferenceImageMaterialError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReferenceImageMaterialError";
  }
}

function refuse(code: string, message: string): never {
  throw new ReferenceImageMaterialError(code, message);
}

/**
 * The bounds the read-back walk runs under.
 *
 * They are W04's own, not a second set: a tree the walk accepted but the
 * material store would refuse is a failure discovered one layer too late.
 */
export const REFERENCE_IMAGE_MATERIAL_BOUNDS = Object.freeze({
  maxEntries: FACTORY_MATERIAL_LIMITS.maxObjectsPerOperation,
  maxTotalBytes: FACTORY_MATERIAL_LIMITS.maxTotalBytes,
  maxDepth: 4,
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Reads one guest-written file whole, through the shared opener only. */
async function readMaterial(directory: string, entry: string, expectedBytes: number): Promise<Uint8Array> {
  const handle = await openRunnerMaterial(directory, entry);
  try {
    const bytes = new Uint8Array(await handle.readFile());
    if (bytes.byteLength !== expectedBytes) {
      refuse("reference_image_material_size", `Material ${entry} read ${bytes.byteLength} bytes where the walk measured ${expectedBytes}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * The object name a guest-written file takes in the material store.
 *
 * The guest chooses a path inside its mount and the store needs a name that is
 * unique within the operation, so the two are kept distinct rather than
 * assumed equal. A path that would exceed the store's name limit is refused
 * here, where the offending name can be reported, rather than inside `begin`.
 */
export function guestMaterialObjectName(path: string, prefix = "guest/"): string {
  const objectName = `${prefix}${path}`;
  if (objectName.length > FACTORY_MATERIAL_LIMITS.maxNameLength) {
    refuse("reference_image_material_name", `Material name ${objectName} exceeds ${FACTORY_MATERIAL_LIMITS.maxNameLength} characters`);
  }
  return objectName;
}

export interface SealGuestMaterialsInput {
  /** The host-owned per-attempt directory that was bind-mounted at `/materials`. */
  readonly directory: string;
  /** What the guest declared it wrote, from its result frame. */
  readonly claims: readonly GuestMaterialClaim[];
  readonly materials: GuestMaterialSink;
  readonly scope: FactoryMaterialScope;
  readonly objectNamePrefix?: string;
  readonly signal?: AbortSignal;
}

/**
 * Reads back, verifies, and seals everything the guest left in its mount.
 *
 * The order is the rule: walk first so the bounds apply before anything is
 * read, then reconcile the two sets, then verify each file's bytes, and only
 * then write to the store. Sealing a file before checking it would put
 * unverified bytes somewhere durable.
 */
export async function sealGuestMaterials(input: SealGuestMaterialsInput): Promise<readonly SealedGuestMaterial[]> {
  const found = await listRunnerMaterials(input.directory, REFERENCE_IMAGE_MATERIAL_BOUNDS);
  const claimed = new Map(input.claims.map(claim => [claim.path, claim]));
  if (claimed.size !== input.claims.length) refuse("reference_image_material_duplicate", "The guest claimed the same material path twice");

  const onDisk = new Set(found.map(entry => entry.path));
  for (const entry of found) {
    if (!claimed.has(entry.path)) refuse("reference_image_material_undeclared", `The guest left ${entry.path} in its mount without declaring it`);
  }
  for (const claim of input.claims) {
    if (!onDisk.has(claim.path)) refuse("reference_image_material_missing", `The guest declared ${claim.path} and did not write it`);
  }

  const sealed: SealedGuestMaterial[] = [];
  for (const entry of found) {
    const claim = claimed.get(entry.path) as GuestMaterialClaim;
    if (claim.bytes !== entry.bytes) {
      refuse("reference_image_material_size", `The guest declared ${claim.bytes} bytes for ${entry.path} and wrote ${entry.bytes}`);
    }
    const bytes = await readMaterial(input.directory, entry.path, entry.bytes);
    const digest = sha256(bytes);
    if (digest !== claim.digest) {
      refuse("reference_image_material_digest", `The guest declared ${claim.digest} for ${entry.path} and the bytes read back digest ${digest}`);
    }

    const objectName = guestMaterialObjectName(entry.path, input.objectNamePrefix);
    const identity: FactoryMaterialIdentity = { ...input.scope, objectName, version: 1 };
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += FACTORY_MATERIAL_LIMITS.maxChunkBytes) {
      parts.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + FACTORY_MATERIAL_LIMITS.maxChunkBytes)));
    }
    const begun = await input.materials.begin(identity, claim.mediaType, bytes.byteLength, parts.length, input.signal);
    // A replayed seal returns the handle it already issued. Different bytes
    // under the same name is a conflict, never an overwrite.
    if (begun.sealed) {
      if (begun.digest !== digest || begun.artifact === undefined) {
        refuse("reference_image_material_conflict", `Material ${objectName} is already sealed with different bytes`);
      }
      sealed.push({ path: entry.path, objectName, version: identity.version, digest, bytes: bytes.byteLength, mediaType: claim.mediaType, artifact: begun.artifact });
      continue;
    }
    for (const [index, part] of parts.entries()) {
      await input.materials.writeChunk(identity, { index, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part, input.signal);
    }
    const artifact = await input.materials.seal(identity, digest, input.signal);
    sealed.push({ path: entry.path, objectName, version: identity.version, digest, bytes: bytes.byteLength, mediaType: claim.mediaType, artifact });
  }
  return Object.freeze(sealed);
}
