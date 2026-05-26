import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  enqueue,
  list,
  get,
  update,
  approve,
  reject,
  markSent,
  markFailed,
  editBody,
  findActiveByTarget,
  _setQueueStoreForTests,
  _setClockForTests,
  _resetQueueForTests,
  type QueueStoreLike,
} from "../lib/review-queue";

// ── In-memory store fake (mirrors the SDK runtime Storage surface) ─

function makeStore() {
  const map = new Map<string, unknown>();
  const store: QueueStoreLike = {
    async get<T>(key: string) {
      if (map.has(key)) return { value: map.get(key) as T, exists: true };
      return { value: null, exists: false };
    },
    async set<T>(key: string, value: T) {
      map.set(key, value);
      return { ok: true as const, sizeBytes: 0 };
    },
    async delete(key: string) {
      const had = map.has(key);
      map.delete(key);
      return { deleted: had };
    },
  };
  return { map, store };
}

let kit: ReturnType<typeof makeStore>;
let counter = 0;

beforeEach(() => {
  kit = makeStore();
  _setQueueStoreForTests(kit.store);
  counter = 0;
  // Deterministic clock + ids so assertions are stable.
  _setClockForTests(
    () => 1_000_000,
    () => `id-${counter++}`,
  );
});

afterEach(() => {
  _resetQueueForTests();
});

describe("enqueue → list round-trip", () => {
  test("enqueues a pending item and the index stays consistent", async () => {
    const item = await enqueue({
      kind: "reply",
      target_ref: "c-1",
      context: "nice post",
      draft_body: "thanks!",
    });
    expect(item.id).toBe("id-0");
    expect(item.status).toBe("pending");
    expect(item.due_at).toBeNull();
    expect(item.created_at).toBe(1_000_000);
    expect(item.updated_at).toBe(1_000_000);

    const all = await list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("id-0");

    // Index holds exactly one id.
    expect(kit.map.get("queue-index")).toEqual(["id-0"]);
  });

  test("multiple enqueues append to the index without duplicates", async () => {
    await enqueue({ kind: "reply", target_ref: "c-1", context: "a", draft_body: "1" });
    await enqueue({ kind: "welcome-dm", target_ref: "s-1", context: "b", draft_body: "2" });
    expect(kit.map.get("queue-index")).toEqual(["id-0", "id-1"]);
    expect(await list()).toHaveLength(2);
  });

  test("carries sequence_step + due_at when provided", async () => {
    const item = await enqueue({
      kind: "welcome-dm",
      target_ref: "s-1",
      context: "",
      draft_body: "",
      due_at: 2_000_000,
      sequence_step: 1,
    });
    expect(item.due_at).toBe(2_000_000);
    expect(item.sequence_step).toBe(1);
  });

  test("status override is honored", async () => {
    const item = await enqueue({
      kind: "reply",
      target_ref: "c-1",
      context: "a",
      draft_body: "1",
      status: "approved",
    });
    expect(item.status).toBe("approved");
  });
});

describe("filters", () => {
  test("list filters by status and kind independently", async () => {
    await enqueue({ kind: "reply", target_ref: "c-1", context: "a", draft_body: "1" });
    const dm = await enqueue({
      kind: "welcome-dm",
      target_ref: "s-1",
      context: "b",
      draft_body: "2",
    });
    await approve(dm.id);

    expect(await list({ kind: "reply" })).toHaveLength(1);
    expect(await list({ kind: "welcome-dm" })).toHaveLength(1);
    expect(await list({ status: "approved" })).toHaveLength(1);
    expect(await list({ status: "pending" })).toHaveLength(1);
    expect(await list({ status: "approved", kind: "reply" })).toHaveLength(0);
  });

  test("list tolerates index/record drift (missing record skipped)", async () => {
    await enqueue({ kind: "reply", target_ref: "c-1", context: "a", draft_body: "1" });
    // Corrupt: index references a phantom id with no record.
    kit.map.set("queue-index", ["id-0", "ghost"]);
    const all = await list();
    expect(all).toHaveLength(1);
  });
});

describe("update + transitions", () => {
  test("update mutates one record + stamps updated_at, leaves others", async () => {
    const a = await enqueue({ kind: "reply", target_ref: "c-1", context: "a", draft_body: "1" });
    const b = await enqueue({ kind: "reply", target_ref: "c-2", context: "b", draft_body: "2" });
    _setClockForTests(() => 9_999, () => "unused");

    const updated = await update(a.id, { draft_body: "edited" });
    expect(updated?.draft_body).toBe("edited");
    expect(updated?.updated_at).toBe(9_999);
    expect(updated?.created_at).toBe(1_000_000); // preserved

    const untouched = await get(b.id);
    expect(untouched?.draft_body).toBe("2");
  });

  test("approve / reject flip status", async () => {
    const a = await enqueue({ kind: "reply", target_ref: "c-1", context: "a", draft_body: "1" });
    expect((await approve(a.id))?.status).toBe("approved");
    expect((await reject(a.id))?.status).toBe("rejected");
  });

  test("markSent / markFailed set terminal states", async () => {
    const a = await enqueue({ kind: "reply", target_ref: "c-1", context: "a", draft_body: "1" });
    const failed = await markFailed(a.id, "boom");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");

    const sent = await markSent(a.id);
    expect(sent?.status).toBe("sent");
    expect(sent?.error).toBeUndefined(); // cleared on successful (re)send
  });

  test("editBody replaces the draft body", async () => {
    const a = await enqueue({ kind: "reply", target_ref: "c-1", context: "a", draft_body: "1" });
    expect((await editBody(a.id, "new body"))?.draft_body).toBe("new body");
  });

  test("update / transitions return null for unknown id", async () => {
    expect(await update("nope", { draft_body: "x" })).toBeNull();
    expect(await approve("nope")).toBeNull();
    expect(await reject("nope")).toBeNull();
    expect(await markSent("nope")).toBeNull();
    expect(await markFailed("nope", "e")).toBeNull();
    expect(await editBody("nope", "x")).toBeNull();
  });
});

describe("get", () => {
  test("returns null for a missing id", async () => {
    expect(await get("missing")).toBeNull();
  });
});

describe("findActiveByTarget (dedupe)", () => {
  test("finds a pending item for the same kind+ref", async () => {
    await enqueue({ kind: "reply", target_ref: "c-1", context: "a", draft_body: "1" });
    const found = await findActiveByTarget("reply", "c-1");
    expect(found?.target_ref).toBe("c-1");
  });

  test("ignores terminal (rejected/sent) items so a fresh draft is allowed", async () => {
    const a = await enqueue({ kind: "reply", target_ref: "c-1", context: "a", draft_body: "1" });
    await reject(a.id);
    expect(await findActiveByTarget("reply", "c-1")).toBeNull();

    const b = await enqueue({ kind: "reply", target_ref: "c-2", context: "b", draft_body: "2" });
    await markSent(b.id);
    expect(await findActiveByTarget("reply", "c-2")).toBeNull();
  });

  test("does not match a different kind for the same ref", async () => {
    await enqueue({ kind: "reply", target_ref: "x", context: "a", draft_body: "1" });
    expect(await findActiveByTarget("welcome-dm", "x")).toBeNull();
  });

  test("returns null when nothing matches", async () => {
    expect(await findActiveByTarget("reply", "absent")).toBeNull();
  });
});

describe("store-not-bound guard", () => {
  test("throws a clear error when no store is bound", async () => {
    _resetQueueForTests();
    await expect(
      enqueue({ kind: "reply", target_ref: "c", context: "a", draft_body: "1" }),
    ).rejects.toThrow(/store not bound/);
  });
});
