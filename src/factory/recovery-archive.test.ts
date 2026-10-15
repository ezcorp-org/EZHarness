import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import { FactoryMemoryS3Store } from "../__tests__/helpers/factory-s3-memory-store";
import { S3FactoryReleaseArchive } from "./release-adapters";
import { FACTORY_RECOVERY_LIST_LIMIT, FactoryRecoveryArchiveError, parseFactoryArchiveReference, readFactoryRecoveryJson, S3FactoryRecoveryArchive, writeFactoryRecoveryJson } from "./recovery-archive";

const credentials = { accessKeyId: "archive-access", secretAccessKey: "archive-secret" };

function archives(store = new FactoryMemoryS3Store()) {
  const options = { endpoint: "http://archive.invalid", bucket: "tenant-bucket", prefix: "/root/archive/", credentials, client: store };
  return { store, recovery: new S3FactoryRecoveryArchive(options), releases: new S3FactoryReleaseArchive(options) };
}

describe("the recovery archive shares the release archive's immutable write path", () => {
  test("a recovery record round-trips, is content addressed, and lists under its own record", async () => {
    const { recovery, store } = archives();
    const first = await writeFactoryRecoveryJson(recovery, "tenant-a", "checkpoint", "checkpoint-1", { b: 2, a: 1 });
    expect(first.key.startsWith("root/archive/")).toBe(true);
    expect(first.key).toContain("/.recovery/checkpoint/");
    expect(await readFactoryRecoveryJson<Record<string, number>>(recovery, first)).toEqual({ a: 1, b: 2 });
    const again = await writeFactoryRecoveryJson(recovery, "tenant-a", "checkpoint", "checkpoint-1", { a: 1, b: 2 });
    expect(again).toEqual(first);
    await writeFactoryRecoveryJson(recovery, "tenant-a", "checkpoint", "checkpoint-2", { other: true });
    await writeFactoryRecoveryJson(recovery, "tenant-b", "checkpoint", "checkpoint-1", { tenant: "b" });
    expect(await recovery.list("tenant-a", "checkpoint", "checkpoint-1")).toEqual([first]);
    expect(store.calls).toContain("ListObjectVersionsCommand");
    await expect(recovery.write("tenant-a", "unknown" as "audit", "x", new Uint8Array([1]))).rejects.toMatchObject({ code: "factory_recovery_archive_invalid" });
  });

  test("a write whose read-back differs, or bytes that are not JSON, are refused as corrupt", async () => {
    const { recovery, store } = archives();
    store.corruptReads = true;
    await expect(writeFactoryRecoveryJson(recovery, "tenant-a", "report", "r", { a: 1 })).rejects.toThrow();
    store.corruptReads = false;
    const raw = await recovery.write("tenant-a", "report", "raw", new Uint8Array([0xff, 0xfe]));
    await expect(readFactoryRecoveryJson(recovery, raw)).rejects.toMatchObject({ code: "factory_recovery_archive_corrupt" });
    const lying = { write: async () => ({ ...raw, digest: `sha256:${"0".repeat(64)}` }), read: async () => new Uint8Array(), list: async () => [] };
    await expect(writeFactoryRecoveryJson(lying, "tenant-a", "report", "r", {})).rejects.toMatchObject({ code: "factory_recovery_archive_corrupt" });
    const different = { write: recovery.write.bind(recovery), read: async () => new TextEncoder().encode("{}"), list: async () => [] };
    await expect(writeFactoryRecoveryJson(different, "tenant-a", "report", "r2", { a: 2 })).rejects.toMatchObject({ code: "factory_recovery_archive_corrupt" });
  });

  test("the release catalog finds every operation's objects from the archive alone, across listing pages", async () => {
    const { recovery, releases, store } = archives();
    for (let index = 0; index < 3; index += 1) {
      const operationId = `operation:${index}`;
      await releases.writeImmutable("tenant-a", operationId, "intent", new TextEncoder().encode(`intent-${index}`));
      await releases.writeImmutable("tenant-a", operationId, "material", new TextEncoder().encode(`material-${index}`));
      if (index > 0) await releases.writeImmutable("tenant-a", operationId, "receipt", new TextEncoder().encode(`receipt-${index}`));
    }
    await releases.writeImmutable("tenant-b", "foreign", "intent", new TextEncoder().encode("foreign"));
    await writeFactoryRecoveryJson(recovery, "tenant-a", "audit", "project/run", { page: 1 });
    // Objects a catalog must step over: an unparseable segment, an unknown name, a non-digest leaf, a stale version.
    store.put("root/archive/dGVuYW50LWE/!!/intent/" + "a".repeat(64), new Uint8Array([1]));
    store.put("root/archive/dGVuYW50LWE/b3A/unknown/" + "b".repeat(64), new Uint8Array([1]));
    store.put("root/archive/dGVuYW50LWE/b3A/intent/not-a-digest", new Uint8Array([1]));
    store.put("root/archive/dGVuYW50LWE/b3A=/intent/" + "c".repeat(64), new Uint8Array([1]));
    store.put("root/archive/dGVuYW50LWE/b3A/intent/" + "d".repeat(64), new Uint8Array([1]));
    store.put("root/archive/dGVuYW50LWE/b3A/intent/" + "d".repeat(64), new Uint8Array([2]));
    const operations = await recovery.operations("tenant-a");
    expect(operations.map(operation => operation.operationId)).toEqual(["op", "operation:0", "operation:1", "operation:2"]);
    expect(operations[0]!.intent).toHaveLength(1);
    // Lengths, not toMatchObject with expect.any: Bun 1.3.14 replaces array elements matched that way with {}.
    expect([operations[1]!.intent.length, operations[1]!.material.length, operations[1]!.receipt.length, operations[1]!.reconciliation.length]).toEqual([1, 1, 0, 0]);
    expect(operations[2]!.receipt).toHaveLength(1);
    for (const operation of operations.slice(1)) for (const object of [...operation.intent, ...operation.material, ...operation.receipt]) expect((await releases.read(object)).byteLength).toBeGreaterThan(0);
  });

  test("paging follows the store's markers and refuses a truncated page with no marker or an unbounded inventory", async () => {
    const { recovery, store } = archives();
    for (let index = 0; index < 5; index += 1) await recovery.write("tenant-a", "audit", "run", new TextEncoder().encode(`page-${index}`));
    const send = store.send.bind(store);
    let pages = 0;
    store.send = async (command: unknown, options?: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "ListObjectVersionsCommand") { pages += 1; (command as { input: { MaxKeys?: number } }).input.MaxKeys = 2; }
      return send(command, options);
    };
    expect(await recovery.list("tenant-a", "audit", "run", new AbortController().signal)).toHaveLength(5);
    expect(pages).toBe(3);
    store.send = async (command: unknown, options?: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "ListObjectVersionsCommand") return { Versions: [], IsTruncated: true };
      return send(command, options);
    };
    await expect(recovery.list("tenant-a", "audit", "run")).rejects.toMatchObject({ code: "factory_recovery_archive_corrupt" });
    store.send = async (command: unknown, options?: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "ListObjectVersionsCommand") return { Versions: Array.from({ length: FACTORY_RECOVERY_LIST_LIMIT + 1 }, (_, index) => ({ Key: `k${index}`, VersionId: "v", IsLatest: true })), IsTruncated: false };
      return send(command, options);
    };
    await expect(recovery.operations("tenant-a")).rejects.toMatchObject({ code: "factory_recovery_archive_too_large" });
    store.send = async () => ({ Versions: [{ Key: undefined }, { Key: "root/archive/dGVuYW50LWE/.recovery/audit/cnVu/" + "e".repeat(64) }] });
    expect(await recovery.list("tenant-a", "audit", "run")).toEqual([]);
  });

  test("a stored archive reference is validated before it is ever read", () => {
    const reference = { key: "root/k", digest: `sha256:${"a".repeat(64)}`, versionId: "v1" };
    expect(parseFactoryArchiveReference(canonicalJson(reference))).toEqual(reference);
    expect(parseFactoryArchiveReference(reference)).toEqual(reference);
    for (const bad of ["{", "null", "[]", { ...reference, key: "" }, { ...reference, digest: "sha256:zz" }, { ...reference, versionId: "" }, { ...reference, extra: 1 }, { key: "k", digest: reference.digest }]) {
      expect(() => parseFactoryArchiveReference(bad)).toThrow(FactoryRecoveryArchiveError);
    }
  });
});
