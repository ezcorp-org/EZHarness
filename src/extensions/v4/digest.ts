import { createHash } from "node:crypto";

/**
 * SHA-256 over raw bytes, hex, unprefixed.
 *
 * This was part of `blobs.ts`, which also constructs an S3 client and reaches canonical JSON. That
 * made "hash these bytes" transitively depend on the AWS SDK and on a JSON-schema validator, so a
 * bundled validator guest had to carry both or write a second `createHash` call and drift from
 * this one. It lives here alone so there is still exactly one implementation and its closure is
 * `node:crypto`. `blobs.ts` re-exports it, so every existing caller is unchanged.
 */
export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
