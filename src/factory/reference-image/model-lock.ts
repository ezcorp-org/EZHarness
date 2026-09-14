/**
 * The model half of the reference image lock.
 *
 * It is a separate module for one reason: the image builder needs the model
 * revision and the file digests to locate and verify a weight closure, and it
 * runs before the full lock can be satisfied, because the guest image digest
 * the full lock requires is the output of the build this serves. Importing the
 * whole lock there would fail at module load on a first build.
 *
 * Splitting it keeps the bootstrap honest rather than merely possible: the
 * builder still validates every binding it relies on instead of reading raw
 * JSON and hoping.
 */
import lockDocument from "./sdxl-lock.json" with { type: "json" };

export class ReferenceImageLockError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReferenceImageLockError";
  }
}

export function invalid(message: string): never {
  throw new ReferenceImageLockError("reference_image_lock_invalid", message);
}

export const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const BLOB = /^[a-f0-9]{40}$/;
export const IMAGE = /^[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}$/;

/**
 * One file of the model closure, bound before it is fetched.
 *
 * Two kinds of file arrive from the model host and they are bound differently.
 * A weight file is stored by content address, so `digest` is the authoritative
 * SHA-256 of its bytes and `blobId` identifies only the small pointer object
 * that stands in for it in the repository tree. A configuration or vocabulary
 * file is stored inline, so it has no `digest` upstream and `blobId` is the
 * SHA-1 over `blob <size>\0` and the content itself, which does bind the bytes.
 *
 * Applying the pointer's identifier to the weight bytes is the mistake this
 * comment exists to prevent; it was made once and caught by the fetcher.
 */
export interface ReferenceImageModelFile {
  readonly path: string;
  readonly bytes: number;
  /** The upstream Git object identifier: the content for a small file, the pointer for a weight. */
  readonly blobId: string;
  /** The model host's SHA-256 over the bytes. Present for content-addressed weight files only. */
  readonly digest?: string;
}

export interface ReferenceImageModelLock {
  readonly source: string;
  readonly repository: string;
  readonly revision: string;
  readonly variant: string;
  readonly pipeline: string;
  readonly files: readonly ReferenceImageModelFile[];
}


/**
 * Validates the model section on its own.
 *
 * The builder still checks every binding it relies on: a revision that is not a
 * commit, an out-of-order or duplicated file list, a file path that escapes the
 * closure, or a weight with no digest would each let the build seal bytes the
 * lock never named.
 */
export function assertReferenceImageModelLock(value: unknown): asserts value is ReferenceImageModelLock {
  if (typeof value !== "object" || value === null) invalid("The model lock must be an object");
  const model = value as Record<string, unknown>;
  if (typeof model.source !== "string" || !model.source.startsWith("https://")) invalid("The model source must be an HTTPS origin");
  if (typeof model.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(model.repository)) invalid("The model repository must be an owner and name");
  if (typeof model.revision !== "string" || !BLOB.test(model.revision)) invalid("The model revision must be a full commit identifier");
  if (typeof model.variant !== "string" || model.variant.length === 0) invalid("The model variant must be named");
  if (typeof model.pipeline !== "string" || model.pipeline.length === 0) invalid("The model pipeline must be named");
  if (!Array.isArray(model.files) || model.files.length === 0) invalid("The model lock must list its files");
  let previous = "";
  let weights = 0;
  for (const entry of model.files as readonly unknown[]) {
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || file.path.length === 0) invalid("Every model file must name a path");
    if (file.path.startsWith("/") || file.path.includes("..")) invalid(`Model file path ${file.path} must stay inside the closure`);
    if (file.path <= previous) invalid(`Model files must be sorted and unique; ${file.path} follows ${previous}`);
    previous = file.path;
    if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) invalid(`Model file ${file.path} must declare its byte count`);
    if (typeof file.blobId !== "string" || !BLOB.test(file.blobId)) invalid(`Model file ${file.path} must declare its blob identifier`);
    if (file.digest !== undefined) {
      if (typeof file.digest !== "string" || !DIGEST.test(file.digest)) invalid(`Model file ${file.path} declares a malformed digest`);
      weights += 1;
    }
  }
  if (weights === 0) invalid("The model lock must pin at least one weight file by digest");
}

/**
 * The committed document's model section, validated on its own.
 *
 * This is what the image builder reads. It deliberately does not parse the whole
 * lock, because the guest image pin the full lock requires is the output of the
 * build this function serves.
 */
export function referenceImageModelDocument(): ReferenceImageModelLock {
  const document = lockDocument as { model?: unknown };
  assertReferenceImageModelLock(document.model);
  return Object.freeze({ ...document.model, files: Object.freeze(document.model.files.map(file => Object.freeze({ ...file }))) });
}

/**
 * Where the sealed weight closure lives on this host.
 *
 * The revision is part of the path, so a lock that moves to another revision
 * cannot read the previous one's bytes out of a warm directory.
 */
export function sdxlClosureDirectoryFor(model: ReferenceImageModelLock): string {
  const base = process.env.EZCORP_FACTORY_SDXL_CLOSURE_DIR ?? "/tmp/ezcorp-factory-sdxl";
  return `${base}/${model.revision}`;
}
