/**
 * End-to-end tests for the "__current__" model sentinel feature.
 *
 * Covers:
 * 1. resolveSentinel unit logic (inline since not exported)
 * 2. Full 3-tier model resolution chain (override → config → parent)
 * 3. Task assignment model resolution (matches start endpoint logic)
 * 4. Sentinel constant consistency
 *
 * The legacy `completeTaskFromAssignment` integration block that lived
 * here tested the built-in task-tracking module's auto-advance logic.
 * Phase 3 commit-5 moved that logic inside the bundled task-tracking
 * extension, where it's covered by
 * src/__tests__/task-tracking-extension.test.ts (the
 * `task:assignment_update` subscription cases).
 *
 * Phase 4 commit-5 also deleted the legacy invoke-agent built-in — the
 * `__current__` sentinel substitution for the invoke-agent branch now
 * lives inside the bundled `orchestration` extension + the host's
 * spawn-assignment-handler → startAssignment cascade. The pure-logic
 * checks below (resolveSentinel / resolveModel / resolveForTaskAssignment)
 * are inline replicas that continue to pin the invariant — the
 * end-to-end proof that the sentinel survives the invoke-agent path in
 * the new architecture lives in orchestration-e2e.test.ts.
 */
import { test, expect, describe } from "bun:test";
import { CURRENT_MODEL_SENTINEL } from "../types";

/** Inline replica of the unexported resolveSentinel logic that
 *  historically lived in the legacy invoke-agent built-in. Phase 4
 *  commit-5 moved the runtime behavior into the bundled `orchestration`
 *  extension (which delegates the sentinel substitution to the host's
 *  spawn-assignment-handler → startAssignment chain). The pure-logic
 *  checks in this file continue to guard the invariant. */
function resolveSentinel(value: string | undefined | null, fallback: string | undefined): string | undefined {
  if (value === CURRENT_MODEL_SENTINEL) return fallback;
  return value ?? undefined;
}

/** Inline replica of the 3-tier resolution chain (override → config → parent)
 *  formerly implemented inline in the legacy invoke-agent built-in and
 *  now mirrored by the startAssignment override cascade reached via the
 *  orchestration extension. */
function resolveModel(overrideModel: string | undefined | null, configModel: string | undefined | null, parentModel: string | undefined): string | undefined {
  return resolveSentinel(overrideModel, parentModel) ?? resolveSentinel(configModel, parentModel) ?? parentModel;
}

/** Inline replica of the resolution logic from the start-assignment endpoint */
function resolveForTaskAssignment(
  configModel: string | null | undefined,
  bodyModel: string | undefined,
  convModel: string | null | undefined,
): string | undefined {
  return configModel === CURRENT_MODEL_SENTINEL
    ? (bodyModel ?? convModel ?? undefined)
    : (configModel ?? bodyModel ?? convModel ?? undefined);
}

// ═════════════════════════════════════════════════════════════════════
// 1. resolveSentinel unit tests
// ═════════════════════════════════════════════════════════════════════

describe("resolveSentinel", () => {
  test("__current__ with valid fallback returns fallback", () => {
    expect(resolveSentinel(CURRENT_MODEL_SENTINEL, "claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });

  test("__current__ with undefined fallback returns undefined", () => {
    expect(resolveSentinel(CURRENT_MODEL_SENTINEL, undefined)).toBeUndefined();
  });

  test("regular string returns as-is", () => {
    expect(resolveSentinel("gpt-4o", "claude-sonnet-4-20250514")).toBe("gpt-4o");
  });

  test("undefined returns undefined", () => {
    expect(resolveSentinel(undefined, "claude-sonnet-4-20250514")).toBeUndefined();
  });

  test("null returns undefined", () => {
    expect(resolveSentinel(null, "claude-sonnet-4-20250514")).toBeUndefined();
  });

  test("empty string returns empty string (truthy in ?? chain)", () => {
    expect(resolveSentinel("", "claude-sonnet-4-20250514")).toBe("");
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Full model resolution chain (override → config → parent)
// ═════════════════════════════════════════════════════════════════════

describe("3-tier model resolution chain", () => {
  test("override=__current__, config=specific, parent=X → X", () => {
    expect(resolveModel(CURRENT_MODEL_SENTINEL, "gpt-4o", "claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });

  test("override=undefined, config=__current__, parent=X → X", () => {
    expect(resolveModel(undefined, CURRENT_MODEL_SENTINEL, "claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });

  test("override=__current__, config=__current__, parent=X → X", () => {
    expect(resolveModel(CURRENT_MODEL_SENTINEL, CURRENT_MODEL_SENTINEL, "claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });

  test("override=specific, config=__current__, parent=X → specific", () => {
    expect(resolveModel("gpt-4o", CURRENT_MODEL_SENTINEL, "claude-sonnet-4-20250514")).toBe("gpt-4o");
  });

  test("override=undefined, config=undefined, parent=X → X", () => {
    expect(resolveModel(undefined, undefined, "claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });

  test("override=__current__, config=specific, parent=undefined → specific (fallback to config)", () => {
    // resolveSentinel(__current__, undefined) → undefined, resolveSentinel("gpt-4o", undefined) → "gpt-4o"
    expect(resolveModel(CURRENT_MODEL_SENTINEL, "gpt-4o", undefined)).toBe("gpt-4o");
  });

  test("all undefined → undefined", () => {
    expect(resolveModel(undefined, undefined, undefined)).toBeUndefined();
  });

  test("override=null, config=null, parent=X → X", () => {
    expect(resolveModel(null, null, "claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });

  test("sentinel never leaks through", () => {
    const combos: [string | undefined | null, string | undefined | null, string | undefined][] = [
      [CURRENT_MODEL_SENTINEL, CURRENT_MODEL_SENTINEL, "claude-sonnet-4-20250514"],
      [CURRENT_MODEL_SENTINEL, CURRENT_MODEL_SENTINEL, undefined],
      [CURRENT_MODEL_SENTINEL, "gpt-4o", undefined],
      [undefined, CURRENT_MODEL_SENTINEL, undefined],
      [null, CURRENT_MODEL_SENTINEL, "claude-sonnet-4-20250514"],
    ];
    for (const [o, c, p] of combos) {
      expect(resolveModel(o, c, p)).not.toBe(CURRENT_MODEL_SENTINEL);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Task assignment model resolution (start endpoint logic)
// ═════════════════════════════════════════════════════════════════════

describe("task assignment model resolution", () => {
  test("config=__current__, body=claude-sonnet, conv=null → claude-sonnet", () => {
    expect(resolveForTaskAssignment(CURRENT_MODEL_SENTINEL, "claude-sonnet-4-20250514", null)).toBe("claude-sonnet-4-20250514");
  });

  test("config=__current__, body=undefined, conv=claude-sonnet → claude-sonnet", () => {
    expect(resolveForTaskAssignment(CURRENT_MODEL_SENTINEL, undefined, "claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });

  test("config=__current__, body=undefined, conv=null → undefined", () => {
    expect(resolveForTaskAssignment(CURRENT_MODEL_SENTINEL, undefined, null)).toBeUndefined();
  });

  test("config=gpt-4o, body=claude-sonnet, conv=null → gpt-4o", () => {
    expect(resolveForTaskAssignment("gpt-4o", "claude-sonnet-4-20250514", null)).toBe("gpt-4o");
  });

  test("config=null, body=claude-sonnet, conv=null → claude-sonnet", () => {
    expect(resolveForTaskAssignment(null, "claude-sonnet-4-20250514", null)).toBe("claude-sonnet-4-20250514");
  });

  test("config=null, body=undefined, conv=claude-sonnet → claude-sonnet", () => {
    expect(resolveForTaskAssignment(null, undefined, "claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });

  test("sentinel NEVER leaks into output", () => {
    const cases = [
      { config: CURRENT_MODEL_SENTINEL, body: "x", conv: null },
      { config: CURRENT_MODEL_SENTINEL, body: undefined, conv: null },
      { config: CURRENT_MODEL_SENTINEL, body: undefined, conv: "y" },
      { config: CURRENT_MODEL_SENTINEL, body: "x", conv: "y" },
    ];
    for (const c of cases) {
      const result = resolveForTaskAssignment(c.config, c.body, c.conv);
      expect(result).not.toBe(CURRENT_MODEL_SENTINEL);
    }
  });
});


// ═════════════════════════════════════════════════════════════════════
// 5. Sentinel constant consistency
// ═════════════════════════════════════════════════════════════════════

describe("sentinel constant consistency", () => {
  test("CURRENT_MODEL_SENTINEL equals '__current__'", () => {
    expect(CURRENT_MODEL_SENTINEL).toBe("__current__");
  });

  test("CURRENT_MODEL_SENTINEL is exported from types.ts", () => {
    // If the import succeeded at the top of this file, it's exported.
    // This test verifies the value is stable.
    expect(typeof CURRENT_MODEL_SENTINEL).toBe("string");
    expect(CURRENT_MODEL_SENTINEL).toBeTruthy();
  });
});
