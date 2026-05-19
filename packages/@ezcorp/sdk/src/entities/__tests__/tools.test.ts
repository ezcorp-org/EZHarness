// tools.test.ts — every generated handler, every error branch
//
// Spec-required cases:
//   each generated tool (list, get, create, update, delete),
//   each error branch,
//   slug immutability on update,
//   dup-slug rejection on create,
//   missing-slug behavior on get/update/delete,
//   validation-throw on create/update with bad data,
//   soft-warning shape on read of drifted record

import { describe, expect, test } from "bun:test";

import type { ToolCallResult } from "../../types";
import type { EntityDeclaration } from "../types";
import type { EntityStoreLike } from "../storage";
import {
  buildEntityToolDefinitions,
  buildEntityToolHandlers,
  buildEntityToolMap,
  entityToolNames,
  snakeCaseToolSegment,
} from "../tools";

// ── Fixtures ────────────────────────────────────────────────────

const POST_TYPE_DECL: EntityDeclaration = {
  type: "post-type",
  label: "Post Type",
  pluralLabel: "Post Types",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      systemPrompt: { type: "string", minLength: 1, maxLength: 100_000 },
      cadence: {
        type: "string",
        enum: ["weekly", "monthly", "ad-hoc", "custom"],
      },
    },
    required: ["name", "systemPrompt"],
    additionalProperties: false,
  },
};

function makeStore(seed: Record<string, unknown> = {}): EntityStoreLike & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(seed));
  return {
    data,
    async get<T = unknown>(key: string) {
      const exists = data.has(key);
      return {
        exists,
        value: exists ? (data.get(key) as T) : (null as T | null),
      };
    },
    async set<T = unknown>(key: string, value: T) {
      data.set(key, value);
      return { ok: true };
    },
    async delete(key: string) {
      const had = data.delete(key);
      return { deleted: had };
    },
  };
}

function parseResult(res: ToolCallResult): unknown {
  expect(res.content).toHaveLength(1);
  const text = res.content[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── snakeCaseToolSegment ────────────────────────────────────────

describe("snakeCaseToolSegment", () => {
  test.each([
    ["Post Types", "post_types"],
    ["Post Type", "post_type"],
    ["Characters", "characters"],
    ["Research Playbooks", "research_playbooks"],
    ["data sources", "data_sources"],
    ["Multi   Space", "multi_space"],
    ["with-hyphen", "with_hyphen"],
    ["UPPER", "upper"],
    ["mix-of_Things 3", "mix_of_things_3"],
    ["  leading and trailing  ", "leading_and_trailing"],
  ] satisfies [string, string][])("%p → %p", (input, expected) => {
    expect(snakeCaseToolSegment(input)).toBe(expected);
  });

  test("throws on empty result", () => {
    expect(() => snakeCaseToolSegment("")).toThrow(
      /Cannot derive tool name/,
    );
    expect(() => snakeCaseToolSegment("   ")).toThrow(
      /Cannot derive tool name/,
    );
    expect(() => snakeCaseToolSegment("!@#$")).toThrow(
      /Cannot derive tool name/,
    );
  });
});

// ── entityToolNames ─────────────────────────────────────────────

describe("entityToolNames", () => {
  test("post-type derivation matches spec", () => {
    expect(entityToolNames(POST_TYPE_DECL)).toEqual({
      list: "list_post_types",
      get: "get_post_type",
      create: "create_post_type",
      update: "update_post_type",
      delete: "delete_post_type",
    });
  });

  test("characters derivation (regression — singular = plural minus 's' is NOT required)", () => {
    expect(
      entityToolNames({
        ...POST_TYPE_DECL,
        label: "Character",
        pluralLabel: "Characters",
      }),
    ).toEqual({
      list: "list_characters",
      get: "get_character",
      create: "create_character",
      update: "update_character",
      delete: "delete_character",
    });
  });

  test("accepts digit-starting label (list_/get_ prefix makes the full name valid)", () => {
    // Tool names like "list_1st_things" / "get_1st_thing" are well-formed —
    // the prefix-derived first char is always a letter, so the
    // TOOL_NAME_REGEX sanity check inside entityToolNames doesn't fire.
    expect(
      entityToolNames({
        ...POST_TYPE_DECL,
        label: "1st thing",
        pluralLabel: "1st things",
      }),
    ).toEqual({
      list: "list_1st_things",
      get: "get_1st_thing",
      create: "create_1st_thing",
      update: "update_1st_thing",
      delete: "delete_1st_thing",
    });
  });

  test("snakeCaseToolSegment throws on empty input — propagates from entityToolNames", () => {
    expect(() =>
      entityToolNames({
        ...POST_TYPE_DECL,
        label: "!!!",
        pluralLabel: "!!!",
      }),
    ).toThrow(/Cannot derive tool name/);
  });
});

// ── buildEntityToolDefinitions ──────────────────────────────────

describe("buildEntityToolDefinitions", () => {
  test("returns 5 tool definitions with correct names", () => {
    const defs = buildEntityToolDefinitions(POST_TYPE_DECL);
    expect(defs.map((d) => d.name)).toEqual([
      "list_post_types",
      "get_post_type",
      "create_post_type",
      "update_post_type",
      "delete_post_type",
    ]);
  });

  test("descriptions include label + field summary", () => {
    const defs = buildEntityToolDefinitions(POST_TYPE_DECL);
    const list = defs[0];
    expect(list?.description).toContain("Post Types");
    expect(list?.description).toContain("name: string (required)");
    expect(list?.description).toContain("systemPrompt: string (required)");
    expect(list?.description).toContain("cadence: string");
  });

  test("list/delete input schemas are minimal", () => {
    const defs = buildEntityToolDefinitions(POST_TYPE_DECL);
    expect(defs[0]?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect((defs[4]?.inputSchema as { required: string[] }).required).toEqual([
      "slug",
    ]);
  });

  test("create requires slug + data", () => {
    const defs = buildEntityToolDefinitions(POST_TYPE_DECL);
    expect((defs[2]?.inputSchema as { required: string[] }).required).toEqual([
      "slug",
      "data",
    ]);
  });

  test("update requires slug + patch", () => {
    const defs = buildEntityToolDefinitions(POST_TYPE_DECL);
    expect((defs[3]?.inputSchema as { required: string[] }).required).toEqual([
      "slug",
      "patch",
    ]);
  });
});

// ── list_<plural> ───────────────────────────────────────────────

describe("list handler", () => {
  test("empty store returns {items: []}", async () => {
    const store = makeStore();
    const { list } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await list({});
    expect(res.isError).toBe(false);
    expect(parseResult(res)).toEqual({ items: [] });
  });

  test("returns all records from index", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["monthly", "weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
      "__entity:post-type:monthly": { name: "Monthly", systemPrompt: "y" },
    });
    const { list } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await list({});
    const out = parseResult(res) as { items: { slug: string }[] };
    expect(out.items.map((i) => i.slug).sort()).toEqual(["monthly", "weekly"]);
  });

  test("attaches _validationWarning to drifted records (soft-read)", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": {
        name: "Weekly",
        systemPrompt: "x",
        cadence: "biweekly", // not in enum
      },
    });
    const { list } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await list({});
    const out = parseResult(res) as {
      items: Array<{ _validationWarning?: { code: string } }>;
    };
    expect(out.items[0]?._validationWarning?.code).toBe("SCHEMA_DRIFT");
  });

  test("softRead=false omits warnings even on drift", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": {
        name: "Weekly",
        systemPrompt: "x",
        cadence: "biweekly",
      },
    });
    const { list } = buildEntityToolHandlers(POST_TYPE_DECL, store, {
      softRead: false,
    });
    const res = await list({});
    const out = parseResult(res) as {
      items: Array<{ _validationWarning?: unknown }>;
    };
    expect(out.items[0]?._validationWarning).toBeUndefined();
  });

  test("propagates storage failure as isError", async () => {
    const failingStore: EntityStoreLike = {
      async get() {
        throw new Error("storage offline");
      },
      async set() {
        return { ok: true };
      },
      async delete() {
        return { deleted: false };
      },
    };
    const { list } = buildEntityToolHandlers(POST_TYPE_DECL, failingStore);
    const res = await list({});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("storage offline");
  });
});

// ── get_<singular> ──────────────────────────────────────────────

describe("get handler", () => {
  test("returns record by slug", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    const { get } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await get({ slug: "weekly" });
    expect(res.isError).toBe(false);
    expect(parseResult(res)).toEqual({
      slug: "weekly",
      data: { name: "Weekly", systemPrompt: "x" },
    });
  });

  test("missing slug → NOT_FOUND error", async () => {
    const store = makeStore();
    const { get } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await get({ slug: "ghost" });
    expect(res.isError).toBe(true);
    expect((res as ToolCallResult & { code?: string }).code).toBe(
      "NOT_FOUND",
    );
  });

  test("non-string slug rejected before storage", async () => {
    const store = makeStore();
    const { get } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await get({ slug: 42 });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/requires a string 'slug'/);
  });

  test("invalid slug shape rejected", async () => {
    const store = makeStore();
    const { get } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await get({ slug: "BAD" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/invalid slug/);
  });

  test("attaches _validationWarning on drift", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": {
        name: "Weekly",
        systemPrompt: "x",
        cadence: "biweekly",
      },
    });
    const { get } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await get({ slug: "weekly" });
    const out = parseResult(res) as {
      _validationWarning?: { code: string; issues: unknown[] };
    };
    expect(out._validationWarning?.code).toBe("SCHEMA_DRIFT");
  });

  test("softRead=false omits warnings", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": {
        name: "Weekly",
        systemPrompt: "x",
        cadence: "biweekly",
      },
    });
    const { get } = buildEntityToolHandlers(POST_TYPE_DECL, store, {
      softRead: false,
    });
    const res = await get({ slug: "weekly" });
    const out = parseResult(res) as { _validationWarning?: unknown };
    expect(out._validationWarning).toBeUndefined();
  });

  test("storage failure produces isError result", async () => {
    const failingStore: EntityStoreLike = {
      async get() {
        throw new Error("storage offline");
      },
      async set() {
        return { ok: true };
      },
      async delete() {
        return { deleted: false };
      },
    };
    const { get } = buildEntityToolHandlers(POST_TYPE_DECL, failingStore);
    const res = await get({ slug: "weekly" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("storage offline");
  });
});

// ── create_<singular> ───────────────────────────────────────────

describe("create handler", () => {
  test("creates a record + writes index entry", async () => {
    const store = makeStore();
    const { create } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await create({
      slug: "weekly",
      data: { name: "Weekly", systemPrompt: "Write a weekly roundup." },
    });
    expect(res.isError).toBe(false);
    expect(store.data.get("__entity:post-type:weekly")).toEqual({
      name: "Weekly",
      systemPrompt: "Write a weekly roundup.",
    });
    expect(store.data.get("__entity-index:post-type")).toEqual(["weekly"]);
  });

  test("dup slug → ALREADY_EXISTS (caught via index)", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    const { create } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await create({
      slug: "weekly",
      data: { name: "Other", systemPrompt: "y" },
    });
    expect(res.isError).toBe(true);
    expect((res as ToolCallResult & { code?: string }).code).toBe(
      "ALREADY_EXISTS",
    );
  });

  test("dup slug detected via direct record read when index is empty", async () => {
    const store = makeStore({
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    const { create } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await create({
      slug: "weekly",
      data: { name: "Other", systemPrompt: "y" },
    });
    expect(res.isError).toBe(true);
    expect((res as ToolCallResult & { code?: string }).code).toBe(
      "ALREADY_EXISTS",
    );
  });

  test("validation failure → VALIDATION_FAILED", async () => {
    const store = makeStore();
    const { create } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await create({
      slug: "weekly",
      data: { name: "Weekly" }, // missing systemPrompt
    });
    expect(res.isError).toBe(true);
    expect((res as ToolCallResult & { code?: string }).code).toBe(
      "VALIDATION_FAILED",
    );
    expect(res.content[0]?.text).toContain("systemPrompt");
  });

  test("non-string slug", async () => {
    const store = makeStore();
    const { create } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await create({ slug: 42, data: { name: "x", systemPrompt: "y" } });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/requires a string 'slug'/);
  });

  test("invalid slug shape", async () => {
    const store = makeStore();
    const { create } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await create({
      slug: "BAD",
      data: { name: "x", systemPrompt: "y" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/invalid slug/);
  });

  test("non-object data", async () => {
    const store = makeStore();
    const { create } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    for (const bad of ["not-an-object", null, undefined, [1, 2, 3], 42]) {
      const res = await create({ slug: "weekly", data: bad });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/requires an object 'data'/);
    }
  });

  test("storage failure during write", async () => {
    const failingStore: EntityStoreLike = {
      async get() {
        return { value: null, exists: false };
      },
      async set() {
        throw new Error("storage offline");
      },
      async delete() {
        return { deleted: false };
      },
    };
    const { create } = buildEntityToolHandlers(POST_TYPE_DECL, failingStore);
    const res = await create({
      slug: "weekly",
      data: { name: "x", systemPrompt: "y" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("storage offline");
  });
});

// ── update_<singular> ───────────────────────────────────────────

describe("update handler", () => {
  test("shallow-merges patch + re-validates", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": {
        name: "Old",
        systemPrompt: "x",
        cadence: "weekly",
      },
    });
    const { update } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await update({ slug: "weekly", patch: { name: "New" } });
    expect(res.isError).toBe(false);
    expect(store.data.get("__entity:post-type:weekly")).toEqual({
      name: "New",
      systemPrompt: "x",
      cadence: "weekly",
    });
  });

  test("slug-immutable: rejects patch.slug", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    const { update } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await update({
      slug: "weekly",
      patch: { slug: "renamed" },
    });
    expect(res.isError).toBe(true);
    expect((res as ToolCallResult & { code?: string }).code).toBe(
      "SLUG_IMMUTABLE",
    );
  });

  test("missing slug → NOT_FOUND", async () => {
    const store = makeStore();
    const { update } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await update({ slug: "ghost", patch: { name: "x" } });
    expect(res.isError).toBe(true);
    expect((res as ToolCallResult & { code?: string }).code).toBe(
      "NOT_FOUND",
    );
  });

  test("invalid patch (validation fails on merged result)", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    const { update } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await update({
      slug: "weekly",
      patch: { cadence: "biweekly" }, // not in enum
    });
    expect(res.isError).toBe(true);
    expect((res as ToolCallResult & { code?: string }).code).toBe(
      "VALIDATION_FAILED",
    );
  });

  test("non-object patch", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    const { update } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    for (const bad of ["str", 42, null, undefined, [1, 2]]) {
      const res = await update({ slug: "weekly", patch: bad });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/requires an object 'patch'/);
    }
  });

  test("non-string slug", async () => {
    const store = makeStore();
    const { update } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await update({ slug: 42, patch: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/requires a string 'slug'/);
  });

  test("invalid slug shape", async () => {
    const store = makeStore();
    const { update } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await update({ slug: "BAD", patch: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/invalid slug/);
  });

  test("storage failure during write", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    // override set after first read
    let setCount = 0;
    const orig = store.set.bind(store);
    store.set = async (key, value) => {
      setCount++;
      if (setCount > 0) throw new Error("storage offline");
      return orig(key, value);
    };
    const { update } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await update({ slug: "weekly", patch: { name: "New" } });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("storage offline");
  });
});

// ── delete_<singular> ───────────────────────────────────────────

describe("delete handler", () => {
  test("deletes existing record + updates index", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["monthly", "weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
      "__entity:post-type:monthly": { name: "Monthly", systemPrompt: "y" },
    });
    const { delete: del } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await del({ slug: "weekly" });
    expect(res.isError).toBe(false);
    expect(parseResult(res)).toEqual({ deleted: true });
    expect(store.data.has("__entity:post-type:weekly")).toBe(false);
    expect(store.data.get("__entity-index:post-type")).toEqual(["monthly"]);
  });

  test("missing slug → {deleted: false} (no error)", async () => {
    const store = makeStore();
    const { delete: del } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await del({ slug: "ghost" });
    expect(res.isError).toBe(false);
    expect(parseResult(res)).toEqual({ deleted: false });
  });

  test("non-string slug", async () => {
    const store = makeStore();
    const { delete: del } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await del({ slug: 42 });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/requires a string 'slug'/);
  });

  test("invalid slug shape", async () => {
    const store = makeStore();
    const { delete: del } = buildEntityToolHandlers(POST_TYPE_DECL, store);
    const res = await del({ slug: "BAD" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/invalid slug/);
  });

  test("storage failure", async () => {
    const failingStore: EntityStoreLike = {
      async get() {
        throw new Error("storage offline");
      },
      async set() {
        return { ok: true };
      },
      async delete() {
        return { deleted: false };
      },
    };
    const { delete: del } = buildEntityToolHandlers(
      POST_TYPE_DECL,
      failingStore,
    );
    const res = await del({ slug: "weekly" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("storage offline");
  });
});

// ── buildEntityToolMap ──────────────────────────────────────────

describe("buildEntityToolMap", () => {
  test("returns the 5 tools keyed by name", () => {
    const store = makeStore();
    const map = buildEntityToolMap(POST_TYPE_DECL, store);
    expect(Object.keys(map).sort()).toEqual(
      [
        "create_post_type",
        "delete_post_type",
        "get_post_type",
        "list_post_types",
        "update_post_type",
      ].sort(),
    );
  });

  test("returned handlers dispatch through the store", async () => {
    const store = makeStore();
    const map = buildEntityToolMap(POST_TYPE_DECL, store);
    const createHandler = map.create_post_type;
    expect(createHandler).toBeDefined();
    const res = await (createHandler as NonNullable<typeof createHandler>)({
      slug: "weekly",
      data: { name: "Weekly", systemPrompt: "x" },
    });
    expect(res.isError).toBe(false);
    expect(store.data.get("__entity-index:post-type")).toEqual(["weekly"]);
  });

  test("respects softRead option", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": {
        name: "Weekly",
        systemPrompt: "x",
        cadence: "BAD-ENUM",
      },
    });
    const map = buildEntityToolMap(POST_TYPE_DECL, store, { softRead: false });
    const handler = map.get_post_type;
    expect(handler).toBeDefined();
    const res = await (handler as NonNullable<typeof handler>)({
      slug: "weekly",
    });
    const out = parseResult(res) as { _validationWarning?: unknown };
    expect(out._validationWarning).toBeUndefined();
  });
});
