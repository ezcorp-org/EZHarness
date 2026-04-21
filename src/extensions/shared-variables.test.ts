import { test, expect, describe } from "bun:test";
import { resolveSharedVariables, getSharedDefaults, SHARED_VARIABLE_RESOLVERS } from "./shared-variables";
import { basename } from "node:path";

// ── Unit: SHARED_VARIABLE_RESOLVERS ─────────────────────────────────────

describe("SHARED_VARIABLE_RESOLVERS", () => {
  test("project.cwd returns cwd", () => {
    expect(SHARED_VARIABLE_RESOLVERS["project.cwd"]!()).toBe(process.cwd());
  });

  test("project.name returns basename of cwd", () => {
    expect(SHARED_VARIABLE_RESOLVERS["project.name"]!()).toBe(basename(process.cwd()));
  });

  test("all resolver keys are strings", () => {
    for (const [key, fn] of Object.entries(SHARED_VARIABLE_RESOLVERS)) {
      expect(typeof key).toBe("string");
      expect(typeof fn()).toBe("string");
    }
  });

  test("resolvers return non-empty strings", () => {
    for (const fn of Object.values(SHARED_VARIABLE_RESOLVERS)) {
      expect(fn().length).toBeGreaterThan(0);
    }
  });
});

// ── Unit: resolveSharedVariables ─────────────────────────────────────────

describe("resolveSharedVariables", () => {
  const schema = {
    type: "object",
    properties: {
      sourcePath: { type: "string", "x-shared": "project.cwd" },
      convention: { type: "string" },
    },
  };

  test("fills missing x-shared field", () => {
    const result = resolveSharedVariables(schema, { convention: "camelCase" });
    expect(result.sourcePath).toBe(process.cwd());
    expect(result.convention).toBe("camelCase");
  });

  test("fills empty string x-shared field", () => {
    const result = resolveSharedVariables(schema, { sourcePath: "", convention: "camelCase" });
    expect(result.sourcePath).toBe(process.cwd());
  });

  test("fills null x-shared field", () => {
    const result = resolveSharedVariables(schema, { sourcePath: null, convention: "camelCase" });
    expect(result.sourcePath).toBe(process.cwd());
  });

  test("does not overwrite provided value", () => {
    const result = resolveSharedVariables(schema, { sourcePath: "/custom/path", convention: "camelCase" });
    expect(result.sourcePath).toBe("/custom/path");
  });

  test("does not overwrite whitespace-only value", () => {
    const result = resolveSharedVariables(schema, { sourcePath: "  ", convention: "camelCase" });
    expect(result.sourcePath).toBe("  ");
  });

  test("does not mutate original args", () => {
    const args = { convention: "camelCase" };
    const result = resolveSharedVariables(schema, args);
    expect(args).toEqual({ convention: "camelCase" });
    expect(result).not.toBe(args);
  });

  test("handles schema with no properties", () => {
    const result = resolveSharedVariables({ type: "object" }, { foo: "bar" });
    expect(result).toEqual({ foo: "bar" });
  });

  test("handles empty properties object", () => {
    const result = resolveSharedVariables({ type: "object", properties: {} }, { foo: "bar" });
    expect(result).toEqual({ foo: "bar" });
  });

  test("ignores unknown x-shared keys", () => {
    const schema2 = {
      type: "object",
      properties: {
        field: { type: "string", "x-shared": "unknown.var" },
      },
    };
    const result = resolveSharedVariables(schema2, {});
    expect(result.field).toBeUndefined();
  });

  test("resolves multiple x-shared fields in one schema", () => {
    const multiSchema = {
      type: "object",
      properties: {
        path: { type: "string", "x-shared": "project.cwd" },
        name: { type: "string", "x-shared": "project.name" },
        other: { type: "string" },
      },
    };
    const result = resolveSharedVariables(multiSchema, { other: "keep" });
    expect(result.path).toBe(process.cwd());
    expect(result.name).toBe(basename(process.cwd()));
    expect(result.other).toBe("keep");
  });

  test("preserves extra args not in schema", () => {
    const result = resolveSharedVariables(schema, { convention: "camelCase", extraArg: 42 });
    expect(result.extraArg).toBe(42);
    expect(result.convention).toBe("camelCase");
  });

  test("handles undefined args for x-shared field", () => {
    const result = resolveSharedVariables(schema, { sourcePath: undefined });
    expect(result.sourcePath).toBe(process.cwd());
  });
});

// ── Unit: getSharedDefaults ─────────────────────────────────────────────

describe("getSharedDefaults", () => {
  test("returns defaults for x-shared fields", () => {
    const schema = {
      type: "object",
      properties: {
        sourcePath: { type: "string", "x-shared": "project.cwd" },
        name: { type: "string", "x-shared": "project.name" },
        other: { type: "string" },
      },
    };
    const defaults = getSharedDefaults(schema);
    expect(defaults.sourcePath).toBe(process.cwd());
    expect(defaults.name).toBe(basename(process.cwd()));
    expect(defaults.other).toBeUndefined();
  });

  test("returns empty for schema without x-shared", () => {
    const schema = { type: "object", properties: { foo: { type: "string" } } };
    expect(getSharedDefaults(schema)).toEqual({});
  });

  test("returns empty for schema with no properties", () => {
    expect(getSharedDefaults({ type: "object" })).toEqual({});
  });

  test("skips unknown x-shared keys", () => {
    const schema = {
      type: "object",
      properties: {
        field: { type: "string", "x-shared": "nonexistent.var" },
      },
    };
    expect(getSharedDefaults(schema)).toEqual({});
  });

  test("return type values are all strings", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", "x-shared": "project.cwd" },
        b: { type: "string", "x-shared": "project.name" },
      },
    };
    const defaults = getSharedDefaults(schema);
    for (const val of Object.values(defaults)) {
      expect(typeof val).toBe("string");
    }
  });
});
