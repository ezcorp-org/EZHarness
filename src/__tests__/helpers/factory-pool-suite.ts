import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { C03_RESERVATION_STATES, FactoryPoolLedger, POOL_DEFAULT_QUEUE_LIMITS, POOL_LEASE_STATES, POOL_STATE_CONTRACT_MAPPING, type PoolClock, type PoolLease, type PoolLeaseState, type PoolRequest, type PoolSql } from "../../factory/pool";
import { PoolAdmissionService, type PoolPrincipal } from "../../factory/pool/service";

export interface FactoryPoolConformanceFixture {
  readonly name: string;
  create(): Promise<PoolSql>;
  destroy(): Promise<void>;
}

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

/** Admit one request, finish it, and return its capacity before the next round. */
async function cycle(pool: FactoryPoolLedger): Promise<PoolLease> {
  const lease = await admitted(pool);
  await pool.revoke(lease.reservationId, lease.allocationGeneration);
  await pool.confirmStopped({ reservationId: lease.reservationId, holderGeneration: lease.holderGeneration });
  return lease;
}

/** Runs C03 ledger behavior against an isolated database fixture. */
export function factoryPoolConformance(fixture: FactoryPoolConformanceFixture): void {
describe(`factory C03 pool admission ledger on ${fixture.name}`, () => {
  let poolDatabase: PoolSql;
  let clock: FixedClock;
  let pool: FactoryPoolLedger;

  beforeAll(async () => { poolDatabase = await fixture.create(); });

  beforeEach(async () => {
    await poolDatabase.unsafe("TRUNCATE factory_pool_round_members, factory_pool_tenant_minima, factory_pool_requests, factory_pool_hosts, factory_pool_tenants, factory_pool_resources");
    clock = new FixedClock(new Date("2026-09-12T12:00:00.000Z"));
    pool = new FactoryPoolLedger(poolDatabase, clock);
  });

  afterAll(async () => { await fixture.destroy(); });

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

  test("serves ten tenants one allocation each per round, in a deterministic order", async () => {
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

  test("weighting orders a round, so a heavier tenant holding more capacity is still served first", async () => {
    await pool.configureCapacity("cpu", 12);
    await pool.setTenantPolicy({ tenantId: "tenant-light", weight: 1 });
    await pool.setTenantPolicy({ tenantId: "tenant-heavy", weight: 3 });
    const hold = async (tenantId: string, count: number, label: string) => {
      for (let index = 0; index < count; index += 1) {
        await pool.request(request(`${label}-${tenantId}-${index}`, tenantId, { cpu: 1 }, clock));
        await admitted(pool);
      }
    };
    // Active service of 2 and 3 units against weights 1 and 3 scores 2 and 1,
    // so the tenant holding MORE absolute capacity sorts first. Nothing but the
    // weight can produce that order.
    await hold("tenant-light", 2, "first");
    await hold("tenant-heavy", 3, "first");
    await pool.request(request("next-light", "tenant-light", { cpu: 1 }, clock));
    await pool.request(request("next-heavy", "tenant-heavy", { cpu: 1 }, clock));
    // Begin a fresh round. Round membership decides WHO is eligible and always
    // outranks weight; weight decides the order among those who are.
    await poolDatabase.unsafe("DELETE FROM factory_pool_round_members");
    expect([(await pool.schedule())?.reservationId, (await pool.schedule())?.reservationId]).toEqual(["next-heavy", "next-light"]);

    // Swap the weights with the holdings otherwise unchanged in shape, and the
    // order inverts. The trace is the assertion, not the test's name.
    await pool.setTenantPolicy({ tenantId: "tenant-light", weight: 3 });
    await pool.setTenantPolicy({ tenantId: "tenant-heavy", weight: 1 });
    await pool.request(request("later-light", "tenant-light", { cpu: 1 }, clock));
    await pool.request(request("later-heavy", "tenant-heavy", { cpu: 1 }, clock));
    await poolDatabase.unsafe("DELETE FROM factory_pool_round_members");
    expect([(await pool.schedule())?.reservationId, (await pool.schedule())?.reservationId]).toEqual(["later-light", "later-heavy"]);
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
    await poolDatabase.unsafe("DELETE FROM factory_pool_round_members");
    expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "cpu-tenant-provider" });
  });

  test("accounts memory separately from CPU and releases both only after a stop proof", async () => {
    await pool.configureCapacity("cpu", 1);
    await pool.configureCapacity("memory", 2_048);
    await pool.request(request("memory-holder", "tenant-a", { cpu: 1, memory: 2_048 }, clock));
    const lease = await admitted(pool);
    await pool.acknowledgeStart(fence(lease));
    await pool.request(request("memory-waiter", "tenant-b", { memory: 1 }, clock));
    expect(await pool.schedule()).toMatchObject({ status: "queued", reservationId: "memory-waiter", blockingResource: "memory" });
    await pool.revoke("memory-holder", lease.allocationGeneration);
    await pool.confirmStopped({ reservationId: "memory-holder", holderGeneration: lease.holderGeneration });
    expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "memory-waiter" });
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

  test("serves persistently queued tenants one allocation per round, ordered inside a tenant by priority, ready sequence, then node identity", async () => {
    await pool.configureCapacity("cpu", 1);
    // Unequal weights order a round. They never buy a second turn inside one.
    await pool.setTenantPolicy({ tenantId: "tenant-a", weight: 1 });
    await pool.setTenantPolicy({ tenantId: "tenant-b", weight: 3 });
    await pool.setTenantPolicy({ tenantId: "tenant-c", weight: 2 });
    const queue: Array<[string, string, Partial<PoolRequest>]> = [
      ["a-priority", "tenant-a", { priority: 5, readySequence: 9, nodeId: "node-a" }],
      ["a-ready", "tenant-a", { priority: 1, readySequence: 2, nodeId: "node-a" }],
      ["a-late", "tenant-a", { priority: 1, readySequence: 7, nodeId: "node-a" }],
      ["b-node-a", "tenant-b", { priority: 0, readySequence: 0, nodeId: "node-a" }],
      ["b-node-b", "tenant-b", { priority: 0, readySequence: 0, nodeId: "node-b" }],
      ["b-ready", "tenant-b", { priority: 0, readySequence: 1, nodeId: "node-a" }],
      ["c-first", "tenant-c", { priority: 0, readySequence: 0, nodeId: "node-c" }],
      ["c-second", "tenant-c", { priority: 0, readySequence: 1, nodeId: "node-c" }],
      ["c-third", "tenant-c", { priority: 0, readySequence: 2, nodeId: "node-c" }],
    ];
    for (const [reservationId, tenantId, overrides] of queue) await pool.request(request(reservationId, tenantId, { cpu: 1 }, clock, overrides));
    const trace: string[] = [];
    for (let round = 0; round < queue.length; round += 1) trace.push((await cycle(pool)).reservationId);
    expect(trace).toEqual([
      "a-priority", "b-node-a", "c-first",
      "a-ready", "b-node-b", "c-second",
      "a-late", "b-ready", "c-third",
    ]);
  });

  test("admits a small tenant within a bounded number of rounds under sustained large-tenant traffic", async () => {
    await pool.configureCapacity("cpu", 4);
    const largeTenants = ["tenant-large-1", "tenant-large-2", "tenant-large-3"];
    let sequence = 0;
    const enqueue = async (tenantId: string, cpu: number) => { sequence += 1; await pool.request(request(`${tenantId}-${sequence}`, tenantId, { cpu }, clock)); };
    // Each large tenant keeps a backlog. "tenant-small" sorts after all of them,
    // so only the round, never the identifier order, can let it through.
    for (const tenantId of largeTenants) { await enqueue(tenantId, 2); await enqueue(tenantId, 2); }
    await enqueue("tenant-small", 1);
    const trace: string[] = [];
    for (let round = 1; round <= 12 && !trace.includes("tenant-small"); round += 1) {
      const lease = await cycle(pool);
      trace.push(lease.tenantId);
      if (lease.tenantId !== "tenant-small") await enqueue(lease.tenantId, 2);
    }
    expect(trace).toEqual([...largeTenants, "tenant-small"]);
    expect(trace.indexOf("tenant-small") + 1).toBeLessThanOrEqual(largeTenants.length + 1);
    expect((await pool.status(`tenant-small-${largeTenants.length * 2 + 1}`))?.state).toBe("settled");
  });

  test("serves a thirty-second-aged request before a younger request the round order would pick", async () => {
    await pool.configureCapacity("cpu", 1);
    await pool.request(request("aged", "tenant-z", { cpu: 1 }, clock));
    clock.advance(30_001);
    await pool.request(request("young", "tenant-a", { cpu: 1 }, clock));
    // Both tenants are unserved, so the round order alone would admit tenant-a.
    expect(await pool.schedule()).toMatchObject({ status: "admitted", reservationId: "aged" });
    expect((await pool.status("young"))?.state).toBe("queued");
  });

  test("bounds outstanding requests at the configured limits and defaults to the C03 maxima", async () => {
    expect(POOL_DEFAULT_QUEUE_LIMITS).toEqual({ perTenant: 10_000, pool: 100_000 });
    expect(new FactoryPoolLedger(poolDatabase).queueLimits).toEqual({ perTenant: 10_000, pool: 100_000 });
    for (const limits of [{ perTenant: 10_001 }, { pool: 100_001 }, { perTenant: 0 }, { pool: 1.5 }]) {
      expect(() => new FactoryPoolLedger(poolDatabase, clock, limits)).toThrow("outstanding-request limit");
    }
    // Two per tenant and three per pool exercise the same comparison the
    // contract maxima use. Nothing is scheduled, so every row stays queued.
    const bounded = new FactoryPoolLedger(poolDatabase, clock, { perTenant: 2, pool: 3 });
    expect(bounded.queueLimits).toEqual({ perTenant: 2, pool: 3 });
    await bounded.configureCapacity("cpu", 1);
    for (const reservationId of ["bound-a-1", "bound-a-2"]) expect(await bounded.request(request(reservationId, "tenant-a", { cpu: 1 }, clock))).toMatchObject({ status: "queued" });
    expect(await bounded.request(request("bound-a-3", "tenant-a", { cpu: 1 }, clock))).toEqual({ status: "rejected", reservationId: "bound-a-3", reason: "queue-full", retryAfterSeconds: 1 });
    expect(await bounded.status("bound-a-3")).toBeUndefined();
    expect(await bounded.request(request("bound-b-1", "tenant-b", { cpu: 1 }, clock))).toMatchObject({ status: "queued" });
    expect(await bounded.request(request("bound-b-2", "tenant-b", { cpu: 1 }, clock))).toEqual({ status: "rejected", reservationId: "bound-b-2", reason: "queue-full", retryAfterSeconds: 1 });
    expect(await bounded.status("bound-b-2")).toBeUndefined();
    // A lost rejection leaves no durable trace, so the caller simply retries
    // once a cancellation frees one outstanding slot.
    await bounded.cancel("bound-a-1", 1);
    expect(await bounded.request(request("bound-a-3", "tenant-a", { cpu: 1 }, clock))).toMatchObject({ status: "queued", reservationId: "bound-a-3" });
  });

  test("keeps the durable reservation vocabulary and the documented C03 mapping identical", async () => {
    const states: readonly PoolLeaseState[] = POOL_LEASE_STATES;
    expect(Object.keys(POOL_STATE_CONTRACT_MAPPING).sort()).toEqual([...states].sort());
    expect([...new Set(Object.values(POOL_STATE_CONTRACT_MAPPING))].sort()).toEqual([...C03_RESERVATION_STATES].sort());
    const documented = await readFile(new URL("../../../docs/factory-pool-admission.md", import.meta.url), "utf8");
    for (const [state, contractState] of Object.entries(POOL_STATE_CONTRACT_MAPPING)) expect(documented).toContain(`| \`${state}\` | \`${contractState}\` |`);
    // The durable CHECK constraint must accept exactly the documented states.
    const insert = "INSERT INTO factory_pool_requests(reservation_id, tenant_id, grant_revision, resources_json, queued_at, admission_deadline, state, fence) VALUES ($1,'tenant-vocabulary',1,'{\"cpu\":1}'::jsonb,$2,$2,$3,$1)";
    const moment = clock.now().toISOString();
    for (const state of states) await poolDatabase.unsafe(insert, [`vocabulary-${state}`, moment, state]);
    expect((await pool.status("vocabulary-queued"))?.state).toBe("queued");
    for (const absent of C03_RESERVATION_STATES.filter(state => !(states as readonly string[]).includes(state))) {
      // `expect(...).rejects` never drives Bun's lazy SQLQuery. Adopt it into a
      // real promise so both drivers actually run the statement.
      expect(await Promise.resolve(poolDatabase.unsafe(insert, [`vocabulary-${absent}`, moment, absent])).then(() => "accepted", () => "rejected")).toBe("rejected");
    }
  });

  test("a tenant can confirm a supervisor's stop, and can never stand in for one", async () => {
    const service = new PoolAdmissionService(poolDatabase, pool);
    const holder: PoolPrincipal = { kind: "tenant", tenantId: "tenant-a", subject: "tenant-a", scopes: ["pool:tenant:tenant-a"] };
    const other: PoolPrincipal = { kind: "tenant", tenantId: "tenant-b", subject: "tenant-b", scopes: ["pool:tenant:tenant-b"] };
    const supervisorPrincipal: PoolPrincipal = { kind: "supervisor", supervisorId: "supervisor-a", subject: "supervisor-a", hostIds: ["host-ack"], scopes: ["pool:supervisor:supervisor-a"] };
    await pool.configureCapacity("cpu", 2);
    await pool.request(request("ack", "tenant-a", { cpu: 1 }, clock));
    const lease = await admitted(pool);
    await pool.acknowledgeStart(fence(lease));
    const stop = { reservationId: "ack", holderGeneration: lease.holderGeneration, hostId: "host-ack" };

    // Before the supervisor confirms, the holder may still be running, so the
    // acknowledgement fails closed rather than freeing anything.
    await expect(service.acknowledgeStopped(holder, stop)).rejects.toThrow("cannot be acknowledged");
    expect((await pool.status("ack"))?.state).toBe("running");

    // The supervisor's own confirmation is what releases capacity. A CPU
    // reservation binds no whole host, so the ledger records none.
    expect(await service.confirmStopped(supervisorPrincipal, { reservationId: stop.reservationId, holderGeneration: stop.holderGeneration, hostId: "host-ack" })).toMatchObject({ state: "settled" });

    // The tenant then reads that settled fact, and a repeat is identical
    // because the acknowledgement writes nothing at all.
    const acknowledged = await service.acknowledgeStopped(holder, stop);
    expect(acknowledged).toMatchObject({ reservationId: "ack", tenantId: "tenant-a", state: "settled", holderGeneration: lease.holderGeneration });
    expect(acknowledged.hostId).toBeUndefined();
    expect(await service.acknowledgeStopped(holder, stop)).toEqual(acknowledged);
    // A concurrent pair agrees, and neither of them moves the ledger.
    expect(await Promise.all([service.acknowledgeStopped(holder, stop), service.acknowledgeStopped(holder, stop)])).toEqual([acknowledged, acknowledged]);
    expect(await pool.status("ack")).toEqual(acknowledged);

    // A foreign host, a stale generation, another tenant, an unknown
    // reservation, and a malformed field are each refused.
    // The pool has no host for a CPU reservation, so it cannot contradict one;
    // the GPU case below is where a foreign host is refused.
    expect(await service.acknowledgeStopped(holder, { ...stop, hostId: "host-elsewhere" })).toEqual(acknowledged);
    await expect(service.acknowledgeStopped(holder, { ...stop, holderGeneration: stop.holderGeneration + 1 })).rejects.toThrow("is stale");
    await expect(service.acknowledgeStopped(other, stop)).rejects.toThrow("not owned by this tenant");
    await expect(service.acknowledgeStopped(holder, { ...stop, reservationId: "absent" })).rejects.toThrow("does not exist");
    await expect(service.acknowledgeStopped(holder, { ...stop, holderGeneration: 0 })).rejects.toThrow("malformed");
    await expect(service.acknowledgeStopped(holder, { ...stop, hostId: "" })).rejects.toThrow("malformed");
    await expect(service.acknowledgeStopped(supervisorPrincipal, stop)).rejects.toThrow("requires a tenant certificate");
  });

  test("a GPU stop stays unacknowledged until its host is proven reimaged", async () => {
    const service = new PoolAdmissionService(poolDatabase, pool);
    const holder: PoolPrincipal = { kind: "tenant", tenantId: "tenant-a", subject: "tenant-a", scopes: ["pool:tenant:tenant-a"] };
    const supervisorPrincipal: PoolPrincipal = { kind: "supervisor", supervisorId: "supervisor-a", subject: "supervisor-a", hostIds: ["gpu-ack"], scopes: ["pool:supervisor:supervisor-a"] };
    await pool.configureCapacity("cpu", 1);
    await pool.registerGpuHost({ hostId: "gpu-ack" });
    await pool.request(request("gpu-ack-reservation", "tenant-a", { cpu: 1, "gpu-host": 1 }, clock));
    const lease = await admitted(pool);
    const stop = { reservationId: "gpu-ack-reservation", holderGeneration: lease.holderGeneration, hostId: "gpu-ack" };
    expect(await service.confirmStopped(supervisorPrincipal, stop)).toMatchObject({ state: "uncertain", reason: "awaiting-gpu-reimage" });
    // The host is not offered again yet, so there is nothing for the tenant to
    // acknowledge; C03 holds the capacity until a verified reimage receipt.
    await expect(service.acknowledgeStopped(holder, stop)).rejects.toThrow("cannot be acknowledged");
    expect(await service.confirmReimage(supervisorPrincipal, { ...stop, receipt: "reimage-proof" })).toMatchObject({ state: "settled" });
    expect(await service.acknowledgeStopped(holder, stop)).toMatchObject({ state: "settled", hostId: "gpu-ack" });
    // Here the pool does know the host, so a foreign one is refused.
    await expect(service.acknowledgeStopped(holder, { ...stop, hostId: "gpu-elsewhere" })).rejects.toThrow("host is stale");
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
}
