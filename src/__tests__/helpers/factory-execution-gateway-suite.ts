import type { TransactionalDb } from "../../db/migrations/types";
import { certificates, nodeHttpsRequest, rawTls, type Certificates } from "./factory-certificates";
import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { rm } from "node:fs/promises";
import { signJWT, signInstallationToken, verifyJWT } from "../../auth/jwt";
import { signFactoryServiceToken, verifyFactoryServiceToken, FACTORY_SERVICE_TOKEN_PREFIX } from "../../auth/factory-service-token";
import type { AuthUser } from "../../auth/types";
import type { FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { signFactoryAttemptToken, verifyFactoryAttemptToken } from "../../factory/attempt-token";
import { startFactoryExecutionGateway } from "../../factory/execution-gateway";

export function factoryExecutionGatewayConformance(create: () => Promise<{ db: TransactionalDb; close(): Promise<void> }>): void {
describe("C02 execution gateway", () => {
const databases: Array<{ close(): Promise<void> }> = [];
const servers: { stop(): void }[] = [];
const directories: string[] = [];

afterEach(async () => {
  servers.splice(0).forEach(server => { server.stop(); });
  await Promise.all(databases.splice(0).map(database => database.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});


function authority(overrides: Partial<FactoryAttemptAuthority> = {}): FactoryAttemptAuthority {
  return { attemptId: "attempt-1", tenantId: "tenant-a", projectId: "project-a", runId: "run-a", nodeInstanceId: "node-a", candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(Date.now() + 60_000), ...overrides };
}

function runnerRequest(attempt: FactoryAttemptAuthority, input: JsonValue = { prompt: "gateway" }): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: { attemptId: attempt.attemptId, tenantId: attempt.tenantId, projectId: attempt.projectId, runId: attempt.runId, nodeInstanceId: attempt.nodeInstanceId, candidateGeneration: attempt.candidateGeneration, attemptNumber: attempt.attemptNumber, grantRevision: attempt.grantRevision, reservationGeneration: attempt.reservationGeneration, executionEpoch: attempt.executionEpoch, cancellationEpoch: attempt.cancellationEpoch, deadlineAtMs: attempt.deadlineAt.getTime(), nextOperationIndex: 0 },
    runner: { package: "runner", version: "1", digest: `sha256:${"a".repeat(64)}`, export: "run" }, input: { kind: "inline", value: input }, grants: [], resources: {}, tools: [], broker: { attemptToken: "ephemeral-gateway-token", audience: "installation-a" },
  };
}

function signedAuthority(overrides: Partial<FactoryAttemptAuthority> = {}): FactoryAttemptAuthority {
  const attempt = authority(overrides);
  return { ...attempt, requestDigest: factoryRunnerRequestDigest(runnerRequest(attempt)) };
}

async function userShapedToken(attempt: FactoryAttemptAuthority): Promise<string> {
  return signJWT({ id: "factory", email: "factory@example.test", name: "Factory", role: "admin", ...attempt, deadlineAt: attempt.deadlineAt.getTime() } as AuthUser, "test-secret", 60, "installation-a");
}

async function token(attempt: FactoryAttemptAuthority): Promise<string> {
  return signFactoryAttemptToken(attempt, "test-secret", "installation-a");
}

async function call(url: string, certificates: Certificates, attempt: FactoryAttemptAuthority, options: { method?: string; path?: string; body?: unknown; certificate?: "client" | "foreign" | "none"; version?: string; contentType?: string; bearer?: string } = {}): Promise<{ status: number; body: unknown }> {
  const result = await nodeHttpsRequest(`${url}${options.path ?? `/internal/factory/v1/executions/${attempt.attemptId}`}`, certificates, {
    method: options.method ?? "PUT", body: options.body ?? runnerRequest(attempt), certificate: options.certificate,
    token: options.bearer ?? await token(attempt), headers: { "x-ezcorp-factory-version": options.version ?? "1", "content-type": options.contentType ?? "application/json" },
  });
  return { status: result.status, body: JSON.parse(result.body.toString("utf8")) };
}


test("native Bun mTLS gateway derives attempt authority from an installation token and tenant certificate", async () => {
  const database = await create();
  databases.push(database);
  const db = database.db;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('project-a', 'Project A', '/tmp/project-a')`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, 'tenant-a', 6)`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES ('tenant-a', 'project-a')`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('tenant-a', 'project-a', 'run-a', ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
  const certs = await certificates(directories);
  const journal = new FactoryExecutionJournal(db, async () => {});
  const authorized: FactoryAttemptAuthority[] = [];
  const server = startFactoryExecutionGateway({ journal, authorizeAttempt: async value => { authorized.push(value); }, jwtSecret: "test-secret", installationId: "installation-a", tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca } });
  servers.push(server);
  const attempt = signedAuthority();

  // A login credential must never acquire runner authority from extra claims.
  expect(await call(server.url, certs, attempt, { bearer: await userShapedToken(attempt) })).toMatchObject({ status: 401, body: { error: "unauthorized" } });
  expect(authorized).toHaveLength(0);

  const validToken = await token(attempt);
  const claims = JSON.parse(Buffer.from(validToken.split(".")[1]!, "base64url").toString("utf8"));
  const signed = (overrides: Record<string, unknown>) => signInstallationToken({ ...claims, ...overrides }, "test-secret", "installation-a");
  const now = Math.floor(Date.now() / 1_000);
  const serviceToken = await signFactoryServiceToken({ serviceAccountId: "service-a", projectId: "project-a", credentialId: "credential-a", revision: 1, scopes: ["write"], issuedAtMs: now * 1_000, expiresAtMs: (now + 60) * 1_000 }, "test-secret", "installation-a");
  const deniedTokens = [
    "", "not-a-token", serviceToken, serviceToken.slice(FACTORY_SERVICE_TOKEN_PREFIX.length),
    await signJWT({ id: "user-a", email: "user@example.test", name: "User", role: "admin" }, "test-secret", 60, "installation-a"),
    await signed({ tokenUse: "preview" }), await signed({ tokenUse: "factory-service" }),
    await signed({ role: "admin" }), await signed({ iat: now + 60, exp: now + 120 }),
    await signed({ iat: -1 }), await signed({ exp: now - 1 }), await signed({ exp: now + 3_601 }),
    await signed({ deadlineAt: -1 }), await signed({ deadlineAt: Number.MAX_SAFE_INTEGER }),
    await signed({ requestDigest: "bad" }), await signed({ requestDigest: 1 }),
    await signFactoryAttemptToken(attempt, "wrong-secret", "installation-a"),
    await signFactoryAttemptToken(attempt, "test-secret", "installation-b"),
  ];
  const { projectId: _projectId, ...withoutProject } = claims;
  deniedTokens.push(await signInstallationToken(withoutProject, "test-secret", "installation-a"));
  deniedTokens.push(await signInstallationToken({ ...withoutProject, extra: "project-a" }, "test-secret", "installation-a"));
  for (const field of ["attemptId", "tenantId", "projectId", "runId", "nodeInstanceId"]) {
    for (const value of [null, "", "x".repeat(513), "bad\0id"]) deniedTokens.push(await signed({ [field]: value }));
  }
  for (const field of ["candidateGeneration", "attemptNumber", "grantRevision", "reservationGeneration", "executionEpoch", "cancellationEpoch"]) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) deniedTokens.push(await signed({ [field]: value }));
  }
  for (const bearer of deniedTokens) expect(await call(server.url, certs, attempt, { bearer })).toMatchObject({ status: 401, body: { error: "unauthorized" } });
  expect(await call(server.url, certs, attempt, { path: "/internal/factory/v1/executions/other-attempt", bearer: validToken })).toMatchObject({ status: 401 });
  expect(await call(server.url, certs, attempt, { path: "/internal/factory/v1/other", bearer: validToken })).toMatchObject({ status: 401 });
  expect(authorized).toHaveLength(0);

  await expect(call(server.url, certs, attempt, { certificate: "none" })).rejects.toThrow();
  expect(await call(server.url, certs, attempt, { certificate: "foreign" })).toMatchObject({ status: 401, body: { error: "unauthorized" } });
  expect(await call(server.url, certs, attempt, { version: "2" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  expect(await call(server.url, certs, attempt, { contentType: "text/plain" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  const denied = signedAuthority({ attemptId: "denied" });
  const deniedServer = startFactoryExecutionGateway({ journal, authorizeAttempt: async () => { throw new Error("Factory grant is revoked."); }, jwtSecret: "test-secret", installationId: "installation-a", tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca } });
  servers.push(deniedServer);
  expect(await call(deniedServer.url, certs, denied)).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  await expect(journal.status(denied)).rejects.toThrow("unavailable");
  expect(await call(server.url, certs, attempt)).toMatchObject({ status: 201, body: { attemptId: "attempt-1", reused: false } });
  expect(authorized).toHaveLength(1);
  expect(await call(server.url, certs, attempt)).toMatchObject({ status: 200, body: { attemptId: "attempt-1", reused: true } });
  expect(await call(server.url, certs, attempt, { body: runnerRequest(attempt, { prompt: "other" }) })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  expect(await call(server.url, certs, attempt, { method: "GET" })).toMatchObject({ status: 200, body: { status: "admitted", journalCursor: -1 } });
  expect(await call(server.url, certs, { ...attempt, deadlineAt: new Date(Date.now() - 1) }, { method: "POST", path: "/internal/factory/v1/executions/attempt-1/cancel" })).toMatchObject({ status: 202, body: { accepted: true } });
  expect(await call(server.url, certs, attempt, { method: "DELETE" })).toMatchObject({ status: 405, body: { error: "method_not_allowed" } });
  const rawAttempt = signedAuthority({ attemptId: "raw-split" });
  const rawBody = JSON.stringify(runnerRequest(rawAttempt));
  const rawHeaders = `PUT /internal/factory/v1/executions/raw-split HTTP/1.1\r\nauthorization: Bearer ${await token(rawAttempt)}\r\nx-ezcorp-factory-version: 1\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(rawBody)}\r\n\r\n`;
  expect(await rawTls(server.url, certs, [rawHeaders, rawBody.slice(0, 3), rawBody.slice(3)])).toContain("HTTP/1.1 201 Created");
  const duplicate = `PUT /internal/factory/v1/executions/raw-duplicate HTTP/1.1\r\nauthorization: Bearer ignored\r\nauthorization: Bearer ignored\r\nx-ezcorp-factory-version: 1\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}`;
  expect(await rawTls(server.url, certs, [duplicate])).toContain("HTTP/1.1 400 Bad Request");
});


test("attempt tokens preserve captured authority and stay separate from user and public service credentials", async () => {
  const original = signedAuthority();
  const value = { ...original, deadlineAt: new Date(original.deadlineAt) };
  const pending = token(value);
  value.projectId = "mutated";
  value.deadlineAt.setTime(0);
  const bearer = await pending;
  expect(await verifyFactoryAttemptToken(bearer, "test-secret", "installation-a")).toEqual(original);
  expect(await verifyJWT(bearer, "test-secret", "installation-a")).toBeNull();
  expect(await verifyFactoryServiceToken(bearer, "test-secret", "installation-a")).toBeNull();
  expect(await verifyFactoryAttemptToken(bearer, "test-secret", "")).toBeNull();
  for (const lifetime of [0, -1, 1.5, 3_601, Infinity]) await expect(signFactoryAttemptToken(original, "test-secret", "installation-a", lifetime)).rejects.toThrow("lifetime");
  await expect(signFactoryAttemptToken(original, "test-secret", "")).rejects.toThrow("identity");
  await expect(signFactoryAttemptToken({ ...original, projectId: "" }, "test-secret", "installation-a")).rejects.toThrow("identity");
  await expect(signFactoryAttemptToken({ ...original, deadlineAt: new Date(NaN) }, "test-secret", "installation-a")).rejects.toThrow("identity");
});

});
}
