/**
 * The per-step model binding vocabulary: definition-time shape checking
 * and run-time ref resolution (`src/runtime/workflow-model.ts`).
 */
import { test, expect, describe } from "bun:test";
import {
  effectiveModelOverride,
  MAX_MODEL_FIELD_LENGTH,
  MAX_MODEL_MAX_TOKENS,
  MAX_MODEL_TEMPERATURE,
  resolveModelOverride,
  validateModelOverride,
} from "../runtime/workflow-model";
import type { AgentResult, ModelOverride, WorkflowStep } from "../types";
import type { RefContext } from "../runtime/workflow-refs";

function ctx(input: Record<string, unknown> = {}, steps: Array<[string, AgentResult]> = []): RefContext {
  return { input, stepResults: new Map(steps), prevResult: undefined };
}

describe("validateModelOverride", () => {
  test("accepts a full, well-formed binding", () => {
    expect(
      validateModelOverride(
        {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          temperature: 0.2,
          maxTokens: 8000,
        },
        "Step \"x\" model",
      ),
    ).toEqual([]);
  });

  test("accepts an empty object (every field is optional)", () => {
    expect(validateModelOverride({}, "L")).toEqual([]);
  });

  test.each([[null], ["anthropic"], [42], [["anthropic"]]])(
    "rejects a non-object binding (%p)",
    (value) => {
      expect(validateModelOverride(value, "L")).toEqual(["L must be an object"]);
    },
  );

  test("rejects an unknown field so a typo is not silently ignored", () => {
    const errors = validateModelOverride({ maxtokens: 100 }, "L");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown field "maxtokens"');
  });

  test.each(["provider", "model"] as const)(
    "rejects a non-string / empty %s",
    (field) => {
      expect(validateModelOverride({ [field]: 7 }, "L")).toEqual([
        `L "${field}" must be a non-empty string`,
      ]);
      expect(validateModelOverride({ [field]: "   " }, "L")).toEqual([
        `L "${field}" must be a non-empty string`,
      ]);
    },
  );

  test("rejects an over-long string field", () => {
    const errors = validateModelOverride(
      { model: "m".repeat(MAX_MODEL_FIELD_LENGTH + 1) },
      "L",
    );
    expect(errors).toEqual([
      `L "model" exceeds the maximum length of ${MAX_MODEL_FIELD_LENGTH} characters`,
    ]);
  });

  test("rejects a reasoning/effort field — the LLM call has no such parameter", () => {
    // `ctx.llm.complete` accepts system/provider/model/temperature/maxTokens
    // and nothing else, so accepting `effort` here would validate a knob
    // that silently does nothing. See the note at the top of
    // workflow-model.ts before re-adding it.
    const errors = validateModelOverride({ effort: "high" }, "L");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown field "effort"');
  });

  test("accepts a REF value for a string field (unknowable at definition time)", () => {
    expect(validateModelOverride({ model: "$input.reviewModel" }, "L")).toEqual([]);
    expect(validateModelOverride({ provider: "$input.tier" }, "L")).toEqual([]);
  });

  test("rejects a non-numeric or out-of-range temperature", () => {
    expect(validateModelOverride({ temperature: "hot" }, "L")).toEqual([
      'L "temperature" must be a number',
    ]);
    expect(validateModelOverride({ temperature: Number.NaN }, "L")).toEqual([
      'L "temperature" must be a number',
    ]);
    expect(validateModelOverride({ temperature: -0.1 }, "L")[0]).toContain(
      `must be between 0 and ${MAX_MODEL_TEMPERATURE}`,
    );
    expect(validateModelOverride({ temperature: MAX_MODEL_TEMPERATURE + 0.1 }, "L")[0]).toContain(
      `must be between 0 and ${MAX_MODEL_TEMPERATURE}`,
    );
    // The bounds themselves are inclusive.
    expect(validateModelOverride({ temperature: 0 }, "L")).toEqual([]);
    expect(validateModelOverride({ temperature: MAX_MODEL_TEMPERATURE }, "L")).toEqual([]);
  });

  test("rejects a non-integer or out-of-range maxTokens", () => {
    expect(validateModelOverride({ maxTokens: 1.5 }, "L")).toEqual([
      'L "maxTokens" must be an integer',
    ]);
    expect(validateModelOverride({ maxTokens: "8000" }, "L")).toEqual([
      'L "maxTokens" must be an integer',
    ]);
    expect(validateModelOverride({ maxTokens: 0 }, "L")[0]).toContain(
      `must be between 1 and ${MAX_MODEL_MAX_TOKENS}`,
    );
    expect(validateModelOverride({ maxTokens: MAX_MODEL_MAX_TOKENS + 1 }, "L")[0]).toContain(
      `must be between 1 and ${MAX_MODEL_MAX_TOKENS}`,
    );
    expect(validateModelOverride({ maxTokens: 1 }, "L")).toEqual([]);
    expect(validateModelOverride({ maxTokens: MAX_MODEL_MAX_TOKENS }, "L")).toEqual([]);
  });

  test("reports every problem at once, each prefixed with the label", () => {
    const errors = validateModelOverride(
      { provider: "", temperature: 9, maxTokens: 0, nope: 1 },
      'Step "verify" model',
    );
    expect(errors).toHaveLength(4);
    expect(errors.every((e) => e.startsWith('Step "verify" model'))).toBe(true);
  });
});

describe("effectiveModelOverride", () => {
  const step = (model?: ModelOverride): WorkflowStep => ({ name: "s", ...(model ? { model } : {}) });

  test("prefers the step's own binding", () => {
    expect(
      effectiveModelOverride(step({ model: "step-model" }), { defaultModel: { model: "def" } }),
    ).toEqual({ model: "step-model" });
  });

  test("falls back to the definition's defaultModel", () => {
    expect(effectiveModelOverride(step(), { defaultModel: { model: "def" } })).toEqual({
      model: "def",
    });
  });

  test("is undefined when neither is set", () => {
    expect(effectiveModelOverride(step(), {})).toBeUndefined();
  });

  test("REPLACES the default wholesale — it is not a field-by-field merge", () => {
    // A step naming only `model` must not silently inherit the default's
    // maxTokens; that would spend a budget the step never asked for.
    expect(
      effectiveModelOverride(step({ model: "cheap" }), {
        defaultModel: { model: "expensive", maxTokens: 64_000 },
      }),
    ).toEqual({ model: "cheap" });
  });
});

describe("resolveModelOverride", () => {
  test("returns undefined for an absent binding", () => {
    expect(resolveModelOverride(undefined, ctx(), "s")).toBeUndefined();
  });

  test("passes literals through untouched", () => {
    expect(
      resolveModelOverride(
        { provider: "anthropic", model: "claude-opus-5", temperature: 0.3, maxTokens: 100 },
        ctx(),
        "s",
      ),
    ).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      temperature: 0.3,
      maxTokens: 100,
    });
  });

  test("resolves refs through the shared ref language", () => {
    expect(
      resolveModelOverride(
        { model: "$input.verifyModel", provider: "$input.tier" },
        ctx({ verifyModel: "claude-opus-5", tier: "anthropic" }),
        "verify",
      ),
    ).toEqual({ model: "claude-opus-5", provider: "anthropic" });
  });

  test("resolves a $steps ref (the full grammar, not a $input-only subset)", () => {
    expect(
      resolveModelOverride(
        { model: "$steps.pick.output.model" },
        ctx({}, [["pick", { success: true, output: { model: "claude-haiku-4-5" } }]]),
        "verify",
      ),
    ).toEqual({ model: "claude-haiku-4-5" });
  });

  test("an unset $input ref means NO override for that field, not a broken model id", () => {
    // Lenient by design: an optional job knob that nobody supplied must
    // leave the agent's own binding standing.
    expect(resolveModelOverride({ model: "$input.missing" }, ctx(), "s")).toBeUndefined();
    expect(
      resolveModelOverride({ model: "$input.missing", provider: "anthropic" }, ctx(), "s"),
    ).toEqual({ provider: "anthropic" });
  });

  test("keeps numeric fields even when every string field resolves away", () => {
    expect(
      resolveModelOverride({ model: "$input.missing", maxTokens: 4000 }, ctx(), "s"),
    ).toEqual({ maxTokens: 4000 });
  });

  test("throws, naming the step, when a ref resolves to a non-string", () => {
    expect(() =>
      resolveModelOverride({ model: "$input.n" }, ctx({ n: 42 }), "verify"),
    ).toThrow(/Step "verify" model override "model" resolved to a non-string value \(42\)/);
  });

  test("throws when a ref resolves to a blank string", () => {
    expect(() => resolveModelOverride({ provider: "$input.p" }, ctx({ p: "  " }), "s")).toThrow(
      /model override "provider" resolved to a non-string value/,
    );
  });

  test("a strict-ref failure propagates from the shared resolver", () => {
    expect(() => resolveModelOverride({ model: "$steps.nope.output" }, ctx(), "s")).toThrow(
      /step "nope" has not produced a result/,
    );
  });

  test("ignores non-string declared values for string fields (shape is the validator's job)", () => {
    // A definition that dodged validation (a hand-edited DB row) must not
    // crash the resolver — the field is simply not mapped.
    expect(
      resolveModelOverride({ model: 7 as unknown as string, maxTokens: 10 }, ctx(), "s"),
    ).toEqual({ maxTokens: 10 });
  });
});
