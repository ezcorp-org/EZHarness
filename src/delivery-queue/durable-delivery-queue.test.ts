import { describe, expect, test } from "bun:test";
import { DurableDeliveryQueue, durableInputHash, type DurableDeliveryRecord, type DurableDeliveryStore } from "./durable-delivery-queue";

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
});
