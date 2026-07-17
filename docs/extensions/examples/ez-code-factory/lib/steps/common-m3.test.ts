// ── Shared step machinery added in M3 — isolated unit tests ─────────
//
// RunShared (the document→lint stash), the configured-command runner, new-test-
// file detection, and the trusted agent/disable dispatch options. Kept in a
// SMALL isolated file so coverage attribution stays clean.

import { test, expect, describe } from "bun:test";
import { makeGit } from "../git";
import type { ShellRunner, ShellResult } from "../shell";
import { emptyRepoConfig } from "../repo-config";
import {
  makeRunShared,
  isTestFile,
  detectNewTestFiles,
  runStepShellCommand,
  repoDispatchOptions,
  type StepContext,
} from "./common";

describe("RunShared", () => {
  test("set → take returns once, then null; clear discards", () => {
    const shared = makeRunShared();
    expect(shared.takeHousekeepingLint()).toBeNull();
    shared.setHousekeepingLint({ findingsJson: "{}", summary: "s" });
    expect(shared.takeHousekeepingLint()).toEqual({ findingsJson: "{}", summary: "s" });
    expect(shared.takeHousekeepingLint()).toBeNull(); // consumed
    shared.setHousekeepingLint({ findingsJson: "{}", summary: "again" });
    shared.clearHousekeepingLint();
    expect(shared.takeHousekeepingLint()).toBeNull();
  });

  test("a later set replaces the previous stash", () => {
    const shared = makeRunShared();
    shared.setHousekeepingLint({ findingsJson: "a", summary: "1" });
    shared.setHousekeepingLint({ findingsJson: "b", summary: "2" });
    expect(shared.takeHousekeepingLint()!.findingsJson).toBe("b");
  });
});

describe("isTestFile", () => {
  test("matches common per-language test patterns", () => {
    for (const p of [
      "pkg/foo_test.go",
      "src/bar_test.rs",
      "test_thing.py",
      "thing_test.py",
      "test_helper.rb",
      "FooTest.java",
      "FooTests.java",
      "a.test.ts",
      "a.spec.tsx",
      "b.test.js",
      "c.spec.jsx",
    ]) {
      expect(isTestFile(p)).toBe(true);
    }
  });

  test("rejects non-test files + an empty basename", () => {
    for (const p of ["src/foo.go", "bar.py", "helper.rb", "Foo.java", "index.ts", "dir/"]) {
      expect(isTestFile(p)).toBe(false);
    }
  });
});

describe("detectNewTestFiles", () => {
  function gitWithStatus(porcelain: string) {
    const runner: ShellRunner = async (args): Promise<ShellResult> => {
      if (args.includes("status")) return { exitCode: 0, stdout: porcelain, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return makeGit(runner, "/wt");
  }

  test("collects untracked (??) and staged-add (A) test files, ignoring the rest", async () => {
    const porcelain = ["?? new.test.ts", "A  staged_test.go", " M src/app.ts", "?? notes.md", "xy"].join("\n");
    const files = await detectNewTestFiles(gitWithStatus(porcelain));
    expect(files).toEqual(["new.test.ts", "staged_test.go"]);
  });

  test("empty status → no files", async () => {
    expect(await detectNewTestFiles(gitWithStatus("  "))).toEqual([]);
  });
});

describe("runStepShellCommand", () => {
  test("returns combined output + exit code", async () => {
    const ok = await runStepShellCommand((await import("../shell")).productionHostRunner, "/tmp", "echo hi");
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain("hi");
    const bad = await runStepShellCommand((await import("../shell")).productionHostRunner, "/tmp", "exit 5");
    expect(bad.exitCode).toBe(5);
  });
});

describe("repoDispatchOptions", () => {
  test("passes trusted agent + disable_project_settings, omits empties", () => {
    const withBoth = repoDispatchOptions({
      repoConfig: { ...emptyRepoConfig(), agent: "a", disableProjectSettings: true },
    } as StepContext);
    expect(withBoth).toEqual({ agentName: "a", disableProjectSettings: true });
    const withNone = repoDispatchOptions({ repoConfig: emptyRepoConfig() } as StepContext);
    expect(withNone).toEqual({});
  });
});
