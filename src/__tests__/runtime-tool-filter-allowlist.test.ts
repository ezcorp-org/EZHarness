/**
 * Phase 48 Wave 1 — applyToolFilters('allowlist') unit tests.
 *
 * The Ez concierge mode's safety boundary lives here: when
 * mode.toolRestriction === 'allowlist', the runtime intersects the
 * available toolset with mode.allowedTools BEFORE the LLM sees the
 * tool catalog. These tests pin every edge case the Ez harness relies
 * on:
 *
 *  1. allowlist + non-empty list → keeps listed + orchestration
 *  2. allowlist intersects with the actual toolset (missing names ignored)
 *  3. orchestration tools are preserved even when not in allowedTools
 *  4. allowlist + empty allowedTools → fail-closed (orchestration only)
 *  5. allowlist + missing allowedTools → fail-closed (orchestration only)
 *  6. allowlist + deny → deny applies after allow (consistent ordering)
 *  7. allowlist alone (no other filter) doesn't accidentally widen scope
 *  8. allowlist with the eight Ez tools is a stable contract
 *
 * The complement filters ('all', 'read-only', 'none') are covered in
 * apply-tool-filters.test.ts — this file is the allowlist-specific
 * companion landing alongside the broadened union type.
 */
import { test, expect, describe } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { applyToolFilters } from "../runtime/tools/filter";

function tool(name: string): AgentTool {
  return { name } as unknown as AgentTool;
}

function def(name: string, category: BuiltinToolDef["category"]): BuiltinToolDef {
  return { name, category } as unknown as BuiltinToolDef;
}

const EZ_TOOLS = [
  "propose_create_project",
  "propose_create_agent",
  "propose_install_extension",
  "summarize_conversation",
  "find_agents",
  "fill_form",
  "navigate_to",
];

// Realistic mix: Ez tools, some non-Ez tools, an orchestration tool, an
// extension that the LLM would otherwise see.
const sample = (): AgentTool[] => [
  ...EZ_TOOLS.map(tool),
  tool("read_file"),
  tool("write_file"),
  tool("bash_execute"),
  tool("invoke_agent"),    // orchestration — always preserved
  tool("ext_widget"),      // extension tool, no def entry
];

const builtinDefs = new Map<string, BuiltinToolDef>([
  ["read_file", def("read_file", "read")],
  ["write_file", def("write_file", "write")],
  ["bash_execute", def("bash_execute", "execute")],
  ...EZ_TOOLS.map((n) => [n, def(n, "write")] as const),
]);

const names = (ts: AgentTool[]) => ts.map((t) => t.name).sort();

describe("applyToolFilters — 'allowlist' restriction", () => {
  test("allowlist + non-empty list keeps listed tools and orchestration", () => {
    const out = applyToolFilters(sample(), builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: ["propose_create_project", "fill_form"],
    });
    expect(names(out)).toEqual(["fill_form", "invoke_agent", "propose_create_project"]);
  });

  test("allowlist intersects: names not in the toolset are silently ignored", () => {
    // 'nonexistent_tool' is in allowedTools but not in `sample()` — it must
    // not synthesize a tool out of thin air, just skip it.
    const out = applyToolFilters(sample(), builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: ["propose_create_project", "nonexistent_tool"],
    });
    expect(names(out)).toEqual(["invoke_agent", "propose_create_project"]);
  });

  test("orchestration tools survive even when omitted from allowedTools", () => {
    // 'invoke_agent' is NOT in allowedTools but is in ORCHESTRATION_TOOLS —
    // it must still appear in the output. Stripping orchestration would
    // break sub-agent delegation in Ez panel turns.
    const out = applyToolFilters(sample(), builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: ["fill_form"],
    });
    expect(out.find((t) => t.name === "invoke_agent")).toBeDefined();
    expect(out.find((t) => t.name === "fill_form")).toBeDefined();
    expect(out.find((t) => t.name === "read_file")).toBeUndefined();
  });

  test("allowlist + empty allowedTools fails closed to orchestration only", () => {
    // A misconfigured mode with restriction='allowlist' and an empty list
    // must NOT pass the entire toolset through. Strip everything but
    // orchestration.
    const out = applyToolFilters(sample(), builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: [],
    });
    expect(names(out)).toEqual(["invoke_agent"]);
  });

  test("allowlist + missing allowedTools fails closed to orchestration only", () => {
    // Same fail-closed rule when allowedTools is undefined entirely.
    const out = applyToolFilters(sample(), builtinDefs, {
      toolRestriction: "allowlist",
    });
    expect(names(out)).toEqual(["invoke_agent"]);
  });

  test("allowlist + deny: deny removes from the post-allow set", () => {
    const out = applyToolFilters(sample(), builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: ["propose_create_project", "fill_form", "navigate_to"],
      deniedTools: ["fill_form"],
    });
    expect(names(out)).toEqual(["invoke_agent", "navigate_to", "propose_create_project"]);
  });

  test("allowlist does not silently widen scope: only listed tools survive", () => {
    // No unrelated tool (read_file, ext_widget, write_file) leaks through
    // when the allowlist explicitly excludes them.
    const out = applyToolFilters(sample(), builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: ["propose_create_project"],
    });
    const surviving = new Set(out.map((t) => t.name));
    expect(surviving.has("read_file")).toBe(false);
    expect(surviving.has("write_file")).toBe(false);
    expect(surviving.has("bash_execute")).toBe(false);
    expect(surviving.has("ext_widget")).toBe(false);
  });

  test("the eight Ez tools survive when allowlist matches the design spec", () => {
    // The seeded Ez mode's allowed_tools array is the v1 stable contract.
    // Regressing this test means the seed and the filter disagree — Ez
    // would silently lose a capability.
    const out = applyToolFilters(sample(), builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: EZ_TOOLS,
    });
    const surviving = new Set(out.map((t) => t.name));
    for (const ez of EZ_TOOLS) {
      expect(surviving.has(ez)).toBe(true);
    }
    // Orchestration alongside.
    expect(surviving.has("invoke_agent")).toBe(true);
    // Non-Ez tools must be filtered out.
    expect(surviving.has("read_file")).toBe(false);
    expect(surviving.has("bash_execute")).toBe(false);
  });
});
