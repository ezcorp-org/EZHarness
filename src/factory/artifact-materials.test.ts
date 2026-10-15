import { expect, test } from "bun:test";
import {
  assertFactoryArtifactReference,
  assertFactoryMaterialDigest,
  assertFactoryMaterialMediaType,
  assertFactoryMaterialName,
  FACTORY_ARTIFACT_SHARED_MAX_BYTES,
  FACTORY_MATERIAL_LIMITS,
  FACTORY_WORKSPACE_MATERIAL_PREFIX,
  factoryMaterialDigest,
  factoryMaterialKey,
  FactoryArtifactAccessError,
  FactoryMaterialError,
  isFactoryArtifactMediaType,
  snapshotFactoryMaterialIdentity,
  snapshotFactoryMaterialScope,
  unavailable,
} from "./artifact-materials";

const digest = `sha256:${"a".repeat(64)}`;
const scope = { tenantId: "tenant", projectId: "project", runId: "run", attemptId: "attempt", operationId: "run:node-a:0:0" };
const identity = { ...scope, objectName: "data/export.json", version: 1 };

test("the frozen material limits are the exact values every consumer compiles against", () => {
  expect(FACTORY_MATERIAL_LIMITS).toEqual({ maxChunkBytes: 8 * 1024 * 1024, maxChunks: 64, maxTotalBytes: 256 * 1024 * 1024, maxObjectsPerOperation: 256, maxNameLength: 512 });
  expect(Object.isFrozen(FACTORY_MATERIAL_LIMITS)).toBe(true);
  expect(FACTORY_MATERIAL_LIMITS.maxChunkBytes * FACTORY_MATERIAL_LIMITS.maxChunks).toBeGreaterThanOrEqual(FACTORY_MATERIAL_LIMITS.maxTotalBytes);
  expect(FACTORY_WORKSPACE_MATERIAL_PREFIX).toBe("workspace/");
});

test("the one artifact reference validator accepts an exact reference and freezes its copy", () => {
  const accepted = assertFactoryArtifactReference({ artifactId: "factory-artifact-1", digest, encodedBytes: 12 }, FACTORY_ARTIFACT_SHARED_MAX_BYTES);
  expect(accepted).toEqual({ artifactId: "factory-artifact-1", digest, encodedBytes: 12 });
  expect(Object.isFrozen(accepted)).toBe(true);
  expect(assertFactoryArtifactReference({ artifactId: "factory-artifact-1", digest, encodedBytes: 4 }, 4).encodedBytes).toBe(4);
});

test("the one artifact reference validator rejects every malformed field and an unusable ceiling", () => {
  const reference = { artifactId: "factory-artifact-1", digest, encodedBytes: 12 };
  const rejected: Array<[unknown, number]> = [
    [null, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, artifactId: 7 }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, artifactId: "" }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, artifactId: "with\u0000null" }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, artifactId: "a".repeat(513) }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, digest: 7 }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, digest: `sha256:${"A".repeat(64)}` }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, digest: "a".repeat(64) }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, encodedBytes: 0 }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, encodedBytes: 1.5 }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [{ ...reference, encodedBytes: FACTORY_ARTIFACT_SHARED_MAX_BYTES + 1 }, FACTORY_ARTIFACT_SHARED_MAX_BYTES],
    [reference, 0],
    [reference, 1.5],
  ];
  for (const [value, maximum] of rejected) {
    expect(() => assertFactoryArtifactReference(value as never, maximum)).toThrowError(FactoryMaterialError);
    try { assertFactoryArtifactReference(value as never, maximum); }
    catch (error) { expect((error as FactoryMaterialError).code).toBe("factory_artifact_reference_invalid"); }
  }
});

test("the reference ceiling is exact at the boundary and one byte past it", () => {
  expect(assertFactoryArtifactReference({ artifactId: "factory-artifact-1", digest, encodedBytes: FACTORY_ARTIFACT_SHARED_MAX_BYTES }, FACTORY_ARTIFACT_SHARED_MAX_BYTES).encodedBytes).toBe(FACTORY_ARTIFACT_SHARED_MAX_BYTES);
  expect(() => assertFactoryArtifactReference({ artifactId: "factory-artifact-1", digest, encodedBytes: FACTORY_ARTIFACT_SHARED_MAX_BYTES + 1 }, FACTORY_ARTIFACT_SHARED_MAX_BYTES)).toThrowError(FactoryMaterialError);
});

test("media types follow the one shared artifact grammar", () => {
  expect(isFactoryArtifactMediaType("application/json")).toBe(true);
  expect(assertFactoryMaterialMediaType("application/octet-stream")).toBe("application/octet-stream");
  for (const value of ["Application/JSON", "application", "application/", "/json", 7, undefined, `application/${"a".repeat(65)}`]) {
    expect(isFactoryArtifactMediaType(value)).toBe(false);
    expect(() => assertFactoryMaterialMediaType(value)).toThrowError(FactoryMaterialError);
  }
});

test("object names are bounded relative paths, so no entry escapes its root", () => {
  for (const value of ["data/export.json", `${FACTORY_WORKSPACE_MATERIAL_PREFIX}transcript.json`, "a".repeat(FACTORY_MATERIAL_LIMITS.maxNameLength)]) {
    expect(assertFactoryMaterialName(value)).toBe(value);
  }
  for (const value of ["", "a".repeat(FACTORY_MATERIAL_LIMITS.maxNameLength + 1), "../escape", "a/../../escape", "/absolute", "a\\b", "C:foo", "a\u0000b", "a//b", "./here", 7, undefined]) {
    expect(() => assertFactoryMaterialName(value)).toThrowError(FactoryMaterialError);
    try { assertFactoryMaterialName(value); }
    catch (error) { expect((error as FactoryMaterialError).code).toBe("factory_material_name_invalid"); }
  }
});

test("material digests are always the namespaced hash of the assembled bytes", () => {
  const content = new TextEncoder().encode("material bytes");
  expect(factoryMaterialDigest(content)).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(assertFactoryMaterialDigest(factoryMaterialDigest(content))).toBe(factoryMaterialDigest(content));
  expect(factoryMaterialDigest(content)).not.toBe(factoryMaterialDigest(new TextEncoder().encode("other bytes")));
  for (const value of ["a".repeat(64), `sha512:${"a".repeat(64)}`, 7, undefined]) {
    expect(() => assertFactoryMaterialDigest(value)).toThrowError(FactoryMaterialError);
  }
});

test("scope and identity snapshots copy every field and reject an incomplete identity", () => {
  const mutable = { ...identity };
  const snapshot = snapshotFactoryMaterialIdentity(mutable);
  mutable.objectName = "data/other.json";
  mutable.version = 9;
  expect(snapshot).toEqual(identity);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(snapshotFactoryMaterialScope({ ...scope, extra: "ignored" } as never)).toEqual(scope);
  for (const key of ["tenantId", "projectId", "runId", "attemptId", "operationId"] as const) {
    expect(() => snapshotFactoryMaterialScope({ ...scope, [key]: "" })).toThrowError(FactoryMaterialError);
  }
  for (const version of [0, -1, 1.5, Number.NaN]) {
    expect(() => snapshotFactoryMaterialIdentity({ ...identity, version })).toThrowError(FactoryMaterialError);
  }
  expect(() => snapshotFactoryMaterialIdentity({ ...identity, objectName: "../escape" })).toThrowError(FactoryMaterialError);
});

test("the material admission key separates identities that share every artifact dimension", () => {
  expect(factoryMaterialKey(identity)).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(factoryMaterialKey(identity)).toBe(factoryMaterialKey({ ...identity }));
  const distinct = [
    { ...identity, attemptId: "other-attempt" },
    { ...identity, operationId: "run:node-a:0:1" },
    { ...identity, objectName: "data/other.json" },
    { ...identity, version: 2 },
  ];
  const keys = new Set(distinct.map(factoryMaterialKey));
  expect(keys.size).toBe(distinct.length);
  expect(keys.has(factoryMaterialKey(identity))).toBe(false);
});

test("every artifact denial funnels to one code that discloses nothing", () => {
  expect(() => unavailable()).toThrowError(FactoryArtifactAccessError);
  try { unavailable(); }
  catch (error) {
    expect((error as FactoryArtifactAccessError).code).toBe("factory_artifact_unavailable");
    expect((error as Error).name).toBe("FactoryArtifactAccessError");
    expect((error as Error).message).toBe("factory_artifact_unavailable");
  }
});
