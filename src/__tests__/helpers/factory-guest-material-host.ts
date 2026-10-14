import { canonicalizeJson, sha256Hex } from "@ezcorp/factory-sdk/canonical";
import { decodeFactoryPageBase64, encodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import { FACTORY_GUEST_MATERIAL_LIMITS, type FactoryGuestMaterialRead, type FactoryGuestMaterialRequest, type FactoryGuestModelRequest, type FactoryMeasuredUsage, type JsonValue } from "@ezcorp/factory-sdk";

/** A scripted model: the text it answers a request with, and that answer's measured usage. */
export type FactoryGuestScriptedModel = (request: FactoryGuestModelRequest) => { readonly text: string; readonly usage?: FactoryMeasuredUsage };

/**
 * A strict host double for the guest material frames, for root suites that drive a guest tool
 * in process. It reassembles the chunks it is sent and refuses a seal whose digest is not the bytes
 * it received, as the product's material broker does; `stored` holds what each object sealed to.
 * (The SDK's own suite keeps its copy: a package test cannot import a root helper.)
 */
export function factoryGuestMaterialHost(options: { readonly model?: FactoryGuestScriptedModel; readonly preload?: ReadonlyMap<string, Uint8Array> } = {}): { readonly call: (payload: JsonValue) => Promise<unknown>; readonly frames: FactoryGuestMaterialRequest[]; readonly stored: Map<string, Uint8Array>; readonly byId: Map<string, Uint8Array>; readonly models: FactoryGuestModelRequest[] } {
  const frames: FactoryGuestMaterialRequest[] = [];
  const models: FactoryGuestModelRequest[] = [];
  const parts = new Map<string, Uint8Array[]>();
  const stored = new Map<string, Uint8Array>();
  // Every sealed object and promoted output by artifact id, as the read frame addresses them.
  const byId = new Map<string, Uint8Array>(options.preload ?? []);
  const sealedKeys = new Set<string>();
  const answerModel = (request: FactoryGuestModelRequest) => {
    models.push(request);
    const scripted = options.model!(request);
    const usage = scripted.usage ?? { kind: "measured", inputTokens: 1, outputTokens: 1, computeMs: 1, costMicros: "0" };
    const answer = { schemaVersion: "factory.guest-model-response.v1", status: "completed", text: scripted.text, providerReceiptDigest: "d".repeat(64), usage };
    // The product seals the completed call's checkpoint itself; the guest recovers its handle.
    const key = `workspace/operation-${request.operationIndex}.json:1`;
    parts.set(key, [new TextEncoder().encode(canonicalizeJson({ ...answer } as unknown as JsonValue))]);
    sealedKeys.add(key);
    return { ...answer, operationId: request.operationId };
  };
  const answerRead = (read: FactoryGuestMaterialRead) => {
    const address = { schemaVersion: "factory.guest-material-read-response.v1", artifactId: read.artifactId, digest: read.digest, page: read.page };
    const content = byId.get(read.artifactId);
    if (content === undefined) return { ...address, status: "refused", refusal: { code: "unknown_material", message: "not a material of this run" } };
    if (`sha256:${sha256Hex(content)}` !== read.digest) return { ...address, status: "refused", refusal: { code: "digest_mismatch", message: "other content" } };
    const size = FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes;
    const slice = content.subarray(read.page * size, (read.page + 1) * size);
    return { ...address, status: "page", mediaType: "application/json", totalBytes: content.byteLength, pageCount: Math.max(1, Math.ceil(content.byteLength / size)), encodedBytes: slice.byteLength, contentBase64: encodeFactoryPageBase64(slice) };
  };
  const call = async (payload: JsonValue): Promise<unknown> => {
    const schemaVersion = (payload as { schemaVersion?: string }).schemaVersion;
    if (schemaVersion === "factory.guest-model-request.v1" && options.model) return answerModel(payload as unknown as FactoryGuestModelRequest);
    if (schemaVersion === "factory.guest-material-read.v1") return answerRead(payload as unknown as FactoryGuestMaterialRead);
    const frame = payload as unknown as FactoryGuestMaterialRequest;
    frames.push(frame);
    const key = `${frame.objectName}:${frame.version}`;
    const identity = { schemaVersion: "factory.guest-material-response.v1" as const, operationId: frame.operationId, operationIndex: frame.operationIndex, objectName: frame.objectName, version: frame.version };
    if (frame.schemaVersion === "factory.guest-material-begin.v1") {
      // A begin of a material the product already sealed recovers it rather than restarting it.
      if (!sealedKeys.has(key)) parts.set(key, []);
      return { ...identity, status: "begun", totalBytes: frame.totalBytes, chunkCount: frame.chunkCount };
    }
    if (frame.schemaVersion === "factory.guest-material-chunk.v1") {
      parts.get(key)![frame.index] = decodeFactoryPageBase64(frame.contentBase64);
      return { ...identity, status: "stored", index: frame.index, digest: frame.digest };
    }
    const assembled = new Uint8Array(Buffer.concat(parts.get(key) ?? []));
    if (`sha256:${sha256Hex(assembled)}` !== frame.digest) return { ...identity, status: "refused", refusal: { code: "digest_mismatch", message: "the assembled bytes do not match the declared digest" } };
    stored.set(frame.objectName, assembled);
    const reference = { artifactId: `object-${sha256Hex(assembled).slice(0, 16)}`, digest: frame.digest, encodedBytes: assembled.byteLength };
    byId.set(reference.artifactId, assembled);
    return frame.schemaVersion === "factory.guest-material-seal.v1" ? { ...identity, status: "sealed", material: reference } : { ...identity, status: "output", output: reference, resultDigest: sha256Hex(assembled) };
  };
  return { call, frames, stored, byId, models };
}

/** The canonical JSON a guest staged under one object name, parsed. */
export function factoryGuestStagedJson(stored: Map<string, Uint8Array>, objectName: string): unknown {
  const bytes = stored.get(objectName);
  return bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
