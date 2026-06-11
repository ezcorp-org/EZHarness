/**
 * Unit tests for computeModeToolScope — the shared mode → tool-scope
 * decision used by BOTH the executor's runtime filter and the
 * /api/tools listing endpoint (the header badge). Pure logic, no DB.
 * Gated at 100%.
 *
 * The contract being validated: a mode's attached extensions define the
 * COMPLETE tool surface (union, optionally narrowed per-extension and
 * per-conversation, narrow-only) — no tool outside that surface may
 * survive, and legacy toolRestriction modes pass through unchanged.
 */
import { test, expect, describe } from "bun:test";
import { computeModeToolScope, type ModeScopeRegistry } from "../runtime/tools/mode-tool-scope";
import { applyToolFilters, ORCHESTRATION_TOOLS } from "../runtime/tools/filter";

/** Registry stub: extId → namespaced tool names (originalName = suffix). */
function makeRegistry(byExt: Record<string, string[]>): ModeScopeRegistry {
  return {
    getToolsForExtension(extId: string) {
      return (byExt[extId] ?? []).map((name) => ({
        name,
        originalName: name.includes("__") ? name.slice(name.indexOf("__") + 2) : name,
      }));
    },
  };
}

const registry = makeRegistry({
  "ext-a": ["alpha__scan", "alpha__lint"],
  "ext-b": ["bravo__summarize"],
});

describe("computeModeToolScope — no mode / no restriction", () => {
  test("null mode → null (no filtering)", () => {
    expect(computeModeToolScope(null, null, registry)).toBeNull();
    expect(computeModeToolScope(undefined, null, registry)).toBeNull();
  });

  test("mode with empty extensionIds and no toolRestriction → null", () => {
    expect(computeModeToolScope({ extensionIds: [] }, null, registry)).toBeNull();
    expect(computeModeToolScope({}, null, registry)).toBeNull();
  });
});

describe("computeModeToolScope — extensionIds allowlist", () => {
  test("union of all attached extensions' namespaced tool names", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-a", "ext-b"] },
      null,
      registry,
    );
    expect(scope?.toolRestriction).toBe("allowlist");
    expect(scope?.allowedTools?.sort()).toEqual(
      ["alpha__lint", "alpha__scan", "bravo__summarize"],
    );
  });

  test("per-extension subset narrows that extension's contribution", () => {
    const scope = computeModeToolScope(
      {
        extensionIds: ["ext-a", "ext-b"],
        extensionTools: { "ext-a": ["alpha__scan"] },
      },
      null,
      registry,
    );
    expect(scope?.allowedTools?.sort()).toEqual(["alpha__scan", "bravo__summarize"]);
  });

  test("subset may reference the original (unnamespaced) name", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-a"], extensionTools: { "ext-a": ["scan"] } },
      null,
      registry,
    );
    expect(scope?.allowedTools).toEqual(["alpha__scan"]);
  });

  test("EMPTY mode subset = extension toggled OFF (contributes nothing)", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-a", "ext-b"], extensionTools: { "ext-a": [] } },
      null,
      registry,
    );
    expect(scope?.allowedTools).toEqual(["bravo__summarize"]);
  });

  test("unknown extension id contributes nothing (empty allowlist still fail-closed)", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-missing"] },
      null,
      registry,
    );
    expect(scope).toEqual({ toolRestriction: "allowlist", allowedTools: [] });
  });

  test("extensionIds supersedes a legacy toolRestriction on the same mode", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-b"], toolRestriction: "read-only" },
      null,
      registry,
    );
    expect(scope?.toolRestriction).toBe("allowlist");
    expect(scope?.allowedTools).toEqual(["bravo__summarize"]);
  });
});

describe("computeModeToolScope — per-conversation narrowing (narrow-only)", () => {
  test("conversation subset narrows the mode allowlist", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-a", "ext-b"] },
      { "ext-a": ["alpha__lint"] },
      registry,
    );
    expect(scope?.allowedTools?.sort()).toEqual(["alpha__lint", "bravo__summarize"]);
  });

  test("conversation subset may use the original (unnamespaced) name", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-a"] },
      { "ext-a": ["lint"] },
      registry,
    );
    expect(scope?.allowedTools).toEqual(["alpha__lint"]);
  });

  test("conversation can NOT widen: tools outside the mode allowlist never appear", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-a"], extensionTools: { "ext-a": ["alpha__scan"] } },
      // conv asks for lint (excluded by the mode subset) AND a foreign tool
      { "ext-a": ["alpha__scan", "alpha__lint"], "ext-b": ["bravo__summarize"] },
      registry,
    );
    expect(scope?.allowedTools).toEqual(["alpha__scan"]);
  });

  test("EMPTY conversation subset = master toggle OFF (removes the whole extension)", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-a", "ext-b"] },
      { "ext-a": [] },
      registry,
    );
    expect(scope?.allowedTools).toEqual(["bravo__summarize"]);
  });

  test("conversation map without matching extension keys = no narrowing", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-a"] },
      { "ext-unrelated": ["whatever"] },
      registry,
    );
    expect(scope?.allowedTools?.sort()).toEqual(["alpha__lint", "alpha__scan"]);
  });

  test("empty conversation map = no narrowing", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-b"] },
      {},
      registry,
    );
    expect(scope?.allowedTools).toEqual(["bravo__summarize"]);
  });
});

describe("computeModeToolScope — no-mode conversation narrowing (deny path)", () => {
	test("conversation subset without a mode denies that extension's other tools", () => {
		const scope = computeModeToolScope(null, { "ext-a": ["alpha__scan"] }, registry);
		expect(scope).toEqual({ forceDeniedTools: ["alpha__lint"] });
	});

	test("subset may use the original (unnamespaced) name", () => {
		const scope = computeModeToolScope(null, { "ext-a": ["scan"] }, registry);
		expect(scope).toEqual({ forceDeniedTools: ["alpha__lint"] });
	});

	test("EMPTY subset = master toggle OFF: denies ALL of that extension's tools", () => {
		const scope = computeModeToolScope(null, { "ext-a": [] }, registry);
		expect(scope?.forceDeniedTools?.sort()).toEqual(["alpha__lint", "alpha__scan"]);
	});

	test("absent subsets and unknown extensions deny nothing", () => {
		expect(computeModeToolScope(null, { "ext-missing": ["whatever"] }, registry)).toBeNull();
		expect(computeModeToolScope(null, { "ext-missing": [] }, registry)).toBeNull();
		expect(computeModeToolScope(null, {}, registry)).toBeNull();
		expect(computeModeToolScope(null, null, registry)).toBeNull();
	});

	test("narrowing multiple extensions accumulates denials", () => {
		const scope = computeModeToolScope(
			null,
			{ "ext-a": ["alpha__scan"], "ext-b": ["nope"] },
			registry,
		);
		expect(scope?.forceDeniedTools?.sort()).toEqual(["alpha__lint", "bravo__summarize"]);
	});

	test("combines with a legacy toolRestriction mode (restriction + deny layers)", () => {
		const scope = computeModeToolScope(
			{ toolRestriction: "all" },
			{ "ext-a": ["alpha__scan"] },
			registry,
		);
		expect(scope).toEqual({
			toolRestriction: "all",
			allowedTools: undefined,
			forceDeniedTools: ["alpha__lint"],
		});
	});
});

describe("computeModeToolScope — legacy toolRestriction fallback", () => {
  test("toolRestriction without extensionIds passes through with allowedTools", () => {
    expect(
      computeModeToolScope(
        { toolRestriction: "allowlist", allowedTools: ["alpha__scan"] },
        null,
        registry,
      ),
    ).toEqual({ toolRestriction: "allowlist", allowedTools: ["alpha__scan"] });
  });

  test("null allowedTools maps to undefined (no allow layer)", () => {
    expect(
      computeModeToolScope({ toolRestriction: "none", allowedTools: null }, null, registry),
    ).toEqual({ toolRestriction: "none", allowedTools: undefined });
  });

  test("read-only / all pass through verbatim", () => {
    expect(
      computeModeToolScope({ toolRestriction: "read-only" }, null, registry)?.toolRestriction,
    ).toBe("read-only");
    expect(
      computeModeToolScope({ toolRestriction: "all" }, null, registry)?.toolRestriction,
    ).toBe("all");
  });
});

describe("scope → applyToolFilters end-to-end (no random tools survive)", () => {
  const loaded = [
    { name: "alpha__scan" },
    { name: "alpha__lint" },
    { name: "bravo__summarize" },
    { name: "rogue__exfiltrate" },
    { name: "invoke_agent" }, // orchestration — always survives
  ];

  test("mode allowlist: EXACTLY the mode's tools (+ orchestration) remain", () => {
    const scope = computeModeToolScope({ extensionIds: ["ext-a"] }, null, registry)!;
    const out = applyToolFilters(loaded, new Map(), scope).map((t) => t.name);
    expect(out.sort()).toEqual(["alpha__lint", "alpha__scan", "invoke_agent"]);
    // explicit negative: nothing outside the mode surface leaks
    expect(out).not.toContain("rogue__exfiltrate");
    expect(out).not.toContain("bravo__summarize");
  });

  test("toolRestriction 'none': only orchestration tools remain", () => {
    const scope = computeModeToolScope({ toolRestriction: "none" }, null, registry)!;
    const out = applyToolFilters(loaded, new Map(), scope).map((t) => t.name);
    expect(out.every((n) => ORCHESTRATION_TOOLS.has(n))).toBe(true);
  });

  test("no-mode conversation toggle: unchecked tool drops, everything else untouched", () => {
    const scope = computeModeToolScope(null, { "ext-a": ["alpha__scan"] }, registry)!;
    const out = applyToolFilters(loaded, new Map(), scope).map((t) => t.name);
    expect(out.sort()).toEqual([
      "alpha__scan",
      "bravo__summarize",
      "invoke_agent",
      "rogue__exfiltrate",
    ]);
    expect(out).not.toContain("alpha__lint");
  });
});

describe("orchestration tools — explicit conversation toggle wins", () => {
  // ask-user__ask_user_question is in ORCHESTRATION_TOOLS: it survives
  // restriction/allow/deny layers, and ONLY the conversation's explicit
  // toggles (forceDeniedTools) may remove it.
  const orchRegistry = makeRegistry({
    "ext-a": ["alpha__scan"],
    "ext-askuser": ["ask-user__ask_user_question"],
  });
  const loaded = [
    { name: "alpha__scan" },
    { name: "ask-user__ask_user_question" },
  ];

  test("sanity: the fixture tool really is orchestration-exempt", () => {
    expect(ORCHESTRATION_TOOLS.has("ask-user__ask_user_question")).toBe(true);
  });

  test("mode allowlist does NOT strip ask-user (exemption intact)", () => {
    const scope = computeModeToolScope({ extensionIds: ["ext-a"] }, null, orchRegistry)!;
    const out = applyToolFilters(loaded, new Map(), scope).map((t) => t.name);
    expect(out.sort()).toEqual(["alpha__scan", "ask-user__ask_user_question"]);
  });

  test("conversation master-toggle OFF strips ask-user even under a mode allowlist", () => {
    const scope = computeModeToolScope(
      { extensionIds: ["ext-a"] },
      { "ext-askuser": [] },
      orchRegistry,
    )!;
    expect(scope.forceDeniedTools).toEqual(["ask-user__ask_user_question"]);
    const out = applyToolFilters(loaded, new Map(), scope).map((t) => t.name);
    expect(out).toEqual(["alpha__scan"]);
  });

  test("conversation master-toggle OFF strips ask-user with no mode", () => {
    const scope = computeModeToolScope(null, { "ext-askuser": [] }, orchRegistry)!;
    const out = applyToolFilters(loaded, new Map(), scope).map((t) => t.name);
    expect(out).toEqual(["alpha__scan"]);
  });
});
