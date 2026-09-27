import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { canonicalizeJson, sha256Hex, type FactoryModelPin, type FactoryRunnerRequest, type JsonValue } from "@ezcorp/factory-sdk";
import { createFactoryGuestStaging, FactoryGuestMaterialError } from "@ezcorp/factory-sdk/guest-materials";
import { closeTestDb, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { certificates, nodeHttpsRequest, signedServiceToken, type Certificates } from "../../__tests__/helpers/factory-certificates";
import { digestObject, FileBlobStore } from "../../extensions/v4/blobs";
import { FactoryWorkspaceCheckpoints } from "../artifact-materials";
import { FactoryArtifacts } from "../artifacts";
import { signFactoryAttemptToken } from "../attempt-token";
import { FactoryExecutionJournal } from "../executions";
import { startFactoryPrivateHttps } from "../private-https";
import { factoryRunnerRequestAuthority } from "./attempt-authority";
import { FACTORY_GUEST_MODEL_REQUEST_TIMEOUT_MS, createFactoryGuestBrokerClient } from "./guest-broker-client";
import { FACTORY_GUEST_BROKER_AUDIENCE, FACTORY_GUEST_BROKER_PATH, FACTORY_GUEST_BROKER_SCOPE } from "./guest-broker-contract";
import { createFactoryGuestBrokerRouteHandler } from "./guest-broker-service";
import { factoryAttemptInvocationId, factoryAttemptWorkerId } from "./attempt-wire";
import { createFactoryGuestMaterialFrameBroker, createFactoryGuestMaterialServices } from "./guest-material-broker";
import type { FactoryOneHopProvider } from "./guest-model-broker";
import { createFactoryGuestModelFrameBroker } from "./guest-model-route";
import { createFactoryOneHopProvider } from "./provider-one-hop";
import { createFactoryConfiguredGuestBroker } from "./supervisor-process";
import { FACTORY_GUEST_BROKER_UNCONFIGURED, FACTORY_PROVIDER_NOT_CONFIGURED, composeFactoryGuestBroker, factoryUnpinnedModelProvider } from "../guest-broker-composition";
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
/** The host id the client certificate's host runs as. */
const HOST = "host-a";
const TOKEN_ISSUER = "factory-test";

const directories: string[] = [];
const closing: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(closing.splice(0).map(close => close()));
  // One helper-owned PGlite instance is shared across `setupTestDb` calls and
  // each call closes the previous one, so this closes the last, once.
  await closeTestDb();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const PIN_CONFIGURATION = { temperature: 0 };
/** The pin a model-calling attempt is admitted with. */
const PIN: FactoryModelPin = {
  provider: "ollama", model: "qwen3:1.7b",
  configuration: PIN_CONFIGURATION, configurationDigest: `sha256:${digestObject(PIN_CONFIGURATION)}`,
  policy: {}, policyDigest: `sha256:${digestObject({})}`,
};

/** A provider that answers every call with `text`, and counts the calls. */
function answering(text: string): { readonly provider: FactoryOneHopProvider; readonly calls: () => number } {
  let calls = 0;
  const provider = createFactoryOneHopProvider({
    broker: {
      async stream() {
        calls += 1;
        const message = {
          role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: PIN.provider, model: PIN.model,
          usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: 0,
        } as unknown as AssistantMessage;
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.end(message);
        return stream;
      },
    },
    resolveModel: (pin) => ({ id: pin.model, provider: pin.provider, api: "openai-completions" }) as Model<Api>,
    now: () => 0,
  });
  return { provider, calls: () => calls };
}

/** A model request for the fixture's operation 0, under `model`. */
function modelRequest(operationId: string, model: FactoryModelPin = PIN): JsonValue {
  return { schemaVersion: "factory.guest-model-request.v1", operationId, operationIndex: 0, model, messages: [{ role: "user", text: "across the boundary" }], maxOutputTokens: 16 } as unknown as JsonValue;
}

function runnerRequest(attemptId: string, projectId: string, runId: string, deadlineAtMs: number, model?: FactoryModelPin): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: {
      attemptId, tenantId: TENANT, projectId, runId, nodeInstanceId: "node-a", candidateGeneration: 0, attemptNumber: 1,
      grantRevision: 1, reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, deadlineAtMs, nextOperationIndex: 0,
    },
    runner: { package: "@example/runner", manifestName: "runner", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "run", ...(model === undefined ? {} : { model: model.model, configurationDigest: model.configurationDigest }) },
    input: { kind: "inline", value: { prompt: "stage" } },
    grants: [],
    resources: { maxCostMicros: "1000", maxTokens: 200, maxComputeMs: 30_000, memoryBytes: 1024, resourceClass: "cpu.small" },
    ...(model === undefined ? {} : { model }),
    tools: [],
    broker: { attemptToken: "unset", audience: INSTALLATION },
  } as FactoryRunnerRequest;
}

async function clientSecrets(root: string, certs: Certificates, hostToken: string) {
  const paths = { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key"), serviceTokenPath: join(root, "token") };
  await writeFile(paths.caPath, certs.ca);
  await writeFile(paths.certificatePath, certs.clientCert);
  await writeFile(paths.privateKeyPath, certs.clientKey);
  // The host's own bearer token. It authenticates the HOST; the attempt token
  // in the body is what names the attempt.
  await writeFile(paths.serviceTokenPath, hostToken);
  return paths;
}

async function setup(options: { readonly model?: FactoryModelPin; readonly provider?: () => Promise<FactoryOneHopProvider>; readonly configuredAudience?: string } = {}) {
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

  const request = runnerRequest(attemptId, projectId, runId, Date.now() + 600_000, options.model);
  const authority = factoryRunnerRequestAuthority(request);
  // Admitted the way the dispatcher admits it, so the model half can read the
  // committed request back and the staging half fences on the same row.
  const journal = new FactoryExecutionJournal(db, async () => {});
  await journal.admit({ ...authority, request });

  const blobs = new FileBlobStore(join(root, "blobs"));
  const artifacts = new FactoryArtifacts(db, blobs, TENANT);
  const stores = { database: db, artifacts, blobs, journal };
  const broker = createFactoryGuestMaterialFrameBroker({ services: createFactoryGuestMaterialServices(stores) });
  const model = createFactoryGuestModelFrameBroker({ journal, workspace: new FactoryWorkspaceCheckpoints(stores), provider: options.provider ?? factoryUnpinnedModelProvider });

  const certs = await certificates(directories, TENANT);
  // The host's bearer-token key pair, and a token minted for the host.
  const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const hostPublicKey = hostKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const hostToken = (claims: Record<string, unknown> = {}, key = hostKeys.privateKey) => signedServiceToken(key, {
    sub: TENANT, iss: TOKEN_ISSUER, aud: FACTORY_GUEST_BROKER_AUDIENCE, exp: Math.floor(Date.now() / 1_000) + 600, scope: [FACTORY_GUEST_BROKER_SCOPE], ...claims,
  });
  // Which host holds the attempt's lease. The route asks; a test moves it.
  let lease: string | undefined = HOST;
  const service = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    handle: createFactoryGuestBrokerRouteHandler({
      hosts: { [TENANT]: HOST },
      tokens: async () => ({ issuer: TOKEN_ISSUER, audience: options.configuredAudience ?? FACTORY_GUEST_BROKER_AUDIENCE, publicKeys: { test: hostPublicKey } }),
      leaseHost: async () => lease,
      broker, model, jwtSecret: SECRET, installationId: INSTALLATION,
    }),
  });
  closing.push(async () => { service.stop(); });

  // The token a launch mints and the guest runs under, carried by the request
  // exactly as `FactoryRemoteAttemptRuntime` carries it.
  const token = await signFactoryAttemptToken(authority, SECRET, INSTALLATION, 600);
  const tokened = { ...request, broker: { ...request.broker, attemptToken: token } } as FactoryRunnerRequest;
  const paths = await clientSecrets(root, certs, hostToken());
  const setLease = (host: string | undefined) => { lease = host; };
  return { db, artifacts, blobs, journal, service, certs, paths, hostToken, hostPublicKey, setLease, request: tokened, authority, attemptId, projectId, runId, operationId: `${runId}:node-a:0:0` };
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

test("a payload that is neither a staging frame nor a model request never crosses, and is delegated or refused here", async () => {
  const fixture = await setup();
  const seen: unknown[] = [];
  const delegating = await createFactoryGuestBrokerClient({ baseUrl: fixture.service.url, tls: fixture.paths, serverName: "localhost", delegate: { invoke: async (_request: FactoryRunnerRequest, payload: unknown) => { seen.push(payload); return { accepted: true }; } } });
  expect(await delegating.invoke(fixture.request, { kind: "guest-model-report" })).toEqual({ accepted: true });
  expect(seen).toHaveLength(1);

  const alone = await createFactoryGuestBrokerClient({ baseUrl: fixture.service.url, tls: fixture.paths, serverName: "localhost" });
  await expect(alone.invoke(fixture.request, { kind: "guest-model-report" })).rejects.toThrow("has no other route");
}, 120_000);

test("a model request crosses the host boundary and is answered by the product's model broker, never by the host", async () => {
  const answered = answering("from the product");
  const fixture = await setup({ model: PIN, provider: async () => answered.provider });
  const seen: unknown[] = [];
  const host = await createFactoryGuestBrokerClient({ baseUrl: fixture.service.url, tls: fixture.paths, serverName: "localhost", delegate: { invoke: async (_request: FactoryRunnerRequest, payload: unknown) => { seen.push(payload); return null; } } });
  expect(await host.invoke(fixture.request, modelRequest(fixture.operationId))).toMatchObject({ status: "completed", operationId: fixture.operationId, text: "from the product", usage: { kind: "measured", inputTokens: 3, outputTokens: 2 } });
  // The delegate never saw it, and the provider was called once.
  expect(seen).toEqual([]);
  expect(answered.calls()).toBe(1);
  // The cost is on the attempt's journal, settled before the guest was told.
  expect(await fixture.journal.operations(fixture.authority)).toMatchObject([{ operationId: fixture.operationId, kind: "model", state: "completed" }]);
  // A repeat is a typed refusal that crossed back, not a transport error.
  expect(await host.invoke(fixture.request, modelRequest(fixture.operationId))).toMatchObject({ status: "refused", refusal: { code: "operation_settled" } });
}, 120_000);

test("a product that pins no provider refuses a model request by name, and the attempt with no pin may call none", async () => {
  const unpinnedProduct = await setup({ model: PIN });
  const host = await createFactoryGuestBrokerClient({ baseUrl: unpinnedProduct.service.url, tls: unpinnedProduct.paths, serverName: "localhost" });
  const refused = await host.invoke(unpinnedProduct.request, modelRequest(unpinnedProduct.operationId)) as { status: string; refusal: { code: string; message: string } };
  expect(refused).toMatchObject({ status: "refused", refusal: { code: "provider_unavailable" } });
  expect(refused.refusal.message).toStartWith(FACTORY_PROVIDER_NOT_CONFIGURED);

  const answered = answering("never");
  const unpinnedAttempt = await setup({ provider: async () => answered.provider });
  const other = await createFactoryGuestBrokerClient({ baseUrl: unpinnedAttempt.service.url, tls: unpinnedAttempt.paths, serverName: "localhost" });
  expect(await other.invoke(unpinnedAttempt.request, modelRequest(unpinnedAttempt.operationId))).toMatchObject({ status: "refused", refusal: { code: "model_pin_mismatch" } });
  expect(answered.calls()).toBe(0);
}, 120_000);

test("the route authenticates the host and the attempt separately, and refuses each alone", async () => {
  const fixture = await setup();
  const frame = { schemaVersion: "factory.guest-material-begin.v1", operationId: fixture.operationId, operationIndex: 0, objectName: "probe.bin", version: 1, mediaType: "application/octet-stream", totalBytes: 4, chunkCount: 1 };
  const token = fixture.request.broker.attemptToken;
  const url = `${fixture.service.url}${FACTORY_GUEST_BROKER_PATH}`;
  const call = (options: Parameters<typeof nodeHttpsRequest>[2]) => nodeHttpsRequest(url, fixture.certs, { token: fixture.hostToken(), ...options });

  // A foreign client certificate: the peer is not a host this product serves.
  const foreign = await call({ method: "POST", body: { attemptToken: token, payload: frame }, certificate: "foreign", headers: { "x-ezcorp-factory-version": "1" } });
  expect(foreign.status).toBe(403);

  // The right certificate with no bearer token, or one that does not hold: a
  // foreign key, another subject, no route scope, or expired.
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  // Also refused plainly, never as "token_audience_refused": a token naming another audience that does not
  // verify under it either (a foreign key), and a token whose payload is not JSON at all.
  for (const bearer of [undefined, fixture.hostToken({}, otherKey), fixture.hostToken({ sub: "tenant-b" }), fixture.hostToken({ scope: ["factory:orchestrate"] }), fixture.hostToken({ exp: 1 }), fixture.hostToken({ aud: "factory-pool" }, otherKey), "not.a-json-payload.token"]) {
    const refused = await call({ method: "POST", body: { attemptToken: token, payload: frame }, token: bearer, headers: { "x-ezcorp-factory-version": "1" } });
    expect(refused.status).toBe(401);
    expect(JSON.parse(refused.body.toString("utf8"))).toEqual({ error: "unauthorized" });
  }

  // A token the same host key and issuer signed for the pool: every claim right
  // but the audience. Refused with its own name, not taken as a host token.
  const poolToken = await call({ method: "POST", body: { attemptToken: token, payload: frame }, token: fixture.hostToken({ aud: "factory-pool" }), headers: { "x-ezcorp-factory-version": "1" } });
  expect({ status: poolToken.status, body: JSON.parse(poolToken.body.toString("utf8")) }).toEqual({ status: 401, body: { error: "token_audience_refused" } });

  // W01i: only a single string audience. A list that names this route beside
  // the pool would pass both routes; a list without this route is another
  // route's token; even a one-entry list is refused. Each is named, while a
  // list signed by a foreign key stays plain unauthorized.
  for (const [aud, key, error] of [
    [["factory-pool", FACTORY_GUEST_BROKER_AUDIENCE], undefined, "token_audience_refused"],
    [[FACTORY_GUEST_BROKER_AUDIENCE], undefined, "token_audience_refused"],
    [["factory-pool"], undefined, "token_audience_refused"],
    [["factory-pool", FACTORY_GUEST_BROKER_AUDIENCE], otherKey, "unauthorized"],
    [["factory-pool"], otherKey, "unauthorized"],
  ] as const) {
    const listed = await call({ method: "POST", body: { attemptToken: token, payload: frame }, token: fixture.hostToken({ aud: [...aud] }, key), headers: { "x-ezcorp-factory-version": "1" } });
    expect({ aud, status: listed.status, body: JSON.parse(listed.body.toString("utf8")) }).toEqual({ aud, status: 401, body: { error } });
  }

  // The right host, an attempt token that is not this installation's.
  const wrongToken = await call({ method: "POST", body: { attemptToken: "not-a-signed-attempt-token", payload: frame }, headers: { "x-ezcorp-factory-version": "1" } });
  expect(wrongToken.status).toBe(401);

  // A declared host, a valid attempt token, but another host holds the lease,
  // or no launch records one: refused by name before the broker.
  for (const holder of ["host-b", undefined]) {
    fixture.setLease(holder);
    const elsewhere = await call({ method: "POST", body: { attemptToken: token, payload: frame }, headers: { "x-ezcorp-factory-version": "1" } });
    expect(elsewhere.status).toBe(403);
    expect(JSON.parse(elsewhere.body.toString("utf8"))).toEqual({ error: "forbidden_host" });
  }
  fixture.setLease(HOST);

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

test("a route configured with the pool's audience still accepts only the guest-broker audience", async () => {
  // Defence in depth: the startup parser refuses such a document, and the route
  // does not trust its configuration for the audience either.
  const fixture = await setup({ configuredAudience: "factory-pool" });
  const frame = { schemaVersion: "factory.guest-material-begin.v1", operationId: fixture.operationId, operationIndex: 0, objectName: "probe.bin", version: 1, mediaType: "application/octet-stream", totalBytes: 4, chunkCount: 1 };
  const url = `${fixture.service.url}${FACTORY_GUEST_BROKER_PATH}`;
  const post = (bearer: string) => nodeHttpsRequest(url, fixture.certs, { method: "POST", token: bearer, body: { attemptToken: fixture.request.broker.attemptToken, payload: frame }, headers: { "x-ezcorp-factory-version": "1" } });
  const pool = await post(fixture.hostToken({ aud: "factory-pool" }));
  expect({ status: pool.status, body: JSON.parse(pool.body.toString("utf8")) }).toEqual({ status: 401, body: { error: "token_audience_refused" } });
  const route = await post(fixture.hostToken());
  expect(route.status).toBe(200);
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
  await expect(host.invoke(fixture.request, frame)).rejects.toThrow("answered a staging frame with a value its response contract refuses");
  // A staging answer to a model request is refused by the model contract.
  await expect(host.invoke(fixture.request, modelRequest(fixture.operationId))).rejects.toThrow("answered a model request with a value its response contract refuses");

  const garbled = startFactoryPrivateHttps({
    tls: { key: fixture.certs.serverKey, cert: fixture.certs.serverCert, ca: fixture.certs.ca },
    handle: async () => ({ status: 200, body: Buffer.from([0xff, 0xfe, 0x00]) }),
  });
  closing.push(async () => { garbled.stop(); });
  const other = await createFactoryGuestBrokerClient({ baseUrl: garbled.url, tls: fixture.paths, serverName: "localhost" });
  await expect(other.invoke(fixture.request, frame)).rejects.toThrow("answered a staging frame with something that is not JSON");
  await expect(other.invoke(fixture.request, modelRequest(fixture.operationId))).rejects.toThrow("answered a model request with something that is not JSON");
}, 120_000);

test("a staging frame keeps the ordinary request timeout while a model request waits on its own", async () => {
  const fixture = await setup();
  // A product that has received both requests and answers neither.
  let arrivals = 0;
  let bothArrived: () => void = () => {};
  const received = new Promise<void>((resolve) => { bothArrived = resolve; });
  const silent = startFactoryPrivateHttps({
    tls: { key: fixture.certs.serverKey, cert: fixture.certs.serverCert, ca: fixture.certs.ca },
    handle: () => { arrivals += 1; if (arrivals === 2) bothArrived(); return new Promise(() => {}); },
  });
  closing.push(async () => { silent.stop(); });
  // The ordinary timeout is the transport's `requestTimeoutMs` (30 s unless
  // set); the model request's is `modelRequestTimeoutMs` (five minutes unless set).
  const host = await createFactoryGuestBrokerClient({ baseUrl: silent.url, tls: fixture.paths, serverName: "localhost", requestTimeoutMs: 200, modelRequestTimeoutMs: 5_000 });
  let modelSettled = false;
  const model = host.invoke(fixture.request, modelRequest(fixture.operationId)).finally(() => { modelSettled = true; });
  const frame = { schemaVersion: "factory.guest-material-begin.v1", operationId: fixture.operationId, operationIndex: 0, objectName: "slow.bin", version: 1, mediaType: "application/octet-stream", totalBytes: 1, chunkCount: 1 };
  const staging = host.invoke(fixture.request, frame);
  await received;
  await expect(staging).rejects.toThrow("factory gateway request timed out");
  // The staging frame gave up on its own timeout; the model request is still waiting on its longer one.
  expect(modelSettled).toBe(false);
  await expect(model).rejects.toThrow("factory gateway request timed out");
  expect(FACTORY_GUEST_MODEL_REQUEST_TIMEOUT_MS).toBe(300_000);
}, 120_000);

test("a supervisor configured with a guest broker forwards staging frames and model requests, and refuses anything else by name", async () => {
  const answered = answering("through the supervisor");
  const fixture = await setup({ model: PIN, provider: async () => answered.provider });
  const { caPath, certificatePath, privateKeyPath, serviceTokenPath } = fixture.paths;
  // Exactly the section a supervisor document carries: per tenant, a base URL and paths.
  const host = await createFactoryConfiguredGuestBroker({ [TENANT]: { baseUrl: fixture.service.url, serviceTokenPath, tls: { caPath, certificatePath, privateKeyPath } } });
  const frame = { schemaVersion: "factory.guest-material-begin.v1", operationId: fixture.operationId, operationIndex: 0, objectName: "configured.bin", version: 1, mediaType: "application/octet-stream", totalBytes: 4, chunkCount: 1 };
  expect(await host.invoke(fixture.request, frame)).toMatchObject({ status: "begun", objectName: "configured.bin" });
  // A model request takes the same route and is answered by the product.
  expect(await host.invoke(fixture.request, modelRequest(fixture.operationId))).toMatchObject({ status: "completed", text: "through the supervisor" });
  // Anything else keeps the host's default answer rather than reaching a route
  // that would not know it.
  await expect(host.invoke(fixture.request, { kind: "guest-model-report" })).rejects.toMatchObject({ code: "factory_host_broker_unavailable" });
  // A section whose credential file is missing fails when the host composes,
  // before its listener binds, not on a guest's first frame.
  await expect(createFactoryConfiguredGuestBroker({ [TENANT]: { baseUrl: fixture.service.url, serviceTokenPath: `${serviceTokenPath}.missing`, tls: { caPath, certificatePath, privateKeyPath } } }))
    .rejects.toThrow();
}, 120_000);

/**
 * The product process binds the route itself, from its startup document.
 *
 * The files sit in a private directory under HOME because the private reader
 * refuses a world-writable ancestor such as /tmp.
 */
/** The launch record the dispatcher writes, naming the host that holds the lease. */
async function recordLaunch(fixture: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const receipt = JSON.stringify({ projectId: fixture.projectId, artifactDigest: "b".repeat(64) });
  await fixture.db.execute(sql`INSERT INTO factory_attempt_launches(attempt_id,tenant_id,project_id,run_id,request_digest,request_json,reservation_id,grant_revision,allocation_generation,holder_generation,allocation_token,host_id,package_receipt_digest,package_receipt_json,artifact_digest,worker_id,invocation_id,state)
    VALUES (${fixture.attemptId},${TENANT},${fixture.projectId},${fixture.runId},${"c".repeat(64)},'{}','reservation-a',1,1,1,'allocation-a',${HOST},${`sha256:${"d".repeat(64)}`},${receipt}::jsonb,${"b".repeat(64)},${factoryAttemptWorkerId(fixture.attemptId)},${factoryAttemptInvocationId(fixture.attemptId, 0, 1)},'launched')`);
}

async function composedRoute(fixture: Awaited<ReturnType<typeof setup>>, overrides: { readonly secret?: string; readonly missingKey?: boolean; readonly modelProvider?: FactoryOneHopProvider } = {}) {
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
  const tokenKey = join(root, "host-token.pem");
  await writeFile(tokenKey, fixture.hostPublicKey, { mode: 0o600 });
  await chmod(tokenKey, 0o600);
  const config = {
    installationId: INSTALLATION,
    hostLaunch: { attemptTokenSecretPath: files.secret },
    guestBroker: {
      hostname: "127.0.0.1", port, hosts: { [TENANT]: HOST },
      tls: { caPath: files.ca, certificatePath: files.cert, privateKeyPath: files.key },
      tokens: { issuer: TOKEN_ISSUER, audience: FACTORY_GUEST_BROKER_AUDIENCE, publicKeyPaths: { test: tokenKey } },
    },
    ...(overrides.modelProvider === undefined ? {} : { modelProvider: { provider: PIN.provider, model: PIN.model } }),
  } as unknown as FactoryStartupConfig;
  const reported: Array<{ role: string; error: unknown }> = [];
  const pinsAsked: unknown[] = [];
  const composed = await composeFactoryGuestBroker({
    database: fixture.db, config, blobs: fixture.blobs,
    application: { artifacts: fixture.artifacts, journal: fixture.journal },
    report: (role, error) => { reported.push({ role, error }); },
    ...(overrides.modelProvider === undefined ? {} : { modelProvider: async (pin) => { pinsAsked.push(pin); return overrides.modelProvider!; } }),
  });
  if (composed.listener) closing.push(async () => { composed.listener!.stop(); });
  return { composed, reported, secret, port, pinsAsked };
}

test("the product binds the guest-broker route from its startup document, and a host's frame reaches it", async () => {
  const fixture = await setup();
  const { composed, reported, secret } = await composedRoute(fixture);
  expect(composed.readiness).toEqual({ state: "bound" });
  expect(reported).toEqual([]);
  // The route reads the lease through the runtime's own launch reader.
  await recordLaunch(fixture);

  // The token verifies with the dispatcher's own secret file, not a copy.
  const token = await signFactoryAttemptToken(fixture.authority, secret, INSTALLATION, 600);
  const request = { ...fixture.request, broker: { ...fixture.request.broker, attemptToken: token } } as FactoryRunnerRequest;
  const { caPath, certificatePath, privateKeyPath, serviceTokenPath } = fixture.paths;
  const host = await createFactoryConfiguredGuestBroker({ [TENANT]: { baseUrl: composed.listener!.url, serviceTokenPath, tls: { caPath, certificatePath, privateKeyPath } } });
  const client = createFactoryGuestStaging({ call: async payload => host.invoke(request, payload), operationId: fixture.operationId, operationIndex: 0 });
  // Two chunks, so more than one frame crosses the listener the product bound.
  const bytes = new Uint8Array(40_000).map((_, index) => index % 251);
  const staged = await client.stageOutput("composed.bin", bytes);
  expect(staged.digest).toBe(`sha256:${sha256Hex(bytes)}`);

  // A token signed with any other secret is refused before the broker.
  const forged = { ...request, broker: { ...request.broker, attemptToken: await signFactoryAttemptToken(fixture.authority, `${secret}-other`, INSTALLATION, 600) } } as FactoryRunnerRequest;
  const probe = { schemaVersion: "factory.guest-material-begin.v1", operationId: fixture.operationId, operationIndex: 0, objectName: "forged.bin", version: 1, mediaType: "application/octet-stream", totalBytes: 1, chunkCount: 1 };
  await expect(host.invoke(forged, probe)).rejects.toMatchObject({ response: { statusCode: 401 } });

  // The same host and a valid token, after the lease moved to another host:
  // this host no longer holds the attempt, so it may not forward for it.
  await fixture.db.execute(sql`UPDATE factory_attempt_launches SET host_id='host-b' WHERE attempt_id=${fixture.attemptId}`);
  const moved = await host.invoke(request, probe).then(() => undefined, (error: unknown) => error as { response: { statusCode: number; body: Buffer } });
  expect(moved?.response.statusCode).toBe(403);
  expect(JSON.parse(moved!.response.body.toString("utf8"))).toEqual({ error: "forbidden_host" });
}, 120_000);

test("the composed route answers a model request with the installation's pinned provider, and names a missing pin", async () => {
  const answered = answering("composed");
  const fixture = await setup({ model: PIN });
  await recordLaunch(fixture);
  const pinned = await composedRoute(fixture, { modelProvider: answered.provider });
  const token = await signFactoryAttemptToken(fixture.authority, pinned.secret, INSTALLATION, 600);
  const request = { ...fixture.request, broker: { ...fixture.request.broker, attemptToken: token } } as FactoryRunnerRequest;
  const { caPath, certificatePath, privateKeyPath, serviceTokenPath } = fixture.paths;
  const host = await createFactoryConfiguredGuestBroker({ [TENANT]: { baseUrl: pinned.composed.listener!.url, serviceTokenPath, tls: { caPath, certificatePath, privateKeyPath } } });
  expect(await host.invoke(request, modelRequest(fixture.operationId))).toMatchObject({ status: "completed", text: "composed" });
  // The provider was asked for the installation's own pin, from its startup document.
  expect(pinned.pinsAsked).toEqual([{ provider: PIN.provider, model: PIN.model }]);

  // The same attempt against a route whose document pins no provider: the
  // next operation is refused by name, and the failure is on the journal.
  const unpinned = await composedRoute(fixture);
  const bare = await createFactoryConfiguredGuestBroker({ [TENANT]: { baseUrl: unpinned.composed.listener!.url, serviceTokenPath, tls: { caPath, certificatePath, privateKeyPath } } });
  const next = { ...(modelRequest(`${fixture.runId}:node-a:0:1`) as Record<string, JsonValue>), operationIndex: 1 } as JsonValue;
  const refused = await bare.invoke({ ...request, broker: { ...request.broker, attemptToken: await signFactoryAttemptToken(fixture.authority, unpinned.secret, INSTALLATION, 600) } }, next) as { refusal: { code: string; message: string } };
  expect(refused.refusal.code).toBe("provider_unavailable");
  expect(refused.refusal.message).toStartWith(FACTORY_PROVIDER_NOT_CONFIGURED);
  expect((await fixture.journal.operations(fixture.authority)).map(operation => operation.state)).toEqual(["completed", "failed"]);
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
