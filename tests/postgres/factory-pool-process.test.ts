import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { certificates } from "../../src/__tests__/helpers/factory-certificates";
import { createPoolAdmissionClient } from "../../src/factory/pool/client";
import { readFactoryPoolReadiness } from "../../src/factory/pool/readiness";
import { setupFactoryPoolPostgres } from "./helpers/factory-pool-database";

const bun = "/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun";
const directories: string[] = [];
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
let closeDatabase: () => Promise<void>;
let configPath: string;
let config: Record<string, unknown>;
let root: string;
let tokenPath: string;
let clientTls: { caPath: string; certificatePath: string; privateKeyPath: string; serviceTokenPath: string };

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(subject = "tenant-a", scopes = ["pool:tenant:tenant-a", "pool:grant:tenant-a:factory"]): string {
  const input = `${encode({ alg: "RS256", kid: "test" })}.${encode({ sub: subject, iss: "factory-test", aud: "factory-pool", exp: Math.floor(Date.now() / 1_000) + 60, scope: scopes })}`;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return `${input}.${signer.sign(keys.privateKey).toString("base64url")}`;
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port; server.stop(true); return port;
}

async function privateCopy(from: string, to: string): Promise<void> { await copyFile(from, to); await chmod(to, 0o600); }

beforeAll(async () => {
  const database = await setupFactoryPoolPostgres(); closeDatabase = database.close;
  await certificates(directories); const certificateRoot = directories.at(-1)!;
  root = await mkdtemp(join(process.env.HOME!, ".factory-pool-process-pg-")); directories.push(root);
  for (const name of ["server.key", "server.pem", "client.key", "client.pem", "foreign.key", "foreign.pem", "ca.pem"]) await privateCopy(join(certificateRoot, name), join(root, name));
  const publicKeyPath = join(root, "pool-token.pem"); tokenPath = join(root, "tenant.token");
  await Promise.all([
    writeFile(join(root, "database.json"), JSON.stringify({ databaseUrl: database.databaseUrl }), { mode: 0o600 }),
    writeFile(publicKeyPath, keys.publicKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 }),
    writeFile(tokenPath, token(), { mode: 0o600 }),
  ]);
  const databaseUrl = new URL(database.databaseUrl);
  configPath = join(root, "pool.json");
  config = {
    schemaVersion: "factory.pool-process.v1", poolId: "pool-process", hostname: "127.0.0.1", port: freePort(),
    database: { credentialsPath: join(root, "database.json"), expectedDatabase: decodeURIComponent(databaseUrl.pathname.slice(1)), expectedRole: decodeURIComponent(databaseUrl.username) },
    tls: { privateKeyPath: join(root, "server.key"), certificatePath: join(root, "server.pem"), caPath: join(root, "ca.pem") },
    tokens: { issuer: "factory-test", audience: "factory-pool", publicKeyPaths: { test: publicKeyPath } },
    identities: { tenants: { "tenant-a": { tenantId: "tenant-a", tokenSubject: "tenant-a" } }, supervisors: {} },
    resources: { capacities: { cpu: 2 }, gpuHosts: [] }, readinessFilePath: join(root, "readiness.json"), readinessHeartbeatMs: 1_000,
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  clientTls = { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key"), serviceTokenPath: tokenPath };
});

afterAll(async () => { await closeDatabase?.(); await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

async function start(path = configPath) {
  const child = Bun.spawn([bun, "src/factory/pool/process.ts", path], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  return child;
}

async function waitReady(child: ReturnType<typeof start> extends Promise<infer P> ? P : never): Promise<void> {
  const options = { poolId: "pool-process", readinessFilePath: config.readinessFilePath as string, readinessHeartbeatMs: 1_000 };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await Promise.race([child.exited.then(() => true), Bun.sleep(25).then(() => false)])) throw new Error(`pool process exited before readiness: ${await new Response(child.stderr).text()}`);
    try { expect((await readFactoryPoolReadiness(options)).lifecycle).toBe("ready"); return; } catch { await Bun.sleep(25); }
  }
  throw new Error("pool process readiness timed out");
}

test("a fresh Bun process serves exact PostgreSQL admission retries and shuts down truthfully", async () => {
  const child = await start(); await waitReady(child);
  const client = await createPoolAdmissionClient({ baseUrl: `https://127.0.0.1:${config.port}`, serverName: "localhost", requestTimeoutMs: 5_000, tenantId: "tenant-a", tls: clientTls });
  const request = { reservationId: `process-${randomUUID()}`, grantRevision: 1, grantScope: "tenant-a:factory", resources: { cpu: 1 }, admissionDeadline: new Date(Date.now() + 60_000).toISOString() };
  expect(await client.request(request)).toMatchObject({ status: "queued", reservationId: request.reservationId });
  const admitted = await client.request(request);
  expect(admitted).toMatchObject({ status: "admitted", reservationId: request.reservationId, lease: { tenantId: "tenant-a", grantRevision: 1, allocationGeneration: 1, resources: { cpu: 1 } } });
  expect(admitted.lease?.allocationToken).toBeTruthy();
  expect(await client.status(request.reservationId)).toMatchObject({ state: "held", tenantId: "tenant-a" });

  await writeFile(tokenPath, token("tenant-b", ["pool:tenant:tenant-b"]), { mode: 0o600 });
  const invalid = await createPoolAdmissionClient({ baseUrl: `https://127.0.0.1:${config.port}`, serverName: "localhost", requestTimeoutMs: 5_000, tenantId: "tenant-a", tls: clientTls });
  await expect(invalid.status(request.reservationId)).rejects.toThrow("HTTP 401");
  await writeFile(tokenPath, token(), { mode: 0o600 });

  child.kill("SIGTERM"); expect(await child.exited).toBe(0);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(`${stdout}${stderr}`).not.toContain("private-secret");
  expect(JSON.parse(await readFile(config.readinessFilePath as string, "utf8"))).toMatchObject({ lifecycle: "stopped", databaseReady: false, schemaReady: false, listenerReady: false });
});

test("restart rejects a resource removal and bad private certificate without binding", async () => {
  const changedPath = join(root, "changed.json");
  await writeFile(changedPath, JSON.stringify({ ...config, port: freePort(), resources: { capacities: { memory: 2 }, gpuHosts: [] } }), { mode: 0o600 });
  const changed = await start(changedPath); expect(await changed.exited).toBe(1);
  expect(await new Response(changed.stderr).text()).not.toContain((config.database as { credentialsPath: string }).credentialsPath);
  expect(JSON.parse(await readFile(config.readinessFilePath as string, "utf8"))).toMatchObject({ lifecycle: "degraded", errorCode: "schema_unavailable" });

  const badCertificatePath = join(root, "bad-certificate.json");
  await writeFile(badCertificatePath, JSON.stringify({ ...config, port: freePort(), tls: { ...(config.tls as object), certificatePath: join(root, "foreign.pem") } }), { mode: 0o600 });
  const badCertificate = await start(badCertificatePath); expect(await badCertificate.exited).toBe(1);
  expect(JSON.parse(await readFile(config.readinessFilePath as string, "utf8"))).toMatchObject({ lifecycle: "degraded", errorCode: "configuration_unavailable" });

  const malformedPath = join(root, "malformed.json");
  await writeFile(malformedPath, JSON.stringify({ ...config, unexpected: true }), { mode: 0o600 });
  const malformed = await start(malformedPath); expect(await malformed.exited).toBe(1);
  expect(await new Response(malformed.stderr).text()).not.toContain("databaseUrl");
});

test("the pool identity row is keyed by pool id: an old singleton row is upgraded in place, a rerun is idempotent, and a database of another pool is refused", async () => {
  const other = await setupFactoryPoolPostgres();
  try {
    // The earlier shape bound the pool database to one installation.
    await other.client.unsafe("CREATE TABLE factory_pool_identity(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton), installation_id text NOT NULL, pool_id text NOT NULL)");
    await other.client.unsafe("INSERT INTO factory_pool_identity(singleton,installation_id,pool_id) VALUES(TRUE,'installation-old','pool-process')");
    const otherUrl = new URL(other.databaseUrl);
    await writeFile(join(root, "other-database.json"), JSON.stringify({ databaseUrl: other.databaseUrl }), { mode: 0o600 });
    const upgradedPath = join(root, "upgraded.json");
    const upgraded = { ...config, port: freePort(), readinessFilePath: join(root, "upgraded-readiness.json"), database: { credentialsPath: join(root, "other-database.json"), expectedDatabase: decodeURIComponent(otherUrl.pathname.slice(1)), expectedRole: decodeURIComponent(otherUrl.username) } };
    await writeFile(upgradedPath, JSON.stringify(upgraded), { mode: 0o600 });
    for (let run = 0; run < 2; run += 1) {
      const child = await start(upgradedPath);
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (!ready && Date.now() < deadline) {
        ready = await readFactoryPoolReadiness({ poolId: "pool-process", readinessFilePath: upgraded.readinessFilePath, readinessHeartbeatMs: 1_000 }).then(() => true, () => false);
        if (!ready) await Bun.sleep(50);
      }
      expect(ready).toBe(true);
      child.kill("SIGTERM"); expect(await child.exited).toBe(0);
      await rm(upgraded.readinessFilePath, { force: true });
    }
    expect((await other.client.unsafe("SELECT column_name FROM information_schema.columns WHERE table_name = 'factory_pool_identity' ORDER BY column_name")).map((row: { column_name: string }) => row.column_name)).toEqual(["pool_id"]);
    expect([...await other.client.unsafe("SELECT pool_id FROM factory_pool_identity")]).toEqual([{ pool_id: "pool-process" }]);
    expect((await other.client.unsafe("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'factory_pool_identity'::regclass AND contype = 'p'"))[0]).toEqual({ n: 1 });

    // The same database named by another pool is refused before it binds.
    const foreignPath = join(root, "foreign-pool.json");
    await writeFile(foreignPath, JSON.stringify({ ...upgraded, poolId: "pool-other", port: freePort() }), { mode: 0o600 });
    const foreign = await start(foreignPath); expect(await foreign.exited).toBe(1);
    expect(JSON.parse(await readFile(upgraded.readinessFilePath, "utf8"))).toMatchObject({ poolId: "pool-other", lifecycle: "degraded" });
  } finally { await other.close(); }
});
