// ── Test step — unit tests (test.go port) ───────────────────────────

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionHostRunner, type ShellRunner } from "../shell";
import { makeGit } from "../git";
import { defaultPipelineConfig } from "../config";
import { emptyRepoConfig, type RepoConfig } from "../repo-config";
import { deserializeFindings, serializeFindings } from "../runs";
import type { AgentDispatcher, DispatchOptions, DispatchResult } from "../agent";
import { makeRunShared, type RunShared, type StepContext } from "./common";
import { testStep } from "./test";

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

interface Over {
  run?: Partial<StepContext["run"]>;
  repoConfig?: RepoConfig;
  fixing?: boolean;
  previousFindings?: string;
  dispatcher?: AgentDispatcher;
  shared?: RunShared;
  tmpBase?: string;
  jobFixInstructions?: string;
}

function fakeDispatcher(impl: (o: DispatchOptions) => DispatchResult | Promise<DispatchResult>): AgentDispatcher & {
  calls: DispatchOptions[];
} {
  const calls: DispatchOptions[] = [];
  return {
    calls,
    async dispatch(o) {
      calls.push(o);
      return impl(o);
    },
  };
}

const cleanEvidence: DispatchResult = {
  output: { findings: [], summary: "ok", tested: [], testing_summary: "checked", artifacts: [] },
  text: "",
};

describe("testStep", () => {
  let dir: string;
  let head: string;
  let base: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ezcf-test-"));
    await initRepo(dir);
    base = await commit(dir, "a.txt", "one\n", "base");
    head = await commit(dir, "b.txt", "two\n", "change");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeCtx(over: Over = {}): { ctx: StepContext; logs: string[] } {
    const logs: string[] = [];
    const hostRunner: ShellRunner = productionHostRunner;
    const ctx: StepContext = {
      worktree: dir,
      gateDir: dir,
      tmpBase: over.tmpBase ?? join(dir, ".tmp"),
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
      ...(over.jobFixInstructions ? { jobFixInstructions: over.jobFixInstructions } : {}),
      shared: over.shared ?? makeRunShared(),
      fixing: over.fixing ?? false,
      previousFindings: over.previousFindings ?? "",
      rounds: [],
      dispatcher: over.dispatcher ?? fakeDispatcher(() => cleanEvidence),
      hostGit: makeGit(hostRunner, dir),
      jailedGit: makeGit(hostRunner, dir),
      hostRunner,
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

  test("no test command + no intent → evidence agent runs, clean pass", async () => {
    const dispatcher = fakeDispatcher(() => cleanEvidence);
    const { ctx, logs } = makeCtx({ dispatcher });
    const outcome = await testStep.execute(ctx);
    expect(dispatcher.calls.length).toBe(1);
    expect(outcome.needsApproval).toBe(false);
    expect(logs.join()).toContain("no test command configured");
  });

  test("test-FIX carries the operator fix section; the evidence pass gets nothing", async () => {
    // Fix mode with a passing test command → the fixer prompt is dispatched and
    // carries the operator fix instructions; no evidence agent runs (no intent).
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "true", lint: "", format: "" } };
    const prev = serializeFindings(
      deserializeFindings({ findings: [{ id: "t1", severity: "error", description: "flaky", action: "auto-fix" }], summary: "s" }),
    );
    const dispatcher = fakeDispatcher(() => ({ output: { summary: "fixed test" }, text: "" }));
    const { ctx } = makeCtx({
      repoConfig,
      fixing: true,
      previousFindings: prev,
      dispatcher,
      jobFixInstructions: "run the smallest failing test first",
    });
    await testStep.execute(ctx);
    const fixCall = dispatcher.calls.find((c) => c.role === "fixer")!;
    expect(fixCall.prompt).toContain("Job instructions (operator-configured, advisory)");
    expect(fixCall.prompt).toContain("run the smallest failing test first");
  });

  test("the test-EVIDENCE pass gets NO operator section even when fix instructions are set", async () => {
    // No test command, not fixing → the evidence agent; fix instructions reach
    // agents on FIX rounds only, so the evidence prompt carries no operator section.
    const dispatcher = fakeDispatcher(() => cleanEvidence);
    const { ctx } = makeCtx({ dispatcher, jobFixInstructions: "should not appear in evidence" });
    await testStep.execute(ctx);
    expect(dispatcher.calls[0]!.prompt).not.toContain("Job instructions (operator-configured, advisory)");
    expect(dispatcher.calls[0]!.prompt).not.toContain("should not appear in evidence");
  });

  test("configured test command passes + no intent → no evidence agent, all tests passed", async () => {
    const dispatcher = fakeDispatcher(() => cleanEvidence);
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "true", lint: "", format: "" } };
    const { ctx, logs } = makeCtx({ dispatcher, repoConfig });
    const outcome = await testStep.execute(ctx);
    expect(dispatcher.calls.length).toBe(0); // no evidence agent
    expect(outcome.needsApproval).toBeUndefined();
    expect(logs.join()).toContain("all tests passed");
    expect(deserializeFindings(JSON.parse(outcome.findings!)).tested).toEqual(["true"]);
  });

  test("configured test command FAILS → blocking finding, needs approval", async () => {
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "exit 3", lint: "", format: "" } };
    const { ctx } = makeCtx({ repoConfig });
    const outcome = await testStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(outcome.autoFixable).toBe(true);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.items[0]!.description).toContain("exit code 3");
    expect(f.tested).toEqual(["exit 3"]);
  });

  test("test command passes + intent present → evidence agent runs, tested prepended", async () => {
    const dispatcher = fakeDispatcher(() => ({
      output: { findings: [], summary: "ok", tested: ["manual check"], testing_summary: "", artifacts: [] },
      text: "",
    }));
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "true", lint: "", format: "" } };
    const { ctx } = makeCtx({ dispatcher, repoConfig, run: { intent: "add a flag", intentSource: "agent" } });
    const outcome = await testStep.execute(ctx);
    expect(dispatcher.calls.length).toBe(1);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.tested).toEqual(["true", "manual check"]);
  });

  test("evidence agent returns a blocking finding → needs approval + auto-fixable", async () => {
    const dispatcher = fakeDispatcher(() => ({
      output: {
        findings: [{ severity: "error", description: "missing evidence", action: "auto-fix" }],
        summary: "x",
        tested: [],
        testing_summary: "",
        artifacts: [],
      },
      text: "",
    }));
    const { ctx } = makeCtx({ dispatcher });
    const outcome = await testStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(outcome.autoFixable).toBe(true);
  });

  test("agent writes a NEW test file during the evidence pass → always requires approval (info)", async () => {
    const dispatcher = fakeDispatcher(() => {
      // The "agent" writes an untracked test file into the worktree.
      writeFileSync(join(dir, "new.test.ts"), "test('x',()=>{})\n");
      return cleanEvidence;
    });
    const { ctx } = makeCtx({ dispatcher });
    const outcome = await testStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(outcome.autoFixable).toBe(false);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.items.some((it) => it.description.includes("new test file"))).toBe(true);
  });

  test("evidence falls back from an unparseable structured output to the text response", async () => {
    const dispatcher = fakeDispatcher(() => ({ output: null, text: "free-form summary" }));
    const { ctx } = makeCtx({ dispatcher });
    const outcome = await testStep.execute(ctx);
    expect(deserializeFindings(JSON.parse(outcome.findings!)).summary).toBe("free-form summary");
  });

  test("fix mode: agent fixes, command passes, agent wrote a new test → surfaced for approval", async () => {
    const dispatcher = fakeDispatcher((o) => {
      // The fix turn writes a new test file (still untracked at afterAgentRun).
      if (o.role === "fixer") {
        writeFileSync(join(dir, "extra.test.ts"), "test('y',()=>{})\n");
        return { output: { summary: "fixed it" }, text: "" };
      }
      return cleanEvidence;
    });
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "true", lint: "", format: "" } };
    const { ctx } = makeCtx({ dispatcher, repoConfig, fixing: true });
    const outcome = await testStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.summary).toContain("agent wrote new test files");
    expect(outcome.fixSummary).toBe("fixed it");
  });

  test("evidence dir that git ignores → falls back to the temp location + still runs", async () => {
    // .gitignore the in-repo evidence dir so check-ignore matches → temp fallback.
    await commit(dir, ".gitignore", "evi/\n", "ignore evidence");
    head = (await sh(["git", "rev-parse", "HEAD"], dir)).stdout.trim();
    const dispatcher = fakeDispatcher(() => cleanEvidence);
    const repoConfig: RepoConfig = {
      ...emptyRepoConfig(),
      evidence: { storeInRepo: true, dir: "evi" },
    };
    const { ctx } = makeCtx({ dispatcher, repoConfig, run: { headSha: head } });
    const outcome = await testStep.execute(ctx);
    expect(dispatcher.calls.length).toBe(1);
    expect(outcome.needsApproval).toBe(false);
  });

  test("agent selection + disable_project_settings from trusted config reach the dispatch", async () => {
    const dispatcher = fakeDispatcher(() => cleanEvidence);
    const repoConfig: RepoConfig = { ...emptyRepoConfig(), agent: "trusted-agent", disableProjectSettings: true };
    const { ctx } = makeCtx({ dispatcher, repoConfig });
    await testStep.execute(ctx);
    expect(dispatcher.calls[0]!.agentName).toBe("trusted-agent");
    expect(dispatcher.calls[0]!.disableProjectSettings).toBe(true);
  });

  test("fix mode threads previous findings into the fix prompt", async () => {
    let seenPrompt = "";
    const dispatcher = fakeDispatcher((o) => {
      if (o.role === "fixer") {
        seenPrompt = o.prompt;
        return { output: { summary: "fixed" }, text: "" };
      }
      return cleanEvidence;
    });
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "true", lint: "", format: "" } };
    const previousFindings = JSON.stringify({
      findings: [{ id: "test-1", severity: "error", description: "boom", action: "auto-fix" }],
      summary: "prior",
    });
    const { ctx } = makeCtx({ dispatcher, repoConfig, fixing: true, previousFindings });
    await testStep.execute(ctx);
    expect(seenPrompt).toContain("Previous test findings to address:");
    expect(seenPrompt).toContain("boom");
  });

  test("a dispatch failure surfaces as a step error", async () => {
    const dispatcher = fakeDispatcher(() => {
      throw new Error("provider down");
    });
    const { ctx } = makeCtx({ dispatcher });
    await expect(testStep.execute(ctx)).rejects.toThrow(/agent run tests: provider down/);
  });
});
