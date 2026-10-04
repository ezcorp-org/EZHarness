import { describe, expect, test } from "bun:test";
import { DurableDeliveryQueue, dispatchDurableDelivery, durableInputHash, intervalHeartbeat, type DurableDeliveryRecord, type DurableDeliveryStore } from "./durable-delivery-queue";

type Record = DurableDeliveryRecord & { readonly value: string };

const record: Record = { id: "kept", value: "same", state: "queued", attempts: 0, maxAttempts: 3, availableAt: 0, leaseUntil: 0, createdAt: 0 };

function raceStore(afterConflict: Record | null): DurableDeliveryStore<Record> {
  let reads = 0;
  return {
    findDuplicate: async () => reads++ === 0 ? null : afterConflict,
    insert: async () => false,
    claimCandidate: async () => null,
    findById: async () => null,
    write: async () => undefined,
    inspect: async () => null,
  };
}

const queue = new DurableDeliveryQueue<Record>((code, message) => Object.assign(new Error(message), { code }), () => "lease-token");

describe("shared durable delivery queue concurrency", () => {
  test("returns the winner when a same-input insert wins the unique-key race", async () => {
    await expect(queue.enqueue(raceStore(record), {
      scope: "scope",
      deduplicationId: "dedup",
      inputHash: durableInputHash({ value: "same" }),
      hashExisting: value => durableInputHash({ value: value.value }),
      create: () => ({ ...record, id: "loser" }),
    })).resolves.toBe(record);
  });

  test("fails when a racing insert used different input or vanished", async () => {
    const enqueue = (winner: Record | null) => queue.enqueue(raceStore(winner), {
      scope: "scope",
      deduplicationId: "dedup",
      inputHash: durableInputHash({ value: "same" }),
      hashExisting: value => durableInputHash({ value: value.value }),
      create: () => ({ ...record, id: "loser" }),
    });
    await expect(enqueue({ ...record, value: "changed" })).rejects.toMatchObject({ code: "delivery_conflict" });
    await expect(enqueue(null)).rejects.toMatchObject({ code: "delivery_conflict" });
  });

  test("cancels only queued work and keeps cancellation idempotent", async () => {
    let current = { ...record };
    const store: DurableDeliveryStore<Record> = {
      findDuplicate: async () => null,
      insert: async () => false,
      claimCandidate: async () => null,
      findById: async () => current,
      write: async value => { current = { ...value }; },
      inspect: async () => current,
    };
    expect(await queue.cancel(store, "scope", current.id, "authority_revoked")).toMatchObject({ state: "cancelled", failureCode: "authority_revoked" });
    expect(await queue.cancel(store, "scope", current.id)).toEqual(current);
    current = { ...record, state: "leased", leaseToken: "owner" };
    await expect(queue.cancel(store, "scope", current.id)).rejects.toMatchObject({ code: "delivery_already_dispatched" });
    current = { ...record };
    expect(await queue.cancel(store, "scope", current.id, "not valid!")).toMatchObject({ failureCode: "delivery_cancelled" });
    await expect(queue.cancel({ ...store, findById: async () => null }, "scope", "missing")).rejects.toMatchObject({ code: "not_found" });
  });

  test("lets only the current lease owner settle pre-execution work as cancelled", async () => {
    let current: Record = { ...record, state: "leased", attempts: 1, leaseToken: "owner", leaseUntil: 10 };
    const store: DurableDeliveryStore<Record> = {
      findDuplicate: async () => null,
      insert: async () => false,
      claimCandidate: async () => null,
      findById: async () => current,
      write: async value => { current = { ...value }; },
      inspect: async () => current,
    };
    expect(await queue.settle(store, "scope", current, 1, "cancelled", "authority_revoked")).toMatchObject({ state: "cancelled", failureCode: "authority_revoked", leaseUntil: 0 });
    current = { ...record, state: "leased", attempts: 1, leaseToken: "new-owner", leaseUntil: 10 };
    await expect(queue.settle(store, "scope", { ...current, leaseToken: "stale-owner" }, 1, "cancelled")).rejects.toMatchObject({ code: "delivery_lease_lost" });
  });

  test("recovers only a verified unknown outcome and keeps the receipt idempotent", async () => {
    let current: Record = { ...record, state: "outcome_unknown", leaseToken: "expired-owner", leaseUntil: 3, failureCode: "external_outcome_unknown" };
    const store: DurableDeliveryStore<Record> = {
      findDuplicate: async () => null,
      insert: async () => false,
      claimCandidate: async () => null,
      findById: async () => current,
      write: async value => { current = { ...value }; },
      inspect: async () => current,
    };
    expect(await queue.recoverDelivered(store, "scope", current.id)).toEqual({ ...record, state: "delivered", leaseUntil: 0 });
    expect(await queue.recoverDelivered(store, "scope", current.id)).toEqual(current);
    current = { ...record, state: "cancelled" };
    await expect(queue.recoverDelivered(store, "scope", current.id)).rejects.toMatchObject({ code: "delivery_recovery_invalid" });
    await expect(queue.recoverDelivered({ ...store, findById: async () => null }, "scope", "missing")).rejects.toMatchObject({ code: "not_found" });
  });

  test("renews only the lease its owner still holds, and never one that ran out or was taken", async () => {
    let current: Record = { ...record, state: "leased", attempts: 1, leaseToken: "owner", leaseUntil: 100 };
    const store: DurableDeliveryStore<Record> = {
      findDuplicate: async () => null,
      insert: async () => false,
      claimCandidate: async () => null,
      findById: async () => current,
      write: async value => { current = { ...value }; },
      inspect: async () => current,
    };
    const claimed = { ...current };
    expect(await queue.renew(store, "scope", claimed, 50, 1000)).toMatchObject({ state: "leased", leaseToken: "owner", leaseUntil: 1050 });
    expect(current.leaseUntil).toBe(1050);
    await expect(queue.renew(store, "scope", { ...claimed, leaseToken: "stale-owner" }, 60, 1000)).rejects.toMatchObject({ code: "delivery_lease_lost" });
    await expect(queue.renew(store, "scope", claimed, 1050, 1000)).rejects.toMatchObject({ code: "delivery_lease_lost" });
    current = { ...current, state: "outcome_unknown", leaseUntil: 0 };
    await expect(queue.renew(store, "scope", claimed, 60, 1000)).rejects.toMatchObject({ code: "delivery_lease_lost" });
    expect(current.state).toBe("outcome_unknown");
    await expect(queue.renew({ ...store, findById: async () => null }, "scope", claimed, 60, 1000)).rejects.toMatchObject({ code: "not_found" });
    await expect(queue.renew(store, "scope", claimed, 60, 0)).rejects.toMatchObject({ code: "invalid_lease" });
  });
});

describe("lease heartbeat during dispatch", () => {
  const leased: Record = { ...record, state: "leased", attempts: 1, leaseToken: "owner", leaseUntil: 10 };

  test("the interval schedule beats until it is stopped", async () => {
    let beats = 0;
    const second = Promise.withResolvers<void>();
    const stop = intervalHeartbeat(3)(async () => { beats += 1; if (beats === 2) second.resolve(); });
    await second.promise;
    stop();
    const counted = beats;
    // A stopped schedule never beats again: a later timer turn observes the same count.
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(beats).toBe(counted);
  });

  test("renews while the handler runs, never two renewals at once, and stops before the settle", async () => {
    const events: string[] = [];
    let beat: (() => Promise<void>) | undefined;
    const renewal = Promise.withResolvers<Record>();
    const result = await dispatchDurableDelivery(async () => leased, async (value, outcome) => { events.push(`settle:${outcome}`); return { ...value, state: "delivered" }; }, async () => {
      const first = beat!();
      expect(beat!()).toBe(first);
      events.push("renewing");
      renewal.resolve(leased);
      await first;
      events.push("renewed");
    }, () => null, {
      start: value => { beat = value; events.push("start"); return () => { events.push("stop"); }; },
      renew: async () => renewal.promise,
    });
    expect(result?.state).toBe("delivered");
    expect(events).toEqual(["start", "renewing", "renewed", "stop", "settle:delivered"]);
  });

  test("a lost lease ends the renewals, and a failing handler still settles after they stop", async () => {
    let beat: (() => Promise<void>) | undefined;
    let renewals = 0;
    const events: string[] = [];
    const result = await dispatchDurableDelivery(async () => leased, async (value, outcome, code) => { events.push(`settle:${outcome}:${code}`); return { ...value, state: "outcome_unknown" }; }, async () => {
      await beat!();
      await beat!();
      throw new Error("remote outcome unknown");
    }, () => null, {
      start: value => { beat = value; return () => { events.push("stop"); }; },
      renew: async () => { renewals += 1; throw Object.assign(new Error("lost"), { code: "delivery_lease_lost" }); },
    });
    expect(renewals).toBe(1);
    expect(result?.state).toBe("outcome_unknown");
    expect(events).toEqual(["stop", "settle:outcome_unknown:external_outcome_unknown"]);
  });
});

