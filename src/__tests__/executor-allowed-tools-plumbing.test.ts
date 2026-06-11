/**
 * Phase 48 Wave 1 — Executor mode-lookup → applyToolFilters plumbing.
 *
 * The executor's mode-restriction block (src/runtime/executor.ts) reads
 * `mode.allowedTools` alongside `mode.toolRestriction` and forwards both
 * into applyToolFilters. Full executor invocation is too heavyweight to
 * run end-to-end here (real LLMs, sub-agent spawn, attachments, etc.),
 * so this test covers the contract from two complementary angles:
 *
 *   1. STATIC: the executor source contains the plumbing pattern. If
 *      anyone refactors that block and drops `mode.allowedTools` from
 *      the applyToolFilters call, the regex catches it.
 *
 *   2. BEHAVIORAL: feed applyToolFilters the exact input the executor
 *      would (a fake mode with allowlist=[a]) and verify tool `b` is
 *      filtered out. This proves the WIRING logic: when a mode says
 *      "allowlist=[a]", `b` does not survive.
 *
 * Together these pin the must-have: "tool call to an unlisted tool from
 * an Ez-mode conversation is rejected".
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { applyToolFilters } from "../runtime/tools/filter";

function tool(name: string): AgentTool {
  return { name } as unknown as AgentTool;
}

function def(name: string, category: BuiltinToolDef["category"]): BuiltinToolDef {
  return { name, category } as unknown as BuiltinToolDef;
}

describe("executor → applyToolFilters plumbing for mode.allowedTools", () => {
  test("STATIC: executor.ts routes getMode through computeModeToolScope into applyToolFilters", () => {
    // The mode-restriction plumbing was extracted into
    // src/runtime/tools/mode-tool-scope.ts (shared with the /api/tools
    // listing endpoint so the header badge can't drift from the runtime
    // surface). The static pin now spans both files: the executor must
    // feed the getMode result through computeModeToolScope and apply the
    // returned scope; the scope module must forward mode.allowedTools
    // alongside mode.toolRestriction in its legacy fallback.
    const executorSrc = readFileSync(
      join(import.meta.dir, "..", "runtime", "executor.ts"),
      "utf-8",
    );
    expect(executorSrc).toContain("applyToolFilters");
    expect(executorSrc).toContain("getMode");
    expect(/computeModeToolScope\(\s*mode/.test(executorSrc)).toBe(true);
    expect(/applyToolFilters\(ctx\.agentTools,\s*ctx\.builtinToolDefsMap,\s*scope\)/.test(executorSrc)).toBe(true);

    const scopeSrc = readFileSync(
      join(import.meta.dir, "..", "runtime", "tools", "mode-tool-scope.ts"),
      "utf-8",
    );
    expect(/toolRestriction:\s*mode\.toolRestriction[\s\S]*?allowedTools:\s*mode\.allowedTools/.test(scopeSrc))
      .toBe(true);
  });

  test("BEHAVIORAL: a fake mode with allowlist=[a] drops tool 'b' through the filter", () => {
    const tools: AgentTool[] = [tool("a"), tool("b"), tool("invoke_agent")];
    const builtinDefs = new Map<string, BuiltinToolDef>([
      ["a", def("a", "write")],
      ["b", def("b", "write")],
    ]);
    // Simulate: getMode returned { toolRestriction: 'allowlist', allowedTools: ['a'] }.
    const filtered = applyToolFilters(tools, builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: ["a"],
    });
    const names = filtered.map((t) => t.name).sort();
    // 'a' survived (allowlisted), 'b' did not (excluded), invoke_agent
    // is preserved as orchestration.
    expect(names).toEqual(["a", "invoke_agent"]);
    expect(names.includes("b")).toBe(false);
  });

  test("BEHAVIORAL: mode with NULL allowedTools but restriction='allowlist' is fail-closed", () => {
    // A mode row that was created with restriction='allowlist' but never
    // had its allowedTools populated MUST NOT pass the toolset through.
    // This is the safety property the executor relies on if mode storage
    // ever drifts (e.g., a buggy migration).
    const tools: AgentTool[] = [tool("a"), tool("b"), tool("invoke_agent")];
    const builtinDefs = new Map<string, BuiltinToolDef>([
      ["a", def("a", "write")],
      ["b", def("b", "write")],
    ]);
    const filtered = applyToolFilters(tools, builtinDefs, {
      toolRestriction: "allowlist",
      // mode.allowedTools is null in DB → undefined here after `?? undefined`.
      allowedTools: undefined,
    });
    expect(filtered.map((t) => t.name)).toEqual(["invoke_agent"]);
  });
});
