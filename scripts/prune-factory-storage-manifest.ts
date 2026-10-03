#!/usr/bin/env bun
/**
 * Deletes exactly the object versions a manifest names, and nothing else.
 *
 * This replaces a time-window deleter that listed every version in a window across all ten tenant
 * buckets and deleted what it found. That tool could delete an object it did not create, which on a
 * store several packages share means destroying another package's evidence. It was run once with
 * `--apply` without authorization; see `tasks/factory/w07-GATES.md` for exactly what went.
 *
 * The rule this tool now enforces: cleanup deletes only what the run recorded writing. There is no
 * discovery step, no prefix mode, and no window mode. A key the manifest does not name cannot be
 * reached, so the blast radius is the manifest and a reviewer can read it before anything runs.
 *
 * A producer writes the manifest; the manifest is the authorization. Dry run is the default.
 *
 * Usage:
 *   bun scripts/prune-factory-storage-manifest.ts --manifest <path>            # shows what would go
 *   bun scripts/prune-factory-storage-manifest.ts --manifest <path> --apply    # deletes it
 *
 * Manifest shape (JSON):
 *   { "schemaVersion": "factory.storage-prune-manifest.v1",
 *     "store": "ordinary" | "archive",
 *     "objects": [ { "bucket": "tenant-01", "key": "ordinary/…/<digest>", "versionId": "…" } ] }
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";

export const FACTORY_STORAGE_PRUNE_MANIFEST_SCHEMA_VERSION = "factory.storage-prune-manifest.v1" as const;
/** A cleanup that would delete more than this is a bulk operation, not a cleanup. */
export const FACTORY_STORAGE_PRUNE_MAX_OBJECTS = 5_000;

export interface FactoryStoragePruneObject {
  readonly bucket: string;
  readonly key: string;
  /** Required. Deleting "the current version" of a key is a guess about what is there now. */
  readonly versionId: string;
}

export interface FactoryStoragePruneManifest {
  readonly schemaVersion: typeof FACTORY_STORAGE_PRUNE_MANIFEST_SCHEMA_VERSION;
  readonly store: "ordinary" | "archive";
  readonly objects: readonly FactoryStoragePruneObject[];
}

export class FactoryStoragePruneError extends Error {
  constructor(readonly code: "factory_prune_manifest_required" | "factory_prune_manifest_invalid") {
    super(code);
    this.name = "FactoryStoragePruneError";
  }
}

function invalid(): never { throw new FactoryStoragePruneError("factory_prune_manifest_invalid"); }

function bounded(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) invalid();
  return value;
}

/**
 * Every rule a prune manifest must satisfy before one delete is issued.
 *
 * The two that matter most: a key must be exact, and a version must be named. A `*`, a `?`, or a
 * trailing `/` would let one entry stand for objects the run never wrote, and an entry without a
 * version deletes whatever happens to be current rather than what the run created.
 */
export function assertFactoryStoragePruneManifest(value: unknown): FactoryStoragePruneManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 3) invalid();
  if (source.schemaVersion !== FACTORY_STORAGE_PRUNE_MANIFEST_SCHEMA_VERSION) invalid();
  if (source.store !== "ordinary" && source.store !== "archive") invalid();
  if (!Array.isArray(source.objects) || source.objects.length < 1 || source.objects.length > FACTORY_STORAGE_PRUNE_MAX_OBJECTS) invalid();
  const seen = new Set<string>();
  const objects = source.objects.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).length !== 3) invalid();
    const bucket = bounded(item.bucket, 255);
    const key = bounded(item.key, 1024);
    const versionId = bounded(item.versionId, 512);
    // An exact key only. Anything that could stand for more than one object is refused.
    if (key.includes("*") || key.includes("?") || key.endsWith("/") || key.startsWith("/") || key.includes("//") || key.split("/").some(part => part === "." || part === "..")) invalid();
    const identity = `${bucket}\0${key}\0${versionId}`;
    if (seen.has(identity)) invalid();
    seen.add(identity);
    return Object.freeze({ bucket, key, versionId });
  });
  return Object.freeze({ schemaVersion: FACTORY_STORAGE_PRUNE_MANIFEST_SCHEMA_VERSION, store: source.store, objects: Object.freeze(objects) });
}

interface CredentialEntry { readonly name: string; readonly credentials: readonly { readonly accessKey: string; readonly secretKey: string }[] }

/**
 * One scoped client per tenant identity, from the same credential file every producer reads.
 *
 * Each identity is authorized for its own bucket only, so a manifest naming a bucket this
 * credential set does not hold simply has no client and is reported rather than deleted.
 */
async function clientsFor(store: "ordinary" | "archive", secretsDir: string): Promise<Map<string, S3Client>> {
  const raw = JSON.parse(await readFile(join(secretsDir, `${store}.json`), "utf8")) as { identities?: readonly CredentialEntry[] };
  const identities = raw.identities ?? [];
  if (!identities.length) invalid();
  const port = store === "ordinary" ? process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_PORT ?? "18333" : process.env.EZCORP_FACTORY_STORAGE_ARCHIVE_S3_PORT ?? "18334";
  const endpoint = (store === "ordinary" ? process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_ENDPOINT : process.env.EZCORP_FACTORY_STORAGE_ARCHIVE_S3_ENDPOINT) ?? `http://127.0.0.1:${port}`;
  return new Map(identities.map(entry => [entry.name, new S3Client({
    endpoint, region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: entry.credentials[0]!.accessKey, secretAccessKey: entry.credentials[0]!.secretKey }, maxAttempts: 2,
  })]));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--manifest");
  const path = index >= 0 ? argv[index + 1] : undefined;
  if (!path) throw new FactoryStoragePruneError("factory_prune_manifest_required");
  const apply = argv.includes("--apply");
  const secretsDir = process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR;
  if (!secretsDir) throw new Error("Set EZCORP_FACTORY_STORAGE_SECRETS_DIR to the storage credential directory.");

  const manifest = assertFactoryStoragePruneManifest(JSON.parse(await readFile(path, "utf8")));
  const clients = await clientsFor(manifest.store, secretsDir);
  const byBucket = new Map<string, FactoryStoragePruneObject[]>();
  for (const object of manifest.objects) byBucket.set(object.bucket, [...(byBucket.get(object.bucket) ?? []), object]);

  const unreachable: string[] = [];
  let deleted = 0;
  const failures: string[] = [];
  for (const [bucket, objects] of byBucket) {
    const client = clients.get(bucket);
    if (!client) { unreachable.push(bucket); continue; }
    if (!apply) continue;
    for (let start = 0; start < objects.length; start += 500) {
      const batch = objects.slice(start, start + 500).map(object => ({ Key: object.key, VersionId: object.versionId }));
      const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
      for (const error of result.Errors ?? []) failures.push(`${bucket}/${error.Key}`);
      deleted += batch.length - (result.Errors?.length ?? 0);
    }
  }
  console.log(JSON.stringify({
    manifest: path, store: manifest.store, named: manifest.objects.length,
    buckets: [...byBucket.keys()].sort(), unreachableBuckets: unreachable.sort(),
    deleted, failures, applied: apply,
  }, null, 2));
  if (failures.length || unreachable.length) process.exitCode = 1;
}

if (import.meta.main) await main();
