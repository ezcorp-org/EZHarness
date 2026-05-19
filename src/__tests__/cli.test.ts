import { test, expect, describe, } from "bun:test";
import { parseArgs } from "../cli";

describe("parseArgs", () => {
  test("defaults to help with no args", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  test("parses list command", () => {
    expect(parseArgs(["list"]).command).toBe("list");
  });

  test("parses help command", () => {
    expect(parseArgs(["help"]).command).toBe("help");
  });

  test("parses run command with agent name", () => {
    const parsed = parseArgs(["run", "shell-runner"]);
    expect(parsed.command).toBe("run");
    expect(parsed.agentName).toBe("shell-runner");
  });

  test("parses run command with --input", () => {
    const parsed = parseArgs(["run", "shell-runner", "--input", '{"command":"echo hi"}']);
    expect(parsed.command).toBe("run");
    expect(parsed.agentName).toBe("shell-runner");
    expect(parsed.input).toEqual({ command: "echo hi" });
  });

  test("parses serve command with default port", () => {
    const parsed = parseArgs(["serve"]);
    expect(parsed.command).toBe("serve");
    expect(parsed.port).toBe(3001);
  });

  test("parses serve command with custom port", () => {
    const parsed = parseArgs(["serve", "--port", "4000"]);
    expect(parsed.command).toBe("serve");
    expect(parsed.port).toBe(4000);
  });

  test("unknown command falls back to help", () => {
    expect(parseArgs(["unknown"]).command).toBe("help");
  });
});

describe("list command", () => {
  test("does not throw", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    // Import cli dynamically to avoid side effects
    const { cli } = await import("../cli");
    await cli(["list"]);

    console.log = originalLog;
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("help command", () => {
  test("prints usage text", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const { cli } = await import("../cli");
    await cli(["help"]);

    console.log = originalLog;
    const output = logs.join("\n");
    expect(output).toContain("Usage:");
    expect(output).toContain("ezcorp list");
    expect(output).toContain("ezcorp run");
    expect(output).toContain("ezcorp serve");
  });
});
