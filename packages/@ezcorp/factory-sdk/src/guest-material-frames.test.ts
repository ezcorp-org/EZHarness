import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical";
import { encodeFactoryPageBase64, FACTORY_PAGE_BYTES_LIMIT } from "./page-bytes";
import { isFactoryGuestMaterialRequest, isFactoryGuestMaterialResponse } from "./schema";
import { FACTORY_GUEST_MATERIAL_LIMITS } from "./types";
import { isFactoryGuestMaterialFrame, validateFactoryGuestMaterialRequest, validateFactoryGuestMaterialResponse } from "./validation";

/**
 * The staging frame contract, from the side that has to refuse a bad one.
 *
 * Every case here is a frame a guest could build and a host would then have to
 * decide about. The guest SDK validates before it sends precisely so that a
 * refusal names the guest's own mistake instead of arriving as a transport
 * failure, and these are the mistakes it must name.
 */

const BUILT = join(import.meta.dir, "../dist/index.js");

const bytes = new TextEncoder().encode("staged output bytes");
const digest = `sha256:${sha256Hex(bytes)}`;

function identity(overrides: Record<string, unknown> = {}) {
  return { operationId: "run:node:0:3", operationIndex: 3, objectName: "report.json", version: 1, ...overrides };
}

function begin(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "factory.guest-material-begin.v1", ...identity(), mediaType: "application/json", totalBytes: 19, chunkCount: 1, ...overrides };
}

function chunk(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "factory.guest-material-chunk.v1", ...identity(), index: 0, digest, encodedBytes: bytes.byteLength, contentBase64: encodeFactoryPageBase64(bytes), ...overrides };
}

function seal(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "factory.guest-material-seal.v1", ...identity(), digest, ...overrides };
}

function output(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "factory.guest-material-output.v1", ...identity(), digest, ...overrides };
}

function code(value: unknown): string | undefined {
  const result = validateFactoryGuestMaterialRequest(value);
  return result.ok ? undefined : result.issues[0]?.code;
}

function answerCode(value: unknown): string | undefined {
  const result = validateFactoryGuestMaterialResponse(value);
  return result.ok ? undefined : result.issues[0]?.code;
}

test("a chunk is exactly one bounded page, so one canonical base64 codec carries both", () => {
  // The guest SDK encodes a chunk with `encodeFactoryPageBase64`, which refuses
  // anything past the page limit. If these two bounds ever diverge, a legal
  // chunk becomes unsendable with no error that names the cause.
  expect(FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes).toBe(FACTORY_PAGE_BYTES_LIMIT);
  expect(Object.isFrozen(FACTORY_GUEST_MATERIAL_LIMITS)).toBe(true);
  // The whole material must still fit the guest's one-mebibyte lifetime output
  // budget once base64 has cost it a third more.
  expect(Math.ceil(FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes / 3) * 4).toBeLessThan(1024 * 1024);
  expect(FACTORY_GUEST_MATERIAL_LIMITS.maxChunks * FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes).toBeGreaterThanOrEqual(FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes);
});

test("the four request frames pass, and a shape that is not one of them is refused by schema", () => {
  for (const frame of [begin(), chunk(), seal(), output()]) {
    expect(isFactoryGuestMaterialRequest(frame)).toBe(true);
    expect(validateFactoryGuestMaterialRequest(frame)).toEqual({ ok: true });
  }
  for (const value of [null, "begin", [begin()], {}, { ...begin(), schemaVersion: "factory.guest-material-begin.v2" }, { ...begin(), extra: 1 }]) {
    expect(code(value)).toBe("GUEST_MATERIAL_SCHEMA");
  }
});

test("an identity must name its own journalled operation, a relative object name, and a version from one", () => {
  expect(code(begin({ operationId: "run:node:0:4" }))).toBe("GUEST_MATERIAL_OPERATION");
  expect(code(begin({ operationId: "" }))).toBe("GUEST_MATERIAL_OPERATION");
  expect(code(begin({ operationIndex: -1, operationId: "run:node:0:-1" }))).toBe("GUEST_MATERIAL_OPERATION");
  for (const objectName of ["", "/absolute", "../escape", "a/../b", "a//b", "./here", "with\\backslash", "with:colon", "a\u0000b", "x".repeat(FACTORY_GUEST_MATERIAL_LIMITS.maxNameLength + 1)]) {
    expect(code(begin({ objectName })), objectName).toBe("GUEST_MATERIAL_NAME");
  }
  expect(code(begin({ objectName: "nested/report.json" }))).toBeUndefined();
  expect(code(begin({ version: 0 }))).toBe("GUEST_MATERIAL_VERSION");
});

test("a plan is refused when its media type, byte count, or chunk count cannot be honoured", () => {
  for (const mediaType of ["", "application", "application/json/extra", "/json", "Application/json", "application/", "-bad/json", `${"a".repeat(65)}/json`, `application/${"b".repeat(120)}`]) {
    expect(code(begin({ mediaType })), mediaType).toBe("GUEST_MATERIAL_MEDIA_TYPE");
  }
  expect(code(begin({ mediaType: "application/vnd.ez+json" }))).toBeUndefined();
  expect(code(begin({ totalBytes: 0 }))).toBe("GUEST_MATERIAL_BYTES");
  expect(code(begin({ totalBytes: FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes + 1, chunkCount: 64 }))).toBe("GUEST_MATERIAL_BYTES");
  expect(code(begin({ chunkCount: 0 }))).toBe("GUEST_MATERIAL_CHUNK_COUNT");
  expect(code(begin({ chunkCount: FACTORY_GUEST_MATERIAL_LIMITS.maxChunks + 1 }))).toBe("GUEST_MATERIAL_CHUNK_COUNT");
  // More chunks than bytes, and too few chunks for the bytes, are both refused.
  expect(code(begin({ totalBytes: 2, chunkCount: 3 }))).toBe("GUEST_MATERIAL_CHUNK_COUNT");
  expect(code(begin({ totalBytes: FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes * 2, chunkCount: 1 }))).toBe("GUEST_MATERIAL_CHUNK_COUNT");
  expect(code(begin({ totalBytes: FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes, chunkCount: 16 }))).toBeUndefined();
});

test("a chunk frame must carry a digest, a byte count, and base64 that agrees with both", () => {
  expect(code(chunk({ index: FACTORY_GUEST_MATERIAL_LIMITS.maxChunks }))).toBe("GUEST_MATERIAL_CHUNK_INDEX");
  expect(code(chunk({ index: -1 }))).toBe("GUEST_MATERIAL_CHUNK_INDEX");
  expect(code(chunk({ digest: sha256Hex(bytes) }))).toBe("GUEST_MATERIAL_DIGEST");
  expect(code(chunk({ digest: "sha256:NOTHEX" }))).toBe("GUEST_MATERIAL_DIGEST");
  expect(code(chunk({ encodedBytes: 0 }))).toBe("GUEST_MATERIAL_CHUNK_BYTES");
  expect(code(chunk({ encodedBytes: FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes + 1 }))).toBe("GUEST_MATERIAL_CHUNK_BYTES");
  // The declared count and the encoded content must agree, in both directions.
  expect(code(chunk({ encodedBytes: bytes.byteLength - 1 }))).toBe("GUEST_MATERIAL_CHUNK_CONTENT");
  for (const contentBase64 of ["", "AAA", "A$==", "A===", "=AAA", "AA=A", "AAAA=AAA"]) {
    expect(code(chunk({ contentBase64 })), contentBase64).toBe("GUEST_MATERIAL_CHUNK_CONTENT");
  }
  // Padding arithmetic: one and two pad characters both decode to the count they claim.
  expect(code(chunk({ contentBase64: "aGVsbG8=", encodedBytes: 5 }))).toBeUndefined();
  expect(code(chunk({ contentBase64: "aGVsbA==", encodedBytes: 4 }))).toBeUndefined();
});

test("a seal and a promotion each need a prefixed material digest", () => {
  expect(code(seal({ digest: "sha256:" }))).toBe("GUEST_MATERIAL_DIGEST");
  expect(code(output({ digest: `sha256:${"g".repeat(64)}` }))).toBe("GUEST_MATERIAL_DIGEST");
});

test("every response variant validates, and each one is refused when its own field is wrong", () => {
  const reference = { artifactId: "object-1", digest, encodedBytes: 19 };
  const begun = { schemaVersion: "factory.guest-material-response.v1", ...identity(), status: "begun", totalBytes: 19, chunkCount: 1 };
  const stored = { schemaVersion: "factory.guest-material-response.v1", ...identity(), status: "stored", index: 0, digest };
  const sealed = { schemaVersion: "factory.guest-material-response.v1", ...identity(), status: "sealed", material: reference };
  const promoted = { schemaVersion: "factory.guest-material-response.v1", ...identity(), status: "output", output: reference, resultDigest: sha256Hex(bytes) };
  const refused = { schemaVersion: "factory.guest-material-response.v1", ...identity(), status: "refused", refusal: { code: "stale_epoch", message: "the attempt fence moved" } };
  for (const value of [begun, stored, sealed, promoted, refused]) {
    expect(isFactoryGuestMaterialResponse(value)).toBe(true);
    expect(validateFactoryGuestMaterialResponse(value)).toEqual({ ok: true });
  }
  expect(answerCode(null)).toBe("GUEST_MATERIAL_SCHEMA");
  expect(answerCode({ ...refused, refusal: { code: "not_a_refusal_name", message: "x" } })).toBe("GUEST_MATERIAL_SCHEMA");
  expect(answerCode({ ...begun, operationId: "other:0" })).toBe("GUEST_MATERIAL_OPERATION");
  expect(answerCode({ ...refused, refusal: { code: "stale_epoch", message: "" } })).toBe("GUEST_MATERIAL_REFUSAL");
  expect(answerCode({ ...begun, totalBytes: 0 })).toBe("GUEST_MATERIAL_BYTES");
  expect(answerCode({ ...stored, index: -1 })).toBe("GUEST_MATERIAL_CHUNK_INDEX");
  expect(answerCode({ ...stored, digest: "sha256:zz" })).toBe("GUEST_MATERIAL_DIGEST");
  expect(answerCode({ ...sealed, material: { ...reference, artifactId: "a/b" } })).toBe("RUNNER_ARTIFACT_ID");
  expect(answerCode({ ...promoted, output: { ...reference, digest: "nope" } })).toBe("RUNNER_DIGEST");
  // BARE hex: a COMPLETED result copies this value into `resultDigest`, where
  // the runner-result validator requires the unprefixed form.
  expect(answerCode({ ...promoted, resultDigest: digest })).toBe("GUEST_MATERIAL_DIGEST");
});

test("the built barrel exports the frame bounds, both guards, and both validators", async () => {
  expect(existsSync(BUILT), `${BUILT} is missing — run bun run --cwd packages/@ezcorp/factory-sdk build`).toBe(true);
  const built = await import(BUILT) as Record<string, unknown>;
  expect(built.FACTORY_GUEST_MATERIAL_LIMITS).toEqual(FACTORY_GUEST_MATERIAL_LIMITS);
  expect(built.FACTORY_GUEST_MATERIAL_BEGIN_SCHEMA_VERSION).toBe("factory.guest-material-begin.v1");
  expect(built.FACTORY_GUEST_MATERIAL_CHUNK_SCHEMA_VERSION).toBe("factory.guest-material-chunk.v1");
  expect(built.FACTORY_GUEST_MATERIAL_SEAL_SCHEMA_VERSION).toBe("factory.guest-material-seal.v1");
  expect(built.FACTORY_GUEST_MATERIAL_OUTPUT_SCHEMA_VERSION).toBe("factory.guest-material-output.v1");
  expect(built.FACTORY_GUEST_MATERIAL_RESPONSE_SCHEMA_VERSION).toBe("factory.guest-material-response.v1");
  for (const name of ["isFactoryGuestMaterialRequest", "isFactoryGuestMaterialResponse", "validateFactoryGuestMaterialRequest", "validateFactoryGuestMaterialResponse", "createFactoryGuestStaging"]) {
    expect(typeof built[name], `${name} is not on the built barrel`).toBe("function");
  }
  expect((built.factoryGuestMaterialRequestJsonSchema as { $id?: string }).$id).toBe("urn:ezcorp:factory:guest-material-request:v1");
  expect((built.factoryGuestMaterialResponseJsonSchema as { $id?: string }).$id).toBe("urn:ezcorp:factory:guest-material-response:v1");
});

test("a host routes by frame name alone, and the four staging frames are the only names it routes", () => {
  for (const frame of [begin(), chunk(), seal(), output()]) expect(isFactoryGuestMaterialFrame(frame)).toBe(true);
  // Routing is not acceptance: a frame that names a staging version but breaks
  // its schema is still routed here, and refused by the validator after.
  expect(isFactoryGuestMaterialFrame({ schemaVersion: "factory.guest-material-seal.v1" })).toBe(true);
  expect(code({ schemaVersion: "factory.guest-material-seal.v1" })).toBe("GUEST_MATERIAL_SCHEMA");
  // A model request and every non-frame keep their own route.
  for (const other of [
    { schemaVersion: "factory.guest-model-request.v1" },
    { schemaVersion: "factory.guest-material-response.v1" },
    { schemaVersion: 1 },
    {},
    [seal()],
    null,
    "factory.guest-material-seal.v1",
  ]) expect(isFactoryGuestMaterialFrame(other)).toBe(false);
});
