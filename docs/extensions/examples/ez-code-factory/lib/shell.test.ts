import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionHostRunner, shQuote } from "./shell";

describe("shQuote", () => {
  test("wraps a plain token in single quotes", () => {
    expect(shQuote("hello")).toBe("'hello'");
  });
  test("escapes embedded single quotes", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
  test("preserves spaces + newlines inside the quotes", () => {
    expect(shQuote("a b\nc")).toBe("'a b\nc'");
  });
});

describe("productionHostRunner", () => {
  test("captures stdout + exit code of a real command", async () => {
    const res = await productionHostRunner(["sh", "-c", "printf hi"], tmpdir());
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hi");
    expect(res.stderr).toBe("");
  });

  test("captures a non-zero exit code + stderr", async () => {
    const res = await productionHostRunner(["sh", "-c", "printf oops 1>&2; exit 3"], tmpdir());
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toBe("oops");
  });

  test("feeds stdin when provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ezcf-shell-"));
    try {
      const target = join(dir, "out.txt");
      const res = await productionHostRunner(
        ["sh", "-c", `cat > ${shQuote(target)}`],
        dir,
        { stdin: "streamed-content" },
      );
      expect(res.exitCode).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("streamed-content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs git hermetically (GIT_CONFIG_GLOBAL=/dev/null)", async () => {
    const res = await productionHostRunner(["git", "--version"], tmpdir());
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("git version");
  });

  test("merges extra env (the gh runner injects GH_TOKEN this way)", async () => {
    const res = await productionHostRunner(["sh", "-c", 'printf %s "$GH_TOKEN"'], tmpdir(), {
      env: { GH_TOKEN: "injected-token" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("injected-token");
  });

  test("a missing executable maps to exit 127 (skip-not-fail), never throws", async () => {
    // `gh` is not in the base image; Bun.spawn throws ENOENT synchronously for a
    // missing binary. The runner boundary must map that to a 127 ShellResult so
    // GitHubHost.available() skips pr/ci instead of failing the whole run.
    const res = await productionHostRunner(["ez-code-factory-no-such-binary-xyz"], tmpdir());
    expect(res.exitCode).toBe(127);
    expect(res.stderr).toContain("ez-code-factory-no-such-binary-xyz");
  });
});
