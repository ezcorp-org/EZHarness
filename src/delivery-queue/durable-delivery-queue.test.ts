import { describe, expect, spyOn, test } from "bun:test";
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
    expect(await queue.renew(store, "scope", claimed, 50, 1000)).toMatchObject({ state: "leased", leaseToken: "owner", attempts: 1, leaseUntil: 1050 });
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

  test("the interval schedule renews at a third of the lease, so two renewals may fail before it lapses", () => {
    const schedule = spyOn(globalThis, "setInterval");
    try {
      const stop = intervalHeartbeat(60_000)(async () => undefined);
      stop();
      expect(schedule.mock.calls.map(call => call[1])).toEqual([20_000]);
    } finally { schedule.mockRestore(); }
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

  test("a renewal still pending when the handler returns finishes before the settle starts", async () => {
    const events: string[] = [];
    let beat: (() => Promise<void>) | undefined;
    const renewal = Promise.withResolvers<Record>();
    const returned = Promise.withResolvers<void>();
    const dispatched = dispatchDurableDelivery(async () => leased, async (value, outcome) => { events.push(`settle:${outcome}`); return { ...value, state: "delivered" }; }, async () => {
      void beat!();
      events.push("handler returned");
      returned.resolve();
    }, () => null, {
      start: value => { beat = value; return () => { events.push("stop"); }; },
      renew: async () => { const renewed = await renewal.promise; events.push("renewed"); return renewed; },
    });
    await returned.promise;
    // Give the dispatcher every turn it would need to settle early.
    for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(["handler returned", "stop"]);
    renewal.resolve(leased);
    expect((await dispatched)?.state).toBe("delivered");
    expect(events).toEqual(["handler returned", "stop", "renewed", "settle:delivered"]);
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


/** One-record store whose claim offers the current record when it is due or its lease ran out. */
function singleStore(initial: Record): { store: DurableDeliveryStore<Record>; current: () => Record } {
  let current = { ...initial };
  return {
    current: () => current,
    store: {
      findDuplicate: async () => null,
      insert: async () => false,
      claimCandidate: async (_scope, now) => (current.state === "queued" && current.availableAt <= now) || (current.state === "leased" && current.leaseUntil <= now) ? { ...current } : null,
      findById: async () => ({ ...current }),
      write: async value => { current = { ...value }; },
      inspect: async () => ({ ...current }),
    },
  };
}

describe("an expired lease (C11 N7)", () => {
  const expired: Record = { ...record, state: "leased", attempts: 1, leaseUntil: 50, leaseToken: "crashed" };

  test("by default becomes outcome_unknown and is never re-driven", async () => {
    const { store, current } = singleStore(expired);
    expect(await queue.claim(store, "scope", 100)).toBeNull();
    expect(current()).toMatchObject({ state: "outcome_unknown", failureCode: "worker_lease_expired", leaseUntil: 0, attempts: 1 });
    expect(await queue.claim(store, "scope", 200)).toBeNull();
  });

  test("with expiredLease 'reclaim' is leased again as a new attempt with a new token", async () => {
    const { store, current } = singleStore(expired);
    const claimed = await queue.claim(store, "scope", 100, 30_000, { expiredLease: "reclaim" });
    expect(claimed).toMatchObject({ id: "kept", state: "leased", attempts: 2, leaseUntil: 30_100, leaseToken: "lease-token" });
    expect(current()).toMatchObject({ state: "leased", attempts: 2 });
  });

  test("with expiredLease 'reclaim' still stops at maxAttempts", async () => {
    const { store, current } = singleStore({ ...expired, attempts: 3 });
    expect(await queue.claim(store, "scope", 100, 30_000, { expiredLease: "reclaim" })).toBeNull();
    expect(current()).toMatchObject({ state: "dead_letter", failureCode: "attempts_exhausted", leaseUntil: 0 });
  });

  test("the crashed owner cannot settle after another worker reclaimed it", async () => {
    const { store } = singleStore(expired);
    await queue.claim(store, "scope", 100, 30_000, { expiredLease: "reclaim" });
    await expect(queue.settle(store, "scope", expired, 101, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
  });
});

describe("a terminal rejection settles as dead letter", () => {
  test("settle accepts dead_letter with its code and clears the lease", async () => {
    const { store } = singleStore({ ...record, state: "leased", attempts: 1, leaseUntil: 1000, leaseToken: "lease-token" });
    const settled = await queue.settle(store, "scope", { ...record, leaseToken: "lease-token" }, 10, "dead_letter", "webhook_rejected_4xx");
    expect(settled).toMatchObject({ state: "dead_letter", failureCode: "webhook_rejected_4xx", leaseUntil: 0 });
  });

  test("dispatch settles dead_letter when the classifier names a terminal code", async () => {
    const settled: unknown[] = [];
    const result = await dispatchDurableDelivery<Record, "dead_letter">(
      async () => ({ ...record, state: "leased" as const }),
      async (value, outcome, code) => { settled.push([outcome, code]); return value; },
      async () => { throw new Error("rejected"); },
      (): { deadLetter: string } => ({ deadLetter: "webhook_rejected_4xx" }),
    );
    expect(result).not.toBeNull();
    expect(settled).toEqual([["dead_letter", "webhook_rejected_4xx"]]);
  });
});

describe("releasing a lease without spending an attempt", () => {
  test("the owner gets the record back queued and due now, its attempt returned", async () => {
    const { store, current } = singleStore({ ...record, state: "leased", attempts: 2, leaseUntil: 1_000, leaseToken: "lease-token", availableAt: 0 });
    const released = await queue.release(store, "scope", { ...record, leaseToken: "lease-token" }, 10);
    expect(released).toMatchObject({ state: "queued", attempts: 1, availableAt: 10, leaseUntil: 0 });
    expect(current().leaseToken).toBeUndefined();
  });

  test("is fenced like a settlement: a lost lease is refused", async () => {
    const { store } = singleStore({ ...record, state: "leased", attempts: 2, leaseUntil: 1_000, leaseToken: "another" });
    await expect(queue.release(store, "scope", { ...record, leaseToken: "lease-token" }, 10)).rejects.toMatchObject({ code: "delivery_lease_lost" });
  });
});
