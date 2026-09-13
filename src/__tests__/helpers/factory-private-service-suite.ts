import { compileFactory } from "@ezcorp/factory-sdk/compiler";
import { referenceCodeV1, type CompiledFactory } from "@ezcorp/factory-sdk";
import { createKernelState } from "@ezcorp/factory-sdk/kernel";
import { encodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import { createHash } from "node:crypto";
import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider } from "../../factory/encryption";
import { DatabaseInstallationKeyWrapStore } from "../../factory/encryption-key-wrap-store";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArtifacts } from "../../factory/artifacts";
import { createFactoryArtifactActivities } from "../../factory/artifact-activities";
import { FactoryDefinitionError } from "../../factory/definitions";
import { FactoryDefinitionArtifacts } from "../../factory/definition-artifacts";
import { FactoryTransitionArtifacts } from "../../factory/transition-artifacts";
import { FactoryCommandOutbox, FactoryInstallationCommandOutbox } from "../../factory/outbox";
import { FactoryInbox } from "../../factory/inbox";
import { FactoryTransportQueue } from "../../factory/transport-queue";
import { FactoryRecords } from "../../factory/records";
import { startFactoryPrivateService } from "../../factory/private-service";
import { certificates, nodeHttpsRequest, nodeFactoryQueueCycle, type Certificates } from "./factory-certificates";

export function factoryPrivateServiceConformance(create: () => Promise<{ db: TransactionalDb; blobs: BlobStore; close(): Promise<void> }>): void {
  const directories: string[] = [];
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const identity = { tenantId: "private-tenant", projectId: "private-project", logicalRunId: "private-run", interpreterId: "root" };
  let fixture: Awaited<ReturnType<typeof create>>;
  let certs: Certificates;
  let server: { url: string; stop(): void };
  let outbox: FactoryCommandOutbox;
  let definitions: FactoryDefinitionArtifacts;
  let compiled: CompiledFactory;
  const commands: Array<{ service: unknown; reference: unknown }> = [];
  const issuer = "https://factory.example.test";
  const audience = "factory-private-service";
  function token(overrides: Record<string, unknown> = {}): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "tenant-a", iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 60, scope: ["factory:orchestrate"], ...overrides })).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  }
  beforeAll(async () => {
    fixture = await create();
    certs = await certificates(directories);
    const compilation = compileFactory(referenceCodeV1);
    if (!compilation.ok) throw new Error("Private service fixture did not compile.");
    compiled = compilation.factory;
    const records = new FactoryRecords(fixture.db, identity.tenantId);
    await records.bindInstallation();
    await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${identity.projectId},'Private','/tmp/private')`);
    await records.bindProject(identity.projectId);
    await records.createRun({ projectId: identity.projectId, runId: identity.logicalRunId, definitionDigest: compiled.digest, interpreterBuild: "test", executionEpoch: 1, input: {}, principalId: "private-service", principalKind: "service" }, async () => {});
    outbox = new FactoryCommandOutbox(fixture.db, identity.tenantId, identity.projectId);
    const dataKey = await InstallationDataKey.loadOrCreate("private-installation", new DatabaseInstallationKeyWrapStore(fixture.db), new StaticMasterKeyProvider({ id: "test-master", bytes: new Uint8Array(32).fill(4) }));
    const artifacts = new FactoryArtifacts(fixture.db, new EncryptedBlobStore(fixture.blobs, dataKey, identity.tenantId), identity.tenantId);
    definitions = new FactoryDefinitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(definitions, new FactoryTransitionArtifacts(artifacts));
    server = startFactoryPrivateService({
      tenantId: identity.tenantId, certificateIdentity: "tenant-a", tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey },
      tokens: async () => ({ issuer, audience, publicKeys: { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() } }),
      queue: new FactoryTransportQueue(new FactoryInstallationCommandOutbox(fixture.db, identity.tenantId), new FactoryInbox(fixture.db, identity.tenantId)),
      artifacts: activities,
      commands: { async execute(service, reference) { commands.push({ service, reference }); if (reference.commandId === "unavailable") throw new Error("internal privileged details"); if (reference.commandId === "driver-failure") throw Object.assign(new Error("internal driver failure"), { code: "internal-driver-location" }); return reference.commandId === "pending" ? null : { kind: "cancel", id: "command-result", atMs: 1, reason: "test command result" }; }, async resolveFactory(service, request) { if (service.tenantId !== identity.tenantId || request.factory.id !== compiled.definition.id || request.factory.version !== compiled.definition.version || request.factory.digest !== compiled.digest) throw new FactoryDefinitionError("factory_version_not_found"); return definitions.stageDefinition(compiled, request); } },
    });
  });
  afterAll(async () => { server?.stop(); await fixture?.close(); await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });
  const call = (path: string, options: Parameters<typeof nodeHttpsRequest>[2] = {}) => nodeHttpsRequest(`${server.url}/internal/factory/v1${path}`, certs, { token: token(), ...options });

  test("the real Node client needs the bound certificate and purpose-scoped issuer before claiming a stored command", async () => {
    const queued = await outbox.enqueue({ kind: "start_run", projectId: identity.projectId, logicalRunId: identity.logicalRunId, interpreterId: identity.interpreterId, body: { marker: "stored" } });
    await expect(call("/outbox/claim", { body: {}, certificate: "none" })).rejects.toThrow("Node HTTPS client failed");
    for (const options of [{ token: "invalid" }, { certificate: "foreign" as const }, { token: token({ sub: "tenant-b" }) }, { token: token({ iss: "foreign" }) }, { token: token({ aud: "pool" }) }, { token: token({ scope: ["admin"] }) }, { token: token({ exp: 1 }) }]) {
      expect((await call("/outbox/claim", { body: {}, ...options })).status).toBe(401);
    }
    expect((await call("/outbox/claim", { body: { tenantId: "foreign" } })).status).toBe(400);
    expect((await outbox.inspect(queued.id))?.state).toBe("queued");
    const response = await call("/outbox/claim", { body: {} });
    expect(response.status).toBe(200);
    const claim = JSON.parse(response.body.toString());
    expect(claim.command).toEqual(queued.command);
    expect(claim.claimToken).toBeString();
    expect(JSON.parse((await call("/outbox/confirm-inbox", { body: { command: claim.command } })).body.toString())).toBe(false);
    expect((await call("/outbox/settle", { body: { claim: { ...claim, command: { ...claim.command, body: { marker: "forged" } } }, outcome: "delivered" } })).status).toBe(409);
    expect((await call("/outbox/settle", { body: { claim, outcome: "delivered" } })).status).toBe(204);
    expect((await outbox.inspect(queued.id))?.state).toBe("delivered");
  });

  test("protocol errors fail closed and the service forwards only authenticated stored-command references", async () => {
    const health = await call("/health", { method: "GET" });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body.toString())).toEqual({ schemaVersion: "factory.private-service.v1", tenantId: identity.tenantId });
    for (const body of [null, [], 4]) expect((await call("/outbox/claim", { body })).status).toBe(400);
    expect((await call("/outbox/claim", { body: {}, headers: { "x-ezcorp-factory-version": "2" } })).status).toBe(400);
    expect((await call("/outbox/claim", { body: {}, headers: { "content-type": "text/plain" } })).status).toBe(400);
    expect((await call("/unknown", { body: {} })).status).toBe(404);
    expect((await call("/outbox/settle", { body: { outcome: "success" } })).status).toBe(400);
    expect((await call("/outbox/settle", { body: { outcome: "retry", errorCode: "invalid error text" } })).status).toBe(400);
    expect((await call("/outbox/settle", { body: { outcome: "retry", claim: { claimToken: 3 } } })).status).toBe(400);
    const command = { kind: "dispatch-node", id: "dispatch", input: { forged: "must not reach authority" }, runner: { package: "untrusted" }, grantRevision: 999 };
    expect((await call("/executions/dispatch", { method: "PUT", body: { ...identity, tenantId: "foreign", command } })).status).toBe(403);
    expect((await call("/executions/wrong", { method: "PUT", body: { ...identity, command } })).status).toBe(400);
    expect(commands).toEqual([]);
    const dispatched = await call("/executions/dispatch", { method: "PUT", body: { ...identity, command } });
    expect(dispatched.status).toBe(200);
    expect(JSON.parse(dispatched.body.toString())).toMatchObject({ id: "command-result" });
    expect(commands).toEqual([{ service: { subject: "tenant-a", tenantId: identity.tenantId }, reference: { ...identity, commandId: "dispatch" } }]);
    expect((await call("/executions/dispatch/cancel", { body: { ...identity, command: { kind: "cancel-node", id: "cancel", attemptCommandId: "dispatch" } } })).status).toBe(200);
    expect((await call("/commands/pending", { body: { ...identity, command: { kind: "request-approval", id: "pending" } } })).status).toBe(204);
    const failed = await call("/commands/unavailable", { body: { ...identity, command: { kind: "request-approval", id: "unavailable" } } });
    expect(failed.status).toBe(500);
    expect(failed.body.toString()).not.toContain("privileged");
  });


  test("encrypted stored definitions and transitions cross the real Node connection as exact immutable bytes", async () => {
    const source = await definitions.stageDefinition(compiled, identity);
    const factory = { id: compiled.definition.id, version: compiled.definition.version, digest: compiled.digest };
    expect((await call("/definitions/resolve", { body: { ...identity, factory } })).status).toBe(400);
    expect((await call("/definitions/resolve", { body: { ...identity, commandId: "", factory } })).status).toBe(400);
    expect(JSON.parse((await call("/definitions/resolve", { body: { ...identity, commandId: "resolve-command", factory } })).body.toString())).toEqual(source);
    expect((await call("/definitions/resolve", { body: { ...identity, commandId: "resolve-command", factory: { ...factory, digest: `sha256:${"0".repeat(64)}` } } })).status).toBe(404);
    const manifestResponse = await call("/definitions/manifest", { body: { ...identity, definition: source, page: source.manifest } });
    expect(manifestResponse.status).toBe(200);
    expect(`sha256:${createHash("sha256").update(manifestResponse.body).digest("hex")}`).toBe(source.manifest.digest);
    const manifest = JSON.parse(manifestResponse.body.toString());
    const parts: string[] = [];
    for (const page of manifest.pages) {
      const response = await call("/definitions/page", { body: { ...identity, definitionDigest: compiled.digest, page } });
      expect(response.status).toBe(200);
      expect(response.body.byteLength).toBe(page.encodedBytes);
      expect(`sha256:${createHash("sha256").update(response.body).digest("hex")}`).toBe(page.digest);
      parts.push(response.body.toString());
    }
    expect(JSON.parse(parts.join(""))).toEqual(compiled);
    expect((await call("/definitions/manifest", { body: { ...identity, projectId: "foreign", definition: source, page: source.manifest } })).status).toBe(404);
    const execution = { partitionId: "part-a" };
    const executionRef = await definitions.stageExecutionManifest(execution as never, identity, compiled.digest);
    expect(JSON.parse((await call("/definitions/execution-manifest", { body: { ...identity, definitionDigest: compiled.digest, manifest: executionRef } })).body.toString())).toEqual(execution);
    const partition = { id: "part-a" };
    const partitionRef = await definitions.stagePartition(partition as never, identity, compiled.digest);
    expect(JSON.parse((await call("/definitions/partition", { body: { ...identity, definitionDigest: compiled.digest, partition: partitionRef } })).body.toString())).toEqual(partition);

    const event = { kind: "cancel", id: "private-cancel", atMs: 10, reason: "fixture" };
    const state = createKernelState(compiled, identity.logicalRunId, { repositoryConnection: { id: "repo" }, baseCommitSha: "abc123", request: "private service proof", destinationRepository: { id: "repo" }, baseBranch: "main" }, 1);
    const transition = { schemaVersion: "factory.transition.v1", ...identity, sourceSequence: 1, event, nextState: state, commands: [] };
    const bytes = Buffer.from(canonicalizeJson(transition as never));
    const staged = await call("/transitions/1/pages/0", { method: "PUT", body: { ...identity, sourceSequence: 1, index: 0, contentBase64: encodeFactoryPageBase64(bytes), encodedBytes: bytes.byteLength } });
    expect(staged.status).toBe(200);
    const page = JSON.parse(staged.body.toString());
    expect(page.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    const finalized = await call("/transitions/1/finalize", { body: { ...identity, sourceSequence: 1, encodedBytes: bytes.byteLength, eventId: event.id, pages: [page] } });
    expect(finalized.status).toBe(200);
    const proof = JSON.parse(finalized.body.toString());
    const loaded = await call("/transitions/1/page", { body: { ...identity, sourceSequence: 1, page } });
    expect(loaded.status).toBe(200);
    expect(loaded.body).toEqual(bytes);
    const savedManifest = await call("/transitions/1/manifest", { body: { ...identity, sourceSequence: 1, manifest: proof.manifest } });
    expect(savedManifest.status).toBe(200);
    expect(`sha256:${createHash("sha256").update(savedManifest.body).digest("hex")}`).toBe(proof.manifest.digest);
    expect((await call("/transitions/2/page", { body: { ...identity, sourceSequence: 1, page } })).status).toBe(400);
    expect((await call("/transitions/1/pages/1", { method: "PUT", body: { ...identity, sourceSequence: 1, index: 0 } })).status).toBe(400);
    expect((await call("/transitions/1/pages/0", { body: { ...identity, sourceSequence: 1, index: 0 } })).status).toBe(400);
    expect((await call("/transitions/1/page", { method: "PUT", body: { ...identity, sourceSequence: 1, page } })).status).toBe(400);
    expect((await call("/transitions/0/page", { body: { ...identity, sourceSequence: 0, page } })).status).toBe(400);
    expect((await call("/transitions/1/page", { body: { ...identity, interpreterId: "foreign", sourceSequence: 1, page } })).status).toBe(404);
    expect((await call("/transitions", { body: { ...identity, sourceSequence: 1, eventId: event.id, eventHash: proof.eventHash, artifactManifest: proof.manifest } })).status).toBe(204);
    const audit = await new FactoryRecords(fixture.db, identity.tenantId).readAudit({ projectId: identity.projectId, runId: identity.logicalRunId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ interpreterId: identity.interpreterId, sourceSequence: 1, payload: { eventId: event.id, eventHash: proof.eventHash } });
  });

  test("route aliases cannot read an artifact and internal driver codes stay private", async () => {
    const source = await definitions.stageDefinition(compiled, identity);
    const body = { ...identity, definition: source, page: source.manifest };
    expect((await call("/definitions/nested/manifest", { body })).status).toBe(404);
    const failure = await call("/commands/driver-failure", { body: { ...identity, command: { kind: "request-approval", id: "driver-failure" } } });
    expect(failure.status).toBe(500);
    expect(JSON.parse(failure.body.toString())).toEqual({ error: "request_failed" });
  });

  test("a legal 64 KiB stored command can be claimed and settled with its complete lease envelope", async () => {
    const runId = "large-private-run";
    await new FactoryRecords(fixture.db, identity.tenantId).createRun({ projectId: identity.projectId, runId, definitionDigest: compiled.digest, interpreterBuild: "test", executionEpoch: 1, input: {}, principalId: "private-service", principalKind: "service" }, async () => {});
    const request = { kind: "start_run" as const, projectId: identity.projectId, logicalRunId: runId, interpreterId: identity.interpreterId, body: { padding: "" } };
    let overhead = 0;
    const rollback = new Error("measure the public command envelope without committing");
    await expect(fixture.db.transaction(async transaction => {
      const probe = await outbox.enqueueInTransaction(transaction, request);
      overhead = Buffer.byteLength(canonicalizeJson(probe.command as never));
      throw rollback;
    })).rejects.toBe(rollback);
    const queued = await outbox.enqueue({ ...request, body: { padding: "x".repeat(64 * 1024 - overhead) } });
    expect(Buffer.byteLength(canonicalizeJson(queued.command as never))).toBe(64 * 1024);
    const cycle = await nodeFactoryQueueCycle(server.url, certs, token());
    expect(cycle.command).toEqual(queued.command);
    expect(cycle.confirmed).toBe(false);
    expect(cycle.empty).toBeNull();
    expect((await outbox.inspect(queued.id))?.state).toBe("delivered");
  });

}
