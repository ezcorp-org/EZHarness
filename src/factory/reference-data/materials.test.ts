import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUEST_MATERIALS_PATH } from "@ezcorp/extension-runner";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { FACTORY_MATERIAL_LIMITS, type FactoryMaterialChunk, type FactoryMaterialIdentity, type FactoryMaterialRecord, type FactoryMaterialScope } from "../artifact-materials";
import {
  readReferenceDataMaterial,
  referenceDataDigest,
  ReferenceDataGuestDirectory,
  ReferenceDataMaterialError,
  REFERENCE_DATA_GUEST_INPUT,
  REFERENCE_DATA_GUEST_OUTPUT,
  sealReferenceDataMaterial,
  streamDigest,
} from "./materials";

/**
 * The join between the guest's directory and W04's durable materials.
 *
 * W04's own behaviour is proved by W04's suites; these cases fix what THIS
 * module does: the mode a staged file really gets, the names it refuses, the
 * chunk plan it hands to the material service, and the fact that it streams
 * rather than assembling.
 */

const SCOPE: FactoryMaterialScope = { tenantId: "tenant", projectId: "project", runId: "run", attemptId: "attempt", operationId: "operation" };

/** Records the exact plan and chunks a seal was given. */
function recorder() {
  const chunks: Array<{ index: number; digest: string; bytes: number }> = [];
  const plans: Array<{ objectName: string; mediaType: string; totalBytes: number; chunkCount: number }> = [];
  const seals: string[] = [];
  const materials = {
    async begin(identity: FactoryMaterialIdentity, mediaType: string, totalBytes: number, chunkCount: number): Promise<FactoryMaterialRecord> {
      plans.push({ objectName: identity.objectName, mediaType, totalBytes, chunkCount });
      return { ...identity, schemaVersion: "factory.material.v1", mediaType, digest: `sha256:${"0".repeat(64)}`, totalBytes, chunkCount, storageVersion: "v1", sealed: false, createdAtMs: 0 };
    },
    async writeChunk(_identity: FactoryMaterialIdentity, chunk: FactoryMaterialChunk, content: Uint8Array): Promise<FactoryMaterialRecord> {
      chunks.push({ index: chunk.index, digest: chunk.digest, bytes: content.byteLength });
      return undefined as unknown as FactoryMaterialRecord;
    },
    async seal(_identity: FactoryMaterialIdentity, digest: string): Promise<FactoryArtifactReference> {
      seals.push(digest);
      return { artifactId: "artifact", digest, encodedBytes: 1024 };
    },
  };
  return { materials, chunks, plans, seals };
}

async function* blocks(...values: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield value;
}

const text = (value: string) => new TextEncoder().encode(value);

async function directory(): Promise<ReferenceDataGuestDirectory> {
  const parent = await mkdtemp(join(tmpdir(), "refdata-materials-test-"));
  const created = await ReferenceDataGuestDirectory.create(parent);
  return created;
}

test("the per-attempt directory is laid out so a guest running as another user can read and write it", async () => {
  const created = await directory();
  try {
    expect(ReferenceDataGuestDirectory.input("a.csv")).toBe(`${REFERENCE_DATA_GUEST_INPUT}/a.csv`);
    expect(ReferenceDataGuestDirectory.output("a.parquet")).toBe(`${REFERENCE_DATA_GUEST_OUTPUT}/a.parquet`);
    expect(ReferenceDataGuestDirectory.guestPath("in/a.csv")).toBe(`${GUEST_MATERIALS_PATH}/in/a.csv`);
    const staged = await created.stage(ReferenceDataGuestDirectory.input("a.csv"), blocks(text("alpha"), text("beta")));
    expect(staged.totalBytes).toBe(9);
    expect(staged.digest).toBe(referenceDataDigest(text("alphabeta")));
    // Under a 077 umask the file would be 0600 and unreadable by the guest's
    // uid, which is a different user in a different namespace.
    const { stat } = await import("node:fs/promises");
    expect((await stat(join(created.root, "in/a.csv"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(created.root, "out"))).mode & 0o777).toBe(0o777);
  } finally {
    await created.dispose();
  }
});

test("only bounded entries of the attempt directory can be named", async () => {
  const created = await directory();
  try {
    for (const name of ["", "a.csv", "../escape", "in/../../escape", "/etc/passwd", "in/sub/dir.csv", "out/.hidden", "other/a.csv"]) {
      await expect(created.stage(name, blocks(text("x")))).rejects.toMatchObject({ code: "reference_data_material_name_invalid" });
    }
    // A symbolic link inside the directory cannot widen it either: the name
    // grammar admits one segment under `in` or `out`, and nothing else.
    await symlink("/etc", join(created.root, "out/escape"));
    await expect(created.size("out/escape/passwd")).rejects.toMatchObject({ code: "reference_data_material_name_invalid" });
    await expect(created.stage("out/escape/passwd", blocks(text("x")))).rejects.toMatchObject({ code: "reference_data_material_name_invalid" });
  } finally {
    await created.dispose();
  }
});

test("collecting reports exactly what the guest left, in chunks a material write can take", async () => {
  const created = await directory();
  try {
    const payload = new Uint8Array(20).map((_, index) => index);
    await writeFile(join(created.root, "out/part.bin"), payload);
    await chmod(join(created.root, "out/part.bin"), 0o644);
    const collected: Uint8Array[] = [];
    for await (const chunk of created.collect("out/part.bin", 8)) collected.push(Uint8Array.from(chunk));
    expect(collected.map(chunk => chunk.byteLength)).toEqual([8, 8, 4]);
    expect(Buffer.concat(collected).equals(Buffer.from(payload))).toBe(true);
    expect(await created.size("out/part.bin")).toBe(20);
    expect(await created.produced()).toEqual(["part.bin"]);
  } finally {
    await created.dispose();
  }
});

test("a file the guest did not leave is an absence with a name, not an empty read", async () => {
  const created = await directory();
  try {
    const iterator = created.collect("out/absent.bin");
    await expect(iterator.next()).rejects.toMatchObject({ code: "reference_data_material_absent" });
    await expect(created.size("out/absent.bin")).rejects.toMatchObject({ code: "reference_data_material_absent" });
  } finally {
    await created.dispose();
  }
  // Disposing twice is not a failure: a journey disposes on its own error path.
  await created.dispose();
});

test("sealing chunks a stream at W04's own bound and takes the whole digest once", async () => {
  const world = recorder();
  const payload = new Uint8Array(FACTORY_MATERIAL_LIMITS.maxChunkBytes + 5).fill(7);
  const sealed = await sealReferenceDataMaterial(
    world.materials,
    { ...SCOPE, objectName: "part-00000.parquet", version: 1 },
    "application/vnd.apache.parquet",
    payload.byteLength,
    blocks(payload.subarray(0, FACTORY_MATERIAL_LIMITS.maxChunkBytes), payload.subarray(FACTORY_MATERIAL_LIMITS.maxChunkBytes)),
  );
  expect(world.plans).toEqual([{ objectName: "part-00000.parquet", mediaType: "application/vnd.apache.parquet", totalBytes: payload.byteLength, chunkCount: 2 }]);
  expect(world.chunks.map(chunk => [chunk.index, chunk.bytes])).toEqual([[0, FACTORY_MATERIAL_LIMITS.maxChunkBytes], [1, 5]]);
  expect(world.seals).toEqual([referenceDataDigest(payload)]);
  expect(sealed.digest).toBe(referenceDataDigest(payload));
  expect(sealed.totalBytes).toBe(payload.byteLength);
  expect(sealed.chunkCount).toBe(2);
  expect(sealed.artifact.artifactId).toBe("artifact");
});

test("an empty material is refused by name, because W04 has no chunk plan for one", async () => {
  const world = recorder();
  await expect(
    sealReferenceDataMaterial(world.materials, { ...SCOPE, objectName: "empty.json", version: 1 }, "application/json", 0, blocks()),
  ).rejects.toMatchObject({ code: "reference_data_material_empty" });
  expect(world.plans).toEqual([]);
  expect(world.seals).toEqual([]);
});

test("a caller's blocks are repacked to the plan, whatever size they arrive in", async () => {
  const world = recorder();
  const size = FACTORY_MATERIAL_LIMITS.maxChunkBytes;
  const payload = new Uint8Array(size * 2 + 3).map((_, index) => index % 251);
  // One mebibyte at a time: what a file reader or a row generator really yields.
  async function* megabytes(): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < payload.byteLength; at += 1024 * 1024) yield payload.subarray(at, Math.min(at + 1024 * 1024, payload.byteLength));
  }
  const sealed = await sealReferenceDataMaterial(world.materials, { ...SCOPE, objectName: "big.bin", version: 1 }, "application/octet-stream", payload.byteLength, megabytes());
  expect(world.plans[0]?.chunkCount).toBe(3);
  expect(world.chunks.map(chunk => [chunk.index, chunk.bytes])).toEqual([[0, size], [1, size], [2, 3]]);
  expect(sealed.digest).toBe(referenceDataDigest(payload));
  expect(sealed.chunkCount).toBe(3);
});

test("a stream that does not match the measurement it was planned against is refused", async () => {
  const world = recorder();
  await expect(
    sealReferenceDataMaterial(world.materials, { ...SCOPE, objectName: "short.json", version: 1 }, "application/json", 10, blocks(text("abc"))),
  ).rejects.toMatchObject({ code: "reference_data_material_digest_mismatch" });
  expect(world.seals).toEqual([]);
});

test("a material past W04's total bound is refused before any chunk is written", async () => {
  const world = recorder();
  await expect(
    sealReferenceDataMaterial(world.materials, { ...SCOPE, objectName: "huge.bin", version: 1 }, "application/octet-stream", FACTORY_MATERIAL_LIMITS.maxTotalBytes + 1, blocks()),
  ).rejects.toMatchObject({ code: "reference_data_material_oversized" });
  expect(world.plans).toEqual([]);
});

test("reading a material walks its chunks and never asks for the assembled bytes", async () => {
  const stored = [text("alpha"), text("beta"), text("gamma")];
  const scopes: string[] = [];
  const reader = {
    async read(): Promise<Uint8Array> {
      throw new Error("this pack must read chunks, never a whole material");
    },
    async readChunk(scope: FactoryMaterialScope, _artifact: FactoryArtifactReference, index: number): Promise<Uint8Array> {
      // The material's own operation reaches the reader, not the base scope's.
      scopes.push(scope.operationId);
      return stored[index] as Uint8Array;
    },
  };
  const collected: string[] = [];
  for await (const chunk of readReferenceDataMaterial(reader, SCOPE, { operationId: "operation:export", artifact: { artifactId: "a", digest: referenceDataDigest(text("x")), encodedBytes: 1 }, chunkCount: 3 })) {
    collected.push(new TextDecoder().decode(chunk));
  }
  expect(collected).toEqual(["alpha", "beta", "gamma"]);
  expect(scopes).toEqual(["operation:export", "operation:export", "operation:export"]);
});

test("a stream digest measures the whole stream without holding it", async () => {
  const measured = await streamDigest(blocks(text("alpha"), text("beta"), text("gamma")));
  expect(measured.totalBytes).toBe(14);
  expect(measured.digest).toBe(referenceDataDigest(text("alphabetagamma")));
  expect(await streamDigest(blocks())).toEqual({ digest: referenceDataDigest(new Uint8Array()), totalBytes: 0 });
});

test("a staged name that already exists is refused rather than overwritten", async () => {
  const created = await directory();
  try {
    await created.stage(ReferenceDataGuestDirectory.input("a.csv"), blocks(text("first")));
    await expect(created.stage(ReferenceDataGuestDirectory.input("a.csv"), blocks(text("second")))).rejects.toThrow();
    expect(await readFile(join(created.root, "in/a.csv"), "utf8")).toBe("first");
  } finally {
    await created.dispose();
  }
});

test("the error type names every refusal this module can make", () => {
  const error = new ReferenceDataMaterialError("reference_data_material_unsealed", "unsealed");
  expect(error.name).toBe("ReferenceDataMaterialError");
  expect(error.code).toBe("reference_data_material_unsealed");
  expect(error).toBeInstanceOf(Error);
});

test("the directory is created under the root it was given", async () => {
  const parent = await mkdtemp(join(tmpdir(), "refdata-parent-"));
  await mkdir(join(parent, "nested"), { recursive: true });
  const created = await ReferenceDataGuestDirectory.create(join(parent, "nested"));
  try {
    expect(created.root.startsWith(join(parent, "nested"))).toBe(true);
  } finally {
    await created.dispose();
    await rm(parent, { recursive: true, force: true });
  }
});
