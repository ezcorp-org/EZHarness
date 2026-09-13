import { encodeFactoryPageBase64, decodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileFactory } from "@ezcorp/factory-sdk/compiler";
import { referenceCodeV1 } from "@ezcorp/factory-sdk";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { loadCompiledFactory } from "../../packages/@ezcorp/factory-orchestrator/src/definition-pages";
import { persistTransition } from "../../packages/@ezcorp/factory-orchestrator/src/transition-pages";
import { FileBlobStore } from "../extensions/v4/blobs";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import type { TransactionalDb } from "../db/migrations/types";
import { FactoryArtifacts } from "./artifacts";
import type { FactoryArtifactKind } from "./artifacts";
import { artifactJson } from "./artifacts";
import { createFactoryArtifactActivities } from "./artifact-activities";
import { FactoryDefinitionArtifacts } from "./definition-artifacts";
import { FactoryInbox } from "./inbox";
import { FactoryRecords } from "./records";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "./encryption";

const databases: PGlite[] = [];
const directories: string[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const database = new PGlite({ extensions: { vector, pg_trgm } }); databases.push(database); await database.waitReady;
  const db = drizzle(database, { schema }); await migrate(db);
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('artifact-project', 'Artifact', '/tmp/artifact')`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, 'artifact-tenant', 1)`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES ('artifact-tenant', 'artifact-project')`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('artifact-tenant', 'artifact-project', 'artifact-run', ${`sha256:${"a".repeat(64)}`}, 'test', 1, 'request', '{}')`);
  const root = await mkdtemp(join(tmpdir(), "factory-artifacts-")); directories.push(root);
  const artifacts = new FactoryArtifacts(db, new FileBlobStore(root), "artifact-tenant");
  const definitions = new FactoryDefinitionArtifacts(artifacts);
  const transitions = new FactoryTransitionArtifacts(artifacts);
  return { db, root, artifacts, definitions, transitions, identity: { tenantId: "artifact-tenant", projectId: "artifact-project", logicalRunId: "artifact-run", interpreterId: "interpreter-a" } };
}

test("public artifact load snapshots mutable authority before its held database transaction", async () => {
  const { db, root, artifacts, identity } = await fixture();
  const content = new TextEncoder().encode("snapshot artifact read");
  const stored = await artifacts.stage(identity, "execution_manifest", content, { definitionDigest: `sha256:${"a".repeat(64)}`, interpreterScoped: false });
  let entered!: () => void;
  const enteredTransaction = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const resume = new Promise<void>(resolve => { release = resolve; });
  const heldDatabase: TransactionalDb = {
    execute: query => db.execute(query),
    transaction: work => db.transaction(async transaction => { entered(); await resume; return work(transaction); }),
  };
  const reader = new FactoryArtifacts(heldDatabase, new FileBlobStore(root), identity.tenantId);
  const mutableIdentity = { ...identity };
  const mutableReference = { ...stored };
  const mutableKinds: FactoryArtifactKind[] = ["execution_manifest"];
  const pending = reader.load(mutableIdentity, mutableReference, mutableKinds, false);
  await enteredTransaction;
  mutableIdentity.projectId = "foreign-project";
  mutableReference.digest = `sha256:${"0".repeat(64)}`;
  mutableKinds[0] = "transition_manifest";
  release();
  expect(await pending).toMatchObject({ reference: stored, kind: "execution_manifest", content });
});

test("host-issued definition references load exact canonical compiler bytes through the Node reader", async () => {
  const { artifacts, definitions, identity } = await fixture();
  const result = compileFactory(referenceCodeV1); if (!result.ok) throw new Error("reference compiler fixture failed");
  const source = await definitions.stageDefinition(result.factory, identity);
  const loaded = await loadCompiledFactory(identity, source, { loadManifestPage: request => definitions.loadManifestPage(request, request.definition, request.page), loadDefinitionPage: request => definitions.loadDefinitionPage(request, request.definitionDigest, request.page) });
  expect(loaded.digest).toBe(result.factory.digest);
  await expect(artifacts.load({ ...identity, projectId: "foreign-project" }, source.manifest, ["definition_manifest"])).rejects.toMatchObject({ code: "factory_artifact_not_found" });
  await expect(artifacts.load(identity, { ...source.manifest, digest: `sha256:${"0".repeat(64)}` }, ["definition_manifest"])).rejects.toMatchObject({ code: "factory_artifact_not_found" });
});

test("encrypted object-bound storage composes with canonical definition references", async () => {
  const { db, identity } = await fixture();
  const root = await mkdtemp(join(tmpdir(), "factory-encrypted-artifacts-")); directories.push(root);
  const values: InstallationKeyWrap[] = [];
  const wraps: InstallationKeyWrapStore = { async load() { return values; }, async save(value: InstallationKeyWrap) { values.push(value); } };
  const key = await InstallationDataKey.loadOrCreate("artifact-installation", wraps, new StaticMasterKeyProvider({ id: "operator", bytes: new Uint8Array(32).fill(1) }));
  const artifacts = new FactoryArtifacts(db, new EncryptedBlobStore(new FileBlobStore(root), key, identity.tenantId), identity.tenantId);
  const bytes = new TextEncoder().encode("encrypted published definition");
  const reference = await artifacts.stage(identity, "execution_manifest", bytes, { definitionDigest: `sha256:${"a".repeat(64)}`, interpreterScoped: false });
  expect(reference.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  expect((await artifacts.load(identity, reference, ["execution_manifest"])).content).toEqual(bytes);
});

test("definition manifests use bounded linked pages at the 512-page edge", async () => {
  const { definitions, identity } = await fixture();
  const result = compileFactory(referenceCodeV1); if (!result.ok) throw new Error("reference compiler fixture failed");
  const compiled = { ...result.factory, padding: "x".repeat(15 * 1024 * 1024) } as typeof result.factory & { padding: string };
  const source = await definitions.stageDefinition(compiled, identity);
  const loaded = await loadCompiledFactory(identity, source, { loadManifestPage: request => definitions.loadManifestPage(request, request.definition, request.page), loadDefinitionPage: request => definitions.loadDefinitionPage(request, request.definitionDigest, request.page) }) as typeof compiled;
  expect(loaded.padding).toHaveLength(15 * 1024 * 1024);
}, 30_000);

test("execution manifests and partitions keep their definition scope", async () => {
  const { definitions, identity } = await fixture();
  const definitionDigest = `sha256:${"c".repeat(64)}`;
  const execution = await definitions.stageExecutionManifest({ partitionId: "partition-a" } as never, identity, definitionDigest);
  const partition = await definitions.stagePartition({ id: "partition-a" } as never, identity, definitionDigest);
  expect(await definitions.loadExecutionManifest(identity, definitionDigest, execution) as unknown).toEqual({ partitionId: "partition-a" });
  expect(await definitions.loadPartition(identity, definitionDigest, partition) as unknown).toEqual({ id: "partition-a" });
  await expect(definitions.loadPartition(identity, `sha256:${"d".repeat(64)}`, partition)).rejects.toMatchObject({ code: "factory_definition_not_found" });
  const second = await definitions.stagePartition({ id: "partition-b" } as never, identity, definitionDigest);
  expect((await definitions.loadPartition(identity, definitionDigest, second) as unknown as { id: string }).id).toBe("partition-b");
  await expect(definitions.loadPartition({ ...identity, tenantId: "foreign-tenant" }, definitionDigest, second)).rejects.toMatchObject({ code: "factory_artifact_tenant_denied" });
});

test("run creation and definition staging share one transaction", async () => {
  const { artifacts, db, definitions, identity } = await fixture();
  const result = compileFactory(referenceCodeV1); if (!result.ok) throw new Error("reference compiler fixture failed");
  const pending = { ...identity, logicalRunId: "artifact-run-transaction" };
  const records = new FactoryRecords(db, identity.tenantId);
  await expect(db.transaction(async transaction => {
    await records.createRunInTransaction(transaction, { projectId: pending.projectId, runId: pending.logicalRunId, definitionDigest: result.factory.digest, interpreterBuild: "test", executionEpoch: 1, input: {}, principalId: "factory-service", principalKind: "service" }, async () => {});
    await definitions.stageDefinitionInTransaction(transaction, result.factory, pending);
    throw new Error("force factory creation rollback");
  })).rejects.toThrow("force factory creation rollback");
  const references = await db.execute(sql`SELECT object_id FROM factory_artifacts WHERE run_id=${pending.logicalRunId}`) as unknown as { rows?: unknown[] } | unknown[];
  const runs = await db.execute(sql`SELECT run_id FROM factory_runs WHERE run_id=${pending.logicalRunId}`) as unknown as { rows?: unknown[] } | unknown[];
  const audit = await db.execute(sql`SELECT action FROM audit_log WHERE target=${pending.logicalRunId}`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(references) ? references : references.rows).toEqual([]);
  expect(Array.isArray(runs) ? runs : runs.rows).toEqual([]);
  expect(Array.isArray(audit) ? audit : audit.rows).toEqual([]);
  expect(artifacts).toBeDefined();
});

test("transition pages finalize before the existing compact Factory audit stream records them", async () => {
  const { artifacts, definitions, transitions, identity } = await fixture();
  const activity = createFactoryArtifactActivities(definitions, transitions);
  const event = { id: "event-1", kind: "node-succeeded", atMs: 1 } as never;
  const state = { definitionDigest: `sha256:${"a".repeat(64)}` } as never;
  await persistTransition(identity, 1, event, state, [], undefined, activity);
  const rows = await (artifacts.database as typeof artifacts.database).execute(sql`SELECT source_sequence, payload FROM factory_audit_batches WHERE tenant_id='artifact-tenant'`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(rows) ? rows : rows.rows).toHaveLength(1);
  await expect(artifacts.load(identity, { objectId: "guessed", digest: `sha256:${"a".repeat(64)}`, encodedBytes: 1 }, ["transition_manifest"], true)).rejects.toMatchObject({ code: "factory_artifact_not_found" });
});

function storedCommand(id = "stored-command", generation = 0) {
  return { kind: "request-admission", id, nodeId: "node-a", candidateGeneration: generation, deadlineAtMs: 2_000_000_000_000 } as const;
}

test("stored commands resolve only after their exact transition audit commits and retries converge", async () => {
  const { db, definitions, transitions, identity } = await fixture();
  const activity = createFactoryArtifactActivities(definitions, transitions);
  const command = storedCommand();
  const event: Extract<KernelEvent, { kind: "cancel" }> = { id: "stored-command-event", kind: "cancel", atMs: 1, reason: "test" };
  const inbox = new FactoryInbox(db, identity.tenantId);
  const key = { projectId: identity.projectId, runId: identity.logicalRunId, interpreterId: identity.interpreterId };
  const delivery = await inbox.enqueue(key, event);
  const receipt = delivery.command as { eventSequence: number; eventHash: string };
  const finalized = await persistTransition(identity, 1, event, {} as never, [command], { sequence: receipt.eventSequence, eventId: event.id, eventHash: receipt.eventHash }, activity);
  const reference = { ...identity, commandId: command.id };
  expect(await transitions.loadStoredCommand(reference)).toEqual(command);
  const mutableReference = { ...reference };
  const pending = transitions.loadStoredCommand(mutableReference);
  mutableReference.projectId = "foreign-project";
  expect(await pending).toEqual(command);
  expect(await inbox.confirmApplied(key, { inboxSequence: receipt.eventSequence, eventId: event.id, eventHash: receipt.eventHash })).toBe(true);
  await expect(transitions.loadStoredCommand({ ...reference, commandId: "missing" })).rejects.toMatchObject({ code: "factory_transition_command_not_found" });
  await expect(transitions.loadStoredCommand({ ...reference, projectId: "foreign-project" })).rejects.toMatchObject({ code: "factory_transition_command_not_found" });
  const record = { ...identity, sourceSequence: 1, eventId: event.id, eventHash: finalized.eventHash, inboxSequence: receipt.eventSequence, artifactManifest: finalized.manifest };
  await Promise.all([transitions.recordTransition(record), transitions.recordTransition(record)]);
  await persistTransition(identity, 2, { id: "stored-command-repeat", kind: "node-succeeded", atMs: 2 } as never, {} as never, [command], undefined, activity);
  const index = await db.execute(sql`SELECT source_sequence FROM factory_transition_commands WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.logicalRunId} AND command_id=${command.id}`) as unknown as { rows?: Array<{ source_sequence: number }> } | Array<{ source_sequence: number }>;
  expect((Array.isArray(index) ? index : index.rows)![0]!.source_sequence).toBe(1);
  await expect(persistTransition(identity, 3, { id: "stored-command-next", kind: "node-succeeded", atMs: 3 } as never, {} as never, [storedCommand(command.id, 1)], undefined, activity)).rejects.toMatchObject({ code: "factory_transition_command_conflict" });
  const rows = await db.execute(sql`SELECT source_sequence FROM factory_audit_batches WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.logicalRunId}`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(rows) ? rows : rows.rows).toHaveLength(2);
});

test("stored command lookup rejects uncommitted, malformed, and tampered transition authority", async () => {
  const { db, transitions, identity } = await fixture();
  const command = storedCommand("tampered-command");
  const event: Extract<KernelEvent, { kind: "cancel" }> = { id: "tampered-command-event", kind: "cancel", atMs: 1, reason: "test" };
  const content = artifactJson.text(artifactJson.canonical({ schemaVersion: "factory.transition.v1", ...identity, sourceSequence: 1, event, nextState: {}, commands: [command] }));
  const page = await transitions.stageTransitionPage({ ...identity, sourceSequence: 1, index: 0, contentBase64: encodeFactoryPageBase64(artifactJson.bytes(content)), encodedBytes: artifactJson.bytes(content).byteLength });
  const finalized = await transitions.finalizeTransitionArtifact({ ...identity, sourceSequence: 1, encodedBytes: page.encodedBytes, eventId: event.id, pages: [page] });
  const reference = { ...identity, commandId: command.id };
  await expect(transitions.loadStoredCommand(reference)).rejects.toMatchObject({ code: "factory_transition_command_not_found" });
  await transitions.recordTransition({ ...identity, sourceSequence: 1, eventId: event.id, eventHash: finalized.eventHash, artifactManifest: finalized.manifest });
  await db.execute(sql`UPDATE factory_transition_commands SET command_digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND command_id=${command.id}`);
  await expect(transitions.loadStoredCommand(reference)).rejects.toMatchObject({ code: "factory_transition_command_corrupt" });
  await db.execute(sql`UPDATE factory_transition_commands SET command_digest=${`sha256:${"1".repeat(64)}`} WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND command_id=${command.id}`);
  await expect(transitions.loadStoredCommand(reference)).rejects.toMatchObject({ code: "factory_transition_command_corrupt" });
  await db.execute(sql`UPDATE factory_audit_batches SET payload='{}' WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.logicalRunId}`);
  await expect(transitions.loadStoredCommand(reference)).rejects.toMatchObject({ code: "factory_transition_command_corrupt" });
  await expect(transitions.recordTransition({ ...identity, sourceSequence: 1, eventId: event.id, eventHash: finalized.eventHash, artifactManifest: finalized.manifest })).rejects.toMatchObject({ code: "factory_audit_corrupt" });
});

test("stored command lookup rejects a changed immutable transition page", async () => {
  const { db, definitions, transitions, identity } = await fixture();
  const activity = createFactoryArtifactActivities(definitions, transitions);
  const command = storedCommand("blob-command");
  await persistTransition(identity, 1, { id: "blob-command-event", kind: "node-succeeded", atMs: 1 } as never, {} as never, [command], undefined, activity);
  const page = await db.execute(sql`SELECT object_id FROM factory_artifacts WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.logicalRunId} AND kind='transition_page'`) as unknown as { rows?: Array<{ object_id: string }> } | Array<{ object_id: string }>;
  const row = (Array.isArray(page) ? page : page.rows)![0]!;
  await db.execute(sql`UPDATE factory_artifacts SET digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND object_id=${row.object_id}`);
  await expect(transitions.loadStoredCommand({ ...identity, commandId: command.id })).rejects.toMatchObject({ code: "factory_transition_command_corrupt" });
});

test("stored command indexing rejects duplicate malformed IDs before audit admission", async () => {
  const { db, transitions, identity } = await fixture();
  const event: Extract<KernelEvent, { kind: "cancel" }> = { id: "duplicate-command-event", kind: "cancel", atMs: 1, reason: "test" };
  const command = storedCommand("duplicate-command");
  const content = artifactJson.text(artifactJson.canonical({ schemaVersion: "factory.transition.v1", ...identity, sourceSequence: 1, event, nextState: {}, commands: [command, command] }));
  const page = await transitions.stageTransitionPage({ ...identity, sourceSequence: 1, index: 0, contentBase64: encodeFactoryPageBase64(artifactJson.bytes(content)), encodedBytes: artifactJson.bytes(content).byteLength });
  const finalized = await transitions.finalizeTransitionArtifact({ ...identity, sourceSequence: 1, encodedBytes: page.encodedBytes, eventId: event.id, pages: [page] });
  await expect(transitions.recordTransition({ ...identity, sourceSequence: 1, eventId: event.id, eventHash: finalized.eventHash, artifactManifest: finalized.manifest })).rejects.toMatchObject({ code: "factory_transition_commands_invalid" });
  const rows = await db.execute(sql`SELECT command_id FROM factory_transition_commands WHERE tenant_id=${identity.tenantId}`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(rows) ? rows : rows.rows).toEqual([]);
});

test("the Node transition activity keeps large transitions paged and rejects corrupt receipts", async () => {
  const { artifacts, db, definitions, transitions, identity } = await fixture();
  const activity = createFactoryArtifactActivities(definitions, transitions);
  const event: Extract<KernelEvent, { kind: "cancel" }> = { id: "paged-event", kind: "cancel", atMs: 1, reason: "x" };
  await persistTransition(identity, 1, event, { padding: "x".repeat(40 * 1024) } as never, [], undefined, activity);
  const auditRows = await db.execute(sql`SELECT payload FROM factory_audit_batches WHERE tenant_id=${identity.tenantId} AND run_id=${identity.logicalRunId}`) as unknown as { rows?: Array<{ payload: string }> } | Array<{ payload: string }>;
  const audit = (Array.isArray(auditRows) ? auditRows : auditRows.rows)![0]!;
  const manifest = JSON.parse(audit.payload).artifactManifest;
  expect(manifest.encodedBytes).toBeLessThanOrEqual(32 * 1024);
  const pages = await db.execute(sql`SELECT object_id FROM factory_artifacts WHERE run_id=${identity.logicalRunId} AND kind='transition_page'`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(pages) ? pages : pages.rows).toHaveLength(2);
  const loadedManifest = await activity.loadTransitionManifest({ ...identity, sourceSequence: 1, manifest });
  expect(loadedManifest.self).toEqual(manifest);
  expect(loadedManifest.pages).toHaveLength(2);
  const loadedPages = await Promise.all(loadedManifest.pages.map(page => activity.loadTransitionPage({ ...identity, sourceSequence: 1, page })));
  const restored = JSON.parse(loadedPages.map(page => new TextDecoder("utf-8", { fatal: true }).decode(decodeFactoryPageBase64(page.contentBase64))).join(""));
  expect(restored).toMatchObject({ schemaVersion: "factory.transition.v1", sourceSequence: 1, event, nextState: { padding: "x".repeat(40 * 1024) } });
  await expect(activity.loadTransitionManifest({ ...identity, sourceSequence: 2, manifest })).rejects.toMatchObject({ code: "factory_transition_not_found" });
  await expect(activity.loadTransitionManifest({ ...identity, projectId: "foreign-project", sourceSequence: 1, manifest })).rejects.toMatchObject({ code: "factory_artifact_not_found" });
  await expect(activity.loadTransitionPage({ ...identity, sourceSequence: 2, page: loadedManifest.pages[0]! })).rejects.toMatchObject({ code: "factory_transition_not_found" });
  await expect(activity.loadTransitionPage({ ...identity, page: { ...loadedManifest.pages[0]!, digest: `sha256:${"0".repeat(64)}` }, sourceSequence: 1 })).rejects.toMatchObject({ code: "factory_artifact_not_found" });

  const invalidEvent: Extract<KernelEvent, { kind: "cancel" }> = { id: "invalid-event", kind: "cancel", atMs: 2, reason: "x" };
  const content = artifactJson.text(artifactJson.canonical({ schemaVersion: "factory.transition.v1", ...identity, sourceSequence: 2, event: invalidEvent, nextState: {}, commands: [] }));
  const page = await transitions.stageTransitionPage({ ...identity, sourceSequence: 2, index: 0, contentBase64: encodeFactoryPageBase64(artifactJson.bytes(content)), encodedBytes: artifactJson.bytes(content).byteLength });
  const request = { ...identity, sourceSequence: 2, encodedBytes: page.encodedBytes, eventId: invalidEvent.id, pages: [page] };
  await expect(transitions.finalizeTransitionArtifact({ ...request, pages: [{ ...page, index: 1 }] })).rejects.toMatchObject({ code: "factory_transition_invalid" });
  await expect(transitions.finalizeTransitionArtifact({ ...request, pages: [{ ...page, encodedBytes: page.encodedBytes - 1 }] })).rejects.toMatchObject({ code: "factory_artifact_not_found" });
  await expect(transitions.finalizeTransitionArtifact({ ...request, projectId: "foreign-project" })).rejects.toMatchObject({ code: "factory_artifact_not_found" });
  await expect(transitions.finalizeTransitionArtifact({ ...request, expectedEventHash: `sha256:${"0".repeat(64)}` })).rejects.toMatchObject({ code: "factory_transition_event_conflict" });
  await db.execute(sql`UPDATE factory_artifacts SET digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND object_id=${page.objectId}`);
  await expect(transitions.finalizeTransitionArtifact({ ...request, pages: [{ ...page, digest: `sha256:${"0".repeat(64)}` }] })).rejects.toMatchObject({ code: "factory_artifact_corrupt" });
  await expect(activity.loadTransitionPage({ ...identity, sourceSequence: 2, page: { ...page, digest: `sha256:${"0".repeat(64)}` } })).rejects.toMatchObject({ code: "factory_artifact_corrupt" });
  expect(artifacts).toBeDefined();
});

test("transition recording commits its exact inbox receipt or rolls back the audit", async () => {
  const { db, definitions, transitions, identity } = await fixture();
  const activity = createFactoryArtifactActivities(definitions, transitions);
  const inbox = new FactoryInbox(db, identity.tenantId);
  const event: Extract<KernelEvent, { kind: "cancel" }> = { id: "accepted-event", kind: "cancel", atMs: 1, reason: "x" };
  const key = { projectId: identity.projectId, runId: identity.logicalRunId, interpreterId: identity.interpreterId };
  const delivery = await inbox.enqueue(key, event);
  const command = delivery.command as { eventSequence: number; eventHash: string };
  const notification = await inbox.enqueue(key, { id: "partition-notification", kind: "cancel", atMs: 2, reason: "x" }, "partition_notification");
  expect((notification.command as { kind: string }).kind).toBe("partition_notification");
  await persistTransition(identity, 1, event, {} as never, [], { sequence: command.eventSequence, eventId: event.id, eventHash: command.eventHash }, activity);
  expect(await inbox.confirmApplied({ projectId: identity.projectId, runId: identity.logicalRunId, interpreterId: identity.interpreterId }, { inboxSequence: command.eventSequence, eventId: event.id, eventHash: command.eventHash })).toBe(true);

  const missing: Extract<KernelEvent, { kind: "cancel" }> = { id: "never-enqueued", kind: "cancel", atMs: 2, reason: "x" };
  const content = artifactJson.text(artifactJson.canonical({ schemaVersion: "factory.transition.v1", ...identity, sourceSequence: 2, event: missing, nextState: {}, commands: [] }));
  const page = await transitions.stageTransitionPage({ ...identity, sourceSequence: 2, index: 0, contentBase64: encodeFactoryPageBase64(artifactJson.bytes(content)), encodedBytes: artifactJson.bytes(content).byteLength });
  const finalized = await transitions.finalizeTransitionArtifact({ ...identity, sourceSequence: 2, encodedBytes: page.encodedBytes, eventId: missing.id, pages: [page] });
  await expect(transitions.recordTransition({ ...identity, sourceSequence: 2, eventId: missing.id, eventHash: finalized.eventHash, inboxSequence: command.eventSequence, artifactManifest: finalized.manifest })).rejects.toMatchObject({ code: "factory_inbox_applied_conflict" });
  const rows = await db.execute(sql`SELECT source_sequence FROM factory_audit_batches WHERE run_id=${identity.logicalRunId}`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(rows) ? rows : rows.rows).toHaveLength(1);
});
