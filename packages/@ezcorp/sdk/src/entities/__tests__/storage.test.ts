// storage.test.ts — coverage for entities/storage.ts
//
// Spec-required cases:
//   key shape (__entity:<type>:<slug>),
//   index key shape (__entity-index:<type>),
//   reserved-key rejection,
//   scope routing (deferred — scope is a backend concern; we test the
//     store interface accepts whatever backend is injected),
//   index maintenance on add/remove

import { describe, expect, test } from "bun:test";

import {
  ENTITY_INDEX_PREFIX,
  ENTITY_KEY_PREFIX,
} from "../types";
import {
  assertNotReserved,
  assertValidEntityType,
  deleteEntityRecord,
  entityIndexKey,
  entityRecordKey,
  isReservedEntityKey,
  isValidEntityType,
  listEntityRecords,
  readEntityIndex,
  readEntityRecord,
  writeEntityIndex,
  writeEntityRecord,
  type EntityStoreLike,
} from "../storage";

// ── Fake in-memory store ────────────────────────────────────────

function makeStore(seed: Record<string, unknown> = {}): EntityStoreLike & {
  data: Map<string, unknown>;
  getCalls: string[];
  setCalls: Array<{ key: string; value: unknown }>;
  deleteCalls: string[];
  failOn?: { key: string; op: "get" | "set" | "delete"; err: Error };
} {
  const data = new Map<string, unknown>(Object.entries(seed));
  const getCalls: string[] = [];
  const setCalls: Array<{ key: string; value: unknown }> = [];
  const deleteCalls: string[] = [];

  const store: ReturnType<typeof makeStore> = {
    data,
    getCalls,
    setCalls,
    deleteCalls,
    async get<T = unknown>(key: string) {
      getCalls.push(key);
      if (store.failOn?.key === key && store.failOn.op === "get") {
        throw store.failOn.err;
      }
      const exists = data.has(key);
      return {
        exists,
        value: exists ? (data.get(key) as T) : (null as T | null),
      };
    },
    async set<T = unknown>(key: string, value: T) {
      setCalls.push({ key, value });
      if (store.failOn?.key === key && store.failOn.op === "set") {
        throw store.failOn.err;
      }
      data.set(key, value);
      return { ok: true };
    },
    async delete(key: string) {
      deleteCalls.push(key);
      if (store.failOn?.key === key && store.failOn.op === "delete") {
        throw store.failOn.err;
      }
      const had = data.delete(key);
      return { deleted: had };
    },
  };
  return store;
}

// ── Key shape ───────────────────────────────────────────────────

describe("key construction", () => {
  test("entityRecordKey: __entity:<type>:<slug>", () => {
    expect(entityRecordKey("post-type", "weekly")).toBe(
      `${ENTITY_KEY_PREFIX}post-type:weekly`,
    );
    expect(ENTITY_KEY_PREFIX).toBe("__entity:");
  });

  test("entityIndexKey: __entity-index:<type>", () => {
    expect(entityIndexKey("post-type")).toBe(
      `${ENTITY_INDEX_PREFIX}post-type`,
    );
    expect(ENTITY_INDEX_PREFIX).toBe("__entity-index:");
  });

  test("entityRecordKey rejects malformed type", () => {
    expect(() => entityRecordKey("BadType", "weekly")).toThrow(
      /Invalid entity type/,
    );
    expect(() => entityRecordKey("-leading", "weekly")).toThrow(
      /Invalid entity type/,
    );
    expect(() => entityRecordKey("", "weekly")).toThrow(/Invalid entity type/);
  });

  test("entityRecordKey rejects malformed slug", () => {
    expect(() => entityRecordKey("post-type", "BAD")).toThrow(/Invalid slug/);
    expect(() => entityRecordKey("post-type", "")).toThrow(/Invalid slug/);
  });

  test("entityIndexKey rejects malformed type", () => {
    expect(() => entityIndexKey("Bad")).toThrow(/Invalid entity type/);
  });
});

// ── Type validators ─────────────────────────────────────────────

describe("type validators", () => {
  test("isValidEntityType — accept", () => {
    expect(isValidEntityType("post-type")).toBe(true);
    expect(isValidEntityType("a")).toBe(true);
    expect(isValidEntityType("1")).toBe(true);
  });

  test("isValidEntityType — reject", () => {
    expect(isValidEntityType("Bad")).toBe(false);
    expect(isValidEntityType("")).toBe(false);
    expect(isValidEntityType("a".repeat(65))).toBe(false);
    expect(isValidEntityType(null)).toBe(false);
    expect(isValidEntityType(undefined)).toBe(false);
    expect(isValidEntityType(42)).toBe(false);
  });

  test("assertValidEntityType throws on bad input", () => {
    expect(() => assertValidEntityType("BAD")).toThrow(/Invalid entity type/);
  });

  test("assertValidEntityType doesn't throw on good input", () => {
    expect(() => assertValidEntityType("post-type")).not.toThrow();
  });
});

// ── Reserved-key guards ─────────────────────────────────────────

describe("reserved-key guards", () => {
  test("isReservedEntityKey identifies managed keys", () => {
    expect(isReservedEntityKey("__entity:post-type:weekly")).toBe(true);
    expect(isReservedEntityKey("__entity-index:post-type")).toBe(true);
    expect(isReservedEntityKey("__entity:")).toBe(true);
    expect(isReservedEntityKey("__entity-index:")).toBe(true);
  });

  test("isReservedEntityKey rejects non-managed keys", () => {
    expect(isReservedEntityKey("post-type:weekly")).toBe(false);
    expect(isReservedEntityKey("settings:foo")).toBe(false);
    expect(isReservedEntityKey("_entity:x")).toBe(false); // single underscore
    expect(isReservedEntityKey("")).toBe(false);
    expect(isReservedEntityKey(null)).toBe(false);
    expect(isReservedEntityKey(undefined)).toBe(false);
    expect(isReservedEntityKey(42)).toBe(false);
  });

  test("assertNotReserved throws on managed key", () => {
    expect(() => assertNotReserved("__entity:post-type:weekly")).toThrow(
      /reserved entity namespace/,
    );
    expect(() => assertNotReserved("__entity-index:post-type")).toThrow(
      /reserved entity namespace/,
    );
  });

  test("assertNotReserved passes for safe keys", () => {
    expect(() => assertNotReserved("settings:foo")).not.toThrow();
    expect(() => assertNotReserved("custom-key")).not.toThrow();
  });

  test("assertNotReserved uses ctx prefix", () => {
    expect(() =>
      assertNotReserved("__entity:post-type:weekly", "settings key"),
    ).toThrow(/settings key/);
  });
});

// ── Index read/write ────────────────────────────────────────────

describe("readEntityIndex", () => {
  test("returns [] when index is absent", async () => {
    const store = makeStore();
    expect(await readEntityIndex(store, "post-type")).toEqual([]);
  });

  test("returns slugs as stored", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly", "monthly"],
    });
    expect(await readEntityIndex(store, "post-type")).toEqual([
      "weekly",
      "monthly",
    ]);
  });

  test("filters non-string entries (corruption-tolerant)", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly", 42, null, "monthly"],
    });
    expect(await readEntityIndex(store, "post-type")).toEqual([
      "weekly",
      "monthly",
    ]);
  });

  test("filters invalid slugs (e.g. uppercase)", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly", "BAD", "monthly"],
    });
    expect(await readEntityIndex(store, "post-type")).toEqual([
      "weekly",
      "monthly",
    ]);
  });

  test("returns [] when index value is not an array", async () => {
    const store = makeStore({
      "__entity-index:post-type": "not-an-array",
    });
    expect(await readEntityIndex(store, "post-type")).toEqual([]);
  });
});

describe("writeEntityIndex", () => {
  test("sorts and dedupes", async () => {
    const store = makeStore();
    await writeEntityIndex(store, "post-type", [
      "monthly",
      "weekly",
      "ad-hoc",
      "weekly", // dup
    ]);
    expect(store.data.get("__entity-index:post-type")).toEqual([
      "ad-hoc",
      "monthly",
      "weekly",
    ]);
  });

  test("filters invalid slugs from the persisted set", async () => {
    const store = makeStore();
    await writeEntityIndex(store, "post-type", [
      "weekly",
      "BAD",
      "ad-hoc",
    ]);
    expect(store.data.get("__entity-index:post-type")).toEqual([
      "ad-hoc",
      "weekly",
    ]);
  });

  test("empty input writes []", async () => {
    const store = makeStore();
    await writeEntityIndex(store, "post-type", []);
    expect(store.data.get("__entity-index:post-type")).toEqual([]);
  });
});

// ── CRUD primitives ─────────────────────────────────────────────

describe("readEntityRecord", () => {
  test("returns null when record is absent", async () => {
    const store = makeStore();
    expect(await readEntityRecord(store, "post-type", "weekly")).toBeNull();
  });

  test("returns {slug, data} when record exists", async () => {
    const store = makeStore({
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    expect(await readEntityRecord(store, "post-type", "weekly")).toEqual({
      slug: "weekly",
      data: { name: "Weekly", systemPrompt: "x" },
    });
  });

  test("returns null when stored value is explicitly null", async () => {
    const store = makeStore({
      "__entity:post-type:weekly": null,
    });
    expect(await readEntityRecord(store, "post-type", "weekly")).toBeNull();
  });
});

describe("writeEntityRecord", () => {
  test("writes record AND appends slug to fresh index", async () => {
    const store = makeStore();
    await writeEntityRecord(store, "post-type", "weekly", {
      name: "Weekly",
      systemPrompt: "x",
    });
    expect(store.data.get("__entity:post-type:weekly")).toEqual({
      name: "Weekly",
      systemPrompt: "x",
    });
    expect(store.data.get("__entity-index:post-type")).toEqual(["weekly"]);
  });

  test("appends to existing index without disturbing other slugs", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["monthly", "ad-hoc"],
      "__entity:post-type:monthly": { name: "Monthly", systemPrompt: "x" },
      "__entity:post-type:ad-hoc": { name: "Ad-hoc", systemPrompt: "y" },
    });
    await writeEntityRecord(store, "post-type", "weekly", {
      name: "Weekly",
      systemPrompt: "z",
    });
    expect(store.data.get("__entity-index:post-type")).toEqual([
      "ad-hoc",
      "monthly",
      "weekly",
    ]);
  });

  test("re-writing the same slug doesn't duplicate the index entry", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": { name: "Old", systemPrompt: "x" },
    });
    await writeEntityRecord(store, "post-type", "weekly", {
      name: "New",
      systemPrompt: "y",
    });
    expect(store.data.get("__entity-index:post-type")).toEqual(["weekly"]);
    expect(store.data.get("__entity:post-type:weekly")).toEqual({
      name: "New",
      systemPrompt: "y",
    });
  });
});

describe("deleteEntityRecord", () => {
  test("deletes record + removes from index", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["ad-hoc", "monthly", "weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
      "__entity:post-type:monthly": { name: "Monthly", systemPrompt: "y" },
      "__entity:post-type:ad-hoc": { name: "Ad-hoc", systemPrompt: "z" },
    });
    expect(await deleteEntityRecord(store, "post-type", "weekly")).toBe(true);
    expect(store.data.has("__entity:post-type:weekly")).toBe(false);
    expect(store.data.get("__entity-index:post-type")).toEqual([
      "ad-hoc",
      "monthly",
    ]);
  });

  test("missing record returns false (no-op)", async () => {
    const store = makeStore();
    expect(await deleteEntityRecord(store, "post-type", "weekly")).toBe(false);
  });

  test("orphan slug in index is self-healed (record absent, index dirty)", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly", "ghost"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    expect(await deleteEntityRecord(store, "post-type", "ghost")).toBe(false);
    // Index should be cleaned even though there was no record to delete
    expect(store.data.get("__entity-index:post-type")).toEqual(["weekly"]);
  });
});

describe("listEntityRecords", () => {
  test("returns [] for empty index", async () => {
    const store = makeStore();
    expect(await listEntityRecords(store, "post-type")).toEqual([]);
  });

  test("returns all records for indexed slugs", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly", "monthly"],
      "__entity:post-type:weekly": { name: "Weekly" },
      "__entity:post-type:monthly": { name: "Monthly" },
    });
    const items = await listEntityRecords(store, "post-type");
    expect(items).toEqual([
      { slug: "weekly", data: { name: "Weekly" } },
      { slug: "monthly", data: { name: "Monthly" } },
    ]);
  });

  test("filters out slugs whose record is missing (index drift)", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly", "ghost"],
      "__entity:post-type:weekly": { name: "Weekly" },
    });
    const items = await listEntityRecords(store, "post-type");
    expect(items).toEqual([{ slug: "weekly", data: { name: "Weekly" } }]);
  });
});

// ── Error propagation ──────────────────────────────────────────

describe("error propagation from backing store", () => {
  test("writeEntityRecord rethrows storage failure", async () => {
    const store = makeStore();
    store.failOn = {
      key: "__entity:post-type:weekly",
      op: "set",
      err: new Error("storage offline"),
    };
    expect(
      writeEntityRecord(store, "post-type", "weekly", { name: "x" }),
    ).rejects.toThrow(/storage offline/);
  });

  test("readEntityRecord rethrows storage failure", async () => {
    const store = makeStore();
    store.failOn = {
      key: "__entity:post-type:weekly",
      op: "get",
      err: new Error("storage offline"),
    };
    expect(
      readEntityRecord(store, "post-type", "weekly"),
    ).rejects.toThrow(/storage offline/);
  });
});
