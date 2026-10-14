import { canonicalizeJson, sha256Hex } from "./canonical.js";
import { decodeFactoryPageBase64, encodeFactoryPageBase64 } from "./page-bytes.js";
import { validateFactoryGuestMaterialReadRequest, validateFactoryGuestMaterialReadResponse, validateFactoryGuestMaterialRequest, validateFactoryGuestMaterialResponse } from "./validation.js";
import {
  FACTORY_GUEST_MATERIAL_LIMITS,
  FACTORY_GUEST_MATERIAL_READ_SCHEMA_VERSION,
  type FactoryArtifactReference,
  type FactoryCheckpointReference,
  type FactoryGuestMaterialReadRefusal,
  type FactoryGuestMaterialReadResponse,
  type FactoryGuestMaterialRefusal,
  type FactoryGuestMaterialRequest,
  type FactoryGuestMaterialResponse,
  type FactoryRunnerRequest,
  type JsonValue,
} from "./types.js";

/**
 * The guest half of the material staging contract.
 *
 * A sandboxed guest has no network and one reverse control frame, so this is
 * the only way bytes leave it. Every frame it builds is validated here before
 * it is sent: a guest that sends a frame the host will refuse has spent part of
 * its one-mebibyte lifetime output budget for nothing, and the refusal would
 * arrive without saying which of its own numbers was wrong.
 *
 * Nothing here carries authority. The attempt token the runner request already
 * holds is what the host verifies, and every scope field — tenant, project,
 * run, attempt, node instance, candidate generation — is read from that
 * verified attempt on the host side. A frame names only an operation, an object
 * name, and a version.
 *
 * The module is deliberately import-light: the canonical digest, the canonical
 * base64 page codec, and the shared validators. It reaches no storage client,
 * no subprocess, and no host directory, so an isolated guest can stage it flat.
 */

export const FACTORY_GUEST_MATERIAL_DEFAULT_MEDIA_TYPE = "application/octet-stream";
export const FACTORY_GUEST_MATERIAL_JSON_MEDIA_TYPE = "application/json";

/** What a refused frame raises. The code is the host's own refusal name. */
export class FactoryGuestMaterialError extends Error {
  constructor(readonly code: FactoryGuestMaterialRefusal | FactoryGuestMaterialReadRefusal | "guest_frame_invalid" | "guest_response_invalid", message: string) {
    super(message);
    this.name = "FactoryGuestMaterialError";
  }
}

/**
 * The one reverse call a guest makes, already bound to `factory.broker`.
 *
 * The v4 SDK gives a tool `context.call(method, input)`; a caller passes
 * `payload => context.call("factory.broker", payload)`. The Python guest binds
 * its own channel to the same shape, which is what keeps the two runtimes on
 * one contract instead of two.
 */
export type FactoryGuestBrokerCall = (payload: JsonValue) => Promise<unknown>;

export interface FactoryGuestStagingOptions {
  readonly call: FactoryGuestBrokerCall;
  /** The journalled operation every material this guest stages belongs to. */
  readonly operationId: string;
  readonly operationIndex: number;
}

export interface FactoryGuestStagedOutput {
  /** The candidate output a COMPLETED runner result names. */
  readonly output: FactoryArtifactReference;
  /** Bare 64-hex; a COMPLETED result's `resultDigest` must equal this. */
  readonly resultDigest: string;
}

/**
 * What one sealed material is, in the two identities it actually has.
 *
 * `material` is the sealed handle — an artifact of kind `material` holding the
 * chunk manifest, which is what the scoped reader resolves and what a
 * validator or a release profile is given. Its digest covers the MANIFEST.
 * `digest` covers the assembled CONTENT, and that is the one a promotion
 * names. They are different values over different bytes, and returning only
 * the handle is how a caller ends up promoting with the wrong one.
 */
export interface FactoryGuestStagedMaterial {
  readonly material: FactoryArtifactReference;
  /** `sha256:` + 64 hex over the assembled bytes. */
  readonly digest: string;
  readonly totalBytes: number;
  readonly version: number;
}

export interface FactoryGuestStaging {
  /**
   * Chunks, seals, and returns the sealed material.
   *
   * `bytes` may be one buffer or an async sequence of them; the sequence is
   * drained into memory before the first frame, because the plan a `begin`
   * frame commits to names the exact byte and chunk counts and a stream that
   * ends early would leave a half-written material no later call can finish.
   * The bound that makes this safe is the same one the channel imposes.
   */
  stageOutput(objectName: string, bytes: Uint8Array | AsyncIterable<Uint8Array>, mediaType?: string): Promise<FactoryGuestStagedMaterial>;
  /**
   * Promotes one sealed material to this attempt's candidate output.
   *
   * `contentDigest` covers the assembled bytes, not the material handle. It
   * defaults to the digest this client computed when it staged that name, so
   * the ordinary path cannot pass the wrong one; a guest that recovered and has
   * no memory of the upload passes it explicitly.
   */
   promoteOutput(objectName: string, contentDigest?: string, version?: number): Promise<FactoryGuestStagedOutput>;
  /** Stages a JSON value as canonical bytes and promotes it in one step. */
  stageResult(objectName: string, value: JsonValue): Promise<FactoryGuestStagedOutput>;
  /**
   * Stages one workspace checkpoint and returns the reference a result carries.
   *
   * A COMPLETED result must carry a checkpoint whose `journalCursor` equals the
   * result's own, and `validateFactoryRunnerResult` refuses any other pairing.
   * The reference points at a real sealed material under the reserved
   * `workspace/` prefix, so recovery reads the same verified bytes through the
   * same scoped reader rather than following a handle to nothing.
   */
  stageCheckpoint(value: JsonValue, journalCursor: number): Promise<FactoryCheckpointReference>;
}

/**
 * The object name one checkpoint occupies, under W04's reserved prefix.
 *
 * An attempt that settled no operation has cursor -1, which the host-side
 * `FactoryWorkspaceCheckpoints.objectName` refuses because it names an
 * operation index. A guest checkpoint is named by its cursor instead, and the
 * two never collide: `attempt` is not an operation number.
 */
export function factoryGuestCheckpointName(journalCursor: number): string {
  if (!Number.isSafeInteger(journalCursor) || journalCursor < -1) throw new FactoryGuestMaterialError("guest_frame_invalid", "A journal cursor is -1 or a nonnegative safe integer.");
  return journalCursor < 0 ? "workspace/attempt.json" : `workspace/operation-${journalCursor}.json`;
}

function chunkPlan(totalBytes: number): number {
  return Math.max(1, Math.ceil(totalBytes / FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes));
}

async function collect(bytes: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (bytes instanceof Uint8Array) return bytes;
  const blocks: Uint8Array[] = [];
  let total = 0;
  for await (const block of bytes) {
    total += block.byteLength;
    if (total > FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes) {
      throw new FactoryGuestMaterialError("oversize", `A guest may stage at most ${FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes} bytes in one material.`);
    }
    blocks.push(block);
  }
  const assembled = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    assembled.set(block, offset);
    offset += block.byteLength;
  }
  return assembled;
}

/**
 * Builds the staging client.
 *
 * Version numbers are tracked per object name so a guest that stages the same
 * name twice advances to version 2 rather than colliding with itself; the host
 * enforces the same rule from the durable row, so an out-of-step guest is
 * refused by name instead of silently overwriting.
 */
export function createFactoryGuestStaging(options: FactoryGuestStagingOptions): FactoryGuestStaging {
  const staged = new Map<string, { readonly version: number; readonly digest: string }>();

  const send = async (frame: FactoryGuestMaterialRequest): Promise<FactoryGuestMaterialResponse> => {
    const outgoing = validateFactoryGuestMaterialRequest(frame);
    if (!outgoing.ok) throw new FactoryGuestMaterialError("guest_frame_invalid", outgoing.issues[0]?.message ?? "This guest built a staging frame the shared contract refuses.");
    const answer = await options.call(frame as unknown as JsonValue);
    const incoming = validateFactoryGuestMaterialResponse(answer);
    if (!incoming.ok) throw new FactoryGuestMaterialError("guest_response_invalid", incoming.issues[0]?.message ?? "The host answered with a value that is not a staging response.");
    const response = answer as FactoryGuestMaterialResponse;
    if (response.status === "refused") throw new FactoryGuestMaterialError(response.refusal.code, response.refusal.message);
    return response;
  };

  const identity = (objectName: string, version: number) => ({
    operationId: options.operationId,
    operationIndex: options.operationIndex,
    objectName,
    version,
  });

  const stageOutput = async (objectName: string, source: Uint8Array | AsyncIterable<Uint8Array>, mediaType = FACTORY_GUEST_MATERIAL_DEFAULT_MEDIA_TYPE): Promise<FactoryGuestStagedMaterial> => {
    const content = await collect(source);
    const version = (staged.get(objectName)?.version ?? 0) + 1;
    const chunkCount = chunkPlan(content.byteLength);
    await send({ schemaVersion: "factory.guest-material-begin.v1", ...identity(objectName, version), mediaType, totalBytes: content.byteLength, chunkCount });
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes;
      const slice = content.subarray(start, Math.min(start + FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes, content.byteLength));
      await send({
        schemaVersion: "factory.guest-material-chunk.v1",
        ...identity(objectName, version),
        index,
        digest: `sha256:${sha256Hex(slice)}`,
        encodedBytes: slice.byteLength,
        contentBase64: encodeFactoryPageBase64(slice),
      });
    }
    const digest = `sha256:${sha256Hex(content)}`;
    const sealed = await send({ schemaVersion: "factory.guest-material-seal.v1", ...identity(objectName, version), digest });
    if (sealed.status !== "sealed") throw new FactoryGuestMaterialError("guest_response_invalid", `A seal was answered with '${sealed.status}'.`);
    staged.set(objectName, { version, digest });
    return Object.freeze({ material: sealed.material, digest, totalBytes: content.byteLength, version });
  };

  const promoteOutput = async (objectName: string, contentDigest?: string, version?: number): Promise<FactoryGuestStagedOutput> => {
    const held = staged.get(objectName);
    const digest = contentDigest ?? held?.digest;
    if (digest === undefined) throw new FactoryGuestMaterialError("guest_frame_invalid", `This guest did not stage '${objectName}', so it cannot name the bytes to promote.`);
    const promoted = await send({ schemaVersion: "factory.guest-material-output.v1", ...identity(objectName, version ?? held?.version ?? 1), digest });
    if (promoted.status !== "output") throw new FactoryGuestMaterialError("guest_response_invalid", `A promotion was answered with '${promoted.status}'.`);
    return Object.freeze({ output: promoted.output, resultDigest: promoted.resultDigest });
  };

  return Object.freeze({
    stageOutput,
    promoteOutput,
    async stageResult(objectName: string, value: JsonValue): Promise<FactoryGuestStagedOutput> {
      // Canonical I-JSON, because the host re-parses the promoted bytes and
      // requires them to equal their own canonical form. Sending
      // `JSON.stringify` output would be refused for key order alone.
      const content = new TextEncoder().encode(canonicalizeJson(value));
      const material = await stageOutput(objectName, content, FACTORY_GUEST_MATERIAL_JSON_MEDIA_TYPE);
      return promoteOutput(objectName, material.digest, material.version);
    },
    async stageCheckpoint(value: JsonValue, journalCursor: number): Promise<FactoryCheckpointReference> {
      const content = new TextEncoder().encode(canonicalizeJson(value));
      const material = await stageOutput(factoryGuestCheckpointName(journalCursor), content, FACTORY_GUEST_MATERIAL_JSON_MEDIA_TYPE);
      return Object.freeze({ ...material.material, journalCursor });
    },
  });
}

/**
 * The COMPLETED result of a task that settled no operation: cursor one below
 * the attempt's next operation index, no rows, measured zero usage.
 *
 * A completed result must mirror the journal row for row, and a guest that
 * called nothing through the broker has no rows to mirror. The output is staged
 * under `outputName` and a checkpoint under the cursor's name, both through the
 * one staging client, so every deterministic guest task ends the same way
 * (W19a's graph guest, the reference-code runners).
 */
/** The operation id the journal keys a guest's operation by: run, node instance, generation, index. */
export function factoryGuestOperationId(request: FactoryRunnerRequest, index: number): string {
  const authority = request.authority;
  return `${authority.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:${index}`;
}

export async function factoryGuestCompletedWithoutOperations(input: {
  readonly request: FactoryRunnerRequest;
  readonly call: FactoryGuestBrokerCall;
  readonly outputName: string;
  /** The node's output, or a function that stages its materials through the same client first and answers it. */
  readonly output: JsonValue | ((staging: FactoryGuestStaging) => Promise<JsonValue>);
  readonly checkpointSchema: string;
}): Promise<Record<string, JsonValue>> {
  const { authority } = input.request;
  const index = authority.nextOperationIndex;
  const staging = createFactoryGuestStaging({ call: input.call, operationId: factoryGuestOperationId(input.request, index), operationIndex: index });
  const output = typeof input.output === "function" ? await input.output(staging) : input.output;
  const promoted = await staging.stageResult(input.outputName, output);
  const cursor = index - 1;
  const checkpoint = await staging.stageCheckpoint({ schemaVersion: input.checkpointSchema, cursor }, cursor);
  return {
    schemaVersion: "factory.runner.result.v1",
    status: "completed",
    journalCursor: cursor,
    operations: [],
    resultDigest: promoted.resultDigest,
    output: promoted.output as unknown as JsonValue,
    usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" },
    workspaceCheckpoint: checkpoint as unknown as JsonValue,
  };
}

/** What a guest names to read: an artifact id and the digest of the content it expects. */
export interface FactoryGuestMaterialAddress {
  readonly artifactId: string;
  readonly digest: string;
}

export interface FactoryGuestReadMaterial {
  readonly content: Uint8Array;
  readonly mediaType: string;
}

/**
 * The address an input port's material value names: `{ digest, mediaType, storage }`, where
 * `storage` is the sealed material's artifact id and `digest` covers its content.
 */
export function factoryGuestPortAddress(value: unknown): FactoryGuestMaterialAddress {
  const port = value as { digest?: unknown; storage?: unknown } | null;
  if (!port || typeof port !== "object" || typeof port.digest !== "string" || typeof port.storage !== "string") {
    throw new FactoryGuestMaterialError("guest_frame_invalid", "An input port names a material as { digest, mediaType, storage }.");
  }
  return { artifactId: port.storage, digest: port.digest };
}

/**
 * Reads one sealed material or candidate output of this guest's own run, page by page (W4H-28).
 *
 * The host takes the run from the verified attempt, so the address carries no scope. Every page is
 * validated, every page must agree with the first about the whole, and the assembled bytes must
 * have the digest the guest asked for: a host that answered other bytes is refused here, not used.
 */
export async function readFactoryGuestMaterial(call: FactoryGuestBrokerCall, address: FactoryGuestMaterialAddress): Promise<FactoryGuestReadMaterial> {
  const pages: Uint8Array[] = [];
  let first: Extract<FactoryGuestMaterialReadResponse, { status: "page" }> | undefined;
  for (let page = 0; page < (first?.pageCount ?? 1); page += 1) {
    const frame = { schemaVersion: FACTORY_GUEST_MATERIAL_READ_SCHEMA_VERSION, artifactId: address.artifactId, digest: address.digest, page };
    const outgoing = validateFactoryGuestMaterialReadRequest(frame);
    if (!outgoing.ok) throw new FactoryGuestMaterialError("guest_frame_invalid", outgoing.issues[0]?.message ?? "This guest built a read frame the shared contract refuses.");
    const answer = await call(frame as unknown as JsonValue);
    const incoming = validateFactoryGuestMaterialReadResponse(answer);
    if (!incoming.ok) throw new FactoryGuestMaterialError("guest_response_invalid", incoming.issues[0]?.message ?? "The host answered with a value that is not a read response.");
    const response = answer as FactoryGuestMaterialReadResponse;
    if (response.artifactId !== address.artifactId || response.digest !== address.digest || response.page !== page) {
      throw new FactoryGuestMaterialError("guest_response_invalid", "The host answered a read for another address or page.");
    }
    if (response.status === "refused") throw new FactoryGuestMaterialError(response.refusal.code, response.refusal.message);
    first ??= response;
    if (response.pageCount !== first.pageCount || response.totalBytes !== first.totalBytes || response.mediaType !== first.mediaType) {
      throw new FactoryGuestMaterialError("guest_response_invalid", "The host's pages disagree about the whole they belong to.");
    }
    pages.push(decodeFactoryPageBase64(response.contentBase64));
  }
  const content = new Uint8Array(first!.totalBytes);
  let offset = 0;
  for (const page of pages) { content.set(page, offset); offset += page.byteLength; }
  if (`sha256:${sha256Hex(content)}` !== address.digest) throw new FactoryGuestMaterialError("digest_mismatch", "The assembled bytes do not have the digest this guest asked for.");
  return Object.freeze({ content, mediaType: first!.mediaType });
}

