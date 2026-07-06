import { test, expect, describe, spyOn } from "bun:test";
import { parseArgs } from "../cli";

type ServeSpawn = { cmd: string[]; env: Record<string, string | undefined> };

/**
 * Drive `cli(["serve", …])` with Bun.spawn stubbed, returning the argv + env
 * the serve case handed the spawned dev server. `isDev` is derived from
 * Bun.argv (never carries `--prod` under bun:test), so this always exercises
 * the dev branch. The serve case installs a SIGTERM + SIGINT handler; snapshot
 * and strip exactly those two so they don't leak across the suite.
 */
async function captureServeSpawn(args: string[]): Promise<ServeSpawn> {
  const { cli } = await import("../cli");
  let captured: ServeSpawn | undefined;
  const spawnStub = (cmd: string[], options: { env: Record<string, string | undefined> }) => {
    captured = { cmd, env: options.env };
    return { kill: () => {}, exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
  };
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(spawnStub as unknown as typeof Bun.spawn);
  const beforeTerm = process.listeners("SIGTERM");
  const beforeInt = process.listeners("SIGINT");
  try {
    await cli(args);
  } finally {
    for (const l of process.listeners("SIGTERM"))
      if (!beforeTerm.includes(l)) process.removeListener("SIGTERM", l);
    for (const l of process.listeners("SIGINT"))
      if (!beforeInt.includes(l)) process.removeListener("SIGINT", l);
    spawnSpy.mockRestore();
  }
  if (!captured) throw new Error("Bun.spawn was not called by the serve command");
  return captured;
}

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

describe("serve command (dev branch)", () => {
  test("exports the chosen --port into the spawned dev server env", async () => {
    const { cmd, env } = await captureServeSpawn(["serve", "--port", "4123"]);
    expect(cmd).toEqual(["bun", "run", "dev", "--port", "4123"]);
    // Exported so the dev server's mockLlmBaseUrl() targets the bound port.
    expect(env.PORT).toBe("4123");
  });

  test("defaults the exported PORT to 3001 when no --port is given", async () => {
    const { cmd, env } = await captureServeSpawn(["serve"]);
    expect(cmd).toEqual(["bun", "run", "dev", "--port", "3001"]);
    expect(env.PORT).toBe("3001");
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
