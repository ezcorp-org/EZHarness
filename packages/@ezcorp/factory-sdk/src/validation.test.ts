import { describe, expect, test } from "bun:test";
import { firstValidationIssue, isSchemaContained, validatePortSchema, validateValue } from "./validation";
import type { PortSchema } from "./types";

const closedObject: PortSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 4 },
    count: { type: "integer", minimum: 0, maximum: 10 },
    tags: { type: "array", items: { type: ["string", "null"] }, minItems: 1, maxItems: 2 },
  },
  required: ["name", "count"],
  additionalProperties: false,
};

describe("port schema validation", () => {
  test("accepts the complete supported subset and escaped local pointers", () => {
    const schema: PortSchema = {
      $defs: { "a/b~c": { type: "string", enum: ["x", "y"], title: "value", description: "value" } },
      $ref: "#/$defs/a~1b~0c",
    };
    expect(validatePortSchema(schema)).toEqual({ ok: true });
    expect(validateValue(schema, "x")).toEqual({ ok: true });
    expect(validatePortSchema(closedObject)).toEqual({ ok: true });
    expect(validatePortSchema({ type: "string", const: "x" })).toEqual({ ok: true });
  });

  test("rejects unknown keywords and malformed keyword shapes without throwing", () => {
    const invalid: unknown[] = [
      null, [], { type: "string", pattern: ".*" }, { type: "wat" }, { type: [] },
      { type: ["string", "number"] }, { type: ["string", "null", "number"] },
      { type: "object", properties: null }, { type: "object", $defs: null },
      { type: "array", items: [] }, { type: "object", required: "x" },
      { type: "object", additionalProperties: {} }, { type: "string", enum: [] },
      { type: "string", title: 1 }, { type: "string", description: 1 },
      { type: "string", minLength: -1 }, { type: "number", minimum: Number.NaN },
      { type: "array", minItems: 2, maxItems: 1 }, { type: "string", minLength: 2, maxLength: 1 },
      { type: "number", minimum: 2, maximum: 1 }, { type: "string", const: undefined },
      { type: "string", enum: ["x", "x"] }, { type: "string", enum: [Number.NaN] },
      { type: "object", properties: { x: { type: "string" } }, required: ["y"] },
      { type: "object", properties: { x: { type: "string" } }, required: ["x", "x"] },
      { $ref: 1 }, { $ref: "https://example.test/schema" }, { $ref: "#/missing" },
      { $ref: "#/$defs/x", type: "string", $defs: { x: { type: "string" } } },
    ];
    for (const schema of invalid) expect(validatePortSchema(schema as PortSchema).ok).toBe(false);
  });

  test("rejects recursive reference graphs but accepts transitive acyclic refs", () => {
    expect(validatePortSchema({ $defs: { value: { type: "string" }, alias: { $ref: "#/$defs/value" } }, $ref: "#/$defs/alias" })).toEqual({ ok: true });
    expect(validatePortSchema({ $defs: { value: { $ref: "#" } }, $ref: "#/$defs/value" }).ok).toBe(false);
    const direct: PortSchema = { type: "array" };
    (direct as { items?: PortSchema }).items = direct;
    expect(validatePortSchema(direct).ok).toBe(false);
  });
});

describe("runtime value validation", () => {
  test("validates objects, arrays, Unicode lengths, ranges, enum and const", () => {
    expect(validateValue(closedObject, { name: "🌳", count: 2, tags: ["x", null] })).toEqual({ ok: true });
    const failures: unknown[] = [
      null, { name: "", count: 2 }, { name: "abcde", count: 2 }, { name: "x", count: -1 },
      { name: "x", count: 11 }, { name: "x", count: 2, tags: [] },
      { name: "x", count: 2, tags: ["a", "b", "c"] }, { name: "x", count: 2, extra: true },
      { name: "x", count: 2.5 }, { name: "x", count: 2, tags: [1] },
    ];
    for (const value of failures) expect(validateValue(closedObject, value as never).ok).toBe(false);
    expect(validateValue({ type: "string", enum: ["x"] }, "y").ok).toBe(false);
    expect(validateValue({ type: "string", const: "x" }, "y").ok).toBe(false);
  });

  test("rejects invalid I-JSON through permissive schemas", () => {
    expect(validateValue({ type: "object", additionalProperties: true }, { x: Number.NaN } as never).ok).toBe(false);
    expect(validateValue({ type: "array" }, [9_007_199_254_740_992] as never).ok).toBe(false);
    expect(validateValue({ type: "string" }, "\ud800").ok).toBe(false);
    const invalidSchema = validateValue({ type: "object", pattern: "x" } as never, {});
    expect(firstValidationIssue(invalidSchema)?.code).toBe("SCHEMA_KEYWORD_UNSUPPORTED");
    expect(firstValidationIssue({ ok: true })).toBeUndefined();
  });
});

describe("conservative containment", () => {
  test("proves structural, range, enum, array, and integer subsets", () => {
    expect(isSchemaContained(closedObject, { type: "object", properties: { name: { type: "string", maxLength: 5 } }, required: ["name"], additionalProperties: true })).toBe(true);
    expect(isSchemaContained({ type: "integer", minimum: 2, maximum: 3 }, { type: "number", minimum: 1, maximum: 4 })).toBe(true);
    expect(isSchemaContained({ type: "string", enum: ["a"] }, { type: "string", enum: ["a", "b"] })).toBe(true);
    expect(isSchemaContained({ type: "string", const: "a" }, { type: "string", const: "a" })).toBe(true);
    expect(isSchemaContained({ type: "array", items: { type: "integer" }, minItems: 1, maxItems: 2 }, { type: "array", items: { type: "number" }, minItems: 0, maxItems: 3 })).toBe(true);
  });

  test("rejects every uncertain containment case and transitive mismatches", () => {
    const uncertain: [PortSchema, PortSchema][] = [
      [{ type: "number" }, { type: "integer" }],
      [{ type: "string" }, { type: "string", const: "a" }],
      [{ type: "string" }, { type: "string", enum: ["a"] }],
      [{ type: "number" }, { type: "number", minimum: 0 }],
      [{ type: "number" }, { type: "number", maximum: 1 }],
      [{ type: "string" }, { type: "string", minLength: 1 }],
      [{ type: "string" }, { type: "string", maxLength: 1 }],
      [{ type: "array" }, { type: "array", items: { type: "string" } }],
      [{ type: "object", properties: {}, additionalProperties: true }, { type: "object", properties: { count: { type: "integer" } }, additionalProperties: true }],
      [{ type: "object", properties: {}, additionalProperties: true }, { type: "object", additionalProperties: false }],
      [{ type: "object", properties: {}, additionalProperties: false }, { type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false }],
      [{ $defs: { value: { type: "string" }, alias: { $ref: "#/$defs/value" } }, $ref: "#/$defs/alias" }, { type: "integer" }],
      [{ type: "string", pattern: "x" } as never, { type: "string" }],
    ];
    for (const [producer, consumer] of uncertain) expect(isSchemaContained(producer, consumer)).toBe(false);
  });
});
