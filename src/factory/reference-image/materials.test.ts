import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";

import {
  FACTORY_MATERIAL_LIMITS,
  type FactoryMaterialChunk,
  type FactoryMaterialIdentity,
  type FactoryMaterialRecord,
  type FactoryMaterialScope,
} from "../artifact-materials.ts";
import {
  guestMaterialObjectName,
  REFERENCE_IMAGE_MATERIAL_BOUNDS,
  ReferenceImageMaterialError,
  sealGuestMaterials,
  type GuestMaterialClaim,
  type GuestMaterialSink,
} from "./materials.ts";

const SCOPE: FactoryMaterialScope = {
  tenantId: "tenant",
  projectId: "project",
  runId: "run",
  attemptId: "attempt",
  operationId: "operation",
};

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Records every call, so a test can assert what reached the store and in what order. */
class RecordingMaterials implements GuestMaterialSink {
  readonly begun: FactoryMaterialIdentity[] = [];
  readonly chunks: { objectName: string; index: number; bytes: number }[] = [];
  readonly sealed: { objectName: string; digest: string }[] = [];
  constructor(private readonly alreadySealed = new Map<string, { digest: string; artifact?: FactoryArtifactReference }>()) {}

  async begin(identity: FactoryMaterialIdentity, mediaType: string, totalBytes: number, chunkCount: number): Promise<FactoryMaterialRecord> {
    this.begun.push(identity);
    const prior = this.alreadySealed.get(identity.objectName);
    return {
      ...identity,
      schemaVersion: "factory.material.v1",
      mediaType,
      digest: prior?.digest ?? "",
      totalBytes,
      chunkCount,
      storageVersion: "1",
      sealed: prior !== undefined,
      createdAtMs: 1,
      ...(prior?.artifact === undefined ? {} : { artifact: prior.artifact }),
    };
  }
  async writeChunk(identity: FactoryMaterialIdentity, chunk: FactoryMaterialChunk, content: Uint8Array): Promise<FactoryMaterialRecord> {
    this.chunks.push({ objectName: identity.objectName, index: chunk.index, bytes: content.byteLength });
    return this.begin(identity, "application/octet-stream", content.byteLength, 1);
  }
  async seal(identity: FactoryMaterialIdentity, digest: string): Promise<FactoryArtifactReference> {
    this.sealed.push({ objectName: identity.objectName, digest });
    return { artifactId: `artifact-${identity.objectName}`, digest, encodedBytes: 0 };
  }
}

async function mount(files: Record<string, Uint8Array>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ez-image-materials-"));
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(directory, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, bytes);
  }
  return directory;
}

function claim(path: string, bytes: Uint8Array, mediaType = "image/png"): GuestMaterialClaim {
  return { path, digest: sha256(bytes), bytes: bytes.byteLength, mediaType };
}

describe("sealing what a guest wrote", () => {
  test("it reads back, verifies, and seals one declared file", async () => {
    const png = new Uint8Array([1, 2, 3, 4, 5]);
    const directory = await mount({ "variant.png": png });
    const materials = new RecordingMaterials();
    const sealed = await sealGuestMaterials({ directory, claims: [claim("variant.png", png)], materials, scope: SCOPE });

    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.path).toBe("variant.png");
    expect(sealed[0]?.objectName).toBe("guest/variant.png");
    expect(sealed[0]?.digest).toBe(sha256(png));
    expect(sealed[0]?.bytes).toBe(5);
    expect(sealed[0]?.mediaType).toBe("image/png");
    expect(sealed[0]?.artifact.artifactId).toBe("artifact-guest/variant.png");
    expect(materials.sealed).toEqual([{ objectName: "guest/variant.png", digest: sha256(png) }]);
  });

  test("it seals several files in path order", async () => {
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2, 2]);
    const directory = await mount({ "b.png": second, "a.png": first });
    const materials = new RecordingMaterials();
    const sealed = await sealGuestMaterials({
      directory,
      claims: [claim("b.png", second), claim("a.png", first)],
      materials,
      scope: SCOPE,
    });
    expect(sealed.map(entry => entry.path)).toEqual(["a.png", "b.png"]);
  });

  test("bytes reach the store in chunks that respect the shared ceiling", async () => {
    const big = new Uint8Array(FACTORY_MATERIAL_LIMITS.maxChunkBytes + 7).fill(9);
    const directory = await mount({ "variant.png": big });
    const materials = new RecordingMaterials();
    await sealGuestMaterials({ directory, claims: [claim("variant.png", big)], materials, scope: SCOPE });
    expect(materials.chunks).toHaveLength(2);
    expect(materials.chunks[0]?.bytes).toBe(FACTORY_MATERIAL_LIMITS.maxChunkBytes);
    expect(materials.chunks[1]?.bytes).toBe(7);
  });

  test("nothing is written to the store before the bytes verify", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const directory = await mount({ "variant.png": png });
    const materials = new RecordingMaterials();
    const lying = { ...claim("variant.png", png), digest: `sha256:${"b".repeat(64)}` };
    await expect(sealGuestMaterials({ directory, claims: [lying], materials, scope: SCOPE })).rejects.toThrow(ReferenceImageMaterialError);
    expect(materials.begun).toEqual([]);
    expect(materials.chunks).toEqual([]);
    expect(materials.sealed).toEqual([]);
  });

  test("a truncated write is refused rather than sealed as a picture", async () => {
    const whole = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const directory = await mount({ "variant.png": whole.subarray(0, 4) });
    const materials = new RecordingMaterials();
    // The guest claimed the whole file; only half of it landed.
    const stale: GuestMaterialClaim = { path: "variant.png", digest: sha256(whole), bytes: whole.byteLength, mediaType: "image/png" };
    await expect(sealGuestMaterials({ directory, claims: [stale], materials, scope: SCOPE })).rejects.toThrow(/declared 8 bytes .* and wrote 4/);
  });

  test("a file the guest never declared is refused", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const directory = await mount({ "variant.png": png, "smuggled.bin": new Uint8Array([9]) });
    const materials = new RecordingMaterials();
    await expect(sealGuestMaterials({ directory, claims: [claim("variant.png", png)], materials, scope: SCOPE })).rejects.toThrow(
      /without declaring it/,
    );
  });

  test("a declared file the guest never wrote is refused", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const directory = await mount({ "variant.png": png });
    const materials = new RecordingMaterials();
    await expect(
      sealGuestMaterials({ directory, claims: [claim("variant.png", png), claim("absent.png", png)], materials, scope: SCOPE }),
    ).rejects.toThrow(/declared absent.png and did not write it/);
  });

  test("the same path claimed twice is refused", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const directory = await mount({ "variant.png": png });
    const materials = new RecordingMaterials();
    await expect(
      sealGuestMaterials({ directory, claims: [claim("variant.png", png), claim("variant.png", png)], materials, scope: SCOPE }),
    ).rejects.toThrow(/same material path twice/);
  });

  test("a symbolic link the guest planted is refused by the shared walk", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const directory = await mount({ "variant.png": png });
    await symlink("/etc/passwd", join(directory, "escape.png"));
    const materials = new RecordingMaterials();
    await expect(sealGuestMaterials({ directory, claims: [claim("variant.png", png)], materials, scope: SCOPE })).rejects.toThrow(
      /symbolic link/,
    );
  });

  test("an empty mount with no claims seals nothing", async () => {
    const directory = await mount({});
    const materials = new RecordingMaterials();
    expect(await sealGuestMaterials({ directory, claims: [], materials, scope: SCOPE })).toEqual([]);
    expect(materials.sealed).toEqual([]);
  });

  test("a nested path keeps its forward slashes in the object name", async () => {
    const png = new Uint8Array([7]);
    const directory = await mount({ "out/variant.png": png });
    const materials = new RecordingMaterials();
    const sealed = await sealGuestMaterials({ directory, claims: [claim("out/variant.png", png)], materials, scope: SCOPE });
    expect(sealed[0]?.objectName).toBe("guest/out/variant.png");
  });

  test("a caller-chosen prefix is used", async () => {
    const png = new Uint8Array([7]);
    const directory = await mount({ "variant.png": png });
    const materials = new RecordingMaterials();
    const sealed = await sealGuestMaterials({ directory, claims: [claim("variant.png", png)], materials, scope: SCOPE, objectNamePrefix: "image/" });
    expect(sealed[0]?.objectName).toBe("image/variant.png");
  });
});

describe("replay", () => {
  test("an already-sealed material returns its existing handle without rewriting", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const directory = await mount({ "variant.png": png });
    const prior = new Map([["guest/variant.png", { digest: sha256(png), artifact: { artifactId: "prior", digest: sha256(png), encodedBytes: 3 } }]]);
    const materials = new RecordingMaterials(prior);
    const sealed = await sealGuestMaterials({ directory, claims: [claim("variant.png", png)], materials, scope: SCOPE });
    expect(sealed[0]?.artifact.artifactId).toBe("prior");
    expect(materials.chunks).toEqual([]);
    expect(materials.sealed).toEqual([]);
  });

  test("a material already sealed with different bytes is a conflict, never an overwrite", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const directory = await mount({ "variant.png": png });
    const prior = new Map([["guest/variant.png", { digest: `sha256:${"c".repeat(64)}`, artifact: { artifactId: "prior", digest: "x", encodedBytes: 3 } }]]);
    const materials = new RecordingMaterials(prior);
    await expect(sealGuestMaterials({ directory, claims: [claim("variant.png", png)], materials, scope: SCOPE })).rejects.toThrow(
      /already sealed with different bytes/,
    );
  });

  test("a sealed record with no artifact is a conflict rather than a silent pass", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const directory = await mount({ "variant.png": png });
    const prior = new Map([["guest/variant.png", { digest: sha256(png) }]]);
    const materials = new RecordingMaterials(prior);
    await expect(sealGuestMaterials({ directory, claims: [claim("variant.png", png)], materials, scope: SCOPE })).rejects.toThrow(
      ReferenceImageMaterialError,
    );
  });
});

describe("bounds and names", () => {
  test("the walk runs under W04's own limits, not a second set", () => {
    expect(REFERENCE_IMAGE_MATERIAL_BOUNDS.maxEntries).toBe(FACTORY_MATERIAL_LIMITS.maxObjectsPerOperation);
    expect(REFERENCE_IMAGE_MATERIAL_BOUNDS.maxTotalBytes).toBe(FACTORY_MATERIAL_LIMITS.maxTotalBytes);
  });

  test("an object name within the store's limit is accepted", () => {
    expect(guestMaterialObjectName("variant.png")).toBe("guest/variant.png");
  });

  test("an object name past the store's limit is refused where the name can be reported", () => {
    const long = `${"a".repeat(FACTORY_MATERIAL_LIMITS.maxNameLength)}.png`;
    expect(() => guestMaterialObjectName(long)).toThrow(/exceeds 512 characters/);
  });
});
