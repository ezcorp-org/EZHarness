import { encodeFactoryPageBase64, decodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import type { JsonValue } from "@ezcorp/factory-sdk";
import { MAX_PAGE_BYTES, MAX_TRANSITION_ARTIFACT_BYTES, MAX_TRANSITION_PAGES, type FactoryIdentity, type FactoryTransitionManifest, type FactoryTransitionPage, type FinalizedTransitionArtifact, type ImmutableObjectReference, type TransitionArtifact, type TransitionArtifactRequest, type TransitionPageReference, type TransitionPageRequest, type TransitionRecord } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import { digestBytes } from "../extensions/v4/blobs";
import { FACTORY_ARTIFACT_MAX_BYTES, FactoryArtifactError, artifactJson } from "./artifacts";
import type { FactoryArtifacts } from "./artifacts";
import { FactoryInbox } from "./inbox";
import { encodeFactoryPayload, FactoryRecords } from "./records";

function eventDigest(event: unknown): string { return `sha256:${digestBytes(artifactJson.canonical(event))}`; }

export type LoadedTransitionManifest = FactoryTransitionManifest;
export type LoadedTransitionPage = FactoryTransitionPage;

function validSequence(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function sameReference(left: ImmutableObjectReference, right: ImmutableObjectReference): boolean { return left.objectId === right.objectId && left.digest === right.digest && left.encodedBytes === right.encodedBytes; }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function reference(value: unknown): value is ImmutableObjectReference { return object(value) && typeof value.objectId === "string" && typeof value.digest === "string" && typeof value.encodedBytes === "number" && Number.isSafeInteger(value.encodedBytes) && value.encodedBytes >= 1; }
function pageReference(value: unknown): value is TransitionPageReference { return object(value) && reference(value) && typeof value.index === "number" && Number.isSafeInteger(value.index) && value.index >= 0; }

/** Activity implementation that keeps transition bytes ahead of compact records. */
export class FactoryTransitionArtifacts {
  constructor(private readonly artifacts: FactoryArtifacts) {}

  async loadTransitionManifest(request: FactoryIdentity & { readonly sourceSequence: number; readonly manifest: ImmutableObjectReference }): Promise<LoadedTransitionManifest> {
    if (!validSequence(request.sourceSequence) || !reference(request.manifest)) throw new FactoryArtifactError("factory_transition_invalid");
    const loaded = await this.artifacts.load(request, request.manifest, ["transition_manifest"], true);
    if (loaded.sourceSequence !== request.sourceSequence || loaded.pageIndex !== null || !sameReference(loaded.reference, request.manifest)) throw new FactoryArtifactError("factory_transition_not_found");
    return this.parseManifest(loaded.content, request, loaded.reference, "factory_transition_not_found");
  }

  async loadTransitionPage(request: FactoryIdentity & { readonly sourceSequence: number; readonly page: TransitionPageReference }): Promise<LoadedTransitionPage> {
    if (!validSequence(request.sourceSequence) || !pageReference(request.page)) throw new FactoryArtifactError("factory_transition_invalid");
    const loaded = await this.artifacts.load(request, request.page, ["transition_page"], true);
    if (loaded.sourceSequence !== request.sourceSequence || loaded.pageIndex !== request.page.index || !sameReference(loaded.reference, request.page)) throw new FactoryArtifactError("factory_transition_not_found");
    try { return { ...loaded.reference, index: request.page.index, contentBase64: encodeFactoryPageBase64(loaded.content) }; }
    catch { throw new FactoryArtifactError("factory_transition_corrupt"); }
  }

  async stageTransitionPage(request: TransitionPageRequest): Promise<TransitionPageReference> {
    request = JSON.parse(encodeFactoryPayload(request)) as TransitionPageRequest;
    if (!Number.isSafeInteger(request.index) || request.index < 0 || request.index >= MAX_TRANSITION_PAGES) throw new FactoryArtifactError("factory_transition_invalid");
    let content: Uint8Array;
    try { content = decodeFactoryPageBase64(request.contentBase64); } catch { throw new FactoryArtifactError("factory_transition_invalid"); }
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
    const manifest = await this.loadTransitionManifest({ ...snapshot, manifest: snapshot.artifactManifest }).catch(error => { if (error instanceof FactoryArtifactError) throw new FactoryArtifactError("factory_transition_unfinalized"); throw error; });
    if (manifest.eventId !== snapshot.eventId || manifest.eventHash !== snapshot.eventHash) throw new FactoryArtifactError("factory_transition_unfinalized");
    const records = new FactoryRecords(this.artifacts.database, snapshot.tenantId);
    const inbox = new FactoryInbox(this.artifacts.database, snapshot.tenantId);
    await this.artifacts.database.transaction(async transaction => {
      const prior = snapshot.sourceSequence === 1 ? null : await records.readAuditBatchInTransaction(transaction, { projectId: snapshot.projectId, runId: snapshot.logicalRunId, interpreterId: snapshot.interpreterId }, snapshot.sourceSequence - 1);
      await inbox.commitTransitionInTransaction(transaction, { projectId: snapshot.projectId, runId: snapshot.logicalRunId, interpreterId: snapshot.interpreterId, sourceSequence: snapshot.sourceSequence, predecessorDigest: prior?.digest ?? null, payload: { kind: "factory.transition", eventId: snapshot.eventId, eventHash: snapshot.eventHash, ...(snapshot.inboxSequence === undefined ? {} : { inboxSequence: snapshot.inboxSequence }), artifactManifest: snapshot.artifactManifest } });
    });
  }

  private parseManifest(content: Uint8Array, identity: FactoryIdentity & { readonly sourceSequence: number }, self: ImmutableObjectReference, code: string): LoadedTransitionManifest {
    let manifest: unknown;
    const text = (() => { try { return artifactJson.text(content); } catch { throw new FactoryArtifactError(code); } })();
    try { manifest = JSON.parse(text); } catch { throw new FactoryArtifactError(code); }
    if (!object(manifest) || artifactJson.text(artifactJson.canonical(manifest)) !== text || manifest.schemaVersion !== "factory.transition-manifest.v1" || manifest.tenantId !== identity.tenantId || manifest.projectId !== identity.projectId || manifest.logicalRunId !== identity.logicalRunId || manifest.interpreterId !== identity.interpreterId || manifest.sourceSequence !== identity.sourceSequence || typeof manifest.eventId !== "string" || !manifest.eventId || typeof manifest.eventHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(manifest.eventHash) || !validSequence(manifest.encodedBytes) || manifest.encodedBytes > MAX_TRANSITION_ARTIFACT_BYTES || !Array.isArray(manifest.pages) || manifest.pages.length < 1 || manifest.pages.length > MAX_TRANSITION_PAGES) throw new FactoryArtifactError(code);
    let total = 0;
    for (const [index, page] of manifest.pages.entries()) {
      if (!pageReference(page) || page.index !== index || !page.objectId || !/^sha256:[0-9a-f]{64}$/.test(page.digest) || page.encodedBytes > MAX_PAGE_BYTES) throw new FactoryArtifactError(code);
      total += page.encodedBytes;
    }
    if (total !== manifest.encodedBytes) throw new FactoryArtifactError(code);
    return { ...manifest, pages: manifest.pages as readonly TransitionPageReference[], self } as LoadedTransitionManifest;
  }
}
