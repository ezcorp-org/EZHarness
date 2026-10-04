import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { randomUUID } from "node:crypto";
import { up } from "../../db/migrations/add-extension-releases";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { ExtensionDeliveryQueue, RetryableDeliveryError } from "./deliveries";

let database: PGlite;
let repository: DatabaseLifecycleRepository;
let queue: ExtensionDeliveryQueue;
let now = 1_000;

beforeAll(async () => { database = new PGlite(); const driver = drizzle(database); await up(driver); repository = new DatabaseLifecycleRepository(driver); queue = new ExtensionDeliveryQueue(driver, () => now); });
afterAll(async () => { await database.close(); });

async function installationFixture(lifecycle = repository) {
  const id = randomUUID();
  const releaseId = randomUUID();
  await lifecycle.create({ installation: { id, ownerId: "owner", scope: "global", activeReleaseId: releaseId, generation: 1, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 }, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: {} });
  return { installationId: id, releaseId, generation: 1, principalId: "owner", scope: "global", deduplicationId: randomUUID(), kind: "webhook" as const, input: { event: "created" } };
}

/** A queue on its own database whose lease heartbeat the test drives by hand. */
async function renewingQueue() {
  const own = new PGlite();
  const driver = drizzle(own);
  await up(driver);
  owned.push(own);
  const beats: (() => Promise<void>)[] = [];
  const renewing = new ExtensionDeliveryQueue(driver, () => now, beat => { beats.push(beat); return () => { beats.splice(beats.indexOf(beat), 1); }; });
  const lifecycle = new DatabaseLifecycleRepository(driver);
  return { renewing, beats, lifecycle, input: await installationFixture(lifecycle) };
}
const owned: PGlite[] = [];
afterAll(async () => { for (const own of owned) await own.close(); });

describe("durable extension deliveries", () => {
  test("duplicate enqueue returns one record and changed input conflicts", async () => {
    const input = await installationFixture();
    const first = await queue.enqueue(input);
    expect((await queue.enqueue(input)).id).toBe(first.id);
    await expect(queue.enqueue({ ...input, input: { event: "changed" } })).rejects.toMatchObject({ code: "delivery_conflict" });
    const claimed = await queue.claim();
    expect(claimed?.id).toBe(first.id);
    await queue.settle(claimed!, "delivered");
  });

  test("claim is exclusive and expired leases never replay uncertain effects", async () => {
    const input = await installationFixture();
    await queue.enqueue(input);
    const claims = await Promise.all([queue.claim(100), queue.claim(100)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const original = claims.find(Boolean)!;
    now += 101;
    expect(await queue.claim(100)).toBeNull();
    expect((await queue.inspect(input.installationId, original.id))?.state).toBe("outcome_unknown");
    await expect(queue.settle(original, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
    expect(await queue.claim(100)).toBeNull();
  });

  test("transport retries preserve first context without weakening immutable payload identity", async () => {
    const input = await installationFixture();
    const first = await queue.enqueue({ ...input, transportContext: { attempt: 1, firedAt: 10 } });
    const retry = await queue.enqueue({ ...input, transportContext: { attempt: 2, firedAt: 20 } });
    expect(retry.id).toBe(first.id);
    expect(retry.transportContext).toEqual({ attempt: 1, firedAt: 10 });
    await expect(queue.enqueue({ ...input, input: { event: "different" }, transportContext: { attempt: 2 } })).rejects.toMatchObject({ code: "delivery_conflict" });
    await queue.settle((await queue.claim())!, "delivered");
  });

  test("unknown external effects are visible and are never automatically repeated", async () => {
    const input = await installationFixture();
    const record = await queue.enqueue(input);
    let effects = 0;
    const result = await queue.dispatch(async () => { effects += 1; throw new Error("remote succeeded but connection broke"); });
    expect(result?.state).toBe("outcome_unknown");
    expect(await queue.dispatch(async () => { effects += 1; })).toBeNull();
    expect(effects).toBe(1);
    expect((await queue.inspect(input.installationId, record.id))?.state).toBe("outcome_unknown");
  });

  test("known failures retry with a bounded budget then reach dead letter", async () => {
    const input = await installationFixture();
    await queue.enqueue(input);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await queue.dispatch(async () => { throw new RetryableDeliveryError("provider_unavailable_before_send"); });
      expect(result?.attempts).toBe(attempt);
      expect(result?.state).toBe(attempt === 3 ? "dead_letter" : "queued");
      now += 60_001;
    }
    expect(await queue.claim()).toBeNull();
  });

  test("generation changes cancel queued and leased work transactionally", async () => {
    const input = await installationFixture();
    const delivery = await queue.enqueue(input);
    const leased = await queue.claim();
    await repository.transact(input.installationId, (state) => { state.installation.generation += 1; state.installation.enabled = false; });
    expect((await queue.inspect(input.installationId, delivery.id))?.state).toBe("cancelled");
    await expect(queue.settle(leased!, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
    await expect(queue.enqueue({ ...input, deduplicationId: "after-disable" })).rejects.toMatchObject({ code: "delivery_authority_changed" });
  });

  test("a handler that runs past its claim lease, still inside its own bound, keeps the lease and settles delivered", async () => {
    // W4H-8: the lease (60 s from claim) ended before a handler still inside its own
    // 60 s invocation deadline, which starts later; the settle then failed with
    // delivery_lease_lost. The dispatcher now renews the lease while the handler runs.
    const { renewing, beats, input } = await renewingQueue();
    const record = await renewing.enqueue(input);
    const settled = await renewing.dispatch(async () => {
      now += 40_000;
      for (const beat of beats) await beat();
      now += 40_000;
    });
    expect(settled).toMatchObject({ id: record.id, state: "delivered" });
    expect(beats).toEqual([]);
  });

  test("a renewal never takes back a lease another worker already holds or expired", async () => {
    const { renewing, beats, input } = await renewingQueue();
    const record = await renewing.enqueue(input);
    const result = renewing.dispatch(async () => {
      now += 60_001;
      // The lease lapsed: a claim marks it outcome_unknown, and the renewal must not revive it.
      expect(await renewing.claim()).toBeNull();
      for (const beat of beats) await beat();
    });
    await expect(result).rejects.toMatchObject({ code: "delivery_lease_lost" });
    expect((await renewing.inspect(input.installationId, record.id))?.state).toBe("outcome_unknown");
  });

  test("by default a dispatch renews its 60 s lease every 20 s while the handler runs", async () => {
    const own = new PGlite();
    owned.push(own);
    const driver = drizzle(own);
    await up(driver);
    const live = new ExtensionDeliveryQueue(driver, () => now);
    await live.enqueue(await installationFixture(new DatabaseLifecycleRepository(driver)));
    const schedule = spyOn(globalThis, "setInterval");
    try {
      const settled = await live.dispatch(async () => { expect(schedule.mock.calls.map(call => call[1])).toEqual([20_000]); });
      expect(settled?.state).toBe("delivered");
    } finally { schedule.mockRestore(); }
  });

  test("a stale lease token cannot renew, before or after the delivery is reclaimed", async () => {
    const { renewing, input } = await renewingQueue();
    await renewing.enqueue(input);
    const original = (await renewing.claim(100))!;
    expect(await renewing.renew(original, 100)).toMatchObject({ id: original.id, leaseToken: original.leaseToken, attempts: 1, leaseUntil: now + 100 });
    await expect(renewing.renew({ ...original, leaseToken: "stale-owner" }, 100)).rejects.toMatchObject({ code: "delivery_lease_lost" });
    now += 101;
    await expect(renewing.renew(original, 100)).rejects.toMatchObject({ code: "delivery_lease_lost" });
    expect(await renewing.claim(100)).toBeNull();
    expect((await renewing.inspect(input.installationId, original.id))?.state).toBe("outcome_unknown");
    await expect(renewing.renew(original, 100)).rejects.toMatchObject({ code: "delivery_lease_lost" });
  });

  test("a running handler cannot keep a lease that a generation change revoked", async () => {
    const { renewing, beats, lifecycle, input } = await renewingQueue();
    const record = await renewing.enqueue(input);
    const refusals: unknown[] = [];
    const renew = renewing.renew.bind(renewing);
    const renewal = spyOn(renewing, "renew").mockImplementation(async (delivery, leaseMs) => renew(delivery, leaseMs).catch((cause: unknown) => { refusals.push(cause); throw cause; }));
    try {
      await expect(renewing.dispatch(async () => {
        await lifecycle.transact(input.installationId, (state) => { state.installation.generation += 1; state.installation.enabled = false; });
        for (const beat of beats) await beat();
      })).rejects.toMatchObject({ code: "delivery_lease_lost" });
      expect(refusals).toEqual([expect.objectContaining({ code: "delivery_lease_lost" })]);
      expect((await renewing.inspect(input.installationId, record.id))?.state).toBe("cancelled");
    } finally { renewal.mockRestore(); }
  });

  test("ownerless and cross-user jobs are rejected", async () => {
    const input = await installationFixture();
    await expect(queue.enqueue({ ...input, principalId: "" })).rejects.toMatchObject({ code: "invalid_delivery" });
    await expect(queue.enqueue({ ...input, principalId: "other" })).rejects.toMatchObject({ code: "delivery_authority_changed" });
    await expect(queue.enqueue({ ...input, scope: "other" })).rejects.toMatchObject({ code: "delivery_authority_changed" });
  });
});
