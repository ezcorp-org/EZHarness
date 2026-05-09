import { test, expect, describe } from "bun:test";

import { getBuiltInToolMetadata, getBuiltInCategories, getBuiltInToolsByCategory } from "../runtime/tools/builtin-registry";

describe("builtin-registry", () => {
  test("returns only `ez` category tools (legacy categories all moved to bundled extensions)", () => {
    // Phase 1 moved the 2 scratchpad tools out of the built-in registry
    // into a bundled extension. Phase 3 commit-5 moved the 12
    // task-tracking tools. Phase 4 commit-5 moved `invoke_agent`.
    // Phase 5 commit 4 moved the last legacy resident, `ask_human`, to the
    // bundled `orchestration` extension.
    // v1.2 Ez Button (Phase 47) re-populated the registry with `ez`-category
    // tools that are intentionally locked to the in-app Ez concierge mode.
    const tools = getBuiltInToolMetadata();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => (t as { category: string }).category === "ez")).toBe(true);
  });

  test("scratchpad, task-tracking, invoke_agent, and ask_human are no longer in the built-in registry", () => {
    const tools = getBuiltInToolMetadata();
    expect(tools.some((t) => t.name === "scratchpad_write")).toBe(false);
    expect(tools.some((t) => t.name === "task_plan")).toBe(false);
    expect(tools.some((t) => t.name === "task_list")).toBe(false);
    expect(tools.some((t) => t.name === "invoke_agent")).toBe(false);
    expect(tools.some((t) => t.name === "ask_human")).toBe(false);
    expect(tools.some((t) => (t as { category: string }).category === "scratchpad")).toBe(false);
    expect(tools.some((t) => (t as { category: string }).category === "task-tracking")).toBe(false);
    expect(tools.some((t) => (t as { category: string }).category === "orchestration")).toBe(false);
  });

  test("only the `ez` category remains for built-in tools", () => {
    const tools = getBuiltInToolMetadata();
    const categories = new Set(tools.map((t) => t.category));
    expect([...categories]).toEqual(["ez"]);
  });

  test("no duplicate names", () => {
    const tools = getBuiltInToolMetadata();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("getBuiltInCategories returns empty — `ez` tools are not mentionable categories", () => {
    // The ez-category tools are locked to the in-app Ez concierge mode and
    // are NOT surfaced as user-mentionable categories. Legacy categories
    // (task-tracking / scratchpad / orchestration) are gone for good.
    const categories = getBuiltInCategories();
    const names = categories.map((c) => c.name);
    expect(names).not.toContain("task-tracking");
    expect(names).not.toContain("scratchpad");
    expect(names).not.toContain("orchestration");
    expect(names).toEqual([]);
  });

  test("getBuiltInToolsByCategory returns empty arrays for every removed category", () => {
    expect(getBuiltInToolsByCategory("task-tracking")).toHaveLength(0);
    expect(getBuiltInToolsByCategory("scratchpad")).toHaveLength(0);
    expect(getBuiltInToolsByCategory("orchestration")).toHaveLength(0);
  });
});
