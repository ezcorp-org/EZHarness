/**
 * Caller-executed tools versus the tool-scoping layers — the two halves of
 * the same decision:
 *
 *   PRESERVATION (§3.6, `tools/filter.ts`). A mode declares its tool surface
 *   with `extensionIds` or `allowedTools`, and a caller tool belongs to no
 *   extension, so NO mode can name one. Without `preservedTools`, any mode
 *   with `extensionIds`, `read-only`, `none`, or `allowlist` silently strips
 *   every caller tool from a conversation that explicitly declared them.
 *
 *   REVOCATION (§3.5, `tools/mode-tool-scope.ts`). The owner's Tools dropdown
 *   must still be able to switch them off — so the conversation's toggle map
 *   compiles caller exclusions into `forceDeniedTools`, the ONE layer
 *   preservation does not survive. If preservation covered that layer too,
 *   the toggle would be a suggestion rather than a revocation.
 *
 * The asymmetry is the design, and each test below names which side it pins.
 */
import { describe, expect, test } from "bun:test";
import { applyToolFilters, type ToolFilterOptions } from "../runtime/tools/filter";
import { computeModeToolScope, type ModeScopeRegistry } from "../runtime/tools/mode-tool-scope";
import { callerToolWireName } from "../runtime/caller-tool-declarations";

const OPEN = callerToolWireName("open_app");
const CLOSE = callerToolWireName("close_app");

const TOOLS = [
  { name: OPEN },
  { name: CLOSE },
  { name: "readFile" },
  { name: "shell" },
  { name: "invoke_agent" },
  { name: "ext-a__do_thing" },
];
const DEFS = new Map<string, { category: string }>([
  ["readFile", { category: "read" }],
  ["shell", { category: "execute" }],
  [OPEN, { category: "caller" }],
  [CLOSE, { category: "caller" }],
]);

function names(opts: ToolFilterOptions): string[] {
  return applyToolFilters(TOOLS, DEFS, opts).map((t) => t.name);
}

const PRESERVED = { preservedTools: [OPEN, CLOSE] };

// ── Preservation ───────────────────────────────────────────────────────

describe("preservedTools carries caller tools through every narrowing layer", () => {
  test("read-only, which would otherwise keep only `category: read` built-ins", () => {
    expect(names({ toolRestriction: "read-only" })).toEqual(["readFile", "invoke_agent"]);
    expect(names({ toolRestriction: "read-only", ...PRESERVED })).toEqual([
      OPEN,
      CLOSE,
      "readFile",
      "invoke_agent",
    ]);
  });

  test("none, which would otherwise keep only orchestration tools", () => {
    expect(names({ toolRestriction: "none" })).toEqual(["invoke_agent"]);
    expect(names({ toolRestriction: "none", ...PRESERVED })).toEqual([OPEN, CLOSE, "invoke_agent"]);
  });

  test("a misconfigured allowlist (restriction set, list empty) — the fail-closed leg", () => {
    expect(names({ toolRestriction: "allowlist" })).toEqual(["invoke_agent"]);
    expect(names({ toolRestriction: "allowlist", ...PRESERVED })).toEqual([
      OPEN,
      CLOSE,
      "invoke_agent",
    ]);
  });

  test("a mode allowlist that cannot name them (this is the §3.6 defect)", () => {
    const modeScope: ToolFilterOptions = {
      toolRestriction: "allowlist",
      allowedTools: ["ext-a__do_thing"],
    };
    expect(names(modeScope)).toEqual(["invoke_agent", "ext-a__do_thing"]);
    expect(names({ ...modeScope, ...PRESERVED })).toEqual([
      OPEN,
      CLOSE,
      "invoke_agent",
      "ext-a__do_thing",
    ]);
  });

  test("a team deny-list", () => {
    const denyScope: ToolFilterOptions = { deniedTools: [OPEN, "shell"] };
    expect(names(denyScope)).toEqual([CLOSE, "readFile", "invoke_agent", "ext-a__do_thing"]);
    expect(names({ ...denyScope, ...PRESERVED })).toEqual([
      OPEN,
      CLOSE,
      "readFile",
      "invoke_agent",
      "ext-a__do_thing",
    ]);
  });

  test("layered narrowings in sequence, the way the executor applies them", () => {
    const scoped = [
      { toolRestriction: "read-only" as const, ...PRESERVED },
      { deniedTools: [OPEN, CLOSE, "readFile"], ...PRESERVED },
    ].reduce((tools, s) => applyToolFilters(tools, DEFS, s), TOOLS);
    expect(scoped.map((t) => t.name)).toEqual([OPEN, CLOSE, "invoke_agent"]);
  });

  test("an absent or empty list changes nothing at all", () => {
    expect(names({ toolRestriction: "none", preservedTools: [] })).toEqual(
      names({ toolRestriction: "none" }),
    );
  });
});

describe("preservation stops at forceDeniedTools — deliberately", () => {
  test("a force-denied caller tool is removed even while preserved", () => {
    expect(names({ toolRestriction: "none", ...PRESERVED, forceDeniedTools: [OPEN] })).toEqual([
      CLOSE,
      "invoke_agent",
    ]);
  });

  test("the same layer removes orchestration tools, which is the precedent", () => {
    expect(
      names({ toolRestriction: "none", ...PRESERVED, forceDeniedTools: ["invoke_agent"] }),
    ).toEqual([OPEN, CLOSE]);
  });
});

// ── Revocation ─────────────────────────────────────────────────────────

/** The caller key owns no registry row, so this registry answers `[]` for it —
 *  which is exactly why the `"caller"` branch cannot live inside the loop that
 *  iterates `getToolsForExtension`. */
const registry: ModeScopeRegistry = {
  getToolsForExtension: (extId) =>
    extId === "ext-a" ? [{ name: "ext-a__do_thing", originalName: "do_thing" }] : [],
};

const CALLER_NAMES = [OPEN, CLOSE];

function scopeFor(convToggles: Record<string, string[]> | null) {
  return computeModeToolScope(null, convToggles, registry, CALLER_NAMES);
}

describe("the conversation's caller toggle", () => {
  test("absent key → every caller tool passes", () => {
    expect(scopeFor(null)).toBeNull();
    expect(scopeFor({ "ext-a": ["ext-a__do_thing"] })).toBeNull();
  });

  test("EMPTY subset → every caller tool is force-denied (master toggle off)", () => {
    // Unreachable through the `getToolsForExtension` loop, which is the whole
    // reason for the separate branch: that call returns [] for "caller", so
    // the loop would deny nothing and the toggle would do nothing.
    expect(scopeFor({ caller: [] })).toEqual({ forceDeniedTools: [OPEN, CLOSE] });
  });

  test("non-empty subset → the tools it omits are force-denied", () => {
    expect(scopeFor({ caller: [OPEN] })).toEqual({ forceDeniedTools: [CLOSE] });
  });

  test("the subset matches the BARE name too, since that is what the UI holds", () => {
    expect(scopeFor({ caller: ["open_app"] })).toEqual({ forceDeniedTools: [CLOSE] });
    expect(scopeFor({ caller: ["open_app", CLOSE] })).toBeNull();
  });

  test("a conversation with no declarations denies nothing, whatever the toggle says", () => {
    expect(computeModeToolScope(null, { caller: [] }, registry, [])).toBeNull();
    expect(computeModeToolScope(null, { caller: [] }, registry)).toBeNull();
  });

  test("caller and real-extension toggles compose in one map", () => {
    expect(scopeFor({ caller: [OPEN], "ext-a": [] })).toEqual({
      forceDeniedTools: [CLOSE, "ext-a__do_thing"],
    });
  });

  test("the revocation reaches applyToolFilters as a real removal", () => {
    const scope = scopeFor({ caller: [] })!;
    // Preserved by the executor AND force-denied by the owner: the owner wins.
    expect(names({ ...scope, ...PRESERVED, toolRestriction: "none" })).toEqual(["invoke_agent"]);
  });
});

describe("the caller branch inside a mode's extension allowlist", () => {
  const mode = { extensionIds: ["ext-a"] };

  test("a mode allowlist never contains caller tools — preservation is what saves them", () => {
    const scope = computeModeToolScope(mode, null, registry, CALLER_NAMES)!;
    expect(scope.allowedTools).toEqual(["ext-a__do_thing"]);
    expect(scope.forceDeniedTools).toBeUndefined();
    // Without preservation the declared tools are gone…
    expect(names(scope)).toEqual(["invoke_agent", "ext-a__do_thing"]);
    // …and with it they survive the mode that could not name them.
    expect(names({ ...scope, ...PRESERVED })).toEqual([
      OPEN,
      CLOSE,
      "invoke_agent",
      "ext-a__do_thing",
    ]);
  });

  test("…and the conversation toggle still revokes them under that mode", () => {
    const scope = computeModeToolScope(mode, { caller: [] }, registry, CALLER_NAMES)!;
    expect(scope.forceDeniedTools).toEqual([OPEN, CLOSE]);
    expect(names({ ...scope, ...PRESERVED })).toEqual(["invoke_agent", "ext-a__do_thing"]);
  });
});

describe("the legacy toolRestriction path threads the caller denials too", () => {
  test("a mode with a bare restriction keeps the conversation's caller toggle", () => {
    const scope = computeModeToolScope(
      { toolRestriction: "read-only" },
      { caller: [OPEN] },
      registry,
      CALLER_NAMES,
    );
    expect(scope).toEqual({
      toolRestriction: "read-only",
      allowedTools: undefined,
      forceDeniedTools: [CLOSE],
    });
  });
});
