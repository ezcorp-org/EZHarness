// ── Lint step — unit tests (lint.go port) ───────────────────────────

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionHostRunner } from "../shell";
import { makeGit } from "../git";
import { defaultPipelineConfig } from "../config";
import { emptyRepoConfig, type RepoConfig } from "../repo-config";
import { deserializeFindings, serializeFindings } from "../runs";
import { FINDINGS_SCHEMA } from "../prompts";
import type { AgentDispatcher, DispatchOptions, DispatchResult } from "../agent";
import { makeRunShared, type HousekeepingLintResult, type RunShared, type StepContext } from "./common";
import { lintStep, lintOutcomeFromHousekeeping } from "./lint";

const sh = (args: string[], cwd: string) => productionHostRunner(args, cwd);

async function initRepo(dir: string): Promise<void> {
  await sh(["git", "init", "-b", "main", dir], dir);
  await sh(["git", "config", "user.email", "t@t.com"], dir);
  await sh(["git", "config", "user.name", "t"], dir);
  await sh(["git", "config", "commit.gpgsign", "false"], dir);
}

async function commit(dir: string, file: string, content: string, message: string): Promise<string> {
  writeFileSync(join(dir, file), content);
  await sh(["git", "add", "-A"], dir);
  await sh(["git", "commit", "-m", message], dir);
  return (await sh(["git", "rev-parse", "HEAD"], dir)).stdout.trim();
}

function fakeDispatcher(impl: (o: DispatchOptions) => DispatchResult): AgentDispatcher & { calls: DispatchOptions[] } {
  const calls: DispatchOptions[] = [];
  return {
    calls,
    async dispatch(o) {
      calls.push(o);
      return impl(o);
    },
  };
}

interface Over {
  run?: Partial<StepContext["run"]>;
  repoConfig?: RepoConfig;
  fixing?: boolean;
  previousFindings?: string;
  dispatcher?: AgentDispatcher;
  shared?: RunShared;
}

describe("lintStep", () => {
  let dir: string;
  let head: string;
  let base: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ezcf-lint-"));
    await initRepo(dir);
    base = await commit(dir, "a.txt", "one\n", "base");
    head = await commit(dir, "b.txt", "two\n", "change");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeCtx(over: Over = {}): { ctx: StepContext; logs: string[] } {
    const logs: string[] = [];
    const ctx: StepContext = {
      worktree: dir,
      gateDir: dir,
      tmpBase: join(dir, ".tmp"),
      run: {
        id: "run_1",
        branch: "feature",
        ref: "refs/heads/feature",
        headSha: head,
        baseSha: base,
        intent: null,
        intentSource: null,
        prUrl: null,
        ...over.run,
      },
      repo: { defaultBranch: "main", workingPath: "" },
      config: defaultPipelineConfig(),
      repoConfig: over.repoConfig ?? emptyRepoConfig(),
      shared: over.shared ?? makeRunShared(),
      fixing: over.fixing ?? false,
      previousFindings: over.previousFindings ?? "",
      rounds: [],
      dispatcher: over.dispatcher ?? fakeDispatcher(() => ({ output: { findings: [], summary: "clean" }, text: "" })),
      hostGit: makeGit(productionHostRunner, dir),
      jailedGit: makeGit(productionHostRunner, dir),
      hostRunner: productionHostRunner,
      gh: async () => ({ exitCode: 127, stdout: "", stderr: "" }),
      now: () => 0,
      sleep: async () => {},
      log: (m) => logs.push(m),
      updateHeadSha: async () => {},
      updatePrUrl: async () => {},
      loadStepHistory: async () => [],
    };
    return { ctx, logs };
  }

  test("configured lint command passes → clean outcome", async () => {
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "", lint: "true", format: "" } };
    const { ctx, logs } = makeCtx({ repoConfig });
    const outcome = await lintStep.execute(ctx);
    expect(outcome).toEqual({ fixSummary: "" });
    expect(logs.join()).toContain("lint passed");
  });

  test("configured lint command FAILS → blocking finding, needs approval", async () => {
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "", lint: "exit 2", format: "" } };
    const { ctx } = makeCtx({ repoConfig });
    const outcome = await lintStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(outcome.autoFixable).toBe(true);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.items[0]!.description).toContain("exit code 2");
  });

  test("no lint command + a stashed housekeeping result → consumes the stash (no agent)", async () => {
    const shared = makeRunShared();
    const stashFindings = serializeFindings(
      deserializeFindings({ findings: [{ id: "l1", severity: "warning", description: "lint", action: "auto-fix" }], summary: "s" }),
    );
    shared.setHousekeepingLint({ findingsJson: stashFindings, summary: "housekeeping lint" });
    const dispatcher = fakeDispatcher(() => ({ output: { findings: [], summary: "x" }, text: "" }));
    const { ctx, logs } = makeCtx({ shared, dispatcher });
    const outcome = await lintStep.execute(ctx);
    expect(dispatcher.calls.length).toBe(0); // stash consumed, no cold pass
    expect(outcome.needsApproval).toBe(true); // the stashed warning blocks
    expect(outcome.fixSummary).toBe("housekeeping lint");
    expect(logs.join()).toContain("combined document+lint housekeeping pass");
  });

  test("no lint command + no stash → cold agent lint pass", async () => {
    const dispatcher = fakeDispatcher(() => ({
      output: { findings: [{ severity: "error", description: "bad", action: "auto-fix" }], summary: "found" },
      text: "",
    }));
    const { ctx, logs } = makeCtx({ dispatcher });
    const outcome = await lintStep.execute(ctx);
    expect(dispatcher.calls[0]!.jsonSchema).toBe(FINDINGS_SCHEMA);
    expect(outcome.needsApproval).toBe(true);
    expect(logs.join()).toContain("no lint command configured");
  });

  test("cold pass falls back to the text response when structured output is missing", async () => {
    const dispatcher = fakeDispatcher(() => ({ output: null, text: "free text" }));
    const { ctx } = makeCtx({ dispatcher });
    const outcome = await lintStep.execute(ctx);
    expect(deserializeFindings(JSON.parse(outcome.findings!)).summary).toBe("free text");
  });

  test("fix mode + no lint command → cold pass runs (stash NOT consumed while fixing)", async () => {
    const shared = makeRunShared();
    shared.setHousekeepingLint({ findingsJson: "{}", summary: "stale" });
    const dispatcher = fakeDispatcher(() => ({ output: { findings: [], summary: "clean" }, text: "" }));
    const { ctx } = makeCtx({ shared, dispatcher, fixing: true });
    const outcome = await lintStep.execute(ctx);
    expect(dispatcher.calls.length).toBe(1); // cold pass, not the stash
    expect(outcome.needsApproval).toBe(false);
  });

  test("fix mode + configured command → runs the fix agent then the command", async () => {
    const dispatcher = fakeDispatcher(() => ({ output: { summary: "fixed lint" }, text: "" }));
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "", lint: "true", format: "" } };
    const previousFindings = JSON.stringify({
      findings: [{ id: "l1", severity: "warning", description: "prior", action: "auto-fix" }],
      summary: "p",
    });
    const { ctx } = makeCtx({ dispatcher, repoConfig, fixing: true, previousFindings });
    const outcome = await lintStep.execute(ctx);
    expect(dispatcher.calls.length).toBe(1);
    expect(dispatcher.calls[0]!.prompt).toContain("Previous lint findings to address:");
    expect(outcome.fixSummary).toBe("fixed lint");
  });

  test("cold pass threads previous findings into the prompt", async () => {
    let prompt = "";
    const dispatcher = fakeDispatcher((o) => {
      prompt = o.prompt;
      return { output: { findings: [], summary: "clean" }, text: "" };
    });
    const previousFindings = JSON.stringify({
      findings: [{ id: "l1", severity: "warning", description: "old lint", action: "auto-fix" }],
      summary: "p",
    });
    const { ctx } = makeCtx({ dispatcher, fixing: false, previousFindings });
    // With no stash and not fixing, the cold pass runs and includes prior findings.
    await lintStep.execute(ctx);
    expect(prompt).toContain("Previous lint findings to address:");
    expect(prompt).toContain("old lint");
  });

  test("agent selection reaches the cold-pass dispatch (trusted agent)", async () => {
    const dispatcher = fakeDispatcher(() => ({ output: { findings: [], summary: "clean" }, text: "" }));
    const repoConfig = { ...emptyRepoConfig(), agent: "trusted-linter" };
    const { ctx } = makeCtx({ dispatcher, repoConfig });
    await lintStep.execute(ctx);
    expect(dispatcher.calls[0]!.agentName).toBe("trusted-linter");
  });

  test("a cold-pass dispatch failure surfaces as a step error", async () => {
    const dispatcher = fakeDispatcher(() => {
      throw new Error("lint boom");
    });
    const { ctx } = makeCtx({ dispatcher });
    await expect(lintStep.execute(ctx)).rejects.toThrow(/agent lint: lint boom/);
  });
});

describe("lintOutcomeFromHousekeeping", () => {
  const baseCtx = { log: () => {} } as unknown as StepContext;

  test("valid stash → gate semantics from the stashed findings", () => {
    const stash: HousekeepingLintResult = {
      findingsJson: serializeFindings(
        deserializeFindings({ findings: [{ severity: "info", description: "note", action: "no-op" }], summary: "s" }),
      ),
      summary: "sum",
    };
    const outcome = lintOutcomeFromHousekeeping(baseCtx, stash);
    expect(outcome.needsApproval).toBe(false); // info only
    expect(outcome.findings).toBe(stash.findingsJson);
  });

  test("malformed stash → parks for a human (fail safe)", () => {
    const outcome = lintOutcomeFromHousekeeping(baseCtx, { findingsJson: "{not json", summary: "x" });
    expect(outcome.needsApproval).toBe(true);
    expect(deserializeFindings(JSON.parse(outcome.findings!)).items[0]!.action).toBe("ask-user");
  });
});
