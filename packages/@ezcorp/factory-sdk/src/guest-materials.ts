import { canonicalizeJson, sha256Hex } from "./canonical.js";
import { encodeFactoryPageBase64 } from "./page-bytes.js";
import { validateFactoryGuestMaterialRequest, validateFactoryGuestMaterialResponse } from "./validation.js";
import {
  FACTORY_GUEST_MATERIAL_LIMITS,
  type FactoryArtifactReference,
  type FactoryCheckpointReference,
  type FactoryGuestMaterialRefusal,
  type FactoryGuestMaterialRequest,
  type FactoryGuestMaterialResponse,
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
  constructor(readonly code: FactoryGuestMaterialRefusal | "guest_frame_invalid" | "guest_response_invalid", message: string) {
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
