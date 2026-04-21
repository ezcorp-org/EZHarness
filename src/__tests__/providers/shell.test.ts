import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { createShellProvider } from "../../providers/shell";

const shell = createShellProvider();

test("echo hello returns stdout", async () => {
  const result = await shell.run("echo hello");
  expect(result.stdout).toBe("hello\n");
  expect(result.exitCode).toBe(0);
});

test("invalid command returns non-zero exit code", async () => {
  const result = await shell.run("false");
  expect(result.exitCode).not.toBe(0);
});

test("cwd option works", async () => {
  const dir = tmpdir();
  const result = await shell.run("pwd", { cwd: dir });
  // tmpdir may be a symlink, so just check it resolves to same real path
  const expected = await Bun.$`realpath ${dir}`.text();
  const actual = result.stdout.trim();
  const actualResolved = await Bun.$`realpath ${actual}`.text();
  expect(actualResolved.trim()).toBe(expected.trim());
});

describe("timeout option", () => {
  test("kills command that exceeds timeout", async () => {
    const result = await shell.run("sleep 10", { timeout: 100 });
    // Process should be killed, resulting in non-zero exit code
    expect(result.exitCode).not.toBe(0);
  }, { timeout: 15_000 });

  test("allows command that completes within timeout", async () => {
    const result = await shell.run("echo fast", { timeout: 5000 });
    expect(result.stdout).toBe("fast\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("stderr capture", () => {
  test("captures stderr separately from stdout", async () => {
    const result = await shell.run("echo out && echo err >&2");
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.exitCode).toBe(0);
  });

  test("non-zero exit code with stderr message", async () => {
    const result = await shell.run("echo 'fail message' >&2 && exit 42");
    expect(result.exitCode).toBe(42);
    expect(result.stderr).toContain("fail message");
  });
});

describe("large output", () => {
  test("handles large stdout", async () => {
    // Generate ~10KB of output
    const result = await shell.run("seq 1 2000");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBe(2000);
    expect(lines[0]).toBe("1");
    expect(lines[1999]).toBe("2000");
  });
});
