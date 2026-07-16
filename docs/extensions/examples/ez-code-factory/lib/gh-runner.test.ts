import { test, expect, describe } from "bun:test";
import type { ShellResult, ShellRunner } from "./shell";
import {
  GH_TOKEN_STORAGE_KEY,
  GH_TOKEN_ENV_VARS,
  resolveGhToken,
  makeGhRunner,
  type TokenStorage,
} from "./gh-runner";

const store = (value: string | null): TokenStorage => ({
  async get() {
    return { value: value as never, exists: value !== null };
  },
});

describe("resolveGhToken", () => {
  test("GH_TOKEN env override wins", async () => {
    expect(await resolveGhToken({ GH_TOKEN: "  envtok " }, store("stored"))).toBe("envtok");
  });
  test("GITHUB_TOKEN env override honored", async () => {
    expect(await resolveGhToken({ GITHUB_TOKEN: "ght" }, store(null))).toBe("ght");
  });
  test("falls back to the stored secret", async () => {
    expect(await resolveGhToken({}, store("  secret "))).toBe("secret");
  });
  test("blank env is skipped; blank stored → null", async () => {
    expect(await resolveGhToken({ GH_TOKEN: "   " }, store("   "))).toBeNull();
  });
  test("no token anywhere → null", async () => {
    expect(await resolveGhToken({}, store(null))).toBeNull();
  });
  test("exports the storage key + env var names", () => {
    expect(GH_TOKEN_STORAGE_KEY).toBe("github-token");
    expect(GH_TOKEN_ENV_VARS).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
  });
});

describe("makeGhRunner", () => {
  const ok: ShellResult = { exitCode: 0, stdout: "out", stderr: "" };

  test("prefixes gh, runs in the worktree, injects GH_TOKEN", async () => {
    const calls: Array<{ cmd: string[]; cwd: string; opts?: unknown }> = [];
    const runner: ShellRunner = async (cmd, cwd, opts) => {
      calls.push({ cmd, cwd, opts });
      return ok;
    };
    const gh = makeGhRunner(runner, "/wt", async () => "tok");
    expect(await gh(["pr", "list"])).toBe(ok);
    expect(calls[0]!.cmd).toEqual(["gh", "pr", "list"]);
    expect(calls[0]!.cwd).toBe("/wt");
    expect(calls[0]!.opts).toEqual({ env: { GH_TOKEN: "tok" } });
  });

  test("no token → no env injected; stdin forwarded", async () => {
    let seen: unknown;
    const runner: ShellRunner = async (_cmd, _cwd, opts) => {
      seen = opts;
      return ok;
    };
    const gh = makeGhRunner(runner, "/wt", async () => null);
    await gh(["pr", "create", "--body-file", "-"], { stdin: "body" });
    expect(seen).toEqual({ stdin: "body" });
  });
});
