/**
 * Unit tests for src/runtime/structured-output.ts (Phase B1).
 *
 * Covers the standard-JSON-Schema subset validator (every supported
 * keyword, valid + invalid), the JSON extraction variants (raw, fenced,
 * trailing prose, none), malformed-schema handling, the issue summarizer,
 * and the prompt-fragment builders.
 */

import { test, expect, describe } from "bun:test";
import {
  extractJsonCandidate,
  validateAgainstSchema,
  validateStructuredOutput,
  summarizeIssues,
  buildSchemaInstruction,
  buildSchemaCorrection,
  type SchemaIssue,
} from "../runtime/structured-output";

// ── extractJsonCandidate ───────────────────────────────────────────

describe("extractJsonCandidate", () => {
  test("empty / whitespace-only → not found", () => {
    expect(extractJsonCandidate("")).toEqual({ found: false });
    expect(extractJsonCandidate("   \n\t ")).toEqual({ found: false });
  });

  test("raw JSON object (whole text) → found", () => {
    expect(extractJsonCandidate('{"a":1}')).toEqual({ found: true, value: { a: 1 } });
  });

  test("```json fenced block → found", () => {
    const text = "Here is the result:\n```json\n{\"verdict\":\"pass\"}\n```";
    expect(extractJsonCandidate(text)).toEqual({ found: true, value: { verdict: "pass" } });
  });

  test("bare ``` fence (no json tag) → found", () => {
    const text = "```\n{\"n\":2}\n```";
    expect(extractJsonCandidate(text)).toEqual({ found: true, value: { n: 2 } });
  });

  test("multiple fences → LAST one wins (final answer)", () => {
    const text = "```json\n{\"draft\":1}\n```\nrefined:\n```json\n{\"final\":2}\n```";
    expect(extractJsonCandidate(text)).toEqual({ found: true, value: { final: 2 } });
  });

  test("trailing prose after JSON → brace-substring fallback parses", () => {
    // Whole-text parse fails (leading prose); the {…} substring succeeds,
    // exercising the try/catch-then-next-candidate path.
    const text = "Sure, here you go: {\"ok\":true} — hope that helps!";
    expect(extractJsonCandidate(text)).toEqual({ found: true, value: { ok: true } });
  });

  test("no JSON anywhere → not found", () => {
    expect(extractJsonCandidate("just some prose, no json at all")).toEqual({ found: false });
  });

  test("non-object JSON (raw array) still parses", () => {
    expect(extractJsonCandidate("[1,2,3]")).toEqual({ found: true, value: [1, 2, 3] });
  });

  test("open brace without a close is skipped (no substring candidate)", () => {
    expect(extractJsonCandidate("this { is not closed")).toEqual({ found: false });
  });
});

// ── validateAgainstSchema — primitives ─────────────────────────────

function issuesFor(schema: unknown, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateAgainstSchema(schema, value, "", issues);
  return issues;
}

describe("validateAgainstSchema — primitive types", () => {
  test("string: pass + fail", () => {
    expect(issuesFor({ type: "string" }, "hi")).toEqual([]);
    expect(issuesFor({ type: "string" }, 5)).toEqual([
      { path: "", message: "expected string, got number" },
    ]);
  });

  test("number: pass, reject non-number, reject NaN/Infinity", () => {
    expect(issuesFor({ type: "number" }, 3.14)).toEqual([]);
    expect(issuesFor({ type: "number" }, "3")).toEqual([
      { path: "", message: "expected number, got string" },
    ]);
    expect(issuesFor({ type: "number" }, Number.NaN)).toHaveLength(1);
    expect(issuesFor({ type: "number" }, Number.POSITIVE_INFINITY)).toHaveLength(1);
  });

  test("integer: pass + reject float + reject non-number", () => {
    expect(issuesFor({ type: "integer" }, 7)).toEqual([]);
    expect(issuesFor({ type: "integer" }, 7.5)).toEqual([
      { path: "", message: "expected integer, got number" },
    ]);
    expect(issuesFor({ type: "integer" }, "7")).toHaveLength(1);
  });

  test("boolean: pass + fail", () => {
    expect(issuesFor({ type: "boolean" }, true)).toEqual([]);
    expect(issuesFor({ type: "boolean" }, "true")).toEqual([
      { path: "", message: "expected boolean, got string" },
    ]);
  });

  test("null: pass + fail (reports rich type for arrays)", () => {
    expect(issuesFor({ type: "null" }, null)).toEqual([]);
    expect(issuesFor({ type: "null" }, 0)).toEqual([
      { path: "", message: "expected null, got number" },
    ]);
    expect(issuesFor({ type: "null" }, [1])).toEqual([
      { path: "", message: "expected null, got array" },
    ]);
  });
});

// ── validateAgainstSchema — enum ───────────────────────────────────

describe("validateAgainstSchema — enum", () => {
  test("member (primitive) passes", () => {
    expect(issuesFor({ enum: ["a", "b"] }, "b")).toEqual([]);
  });

  test("non-member fails with the option list", () => {
    const issues = issuesFor({ enum: ["a", "b"] }, "c");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('value not in enum ["a", "b"]');
  });

  test("enum with a structural (object) member matches via canonical JSON", () => {
    expect(issuesFor({ enum: [{ k: 1 }, { k: 2 }] }, { k: 2 })).toEqual([]);
    expect(issuesFor({ enum: [{ k: 1 }] }, { k: 9 })).toHaveLength(1);
  });

  test("enum wins over type (checked regardless of declared type)", () => {
    // enum present → type is ignored; a matching literal passes.
    expect(issuesFor({ type: "string", enum: [1, 2, 3] }, 2)).toEqual([]);
  });
});

// ── validateAgainstSchema — object ─────────────────────────────────

describe("validateAgainstSchema — object", () => {
  test("non-object value fails", () => {
    expect(issuesFor({ type: "object" }, 5)).toEqual([
      { path: "", message: "expected object, got number" },
    ]);
    expect(issuesFor({ type: "object" }, [1])).toEqual([
      { path: "", message: "expected object, got array" },
    ]);
    expect(issuesFor({ type: "object" }, null)).toEqual([
      { path: "", message: "expected object, got null" },
    ]);
  });

  test("required: missing key reported at the child path", () => {
    const schema = { type: "object", required: ["name", "age"] };
    expect(issuesFor(schema, { name: "x" })).toEqual([
      { path: "age", message: "required property is missing" },
    ]);
  });

  test("required present, no properties → passes", () => {
    expect(issuesFor({ type: "object", required: ["a"] }, { a: 1 })).toEqual([]);
  });

  test("additionalProperties:false rejects unknown keys", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    const issues = issuesFor(schema, { a: "ok", b: 2 });
    expect(issues).toEqual([
      { path: "b", message: "unknown property (additionalProperties is false)" },
    ]);
  });

  test("additionalProperties defaults to TRUE (unknown keys allowed)", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(issuesFor(schema, { a: "ok", extra: 99 })).toEqual([]);
  });

  test("nested property validation with dotted paths", () => {
    const schema = {
      type: "object",
      properties: {
        meta: {
          type: "object",
          properties: { score: { type: "integer" } },
        },
      },
    };
    expect(issuesFor(schema, { meta: { score: 4.2 } })).toEqual([
      { path: "meta.score", message: "expected integer, got number" },
    ]);
  });

  test("declared property absent → skipped (only required enforces presence)", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(issuesFor(schema, {})).toEqual([]);
  });
});

// ── validateAgainstSchema — array ──────────────────────────────────

describe("validateAgainstSchema — array", () => {
  test("non-array value fails", () => {
    expect(issuesFor({ type: "array" }, { not: "array" })).toEqual([
      { path: "", message: "expected array, got object" },
    ]);
  });

  test("items validation reports the failing index", () => {
    const schema = { type: "array", items: { type: "string" } };
    expect(issuesFor(schema, ["a", 2, "c"])).toEqual([
      { path: "[1]", message: "expected string, got number" },
    ]);
  });

  test("array without items accepts any element", () => {
    expect(issuesFor({ type: "array" }, [1, "two", { three: 3 }])).toEqual([]);
  });

  test("nested arrays/objects compose with indexed + dotted paths", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
      },
    };
    expect(issuesFor(schema, [{ id: 1 }, { id: "bad" }, {}])).toEqual([
      { path: "[1].id", message: "expected integer, got string" },
      { path: "[2].id", message: "required property is missing" },
    ]);
  });
});

// ── validateAgainstSchema — typeless + malformed ───────────────────

describe("validateAgainstSchema — typeless + malformed schemas", () => {
  test("typeless schema ({}) matches any value", () => {
    expect(issuesFor({}, 42)).toEqual([]);
    expect(issuesFor({}, { anything: true })).toEqual([]);
    expect(issuesFor({}, null)).toEqual([]);
  });

  test("non-object schema node → invalid schema issue", () => {
    expect(issuesFor(null, 1)).toEqual([
      { path: "", message: "invalid schema node (expected an object)" },
    ]);
    // Nested malformed child schema.
    const schema = { type: "object", properties: { a: "not-a-schema" } };
    expect(issuesFor(schema, { a: 1 })).toEqual([
      { path: "a", message: "invalid schema node (expected an object)" },
    ]);
  });

  test("union type array is reported as unsupported", () => {
    const issues = issuesFor({ type: ["string", "null"] }, "x");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("unsupported schema");
  });

  test("unknown type string is reported as unsupported", () => {
    const issues = issuesFor({ type: "geo-coordinate" }, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("unsupported schema");
  });
});

// ── summarizeIssues ────────────────────────────────────────────────

describe("summarizeIssues", () => {
  test("root path renders as (root)", () => {
    expect(summarizeIssues([{ path: "", message: "boom" }])).toBe("(root): boom");
  });

  test("non-root path is shown verbatim; multiple joined by '; '", () => {
    expect(
      summarizeIssues([
        { path: "a", message: "x" },
        { path: "b.c", message: "y" },
      ]),
    ).toBe("a: x; b.c: y");
  });

  test("more than 8 issues → truncated with (+N more)", () => {
    const issues: SchemaIssue[] = Array.from({ length: 11 }, (_, i) => ({
      path: `p${i}`,
      message: "m",
    }));
    const out = summarizeIssues(issues);
    expect(out).toContain("(+3 more)");
    expect(out.split("; ")).toHaveLength(8); // 8 shown; the +N rides on the last
  });
});

// ── validateStructuredOutput ───────────────────────────────────────

describe("validateStructuredOutput", () => {
  const schema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      score: { type: "integer" },
    },
    required: ["verdict", "score"],
    additionalProperties: false,
  };

  test("valid fenced JSON → ok with parsed value", () => {
    const text = "All done.\n```json\n{\"verdict\":\"pass\",\"score\":92}\n```";
    const out = validateStructuredOutput(schema, text);
    expect(out).toEqual({ ok: true, value: { verdict: "pass", score: 92 } });
  });

  test("valid raw JSON → ok", () => {
    const out = validateStructuredOutput(schema, '{"verdict":"fail","score":0}');
    expect(out.ok).toBe(true);
  });

  test("schema-violating JSON → not ok with a summary", () => {
    const out = validateStructuredOutput(schema, '{"verdict":"maybe","score":1.5,"extra":1}');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.issues.length).toBeGreaterThanOrEqual(2);
      expect(out.summary).toContain("verdict");
      expect(out.summary).toContain("score");
    }
  });

  test("no JSON in the response → not ok with a 'no JSON' summary", () => {
    const out = validateStructuredOutput(schema, "I could not complete the task.");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.summary).toContain("no JSON value found");
    }
  });
});

// ── prompt fragments ───────────────────────────────────────────────

describe("prompt builders", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };

  test("buildSchemaInstruction embeds the serialized schema + fence", () => {
    const out = buildSchemaInstruction(schema);
    expect(out).toContain("## Required Output Format");
    expect(out).toContain("```json");
    expect(out).toContain('"type": "object"');
    expect(out).toContain('"a"');
  });

  test("buildSchemaCorrection quotes the violations and restates the schema", () => {
    const out = buildSchemaCorrection(schema, "a: expected string, got number");
    expect(out).toContain("did not satisfy the required output schema");
    expect(out).toContain("Validation errors: a: expected string, got number");
    expect(out).toContain('"type": "object"');
  });
});
