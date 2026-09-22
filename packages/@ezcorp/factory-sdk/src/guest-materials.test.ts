import { expect, test } from "bun:test";
import { canonicalizeJson, sha256Hex } from "./canonical";
import { createFactoryGuestStaging, factoryGuestCheckpointName, FactoryGuestMaterialError } from "./guest-materials";
import { decodeFactoryPageBase64 } from "./page-bytes";
import { FACTORY_GUEST_MATERIAL_LIMITS, type FactoryGuestMaterialRequest, type FactoryGuestMaterialResponse, type JsonValue } from "./types";

/**
 * The guest half, driven against a host double that answers exactly what the
 * frame contract allows.
 *
 * The double is deliberately strict: it reassembles the chunks it is sent and
 * refuses a seal whose digest does not match what it actually received. A
 * permissive double would agree with a guest that chunked its own bytes wrong,
 * which is the one defect these tests exist to catch.
 */

interface HostLog {
  readonly frames: FactoryGuestMaterialRequest[];
}

function reference(bytes: Uint8Array, kind: string) {
  return { artifactId: `${kind}-object`, digest: `sha256:${sha256Hex(bytes)}`, encodedBytes: bytes.byteLength };
}

/** A host that stores what it is given and answers from what it stored. */
function host(log: HostLog, overrides: { refuse?: FactoryGuestMaterialResponse; answer?: (frame: FactoryGuestMaterialRequest) => unknown } = {}) {
  const parts = new Map<string, Uint8Array[]>();
  return async (payload: JsonValue): Promise<unknown> => {
    const frame = payload as unknown as FactoryGuestMaterialRequest;
    log.frames.push(frame);
    if (overrides.answer) return overrides.answer(frame);
    if (overrides.refuse) return overrides.refuse;
    const key = `${frame.objectName}:${frame.version}`;
    const identity = { schemaVersion: "factory.guest-material-response.v1" as const, operationId: frame.operationId, operationIndex: frame.operationIndex, objectName: frame.objectName, version: frame.version };
    if (frame.schemaVersion === "factory.guest-material-begin.v1") {
      parts.set(key, []);
      return { ...identity, status: "begun", totalBytes: frame.totalBytes, chunkCount: frame.chunkCount };
    }
    if (frame.schemaVersion === "factory.guest-material-chunk.v1") {
      const held = parts.get(key) ?? [];
      held[frame.index] = decodeFactoryPageBase64(frame.contentBase64);
      parts.set(key, held);
      return { ...identity, status: "stored", index: frame.index, digest: frame.digest };
    }
    const held = parts.get(key) ?? [];
    const total = held.reduce((sum, block) => sum + block.byteLength, 0);
    const assembled = new Uint8Array(total);
    let offset = 0;
    for (const block of held) { assembled.set(block, offset); offset += block.byteLength; }
    if (`sha256:${sha256Hex(assembled)}` !== frame.digest) {
      return { ...identity, status: "refused", refusal: { code: "digest_mismatch", message: "the assembled bytes do not match the declared digest" } };
    }
    if (frame.schemaVersion === "factory.guest-material-seal.v1") return { ...identity, status: "sealed", material: reference(assembled, "material") };
    return { ...identity, status: "output", output: reference(assembled, "candidate"), resultDigest: sha256Hex(assembled) };
  };
}

function staging(call: (payload: JsonValue) => Promise<unknown>) {
  return createFactoryGuestStaging({ call, operationId: "run:node:0:7", operationIndex: 7 });
}

async function* blocks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

test("one small material is planned, chunked, sealed, and returned by reference", async () => {
  const log: HostLog = { frames: [] };
  const bytes = new TextEncoder().encode("a staged report");
  const staged = await staging(host(log)).stageOutput("report.bin", bytes);
  // Two identities, deliberately separate: the handle's digest covers the
  // manifest the scoped reader resolves, and `digest` covers the bytes.
  expect(staged.material).toEqual({ artifactId: "material-object", digest: `sha256:${sha256Hex(bytes)}`, encodedBytes: bytes.byteLength });
  expect(staged.digest).toBe(`sha256:${sha256Hex(bytes)}`);
  expect(staged).toMatchObject({ totalBytes: bytes.byteLength, version: 1 });
  expect(log.frames.map(frame => frame.schemaVersion)).toEqual([
    "factory.guest-material-begin.v1", "factory.guest-material-chunk.v1", "factory.guest-material-seal.v1",
  ]);
  const plan = log.frames[0] as Extract<FactoryGuestMaterialRequest, { schemaVersion: "factory.guest-material-begin.v1" }>;
  expect(plan).toMatchObject({ mediaType: "application/octet-stream", totalBytes: bytes.byteLength, chunkCount: 1, version: 1, objectName: "report.bin" });
});

test("a material larger than one page is split across contiguous chunks that reassemble", async () => {
  const log: HostLog = { frames: [] };
  const bytes = new Uint8Array(FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes * 2 + 17);
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index % 251;
  const staged = await staging(host(log)).stageOutput("big.bin", bytes);
  // The host double refuses a seal it cannot reassemble, so a correct digest
  // here is evidence the chunk boundaries were right, not just that three
  // frames were sent.
  expect(staged.digest).toBe(`sha256:${sha256Hex(bytes)}`);
  const chunks = log.frames.filter(frame => frame.schemaVersion === "factory.guest-material-chunk.v1");
  expect(chunks.map(frame => (frame as { index: number }).index)).toEqual([0, 1, 2]);
  expect(chunks.map(frame => (frame as { encodedBytes: number }).encodedBytes)).toEqual([FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes, FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes, 17]);
});

test("an async sequence is drained before the plan is committed", async () => {
  const log: HostLog = { frames: [] };
  const first = new TextEncoder().encode("first ");
  const second = new TextEncoder().encode("second");
  const staged = await staging(host(log)).stageOutput("stream.bin", blocks(first, second));
  expect(staged.totalBytes).toBe(12);
  expect(staged.digest).toBe(`sha256:${sha256Hex(new TextEncoder().encode("first second"))}`);
  // One chunk, because the plan is made from the assembled length, not from
  // the caller's block sizes. A chunk per incoming block would run past the
  // declared plan the moment a producer chose a different block size.
  expect(log.frames.filter(frame => frame.schemaVersion === "factory.guest-material-chunk.v1")).toHaveLength(1);
});

test("a sequence past the total bound is refused before any frame is sent", async () => {
  const log: HostLog = { frames: [] };
  const oversized = blocks(new Uint8Array(FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes), new Uint8Array(1));
  const failure = await staging(host(log)).stageOutput("huge.bin", oversized).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(FactoryGuestMaterialError);
  expect((failure as FactoryGuestMaterialError).code).toBe("oversize");
  expect(log.frames).toHaveLength(0);
});

test("a frame this guest built wrong is refused here, with no byte spent on the channel", async () => {
  const log: HostLog = { frames: [] };
  const failure = await staging(host(log)).stageOutput("../escape", new Uint8Array([1])).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(FactoryGuestMaterialError);
  expect((failure as FactoryGuestMaterialError).code).toBe("guest_frame_invalid");
  expect((failure as Error).message).toContain("bounded relative path");
  expect(log.frames).toHaveLength(0);
});

test("a host refusal reaches the caller under the host's own name", async () => {
  const log: HostLog = { frames: [] };
  const refuse: FactoryGuestMaterialResponse = {
    schemaVersion: "factory.guest-material-response.v1", operationId: "run:node:0:7", operationIndex: 7,
    objectName: "report.bin", version: 1, status: "refused",
    refusal: { code: "deadline_expired", message: "this attempt's deadline passed" },
  };
  const failure = await staging(host(log, { refuse })).stageOutput("report.bin", new Uint8Array([7])).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(FactoryGuestMaterialError);
  expect((failure as FactoryGuestMaterialError).code).toBe("deadline_expired");
  expect((failure as Error).message).toBe("this attempt's deadline passed");
});

test("an answer that is not a staging response is a protocol failure, not a silent success", async () => {
  const log: HostLog = { frames: [] };
  const failure = await staging(host(log, { answer: () => ({ ok: true }) })).stageOutput("report.bin", new Uint8Array([7])).catch((error: unknown) => error);
  expect((failure as FactoryGuestMaterialError).code).toBe("guest_response_invalid");
});

test("a seal or a promotion answered with the wrong status is refused rather than read as one", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const identity = { schemaVersion: "factory.guest-material-response.v1" as const, operationId: "run:node:0:7", operationIndex: 7, objectName: "report.bin", version: 1 };
  const wrongSeal = staging(async (payload) => {
    const frame = payload as unknown as FactoryGuestMaterialRequest;
    if (frame.schemaVersion === "factory.guest-material-begin.v1") return { ...identity, status: "begun", totalBytes: 3, chunkCount: 1 };
    if (frame.schemaVersion === "factory.guest-material-chunk.v1") return { ...identity, status: "stored", index: 0, digest: frame.digest };
    return { ...identity, status: "begun", totalBytes: 3, chunkCount: 1 };
  });
  const sealFailure = await wrongSeal.stageOutput("report.bin", bytes).catch((error: unknown) => error);
  expect((sealFailure as FactoryGuestMaterialError).code).toBe("guest_response_invalid");
  expect((sealFailure as Error).message).toContain("A seal was answered with 'begun'");

  const wrongPromotion = staging(async () => ({ ...identity, status: "sealed", material: { artifactId: "m", digest: `sha256:${sha256Hex(bytes)}`, encodedBytes: 3 } }));
  const promoteFailure = await wrongPromotion.promoteOutput("report.bin", `sha256:${sha256Hex(bytes)}`).catch((error: unknown) => error);
  expect((promoteFailure as FactoryGuestMaterialError).code).toBe("guest_response_invalid");
  expect((promoteFailure as Error).message).toContain("A promotion was answered with 'sealed'");
});

test("a JSON result is staged as canonical bytes and promoted to the candidate output", async () => {
  const log: HostLog = { frames: [] };
  // Deliberately unsorted keys: the host re-parses the promoted bytes and
  // requires them to equal their own canonical form, so `JSON.stringify` order
  // would be refused there.
  const value = { zeta: 1, alpha: { nested: [3, 2] } } as unknown as JsonValue;
  const canonical = new TextEncoder().encode(canonicalizeJson(value));
  const promoted = await staging(host(log)).stageResult("result.json", value);
  expect(promoted).toEqual({ output: { artifactId: "candidate-object", digest: `sha256:${sha256Hex(canonical)}`, encodedBytes: canonical.byteLength }, resultDigest: sha256Hex(canonical) });
  expect(log.frames.at(-1)?.schemaVersion).toBe("factory.guest-material-output.v1");
  const plan = log.frames[0] as { mediaType: string };
  expect(plan.mediaType).toBe("application/json");
  expect(Object.isFrozen(promoted)).toBe(true);
});

test("staging the same name twice advances its version, and a promotion may name an older one", async () => {
  const log: HostLog = { frames: [] };
  const client = staging(host(log));
  const first = new TextEncoder().encode("one");
  const second = new TextEncoder().encode("two");
  await client.stageOutput("report.bin", first);
  await client.stageOutput("report.bin", second);
  expect(log.frames.filter(frame => frame.schemaVersion === "factory.guest-material-begin.v1").map(frame => frame.version)).toEqual([1, 2]);
  // Default: the latest version this guest staged, and the digest it computed
  // for it. A caller that passes neither cannot pass the wrong one.
  const latest = await client.promoteOutput("report.bin");
  expect(latest.resultDigest).toBe(sha256Hex(second));
  expect(log.frames.at(-1)?.version).toBe(2);
  // Explicit: an earlier version, named by the caller.
  const earlier = await client.promoteOutput("report.bin", `sha256:${sha256Hex(first)}`, 1);
  expect(earlier.resultDigest).toBe(sha256Hex(first));
  expect(log.frames.at(-1)?.version).toBe(1);
});

test("a recovered guest promotes by naming the digest itself, and one that names nothing is refused", async () => {
  const log: HostLog = { frames: [] };
  const bytes = new Uint8Array([9]);
  const client = staging(async (payload) => {
    const frame = payload as unknown as FactoryGuestMaterialRequest;
    log.frames.push(frame);
    return { schemaVersion: "factory.guest-material-response.v1", operationId: frame.operationId, operationIndex: frame.operationIndex, objectName: frame.objectName, version: frame.version, status: "output", output: reference(bytes, "candidate"), resultDigest: sha256Hex(bytes) };
  });
  await client.promoteOutput("recovered.json", `sha256:${sha256Hex(bytes)}`);
  expect(log.frames[0]?.version).toBe(1);

  // Nothing staged and no digest given: there is no value to guess, so this is
  // refused here rather than sent as a frame the host cannot answer.
  const failure = await client.promoteOutput("never-staged.json").catch((error: unknown) => error);
  expect((failure as FactoryGuestMaterialError).code).toBe("guest_frame_invalid");
  expect(log.frames).toHaveLength(1);
});

test("a checkpoint is a real sealed material whose cursor the result must match", async () => {
  const log: HostLog = { frames: [] };
  const client = staging(host(log));
  // Cursor -1 is the attempt that settled no operation, which the host-side
  // checkpoint writer cannot name because its own names are operation indexes.
  const attempt = await client.stageCheckpoint({ transcript: [] } as unknown as JsonValue, -1);
  expect(attempt.journalCursor).toBe(-1);
  expect(log.frames[0]?.objectName).toBe("workspace/attempt.json");
  const operation = await client.stageCheckpoint({ transcript: ["one"] } as unknown as JsonValue, 4);
  expect(operation.journalCursor).toBe(4);
  expect(log.frames.filter(frame => frame.schemaVersion === "factory.guest-material-begin.v1").at(-1)?.objectName).toBe("workspace/operation-4.json");
  // The handle is the sealed material the scoped reader resolves, so the
  // reference a result carries points at bytes that exist.
  const canonical = new TextEncoder().encode(canonicalizeJson({ transcript: ["one"] } as unknown as JsonValue));
  expect(operation.digest).toBe(`sha256:${sha256Hex(canonical)}`);
  expect(operation.encodedBytes).toBe(canonical.byteLength);
});

test("a cursor that is not a journal cursor is refused before a frame is built", () => {
  expect(factoryGuestCheckpointName(-1)).toBe("workspace/attempt.json");
  expect(factoryGuestCheckpointName(0)).toBe("workspace/operation-0.json");
  for (const cursor of [-2, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const failure = (() => { try { factoryGuestCheckpointName(cursor); return undefined; } catch (error) { return error; } })();
    expect(failure, String(cursor)).toBeInstanceOf(FactoryGuestMaterialError);
    expect((failure as FactoryGuestMaterialError).code).toBe("guest_frame_invalid");
  }
});
