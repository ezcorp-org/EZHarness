import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { PoolAdmissionService, type PoolPrincipal } from "../../src/factory/pool/service";

const url = process.env.FACTORY_TEST_POSTGRES_URL;
if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL pool-service conformance.");
let admin: SQL; let client: SQL; let database: string; let service: PoolAdmissionService;
const tenantOne: PoolPrincipal = { kind: "tenant", tenantId: "tenant-01", subject: "tenant-one", scopes: ["pool:tenant:tenant-01", "pool:grant:tenant-01:grant-a"] };
const tenantTwo: PoolPrincipal = { kind: "tenant", tenantId: "tenant-02", subject: "tenant-two", scopes: ["pool:tenant:tenant-02", "pool:grant:tenant-02:grant-a"] };
const supervisor: PoolPrincipal = { kind: "supervisor", supervisorId: "gpu-supervisor-a", subject: "supervisor-a", hostIds: ["gpu-a"], scopes: ["pool:supervisor:gpu-supervisor-a"] };
const request = (reservationId: string, resources = { cpu: 1 }) => ({ reservationId, grantRevision: 1, grantScope: "tenant-01:grant-a", resources, admissionDeadline: new Date(Date.now() + 60_000).toISOString() });

beforeAll(async () => {
  admin = new SQL(url!, { max: 1 }); database = `factory_pool_service_${randomUUID().replaceAll("-", "")}`; await admin.unsafe(`CREATE DATABASE "${database}"`);
  const isolated = new URL(url!); isolated.pathname = `/${database}`; client = new SQL(isolated.toString(), { max: 4 }); service = new PoolAdmissionService(client); await service.setup(); await service.ledger.configureCapacity("cpu", 2); await service.ledger.registerGpuHost({ hostId: "gpu-a" });

});
afterAll(async () => { await client?.close(); if (database) await admin?.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`); await admin?.close(); });

test("binds requests, reads, lease actions, and cancel generation to the authenticated tenant", async () => {
  await service.request(tenantOne, request("cpu-lease"));
  await expect(service.status(tenantTwo, "cpu-lease")).rejects.toThrow("not owned");
  await expect(service.cancel(tenantOne, "cpu-lease", 2)).rejects.toThrow("fenced");
  const lease = (await client`SELECT allocation_token, allocation_generation FROM factory_pool_requests WHERE reservation_id = 'cpu-lease'`)[0] as { allocation_token: string; allocation_generation: number };
  await service.acknowledgeStart(tenantOne, { reservationId: "cpu-lease", grantRevision: 1, allocationGeneration: lease.allocation_generation, allocationToken: lease.allocation_token });
  await service.renew(tenantOne, { reservationId: "cpu-lease", grantRevision: 1, allocationGeneration: lease.allocation_generation, allocationToken: lease.allocation_token });
  expect((await service.cancel(tenantOne, "cpu-lease", lease.allocation_generation)).state).toBe("revoking");
  await expect(service.request(tenantOne, { ...request("scope-denied"), grantScope: "tenant-01:other" })).rejects.toThrow("scope");
});

test("allows only the configured supervisor to stop and reimage its actual GPU host", async () => {
  await service.request(tenantOne, request("gpu-lease", { "gpu-host": 1 }));
  const holder = (await client`SELECT holder_generation FROM factory_pool_requests WHERE reservation_id = 'gpu-lease'`)[0] as { holder_generation: number };
  await expect(service.confirmStopped({ ...supervisor, hostIds: ["gpu-b"] }, { reservationId: "gpu-lease", holderGeneration: holder.holder_generation, hostId: "gpu-a" })).rejects.toThrow("not authorized");
  await expect(service.confirmStopped(supervisor, { reservationId: "gpu-lease", holderGeneration: holder.holder_generation + 1, hostId: "gpu-a" })).rejects.toThrow("stale");
  expect((await service.confirmStopped(supervisor, { reservationId: "gpu-lease", holderGeneration: holder.holder_generation, hostId: "gpu-a" })).state).toBe("uncertain");
  await expect(service.confirmReimage(supervisor, { reservationId: "gpu-lease", holderGeneration: holder.holder_generation, hostId: "gpu-b", receipt: "receipt-a" })).rejects.toThrow("not authorized");
  expect((await service.confirmReimage(supervisor, { reservationId: "gpu-lease", holderGeneration: holder.holder_generation, hostId: "gpu-a", receipt: "receipt-a" })).state).toBe("settled");
});

