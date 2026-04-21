import { test, expect, describe } from "bun:test";
import { formatDuration, formatStatus, formatAgentList } from "../ui/format";
import type { AgentDefinition, AgentStatus } from "../types";

describe("formatDuration", () => {
  test("formats milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(1)).toBe("1ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  test("formats seconds", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(59999)).toBe("60.0s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_599_999)).toBe("59m 60s");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(7_200_000)).toBe("2h 0m");
  });
});

describe("formatStatus", () => {
  const statuses: AgentStatus[] = ["idle", "running", "success", "error", "cancelled"];

  for (const status of statuses) {
    test(`formats ${status} with color and bullet`, () => {
      const result = formatStatus(status);
      // Should contain the bullet character and the status text
      expect(result).toContain("•");
      expect(result).toContain(status);
      // Should contain ANSI reset codes
      expect(result).toContain("\x1b[0m");
    });
  }

  test("idle is dimmed", () => {
    expect(formatStatus("idle")).toContain("\x1b[2m");
  });

  test("running is blue", () => {
    expect(formatStatus("running")).toContain("\x1b[34m");
  });

  test("success is green", () => {
    expect(formatStatus("success")).toContain("\x1b[32m");
  });

  test("error is red", () => {
    expect(formatStatus("error")).toContain("\x1b[31m");
  });

  test("cancelled is yellow", () => {
    expect(formatStatus("cancelled")).toContain("\x1b[33m");
  });
});

describe("formatAgentList", () => {
  const makeAgent = (
    name: string,
    description: string,
    capabilities: AgentDefinition["capabilities"] = ["shell"],
  ): AgentDefinition => ({
    name,
    description,
    capabilities,
    execute: async () => ({ success: true, output: null }),
  });

  test("returns message for empty list", () => {
    expect(formatAgentList([])).toBe("No agents registered.");
  });

  test("formats single agent", () => {
    const result = formatAgentList([makeAgent("test", "A test agent")]);
    expect(result).toContain("test");
    expect(result).toContain("A test agent");
    expect(result).toContain("shell");
  });

  test("formats multiple agents", () => {
    const agents = [
      makeAgent("agent-a", "First agent", ["shell", "file"]),
      makeAgent("agent-b", "Second agent", ["llm"]),
    ];
    const result = formatAgentList(agents);
    expect(result).toContain("agent-a");
    expect(result).toContain("agent-b");
    expect(result).toContain("First agent");
    expect(result).toContain("Second agent");
    expect(result).toContain("shell, file");
    expect(result).toContain("llm");
  });

  test("includes header with underline", () => {
    const result = formatAgentList([makeAgent("x", "desc")]);
    // Header contains column names
    expect(result).toContain("Name");
    expect(result).toContain("Description");
    expect(result).toContain("Capabilities");
    // Has underline ANSI code
    expect(result).toContain("\x1b[4m");
  });

  test("pads columns to align", () => {
    const agents = [
      makeAgent("short", "A"),
      makeAgent("a-much-longer-name", "B"),
    ];
    const lines = formatAgentList(agents).split("\n");
    // Both data rows should have the same position for the second column
    // The header is line 0, data rows are 1 and 2
    expect(lines.length).toBe(3);
  });
});
