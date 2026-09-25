import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3ObjectKey } from "../../src/extensions/v4/blobs";
import { createFactoryOrdinaryStorage, FACTORY_RUN_DELETE_BATCH, factoryRunPrefix, listFactoryRunVersions, removeFactoryRunObjects, type FactoryRunCleanupClient } from "./helpers/factory-storage";

/**
 * W15d: a proof run removes what it wrote. The local buckets keep every version,
 * so a plain delete only adds a marker; the ordinary store filled to 308 of its
 * 400 volumes (16.95 GiB, 59,888 live keys, three ever deleted) before the
 * storage helper's close() removed each run's versions. The prefix is the run's
 * own (a UUID), so the cleanup never reaches another run's objects.
 */

/** A scripted listing: each call returns the next page, and records what it was asked. Deletes answer `deleteAnswer`. */
function scriptedClient(pages: readonly Record<string, unknown>[], deleteAnswer: Record<string, unknown> = {}): FactoryRunCleanupClient & { readonly asked: Record<string, unknown>[] } {
  const asked: Record<string, unknown>[] = [];
  let index = 0;
  return {
    asked,
    async send(command) {
      asked.push({ name: command.constructor.name, ...command.input });
      return command instanceof ListObjectVersionsCommand ? pages[index++] : deleteAnswer;
    },
  };
}

/** `count` versions under ordinary/s/r, split into listing pages of 1000. */
function listing(count: number): Record<string, unknown>[] {
  const keys = Array.from({ length: count }, (_value, index) => ({ Key: `ordinary/s/r/k${String(index).padStart(5, "0")}`, VersionId: `v${index}` }));
  const pages: Record<string, unknown>[] = [];
  for (let start = 0; start < count; start += 1_000) {
    const last = start + 1_000 >= count;
    pages.push({ Versions: keys.slice(start, start + 1_000), IsTruncated: !last, ...(last ? {} : { NextKeyMarker: keys[start + 999]!.Key, NextVersionIdMarker: keys[start + 999]!.VersionId }) });
  }
  return pages;
}

describe("run prefixes", () => {
  test("a cleanup refuses a bucket root, a shared root, and a path that escapes", () => {
    for (const prefix of ["", "/", "ordinary", "ordinary/", "ordinary/../x", "ordinary/./x"]) expect(() => factoryRunPrefix(prefix)).toThrow("at least two path segments");
    expect(factoryRunPrefix("ordinary/suite/run")).toBe("ordinary/suite/run/");
    expect(factoryRunPrefix("/ordinary//w15-run/")).toBe("ordinary/w15-run/");
  });

  test("the listing follows every page, keeps versions and markers, and skips anything outside the run", async () => {
    const client = scriptedClient([
      { Versions: [{ Key: "ordinary/s/r/a", VersionId: "1" }, { Key: "ordinary/s/rx/b", VersionId: "2" }, { Key: "ordinary/s/r/c" }], DeleteMarkers: [{ Key: "ordinary/s/r/a", VersionId: "3" }], IsTruncated: true, NextKeyMarker: "ordinary/s/r/a", NextVersionIdMarker: "3" },
      { DeleteMarkers: [{ Key: "ordinary/s/r/d", VersionId: "4" }], IsTruncated: false },
    ]);
    expect(await listFactoryRunVersions(client, "tenant-01", "ordinary/s/r")).toEqual([
      { key: "ordinary/s/r/a", versionId: "1" }, { key: "ordinary/s/r/a", versionId: "3" }, { key: "ordinary/s/r/d", versionId: "4" },
    ]);
    expect(client.asked).toEqual([
      { name: "ListObjectVersionsCommand", Bucket: "tenant-01", Prefix: "ordinary/s/r/", MaxKeys: 1_000 },
      { name: "ListObjectVersionsCommand", Bucket: "tenant-01", Prefix: "ordinary/s/r/", MaxKeys: 1_000, KeyMarker: "ordinary/s/r/a", VersionIdMarker: "3" },
    ]);
  });

  test("a truncated page without a continuation fails instead of leaving objects behind", async () => {
    for (const page of [{ IsTruncated: true }, { IsTruncated: true, NextKeyMarker: "k" }]) {
      await expect(listFactoryRunVersions(scriptedClient([page]), "tenant-01", "ordinary/s/r")).rejects.toThrow("without a continuation marker");
    }
  });

  test("removal names each listed version by id, a thousand per call, with the last batch partial", async () => {
    const client = scriptedClient(listing(2_345));
    expect(await removeFactoryRunObjects(client, "tenant-01", "ordinary/s/r")).toBe(2_345);
    const deletes = client.asked.filter(call => call.name === "DeleteObjectsCommand") as { Bucket: string; Delete: { Objects: { Key: string; VersionId: string }[]; Quiet: boolean } }[];
    expect(FACTORY_RUN_DELETE_BATCH).toBe(1_000);
    expect(deletes.map(call => call.Delete.Objects.length)).toEqual([1_000, 1_000, 345]);
    expect(deletes.every(call => call.Bucket === "tenant-01" && call.Delete.Quiet)).toBe(true);
    const named = deletes.flatMap(call => call.Delete.Objects);
    expect(named.length).toBe(2_345);
    expect(new Set(named.map(object => `${object.Key}@${object.VersionId}`)).size).toBe(2_345);
    expect(named.at(-1)).toEqual({ Key: "ordinary/s/r/k02344", VersionId: "v2344" });
  });

  test("a version and its delete marker go in one call; an empty run sends no delete", async () => {
    const client = scriptedClient([{ Versions: [{ Key: "ordinary/s/r/a", VersionId: "1" }], DeleteMarkers: [{ Key: "ordinary/s/r/a", VersionId: "2" }] }]);
    expect(await removeFactoryRunObjects(client, "tenant-01", "ordinary/s/r")).toBe(2);
    expect(client.asked.filter(call => call.name === "DeleteObjectsCommand")).toEqual([
      { name: "DeleteObjectsCommand", Bucket: "tenant-01", Delete: { Objects: [{ Key: "ordinary/s/r/a", VersionId: "1" }, { Key: "ordinary/s/r/a", VersionId: "2" }], Quiet: true } },
    ]);
    const empty = scriptedClient([{}]);
    expect(await removeFactoryRunObjects(empty, "tenant-01", "ordinary/s/r")).toBe(0);
    expect(empty.asked.map(call => call.name)).toEqual(["ListObjectVersionsCommand"]);
  });

  test("a delete the store refuses for any key fails the cleanup, naming the first refusal", async () => {
    const page = { Versions: [{ Key: "ordinary/s/r/a", VersionId: "1" }, { Key: "ordinary/s/r/b", VersionId: "2" }] };
    await expect(removeFactoryRunObjects(scriptedClient([page], { Errors: [{ Key: "ordinary/s/r/b", Code: "AccessDenied" }] }), "tenant-01", "ordinary/s/r"))
      .rejects.toThrow("the store refused 1 of 2 deletes under tenant-01/ordinary/s/r/ (first: AccessDenied ordinary/s/r/b)");
    await expect(removeFactoryRunObjects(scriptedClient([page], { Errors: [{}] }), "tenant-01", "ordinary/s/r")).rejects.toThrow("(first: unknown )");
  });
});

describe("the real ordinary store", () => {
  test("close() removes every version and delete marker under the run's prefixes and leaves a neighbouring run alone", async () => {
    const run = randomUUID();
    const published = `ordinary/w15d-cleanup-published/${run}`;
    const storage = await createFactoryOrdinaryStorage(`ordinary/w15d-cleanup/${run}`, "tenant-01", [published]);
    // A neighbour whose prefix starts with the same characters but is another run.
    const neighbour = await createFactoryOrdinaryStorage(`ordinary/w15d-cleanup/${run}x`);
    let storageClosed = false;
    try {
      const put = (key: string, body: string) => storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: body }));
      const digest = await storage.blobs.put(new TextEncoder().encode(`blob-${run}`));
      await put(`${storage.prefix}/replaced`, "first");
      await put(`${storage.prefix}/replaced`, "second");
      await put(`${storage.prefix}/deleted`, "gone");
      await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: `${storage.prefix}/deleted` }));
      await put(`${published}/receipt.json`, "{}");
      const kept = `${neighbour.prefix}/kept`;
      await neighbour.client.send(new PutObjectCommand({ Bucket: neighbour.bucket, Key: kept, Body: "stays" }));

      // The blob, two versions of one key, and a version plus a delete marker of another.
      const before = await listFactoryRunVersions(storage.client, storage.bucket, storage.prefix);
      expect(before.map(version => version.key).sort()).toEqual([
        s3ObjectKey(storage.prefix, digest), `${storage.prefix}/deleted`, `${storage.prefix}/deleted`, `${storage.prefix}/replaced`, `${storage.prefix}/replaced`,
      ].sort());
      expect((await listFactoryRunVersions(storage.client, storage.bucket, published)).length).toBe(1);

      await storage.close();
      storageClosed = true;

      expect(await listFactoryRunVersions(neighbour.client, neighbour.bucket, storage.prefix)).toEqual([]);
      expect(await listFactoryRunVersions(neighbour.client, neighbour.bucket, published)).toEqual([]);
      const survivor = await neighbour.client.send(new GetObjectCommand({ Bucket: neighbour.bucket, Key: kept }));
      expect(await survivor.Body!.transformToString()).toBe("stays");
    } finally {
      if (!storageClosed) await storage.close();
      await neighbour.close();
    }
  }, 60_000);
});
