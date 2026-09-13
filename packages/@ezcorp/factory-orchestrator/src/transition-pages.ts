import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import type { JsonValue } from "@ezcorp/factory-sdk/types";
import type { KernelCommand, KernelEvent, KernelState } from "@ezcorp/factory-sdk/kernel-types";
import type {
  FactoryIdentity,
  FactoryInboxEnvelope,
  FinalizedTransitionArtifact,
  TransitionArtifact,
  TransitionPageReference,
  TransitionRecord,
} from "./contracts.ts";
import { MAX_PAGE_BYTES } from "./contracts.ts";
import { assertActivityPayloadSize, validateObjectReference } from "./validation.ts";

interface TransitionWriter {
  stageTransitionPage(request: FactoryIdentity & { readonly sourceSequence: number; readonly index: number; readonly content: string; readonly encodedBytes: number }): Promise<TransitionPageReference>;
  finalizeTransitionArtifact(request: FactoryIdentity & { readonly sourceSequence: number; readonly encodedBytes: number; readonly eventId: string; readonly expectedEventHash?: string; readonly pages: readonly TransitionPageReference[] }): Promise<FinalizedTransitionArtifact>;
  recordTransition(record: TransitionRecord): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Split UTF-8 without cutting a multi-byte code point. */
export function splitTransitionContent(content: string): readonly string[] {
  const bytes = encoder.encode(content);
  if (bytes.byteLength === 0) return [""];
  const pages: string[] = [];
  for (let offset = 0; offset < bytes.byteLength;) {
    let end = Math.min(offset + MAX_PAGE_BYTES, bytes.byteLength);
    while (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    pages.push(decoder.decode(bytes.subarray(offset, end)));
    offset = end;
  }
  return pages;
}

function validatePageReference(reference: TransitionPageReference, index: number, encodedBytes: number): void {
  validateObjectReference(reference, `factory transition page ${index}`);
  if (reference.index !== index || reference.encodedBytes !== encodedBytes) throw new Error(`factory transition page ${index} reference does not match staged content`);
}

/** Persist the exact transition, then commit its compact audit fact before effects run. */
export async function persistTransition(
  identity: FactoryIdentity,
  sourceSequence: number,
  event: KernelEvent,
  nextState: KernelState,
  commands: readonly KernelCommand[],
  inbox: Pick<FactoryInboxEnvelope, "sequence" | "eventId" | "eventHash"> | undefined,
  writer: TransitionWriter,
): Promise<void> {
  const artifact: TransitionArtifact = { schemaVersion: "factory.transition.v1", ...identity, sourceSequence, event, nextState, commands };
  const content = canonicalizeJson(JSON.parse(JSON.stringify(artifact)) as JsonValue);
  const encodedBytes = encoder.encode(content).byteLength;
  const pages: TransitionPageReference[] = [];
  for (const [index, pageContent] of splitTransitionContent(content).entries()) {
    const pageBytes = encoder.encode(pageContent).byteLength;
    const request = { ...identity, sourceSequence, index, content: pageContent, encodedBytes: pageBytes };
    assertActivityPayloadSize(request, `factory transition page ${index}`);
    const reference = await writer.stageTransitionPage(request);
    validatePageReference(reference, index, pageBytes);
    pages.push(reference);
  }
  const finalizeRequest = { ...identity, sourceSequence, encodedBytes, eventId: event.id, ...(inbox ? { expectedEventHash: inbox.eventHash } : {}), pages };
  assertActivityPayloadSize(finalizeRequest, "factory transition manifest");
  const finalized = await writer.finalizeTransitionArtifact(finalizeRequest);
  validateObjectReference(finalized.manifest, "factory transition manifest");
  if (!/^sha256:[0-9a-f]{64}$/.test(finalized.eventHash)) throw new Error("factory transition finalizer returned an invalid event digest");
  if (inbox && (inbox.eventId !== event.id || inbox.eventHash !== finalized.eventHash)) throw new Error("factory transition finalizer did not preserve the inbox event identity");
  const record: TransitionRecord = { ...identity, sourceSequence, eventId: event.id, eventHash: finalized.eventHash, ...(inbox ? { inboxSequence: inbox.sequence } : {}), artifactManifest: finalized.manifest };
  assertActivityPayloadSize(record, "factory transition audit record");
  await writer.recordTransition(record);
}
