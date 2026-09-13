import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import type { JsonValue } from "@ezcorp/factory-sdk";
import { MAX_PAGE_BYTES, MAX_TRANSITION_ARTIFACT_BYTES, MAX_TRANSITION_PAGES, type FinalizedTransitionArtifact, type TransitionArtifact, type TransitionArtifactRequest, type TransitionPageReference, type TransitionPageRequest, type TransitionRecord } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import { digestBytes } from "../extensions/v4/blobs";
import { FACTORY_ARTIFACT_MAX_BYTES, FactoryArtifactError, artifactJson } from "./artifacts";
import type { FactoryArtifacts } from "./artifacts";
import { FactoryInbox } from "./inbox";
import { encodeFactoryPayload, FactoryRecords } from "./records";

function eventDigest(event: unknown): string { return `sha256:${digestBytes(artifactJson.canonical(event))}`; }

/** Activity implementation that keeps transition bytes ahead of compact records. */
export class FactoryTransitionArtifacts {
  constructor(private readonly artifacts: FactoryArtifacts) {}

  async stageTransitionPage(request: TransitionPageRequest): Promise<TransitionPageReference> {
    request = JSON.parse(encodeFactoryPayload(request)) as TransitionPageRequest;
    const content = artifactJson.bytes(request.content);
    if (content.byteLength !== request.encodedBytes || content.byteLength > MAX_PAGE_BYTES || content.byteLength > FACTORY_ARTIFACT_MAX_BYTES) throw new FactoryArtifactError("factory_transition_invalid");
    const reference = await this.artifacts.stage(request, "transition_page", content, { sourceSequence: request.sourceSequence, pageIndex: request.index, interpreterScoped: true });
    return { ...reference, index: request.index };
  }

  async finalizeTransitionArtifact(request: TransitionArtifactRequest): Promise<FinalizedTransitionArtifact> {
    request = JSON.parse(encodeFactoryPayload(request)) as TransitionArtifactRequest;
    if (!Number.isSafeInteger(request.sourceSequence) || request.sourceSequence < 1 || !Number.isSafeInteger(request.encodedBytes) || request.encodedBytes < 1 || request.encodedBytes > MAX_TRANSITION_ARTIFACT_BYTES || !request.eventId || request.pages.length < 1 || request.pages.length > MAX_TRANSITION_PAGES) throw new FactoryArtifactError("factory_transition_invalid");
    const pages: string[] = [];
    for (const [index, page] of request.pages.entries()) {
      if (page.index !== index || !Number.isSafeInteger(page.encodedBytes) || page.encodedBytes < 1 || page.encodedBytes > MAX_PAGE_BYTES) throw new FactoryArtifactError("factory_transition_invalid");
      const loaded = await this.artifacts.load(request, page, ["transition_page"], true);
      if (loaded.sourceSequence !== request.sourceSequence || loaded.pageIndex !== index || loaded.content.byteLength !== page.encodedBytes) throw new FactoryArtifactError("factory_transition_invalid");
      pages.push(artifactJson.text(loaded.content));
    }
    const content = pages.join("");
    const encoded = artifactJson.bytes(content);
    if (encoded.byteLength !== request.encodedBytes || encoded.byteLength > MAX_TRANSITION_ARTIFACT_BYTES) throw new FactoryArtifactError("factory_transition_invalid");
    let transition: TransitionArtifact;
    try { transition = JSON.parse(content) as TransitionArtifact; } catch { throw new FactoryArtifactError("factory_transition_invalid"); }
    if (canonicalizeJson(transition as unknown as JsonValue) !== content || transition.schemaVersion !== "factory.transition.v1" || transition.tenantId !== request.tenantId || transition.projectId !== request.projectId || transition.logicalRunId !== request.logicalRunId || transition.interpreterId !== request.interpreterId || transition.sourceSequence !== request.sourceSequence || transition.event.id !== request.eventId) throw new FactoryArtifactError("factory_transition_invalid");
    const hash = eventDigest(transition.event);
    if (request.expectedEventHash !== undefined && request.expectedEventHash !== hash) throw new FactoryArtifactError("factory_transition_event_conflict");
    const manifestContent = artifactJson.canonical({ schemaVersion: "factory.transition-manifest.v1", tenantId: request.tenantId, projectId: request.projectId, logicalRunId: request.logicalRunId, interpreterId: request.interpreterId, sourceSequence: request.sourceSequence, eventId: request.eventId, eventHash: hash, encodedBytes: request.encodedBytes, pages: request.pages });
    if (manifestContent.byteLength > MAX_PAGE_BYTES) throw new FactoryArtifactError("factory_transition_invalid");
    const manifest = await this.artifacts.stage(request, "transition_manifest", manifestContent, { sourceSequence: request.sourceSequence, interpreterScoped: true });
    return { manifest, eventHash: hash };
  }

  async recordTransition(record: TransitionRecord): Promise<void> {
    const snapshot = JSON.parse(encodeFactoryPayload(record)) as TransitionRecord;
    if (!Number.isSafeInteger(snapshot.sourceSequence) || snapshot.sourceSequence < 1 || !snapshot.eventId || !/^sha256:[0-9a-f]{64}$/.test(snapshot.eventHash) || (snapshot.inboxSequence !== undefined && (!Number.isSafeInteger(snapshot.inboxSequence) || snapshot.inboxSequence < 1))) throw new FactoryArtifactError("factory_transition_invalid");
    const manifest = await this.artifacts.load(snapshot, snapshot.artifactManifest, ["transition_manifest"], true);
    const content = JSON.parse(artifactJson.text(manifest.content)) as { schemaVersion?: unknown; tenantId?: unknown; projectId?: unknown; logicalRunId?: unknown; interpreterId?: unknown; eventId?: unknown; eventHash?: unknown; sourceSequence?: unknown; encodedBytes?: unknown; pages?: unknown };
    if (content.schemaVersion !== "factory.transition-manifest.v1" || content.tenantId !== snapshot.tenantId || content.projectId !== snapshot.projectId || content.logicalRunId !== snapshot.logicalRunId || content.interpreterId !== snapshot.interpreterId || content.eventId !== snapshot.eventId || content.eventHash !== snapshot.eventHash || content.sourceSequence !== snapshot.sourceSequence || typeof content.encodedBytes !== "number" || !Number.isSafeInteger(content.encodedBytes) || content.encodedBytes < 1 || content.encodedBytes > MAX_TRANSITION_ARTIFACT_BYTES || !Array.isArray(content.pages) || content.pages.length < 1 || content.pages.length > MAX_TRANSITION_PAGES) throw new FactoryArtifactError("factory_transition_unfinalized");
    const records = new FactoryRecords(this.artifacts.database, snapshot.tenantId);
    const inbox = new FactoryInbox(this.artifacts.database, snapshot.tenantId);
    await this.artifacts.database.transaction(async transaction => {
      const prior = snapshot.sourceSequence === 1 ? null : await records.readAuditBatchInTransaction(transaction, { projectId: snapshot.projectId, runId: snapshot.logicalRunId, interpreterId: snapshot.interpreterId }, snapshot.sourceSequence - 1);
      await inbox.commitTransitionInTransaction(transaction, { projectId: snapshot.projectId, runId: snapshot.logicalRunId, interpreterId: snapshot.interpreterId, sourceSequence: snapshot.sourceSequence, predecessorDigest: prior?.digest ?? null, payload: { kind: "factory.transition", eventId: snapshot.eventId, eventHash: snapshot.eventHash, ...(snapshot.inboxSequence === undefined ? {} : { inboxSequence: snapshot.inboxSequence }), artifactManifest: snapshot.artifactManifest } });
    });
  }
}
