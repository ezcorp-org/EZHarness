import { describe, expect, test } from "bun:test";
import { sha256Hex } from "./canonical";
import { factoryGuestPortAddress, FactoryGuestMaterialError, readFactoryGuestMaterial } from "./guest-materials";
import { encodeFactoryPageBase64 } from "./page-bytes";
import { FACTORY_GUEST_MATERIAL_LIMITS, type FactoryGuestMaterialRead, type JsonValue } from "./types";
import { isFactoryGuestMaterialRead, validateFactoryGuestMaterialReadRequest, validateFactoryGuestMaterialReadResponse } from "./validation";

const PAGE = FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes;
const digestOf = (bytes: Uint8Array) => `sha256:${sha256Hex(bytes)}`;
const bytesOf = (length: number) => Uint8Array.from({ length }, (_, index) => index % 251);

/** A host that answers reads of `content` under `artifactId`, and records each frame it saw. */
function host(artifactId: string, content: Uint8Array, mediaType = "application/json", tamper?: (answer: Record<string, unknown>) => Record<string, unknown>) {
  const frames: FactoryGuestMaterialRead[] = [];
  const pageCount = Math.max(1, Math.ceil(content.byteLength / PAGE));
  const call = async (payload: JsonValue): Promise<unknown> => {
    const frame = payload as unknown as FactoryGuestMaterialRead;
    frames.push(frame);
    const slice = content.subarray(frame.page * PAGE, Math.min((frame.page + 1) * PAGE, content.byteLength));
    const answer = { schemaVersion: "factory.guest-material-read-response.v1", status: "page", artifactId, digest: frame.digest, page: frame.page, mediaType, totalBytes: content.byteLength, pageCount, encodedBytes: slice.byteLength, contentBase64: encodeFactoryPageBase64(slice) };
    return tamper ? tamper(answer) : answer;
  };
  return { call, frames };
}

const frame = (overrides: Partial<FactoryGuestMaterialRead> = {}): FactoryGuestMaterialRead => ({ schemaVersion: "factory.guest-material-read.v1", artifactId: "artifact-1", digest: `sha256:${"a".repeat(64)}`, page: 0, ...overrides });

describe("the material read frame (W4H-28 P0)", () => {
  test("a read names an artifact, a content digest and a page, and nothing else", () => {
    expect(validateFactoryGuestMaterialReadRequest(frame()).ok).toBe(true);
    expect(isFactoryGuestMaterialRead(frame())).toBe(true);
    expect(isFactoryGuestMaterialRead({ schemaVersion: "factory.guest-material-begin.v1" })).toBe(false);
    expect(isFactoryGuestMaterialRead(null)).toBe(false);
    expect(isFactoryGuestMaterialRead([])).toBe(false);
    // A read carries no scope: a frame that names a run is not a read frame.
    expect(validateFactoryGuestMaterialReadRequest({ ...frame(), runId: "another-run" }).ok).toBe(false);
  });

  test.each([
    ["an empty artifact id", { artifactId: "" }, "GUEST_MATERIAL_READ_ARTIFACT"],
    ["an unprefixed digest", { digest: "a".repeat(64) }, "GUEST_MATERIAL_DIGEST"],
    ["a negative page", { page: -1 }, "GUEST_MATERIAL_READ_PAGE"],
    ["a page past the staging bound", { page: Math.ceil(FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes / PAGE) }, "GUEST_MATERIAL_READ_PAGE"],
  ])("refuses %s", (_name, overrides, code) => {
    const result = validateFactoryGuestMaterialReadRequest(frame(overrides));
    expect(result.ok ? undefined : result.issues[0]?.code).toBe(code);
  });

  test("a page must be exactly its slice of a bounded whole", () => {
    const page = { schemaVersion: "factory.guest-material-read-response.v1", status: "page", artifactId: "a", digest: `sha256:${"a".repeat(64)}`, page: 1, mediaType: "application/json", totalBytes: PAGE + 3, pageCount: 2, encodedBytes: 3, contentBase64: encodeFactoryPageBase64(bytesOf(3)) };
    expect(validateFactoryGuestMaterialReadResponse(page).ok).toBe(true);
    const code = (value: unknown) => { const result = validateFactoryGuestMaterialReadResponse(value); return result.ok ? undefined : result.issues[0]?.code; };
    expect(code({ ...page, pageCount: 3 })).toBe("GUEST_MATERIAL_READ_PAGE");
    expect(code({ ...page, encodedBytes: 2, contentBase64: encodeFactoryPageBase64(bytesOf(2)) })).toBe("GUEST_MATERIAL_CHUNK_BYTES");
    expect(code({ ...page, contentBase64: encodeFactoryPageBase64(bytesOf(2)) })).toBe("GUEST_MATERIAL_CHUNK_CONTENT");
    expect(code({ ...page, totalBytes: FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes + 1 })).toBe("GUEST_MATERIAL_BYTES");
    expect(code({ ...page, mediaType: "json" })).toBe("GUEST_MATERIAL_MEDIA_TYPE");
    expect(code({ ...page, page: 99 })).toBe("GUEST_MATERIAL_READ_PAGE");
    expect(code({ ...page, status: "refused", refusal: { code: "unknown_material", message: "" } })).toBe("GUEST_MATERIAL_SCHEMA");
    const refusal = { schemaVersion: page.schemaVersion, status: "refused", artifactId: "a", digest: page.digest, page: 0, refusal: { code: "unknown_material", message: "x".repeat(4_097) } };
    expect(code(refusal)).toBe("GUEST_MATERIAL_REFUSAL");
    expect(code({ ...refusal, refusal: { code: "unknown_material", message: "not this run's" } })).toBeUndefined();
    expect(code({ ...refusal, digest: "nope" })).toBe("GUEST_MATERIAL_DIGEST");
    expect(code({ ...refusal, page: -1 })).toBe("GUEST_MATERIAL_READ_PAGE");
  });
});

describe("readFactoryGuestMaterial", () => {
  test("reads a whole across pages and proves its digest", async () => {
    const content = bytesOf(2 * PAGE + 17);
    const { call, frames } = host("snapshot", content);
    const read = await readFactoryGuestMaterial(call, { artifactId: "snapshot", digest: digestOf(content) });
    expect(read.content).toEqual(content);
    expect(read.mediaType).toBe("application/json");
    expect(frames.map(entry => entry.page)).toEqual([0, 1, 2]);
  });

  test("refuses bytes that are not the digest it asked for", async () => {
    const content = bytesOf(10);
    const { call } = host("snapshot", content);
    await expect(readFactoryGuestMaterial(call, { artifactId: "snapshot", digest: `sha256:${"0".repeat(64)}` })).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  test("raises the host's refusal by its own name", async () => {
    const call = async (payload: JsonValue) => ({ schemaVersion: "factory.guest-material-read-response.v1", status: "refused", artifactId: (payload as never as FactoryGuestMaterialRead).artifactId, digest: (payload as never as FactoryGuestMaterialRead).digest, page: 0, refusal: { code: "unknown_material", message: "not a material of this run" } });
    await expect(readFactoryGuestMaterial(call, { artifactId: "other-run", digest: `sha256:${"a".repeat(64)}` })).rejects.toMatchObject({ code: "unknown_material" });
  });

  test.each([
    ["another address", (answer: Record<string, unknown>) => ({ ...answer, artifactId: "other" })],
    ["another page", (answer: Record<string, unknown>) => (answer.page === 1 ? { ...answer, page: 0 } : answer)],
    ["a value that is not a read response", () => ({ status: "page" })],
    ["pages that disagree about the whole", (answer: Record<string, unknown>) => (answer.page === 1 ? { ...answer, mediaType: "text/plain" } : answer)],
  ])("refuses a host that answers %s", async (_name, tamper) => {
    const content = bytesOf(PAGE + 5);
    const { call } = host("snapshot", content, "application/json", tamper);
    await expect(readFactoryGuestMaterial(call, { artifactId: "snapshot", digest: digestOf(content) })).rejects.toMatchObject({ code: "guest_response_invalid" });
  });

  test("refuses to send a frame the contract refuses", async () => {
    const { call, frames } = host("snapshot", bytesOf(1));
    await expect(readFactoryGuestMaterial(call, { artifactId: "", digest: digestOf(bytesOf(1)) })).rejects.toBeInstanceOf(FactoryGuestMaterialError);
    expect(frames).toHaveLength(0);
  });

  test("an input port's material value is the address", () => {
    expect(factoryGuestPortAddress({ digest: `sha256:${"b".repeat(64)}`, mediaType: "application/json", storage: "material-1" })).toEqual({ artifactId: "material-1", digest: `sha256:${"b".repeat(64)}` });
    expect(() => factoryGuestPortAddress({ digest: 1 })).toThrow(FactoryGuestMaterialError);
    expect(() => factoryGuestPortAddress(null)).toThrow(FactoryGuestMaterialError);
  });
});
