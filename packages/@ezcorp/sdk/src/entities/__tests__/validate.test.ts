// validate.test.ts — coverage for validate.ts + EntityValidationError
//
// Spec-required cases:
//   object, string/number/boolean primitives,
//   string min/max-Length, string pattern, string enum,
//   number min/max, integer, array items, nested objects,
//   required fields, additionalProperties=false (default),
//   soft warnings produce structured issues,
//   throw on hard-fail with EntityValidationError

import { describe, expect, test } from "bun:test";

import {
  EntityValidationError,
  type JsonSchema,
  type JsonSchemaObject,
} from "../types";
import { assertRecord, validateRecord } from "../validate";

const POST_TYPE_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    systemPrompt: { type: "string", minLength: 1, maxLength: 100_000 },
    cadence: {
      type: "string",
      enum: ["weekly", "monthly", "ad-hoc", "custom"],
    },
    defaults: {
      type: "object",
      properties: {
        titlePrefix: { type: "string" },
        subtitleTemplate: { type: "string" },
      },
    },
  },
  required: ["name", "systemPrompt"],
  additionalProperties: false,
};

describe("validateRecord — happy paths", () => {
  test("valid record produces zero issues", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, {
      name: "Weekly",
      systemPrompt: "x",
      cadence: "weekly",
    });
    expect(issues).toEqual([]);
  });

  test("optional nested object validates", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, {
      name: "Weekly",
      systemPrompt: "x",
      defaults: { titlePrefix: "Hi:" },
    });
    expect(issues).toEqual([]);
  });

  test("missing optional property is fine", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, {
      name: "Weekly",
      systemPrompt: "x",
    });
    expect(issues).toEqual([]);
  });
});

describe("validateRecord — object branch", () => {
  test("rejects non-object", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, "not an object");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      path: "",
      message: "expected object, got string",
    });
  });

  test("rejects null", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, null);
    expect(issues[0]?.message).toContain("expected object, got null");
  });

  test("rejects array as object", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, ["a", "b"]);
    expect(issues[0]?.message).toContain("expected object, got array");
  });

  test("rejects Date as object (not POJO)", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, new Date());
    expect(issues[0]?.message).toContain("expected object");
  });

  test("missing required field produces path-tagged issue", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, {
      systemPrompt: "x",
    });
    expect(issues).toContainEqual({
      path: "name",
      message: "required property is missing",
    });
  });

  test("multiple missing required fields", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, {});
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("name");
    expect(paths).toContain("systemPrompt");
  });

  test("additionalProperties=false rejects unknown keys", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, {
      name: "x",
      systemPrompt: "y",
      unexpected: "value",
    });
    expect(issues).toContainEqual({
      path: "unexpected",
      message: "unknown property (additionalProperties=false)",
    });
  });

  test("additionalProperties=true allows unknown keys", () => {
    const schema: JsonSchemaObject = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
    };
    const issues = validateRecord(schema, { a: "x", b: "anything" });
    expect(issues).toEqual([]);
  });

  test("default additionalProperties (omitted) rejects unknown", () => {
    const schema: JsonSchemaObject = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    const issues = validateRecord(schema, { a: "x", b: "extra" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("b");
  });

  test("object with no properties + no required is permissive", () => {
    const schema: JsonSchemaObject = {
      type: "object",
      additionalProperties: true,
    };
    expect(validateRecord(schema, {})).toEqual([]);
    expect(validateRecord(schema, { x: 1, y: 2 })).toEqual([]);
  });

  test("nested object validation reports nested path", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, {
      name: "Weekly",
      systemPrompt: "x",
      defaults: { titlePrefix: 42 }, // wrong type
    });
    expect(issues).toContainEqual({
      path: "defaults.titlePrefix",
      message: "expected string, got number",
    });
  });
});

describe("validateRecord — string branch", () => {
  const schema: JsonSchemaObject = {
    type: "object",
    properties: {
      a: { type: "string", minLength: 2, maxLength: 4 },
    },
    required: ["a"],
  };

  test("non-string", () => {
    expect(validateRecord(schema, { a: 123 })).toContainEqual({
      path: "a",
      message: "expected string, got number",
    });
  });

  test("below minLength", () => {
    expect(validateRecord(schema, { a: "x" })[0]?.message).toMatch(
      /below minLength 2/,
    );
  });

  test("above maxLength", () => {
    expect(validateRecord(schema, { a: "abcde" })[0]?.message).toMatch(
      /above maxLength 4/,
    );
  });

  test("at minLength is accepted", () => {
    expect(validateRecord(schema, { a: "ab" })).toEqual([]);
  });

  test("at maxLength is accepted", () => {
    expect(validateRecord(schema, { a: "abcd" })).toEqual([]);
  });

  test("pattern accepts", () => {
    const s: JsonSchemaObject = {
      type: "object",
      properties: { a: { type: "string", pattern: "^[a-z]+$" } },
      required: ["a"],
    };
    expect(validateRecord(s, { a: "abc" })).toEqual([]);
  });

  test("pattern rejects", () => {
    const s: JsonSchemaObject = {
      type: "object",
      properties: { a: { type: "string", pattern: "^[a-z]+$" } },
      required: ["a"],
    };
    const issues = validateRecord(s, { a: "ABC" });
    expect(issues[0]?.message).toMatch(/does not match pattern/);
  });

  test("malformed pattern surfaces structured error", () => {
    const s: JsonSchemaObject = {
      type: "object",
      properties: { a: { type: "string", pattern: "(" } }, // unbalanced
      required: ["a"],
    };
    const issues = validateRecord(s, { a: "x" });
    expect(issues[0]?.message).toMatch(/not a valid regex/);
  });

  test("enum accepts valid value", () => {
    expect(
      validateRecord(POST_TYPE_SCHEMA, {
        name: "n",
        systemPrompt: "p",
        cadence: "weekly",
      }),
    ).toEqual([]);
  });

  test("enum rejects unknown value", () => {
    const issues = validateRecord(POST_TYPE_SCHEMA, {
      name: "n",
      systemPrompt: "p",
      cadence: "biweekly",
    });
    expect(issues[0]).toEqual({
      path: "cadence",
      message: 'expected one of ["weekly", "monthly", "ad-hoc", "custom"], got "biweekly"',
    });
  });
});

describe("validateRecord — number branch", () => {
  const schema: JsonSchemaObject = {
    type: "object",
    properties: { n: { type: "number", minimum: 0, maximum: 10 } },
    required: ["n"],
  };

  test("rejects non-number", () => {
    expect(validateRecord(schema, { n: "5" })[0]?.message).toMatch(
      /expected number, got string/,
    );
  });

  test("rejects NaN", () => {
    expect(validateRecord(schema, { n: Number.NaN })[0]?.message).toMatch(
      /expected number/,
    );
  });

  test("rejects Infinity", () => {
    expect(
      validateRecord(schema, { n: Number.POSITIVE_INFINITY })[0]?.message,
    ).toMatch(/finite/);
  });

  test("rejects below minimum", () => {
    expect(validateRecord(schema, { n: -1 })[0]?.message).toMatch(
      /below minimum 0/,
    );
  });

  test("rejects above maximum", () => {
    expect(validateRecord(schema, { n: 11 })[0]?.message).toMatch(
      /above maximum 10/,
    );
  });

  test("accepts boundary values", () => {
    expect(validateRecord(schema, { n: 0 })).toEqual([]);
    expect(validateRecord(schema, { n: 10 })).toEqual([]);
  });

  test("integer flag rejects floats", () => {
    const s: JsonSchemaObject = {
      type: "object",
      properties: { n: { type: "number", integer: true } },
      required: ["n"],
    };
    expect(validateRecord(s, { n: 1.5 })[0]?.message).toMatch(
      /expected integer/,
    );
    expect(validateRecord(s, { n: 1 })).toEqual([]);
  });
});

describe("validateRecord — boolean branch", () => {
  const schema: JsonSchemaObject = {
    type: "object",
    properties: { b: { type: "boolean" } },
    required: ["b"],
  };

  test("accepts true / false", () => {
    expect(validateRecord(schema, { b: true })).toEqual([]);
    expect(validateRecord(schema, { b: false })).toEqual([]);
  });

  test("rejects truthy non-boolean", () => {
    expect(validateRecord(schema, { b: 1 })[0]?.message).toMatch(
      /expected boolean, got number/,
    );
    expect(validateRecord(schema, { b: "true" })[0]?.message).toMatch(
      /expected boolean, got string/,
    );
  });
});

describe("validateRecord — array branch", () => {
  const schema: JsonSchemaObject = {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 3,
      },
    },
    required: ["tags"],
  };

  test("rejects non-array", () => {
    expect(validateRecord(schema, { tags: "abc" })[0]?.message).toMatch(
      /expected array, got string/,
    );
  });

  test("rejects below minItems", () => {
    expect(validateRecord(schema, { tags: [] })[0]?.message).toMatch(
      /below minItems 1/,
    );
  });

  test("rejects above maxItems", () => {
    expect(
      validateRecord(schema, { tags: ["a", "b", "c", "d"] })[0]?.message,
    ).toMatch(/above maxItems 3/);
  });

  test("validates each item with [i] path", () => {
    const issues = validateRecord(schema, { tags: ["ok", 42, "ok"] });
    expect(issues).toContainEqual({
      path: "tags[1]",
      message: "expected string, got number",
    });
  });

  test("array with no items schema accepts anything-shaped contents", () => {
    const s: JsonSchemaObject = {
      type: "object",
      properties: { x: { type: "array" } },
      required: ["x"],
    };
    expect(validateRecord(s, { x: [1, "two", true] })).toEqual([]);
  });

  test("nested array path encoding", () => {
    const s: JsonSchemaObject = {
      type: "object",
      properties: {
        matrix: {
          type: "array",
          items: { type: "array", items: { type: "number" } },
        },
      },
      required: ["matrix"],
    };
    const issues = validateRecord(s, {
      matrix: [
        [1, 2],
        [3, "BAD", 5],
      ],
    });
    expect(issues).toContainEqual({
      path: "matrix[1][1]",
      message: "expected number, got string",
    });
  });
});

describe("validateRecord — unsupported type", () => {
  test("unknown schema type surfaces a structured issue, never throws", () => {
    const broken = { type: "null" } as unknown as JsonSchema;
    const issues = validateRecord(broken, "anything");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/unsupported schema type/);
  });
});

describe("assertRecord — hard fail", () => {
  test("does not throw on valid record", () => {
    expect(() =>
      assertRecord(POST_TYPE_SCHEMA, {
        name: "n",
        systemPrompt: "p",
      }),
    ).not.toThrow();
  });

  test("throws EntityValidationError with issues attached", () => {
    let caught: unknown = null;
    try {
      assertRecord(POST_TYPE_SCHEMA, { name: "n" }); // missing systemPrompt
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EntityValidationError);
    expect((caught as EntityValidationError).issues).toContainEqual({
      path: "systemPrompt",
      message: "required property is missing",
    });
    expect((caught as EntityValidationError).message).toMatch(
      /record failed schema validation/,
    );
  });

  test("uses ctx prefix in the error message", () => {
    expect(() =>
      assertRecord(POST_TYPE_SCHEMA, { name: "n" }, "create_post_type"),
    ).toThrow(/create_post_type failed schema validation/);
  });

  test("truncates issue list to 5 with a (+N more) suffix", () => {
    const schema: JsonSchemaObject = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
        d: { type: "string" },
        e: { type: "string" },
        f: { type: "string" },
        g: { type: "string" },
      },
      required: ["a", "b", "c", "d", "e", "f", "g"],
    };
    let caught: EntityValidationError | null = null;
    try {
      assertRecord(schema, {});
    } catch (err) {
      caught = err as EntityValidationError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.issues.length).toBe(7);
    expect(caught?.message).toMatch(/\(\+2 more\)/);
  });

  test("renders (root) path for top-level structural failure", () => {
    expect(() => assertRecord(POST_TYPE_SCHEMA, "not-an-object")).toThrow(
      /\(root\):/,
    );
  });
});

describe("EntityValidationError", () => {
  test("preserves issues and name", () => {
    const err = new EntityValidationError("msg", [
      { path: "x", message: "y" },
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EntityValidationError");
    expect(err.message).toBe("msg");
    expect(err.issues).toEqual([{ path: "x", message: "y" }]);
  });
});
