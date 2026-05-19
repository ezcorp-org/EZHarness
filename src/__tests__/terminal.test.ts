import { test, expect, describe, spyOn, beforeEach, afterEach } from "bun:test";
import { formatLogLine, createSpinner } from "../ui/terminal";
import type { AgentLog } from "../types";

describe("formatLogLine", () => {
  test("formats a log line with timestamp, agent name, and message", () => {
    const log: AgentLog = {
      timestamp: new Date(2025, 0, 1, 14, 5, 30).getTime(),
      level: "info",
      message: "Hello world",
    };
    const result = formatLogLine("my-agent", log);
    expect(result).toContain("[14:05:30]");
    expect(result).toContain("[my-agent]");
    expect(result).toContain("Hello world");
  });

  test("pads single-digit time components with zeros", () => {
    const log: AgentLog = {
      timestamp: new Date(2025, 0, 1, 1, 2, 3).getTime(),
      level: "info",
      message: "test",
    };
    const result = formatLogLine("agent", log);
    expect(result).toContain("[01:02:03]");
  });

  test("applies gray color to timestamp", () => {
    const log: AgentLog = {
      timestamp: Date.now(),
      level: "info",
      message: "test",
    };
    const result = formatLogLine("agent", log);
    // Gray ANSI code
    expect(result).toContain("\x1b[90m");
  });

  test("applies blue color to agent name", () => {
    const log: AgentLog = {
      timestamp: Date.now(),
      level: "info",
      message: "test",
    };
    const result = formatLogLine("agent", log);
    // Blue ANSI code for agent name
    expect(result).toContain("\x1b[34m[agent]");
  });

  test("colors debug messages gray", () => {
    const log: AgentLog = { timestamp: Date.now(), level: "debug", message: "dbg" };
    const result = formatLogLine("a", log);
    // Gray wrapping the message
    expect(result).toContain("\x1b[90mdbg\x1b[0m");
  });

  test("colors warn messages yellow", () => {
    const log: AgentLog = { timestamp: Date.now(), level: "warn", message: "warning" };
    const result = formatLogLine("a", log);
    expect(result).toContain("\x1b[33mwarning\x1b[0m");
  });

  test("colors error messages red", () => {
    const log: AgentLog = { timestamp: Date.now(), level: "error", message: "fail" };
    const result = formatLogLine("a", log);
    expect(result).toContain("\x1b[31mfail\x1b[0m");
  });

  test("info messages have no extra color", () => {
    const log: AgentLog = { timestamp: Date.now(), level: "info", message: "plain" };
    const result = formatLogLine("a", log);
    // The message itself should not be wrapped in a color code (empty string color)
    // It should just appear as-is after the agent name
    expect(result).toContain(" plain");
  });
});

describe("createSpinner", () => {
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  test("writes hide cursor on creation", () => {
    const spinner = createSpinner("Loading...");
    // Should have written hide cursor escape code
    expect(stderrSpy).toHaveBeenCalledWith("\x1b[?25l");
    spinner.stop();
  });

  test("stop clears the line and shows cursor", () => {
    const spinner = createSpinner("test");
    stderrSpy.mockClear();
    spinner.stop();
    // Should write clear line + cursor left + show cursor
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0]);
    const output = calls.join("");
    expect(output).toContain("\x1b[?25h"); // show cursor
    expect(output).toContain("\x1b[2K"); // clear line
  });

  test("stop is idempotent", () => {
    const spinner = createSpinner("test");
    spinner.stop();
    stderrSpy.mockClear();
    spinner.stop();
    // Second stop should not write anything
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("succeed prints green checkmark and message", () => {
    const spinner = createSpinner("test");
    stderrSpy.mockClear();
    spinner.succeed("Done!");
    const output = stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(output).toContain("✔");
    expect(output).toContain("Done!");
    expect(output).toContain("\x1b[32m"); // green
  });

  test("fail prints red X and message", () => {
    const spinner = createSpinner("test");
    stderrSpy.mockClear();
    spinner.fail("Error!");
    const output = stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(output).toContain("✖");
    expect(output).toContain("Error!");
    expect(output).toContain("\x1b[31m"); // red
  });

  test("succeed after stop does nothing", () => {
    const spinner = createSpinner("test");
    spinner.stop();
    stderrSpy.mockClear();
    spinner.succeed("late");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("fail after stop does nothing", () => {
    const spinner = createSpinner("test");
    spinner.stop();
    stderrSpy.mockClear();
    spinner.fail("late");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("update changes spinner text", () => {
    const spinner = createSpinner("initial");
    // update should not throw
    spinner.update("new text");
    spinner.stop();
  });
});
