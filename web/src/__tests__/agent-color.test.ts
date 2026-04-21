import { test, expect, describe } from "bun:test";
import { agentColor } from "../lib/agent-color";

describe("agentColor", () => {
  test("returns deterministic color for same name", () => {
    expect(agentColor("test")).toBe(agentColor("test"));
  });

  test("returns different colors for different names", () => {
    expect(agentColor("test")).not.toBe(agentColor("other"));
  });

  test("returns valid hex color", () => {
    expect(agentColor("anything")).toMatch(/^#[0-9A-F]{6}$/i);
  });
});
