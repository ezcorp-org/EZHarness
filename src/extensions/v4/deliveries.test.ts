import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

async function installationFixture() {
  const id = randomUUID();
  const releaseId = randomUUID();
  await repository.create({ installation: { id, ownerId: "owner", scope: "global", activeReleaseId: releaseId, generation: 1, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 }, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: {} });
  return { installationId: id, releaseId, generation: 1, principalId: "owner", scope: "global", deduplicationId: randomUUID(), kind: "webhook" as const, input: { event: "created" } };
}

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

  test("claim is exclusive and expired leases fence late acknowledgements", async () => {
    const input = await installationFixture();
    await queue.enqueue(input);
    const claims = await Promise.all([queue.claim(100), queue.claim(100)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const original = claims.find(Boolean)!;
    now += 101;
    const reclaimed = await queue.claim(100);
    expect(reclaimed?.id).toBe(original.id);
    expect(reclaimed?.leaseToken).not.toBe(original.leaseToken);
    await expect(queue.settle(original, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
    await queue.settle(reclaimed!, "delivered");
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

  test("ownerless and cross-user jobs are rejected", async () => {
    const input = await installationFixture();
    await expect(queue.enqueue({ ...input, principalId: "" })).rejects.toMatchObject({ code: "invalid_delivery" });
    await expect(queue.enqueue({ ...input, principalId: "other" })).rejects.toMatchObject({ code: "delivery_authority_changed" });
    await expect(queue.enqueue({ ...input, scope: "other" })).rejects.toMatchObject({ code: "delivery_authority_changed" });
  });
});
