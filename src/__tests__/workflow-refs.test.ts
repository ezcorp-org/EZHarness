import { describe, test, expect } from "bun:test";
import {
  OMIT,
  getNestedValue,
  resolveInputRef,
  resolveMapping,
  resolveOutputMapping,
  resolveConditionRef,
  interpolateTemplate,
  hasTemplate,
  type RefContext,
} from "../runtime/workflow-refs";
import type { AgentResult } from "../types";

function ctx(overrides: Partial<RefContext> = {}): RefContext {
  return {
    input: {},
    stepResults: new Map<string, AgentResult>(),
    prevResult: undefined,
    ...overrides,
  };
}

describe("getNestedValue", () => {
  test("walks a dotted path", () => {
    expect(getNestedValue({ a: { b: { c: 5 } } }, "a.b.c")).toBe(5);
  });
  test("returns undefined on a missing hop or non-object", () => {
    expect(getNestedValue({ a: 1 }, "a.b")).toBeUndefined();
    expect(getNestedValue(null, "a")).toBeUndefined();
    expect(getNestedValue(42, "a")).toBeUndefined();
  });
  test("only traverses own properties — never the prototype chain", () => {
    // A crafted ref path must not walk into inherited segments.
    expect(getNestedValue({ a: { b: 1 } }, "a.__proto__")).toBeUndefined();
    expect(getNestedValue({ a: {} }, "a.constructor")).toBeUndefined();
    expect(getNestedValue({}, "toString")).toBeUndefined();
    // Own properties still resolve (including array indices + length).
    expect(getNestedValue({ arr: [10, 20] }, "arr.1")).toBe(20);
    expect(getNestedValue({ arr: [10, 20] }, "arr.length")).toBe(2);
  });
});

describe("resolveInputRef", () => {
  test("$input.<field> is lenient (undefined ok)", () => {
    expect(resolveInputRef("k", "$input.name", ctx({ input: { name: "Ada" } }))).toBe("Ada");
    expect(resolveInputRef("k", "$input.missing", ctx())).toBeUndefined();
  });

  test("a literal (no recognised root) is returned verbatim", () => {
    expect(resolveInputRef("k", "hello", ctx())).toBe("hello");
  });

  test("$loop.iteration returns the 1-based number inside a loop", () => {
    expect(resolveInputRef("k", "$loop.iteration", ctx({ loop: { iteration: 2 } }))).toBe(2);
  });

  test("$loop.iteration throws outside a loop", () => {
    expect(() => resolveInputRef("k", "$loop.iteration", ctx())).toThrow(/not inside a loop/);
  });

  test("$loop.last is OMIT on iteration 1 (no previous result)", () => {
    expect(resolveInputRef("k", "$loop.last", ctx({ loop: { iteration: 1 } }))).toBe(OMIT);
    expect(resolveInputRef("k", "$loop.last.output.n", ctx({ loop: { iteration: 1 } }))).toBe(OMIT);
  });

  test("$loop.last returns the whole previous result or a nested field", () => {
    const last: AgentResult = { success: true, output: { n: 7 } };
    expect(resolveInputRef("k", "$loop.last", ctx({ loop: { iteration: 2, last } }))).toEqual(last);
    expect(resolveInputRef("k", "$loop.last.output.n", ctx({ loop: { iteration: 2, last } }))).toBe(7);
  });

  test("$loop.last throws outside a loop, or on a missing field", () => {
    expect(() => resolveInputRef("k", "$loop.last", ctx())).toThrow(/not inside a loop/);
    const last: AgentResult = { success: true, output: { n: 7 } };
    expect(() =>
      resolveInputRef("k", "$loop.last.output.nope", ctx({ loop: { iteration: 2, last } })),
    ).toThrow(/field "output.nope" is missing/);
  });

  test("$prev.<path> is strict", () => {
    const prev: AgentResult = { success: true, output: { title: "T" } };
    expect(resolveInputRef("k", "$prev.output.title", ctx({ prevResult: prev }))).toBe("T");
    expect(() => resolveInputRef("k", "$prev.output", ctx())).toThrow(/no previous step/);
    expect(() => resolveInputRef("k", "$prev.nope", ctx({ prevResult: prev }))).toThrow(
      /field "nope" is missing/,
    );
  });

  test("bare $prev yields the whole previous result (never a '$prev' literal)", () => {
    const prev: AgentResult = { success: true, output: { title: "T" } };
    expect(resolveInputRef("k", "$prev", ctx({ prevResult: prev }))).toEqual(prev);
    expect(() => resolveInputRef("k", "$prev", ctx())).toThrow(/no previous step/);
  });

  test("$steps.<name> is strict on the step and (for inputs) on the field", () => {
    const results = new Map<string, AgentResult>([
      ["fetch", { success: true, output: { title: "Hi" } }],
    ]);
    expect(resolveInputRef("k", "$steps.fetch", ctx({ stepResults: results }))).toEqual(
      results.get("fetch"),
    );
    expect(resolveInputRef("k", "$steps.fetch.output.title", ctx({ stepResults: results }))).toBe(
      "Hi",
    );
    expect(() => resolveInputRef("k", "$steps.ghost.output", ctx({ stepResults: results }))).toThrow(
      /step "ghost" has not produced a result/,
    );
    expect(() =>
      resolveInputRef("k", "$steps.fetch.output.nope", ctx({ stepResults: results })),
    ).toThrow(/field "output.nope" is missing/);
  });
});

describe("resolveMapping", () => {
  test("resolves each key and drops OMIT keys", () => {
    const resolved = resolveMapping(
      { keep: "$input.a", drop: "$loop.last" },
      ctx({ input: { a: 1 }, loop: { iteration: 1 } }),
    );
    expect(resolved).toEqual({ keep: 1 });
  });
});

describe("resolveOutputMapping", () => {
  test("interpolates templated values and resolves direct refs; drops OMIT", () => {
    const results = new Map<string, AgentResult>([
      ["gen", { success: true, output: { title: "World" } }],
    ]);
    const resolved = resolveOutputMapping(
      {
        line: "{{$input.prefix}} — {{$steps.gen.output.title}}",
        direct: "$steps.gen.output.title",
        omitted: "$loop.last",
      },
      ctx({ input: { prefix: "Hi" }, stepResults: results, loop: { iteration: 1 } }),
    );
    expect(resolved).toEqual({ line: "Hi — World", direct: "World" });
  });
});

describe("resolveConditionRef", () => {
  test("$iteration only inside a loop until", () => {
    expect(resolveConditionRef("$iteration", ctx({ iteration: 3 }))).toBe(3);
    expect(() => resolveConditionRef("$iteration", ctx())).toThrow(/only available inside a loop/);
  });

  test("$result whole and nested; throws outside a loop until", () => {
    const result: AgentResult = { success: true, output: { n: 9 } };
    expect(resolveConditionRef("$result", ctx({ result }))).toEqual(result);
    expect(resolveConditionRef("$result.output.n", ctx({ result }))).toBe(9);
    expect(() => resolveConditionRef("$result.output.n", ctx())).toThrow(
      /only available inside a loop/,
    );
  });

  test("$input is lenient", () => {
    expect(resolveConditionRef("$input.v", ctx({ input: { v: 2 } }))).toBe(2);
  });

  test("$prev whole and nested; throws with no previous result", () => {
    const prev: AgentResult = { success: true, output: { ok: true } };
    expect(resolveConditionRef("$prev", ctx({ prevResult: prev }))).toEqual(prev);
    expect(resolveConditionRef("$prev.output.ok", ctx({ prevResult: prev }))).toBe(true);
    expect(() => resolveConditionRef("$prev.output", ctx())).toThrow(/no previous step/);
  });

  test("$steps whole and nested (deep missing field is lenient → undefined)", () => {
    const results = new Map<string, AgentResult>([["s", { success: true, output: { n: 1 } }]]);
    expect(resolveConditionRef("$steps.s", ctx({ stepResults: results }))).toEqual(results.get("s"));
    expect(resolveConditionRef("$steps.s.output.n", ctx({ stepResults: results }))).toBe(1);
    expect(resolveConditionRef("$steps.s.output.gone", ctx({ stepResults: results }))).toBeUndefined();
    expect(() => resolveConditionRef("$steps.ghost", ctx({ stepResults: results }))).toThrow(
      /step "ghost" has not produced a result/,
    );
  });

  test("an unrecognised root is a literal comparison value", () => {
    expect(resolveConditionRef("plain-string", ctx())).toBe("plain-string");
  });
});

describe("interpolateTemplate", () => {
  test("resolves placeholders and stringifies", () => {
    const results = new Map<string, AgentResult>([["s", { success: true, output: { obj: { a: 1 } } }]]);
    expect(
      interpolateTemplate("k", "n={{$input.n}} obj={{$steps.s.output.obj}}", ctx({ input: { n: 4 }, stepResults: results })),
    ).toBe('n=4 obj={"a":1}');
  });

  test("OMIT and null/undefined placeholders render as empty string", () => {
    expect(interpolateTemplate("k", "[{{$loop.last}}]", ctx({ loop: { iteration: 1 } }))).toBe("[]");
    expect(interpolateTemplate("k", "[{{$input.missing}}]", ctx())).toBe("[]");
  });

  test("adjacent placeholders, inner whitespace and $-literals all resolve", () => {
    const c = ctx({ input: { a: 1, b: 2, x: "X" } });
    expect(interpolateTemplate("k", "{{$input.a}}{{$input.b}}", c)).toBe("12");
    expect(interpolateTemplate("k", "[{{ $input.x }}]", c)).toBe("[X]");
    // `$` outside a placeholder and an unrecognised-root literal inside one
    // both pass through verbatim.
    expect(interpolateTemplate("k", "costs $5 and {{$input.a}}", c)).toBe("costs $5 and 1");
    expect(interpolateTemplate("k", "[{{plain}}]", c)).toBe("[plain]");
  });

  test("an empty {{}} placeholder resolves to the empty-string literal", () => {
    expect(interpolateTemplate("k", "a{{}}b", ctx())).toBe("ab");
    expect(interpolateTemplate("k", "a{{ }}b", ctx())).toBe("ab");
  });

  test("a large input with no closing braces returns unchanged, fast (ReDoS regression)", () => {
    // The pre-fix regex (`\{\{\s*([^}]+?)\s*\}\}`) backtracked
    // super-linearly here — ~4KB pinned the event loop for ~9s, so this
    // test would blow the suite timeout. The linear regex must return the
    // template verbatim (no closing `}}` ⇒ no placeholder).
    const pathological = `{{${"a".repeat(8192)}`;
    expect(interpolateTemplate("k", pathological, ctx())).toBe(pathological);
    const trailingBrace = `{{ ${"a ".repeat(4096)}}`;
    expect(interpolateTemplate("k", trailingBrace, ctx())).toBe(trailingBrace);
  });
});

describe("hasTemplate", () => {
  test("detects placeholders", () => {
    expect(hasTemplate("a {{x}} b")).toBe(true);
    expect(hasTemplate("{{ spaced }}")).toBe(true);
    expect(hasTemplate("{{}}")).toBe(true);
    expect(hasTemplate("no placeholders")).toBe(false);
  });

  test("a large unterminated placeholder is not a template, fast (ReDoS regression)", () => {
    expect(hasTemplate(`{{${"a".repeat(8192)}`)).toBe(false);
  });
});
