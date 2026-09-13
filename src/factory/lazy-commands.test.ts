import { afterEach, expect, test } from "bun:test";
import { advanceKernel, createKernelState, referenceCodeV1, type FactoryDefinition, type JsonValue } from "@ezcorp/factory-sdk";
import type { KernelCommand, KernelState } from "@ezcorp/factory-sdk/kernel-types";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { digestBytes } from "../extensions/v4/blobs";
import type { BlobStore } from "../extensions/v4/types";
import { createFactoryArtifactActivities } from "./artifact-activities";
import { FactoryArtifactAccess } from "./artifact-access";
import { FactoryArtifacts } from "./artifacts";
import { FactoryCommandAuthority } from "./command-authority";
import { FactoryDefinitionArtifacts } from "./definition-artifacts";
import { FactoryDefinitions } from "./definitions";
import { FactoryGrants, type FactoryPrincipal } from "./grants";
import { FactoryLazyCommands } from "./lazy-commands";
import { FactoryLazyInputReader } from "./lazy-input";
import { FactoryRecords } from "./records";
import { FactoryRunLifecycle } from "./run-lifecycle";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import { persistTransition } from "../../packages/@ezcorp/factory-orchestrator/src/transition-pages";

const tenantId = "lazy-command-tenant";
const projectId = "lazy-command-project";
const principal: FactoryPrincipal = { kind: "user", id: "lazy-command-owner", authentication: "session" };
const now = Date.UTC(2032, 0, 1);
const definitionKey = { projectId, factoryId: "lazy-command-factory" };
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => { await cleanup?.(); cleanup = undefined; });

type ValueCommand = Extract<KernelCommand, { kind: "read-input-value" }>;
type RecordedMutation = (command: ValueCommand, state: KernelState) => { readonly command: KernelCommand; readonly state: KernelState };

async function fixture(value: string, mutate?: RecordedMutation) {
  const database = await setupTestDb();
  cleanup = async () => database.pglite.close();
  const records = new FactoryRecords(database.db, tenantId);
  await records.bindInstallation();
  await database.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId}, 'Lazy command', '/tmp/lazy-command')`);
  await database.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${principal.id}, 'lazy-command@example.test', 'not-a-login', 'Lazy command owner', 'admin')`);
  await database.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('lazy-command-membership', ${projectId}, ${principal.id}, 'owner')`);
  const grants = new FactoryGrants(database.db, tenantId, () => now);
  await database.db.transaction(transaction => grants.initializeProjectInTransaction(transaction, projectId, principal.id));
  const content = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    async put(bytes) { const digest = digestBytes(bytes); content.set(digest, Uint8Array.from(bytes)); return digest; },
    async get(digest) { const bytes = content.get(digest); if (!bytes) throw new Error("missing fixture blob"); return Uint8Array.from(bytes); },
  };
  const artifacts = new FactoryArtifacts(database.db, blobs, tenantId);
  const sourceIdentity = { tenantId, projectId, logicalRunId: "lazy-command-source", interpreterId: "root" };
  await records.createRun({ projectId, runId: sourceIdentity.logicalRunId, definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "lazy-command", executionEpoch: 1, input: {}, principalId: principal.id, principalKind: principal.kind }, async () => {});
  const stored = await artifacts.stage(sourceIdentity, "candidate_output", new TextEncoder().encode(canonicalJson({ value })), { interpreterScoped: false, candidateNodeInstanceId: "lazy-command-source-node", candidateGeneration: 1 });
  const artifact = { artifactId: stored.objectId, digest: stored.digest, encodedBytes: stored.encodedBytes };
  const task = referenceCodeV1.graph.nodes.find(node => node.kind === "task");
  if (task?.kind !== "task") throw new Error("reference task missing");
  const source: FactoryDefinition = {
    ...structuredClone(referenceCodeV1), id: definitionKey.factoryId,
    inputPorts: { source: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }, outputPorts: {},
    graph: { nodes: [{ ...task, id: "read-source", dependsOn: [], inputPorts: { value: { type: "string" } }, bindings: { value: { kind: "ref", root: "input", name: "source", path: ["value"] } } }], outputs: {} },
  };
  const definitions = new FactoryDefinitions(database.db, tenantId, grants, blobs);
  await definitions.save(principal, definitionKey, 0, "lazy-command-definition-save", source);
  const version = await definitions.publish(principal, definitionKey, 1, "lazy-command-definition-publish");
  const lifecycle = new FactoryRunLifecycle(database.db, tenantId, {
    definitions, grants, interpreterBuild: "lazy-command", interpreterCompatibility: source.interpreterCompatibility,
    limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 },
    stageDefinitionInTransaction: (transaction, compiled, identity) => new FactoryDefinitionArtifacts(artifacts).stageDefinitionInTransaction(transaction, compiled, identity),
    async resolveParameters(transaction) {
      const loaded = await artifacts.loadInTransaction(transaction, sourceIdentity, stored, ["candidate_output"], false);
      return { source: JSON.parse(new TextDecoder().decode(loaded.content)) } as JsonValue;
    },
  }, () => now);
  const body = { factoryVersion: version.version, definitionDigest: version.definitionDigest, grantRevision: 1, parameters: { source: { kind: "artifact" as const, artifact } } };
  const run = await lifecycle.start(principal, definitionKey, body, 0, "lazy-command-start");
  const identity = { tenantId, projectId, logicalRunId: run.run.runId, interpreterId: "root" };
  const { compiled } = await definitions.readVersion(principal, definitionKey, version.version);
  const start = { kind: "start", id: "lazy-command-start-event", atMs: now } as const;
  const first = advanceKernel(compiled, createKernelState(compiled, identity.logicalRunId, { source: { value } }, now, { schemaVersion: "factory.lazy-input.v1", parameters: body.parameters }), start);
  const command = first.commands.find((entry): entry is Extract<typeof entry, { kind: "read-input-value" }> => entry.kind === "read-input-value");
  if (!command) throw new Error("lazy command was not emitted");
  const transitions = new FactoryTransitionArtifacts(artifacts);
  const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
  const recorded = mutate?.(command, first.nextState) ?? { command, state: first.nextState };
  await persistTransition(identity, 1, start, recorded.state, first.commands.map(entry => entry.id === command.id ? recorded.command : entry), undefined, activities);
  const access = new FactoryArtifactAccess(database.db, tenantId, grants, artifacts);
  const reader = new FactoryLazyInputReader(database.db, tenantId, artifacts, access, grants, () => now);
  const authority = new FactoryCommandAuthority(database.db, tenantId, lifecycle, transitions, ["orchestration"], () => now);
  return { database, lifecycle, run: run.run, compiled, identity, first, command, commands: new FactoryLazyCommands(authority, reader), artifact, activities };
}

test("lazy command reads the current stored command and produces a deterministic bounded event", async () => {
  const setup = await fixture("stored value");
  const reference = { ...setup.identity, commandId: setup.command.id };
  const service = { tenantId, subject: "orchestration" };
  const first = await setup.commands.execute(service, reference);
  const repeated = await setup.commands.execute(service, reference);
  expect(first).toEqual(repeated);
  expect(first).toMatchObject({ kind: "input-value-read", commandId: setup.command.id, name: "source", artifact: setup.artifact, value: "stored value" });
  expect(first.id).toBe(`${setup.command.id}:value`);
  expect(new TextEncoder().encode(canonicalJson(first)).byteLength).toBeLessThanOrEqual(32 * 1024);
  const next = advanceKernel(setup.compiled, setup.first.nextState, first);
  await persistTransition(setup.identity, 2, first, next.nextState, next.commands, undefined, setup.activities);
  await expect(setup.commands.execute(service, reference)).rejects.toMatchObject({ code: "factory_command_stale" });
});

test("lazy command rejects a value that cannot fit its recorded event envelope", async () => {
  const setup = await fixture("x".repeat(32 * 1024 - 300));
  await expect(setup.commands.execute({ tenantId, subject: "orchestration" }, { ...setup.identity, commandId: setup.command.id })).rejects.toMatchObject({ code: "factory_lazy_input_page_required" });
});


test("lazy command rejects substituted, version-mismatched, cancelled, and foreign authority", async () => {
  const substituted = await fixture("stored value", (command, state) => ({ command: { ...command, path: ["other"] }, state }));
  await expect(substituted.commands.execute({ tenantId, subject: "orchestration" }, { ...substituted.identity, commandId: substituted.command.id })).rejects.toMatchObject({ code: "factory_command_stale" });

  const versioned = await fixture("stored value", (command, state) => ({
    command: { ...command, expectedStorageVersion: "wrong-version" },
    state: {
      ...state,
      lazyInput: {
        ...state.lazyInput!,
        pending: {
          ...state.lazyInput!.pending,
          [command.id]: { ...state.lazyInput!.pending[command.id]!, expectedStorageVersion: "wrong-version" },
        },
      },
    },
  }));
  await expect(versioned.commands.execute({ tenantId, subject: "orchestration" }, { ...versioned.identity, commandId: versioned.command.id })).rejects.toMatchObject({ code: "factory_lazy_command_invalid" });

  const cancelled = await fixture("stored value");
  await cancelled.lifecycle.cancel(principal, { projectId, runId: cancelled.run.runId }, cancelled.run.revision, "lazy-command-cancel");
  await expect(cancelled.commands.execute({ tenantId, subject: "orchestration" }, { ...cancelled.identity, commandId: cancelled.command.id })).rejects.toMatchObject({ code: "factory_run_stopped" });
  await expect(cancelled.commands.execute({ tenantId: "foreign", subject: "orchestration" }, { ...cancelled.identity, commandId: cancelled.command.id })).rejects.toMatchObject({ code: "factory_command_forbidden" });
});
