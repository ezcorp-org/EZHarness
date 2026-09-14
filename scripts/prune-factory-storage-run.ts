#!/usr/bin/env bun
/**
 * Deletes only the objects one test run created, so a shared store's volume budget is not spent by
 * re-running producers.
 *
 * The window is the point: every version whose `LastModified` falls inside a recorded run window is
 * deleted, and nothing outside it is touched. Older objects belong to other packages' receipts, and
 * deleting those would destroy evidence rather than free space. A dry run is the default; `--apply`
 * is what deletes.
 *
 * Usage:
 *   bun scripts/prune-factory-storage-run.ts --receipt /tmp/.../m2-postgres-neighbours.json [--apply]
 *   bun scripts/prune-factory-storage-run.ts --since <iso> --until <iso> [--prefix ordinary/] [--apply]
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const APPLY = argv.includes("--apply");
const PREFIX = option("prefix") ?? "ordinary/";
const SECRETS = process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR;
if (!SECRETS) throw new Error("Set EZCORP_FACTORY_STORAGE_SECRETS_DIR to the storage credential directory.");

async function window(): Promise<{ since: number; until: number }> {
  const receipt = option("receipt");
  if (receipt) {
    const record = JSON.parse(await readFile(receipt, "utf8")) as { startedAt: string; finishedAt: string };
    return { since: Date.parse(record.startedAt), until: Date.parse(record.finishedAt) };
  }
  const since = Date.parse(option("since") ?? "");
  const until = Date.parse(option("until") ?? new Date().toISOString());
  if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until)) throw new Error("Provide --receipt, or --since and --until as ISO timestamps.");
  return { since, until };
}

interface CredentialEntry { readonly name: string; readonly credentials: readonly { readonly accessKey: string; readonly secretKey: string }[] }

/**
 * One scoped client per tenant identity, read from the same credential file every producer reads.
 *
 * Each identity is authorized for its own bucket only, so the prune runs under the same scoping the
 * producers do rather than under a wider credential.
 */
async function ordinaryClients(): Promise<{ readonly bucket: string; readonly client: S3Client }[]> {
  const raw = JSON.parse(await readFile(join(SECRETS!, "ordinary.json"), "utf8")) as { identities?: readonly CredentialEntry[] };
  const identities = raw.identities ?? [];
  if (!identities.length) throw new Error("The ordinary credential set names no identity.");
  const endpoint = process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_ENDPOINT ?? `http://127.0.0.1:${process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_PORT ?? "18333"}`;
  return identities.map(entry => ({
    bucket: entry.name,
    client: new S3Client({
      endpoint, region: "us-east-1", forcePathStyle: true,
      credentials: { accessKeyId: entry.credentials[0]!.accessKey, secretAccessKey: entry.credentials[0]!.secretKey }, maxAttempts: 2,
    }),
  }));
}

async function main(): Promise<void> {
  const { since, until } = await window();
  const targets = await ordinaryClients();
  let scanned = 0;
  let matched = 0;
  let deleted = 0;
  const prefixes = new Map<string, number>();
  for (const { bucket, client } of targets) {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: PREFIX, KeyMarker: keyMarker, VersionIdMarker: versionMarker, MaxKeys: 1000 }));
      const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
      scanned += versions.length;
      const doomed = versions.filter(version => {
        const at = version.LastModified ? version.LastModified.getTime() : Number.NaN;
        return Number.isSafeInteger(at) && at >= since && at <= until;
      });
      matched += doomed.length;
      for (const version of doomed) prefixes.set(version.Key!.split("/").slice(0, 2).join("/"), (prefixes.get(version.Key!.split("/").slice(0, 2).join("/")) ?? 0) + 1);
      if (APPLY && doomed.length) {
        for (let index = 0; index < doomed.length; index += 500) {
          const batch = doomed.slice(index, index + 500).map(version => ({ Key: version.Key!, VersionId: version.VersionId }));
          const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
          deleted += batch.length - (result.Errors?.length ?? 0);
        }
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker || versionMarker);
  }
  console.log(JSON.stringify({
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    prefix: PREFIX, buckets: targets.length, scanned, matched, deleted, applied: APPLY,
    matchedPrefixes: Object.fromEntries([...prefixes].sort((left, right) => right[1] - left[1])),
  }, null, 2));
}

await main();
