import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { rm } from "node:fs/promises";
import { advanceKernel, createKernelState, referenceCodeV1, type FactoryDefinition, type JsonValue } from "@ezcorp/factory-sdk";
import type { KernelCommand, KernelState } from "@ezcorp/factory-sdk/kernel-types";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { BlobStore } from "../../extensions/v4/types";
import type { TransactionalDb } from "../../db/migrations/types";
import { createFactoryArtifactActivities } from "../../factory/artifact-activities";
import { FactoryArtifactAccess } from "../../factory/artifact-access";
import { FactoryArtifacts } from "../../factory/artifacts";
import { FactoryCommandAuthority } from "../../factory/command-authority";
import { FactoryDefinitionArtifacts } from "../../factory/definition-artifacts";
import { FactoryDefinitions } from "../../factory/definitions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryLazyCommands } from "../../factory/lazy-commands";
import { FactoryLazyInputReader } from "../../factory/lazy-input";
import { FactoryRecords } from "../../factory/records";
import { FactoryRunLifecycle } from "../../factory/run-lifecycle";
import { FactoryTransitionArtifacts } from "../../factory/transition-artifacts";
import { FactoryInstallationCommandOutbox } from "../../factory/outbox";
import { FactoryInbox } from "../../factory/inbox";
import { FactoryTransportQueue } from "../../factory/transport-queue";
import { startFactoryPrivateService } from "../../factory/private-service";
import { certificates, nodeHttpsRequest } from "./factory-certificates";
import { persistTransition } from "../../../packages/@ezcorp/factory-orchestrator/src/transition-pages";

const tenantId = "lazy-command-tenant";
const projectId = "lazy-command-project";
const principal: FactoryPrincipal = { kind: "user", id: "lazy-command-owner", authentication: "session" };
const now = Date.UTC(2032, 0, 1);
const definitionKey = { projectId, factoryId: "lazy-command-factory" };
let databaseFixture: { readonly db: TransactionalDb; readonly blobs: BlobStore; close(): Promise<void> } | undefined;

export function factoryLazyCommandsConformance(create: () => Promise<{ readonly db: TransactionalDb; readonly blobs: BlobStore; close(): Promise<void> }>): void {
  beforeEach(async () => { databaseFixture = await create(); });
  afterEach(async () => { await databaseFixture?.close(); databaseFixture = undefined; });

type ValueCommand = Extract<KernelCommand, { kind: "read-input-value" }>;
type RecordedMutation = (command: ValueCommand, state: KernelState) => { readonly command: KernelCommand; readonly state: KernelState };

async function fixture(value: string | readonly string[], mutate?: RecordedMutation) {
  const database = databaseFixture;
  if (!database) throw new Error("lazy command test fixture is unavailable");
  const records = new FactoryRecords(database.db, tenantId);
  await records.bindInstallation();
  await database.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId}, 'Lazy command', '/tmp/lazy-command')`);
  await database.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${principal.id}, 'lazy-command@example.test', 'not-a-login', 'Lazy command owner', 'admin')`);
  await database.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('lazy-command-membership', ${projectId}, ${principal.id}, 'owner')`);
  const grants = new FactoryGrants(database.db, tenantId, () => now);
  await database.db.transaction(transaction => grants.initializeProjectInTransaction(transaction, projectId, principal.id));
  const artifacts = new FactoryArtifacts(database.db, database.blobs, tenantId);
  const paged = Array.isArray(value);
  const parameterName = paged ? "items" : "source";
  const sourceIdentity = { tenantId, projectId, logicalRunId: "lazy-command-source", interpreterId: "root" };
  await records.createRun({ projectId, runId: sourceIdentity.logicalRunId, definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "lazy-command", executionEpoch: 1, input: {}, principalId: principal.id, principalKind: principal.kind }, async () => {});
  const stored = await artifacts.stage(sourceIdentity, "candidate_output", new TextEncoder().encode(canonicalJson(paged ? value : { value })), { interpreterScoped: false, candidateNodeInstanceId: "lazy-command-source-node", candidateGeneration: 1 });
  const artifact = { artifactId: stored.objectId, digest: stored.digest, encodedBytes: stored.encodedBytes };
  const task = referenceCodeV1.graph.nodes.find(node => node.kind === "task");
  if (task?.kind !== "task") throw new Error("reference task missing");
  const source: FactoryDefinition = {
    ...structuredClone(referenceCodeV1), id: definitionKey.factoryId,
    inputPorts: paged ? { items: { type: "array", items: { type: "string" }, maxItems: 96 } } : { source: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
    outputPorts: {},
    graph: paged
      ? { nodes: [{ id: "read-items", kind: "map", collection: { kind: "ref", root: "input", name: "items" }, itemSchema: { type: "string" }, body: { nodes: [], outputs: {} }, mode: "all", maxItems: 96, maxConcurrency: 4, outputPorts: {} }], outputs: {} }
      : { nodes: [{ ...task, id: "read-source", dependsOn: [], inputPorts: { value: { type: "string" } }, bindings: { value: { kind: "ref", root: "input", name: "source", path: ["value"] } } }], outputs: {} },
  };
  const definitions = new FactoryDefinitions(database.db, tenantId, grants, database.blobs);
  await definitions.save(principal, definitionKey, 0, "lazy-command-definition-save", source);
  const version = await definitions.publish(principal, definitionKey, 1, "lazy-command-definition-publish");
  const lifecycle = new FactoryRunLifecycle(database.db, tenantId, {
    definitions, grants, interpreterBuild: "lazy-command", interpreterCompatibility: source.interpreterCompatibility,
    limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 },
    stageDefinitionInTransaction: (transaction, compiled, identity) => new FactoryDefinitionArtifacts(artifacts).stageDefinitionInTransaction(transaction, compiled, identity),
    async resolveParameters(transaction) {
      const loaded = await artifacts.loadInTransaction(transaction, sourceIdentity, stored, ["candidate_output"], false);
      return { [parameterName]: JSON.parse(new TextDecoder().decode(loaded.content)) } as JsonValue;
    },
  }, () => now);
  const body = { factoryVersion: version.version, definitionDigest: version.definitionDigest, grantRevision: 1, parameters: { [parameterName]: { kind: "artifact" as const, artifact } } };
  const run = await lifecycle.start(principal, definitionKey, body, 0, "lazy-command-start");
  const identity = { tenantId, projectId, logicalRunId: run.run.runId, interpreterId: "root" };
  const { compiled } = await definitions.readVersion(principal, definitionKey, version.version);
  const start = { kind: "start", id: "lazy-command-start-event", atMs: now } as const;
  const input: JsonValue = paged ? { items: [...value] } : { source: { value: value as string } };
  const first = advanceKernel(compiled, createKernelState(compiled, identity.logicalRunId, input, now, { schemaVersion: "factory.lazy-input.v1", parameters: body.parameters }), start);
  const command = first.commands.find((entry): entry is Extract<typeof entry, { kind: "read-input-value" | "read-input-page" }> => entry.kind === "read-input-value" || entry.kind === "read-input-page");
  if (!command || (!paged && command.kind !== "read-input-value") || (paged && command.kind !== "read-input-page")) throw new Error("lazy command was not emitted");
  const transitions = new FactoryTransitionArtifacts(artifacts);
  const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
  const recorded = mutate?.(command as ValueCommand, first.nextState) ?? { command, state: first.nextState };
  await persistTransition(identity, 1, start, recorded.state, first.commands.map(entry => entry.id === command.id ? recorded.command : entry), undefined, activities);
  const access = new FactoryArtifactAccess(database.db, tenantId, grants, artifacts);
  const reader = new FactoryLazyInputReader(database.db, tenantId, artifacts, access, grants, () => now);
  const authority = new FactoryCommandAuthority(database.db, tenantId, lifecycle, transitions, ["orchestration", "tenant-a"], () => now);
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

test("lazy command maps the current stored command to a bounded artifact page", async () => {
  const setup = await fixture(["first", "second", "third"]);
  const event = await setup.commands.execute({ tenantId, subject: "orchestration" }, { ...setup.identity, commandId: setup.command.id });
  expect(event).toMatchObject({ kind: "input-page-read", commandId: setup.command.id, items: ["first", "second", "third"] });
  expect(event.id).toBe(`${setup.command.id}:page`);
});

test("lazy command rejects a value that cannot fit its recorded event envelope", async () => {
  const setup = await fixture("x".repeat(32 * 1024 - 300));
  await expect(setup.commands.execute({ tenantId, subject: "orchestration" }, { ...setup.identity, commandId: setup.command.id })).rejects.toMatchObject({ code: "factory_lazy_input_page_required" });
});


test("lazy command rejects a substituted stored command", async () => {
  const setup = await fixture("stored value", (command, state) => ({ command: { ...command, path: ["other"] }, state }));
  await expect(setup.commands.execute({ tenantId, subject: "orchestration" }, { ...setup.identity, commandId: setup.command.id })).rejects.toMatchObject({ code: "factory_command_stale" });
});

test("lazy command rejects a version mismatch from immutable storage", async () => {
  const setup = await fixture("stored value", (command, state) => ({
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
  await expect(setup.commands.execute({ tenantId, subject: "orchestration" }, { ...setup.identity, commandId: setup.command.id })).rejects.toMatchObject({ code: "factory_lazy_command_invalid" });
});

test("lazy command rejects a cancelled or foreign current run", async () => {
  const setup = await fixture("stored value");
  await setup.lifecycle.cancel(principal, { projectId, runId: setup.run.runId }, setup.run.revision, "lazy-command-cancel");
  await expect(setup.commands.execute({ tenantId, subject: "orchestration" }, { ...setup.identity, commandId: setup.command.id })).rejects.toMatchObject({ code: "factory_run_stopped" });
  await expect(setup.commands.execute({ tenantId: "foreign", subject: "orchestration" }, { ...setup.identity, commandId: setup.command.id })).rejects.toMatchObject({ code: "factory_command_forbidden" });
});


test("private mTLS gateway executes only the stored lazy command reference", async () => {
  const setup = await fixture("stored value");
  const directories: string[] = [];
  const certs = await certificates(directories);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issuer = "https://lazy-command.example.test";
  const audience = "factory-lazy-command";
  const token = () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "lazy-command" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "tenant-a", iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1_000) + 60, scope: ["factory:orchestrate"] })).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  };
  const server = startFactoryPrivateService({
    tenantId, certificateIdentity: "tenant-a", hostname: "127.0.0.1", port: 0, tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey },
    tokens: async () => ({ issuer, audience, publicKeys: { "lazy-command": keys.publicKey.export({ type: "spki", format: "pem" }).toString() } }),
    queue: new FactoryTransportQueue(new FactoryInstallationCommandOutbox(setup.database.db, tenantId), new FactoryInbox(setup.database.db, tenantId)),
    artifacts: setup.activities,
    commands: {
      execute: (service, reference) => setup.commands.execute(service, reference),
      async resolveFactory() { throw new Error("lazy command test does not resolve child factories"); },
    },
  });
  try {
    const response = await nodeHttpsRequest(`${server.url}/internal/factory/v1/commands/${encodeURIComponent(setup.command.id)}`, certs, {
      token: token(),
      body: { ...setup.identity, command: { kind: setup.command.kind, id: setup.command.id, path: ["caller-substitution-must-not-reach-reader"] } },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toMatchObject({ kind: "input-value-read", commandId: setup.command.id, value: "stored value" });
    const foreign = await nodeHttpsRequest(`${server.url}/internal/factory/v1/commands/${encodeURIComponent(setup.command.id)}`, certs, {
      token: token(), body: { ...setup.identity, tenantId: "foreign", command: { kind: setup.command.kind, id: setup.command.id } },
    });
    expect(foreign.status).toBe(403);
  } finally {
    server.stop();
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  }
});

}
