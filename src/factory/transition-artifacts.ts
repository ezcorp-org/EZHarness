import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import type { JsonValue } from "@ezcorp/factory-sdk";
import type { FinalizedTransitionArtifact, TransitionArtifact, TransitionArtifactRequest, TransitionPageReference, TransitionPageRequest, TransitionRecord } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import { digestBytes } from "../extensions/v4/blobs";
import { FACTORY_ARTIFACT_MAX_BYTES, FactoryArtifactError, artifactJson } from "./artifacts";
import type { FactoryArtifacts } from "./artifacts";
import { FactoryRecords } from "./records";

function eventDigest(event: unknown): string { return `sha256:${digestBytes(artifactJson.canonical(event))}`; }

/** Activity implementation that keeps transition bytes ahead of compact records. */
export class FactoryTransitionArtifacts {
  constructor(private readonly artifacts: FactoryArtifacts) {}

  async stageTransitionPage(request: TransitionPageRequest): Promise<TransitionPageReference> {
    const content = artifactJson.bytes(request.content);
    if (content.byteLength !== request.encodedBytes || content.byteLength > FACTORY_ARTIFACT_MAX_BYTES) throw new FactoryArtifactError("factory_transition_invalid");
    const reference = await this.artifacts.stage(request, "transition_page", content, { sourceSequence: request.sourceSequence, pageIndex: request.index, interpreterScoped: true });
    return { ...reference, index: request.index };
  }

  async finalizeTransitionArtifact(request: TransitionArtifactRequest): Promise<FinalizedTransitionArtifact> {
    if (!Number.isSafeInteger(request.sourceSequence) || request.sourceSequence < 1 || !Number.isSafeInteger(request.encodedBytes) || request.encodedBytes < 1 || request.encodedBytes > FACTORY_ARTIFACT_MAX_BYTES || !request.eventId) throw new FactoryArtifactError("factory_transition_invalid");
    const pages: string[] = [];
    for (const [index, page] of request.pages.entries()) {
      if (page.index !== index) throw new FactoryArtifactError("factory_transition_invalid");
      const loaded = await this.artifacts.load(request, page, ["transition_page"], true);
      if (loaded.sourceSequence !== request.sourceSequence || loaded.pageIndex !== index) throw new FactoryArtifactError("factory_transition_invalid");
      pages.push(artifactJson.text(loaded.content));
    }
    const content = pages.join("");
    const encoded = artifactJson.bytes(content);
    if (encoded.byteLength !== request.encodedBytes) throw new FactoryArtifactError("factory_transition_invalid");
    let transition: TransitionArtifact;
    try { transition = JSON.parse(content) as TransitionArtifact; } catch { throw new FactoryArtifactError("factory_transition_invalid"); }
    if (canonicalizeJson(transition as unknown as JsonValue) !== content || transition.schemaVersion !== "factory.transition.v1" || transition.tenantId !== request.tenantId || transition.projectId !== request.projectId || transition.logicalRunId !== request.logicalRunId || transition.interpreterId !== request.interpreterId || transition.sourceSequence !== request.sourceSequence || transition.event.id !== request.eventId) throw new FactoryArtifactError("factory_transition_invalid");
    const hash = eventDigest(transition.event);
    if (request.expectedEventHash !== undefined && request.expectedEventHash !== hash) throw new FactoryArtifactError("factory_transition_event_conflict");
    const manifestContent = artifactJson.canonical({ schemaVersion: "factory.transition-manifest.v1", tenantId: request.tenantId, projectId: request.projectId, logicalRunId: request.logicalRunId, interpreterId: request.interpreterId, sourceSequence: request.sourceSequence, eventId: request.eventId, eventHash: hash, encodedBytes: request.encodedBytes, pages: request.pages });
    const manifest = await this.artifacts.stage(request, "transition_manifest", manifestContent, { sourceSequence: request.sourceSequence, interpreterScoped: true });
    return { manifest, eventHash: hash };
  }

  async recordTransition(record: TransitionRecord): Promise<void> {
    const manifest = await this.artifacts.load(record, record.artifactManifest, ["transition_manifest"], true);
    const content = JSON.parse(artifactJson.text(manifest.content)) as { eventId?: unknown; eventHash?: unknown; sourceSequence?: unknown };
    if (content.eventId !== record.eventId || content.eventHash !== record.eventHash || content.sourceSequence !== record.sourceSequence) throw new FactoryArtifactError("factory_transition_unfinalized");
    const records = new FactoryRecords(this.artifacts.database, record.tenantId);
    await this.artifacts.database.transaction(async transaction => {
      const prior = record.sourceSequence === 1 ? null : await records.readAuditBatchInTransaction(transaction, { projectId: record.projectId, runId: record.logicalRunId, interpreterId: record.interpreterId }, record.sourceSequence - 1);
      await records.appendAuditInTransaction(transaction, { projectId: record.projectId, runId: record.logicalRunId, interpreterId: record.interpreterId, sourceSequence: record.sourceSequence, predecessorDigest: prior?.digest ?? null, payload: { kind: "factory.transition", eventId: record.eventId, eventHash: record.eventHash, inboxSequence: record.inboxSequence ?? null, artifactManifest: record.artifactManifest } });
    });
  }
}
