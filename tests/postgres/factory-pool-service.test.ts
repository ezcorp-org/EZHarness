import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { PoolAdmissionService, type PoolPrincipal } from "../../src/factory/pool/service";
import { setupFactoryPoolPostgres } from "./helpers/factory-pool-database";

let client: SQL; let close: () => Promise<void>; let service: PoolAdmissionService;
const tenantOne: PoolPrincipal = { kind: "tenant", tenantId: "tenant-01", subject: "tenant-one", scopes: ["pool:tenant:tenant-01", "pool:grant:tenant-01:grant-a"] };
const tenantTwo: PoolPrincipal = { kind: "tenant", tenantId: "tenant-02", subject: "tenant-two", scopes: ["pool:tenant:tenant-02", "pool:grant:tenant-02:grant-a"] };
const supervisor: PoolPrincipal = { kind: "supervisor", supervisorId: "gpu-supervisor-a", subject: "supervisor-a", hostIds: ["gpu-a"], scopes: ["pool:supervisor:gpu-supervisor-a"] };
const request = (reservationId: string, resources: import("../../src/factory/pool/ledger").PoolResourceVector = { cpu: 1 }) => ({ reservationId, grantRevision: 1, grantScope: "tenant-01:grant-a", resources, admissionDeadline: new Date(Date.now() + 60_000).toISOString() });

beforeAll(async () => {
  ({ client, close } = await setupFactoryPoolPostgres()); service = new PoolAdmissionService(client); await service.setup(); await service.ledger.configureCapacity("cpu", 10); await service.ledger.registerGpuHost({ hostId: "gpu-a" });

});
afterAll(async () => { await close?.(); });

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

test("snapshots request fields before the grant insert yields", async () => {
  const expected = request("caller-mutation");
  const input = { ...expected, resources: { ...expected.resources } };
  const pending = service.request(tenantOne, input);
  input.grantScope = "tenant-01:changed";
  input.resources = { cpu: 2 };
  await expect(pending).resolves.toMatchObject({ reservationId: "caller-mutation" });
  const stored = (await client`SELECT tenant_id,grant_revision,resources_json,priority,ready_sequence,node_id,admission_deadline FROM factory_pool_requests WHERE reservation_id='caller-mutation'`)[0] as Record<string, unknown>;
  const normalizedStored: Record<string, unknown> = { ...stored, resources_json: JSON.parse(stored.resources_json as string), ready_sequence: Number(stored.ready_sequence), admission_deadline: new Date(stored.admission_deadline as string).toISOString() };
  expect(normalizedStored).toEqual({ tenant_id: "tenant-01", grant_revision: 1, resources_json: { cpu: 1 }, priority: 0, ready_sequence: 0, node_id: "", admission_deadline: expected.admissionDeadline });
  await expect(service.request(tenantOne, expected)).resolves.toMatchObject({ status: "admitted" });
});

test("converges concurrent identical first requests", async () => {
  const input = request("concurrent-identical");
  const outcomes = await Promise.allSettled([service.request(tenantOne, input), service.request(tenantOne, input)]);
  expect(outcomes).toEqual([
    expect.objectContaining({ status: "fulfilled" }),
    expect.objectContaining({ status: "fulfilled" }),
  ]);
  expect((await service.request(tenantOne, input)).lease?.allocationToken).toBeTruthy();
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
