import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { canonicalizeJson, sha256Hex, type FactoryRunnerRequest, type JsonValue } from "@ezcorp/factory-sdk";
import { createFactoryGuestStaging, FactoryGuestMaterialError } from "@ezcorp/factory-sdk/guest-materials";
import { closeTestDb, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { certificates, nodeHttpsRequest, type Certificates } from "../../__tests__/helpers/factory-certificates";
import { FileBlobStore } from "../../extensions/v4/blobs";
import { FactoryArtifacts } from "../artifacts";
import { signFactoryAttemptToken } from "../attempt-token";
import { FactoryExecutionJournal } from "../executions";
import { startFactoryPrivateHttps } from "../private-https";
import { factoryRunnerRequestAuthority } from "./attempt-authority";
import { createFactoryGuestBrokerClient } from "./guest-broker-client";
import { FACTORY_GUEST_BROKER_PATH, createFactoryGuestBrokerRouteHandler } from "./guest-broker-service";
import { createFactoryGuestMaterialFrameBroker, createFactoryGuestMaterialServices } from "./guest-material-broker";
import { createFactoryConfiguredGuestBroker } from "./supervisor-process";
import { FACTORY_GUEST_BROKER_UNCONFIGURED, composeFactoryGuestBroker } from "../guest-broker-composition";
import type { FactoryStartupConfig } from "../startup-config";

/**
 * The byte path a sandboxed guest actually has, end to end over mutual TLS.
 *
 * The guest is on `--network=none` and the host holds no tenant record, so the
 * frame has to cross this boundary for a COMPLETED result to be possible at
 * all. The test drives the shipped guest client through the shipped forwarding
 * host client, across a real private HTTPS listener, into the real material
 * service on a real database.
 */

const TENANT = "tenant-a";
const SECRET = "guest-broker-transport-secret";
const INSTALLATION = "installation-a";

const directories: string[] = [];
const closing: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(closing.splice(0).map(close => close()));
  // One helper-owned PGlite instance is shared across `setupTestDb` calls and
  // each call closes the previous one, so this closes the last, once.
  await closeTestDb();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function runnerRequest(attemptId: string, projectId: string, runId: string, deadlineAtMs: number): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: {
      attemptId, tenantId: TENANT, projectId, runId, nodeInstanceId: "node-a", candidateGeneration: 0, attemptNumber: 1,
      grantRevision: 1, reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, deadlineAtMs, nextOperationIndex: 0,
    },
    runner: { package: "@example/runner", manifestName: "runner", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "run" },
    input: { kind: "inline", value: { prompt: "stage" } },
    grants: [],
    resources: { maxCostMicros: "1000", maxTokens: 200, maxComputeMs: 30_000, memoryBytes: 1024, resourceClass: "cpu.small" },
    tools: [],
    broker: { attemptToken: "unset", audience: INSTALLATION },
  } as FactoryRunnerRequest;
}

async function clientSecrets(root: string, certs: Certificates) {
  const paths = { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key"), serviceTokenPath: join(root, "token") };
  await writeFile(paths.caPath, certs.ca);
  await writeFile(paths.certificatePath, certs.clientCert);
  await writeFile(paths.privateKeyPath, certs.clientKey);
  // The host's own service credential. It authenticates the HOST; the attempt
  // token in the body is what authorizes the frame.
  await writeFile(paths.serviceTokenPath, "host-service-credential");
  return paths;
}

async function setup() {
  const { db } = await setupTestDb();
  const root = await mkdtemp(join(tmpdir(), "factory-guest-broker-transport-"));
  directories.push(root);

  const projectId = `transport-project-${randomUUID()}`;
  const runId = `transport-run-${randomUUID()}`;
  const attemptId = `transport-attempt-${randomUUID()}`;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Transport', ${`/tmp/${projectId}`})`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 6) ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, execution_epoch=EXCLUDED.execution_epoch`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${projectId}, ${runId}, ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);

  const request = runnerRequest(attemptId, projectId, runId, Date.now() + 600_000);
  const authority = factoryRunnerRequestAuthority(request);
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${attemptId},${TENANT},${projectId},${runId},'node-a',0,1,1,1,6,0,${authority.deadlineAt},${authority.requestDigest},'{}'::jsonb,'admitted')`);

  const blobs = new FileBlobStore(join(root, "blobs"));
  const artifacts = new FactoryArtifacts(db, blobs, TENANT);
  const journal = new FactoryExecutionJournal(db, async () => {});
  const broker = createFactoryGuestMaterialFrameBroker({ services: createFactoryGuestMaterialServices({ database: db, artifacts, blobs, journal }) });

  const certs = await certificates(directories, TENANT);
  const service = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    handle: createFactoryGuestBrokerRouteHandler({ allowedPeers: [TENANT], broker, jwtSecret: SECRET, installationId: INSTALLATION }),
  });
  closing.push(async () => { service.stop(); });

  // The token a launch mints and the guest runs under, carried by the request
  // exactly as `FactoryRemoteAttemptRuntime` carries it.
  const token = await signFactoryAttemptToken(authority, SECRET, INSTALLATION, 600);
  const tokened = { ...request, broker: { ...request.broker, attemptToken: token } } as FactoryRunnerRequest;
  const paths = await clientSecrets(root, certs);
  return { db, artifacts, blobs, journal, service, certs, paths, request: tokened, authority, projectId, runId, operationId: `${runId}:node-a:0:0` };
}

test("a guest stages and promotes an output across a real host boundary", async () => {
  const fixture = await setup();
  const host = await createFactoryGuestBrokerClient({ baseUrl: fixture.service.url, tls: fixture.paths, serverName: "localhost" });
  const client = createFactoryGuestStaging({
    call: async payload => host.invoke(fixture.request, payload),
    operationId: fixture.operationId,
    operationIndex: 0,
  });

  // Two chunks, so the multi-frame path crosses the wire rather than one frame.
  const bytes = new Uint8Array(40_000);
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index % 251;
  const staged = await client.stageOutput("evidence.bin", bytes);
  expect(staged.digest).toBe(`sha256:${sha256Hex(bytes)}`);
  expect(staged.totalBytes).toBe(bytes.byteLength);

  const value = { crossed: "the host boundary" } as unknown as JsonValue;
  const promoted = await client.stageResult("result.json", value);
  const canonical = new TextEncoder().encode(canonicalizeJson(value));
  expect(promoted.resultDigest).toBe(sha256Hex(canonical));
  expect(promoted.output.digest).toBe(`sha256:${promoted.resultDigest}`);

  // The candidate is durable in the product database, in this attempt's slot.
  const loaded = await fixture.db.transaction(transaction => fixture.artifacts.loadInTransaction(
    transaction, { tenantId: TENANT, projectId: fixture.projectId, logicalRunId: fixture.runId },
    { objectId: promoted.output.artifactId, digest: promoted.output.digest, encodedBytes: promoted.output.encodedBytes }, ["candidate_output"]));
  expect(new TextDecoder().decode(loaded.content)).toBe(canonicalizeJson(value));
}, 120_000);

test("a refusal crosses the boundary as a refusal, not as a transport failure", async () => {
  const fixture = await setup();
  const host = await createFactoryGuestBrokerClient({ baseUrl: fixture.service.url, tls: fixture.paths, serverName: "localhost" });
  const client = createFactoryGuestStaging({ call: async payload => host.invoke(fixture.request, payload), operationId: fixture.operationId, operationIndex: 0 });
  await fixture.db.execute(sql`UPDATE factory_executions SET status='cancel_accepted' WHERE attempt_id=${fixture.authority.attemptId}`);
  const failure = await client.stageOutput("late.bin", new TextEncoder().encode("too late")).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(FactoryGuestMaterialError);
  expect((failure as FactoryGuestMaterialError).code).toBe("stale_epoch");
}, 120_000);

test("a payload that is not a staging frame never crosses, and is delegated or refused here", async () => {
  const fixture = await setup();
  const seen: unknown[] = [];
  const delegating = await createFactoryGuestBrokerClient({ baseUrl: fixture.service.url, tls: fixture.paths, serverName: "localhost", delegate: { invoke: async (_request: FactoryRunnerRequest, payload: unknown) => { seen.push(payload); return { accepted: true }; } } });
  expect(await delegating.invoke(fixture.request, { schemaVersion: "factory.guest-model-request.v1" })).toEqual({ accepted: true });
  expect(seen).toHaveLength(1);

  const alone = await createFactoryGuestBrokerClient({ baseUrl: fixture.service.url, tls: fixture.paths, serverName: "localhost" });
  await expect(alone.invoke(fixture.request, { schemaVersion: "factory.guest-model-request.v1" })).rejects.toThrow("has no other route");
}, 120_000);

test("the route authenticates the host and the attempt separately, and refuses each alone", async () => {
  const fixture = await setup();
  const frame = { schemaVersion: "factory.guest-material-begin.v1", operationId: fixture.operationId, operationIndex: 0, objectName: "probe.bin", version: 1, mediaType: "application/octet-stream", totalBytes: 4, chunkCount: 1 };
  const token = fixture.request.broker.attemptToken;
  const url = `${fixture.service.url}${FACTORY_GUEST_BROKER_PATH}`;
  const call = (options: Parameters<typeof nodeHttpsRequest>[2]) => nodeHttpsRequest(url, fixture.certs, options);

  // A foreign client certificate: the peer is not a host this product serves.
  const foreign = await call({ method: "POST", body: { attemptToken: token, payload: frame }, certificate: "foreign", headers: { "x-ezcorp-factory-version": "1" } });
  expect(foreign.status).toBe(403);

  // The right host, a token that is not this installation's.
  const wrongToken = await call({ method: "POST", body: { attemptToken: "not-a-signed-attempt-token", payload: frame }, headers: { "x-ezcorp-factory-version": "1" } });
  expect(wrongToken.status).toBe(401);

  // The right host and the right token, but nothing to answer.
  for (const body of [{ attemptToken: token }, { payload: frame }, ["not", "an", "object"], "text"]) {
    const bad = await call({ method: "POST", body, headers: { "x-ezcorp-factory-version": "1" } });
    expect(bad.status, JSON.stringify(body)).toBe(400);
  }

  // Wrong path, wrong method, oversize body.
  expect((await nodeHttpsRequest(`${fixture.service.url}/v1/guest/elsewhere`, fixture.certs, { method: "POST", body: {}, headers: { "x-ezcorp-factory-version": "1" } })).status).toBe(404);
  expect((await call({ method: "PUT", body: { attemptToken: token, payload: frame }, headers: { "x-ezcorp-factory-version": "1" } })).status).toBe(405);
  const oversize = await call({ method: "POST", body: { attemptToken: token, payload: { ...frame, objectName: "x".repeat(200_000) } }, headers: { "x-ezcorp-factory-version": "1" } });
  expect(oversize.status).toBe(413);

  // A malformed JSON body, which the private transport passes through as bytes.
  const malformed = await call({ method: "POST", body: undefined, headers: { "x-ezcorp-factory-version": "1", "content-type": "application/json" } });
  expect(malformed.status).toBe(400);

  // And the control: the same frame, the right host, the right token.
  const accepted = await call({ method: "POST", body: { attemptToken: token, payload: frame }, headers: { "x-ezcorp-factory-version": "1" } });
  expect(accepted.status).toBe(200);
  expect(JSON.parse(accepted.body.toString("utf8"))).toMatchObject({ status: "begun", objectName: "probe.bin" });
}, 120_000);

test("an answer the product could not have produced is refused rather than handed to the guest", async () => {
  const fixture = await setup();
  const lying = startFactoryPrivateHttps({
    tls: { key: fixture.certs.serverKey, cert: fixture.certs.serverCert, ca: fixture.certs.ca },
    handle: async () => ({ status: 200, body: Buffer.from('{"status":"begun"}') }),
  });
  closing.push(async () => { lying.stop(); });
  const host = await createFactoryGuestBrokerClient({ baseUrl: lying.url, tls: fixture.paths, serverName: "localhost" });
  const frame = { schemaVersion: "factory.guest-material-seal.v1", operationId: fixture.operationId, operationIndex: 0, objectName: "probe.bin", version: 1, digest: `sha256:${"a".repeat(64)}` };
  await expect(host.invoke(fixture.request, frame)).rejects.toThrow("not a staging response");

  const garbled = startFactoryPrivateHttps({
    tls: { key: fixture.certs.serverKey, cert: fixture.certs.serverCert, ca: fixture.certs.ca },
    handle: async () => ({ status: 200, body: Buffer.from([0xff, 0xfe, 0x00]) }),
  });
  closing.push(async () => { garbled.stop(); });
  const other = await createFactoryGuestBrokerClient({ baseUrl: garbled.url, tls: fixture.paths, serverName: "localhost" });
  await expect(other.invoke(fixture.request, frame)).rejects.toThrow("not JSON");
}, 120_000);

test("a supervisor configured with a guest broker forwards staging frames and still refuses a model call by name", async () => {
  const fixture = await setup();
  const { caPath, certificatePath, privateKeyPath, serviceTokenPath } = fixture.paths;
  // Exactly the section a supervisor document carries: a base URL and paths.
  const host = await createFactoryConfiguredGuestBroker({ baseUrl: fixture.service.url, serviceTokenPath, tls: { caPath, certificatePath, privateKeyPath } });
  const frame = { schemaVersion: "factory.guest-material-begin.v1", operationId: fixture.operationId, operationIndex: 0, objectName: "configured.bin", version: 1, mediaType: "application/octet-stream", totalBytes: 4, chunkCount: 1 };
  expect(await host.invoke(fixture.request, frame)).toMatchObject({ status: "begun", objectName: "configured.bin" });
  // No route serves a model request yet, so it keeps the host's default answer
  // rather than reaching a route that would not know it.
  await expect(host.invoke(fixture.request, { schemaVersion: "factory.guest-model-request.v1" })).rejects.toMatchObject({ code: "factory_host_broker_unavailable" });
  // A section whose credential file is missing fails when the host composes,
  // before its listener binds, not on a guest's first frame.
  await expect(createFactoryConfiguredGuestBroker({ baseUrl: fixture.service.url, serviceTokenPath: `${serviceTokenPath}.missing`, tls: { caPath, certificatePath, privateKeyPath } }))
    .rejects.toThrow();
}, 120_000);

/**
 * The product process binds the route itself, from its startup document.
 *
 * The files sit in a private directory under HOME because the private reader
 * refuses a world-writable ancestor such as /tmp.
 */
async function composedRoute(fixture: Awaited<ReturnType<typeof setup>>, overrides: { readonly secret?: string; readonly missingKey?: boolean } = {}) {
  const root = await mkdtemp(join(process.env.HOME!, ".w01g-guest-broker-"));
  directories.push(root);
  await chmod(root, 0o700);
  const files = { secret: join(root, "attempt.secret"), ca: join(root, "ca.pem"), cert: join(root, "server.pem"), key: join(root, "server.key") };
  const secret = overrides.secret ?? "composition-attempt-token-secret-0123456789";
  for (const [path, value] of [[files.secret, secret], [files.ca, fixture.certs.ca], [files.cert, fixture.certs.serverCert], [files.key, fixture.certs.serverKey]] as const) {
    if (overrides.missingKey && path === files.key) continue;
    await writeFile(path, value, { mode: 0o600 });
    await chmod(path, 0o600);
  }
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  const config = {
    installationId: INSTALLATION,
    hostLaunch: { attemptTokenSecretPath: files.secret },
    guestBroker: { hostname: "127.0.0.1", port, allowedPeers: [TENANT], tls: { caPath: files.ca, certificatePath: files.cert, privateKeyPath: files.key } },
  } as unknown as FactoryStartupConfig;
  const reported: Array<{ role: string; error: unknown }> = [];
  const composed = await composeFactoryGuestBroker({
    database: fixture.db, config, blobs: fixture.blobs,
    application: { artifacts: fixture.artifacts, journal: fixture.journal },
    report: (role, error) => { reported.push({ role, error }); },
  });
  if (composed.listener) closing.push(async () => { composed.listener!.stop(); });
  return { composed, reported, secret, port };
}

test("the product binds the guest-broker route from its startup document, and a host's frame reaches it", async () => {
  const fixture = await setup();
  const { composed, reported, secret } = await composedRoute(fixture);
  expect(composed.readiness).toEqual({ state: "bound" });
  expect(reported).toEqual([]);

  // The token verifies with the dispatcher's own secret file, not a copy.
  const token = await signFactoryAttemptToken(fixture.authority, secret, INSTALLATION, 600);
  const request = { ...fixture.request, broker: { ...fixture.request.broker, attemptToken: token } } as FactoryRunnerRequest;
  const { caPath, certificatePath, privateKeyPath, serviceTokenPath } = fixture.paths;
  const host = await createFactoryConfiguredGuestBroker({ baseUrl: composed.listener!.url, serviceTokenPath, tls: { caPath, certificatePath, privateKeyPath } });
  const client = createFactoryGuestStaging({ call: async payload => host.invoke(request, payload), operationId: fixture.operationId, operationIndex: 0 });
  // Two chunks, so more than one frame crosses the listener the product bound.
  const bytes = new Uint8Array(40_000).map((_, index) => index % 251);
  const staged = await client.stageOutput("composed.bin", bytes);
  expect(staged.digest).toBe(`sha256:${sha256Hex(bytes)}`);

  // A token signed with any other secret is refused before the broker.
  const forged = { ...request, broker: { ...request.broker, attemptToken: await signFactoryAttemptToken(fixture.authority, `${secret}-other`, INSTALLATION, 600) } } as FactoryRunnerRequest;
  await expect(host.invoke(forged, { schemaVersion: "factory.guest-material-begin.v1", operationId: fixture.operationId, operationIndex: 0, objectName: "forged.bin", version: 1, mediaType: "application/octet-stream", totalBytes: 1, chunkCount: 1 }))
    .rejects.toThrow();
}, 120_000);

test("an undeclared route is named in readiness, and a declared one that cannot bind is reported and named", async () => {
  const fixture = await setup();
  const unconfigured = await composeFactoryGuestBroker({
    database: fixture.db, config: { installationId: INSTALLATION } as unknown as FactoryStartupConfig, blobs: fixture.blobs,
    application: { artifacts: fixture.artifacts, journal: fixture.journal },
    report: () => { throw new Error("an undeclared route is not a failure to report"); },
  });
  expect(unconfigured).toEqual({ readiness: { state: "unconfigured", code: FACTORY_GUEST_BROKER_UNCONFIGURED } });

  // A key file that is not there: nothing binds, the role is reported, and
  // readiness carries a code rather than a path or a stack.
  const missingKey = await composedRoute(fixture, { missingKey: true });
  expect(missingKey.composed.listener).toBeUndefined();
  expect(missingKey.composed.readiness.state).toBe("unavailable");
  expect(JSON.stringify(missingKey.composed.readiness)).not.toContain(process.env.HOME!);
  expect(missingKey.reported.map(entry => entry.role)).toEqual(["guest-broker"]);

  // A secret too short to sign with is the dispatcher's own refusal, by name.
  const weak = await composedRoute(fixture, { secret: "short" });
  expect(weak.composed.readiness).toEqual({ state: "unavailable", code: "factory_attempt_token_secret_invalid" });
}, 120_000);
