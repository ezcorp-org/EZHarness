import { test, expect, describe } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { applyToolFilters, ORCHESTRATION_TOOLS } from "../runtime/tools/filter";

// Minimal test fixtures — we only need `name`, so cast the rest.
function tool(name: string): AgentTool {
  return { name } as unknown as AgentTool;
}

function def(name: string, category: BuiltinToolDef["category"]): BuiltinToolDef {
  return { name, category } as unknown as BuiltinToolDef;
}

// A realistic mix: two read, two write, one orchestration, one extension-only
const sample = (): AgentTool[] => [
  tool("read_file"),
  tool("grep"),
  tool("write_file"),
  tool("bash_execute"),
  tool("invoke_agent"),     // always-preserved orchestration tool
  tool("extension_widget"), // not in builtinDefs
];

const builtinDefs = new Map<string, BuiltinToolDef>([
  ["read_file", def("read_file", "read")],
  ["grep", def("grep", "read")],
  ["write_file", def("write_file", "write")],
  ["bash_execute", def("bash_execute", "execute")],
]);

const names = (ts: AgentTool[]) => ts.map((t) => t.name).sort();

describe("applyToolFilters", () => {
  test("no options is identity", () => {
    expect(names(applyToolFilters(sample(), builtinDefs, {}))).toEqual(names(sample()));
  });

  describe("toolRestriction", () => {
    test("read-only keeps read tools + orchestration; drops write/execute + unknown", () => {
      const out = applyToolFilters(sample(), builtinDefs, { toolRestriction: "read-only" });
      expect(names(out)).toEqual(["grep", "invoke_agent", "read_file"]);
    });

    test("none keeps only orchestration tools", () => {
      const out = applyToolFilters(sample(), builtinDefs, { toolRestriction: "none" });
      expect(names(out)).toEqual(["invoke_agent"]);
    });

    test("all is a no-op", () => {
      const out = applyToolFilters(sample(), builtinDefs, { toolRestriction: "all" });
      expect(names(out)).toEqual(names(sample()));
    });
  });

  describe("allowedTools", () => {
    test("keeps only listed tools (plus orchestration, always)", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        allowedTools: ["read_file"],
      });
      expect(names(out)).toEqual(["invoke_agent", "read_file"]);
    });

    test("empty allowedTools list is a no-op (not an allow-none)", () => {
      const out = applyToolFilters(sample(), builtinDefs, { allowedTools: [] });
      expect(names(out)).toEqual(names(sample()));
    });
  });

  describe("deniedTools", () => {
    test("removes listed tools but preserves orchestration", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        deniedTools: ["bash_execute", "write_file", "invoke_agent"],
      });
      // invoke_agent is orchestration → preserved even when denied
      expect(names(out)).toEqual(["extension_widget", "grep", "invoke_agent", "read_file"]);
    });

    test("empty deniedTools list is a no-op", () => {
      const out = applyToolFilters(sample(), builtinDefs, { deniedTools: [] });
      expect(names(out)).toEqual(names(sample()));
    });
  });

  describe("layered filters", () => {
    test("read-only + deny: intersects correctly", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "read-only",
        deniedTools: ["grep"],
      });
      // read-only leaves [grep, invoke_agent, read_file]; deny removes grep
      expect(names(out)).toEqual(["invoke_agent", "read_file"]);
    });

    test("allow + deny: deny applied after allow", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        allowedTools: ["read_file", "grep", "write_file"],
        deniedTools: ["write_file"],
      });
      expect(names(out)).toEqual(["grep", "invoke_agent", "read_file"]);
    });

    test("restriction:none + allow: orchestration always wins over allow semantics", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "none",
        allowedTools: ["read_file"],
      });
      // "none" strips to orchestration-only BEFORE allow filter runs
      expect(names(out)).toEqual(["invoke_agent"]);
    });
  });

  test("ORCHESTRATION_TOOLS includes the expected delegation and task primitives", () => {
    expect(ORCHESTRATION_TOOLS.has("invoke_agent")).toBe(true);
    // The registry exposes the ask-user tool under the namespaced form
    // — that's what the filter must preserve so the LLM never sees a
    // restrictive scope strip its access to the human-in-the-loop tool.
    expect(ORCHESTRATION_TOOLS.has("ask-user__ask_user_question")).toBe(true);
    // ask_human was renamed/replaced by ask_user_question in the
    // ask-user migration; legacy and bare-name forms must NOT be in
    // the preserved set.
    expect(ORCHESTRATION_TOOLS.has("ask_human")).toBe(false);
    expect(ORCHESTRATION_TOOLS.has("ask_user_question")).toBe(false);
    expect(ORCHESTRATION_TOOLS.has("task_plan")).toBe(true);
    // Scratchpad moved to the `scratchpad` bundled extension in Phase 1 —
    // the filter now matches the namespaced form (`<ext>__<tool>`).
    expect(ORCHESTRATION_TOOLS.has("scratchpad__scratchpad_read")).toBe(true);
    expect(ORCHESTRATION_TOOLS.has("scratchpad__scratchpad_write")).toBe(true);
    // The bare (pre-conversion) names must NOT be preserved — a stray
    // built-in invocation should be blocked under restrictive filters.
    expect(ORCHESTRATION_TOOLS.has("scratchpad_read")).toBe(false);
    expect(ORCHESTRATION_TOOLS.has("scratchpad_write")).toBe(false);
    expect(ORCHESTRATION_TOOLS.has("read_file")).toBe(false);
  });
});
