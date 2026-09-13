import { encodeFactoryPageBase64, decodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import type { JsonValue } from "@ezcorp/factory-sdk";
import type { KernelCommand } from "@ezcorp/factory-sdk/kernel-types";
import { sql } from "drizzle-orm";
import { loadTransitionArtifact } from "../../packages/@ezcorp/factory-orchestrator/src/transition-pages";
import { MAX_ACTIVITY_PAYLOAD_BYTES, MAX_COMMAND_BATCH_BYTES, MAX_PAGE_BYTES, MAX_TRANSITION_ARTIFACT_BYTES, MAX_TRANSITION_PAGES, type FactoryIdentity, type FactoryTransitionManifest, type FactoryTransitionPage, type FinalizedTransitionArtifact, type ImmutableObjectReference, type TransitionArtifact, type TransitionArtifactRequest, type TransitionPageReference, type TransitionPageRequest, type TransitionRecord } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestBytes } from "../extensions/v4/blobs";
import { FACTORY_ARTIFACT_MAX_BYTES, FactoryArtifactError, artifactJson } from "./artifacts";
import type { FactoryArtifacts } from "./artifacts";
import { FactoryInbox } from "./inbox";
import { assertFactoryIdentity, encodeFactoryPayload, FactoryRecords, type FactoryAuditBatch } from "./records";

function eventDigest(event: unknown): string { return `sha256:${digestBytes(artifactJson.canonical(event))}`; }

export type LoadedTransitionManifest = FactoryTransitionManifest;
export type LoadedTransitionPage = FactoryTransitionPage;
export interface StoredFactoryCommandReference extends FactoryIdentity { readonly commandId: string; }
/** Immutable index identity verified with the returned command bytes. */
export interface StoredFactoryCommand { readonly command: KernelCommand; readonly sourceSequence: number; readonly commandDigest: string; }
type IndexedCommand = { readonly commandId: string; readonly digest: string; readonly command: KernelCommand; };
type CommandIndexRow = { source_sequence: number | string; command_digest: string };

function validSequence(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function sameReference(left: ImmutableObjectReference, right: ImmutableObjectReference): boolean { return left.objectId === right.objectId && left.digest === right.digest && left.encodedBytes === right.encodedBytes; }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function reference(value: unknown): value is ImmutableObjectReference { return object(value) && typeof value.objectId === "string" && typeof value.digest === "string" && typeof value.encodedBytes === "number" && Number.isSafeInteger(value.encodedBytes) && value.encodedBytes >= 1; }
function pageReference(value: unknown): value is TransitionPageReference { return object(value) && reference(value) && typeof value.index === "number" && Number.isSafeInteger(value.index) && value.index >= 0; }
/** C08 bounds the whole batch by bytes; the workflow separately limits simultaneous activities. */
function indexedCommands(commands: unknown): readonly IndexedCommand[] {
  if (!Array.isArray(commands) || artifactJson.canonical(commands).byteLength > MAX_COMMAND_BATCH_BYTES) throw new FactoryArtifactError("factory_transition_commands_invalid");
  const seen = new Set<string>();
  return commands.map(command => {
    if (!object(command) || typeof command.id !== "string" || typeof command.kind !== "string" || command.id.length === 0 || command.id.length > 512 || command.id.includes("\0") || seen.has(command.id)) throw new FactoryArtifactError("factory_transition_commands_invalid");
    const bytes = artifactJson.canonical(command);
    if (bytes.byteLength > MAX_ACTIVITY_PAYLOAD_BYTES) throw new FactoryArtifactError("factory_transition_commands_invalid");
    seen.add(command.id);
    return { commandId: command.id, digest: `sha256:${digestBytes(bytes)}`, command: command as KernelCommand };
  });
}

function auditedManifest(payload: unknown): ImmutableObjectReference {
  if (!object(payload) || payload.kind !== "factory.transition" || typeof payload.eventId !== "string" || !payload.eventId || typeof payload.eventHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(payload.eventHash) || !reference(payload.artifactManifest)) throw new FactoryArtifactError("factory_transition_audit_invalid");
  return payload.artifactManifest;
}

/** Activity implementation that keeps transition bytes ahead of compact records. */
export class FactoryTransitionArtifacts {
  constructor(private readonly artifacts: FactoryArtifacts) {}

  async loadTransitionManifest(request: FactoryIdentity & { readonly sourceSequence: number; readonly manifest: ImmutableObjectReference }, transaction?: MigrationDb): Promise<LoadedTransitionManifest> {
    if (!validSequence(request.sourceSequence) || !reference(request.manifest)) throw new FactoryArtifactError("factory_transition_invalid");
    const loaded = await this.loadArtifact(transaction, request, request.manifest, ["transition_manifest"], true);
    if (loaded.sourceSequence !== request.sourceSequence || loaded.pageIndex !== null || !sameReference(loaded.reference, request.manifest)) throw new FactoryArtifactError("factory_transition_not_found");
    return this.parseManifest(loaded.content, request, loaded.reference, "factory_transition_not_found");
  }

  async loadTransitionPage(request: FactoryIdentity & { readonly sourceSequence: number; readonly page: TransitionPageReference }, transaction?: MigrationDb): Promise<LoadedTransitionPage> {
    if (!validSequence(request.sourceSequence) || !pageReference(request.page)) throw new FactoryArtifactError("factory_transition_invalid");
    const loaded = await this.loadArtifact(transaction, request, request.page, ["transition_page"], true);
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
    let transition: TransitionArtifact;
    try { transition = await loadTransitionArtifact(snapshot, snapshot.sourceSequence, snapshot.artifactManifest, this); }
    catch { throw new FactoryArtifactError("factory_transition_unfinalized"); }
    if (transition.event.id !== snapshot.eventId || eventDigest(transition.event) !== snapshot.eventHash) throw new FactoryArtifactError("factory_transition_unfinalized");
    const commands = indexedCommands(transition.commands);
    const records = new FactoryRecords(this.artifacts.database, snapshot.tenantId);
    const inbox = new FactoryInbox(this.artifacts.database, snapshot.tenantId);
    await this.artifacts.database.transaction(async transaction => {
      const prior = snapshot.sourceSequence === 1 ? null : await records.readAuditBatchInTransaction(transaction, { projectId: snapshot.projectId, runId: snapshot.logicalRunId, interpreterId: snapshot.interpreterId }, snapshot.sourceSequence - 1);
      await inbox.commitTransitionInTransaction(transaction, { projectId: snapshot.projectId, runId: snapshot.logicalRunId, interpreterId: snapshot.interpreterId, sourceSequence: snapshot.sourceSequence, predecessorDigest: prior?.digest ?? null, payload: { kind: "factory.transition", eventId: snapshot.eventId, eventHash: snapshot.eventHash, ...(snapshot.inboxSequence === undefined ? {} : { inboxSequence: snapshot.inboxSequence }), artifactManifest: snapshot.artifactManifest } });
      for (const command of commands) await this.indexCommand(transaction, snapshot, command);
    });
  }

  /** Resolves one indexed command, then proves its audit and immutable transition before returning it. */
  async loadStoredCommand(referenceValue: StoredFactoryCommandReference, transaction?: MigrationDb): Promise<KernelCommand> {
    return (await this.loadStoredCommandEntry(referenceValue, transaction)).command;
  }

  /** One verified index read supplies both immutable command bytes and its audit coordinate. */
  async loadStoredCommandEntry(referenceValue: StoredFactoryCommandReference, transaction?: MigrationDb): Promise<StoredFactoryCommand> {
    const database = transaction ?? this.artifacts.database;
    const reference = { tenantId: referenceValue.tenantId, projectId: referenceValue.projectId, logicalRunId: referenceValue.logicalRunId, interpreterId: referenceValue.interpreterId, commandId: referenceValue.commandId };
    try { assertFactoryIdentity(reference.tenantId, reference.projectId, reference.logicalRunId, reference.interpreterId, reference.commandId); }
    catch { throw new FactoryArtifactError("factory_transition_command_invalid"); }
    const indexed = rows<CommandIndexRow>(await database.execute(sql`SELECT source_sequence, command_digest FROM factory_transition_commands WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} AND command_id=${reference.commandId}`))[0];
    if (!indexed) throw new FactoryArtifactError("factory_transition_command_not_found");
    const sourceSequence = Number(indexed.source_sequence);
    if (!validSequence(sourceSequence) || !/^sha256:[0-9a-f]{64}$/.test(indexed.command_digest)) throw new FactoryArtifactError("factory_transition_command_corrupt");
    const records = new FactoryRecords(this.artifacts.database, reference.tenantId);
    let batch: FactoryAuditBatch | null;
    try { batch = await records.readAuditBatchInTransaction(database, { projectId: reference.projectId, runId: reference.logicalRunId, interpreterId: reference.interpreterId }, sourceSequence); }
    catch { throw new FactoryArtifactError("factory_transition_command_corrupt"); }
    if (!batch) throw new FactoryArtifactError("factory_transition_command_not_found");
    const manifest = auditedManifest(batch.payload);
    let transition: TransitionArtifact;
    try { transition = await loadTransitionArtifact(reference, sourceSequence, manifest, this.reader(transaction)); }
    catch { throw new FactoryArtifactError("factory_transition_command_corrupt"); }
    if (transition.event.id !== (batch.payload as { eventId: unknown }).eventId || eventDigest(transition.event) !== (batch.payload as { eventHash: unknown }).eventHash) throw new FactoryArtifactError("factory_transition_command_corrupt");
    const command = indexedCommands(transition.commands).find(value => value.commandId === reference.commandId);
    if (!command || command.digest !== indexed.command_digest) throw new FactoryArtifactError("factory_transition_command_corrupt");
    return { command: command.command, sourceSequence, commandDigest: indexed.command_digest };
  }

  /** Loads one committed audit transition by its bounded global sequence. */
  async loadCommittedTransition(identityValue: FactoryIdentity, sourceSequence: number, transaction?: MigrationDb): Promise<TransitionArtifact> {
    const identity = { tenantId: identityValue.tenantId, projectId: identityValue.projectId, logicalRunId: identityValue.logicalRunId, interpreterId: identityValue.interpreterId };
    try { assertFactoryIdentity(identity.tenantId, identity.projectId, identity.logicalRunId, identity.interpreterId); }
    catch { throw new FactoryArtifactError("factory_transition_invalid"); }
    if (!validSequence(sourceSequence)) throw new FactoryArtifactError("factory_transition_invalid");
    const records = new FactoryRecords(this.artifacts.database, identity.tenantId);
    let batch: FactoryAuditBatch | null;
    try { batch = await records.readAuditBatchInTransaction(transaction ?? this.artifacts.database, { projectId: identity.projectId, runId: identity.logicalRunId, interpreterId: identity.interpreterId }, sourceSequence); }
    catch { throw new FactoryArtifactError("factory_transition_corrupt"); }
    if (!batch) throw new FactoryArtifactError("factory_transition_not_found");
    const manifest = auditedManifest(batch.payload);
    let transition: TransitionArtifact;
    try { transition = await loadTransitionArtifact(identity, sourceSequence, manifest, this.reader(transaction)); }
    catch { throw new FactoryArtifactError("factory_transition_corrupt"); }
    if (transition.event.id !== (batch.payload as { eventId: unknown }).eventId || eventDigest(transition.event) !== (batch.payload as { eventHash: unknown }).eventHash) throw new FactoryArtifactError("factory_transition_corrupt");
    return transition;
  }

  private loadArtifact(transaction: MigrationDb | undefined, ...args: Parameters<FactoryArtifacts["load"]>): ReturnType<FactoryArtifacts["load"]> {
    return transaction ? this.artifacts.loadInTransaction(transaction, ...args) : this.artifacts.load(...args);
  }

  private reader(transaction?: MigrationDb): Pick<FactoryTransitionArtifacts, "loadTransitionManifest" | "loadTransitionPage"> {
    return transaction ? { loadTransitionManifest: request => this.loadTransitionManifest(request, transaction), loadTransitionPage: request => this.loadTransitionPage(request, transaction) } : this;
  }

  private async indexCommand(transaction: MigrationDb, snapshot: TransitionRecord, command: IndexedCommand): Promise<void> {
    const current = rows<CommandIndexRow>(await transaction.execute(sql`SELECT source_sequence, command_digest FROM factory_transition_commands WHERE tenant_id=${snapshot.tenantId} AND project_id=${snapshot.projectId} AND run_id=${snapshot.logicalRunId} AND interpreter_id=${snapshot.interpreterId} AND command_id=${command.commandId} FOR UPDATE`))[0];
    if (current) {
      if (current.command_digest !== command.digest) throw new FactoryArtifactError("factory_transition_command_conflict");
      return;
    }
    await transaction.execute(sql`INSERT INTO factory_transition_commands (tenant_id, project_id, run_id, interpreter_id, command_id, source_sequence, command_digest) VALUES (${snapshot.tenantId}, ${snapshot.projectId}, ${snapshot.logicalRunId}, ${snapshot.interpreterId}, ${command.commandId}, ${snapshot.sourceSequence}, ${command.digest})`);
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
