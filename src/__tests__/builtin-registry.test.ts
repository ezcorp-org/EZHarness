import { test, expect, describe } from "bun:test";

import { getBuiltInToolMetadata, getBuiltInCategories, getBuiltInToolsByCategory } from "../runtime/tools/builtin-registry";

describe("builtin-registry", () => {
  test("returns 2 tools (orchestration only)", () => {
    // Phase 1 moved the 2 scratchpad tools out of the built-in registry
    // into a bundled extension. Phase 3 commit-5 moved the 12
    // task-tracking tools to a bundled extension too. Only the 2
    // orchestration tools (invoke_agent, ask_human) remain as built-ins.
    const tools = getBuiltInToolMetadata();
    expect(tools).toHaveLength(2);
  });

  test("scratchpad and task-tracking are no longer in the built-in registry", () => {
    const tools = getBuiltInToolMetadata();
    expect(tools.some((t) => t.name === "scratchpad_write")).toBe(false);
    expect(tools.some((t) => t.name === "task_plan")).toBe(false);
    expect(tools.some((t) => t.name === "task_list")).toBe(false);
    expect(tools.some((t) => (t as { category: string }).category === "scratchpad")).toBe(false);
    expect(tools.some((t) => (t as { category: string }).category === "task-tracking")).toBe(false);
  });

  test("only orchestration category remains", () => {
    const tools = getBuiltInToolMetadata();
    const validCategories = new Set(["orchestration"]);
    for (const t of tools) {
      expect(validCategories.has(t.category)).toBe(true);
    }
  });

  test("no duplicate names", () => {
    const tools = getBuiltInToolMetadata();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("orchestration tools are not mentionable — getBuiltInCategories returns empty", () => {
    const categories = getBuiltInCategories();
    const names = categories.map((c) => c.name);
    expect(names).not.toContain("task-tracking");
    expect(names).not.toContain("scratchpad");
    expect(names).not.toContain("orchestration");
    // After Phase 3 commit-5 there are no mentionable built-in
    // categories left — everything user-visible lives as an extension.
    expect(names).toHaveLength(0);
  });

  test("getBuiltInToolsByCategory returns empty arrays for removed categories", () => {
    expect(getBuiltInToolsByCategory("task-tracking")).toHaveLength(0);
    expect(getBuiltInToolsByCategory("scratchpad")).toHaveLength(0);
    // orchestration tools have no inputSchema and filter out here.
    expect(getBuiltInToolsByCategory("orchestration")).toHaveLength(0);
  });
});
