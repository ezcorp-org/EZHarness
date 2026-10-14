import { sha256Hex } from "@ezcorp/factory-sdk/canonical";
import { decodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import type { FactoryGuestMaterialRequest, JsonValue } from "@ezcorp/factory-sdk";

/**
 * A strict host double for the guest material frames, for root suites that drive a guest tool
 * in process. It reassembles the chunks it is sent and refuses a seal whose digest is not the bytes
 * it received, as the product's material broker does; `stored` holds what each object sealed to.
 * (The SDK's own suite keeps its copy: a package test cannot import a root helper.)
 */
export function factoryGuestMaterialHost(): { readonly call: (payload: JsonValue) => Promise<unknown>; readonly frames: FactoryGuestMaterialRequest[]; readonly stored: Map<string, Uint8Array> } {
  const frames: FactoryGuestMaterialRequest[] = [];
  const parts = new Map<string, Uint8Array[]>();
  const stored = new Map<string, Uint8Array>();
  const call = async (payload: JsonValue): Promise<unknown> => {
    const frame = payload as unknown as FactoryGuestMaterialRequest;
    frames.push(frame);
    const key = `${frame.objectName}:${frame.version}`;
    const identity = { schemaVersion: "factory.guest-material-response.v1" as const, operationId: frame.operationId, operationIndex: frame.operationIndex, objectName: frame.objectName, version: frame.version };
    if (frame.schemaVersion === "factory.guest-material-begin.v1") {
      parts.set(key, []);
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
    return frame.schemaVersion === "factory.guest-material-seal.v1" ? { ...identity, status: "sealed", material: reference } : { ...identity, status: "output", output: reference, resultDigest: sha256Hex(assembled) };
  };
  return { call, frames, stored };
}

/** The canonical JSON a guest staged under one object name, parsed. */
export function factoryGuestStagedJson(stored: Map<string, Uint8Array>, objectName: string): unknown {
  const bytes = stored.get(objectName);
  return bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
