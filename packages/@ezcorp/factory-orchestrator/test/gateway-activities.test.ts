import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { after, before, describe, it } from "node:test";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createGatewayFactoryActivities, type GatewayTlsSecretPaths } from "../src/gateway-activities.ts";

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
let directory = "";
let origin = "";
let port = 0;
let server: Server;
let mode = "normal";
let expectedClientCn = "factory-orchestrator";
let expectedToken = "gateway-token";
let paths: GatewayTlsSecretPaths;
const calls = [];
const definitionDigest = sha256("compiled-definition");
const definitionBody = Buffer.from(JSON.stringify({ digest: definitionDigest, partitions: [] }));
const definitionPage = { index: 0, objectId: "definition-page", digest: sha256(definitionBody), encodedBytes: definitionBody.byteLength };
const manifestBody = Buffer.from(JSON.stringify({ schemaVersion: "factory.manifest-page.v1", definitionDigest, definitionEncodedBytes: definitionBody.byteLength, pages: [definitionPage] }));
const manifest = { objectId: "manifest-page", digest: sha256(manifestBody), encodedBytes: manifestBody.byteLength };
const source = { definitionDigest, definitionEncodedBytes: definitionBody.byteLength, manifest };
const executionManifestBody = Buffer.from(JSON.stringify({ schemaVersion: "factory.execution-manifest.v1", factoryDigest: definitionDigest, inputPorts: {}, outputPorts: {}, bounds: { runDeadlineMs: 10, maxExpandedNodes: 10, maxScopeDepth: 2 }, outputs: {} }));
const executionManifest = { objectId: "execution-manifest", digest: sha256(executionManifestBody), encodedBytes: executionManifestBody.byteLength };
const partitionBody = Buffer.from(JSON.stringify({ schemaVersion: "factory.partition.v1", factoryDigest: definitionDigest, id: "partition-0", nodeIds: [], dependsOn: [], inbound: [], outbound: [], nodes: [] }));
const partition = { objectId: "partition-0", partitionId: "partition-0", digest: sha256(partitionBody), encodedBytes: partitionBody.byteLength };
const transitionPage = { index: 0, objectId: "transition-page", digest: sha256("page"), encodedBytes: 4 };
const finalizedTransition = { manifest: { objectId: "transition-manifest", digest: sha256("manifest"), encodedBytes: 128 }, eventHash: sha256("event") };

function openssl(...args) {
  execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
}

async function createPki() {
  directory = await mkdtemp(join(tmpdir(), "factory-mtls-"));
  await writeFile(join(directory, "server.ext"), "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n");
  await writeFile(join(directory, "client.ext"), "extendedKeyUsage=clientAuth\n");
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=Factory Test CA", "-days", "1");
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost");
  openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "server.ext");
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/CN=factory-orchestrator");
  openssl("x509", "-req", "-in", "client.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.pem", "-days", "1", "-extfile", "client.ext");
  await copyFile(join(directory, "client.key"), join(directory, "client-original.key"));
  await copyFile(join(directory, "client.pem"), join(directory, "client-original.pem"));
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client-rotated.key", "-out", "client-rotated.csr", "-subj", "/CN=factory-orchestrator-rotated");
  openssl("x509", "-req", "-in", "client-rotated.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client-rotated.pem", "-days", "1", "-extfile", "client.ext");
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "other-ca.key", "-out", "other-ca.pem", "-subj", "/CN=Other CA", "-days", "1");
  await writeFile(join(directory, "token"), "gateway-token\n", { mode: 0o600 });
  await writeFile(join(directory, "empty-token"), " \n", { mode: 0o600 });
  await writeFile(join(directory, "empty-cert"), "", { mode: 0o600 });
  paths = {
    caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"),
    privateKeyPath: join(directory, "client.key"), serviceTokenPath: join(directory, "token"),
  };
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

before(async () => {
  await createPki();
  server = createServer({
    key: await readFile(join(directory, "server.key")), cert: await readFile(join(directory, "server.pem")),
    ca: await readFile(join(directory, "ca.pem")), requestCert: true, rejectUnauthorized: true,
  }, async (request, response) => {
    const body = await readRequest(request);
    calls.push({ method: request.method, path: request.url, authorization: request.headers.authorization, version: request.headers["x-ezcorp-factory-version"], body });
    if (mode === "hang") return;
    if (mode === "http-error") { response.writeHead(503).end("unavailable"); return; }
    if (mode === "large") { response.writeHead(200).end("x".repeat(33 * 1024)); return; }
    if (mode === "invalid-json") { response.writeHead(200).end("not-json"); return; }
    const peer = (request.socket as TLSSocket).getPeerCertificate();
    if (peer.subject?.CN !== expectedClientCn) { response.writeHead(403).end(); return; }
    if (request.headers.authorization !== `Bearer ${expectedToken}`) { response.writeHead(401).end(); return; }
    if (request.url === "/internal/factory/v1/definitions/resolve") response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mode === "wrong-resolve" ? { ...source, definitionDigest: sha256("wrong") } : source));
    else if (request.url === "/internal/factory/v1/definitions/manifest") response.writeHead(200, { "content-type": "application/json" }).end(manifestBody);
    else if (request.url === "/internal/factory/v1/definitions/page") response.writeHead(200, { "content-type": "application/json" }).end(definitionBody);
    else if (request.url === "/internal/factory/v1/definitions/execution-manifest") response.writeHead(200, { "content-type": "application/json" }).end(executionManifestBody);
    else if (request.url === "/internal/factory/v1/definitions/partition") response.writeHead(200, { "content-type": "application/json" }).end(partitionBody);
    else if (request.url === "/internal/factory/v1/transitions/1/pages/0") response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mode === "wrong-transition-page" ? { ...transitionPage, index: 1 } : transitionPage));
    else if (request.url === "/internal/factory/v1/transitions/1/finalize") response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mode === "wrong-transition-finalize" ? { ...finalizedTransition, eventHash: "wrong" } : finalizedTransition));
    else if (request.url === "/internal/factory/v1/transitions") response.writeHead(204).end();
    else if (request.url?.includes("/cancel")) response.writeHead(204).end();
    else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ kind: "admission-result", id: "event", atMs: 1, nodeId: "node", commandId: "command", candidateGeneration: 0, granted: true }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
  origin = `https://localhost:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

const identity = { tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "build" };
const transition = { ...identity, sourceSequence: 1, eventId: "start", eventHash: finalizedTransition.eventHash, artifactManifest: finalizedTransition.manifest };
const activity = (environment, fn, value) => environment.run(fn, value);

describe("authenticated factory gateway activities", () => {
  it("uses verified mutual TLS, scoped routes, and immutable page digests", async () => {
    mode = "normal";
    expectedClientCn = "factory-orchestrator";
    expectedToken = "gateway-token";
    calls.length = 0;
    const activities = await createGatewayFactoryActivities({ baseUrl: origin, tls: paths, requestTimeoutMs: 1_000 });
    const environment = new MockActivityEnvironment();
    assert.deepEqual(await activity(environment, activities.resolveFactory, { ...identity, factory: { id: "child", version: "1", digest: definitionDigest } }), source);
    assert.deepEqual(await activity(environment, activities.loadManifestPage, { ...identity, definition: source, page: manifest }), { ...JSON.parse(manifestBody), self: manifest });
    assert.deepEqual(await activity(environment, activities.loadDefinitionPage, { ...identity, definitionDigest, page: definitionPage }), { index: 0, objectId: definitionPage.objectId, digest: definitionPage.digest, content: definitionBody.toString() });
    assert.deepEqual(await activity(environment, activities.loadExecutionManifest, { ...identity, definitionDigest, manifest: executionManifest }), JSON.parse(executionManifestBody));
    assert.deepEqual(await activity(environment, activities.loadPartitionArtifact, { ...identity, definitionDigest, partition }), JSON.parse(partitionBody));
    assert.deepEqual(await activity(environment, activities.stageTransitionPage, { ...identity, sourceSequence: 1, index: 0, content: "page", encodedBytes: 4 }), transitionPage);
    assert.deepEqual(await activity(environment, activities.finalizeTransitionArtifact, { ...identity, sourceSequence: 1, encodedBytes: 4, eventId: "start", pages: [transitionPage] }), finalizedTransition);
    assert.equal(await activity(environment, activities.recordTransition, transition), undefined);
    const admission = { ...identity, command: { kind: "request-admission", id: "admit", nodeId: "node", candidateGeneration: 0, deadlineAtMs: 10 } };
    assert.equal((await activity(environment, activities.executeCommand, admission)).kind, "admission-result");
    const dispatch = { ...identity, command: { kind: "dispatch-node", id: "dispatch", nodeId: "node", candidateGeneration: 0, attempt: 1, input: {}, deadlineAtMs: 10, cancellationEpoch: 0 } };
    assert.equal((await activity(environment, activities.executeCommand, dispatch)).kind, "admission-result");
    const cancel = { ...identity, command: { kind: "cancel-node", id: "cancel", nodeId: "node", candidateGeneration: 0, attempt: 1, attemptCommandId: "dispatch", cancellationEpoch: 1 } };
    assert.equal(await activity(environment, activities.executeCommand, cancel), null);
    assert.deepEqual(calls.map((call) => [call.method, call.path]), [
      ["POST", "/internal/factory/v1/definitions/resolve"], ["POST", "/internal/factory/v1/definitions/manifest"],
      ["POST", "/internal/factory/v1/definitions/page"], ["POST", "/internal/factory/v1/definitions/execution-manifest"],
      ["POST", "/internal/factory/v1/definitions/partition"], ["PUT", "/internal/factory/v1/transitions/1/pages/0"],
      ["POST", "/internal/factory/v1/transitions/1/finalize"], ["POST", "/internal/factory/v1/transitions"],
      ["POST", "/internal/factory/v1/commands/admit"], ["PUT", "/internal/factory/v1/executions/dispatch"],
      ["POST", "/internal/factory/v1/executions/dispatch/cancel"],
    ]);
    assert.ok(calls.every((call) => call.authorization === "Bearer gateway-token" && call.version === "1"));
  });

  it("reloads the service token and client identity after credential rotation", async () => {
    mode = "normal";
    expectedClientCn = "factory-orchestrator";
    expectedToken = "gateway-token";
    const activities = await createGatewayFactoryActivities({ baseUrl: origin, tls: paths, requestTimeoutMs: 1_000 });
    const environment = new MockActivityEnvironment();
    await activity(environment, activities.recordTransition, transition);
    try {
      await copyFile(join(directory, "client-rotated.key"), paths.privateKeyPath);
      await copyFile(join(directory, "client-rotated.pem"), paths.certificatePath);
      await writeFile(paths.serviceTokenPath, "gateway-token-rotated\n", { mode: 0o600 });
      expectedClientCn = "factory-orchestrator-rotated";
      expectedToken = "gateway-token-rotated";
      await activity(environment, activities.recordTransition, transition);
    } finally {
      await copyFile(join(directory, "client-original.key"), paths.privateKeyPath);
      await copyFile(join(directory, "client-original.pem"), paths.certificatePath);
      await writeFile(paths.serviceTokenPath, "gateway-token\n", { mode: 0o600 });
      expectedClientCn = "factory-orchestrator";
      expectedToken = "gateway-token";
    }
  });

  it("rejects no client certificate, an untrusted CA, and a hostname mismatch", async () => {
    mode = "normal";
    const environment = new MockActivityEnvironment();
    const noCertificate = await createGatewayFactoryActivities({ baseUrl: origin, tls: { ...paths, certificatePath: join(directory, "empty-cert") } });
    await assert.rejects(activity(environment, noCertificate.recordTransition, transition));
    const wrongCa = await createGatewayFactoryActivities({ baseUrl: origin, tls: { ...paths, caPath: join(directory, "other-ca.pem") } });
    await assert.rejects(activity(environment, wrongCa.recordTransition, transition));
    const wrongHost = await createGatewayFactoryActivities({ baseUrl: `https://127.0.0.1:${port}`, tls: paths });
    await assert.rejects(activity(environment, wrongHost.recordTransition, transition), /IP|altname|certificate/i);
  });

  it("fails closed on bad configuration, HTTP, JSON, digest, size, timeout, and cancellation", async () => {
    await assert.rejects(createGatewayFactoryActivities({ baseUrl: "http://localhost", tls: paths }), /private HTTPS/);
    await assert.rejects(createGatewayFactoryActivities({ baseUrl: `${origin}?secret=bad`, tls: paths }), /private HTTPS/);
    await assert.rejects(createGatewayFactoryActivities({ baseUrl: origin, tls: { ...paths, serviceTokenPath: join(directory, "empty-token") } }), /token is empty/);
    const activities = await createGatewayFactoryActivities({ baseUrl: origin, tls: paths, requestTimeoutMs: 20, heartbeatIntervalMs: 5 });

    mode = "http-error";
    await assert.rejects(activity(new MockActivityEnvironment(), activities.recordTransition, transition), /HTTP 503/);
    mode = "invalid-json";
    await assert.rejects(activity(new MockActivityEnvironment(), activities.resolveFactory, { ...identity, factory: { id: "child", version: "1", digest: definitionDigest } }), /invalid JSON/);
    mode = "wrong-resolve";
    await assert.rejects(activity(new MockActivityEnvironment(), activities.resolveFactory, { ...identity, factory: { id: "child", version: "1", digest: definitionDigest } }), /pinned child/);
    mode = "normal";
    await assert.rejects(activity(new MockActivityEnvironment(), activities.loadDefinitionPage, { ...identity, definitionDigest, page: { ...definitionPage, digest: sha256("wrong") } }), /immutable reference/);
    await assert.rejects(activity(new MockActivityEnvironment(), activities.loadExecutionManifest, { ...identity, definitionDigest, manifest: { ...executionManifest, digest: sha256("wrong") } }), /immutable reference/);
    await assert.rejects(activity(new MockActivityEnvironment(), activities.loadPartitionArtifact, { ...identity, definitionDigest, partition: { ...partition, digest: sha256("wrong") } }), /immutable reference/);
    mode = "wrong-transition-page";
    await assert.rejects(activity(new MockActivityEnvironment(), activities.stageTransitionPage, { ...identity, sourceSequence: 1, index: 0, content: "page", encodedBytes: 4 }), /mismatched/);
    mode = "wrong-transition-finalize";
    await assert.rejects(activity(new MockActivityEnvironment(), activities.finalizeTransitionArtifact, { ...identity, sourceSequence: 1, encodedBytes: 4, eventId: "start", pages: [transitionPage] }), /event digest/);
    mode = "large";
    await assert.rejects(activity(new MockActivityEnvironment(), activities.loadDefinitionPage, { ...identity, definitionDigest, page: definitionPage }), /response exceeds/);
    mode = "normal";
    await assert.rejects(activity(new MockActivityEnvironment(), activities.recordTransition, { ...transition, artifactManifest: { ...transition.artifactManifest, objectId: "x".repeat(70_000) } }), /request exceeds/);
    mode = "hang";
    await assert.rejects(activity(new MockActivityEnvironment(), activities.recordTransition, transition), /timed out/);
    const cancelled = new MockActivityEnvironment();
    const pending = activity(cancelled, activities.recordTransition, transition);
    cancelled.cancel();
    await assert.rejects(pending, /abort|cancel/i);
    mode = "normal";
  });
});
