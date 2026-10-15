import { describe, expect, test } from "bun:test";
import { evaluateExpression, isSchemaContained, validatePortSchema, validateValue } from "@ezcorp/factory-sdk";
import type { Expression, JsonValue, PortSchema } from "@ezcorp/factory-sdk";

describe("factory public validation contract", () => {
  test("an open producer cannot guarantee a typed optional consumer field", () => {
    const producer: PortSchema = { type: "object", additionalProperties: true };
    const consumer: PortSchema = { type: "object", properties: { count: { type: "integer" } }, additionalProperties: true };
    const counterexample = { count: "untyped" };
    expect(validateValue(producer, counterexample).ok).toBe(true);
    expect(validateValue(consumer, counterexample).ok).toBe(false);
    expect(isSchemaContained(producer, consumer)).toBe(false);
  });

  test("transitive local references cannot hide incompatible ports", () => {
    const referenced = (type: "string" | "integer"): PortSchema => ({
      $ref: "#/$defs/alias",
      $defs: { alias: { $ref: "#/$defs/value" }, value: { type } },
    });
    const producer = referenced("string");
    const consumer = referenced("integer");
    expect(validatePortSchema(producer).ok).toBe(true);
    expect(validatePortSchema(consumer).ok).toBe(true);
    expect(validateValue(producer, "text").ok).toBe(true);
    expect(validateValue(consumer, "text").ok).toBe(false);
    expect(isSchemaContained(producer, consumer)).toBe(false);
  });

  test("Unicode length agrees with the port validator", () => {
    const value = "🌳";
    expect(validateValue({ type: "string", minLength: 1, maxLength: 1 }, value).ok).toBe(true);
    expect(evaluateExpression({ kind: "length", value: { kind: "literal", value } }, { inputs: {}, nodes: {} })).toEqual({ ok: true, value: 1 });
  });

  test("extra fields still must contain I-JSON", () => {
    for (const value of [Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "\ud800"]) {
      expect(validateValue({ type: "object", additionalProperties: true }, { extra: [value] }).ok).toBe(false);
    }
  });

  test("short circuit cannot hide an oversized expression", () => {
    const expression: Expression = { kind: "or", values: [{ kind: "literal", value: true }, ...Array.from({ length: 256 }, () => ({ kind: "literal" as const, value: false }))] };
    expect(evaluateExpression(expression, { inputs: {}, nodes: {} })).toMatchObject({ ok: false, code: "EXPRESSION_NODE_LIMIT" });
  });

  test("equality work has a fixed execution bound", () => {
    const left: JsonValue = Array.from({ length: 1_024 }, (_, index) => index);
    const right: JsonValue = [...left];
    expect(evaluateExpression({ kind: "eq", left: { kind: "literal", value: left }, right: { kind: "literal", value: right } }, { inputs: {}, nodes: {} })).toMatchObject({ ok: false, code: "EXPRESSION_STEP_LIMIT" });
  });

  test("own names remain data and inherited names remain absent", () => {
    const inputs = JSON.parse('{"__proto__":{"constructor":7}}') as Record<string, JsonValue>;
    expect(evaluateExpression({ kind: "ref", root: "input", name: "__proto__", path: ["constructor"] }, { inputs, nodes: {} })).toEqual({ ok: true, value: 7 });
    expect(evaluateExpression({ kind: "exists", value: { kind: "ref", root: "input", name: "toString" } }, { inputs, nodes: {} })).toEqual({ ok: true, value: false });
  });
});
