import { test, expect, describe } from "bun:test";
import shellRunnerAgent from "../agents/shell-runner.agent";
import type { AgentContext, InputField } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────

function makeCtx(input: Record<string, unknown>, overrides: Partial<AgentContext> = {}): AgentContext {
  const logs: string[] = [];
  return {
    input,
    llm: {} as any,
    shell: {
      async run(command: string, _opts?: { cwd?: string }) {
        return { stdout: `ran: ${command}`, stderr: "", exitCode: 0 };
      },
    },
    file: {
      async read() { return ""; },
      async write() {},
      async exists() { return false; },
    },
    log(message: string) { logs.push(message); },
    signal: new AbortController().signal,
    async run() { return { success: true, output: null }; },
    ...overrides,
  };
}

// ── Agent Definition Structure ────────────────────────────────────────

describe("shell-runner agent definition", () => {
  test("has correct name", () => {
    expect(shellRunnerAgent.name).toBe("shell-runner");
  });

  test("has a description", () => {
    expect(typeof shellRunnerAgent.description).toBe("string");
    expect(shellRunnerAgent.description.length).toBeGreaterThan(0);
  });

  test("declares shell capability", () => {
    expect(shellRunnerAgent.capabilities).toContain("shell");
  });

  test("capabilities is an array", () => {
    expect(Array.isArray(shellRunnerAgent.capabilities)).toBe(true);
  });

  test("has an execute function", () => {
    expect(typeof shellRunnerAgent.execute).toBe("function");
  });

  test("has inputSchema defined", () => {
    expect(shellRunnerAgent.inputSchema).toBeDefined();
  });
});

// ── Input Schema ──────────────────────────────────────────────────────

describe("shell-runner inputSchema", () => {
  test("command field is required and type string", () => {
    const schema = shellRunnerAgent.inputSchema!;
    expect(schema.command).toBeDefined();
    expect(schema.command.type).toBe("string");
    expect(schema.command.required).toBe(true);
  });

  test("cwd field is optional and type file-path", () => {
    const schema = shellRunnerAgent.inputSchema!;
    expect(schema.cwd).toBeDefined();
    expect(schema.cwd.type).toBe("file-path");
    expect((schema.cwd as InputField).required).toBeUndefined();
  });

  test("command field has a label", () => {
    expect(shellRunnerAgent.inputSchema!.command.label).toBeTruthy();
  });

  test("cwd field has a label", () => {
    expect(shellRunnerAgent.inputSchema!.cwd.label).toBeTruthy();
  });
});

// ── Execute: validation ───────────────────────────────────────────────

describe("shell-runner execute — input validation", () => {
  test("returns error when command is missing", async () => {
    const ctx = makeCtx({});
    const result = await shellRunnerAgent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error).toMatch(/command/i);
  });

  test("returns error when command is empty string", async () => {
    const ctx = makeCtx({ command: "" });
    const result = await shellRunnerAgent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/command/i);
  });
});

// ── Execute: success path ─────────────────────────────────────────────

describe("shell-runner execute — success path", () => {
  test("runs command and returns success with stdout/stderr/exitCode", async () => {
    let capturedCommand: string | undefined;
    const ctx = makeCtx({ command: "echo hello" }, {
      shell: {
        async run(cmd) {
          capturedCommand = cmd;
          return { stdout: "hello\n", stderr: "", exitCode: 0 };
        },
      },
    });

    const result = await shellRunnerAgent.execute(ctx);

    expect(capturedCommand).toBe("echo hello");
    expect(result.success).toBe(true);
    expect((result.output as any).stdout).toBe("hello\n");
    expect((result.output as any).exitCode).toBe(0);
  });

  test("passes cwd option to shell.run when provided", async () => {
    let capturedOpts: { cwd?: string } | undefined;
    const ctx = makeCtx({ command: "ls", cwd: "/tmp" }, {
      shell: {
        async run(_cmd, opts) {
          capturedOpts = opts;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    });

    await shellRunnerAgent.execute(ctx);

    expect(capturedOpts?.cwd).toBe("/tmp");
  });

  test("does not pass cwd when not provided", async () => {
    let capturedOpts: { cwd?: string } | undefined;
    const ctx = makeCtx({ command: "pwd" }, {
      shell: {
        async run(_cmd, opts) {
          capturedOpts = opts;
          return { stdout: "/home\n", stderr: "", exitCode: 0 };
        },
      },
    });

    await shellRunnerAgent.execute(ctx);

    expect(capturedOpts?.cwd).toBeUndefined();
  });

  test("logs the command before running", async () => {
    const logged: string[] = [];
    const ctx = makeCtx({ command: "date" }, {
      log(msg: string) { logged.push(msg); },
      shell: { async run() { return { stdout: "", stderr: "", exitCode: 0 }; } },
    });

    await shellRunnerAgent.execute(ctx);

    expect(logged.some((m) => m.includes("date"))).toBe(true);
  });
});

// ── Execute: failure path ─────────────────────────────────────────────

describe("shell-runner execute — non-zero exit", () => {
  test("returns success=false when exitCode is non-zero", async () => {
    const ctx = makeCtx({ command: "false" }, {
      shell: {
        async run() {
          return { stdout: "", stderr: "error output", exitCode: 1 };
        },
      },
    });

    const result = await shellRunnerAgent.execute(ctx);

    expect(result.success).toBe(false);
    expect((result.output as any).exitCode).toBe(1);
    expect((result.output as any).stderr).toBe("error output");
  });

  test("returns success=true only when exitCode is 0", async () => {
    const ctx = makeCtx({ command: "true" }, {
      shell: {
        async run() {
          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      },
    });

    const result = await shellRunnerAgent.execute(ctx);

    expect(result.success).toBe(true);
  });
});
