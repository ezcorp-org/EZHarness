import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createShellTool } from "../runtime/tools/shell";
import { mkdtemp, rm } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

function getText(result: any): string {
  return result.content[0].text;
}

let projectPath: string;

beforeAll(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "shell-test-"));
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("createShellTool", () => {
  test("executes a simple command and returns stdout", async () => {
    const tool = createShellTool(projectPath);
    const result = await tool.execute("1", { command: "echo hello" });
    expect(getText(result).trim()).toBe("hello");
    expect(result.details.exitCode).toBe(0);
  });

  test("reports a non-zero exit code in details", async () => {
    const tool = createShellTool(projectPath);
    const result = await tool.execute("1", { command: "false" });
    expect(result.details.exitCode).toBe(1);
  });

  test("blocks dangerous commands by pattern", async () => {
    const tool = createShellTool(projectPath);
    const result = await tool.execute("1", { command: "rm -rf /" });
    expect(getText(result)).toContain("blocked by security policy");
    expect(result.details.isError).toBe(true);
    expect(result.details.exitCode).toBe(-1);
  });

  test("sanitizes sensitive env vars from the child process", async () => {
    // Set a clearly-sensitive env var and a benign one; the shell command
    // echoes both. Sanitization should strip the sensitive one.
    process.env.SHELL_TEST_SECRET_KEY = "should_be_hidden";
    process.env.SHELL_TEST_PUBLIC_KEY = "visible_value";
    try {
      const tool = createShellTool(projectPath);
      const result = await tool.execute("1", {
        command:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template string
          'echo "secret=${SHELL_TEST_SECRET_KEY:-missing} public=${SHELL_TEST_PUBLIC_KEY:-missing}"',
      });
      const text = getText(result);
      expect(text).toContain("secret=missing");
      expect(text).toContain("public=visible_value");
    } finally {
      delete process.env.SHELL_TEST_SECRET_KEY;
      delete process.env.SHELL_TEST_PUBLIC_KEY;
    }
  });

  test("honours the timeout parameter and reports timeout in the message", async () => {
    const tool = createShellTool(projectPath);
    const start = Date.now();
    const result = await tool.execute("1", { command: "sleep 10", timeout: 1500 });
    const elapsed = Date.now() - start;
    // Must return well before the 10s sleep finishes.
    expect(elapsed).toBeLessThan(5000);
    expect(getText(result).toLowerCase()).toContain("timed out");
    expect(result.details.timeout).toBe(true);
  });

  test("runs commands in the configured project directory", async () => {
    const tool = createShellTool(projectPath);
    const result = await tool.execute("1", { command: "pwd" });
    expect(getText(result).trim()).toBe(projectPath);
  });

  // The catch arm: Bun.spawn itself throwing, rather than the command exiting
  // non-zero. A project directory that no longer exists (deleted or unmounted
  // between turns) is the realistic trigger — the tool must degrade to an
  // error result the model can read, not reject and kill the turn.
  test("a spawn failure is reported as an error result, not a rejection", async () => {
    const tool = createShellTool(resolve(tmpdir(), "shell-test-does-not-exist-" + Date.now()));
    const result = await tool.execute("1", { command: "echo hi" });
    expect(result.details.isError).toBe(true);
    expect(result.details.exitCode).toBe(-1);
    expect(getText(result)).toContain("Error:");
    // The message is echoed into BOTH places the UI reads.
    expect(result.details.stderr).toBe(getText(result).replace("Error: ", ""));
  });
});
