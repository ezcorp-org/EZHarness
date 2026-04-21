import { test, expect, describe } from "bun:test";
import { parseArgs } from "../cli";

describe("parseArgs - extended coverage", () => {
  test("run command with --project flag", () => {
    const parsed = parseArgs(["run", "my-agent", "--project", "my-project"]);
    expect(parsed.command).toBe("run");
    expect(parsed.agentName).toBe("my-agent");
    expect(parsed.project).toBe("my-project");
  });

  test("run command with both --input and --project", () => {
    const parsed = parseArgs([
      "run", "agent", "--input", '{"key":"val"}', "--project", "proj",
    ]);
    expect(parsed.command).toBe("run");
    expect(parsed.agentName).toBe("agent");
    expect(parsed.input).toEqual({ key: "val" });
    expect(parsed.project).toBe("proj");
  });

  test("run command with --project before --input", () => {
    const parsed = parseArgs([
      "run", "agent", "--project", "proj", "--input", '{"a":1}',
    ]);
    expect(parsed.command).toBe("run");
    expect(parsed.agentName).toBe("agent");
    expect(parsed.project).toBe("proj");
    expect(parsed.input).toEqual({ a: 1 });
  });

  test("run command without agent name sets agentName undefined", () => {
    const parsed = parseArgs(["run"]);
    expect(parsed.command).toBe("run");
    expect(parsed.agentName).toBeUndefined();
  });

  test("run command without --input leaves input undefined", () => {
    const parsed = parseArgs(["run", "agent"]);
    expect(parsed.input).toBeUndefined();
  });

  test("serve command without --port defaults to 3001", () => {
    const parsed = parseArgs(["serve"]);
    expect(parsed.port).toBe(3001);
  });

  test("multiple unknown commands all map to help", () => {
    for (const cmd of ["foo", "bar", "deploy", "start", ""]) {
      expect(parseArgs([cmd]).command).toBe("help");
    }
  });
});

describe("cli function - help and list", () => {
  test("cli help includes all commands", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const { cli } = await import("../cli");
    await cli(["help"]);

    console.log = origLog;
    const output = logs.join("\n");
    expect(output).toContain("ezcorp list");
    expect(output).toContain("ezcorp run");
    expect(output).toContain("ezcorp serve");
    expect(output).toContain("ezcorp help");
  });

  test("cli list loads agents and prints output", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const { cli } = await import("../cli");
    await cli(["list"]);

    console.log = origLog;
    // Should print something (either agents or "No agents registered.")
    expect(logs.length).toBeGreaterThan(0);
  });
});
