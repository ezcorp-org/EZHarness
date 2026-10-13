// ── Phase 3 — entities manifest validation ─────────────────────
//
// Exercises the `validateManifestV2` extension (`entities/clamp.ts`):
// shape errors, reserved-key collisions, tool-name collisions, and the
// happy path. Pure validator-only — no DB, no registry, no install.

import { describe, expect, test } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";

function baseManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "test",
    author: { name: "tester" },
    permissions: {},
  };
}

describe("validateManifestV2 — entities[] happy path", () => {
  test("accepts a well-formed entity declaration", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "post-type",
        label: "Post Type",
        pluralLabel: "Post Types",
        scope: "user",
        schema: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            systemPrompt: { type: "string" },
          },
          required: ["name", "systemPrompt"],
          additionalProperties: false,
        },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  test("accepts seed with valid slug + data", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "post-type",
        label: "Post Type",
        pluralLabel: "Post Types",
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        seed: [{ slug: "weekly", data: { name: "Weekly" } }],
      },
    ];
    const res = validateManifestV2(m);
    expect(res.errors).toEqual([]);
  });
});

describe("validateManifestV2 — entities[] shape errors", () => {
  test("rejects when entities is not an array", () => {
    const m = baseManifest();
    m.entities = { foo: "bar" };
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("entities must be an array"))).toBe(true);
  });

  test("rejects entity with malformed type", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "Bad Type With Spaces",
        label: "X",
        pluralLabel: "Xs",
        schema: { type: "object" },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("entities[0].type"))).toBe(true);
  });

  test("rejects duplicate type within same manifest", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "post-type",
        label: "Post Type",
        pluralLabel: "Post Types",
        schema: { type: "object" },
      },
      {
        type: "post-type",
        label: "Other Post Type",
        pluralLabel: "Other Post Types",
        schema: { type: "object" },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("declared more than once"))).toBe(true);
  });

  test("rejects missing labels", () => {
    const m = baseManifest();
    m.entities = [{ type: "x", schema: { type: "object" } }];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("entities[0].label"))).toBe(true);
    expect(res.errors.some((e) => e.includes("entities[0].pluralLabel"))).toBe(true);
  });

  test("rejects non-object schema root", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "x",
        label: "X",
        pluralLabel: "Xs",
        schema: { type: "string" },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('schema.type must be "object"'))).toBe(true);
  });

  test("rejects schema with unknown leaf type", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "x",
        label: "X",
        pluralLabel: "Xs",
        schema: {
          type: "object",
          properties: { weird: { type: "uuid" } },
        },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("properties.weird.type"))).toBe(true);
  });

  test("rejects invalid scope value", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "x",
        label: "X",
        pluralLabel: "Xs",
        scope: "global",
        schema: { type: "object" },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("scope must be one of"))).toBe(true);
  });

  test("rejects malformed regex in schema", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "x",
        label: "X",
        pluralLabel: "Xs",
        schema: {
          type: "object",
          properties: { tag: { type: "string", pattern: "[unclosed" } },
        },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.includes("pattern is not a valid regex")),
    ).toBe(true);
  });

  test("rejects empty enum array", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "x",
        label: "X",
        pluralLabel: "Xs",
        schema: {
          type: "object",
          properties: { cadence: { type: "string", enum: [] } },
        },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("enum must be a non-empty"))).toBe(true);
  });

  test("rejects malformed seed entry", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "x",
        label: "X",
        pluralLabel: "Xs",
        schema: { type: "object" },
        seed: [{ slug: 42, data: { foo: "bar" } }],
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("seed[0].slug"))).toBe(true);
  });

  test("rejects seed.data that is not an object", () => {
    const m = baseManifest();
    m.entities = [
      {
        type: "x",
        label: "X",
        pluralLabel: "Xs",
        schema: { type: "object" },
        seed: [{ slug: "ok", data: "not an object" }],
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("seed[0].data"))).toBe(true);
  });
});

describe("validateManifestV2 — reserved-key + collision checks", () => {
  test("rejects settings key starting with __entity:", () => {
    const m = baseManifest();
    // The settings validator also rejects this key (keys must start with a
    // lowercase letter); the entity clamp names the reserved namespace.
    m.settings = { "__entity:thing": { type: "text", label: "X" } };
    m.entities = [
      {
        type: "x",
        label: "X",
        pluralLabel: "Xs",
        schema: { type: "object" },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(res.errors).toContain(
      'settings key "__entity:thing" uses reserved entity namespace (__entity:* / __entity-index:*)',
    );
  });

  test("rejects tools[].name in reserved namespace", () => {
    const m = baseManifest();
    m.entrypoint = "./index.ts";
    m.tools = [
      {
        // Names that literally start with `__entity:` are the only
        // forms that would collide with the SDK's reserved storage
        // keys. Tool-name validators may reject the colon for tool
        // naming reasons (Anthropic's tool-name regex disallows it);
        // the clamp emits the reserved-namespace error regardless
        // so the install-time message is unambiguous.
        name: "__entity:steal",
        description: "naughty",
        inputSchema: { type: "object" },
      },
    ];
    m.entities = [
      {
        type: "x",
        label: "X",
        pluralLabel: "Xs",
        schema: { type: "object" },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) =>
        e.includes("uses reserved entity namespace"),
      ),
    ).toBe(true);
  });

  test("rejects auto-tool-name collision with hand-rolled tool", () => {
    const m = baseManifest();
    m.entrypoint = "./index.ts";
    // For label="Post Type" / pluralLabel="Post Types":
    //   list_post_types, get_post_type, create_post_type, ...
    m.tools = [
      {
        name: "create_post_type",
        description: "hand-rolled CRUD",
        inputSchema: { type: "object" },
      },
    ];
    m.entities = [
      {
        type: "post-type",
        label: "Post Type",
        pluralLabel: "Post Types",
        schema: { type: "object" },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) =>
        e.includes('auto-generated tool name "create_post_type" collides'),
      ),
    ).toBe(true);
  });

  test("rejects auto-tool-name collision with settings key", () => {
    const m = baseManifest();
    m.settings = {
      list_post_types: { type: "text", label: "X" },
    };
    m.entities = [
      {
        type: "post-type",
        label: "Post Type",
        pluralLabel: "Post Types",
        schema: { type: "object" },
      },
    ];
    const res = validateManifestV2(m);
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) =>
        e.includes('auto-generated tool name "list_post_types" collides with a settings'),
      ),
    ).toBe(true);
  });
});

describe("validateManifestV2 — entity-less manifest still validates", () => {
  test("manifest without entities[] is unchanged", () => {
    const m = baseManifest();
    const res = validateManifestV2(m);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

describe("validateManifestV2 — entity schema subset and optional fields", () => {
  /** Errors for one entity whose declaration is merged over a valid one. */
  function entityErrors(overrides: Record<string, unknown>): string[] {
    const m = baseManifest();
    m.entities = [{
      type: "note",
      label: "Note",
      pluralLabel: "Notes",
      schema: { type: "object", properties: { title: { type: "string" } } },
      ...overrides,
    }];
    return validateManifestV2(m).errors;
  }

  /** Wrap `inner` as the schema of property `p` of an object schema. */
  const withProp = (inner: unknown) => ({ schema: { type: "object", properties: { p: inner } } });

  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 9; i++) deep = { type: "array", items: deep };

  test.each([
    ["a non-object entry", null, "entities[0] must be an object"],
    ["a non-object root schema type", { schema: { type: "string" } }, 'entities[0].schema.type must be "object"'],
    ["properties as an array", { schema: { type: "object", properties: [] } }, "entities[0].schema.properties must be an object map"],
    ["required as a string", { schema: { type: "object", required: "title" } }, "entities[0].schema.required must be an array of strings"],
    ["a non-string required entry", { schema: { type: "object", required: ["title", 3] } }, "entities[0].schema.required[1] must be a string"],
    ["a non-boolean additionalProperties", { schema: { type: "object", additionalProperties: {} } }, "entities[0].schema.additionalProperties must be a boolean"],
    ["a sub-schema that is not an object", withProp("string"), "entities[0].schema.properties.p: must be a JSON Schema object"],
    ["a bad array item type", withProp({ type: "array", items: { type: "date" } }), 'entities[0].schema.properties.p.items.type must be one of "object"|"string"|"number"|"boolean"|"array"'],
    ["a non-string enum entry", withProp({ type: "string", enum: ["a", 1] }), "entities[0].schema.properties.p.enum[1] must be a string"],
    ["a non-string pattern", withProp({ type: "string", pattern: 5 }), "entities[0].schema.properties.p.pattern must be a string"],
    ["a schema nested past 8 levels", withProp(deep), "entities[0].schema.properties.p.items.items.items.items.items.items.items.items: schema nests too deeply (max 8 levels)"],
    ["a non-boolean cascadeOnUninstall", { cascadeOnUninstall: "yes" }, "entities[0].cascadeOnUninstall must be a boolean"],
    ["a non-string preview", { preview: 1 }, "entities[0].preview must be a string when provided"],
    ["seed as an object", { seed: {} }, "entities[0].seed must be an array"],
  ])("rejects %s", (_label, overrides, message) => {
    const errors = overrides === null
      ? (() => { const m = baseManifest(); m.entities = [null]; return validateManifestV2(m).errors; })()
      : entityErrors(overrides as Record<string, unknown>);
    expect(errors).toContain(message);
  });

  test("accepts nested objects, arrays, numbers, booleans and a valid pattern", () => {
    expect(entityErrors({
      cascadeOnUninstall: true,
      preview: "{{title}}",
      schema: {
        type: "object",
        properties: {
          title: { type: "string", pattern: "^[a-z]+$", enum: ["a", "b"] },
          tags: { type: "array", items: { type: "string" } },
          meta: { type: "object", properties: { rank: { type: "number" }, done: { type: "boolean" } } },
        },
        required: ["title"],
        additionalProperties: false,
      },
    })).toEqual([]);
  });
});
