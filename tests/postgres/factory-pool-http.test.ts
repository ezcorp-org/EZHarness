import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGatewayTransport } from "@ezcorp/factory-transport";
import { certificates } from "../../src/__tests__/helpers/factory-certificates";
import { createPoolAdmissionClient, type PoolAdmissionClient } from "../../src/factory/pool/client";
import { PoolAdmissionService } from "../../src/factory/pool/service";
import { startBunPoolAdmissionHttps } from "../../src/factory/pool/service-server";
import { setupFactoryPoolPostgres } from "./helpers/factory-pool-database";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(subject: string, scopes: string[], expiresAt = Math.floor(Date.now() / 1_000) + 60): string {
  const input = `${encode({ alg: "RS256", kid: "test" })}.${encode({ sub: subject, iss: "factory-test", aud: "factory-pool", exp: expiresAt, scope: scopes })}`;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return `${input}.${signer.sign(keys.privateKey).toString("base64url")}`;
}

const directories: string[] = [];
let closeDatabase: () => Promise<void>;
let server: Awaited<ReturnType<typeof startBunPoolAdmissionHttps>>;
let client: PoolAdmissionClient;
let foreign: PoolAdmissionClient;
let mismatched: PoolAdmissionClient;
let expired: PoolAdmissionClient;
let raw: Awaited<ReturnType<typeof createGatewayTransport>>;
let database: SQL;
let service: PoolAdmissionService;

beforeAll(async () => {
  const fixture = await setupFactoryPoolPostgres();
  closeDatabase = fixture.close;
  database = fixture.client;
  service = new PoolAdmissionService(database);
  const certs = await certificates(directories);
  const directory = directories.at(-1)!;
  const ownTokenPath = join(directory, "tenant-a.token");
  const foreignTokenPath = join(directory, "tenant-b.token");
  const mismatchedTokenPath = join(directory, "mismatched.token");
  const expiredTokenPath = join(directory, "expired.token");
  await Promise.all([
    writeFile(ownTokenPath, token("tenant-a", ["pool:tenant:tenant-a", "pool:grant:tenant-a:run"]), { mode: 0o600 }),
    writeFile(foreignTokenPath, token("tenant-b", ["pool:tenant:tenant-b", "pool:grant:tenant-b:run"]), { mode: 0o600 }),
    writeFile(mismatchedTokenPath, token("tenant-b", ["pool:tenant:tenant-b"]), { mode: 0o600 }),
    writeFile(expiredTokenPath, token("tenant-a", ["pool:tenant:tenant-a"], 1), { mode: 0o600 }),
  ]);
  server = await startBunPoolAdmissionHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    identities: { tenants: { "tenant-a": { tenantId: "tenant-a", tokenSubject: "tenant-a" }, "tenant-b": { tenantId: "tenant-b", tokenSubject: "tenant-b" } }, supervisors: {} },
    tokens: { issuer: "factory-test", audience: "factory-pool", publicKeys: { test: keys.publicKey.export({ type: "pkcs1", format: "pem" }).toString() } },
    service,
  });
  const tls = { caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"), privateKeyPath: join(directory, "client.key"), serviceTokenPath: ownTokenPath };
  const foreignTls = { ...tls, certificatePath: join(directory, "foreign.pem"), privateKeyPath: join(directory, "foreign.key"), serviceTokenPath: foreignTokenPath };
  const connection = { baseUrl: server.url, serverName: "localhost", requestTimeoutMs: 5_000 } as const;
  client = await createPoolAdmissionClient({ ...connection, tenantId: "tenant-a", tls });
  foreign = await createPoolAdmissionClient({ ...connection, tenantId: "tenant-b", tls: foreignTls });
  mismatched = await createPoolAdmissionClient({ ...connection, tenantId: "tenant-a", tls: { ...tls, serviceTokenPath: mismatchedTokenPath } });
  expired = await createPoolAdmissionClient({ ...connection, tenantId: "tenant-a", tls: { ...tls, serviceTokenPath: expiredTokenPath } });
  raw = await createGatewayTransport({ ...connection, tls });
});

beforeEach(async () => {
  await database.unsafe("TRUNCATE factory_pool_admission_grants, factory_pool_requests");
  await database.unsafe("UPDATE factory_pool_resources SET allocated_units = 0 WHERE resource_class = 'cpu'");
  await service.ledger.configureCapacity("cpu", 4);
});

afterAll(async () => {
  server?.stop();
  await closeDatabase?.();
  await Promise.all(directories.map(path => rm(path, { recursive: true, force: true })));
});

function admission(reservationId: string) {
  return { reservationId, grantRevision: 7, grantScope: "tenant-a:run", resources: { cpu: 1 }, admissionDeadline: new Date(Date.now() + 60_000).toISOString(), priority: 1, readySequence: 2, nodeId: "node-a" };
}

test("actual Bun mTLS and PostgreSQL admission converges retries and preserves the token lease", async () => {
  const input = admission(`reservation/${randomUUID()}`);
  const raced = await Promise.all([client.request(input), client.request(input)]);
  expect(raced.every(value => value.reservationId === input.reservationId && (value.status === "queued" || value.status === "admitted"))).toBe(true);
  expect(raced.some(value => value.status === "queued")).toBe(true);
  const recovered = await client.request(input);
  expect(recovered.status).toBe("admitted");
  const lease = recovered.lease!;
  expect(lease).toMatchObject({ reservationId: input.reservationId, tenantId: "tenant-a", grantRevision: 7, allocationGeneration: 1, resources: input.resources });
  expect(lease.allocationToken.length).toBeGreaterThan(0);
  expect(lease.deadlineAt).toBeInstanceOf(Date);

  const current = await client.status(input.reservationId);
  expect(current).toMatchObject({ state: "held", reservationId: input.reservationId, tenantId: "tenant-a" });
  expect(Object.hasOwn(current!, "allocationToken")).toBe(false);

  const fence = { reservationId: input.reservationId, grantRevision: 7, allocationGeneration: lease.allocationGeneration, allocationToken: lease.allocationToken };
  expect((await client.acknowledgeStart(fence)).holderGeneration).toBe(1);
  expect((await client.renew(fence)).allocationToken).toBe(lease.allocationToken);
  expect((await client.cancel(input.reservationId, lease.allocationGeneration)).state).toBe("revoking");
  await expect(client.renew(fence)).rejects.toThrow("HTTP 409");
  expect(await client.status(`missing/${randomUUID()}`)).toBeUndefined();
});

test("actual ingress rejects foreign, mismatched, and expired identities", async () => {
  const input = admission(`owned-${randomUUID()}`);
  await client.request(input);
  await expect(foreign.status(input.reservationId)).rejects.toThrow("HTTP 403");
  await expect(mismatched.status(input.reservationId)).rejects.toThrow("HTTP 401");
  await expect(expired.status(input.reservationId)).rejects.toThrow("HTTP 401");
});

test("a malformed request cannot poison its reservation identity", async () => {
  const input = admission(`reusable-${randomUUID()}`);
  await expect(raw.request("POST", "/v1/pool/requests", { ...input, resources: { cpu: 0 } }, 16 * 1024)).rejects.toThrow("HTTP 400");
  const accepted = await client.request(input);
  expect(accepted).toMatchObject({ status: "queued", reservationId: input.reservationId });
  expect((await client.request(input)).lease?.allocationToken).toBeTruthy();

  const blocker = { ...admission(`blocker-${randomUUID()}`), resources: { cpu: 3 } };
  expect((await client.request(blocker)).status).toBe("queued");
  expect((await client.request(blocker)).status).toBe("admitted");
  const queued = admission(`queued-${randomUUID()}`);
  expect((await client.request(queued)).status).toBe("queued");
  expect(await client.status(queued.reservationId)).toMatchObject({ state: "queued", allocationGeneration: 1 });
  expect(await client.cancel(queued.reservationId, 1)).toMatchObject({ state: "settled", reason: "cancelled-before-admission" });
});

test("a tenant confirms a supervisor's stop over real mTLS, and never stands in for one", async () => {
  const input = admission(`stop/${randomUUID()}`);
  expect((await client.request(input)).reservationId).toBe(input.reservationId);
  const admitted = await client.request(input);
  expect(admitted.status).toBe("admitted");
  const lease = admitted.lease!;
  await client.acknowledgeStart({ reservationId: input.reservationId, grantRevision: 7, allocationGeneration: lease.allocationGeneration, allocationToken: lease.allocationToken });
  const stop = { reservationId: input.reservationId, holderGeneration: 1, hostId: "host-http" };

  // The supervisor has not confirmed yet, so the tenant's acknowledgement is
  // refused rather than releasing anything.
  await expect(client.confirmStopped(stop)).rejects.toThrow("HTTP 409");
  expect((await client.status(input.reservationId))?.state).toBe("running");

  // The supervisor's own confirmation is what releases the capacity.
  expect(await service.ledger.confirmStopped({ reservationId: input.reservationId, holderGeneration: 1, hostId: "host-http" })).toMatchObject({ state: "settled" });

  const acknowledged = await client.confirmStopped(stop);
  expect(acknowledged).toMatchObject({ reservationId: input.reservationId, tenantId: "tenant-a", state: "settled", holderGeneration: 1 });
  // A lost response is indistinguishable from a repeat, because the call writes
  // nothing at all: retrying returns the identical status.
  expect(await client.confirmStopped(stop)).toEqual(acknowledged);
  expect(await Promise.all([client.confirmStopped(stop), client.confirmStopped(stop)])).toEqual([acknowledged, acknowledged]);

  // A stale generation and another tenant's certificate are both refused.
  await expect(client.confirmStopped({ ...stop, holderGeneration: 2 })).rejects.toThrow("HTTP 409");
  await expect(foreign.confirmStopped(stop)).rejects.toThrow("HTTP 403");
  // A malformed body never reaches the ledger.
  await expect(client.confirmStopped({ ...stop, holderGeneration: 0 })).rejects.toThrow("malformed");
  await expect(raw.request("POST", `/v1/pool/requests/${encodeURIComponent(input.reservationId)}/confirm-stopped`, { holderGeneration: 1 })).rejects.toThrow("HTTP 400");
});
