import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { FactoryPoolLedger, setupFactoryPoolLedger, type PoolClock, type PoolLease, type PoolRequest } from "../../src/factory/pool";

const url = process.env.FACTORY_TEST_POSTGRES_URL;
if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL pool-ledger conformance.");

class FixedClock implements PoolClock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  advance(milliseconds: number): void { this.value = new Date(this.value.getTime() + milliseconds); }
}

function request(reservationId: string, tenantId: string, resources: PoolRequest["resources"], clock: PoolClock, overrides: Partial<PoolRequest> = {}): PoolRequest {
  return {
    reservationId,
    tenantId,
    grantRevision: 7,
    resources,
    priority: 0,
    readySequence: 0,
    nodeId: reservationId,
    admissionDeadline: new Date(clock.now().getTime() + 120_000),
    ...overrides,
  };
}

function fence(lease: PoolLease) {
  return { reservationId: lease.reservationId, tenantId: lease.tenantId, grantRevision: lease.grantRevision, allocationGeneration: lease.allocationGeneration, allocationToken: lease.allocationToken };
}

async function admitted(pool: FactoryPoolLedger): Promise<PoolLease> {
  const decision = await pool.schedule();
  if (decision?.status !== "admitted" || !decision.lease) throw new Error("Expected an admitted pool lease.");
  return decision.lease;
}

/** This uses a distinct database and only the C03 bootstrap, never product migrate(). */
describe("factory C03 pool admission ledger on real PostgreSQL", () => {
  let admin: SQL;
  let client: SQL;
  let databaseName: string;
  let clock: FixedClock;
  let pool: FactoryPoolLedger;

  beforeAll(async () => {
    admin = new SQL(url!, { max: 1 });
    databaseName = `factory_pool_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const isolated = new URL(url!);
    isolated.pathname = `/${databaseName}`;
    client = new SQL(isolated.toString(), { max: 12 });
    await setupFactoryPoolLedger(client);
  });

  beforeEach(async () => {
    await client.unsafe("TRUNCATE factory_pool_round_members, factory_pool_tenant_minima, factory_pool_requests, factory_pool_hosts, factory_pool_tenants, factory_pool_resources");
    clock = new FixedClock(new Date("2026-09-12T12:00:00.000Z"));
    pool = new FactoryPoolLedger(client, clock);
  });

  afterAll(async () => {
    await client?.close();
    if (databaseName) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.close();
  });

  test("durably queues an opaque request and replays a lost acquire response without a second allocation", async () => {
    await pool.configureCapacity("cpu", 1);
    expect(await pool.request(request("reservation-a", "tenant-a", { cpu: 1 }, clock))).toMatchObject({ status: "queued" });
    const decision = await pool.schedule();
    expect(decision).toMatchObject({ status: "admitted", reservationId: "reservation-a", lease: { allocationGeneration: 1, resources: { cpu: 1 } } });
    if (decision?.status !== "admitted" || !decision.lease) throw new Error("Expected an admitted lease.");
    const lease = decision.lease;
    expect(await pool.renew(fence(lease))).toMatchObject({ reservationId: "reservation-a", allocationGeneration: 1 });
    const replay = await pool.request(request("reservation-a", "tenant-a", { cpu: 1 }, clock));
    expect(replay).toMatchObject({ status: "admitted", lease: { allocationToken: lease.allocationToken, allocationGeneration: 1 } });
    await expect(pool.request(request("reservation-a", "tenant-other", { cpu: 1 }, clock))).rejects.toThrow("conflicts");
  });

  test("cancels a queued admission durably and never allocates it later", async () => {
    await pool.configureCapacity("cpu", 1);
    await pool.request(request("cancelled", "tenant-a", { cpu: 1 }, clock));
    expect(await pool.cancel("cancelled", 1)).toMatchObject({ state: "settled", reason: "cancelled-before-admission" });
    expect(await pool.request(request("cancelled", "tenant-a", { cpu: 1 }, clock))).toMatchObject({ status: "cancelled" });
    expect(await pool.schedule()).toBeUndefined();
  });

  test("serializes two schedulers racing for the last capacity unit", async () => {
    await pool.configureCapacity("cpu", 1);
    await pool.request(request("race-a", "tenant-a", { cpu: 1 }, clock));
    await pool.request(request("race-b", "tenant-b", { cpu: 1 }, clock));
    const decisions = await Promise.all([pool.schedule(), pool.schedule()]);
    expect(decisions.filter(decision => decision?.status === "admitted")).toHaveLength(1);
    expect((await pool.status("race-a"))?.state).toBe("held");
    expect((await pool.status("race-b"))?.state).toBe("queued");
  });

  test("uses deterministic weighted max-min service across ten tenants", async () => {
    await pool.configureCapacity("cpu", 11);
    await pool.setTenantPolicy({ tenantId: "tenant-heavy", weight: 2 });
    const tenantIds = Array.from({ length: 9 }, (_, index) => `tenant-${index}`);
    for (const tenantId of tenantIds) await pool.request(request(`reservation-${tenantId}`, tenantId, { cpu: 1 }, clock));
    await pool.request(request("reservation-heavy-1", "tenant-heavy", { cpu: 1 }, clock));
    await pool.request(request("reservation-heavy-2", "tenant-heavy", { cpu: 1 }, clock, { readySequence: 1 }));
    const allocations = [] as string[];
    for (let index = 0; index < 11; index += 1) allocations.push((await pool.schedule())?.lease?.tenantId ?? "");
    expect(allocations).toEqual(["tenant-0", "tenant-1", "tenant-2", "tenant-3", "tenant-4", "tenant-5", "tenant-6", "tenant-7", "tenant-8", "tenant-heavy", "tenant-heavy"]);
    expect(allocations.filter(tenantId => tenantId === "tenant-heavy")).toHaveLength(2);
  });

  test("uses weighted service for each resource class instead of summing CPU and provider units", async () => {
    await pool.configureCapacity("cpu", 10);
    await pool.configureCapacity("provider", 2);
    await pool.setTenantPolicy({ tenantId: "tenant-cpu", weight: 1 });
    await pool.setTenantPolicy({ tenantId: "tenant-provider", weight: 2 });
    await pool.request(request("cpu-work", "tenant-cpu", { cpu: 10 }, clock));
    await admitted(pool);
    await pool.request(request("provider-work", "tenant-provider", { provider: 1 }, clock));
    await admitted(pool);
    await pool.request(request("cpu-tenant-provider", "tenant-cpu", { provider: 1 }, clock));
    await pool.request(request("provider-tenant-provider", "tenant-provider", { provider: 1 }, clock));
    // Begin the next provider round. Existing CPU service must not count as provider service.
    await client.unsafe("DELETE FROM factory_pool_round_members");
    expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "cpu-tenant-provider" });
  });

  test("opportunistically admits a feasible younger request while a non-aged complete vector is blocked", async () => {
    await pool.configureCapacity("cpu", 1);
    await pool.configureCapacity("provider", 1);
    await pool.request(request("cpu-holder", "tenant-a", { cpu: 1 }, clock));
    await admitted(pool);
    await pool.request(request("later-vector", "tenant-b", { cpu: 1, provider: 1 }, clock));
    await pool.request(request("provider-only", "tenant-c", { provider: 1 }, clock));
    expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "provider-only" });
    expect((await pool.status("later-vector"))?.state).toBe("queued");
  });

  test("holds an aged complete vector instead of borrowing its provider capacity", async () => {
    await pool.configureCapacity("cpu", 1);
    await pool.configureCapacity("provider", 1);
    await pool.request(request("occupies-cpu", "tenant-occupied", { cpu: 1 }, clock));
    const running = await admitted(pool);
    await pool.acknowledgeStart(fence(running));
    await pool.request(request("old-vector", "tenant-old", { cpu: 1, provider: 1 }, clock));
    clock.advance(30_001);
    await pool.request(request("new-provider", "tenant-new", { provider: 1 }, clock));
    expect(await pool.schedule()).toMatchObject({ status: "queued", reservationId: "old-vector", blockingResource: "cpu" });
    expect((await pool.status("new-provider"))?.state).toBe("queued");
  });

  test("reserves a tenant minimum and schedules the protected tenant when another vector would consume it", async () => {
    await pool.configureCapacity("cpu", 2);
    await pool.setTenantPolicy({ tenantId: "tenant-small", reservedMinimum: { cpu: 1 } });
    await pool.request(request("large", "tenant-large", { cpu: 2 }, clock));
    await pool.request(request("small", "tenant-small", { cpu: 1 }, clock));
    expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "small" });
    expect((await pool.status("large"))?.state).toBe("queued");
  });

  test("rejects an unconfigured or oversized resource vector without inventing capacity", async () => {
    await pool.configureCapacity("cpu", 1);
    expect(await pool.request(request("too-large", "tenant-a", { cpu: 2 }, clock))).toMatchObject({ status: "rejected", reason: "request-exceeds-configured-capacity" });
    await expect(pool.request(request("unknown", "tenant-a", { provider: 1 }, clock))).resolves.toMatchObject({ status: "rejected" });
  });

  test("expiry increments allocation generation, rejects old heartbeats, and retains capacity until positive stop proof", async () => {
    await pool.configureCapacity("cpu", 1);
    await pool.request(request("lease", "tenant-a", { cpu: 1 }, clock));
    const lease = await admitted(pool);
    await pool.acknowledgeStart(fence(lease));
    clock.advance(30_001);
    expect(await pool.expire()).toBe(1);
    expect(await pool.status("lease")).toMatchObject({ state: "uncertain", allocationGeneration: 2, holderGeneration: 1 });
    await expect(pool.renew(fence(lease))).rejects.toThrow("fenced");
    await pool.request(request("waiter", "tenant-b", { cpu: 1 }, clock));
    expect(await pool.schedule()).toMatchObject({ status: "queued", reservationId: "waiter", blockingResource: "cpu" });
    expect(await pool.confirmStopped({ reservationId: "lease", holderGeneration: 1 })).toMatchObject({ state: "settled" });
    expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "waiter" });
  });

  test("revocation fences a grant heartbeat and still needs a stop confirmation", async () => {
    await pool.configureCapacity("provider", 1);
    await pool.request(request("revoke", "tenant-a", { provider: 1 }, clock));
    const lease = await admitted(pool);
    await pool.acknowledgeStart(fence(lease));
    expect(await pool.revoke("revoke", 1)).toMatchObject({ state: "revoking", allocationGeneration: 2 });
    await expect(pool.renew({ ...fence(lease), grantRevision: 8 })).rejects.toThrow("fenced");
    expect(await pool.confirmStopped({ reservationId: "revoke", holderGeneration: 1 })).toMatchObject({ state: "settled" });
  });

  test("assigns a GPU whole host and prevents reuse before matching stop and reimage proofs", async () => {
    await pool.registerGpuHost({ hostId: "gpu-host-a" });
    await pool.request(request("gpu-one", "tenant-a", { "gpu-host": 1 }, clock));
    const lease = await admitted(pool);
    expect(lease.hostId).toBe("gpu-host-a");
    await pool.revoke("gpu-one", lease.allocationGeneration);
    await expect(pool.confirmStopped({ reservationId: "gpu-one", holderGeneration: lease.holderGeneration, hostId: "wrong-host" })).rejects.toThrow("stale");
    await pool.confirmStopped({ reservationId: "gpu-one", holderGeneration: lease.holderGeneration, hostId: "gpu-host-a" });
    await pool.request(request("gpu-two", "tenant-b", { "gpu-host": 1 }, clock));
    expect(await pool.schedule()).toMatchObject({ status: "queued", blockingResource: "gpu-host" });
    await expect(pool.confirmGpuReimage({ reservationId: "gpu-one", hostId: "gpu-host-a", holderGeneration: lease.holderGeneration + 1, receipt: "receipt" })).rejects.toThrow("stale");
    await pool.confirmGpuReimage({ reservationId: "gpu-one", hostId: "gpu-host-a", holderGeneration: lease.holderGeneration, receipt: "receipt" });
    expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "gpu-two", lease: { hostId: "gpu-host-a" } });
    // A delayed callback for the previous reservation cannot alter the reused host.
    expect(await pool.confirmStopped({ reservationId: "gpu-one", holderGeneration: lease.holderGeneration, hostId: "gpu-host-a" })).toMatchObject({ state: "settled" });
    expect(await pool.status("gpu-two")).toMatchObject({ state: "held", hostId: "gpu-host-a" });
  });

  test("requires the stored fence and explicit acknowledgement to reconcile uncertain effects", async () => {
    await pool.configureCapacity("cpu", 1);
    await pool.request(request("uncertain", "tenant-a", { cpu: 1 }, clock));
    const lease = await admitted(pool);
    await pool.acknowledgeStart(fence(lease));
    await pool.recoverAfterLedgerLoss();
    await expect(pool.acknowledgeUncertainEffects("uncertain", "wrong-fence", true)).rejects.toThrow("fenced");
    await expect(pool.acknowledgeUncertainEffects("uncertain", lease.fence, false)).rejects.toThrow("explicit");
    expect(await pool.acknowledgeUncertainEffects("uncertain", lease.fence, true)).toMatchObject({ state: "revoking", allocationGeneration: 2 });
    expect(await pool.schedule()).toBeUndefined();
  });

  test("allocator recovery fences every live lease without changing budget-facing capacity and later accepts stop proof", async () => {
    await pool.configureCapacity("cpu", 1);
    await pool.request(request("recovery-old", "tenant-a", { cpu: 1 }, clock));
    const lease = await admitted(pool);
    await pool.acknowledgeStart(fence(lease));
    expect(await pool.recoverAfterLedgerLoss()).toBe(1);
    expect(await pool.status("recovery-old")).toMatchObject({ state: "uncertain", allocationGeneration: 2 });
    await expect(pool.renew(fence(lease))).rejects.toThrow("fenced");
    await pool.request(request("recovery-new", "tenant-b", { cpu: 1 }, clock));
    expect(await pool.schedule()).toMatchObject({ status: "queued", reservationId: "recovery-new" });
    await pool.confirmStopped({ reservationId: "recovery-old", holderGeneration: 1 });
    expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "recovery-new" });
  });

  test("GPU stop proof releases CPU once and leaves another active CPU lease accounted", async () => {
  await pool.configureCapacity("cpu", 2); await pool.registerGpuHost({ hostId: "gpu-mixed" });
  await pool.request(request("mixed", "tenant-a", { cpu: 1, "gpu-host": 1 }, clock));
  const mixed = await admitted(pool); await pool.revoke("mixed", 1);
  await pool.confirmStopped({ reservationId: "mixed", holderGeneration: mixed.holderGeneration, hostId: "gpu-mixed" });
  await pool.request(request("cpu-active", "tenant-b", { cpu: 1 }, clock)); await admitted(pool);
  await pool.confirmStopped({ reservationId: "mixed", holderGeneration: mixed.holderGeneration, hostId: "gpu-mixed" });
  await pool.request(request("cpu-extra", "tenant-c", { cpu: 1 }, clock));
  expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "cpu-extra" });
  await pool.request(request("cpu-over", "tenant-d", { cpu: 1 }, clock));
  expect(await pool.schedule()).toMatchObject({ status: "queued", blockingResource: "cpu" });
  });
});
