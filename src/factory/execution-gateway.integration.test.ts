import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { signJWT } from "../auth/jwt";
import type { AuthUser } from "../auth/types";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "./executions";
import { startFactoryExecutionGateway } from "./execution-gateway";

const databases: PGlite[] = [];
const servers: { stop(): void }[] = [];
const directories: string[] = [];

afterEach(async () => {
  servers.splice(0).forEach(server => { server.stop(); });
  await Promise.all(databases.splice(0).map(database => database.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type Certificates = { ca: string; serverKey: string; serverCert: string; clientKey: string; clientCert: string; foreignKey: string; foreignCert: string };

async function command(args: string[]): Promise<void> {
  const child = Bun.spawn(["openssl", ...args], { stdout: "ignore", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
}

async function certificates(): Promise<Certificates> {
  const root = await mkdtemp(join(tmpdir(), "factory-gateway-"));
  directories.push(root);
  await command(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "ca.key"), "-out", join(root, "ca.pem"), "-days", "1", "-subj", "/CN=factory-test-ca"]);
  for (const [name, subject, extension] of [["server", "localhost", "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth"], ["client", "tenant-a", "extendedKeyUsage=clientAuth"], ["foreign", "tenant-b", "extendedKeyUsage=clientAuth"]] as const) {
    await command(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, `${name}.key`), "-out", join(root, `${name}.csr`), "-subj", `/CN=${subject}`]);
    await Bun.write(join(root, `${name}.ext`), extension);
    await command(["x509", "-req", "-in", join(root, `${name}.csr`), "-CA", join(root, "ca.pem"), "-CAkey", join(root, "ca.key"), "-CAcreateserial", "-out", join(root, `${name}.pem`), "-days", "1", "-extfile", join(root, `${name}.ext`)]);
  }
  const get = (name: string) => readFile(join(root, name), "utf8");
  return { ca: await get("ca.pem"), serverKey: await get("server.key"), serverCert: await get("server.pem"), clientKey: await get("client.key"), clientCert: await get("client.pem"), foreignKey: await get("foreign.key"), foreignCert: await get("foreign.pem") };
}

function authority(overrides: Partial<FactoryAttemptAuthority> = {}): FactoryAttemptAuthority {
  return { attemptId: "attempt-1", tenantId: "tenant-a", projectId: "project-a", runId: "run-a", nodeInstanceId: "node-a", candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6, deadlineAt: new Date(Date.now() + 60_000), ...overrides };
}

async function token(attempt: FactoryAttemptAuthority): Promise<string> {
  return signJWT({ id: "factory", email: "factory@example.test", name: "Factory", role: "admin", ...attempt, deadlineAt: attempt.deadlineAt.getTime() } as AuthUser, "test-secret", 60, "installation-a");
}

async function call(url: string, certificates: Certificates, attempt: FactoryAttemptAuthority, options: { method?: string; path?: string; body?: unknown; certificate?: "client" | "foreign" | "none"; version?: string; contentType?: string } = {}): Promise<{ status: number; body: unknown }> {
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  const certificate = options.certificate ?? "client";
  return new Promise((resolve, reject) => {
    const request = httpsRequest(`${url}${options.path ?? `/internal/factory/v1/executions/${attempt.attemptId}`}`, {
      method: options.method ?? "PUT", ca: certificates.ca, cert: certificate === "client" ? certificates.clientCert : certificate === "foreign" ? certificates.foreignCert : undefined, key: certificate === "client" ? certificates.clientKey : certificate === "foreign" ? certificates.foreignKey : undefined,
      servername: "localhost", rejectUnauthorized: true,
      headers: { authorization: `Bearer ${"not-a-token"}`, "x-ezcorp-factory-version": options.version ?? "1", "content-type": options.contentType ?? "application/json", "content-length": Buffer.byteLength(body) },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
    });
    request.on("error", reject);
    token(attempt).then(value => { request.setHeader("authorization", `Bearer ${value}`); request.end(body); }, reject);
  });
}

test("native Bun mTLS gateway derives attempt authority from an installation token and tenant certificate", async () => {
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  databases.push(database);
  await database.waitReady;
  const db = drizzle(database, { schema });
  await migrate(db);
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('project-a', 'Project A', '/tmp/project-a')`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, 'tenant-a', 6)`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES ('tenant-a', 'project-a')`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('tenant-a', 'project-a', 'run-a', ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
  const certs = await certificates();
  const server = startFactoryExecutionGateway({ journal: new FactoryExecutionJournal(db), jwtSecret: "test-secret", installationId: "installation-a", tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca } });
  servers.push(server);
  const attempt = authority();

  await expect(call(server.url, certs, attempt, { certificate: "none" })).rejects.toThrow();
  expect(await call(server.url, certs, attempt, { certificate: "foreign" })).toMatchObject({ status: 401, body: { error: "unauthorized" } });
  expect(await call(server.url, certs, attempt, { version: "2" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  expect(await call(server.url, certs, attempt, { contentType: "text/plain" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  expect(await call(server.url, certs, attempt, { body: { model: "test" } })).toMatchObject({ status: 201, body: { attemptId: "attempt-1", reused: false } });
  expect(await call(server.url, certs, attempt, { body: { model: "test" } })).toMatchObject({ status: 200, body: { attemptId: "attempt-1", reused: true } });
  expect(await call(server.url, certs, attempt, { method: "GET" })).toMatchObject({ status: 200, body: { status: "admitted", journalCursor: -1 } });
  expect(await call(server.url, certs, authority({ deadlineAt: new Date(Date.now() - 1) }), { method: "POST", path: "/internal/factory/v1/executions/attempt-1/cancel" })).toMatchObject({ status: 202, body: { accepted: true } });
  expect(await call(server.url, certs, attempt, { method: "DELETE" })).toMatchObject({ status: 405, body: { error: "method_not_allowed" } });
});
