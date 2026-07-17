import { test, expect, describe } from "bun:test";
import {
  startPipeline,
  respondToGate,
  reconcileGate,
  STEP_REGISTRY,
  type ExecutorDeps,
} from "./executor";
import { defaultPipelineConfig, PIPELINE_STEPS, type PipelineStep } from "./config";
import {
  serializeFindings,
  deserializeFindings,
  emptyFindings,
  type RunRecord,
  type RunStore,
  type StepResultRecord,
  type StepRoundRecord,
} from "./runs";
import type { AgentDispatcher } from "./agent";
import type { Step, StepContext, StepOutcome } from "./steps/common";
import { emptyRepoConfig, TrustedConfigError, type RepoConfig } from "./repo-config";

// ── in-memory store ─────────────────────────────────────────────────

function memStore(): RunStore & { rounds: Map<string, StepRoundRecord[]>; steps: Map<string, StepResultRecord> } {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, StepResultRecord>();
  const rounds = new Map<string, StepRoundRecord[]>();
  const key = (r: string, s: string) => `${r}/${s}`;
  return {
    steps,
    rounds,
    async createRun(run) {
      runs.set(run.id, run);
    },
    async getRun(id) {
      return runs.get(id) ? { ...runs.get(id)! } : null;
    },
    async updateRun(id, patch) {
      const cur = runs.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: "t" };
      runs.set(id, next);
      return next;
    },
    async listRuns() {
      return [...runs.values()];
    },
    async putStepResult(s) {
      steps.set(key(s.runId, s.step), { ...s });
    },
    async getStepResult(runId, step) {
      const s = steps.get(key(runId, step));
      return s ? { ...s } : null;
    },
    async appendStepRound(round) {
      const list = rounds.get(key(round.runId, round.step)) ?? [];
      list.push(round);
      rounds.set(key(round.runId, round.step), list);
    },
    async getStepRounds(runId, step) {
      return rounds.get(key(runId, step)) ?? [];
    },
    async patchLastStepRound(runId, step, patch) {
      const list = rounds.get(key(runId, step));
      if (!list || list.length === 0) return;
      list[list.length - 1] = { ...list[list.length - 1]!, ...patch };
    },
  };
}

async function seedRun(store: RunStore, over: Partial<RunRecord> = {}): Promise<string> {
  const id = "run1";
  await store.createRun({
    id,
    repoId: "0123456789ab",
    branch: "feat/x",
    ref: "refs/heads/feat/x",
    headSha: "abc",
    baseSha: "0".repeat(40),
    status: "created",
    worktreePath: "/wt",
    createdAt: "t",
    updatedAt: "t",
    parkedMs: 0,
    awaitingAgentSince: null,
    intent: null,
    intentSource: null,
    ...over,
  });
  return id;
}

/** A step whose execute returns scripted outcomes (last repeats). */
function scriptStep(name: PipelineStep, outcomes: StepOutcome[]): Step & { calls: StepContext["fixing"][] } {
  let i = 0;
  const calls: boolean[] = [];
  return {
    name,
    calls,
    async execute(sctx: StepContext) {
      calls.push(sctx.fixing);
      const o = outcomes[Math.min(i, outcomes.length - 1)]!;
      i += 1;
      return o;
    },
  };
}

const noopDispatcher: AgentDispatcher = { async dispatch() { return { output: null, text: "" }; } };

/** Build a full registry: implemented fakes + null for the rest. */
function registry(impl: Partial<Record<PipelineStep, Step>>): Record<PipelineStep, Step | null> {
  const reg = {} as Record<PipelineStep, Step | null>;
  for (const s of PIPELINE_STEPS) reg[s] = impl[s] ?? null;
  return reg;
}

function makeDeps(
  store: RunStore,
  steps: Record<PipelineStep, Step | null>,
  clock: { t: number },
): ExecutorDeps {
  return {
    store,
    worktree: "/wt",
    gateDir: "/gate.git",
    workingPath: "/proj",
    config: defaultPipelineConfig(),
    dispatcher: noopDispatcher,
    hostRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    jailedRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    now: () => clock.t,
    steps,
  };
}

const clean: StepOutcome = {};
function blocking(action: "auto-fix" | "ask-user" = "ask-user"): StepOutcome {
  return {
    needsApproval: true,
    autoFixable: action === "auto-fix",
    findings: serializeFindings(
      deserializeFindings({ findings: [{ id: "f1", severity: "error", description: "bug", action }] }),
    ),
  };
}

// ── happy path ──────────────────────────────────────────────────────

describe("startPipeline — clean run", () => {
  test("runs implemented steps, auto-skips the rest, completes", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const intent = scriptStep("intent", [clean]);
    const rebase = scriptStep("rebase", [clean]);
    const review = scriptStep("review", [clean]);
    const push = scriptStep("push", [clean]);
    const deps = makeDeps(store, registry({ intent, rebase, review, push }), { t: 0 });
    const outcome = await startPipeline(id, deps);
    expect(outcome.status).toBe("completed");
    // The four implemented steps completed; the rest are skipped.
    for (const s of ["intent", "rebase", "review", "push"] as PipelineStep[]) {
      expect((await store.getStepResult(id, s))!.status).toBe("completed");
    }
    for (const s of ["test", "document", "lint", "pr", "ci"] as PipelineStep[]) {
      expect((await store.getStepResult(id, s))!.status).toBe("skipped");
    }
    expect((await store.getRun(id))!.status).toBe("completed");
  });

  test("run not found → failed", async () => {
    const store = memStore();
    const deps = makeDeps(store, registry({}), { t: 0 });
    expect((await startPipeline("nope", deps)).status).toBe("failed");
  });

  test("a step that advances HEAD persists it via updateHeadSha", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const rebase: Step = {
      name: "rebase",
      async execute(sctx) {
        await sctx.updateHeadSha("newhead123");
        return {};
      },
    };
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), rebase }), { t: 0 });
    await startPipeline(id, deps);
    expect((await store.getRun(id))!.headSha).toBe("newhead123");
  });
});

// ── auto-fix loop + caps ────────────────────────────────────────────

describe("auto-fix loop honors the per-step cap", () => {
  test("rebase (cap 3) auto-fixes up to the cap, then parks", async () => {
    const store = memStore();
    const id = await seedRun(store);
    // Always returns an auto-fixable blocking finding.
    const rebase = scriptStep("rebase", [blocking("auto-fix")]);
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), rebase }), { t: 0 });
    const outcome = await startPipeline(id, deps);
    expect(outcome.status).toBe("parked");
    expect(outcome.parkedStep).toBe("rebase");
    const sr = (await store.getStepResult(id, "rebase"))!;
    expect(sr.autoFixAttempts).toBe(3); // cap
    expect(sr.status).toBe("fix_review"); // parked after a fix round
    // 1 initial + 3 auto-fix rounds = 4 executes.
    expect(rebase.calls.length).toBe(4);
    expect(rebase.calls).toEqual([false, true, true, true]);
  });

  test("review (cap 0) parks immediately with no auto-fix", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const review = scriptStep("review", [blocking("auto-fix")]);
    const deps = makeDeps(
      store,
      registry({ intent: scriptStep("intent", [clean]), rebase: scriptStep("rebase", [clean]), review }),
      { t: 0 },
    );
    const outcome = await startPipeline(id, deps);
    expect(outcome.status).toBe("parked");
    expect(outcome.parkedStep).toBe("review");
    const sr = (await store.getStepResult(id, "review"))!;
    expect(sr.autoFixAttempts).toBe(0);
    expect(sr.status).toBe("awaiting_approval");
    expect(review.calls.length).toBe(1);
  });

  test("fail-closed: an ask-user finding parks even when needsApproval is false", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const review = scriptStep("review", [
      {
        needsApproval: false,
        autoFixable: false,
        findings: serializeFindings(
          deserializeFindings({ findings: [{ id: "f1", severity: "info", description: "x", action: "ask-user" }] }),
        ),
      },
    ]);
    const deps = makeDeps(
      store,
      registry({ intent: scriptStep("intent", [clean]), rebase: scriptStep("rebase", [clean]), review }),
      { t: 0 },
    );
    expect((await startPipeline(id, deps)).status).toBe("parked");
    expect((await store.getStepResult(id, "review"))!.status).toBe("awaiting_approval");
  });

  test("autoFixable=true but only ask-user findings → NO auto-fix round (guard on autoFixableFindingsJSON)", async () => {
    const store = memStore();
    const id = await seedRun(store);
    // rebase cap is 3 and the outcome FLAGS autoFixable, yet the findings carry
    // ZERO auto-fix actions (all ask-user) → the executor must not run a fix
    // round; it parks. Kills the guard mutation that drops the
    // `autoFixableFindingsJSON(findings) !== ""` term from willAutoFix.
    const rebase = scriptStep("rebase", [
      {
        needsApproval: true,
        autoFixable: true,
        findings: serializeFindings(
          deserializeFindings({
            findings: [{ id: "f1", severity: "warning", description: "conflict", action: "ask-user" }],
          }),
        ),
      },
    ]);
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), rebase }), { t: 0 });
    const outcome = await startPipeline(id, deps);
    expect(outcome.status).toBe("parked");
    expect(outcome.parkedStep).toBe("rebase");
    const sr = (await store.getStepResult(id, "rebase"))!;
    expect(sr.autoFixAttempts).toBe(0);
    expect(sr.status).toBe("awaiting_approval");
    expect(rebase.calls.length).toBe(1); // no auto-fix round ran
  });

  test("executionMs accumulates execution-only ms across rounds", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const clock = { t: 0 };
    const calls: boolean[] = [];
    // Each execute advances the injected clock by 10ms of execution time.
    const rebase: Step = {
      name: "rebase",
      async execute(sctx) {
        calls.push(sctx.fixing);
        clock.t += 10;
        return blocking("auto-fix"); // auto-fixable → runs to the cap, then parks
      },
    };
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), rebase }), clock);
    await startPipeline(id, deps);
    const sr = (await store.getStepResult(id, "rebase"))!;
    // 1 initial + 3 auto-fix rounds = 4 executes × 10ms = 40ms accumulated.
    expect(calls.length).toBe(4);
    expect(sr.executionMs).toBe(40);
  });
});

// ── skipRemaining ───────────────────────────────────────────────────

describe("skipRemaining short-circuits the pipeline", () => {
  test("rebase empty-diff skips review + push and completes", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const rebase = scriptStep("rebase", [{ skipRemaining: true }]);
    const review = scriptStep("review", [clean]);
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), rebase, review }), { t: 0 });
    expect((await startPipeline(id, deps)).status).toBe("completed");
    expect((await store.getStepResult(id, "rebase"))!.status).toBe("completed");
    expect((await store.getStepResult(id, "review"))!.status).toBe("skipped");
    expect((await store.getStepResult(id, "push"))!.status).toBe("skipped");
    expect(review.calls.length).toBe(0);
  });
});

// ── step skipped-by-outcome + throw ─────────────────────────────────

describe("intent skip + step failure", () => {
  test("intent {skipped} marks the step skipped, pipeline proceeds", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const deps = makeDeps(
      store,
      registry({
        intent: scriptStep("intent", [{ skipped: true }]),
        rebase: scriptStep("rebase", [clean]),
        review: scriptStep("review", [clean]),
        push: scriptStep("push", [clean]),
      }),
      { t: 0 },
    );
    expect((await startPipeline(id, deps)).status).toBe("completed");
    expect((await store.getStepResult(id, "intent"))!.status).toBe("skipped");
  });

  test("a step that throws fails the run + the step", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const rebase: Step = {
      name: "rebase",
      async execute() {
        throw new Error("git exploded");
      },
    };
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), rebase }), { t: 0 });
    const outcome = await startPipeline(id, deps);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("git exploded");
    expect((await store.getStepResult(id, "rebase"))!.status).toBe("failed");
    expect((await store.getRun(id))!.status).toBe("failed");
  });
});

// ── respond: approve / skip / abort ─────────────────────────────────

describe("respondToGate — approve / skip / abort", () => {
  async function parkAtReview() {
    const store = memStore();
    const id = await seedRun(store);
    const review = scriptStep("review", [blocking("ask-user"), clean]);
    const push = scriptStep("push", [clean]);
    const clock = { t: 1000 };
    const deps = makeDeps(
      store,
      registry({ intent: scriptStep("intent", [clean]), rebase: scriptStep("rebase", [clean]), review, push }),
      clock,
    );
    const parked = await startPipeline(id, deps);
    expect(parked.status).toBe("parked");
    return { store, id, deps, clock, review, push };
  }

  test("approve completes the step and finishes the pipeline", async () => {
    const { store, id, deps, push } = await parkAtReview();
    const outcome = await respondToGate(id, { step: "review", action: "approve" }, deps);
    expect(outcome.status).toBe("completed");
    expect((await store.getStepResult(id, "review"))!.status).toBe("completed");
    expect(push.calls.length).toBe(1);
  });

  test("skip marks the step skipped and continues", async () => {
    const { store, id, deps } = await parkAtReview();
    const outcome = await respondToGate(id, { step: "review", action: "skip" }, deps);
    expect(outcome.status).toBe("completed");
    expect((await store.getStepResult(id, "review"))!.status).toBe("skipped");
  });

  test("abort fails the run as aborted; the step is failed", async () => {
    const { store, id, deps } = await parkAtReview();
    const outcome = await respondToGate(id, { step: "review", action: "abort" }, deps);
    expect(outcome.status).toBe("aborted");
    expect((await store.getRun(id))!.status).toBe("aborted");
    expect((await store.getStepResult(id, "review"))!.status).toBe("failed");
  });

  test("parked-time is accounted into parkedMs on resume", async () => {
    const { store, id, deps, clock } = await parkAtReview();
    // Parked at t=1000; respond at t=5000 → +4000ms parked.
    clock.t = 5000;
    await respondToGate(id, { step: "review", action: "approve" }, deps);
    expect((await store.getRun(id))!.parkedMs).toBe(4000);
    expect((await store.getRun(id))!.awaitingAgentSince).toBeNull();
  });
});

// ── respond: fix ────────────────────────────────────────────────────

describe("respondToGate — fix", () => {
  test("fix re-executes the step (fixing=true), records the user selection, then completes", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const review = scriptStep("review", [blocking("auto-fix"), clean]);
    const push = scriptStep("push", [clean]);
    const deps = makeDeps(
      store,
      registry({ intent: scriptStep("intent", [clean]), rebase: scriptStep("rebase", [clean]), review, push }),
      { t: 0 },
    );
    await startPipeline(id, deps); // parks at review (cap 0)
    const outcome = await respondToGate(
      id,
      { step: "review", action: "fix", findingIds: ["f1"], instructions: { f1: "do X" }, addedFindings: [{ description: "extra" }] },
      deps,
    );
    expect(outcome.status).toBe("completed");
    // review executed twice: initial (not fixing) + the fix (fixing).
    expect(review.calls).toEqual([false, true]);
    // The parked round recorded the user selection.
    const rounds = await store.getStepRounds(id, "review");
    expect(rounds[0]!.selectionSource).toBe("user");
    expect(JSON.parse(rounds[0]!.selectedFindingIds!)).toContain("f1");
    expect(rounds[0]!.userFindingsJson).not.toBeNull();
    expect(push.calls.length).toBe(1);
  });

  test("fix that still parks stays parked", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const review = scriptStep("review", [blocking("ask-user"), blocking("ask-user")]);
    const deps = makeDeps(
      store,
      registry({ intent: scriptStep("intent", [clean]), rebase: scriptStep("rebase", [clean]), review }),
      { t: 0 },
    );
    await startPipeline(id, deps);
    const outcome = await respondToGate(id, { step: "review", action: "fix", findingIds: ["f1"] }, deps);
    expect(outcome.status).toBe("parked");
    expect((await store.getStepResult(id, "review"))!.status).toBe("fix_review");
  });

  test("fix whose re-run throws → fails the run", async () => {
    const store = memStore();
    const id = await seedRun(store);
    let n = 0;
    const review: Step = {
      name: "review",
      async execute() {
        n += 1;
        if (n === 1) return blocking("ask-user");
        throw new Error("fix crashed");
      },
    };
    const deps = makeDeps(
      store,
      registry({ intent: scriptStep("intent", [clean]), rebase: scriptStep("rebase", [clean]), review }),
      { t: 0 },
    );
    await startPipeline(id, deps);
    const outcome = await respondToGate(id, { step: "review", action: "fix" }, deps);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("fix crashed");
  });

  test("fix that returns skipRemaining completes the run + skips the rest", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const review = scriptStep("review", [blocking("ask-user"), { skipRemaining: true }]);
    const push = scriptStep("push", [clean]);
    const deps = makeDeps(
      store,
      registry({ intent: scriptStep("intent", [clean]), rebase: scriptStep("rebase", [clean]), review, push }),
      { t: 0 },
    );
    await startPipeline(id, deps);
    const outcome = await respondToGate(id, { step: "review", action: "fix" }, deps);
    expect(outcome.status).toBe("completed");
    expect((await store.getStepResult(id, "push"))!.status).toBe("skipped");
    expect(push.calls.length).toBe(0);
  });
});

// ── respond validation ──────────────────────────────────────────────

describe("respondToGate validation", () => {
  test("run not found → failed", async () => {
    const store = memStore();
    const deps = makeDeps(store, registry({}), { t: 0 });
    expect((await respondToGate("nope", { step: "review", action: "approve" }, deps)).status).toBe("failed");
  });

  test("unknown step → failed", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const deps = makeDeps(store, registry({}), { t: 0 });
    const outcome = await respondToGate(id, { step: "bogus" as PipelineStep, action: "approve" }, deps);
    expect(outcome.error).toContain("unknown step");
  });

  test("responding to a step that is not awaiting → failed", async () => {
    const store = memStore();
    const id = await seedRun(store);
    // review row exists but is 'pending', not a gate.
    await store.putStepResult({
      runId: id,
      step: "review",
      status: "pending",
      findings: emptyFindings(),
      agentPid: null,
      autoFixLimit: 0,
      round: 0,
      autoFixAttempts: 0,
      executionMs: 0,
      fixSummary: null,
    });
    const deps = makeDeps(store, registry({}), { t: 0 });
    const outcome = await respondToGate(id, { step: "review", action: "approve" }, deps);
    expect(outcome.error).toContain("not awaiting approval");
  });
});

// ── M3: trusted-branch repo-config threading (spec §1 invariant 1) ──

/** A scripted step that records the repoConfig it saw each execution. */
function captureRepoConfigStep(name: PipelineStep, outcomes: StepOutcome[]): Step & { seen: RepoConfig[] } {
  let i = 0;
  const seen: RepoConfig[] = [];
  return {
    name,
    seen,
    async execute(sctx: StepContext) {
      seen.push(sctx.repoConfig);
      const o = outcomes[Math.min(i, outcomes.length - 1)]!;
      i += 1;
      return o;
    },
  };
}

describe("trusted-branch repo-config threading", () => {
  test("SECURITY: a resolveRepoConfig throw ABORTS the run before any step/dispatch", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const review = scriptStep("review", [clean]);
    const deps: ExecutorDeps = {
      ...makeDeps(store, registry({ intent: scriptStep("intent", [clean]), review }), { t: 0 }),
      resolveRepoConfig: async () => {
        throw new TrustedConfigError("default branch unreadable");
      },
    };
    const outcome = await startPipeline(id, deps);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("trusted config unreadable");
    // No step ran — the abort is BEFORE advance (so before any agent dispatch).
    expect(review.calls.length).toBe(0);
    expect((await store.getRun(id))!.status).toBe("failed");
  });

  test("resolved config is PERSISTED on the run and threaded to every step", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const resolved: RepoConfig = { ...emptyRepoConfig(), commands: { test: "bun test", lint: "", format: "" } };
    const test = captureRepoConfigStep("test", [clean]);
    const deps: ExecutorDeps = {
      ...makeDeps(store, registry({ intent: scriptStep("intent", [clean]), test }), { t: 0 }),
      resolveRepoConfig: async () => resolved,
    };
    await startPipeline(id, deps);
    expect(test.seen[0]!.commands.test).toBe("bun test");
    expect((await store.getRun(id))!.repoConfig!.commands.test).toBe("bun test");
  });

  test("respondToGate REUSES the persisted config (no re-resolve) for the fix/advance steps", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const resolved: RepoConfig = { ...emptyRepoConfig(), commands: { test: "persisted-cmd", lint: "", format: "" } };
    const review = scriptStep("review", [blocking()]); // parks
    const test = captureRepoConfigStep("test", [clean]);
    let resolveCalls = 0;
    const deps: ExecutorDeps = {
      ...makeDeps(store, registry({ intent: scriptStep("intent", [clean]), review, test }), { t: 0 }),
      resolveRepoConfig: async () => {
        resolveCalls += 1;
        return resolved;
      },
    };
    expect((await startPipeline(id, deps)).status).toBe("parked");
    expect(resolveCalls).toBe(1);
    // Approving review advances to `test`, which must see the PERSISTED config
    // without a second resolve (a respond never re-fetches the default branch).
    await respondToGate(id, { step: "review", action: "approve" }, deps);
    expect(resolveCalls).toBe(1);
    expect(test.seen[0]!.commands.test).toBe("persisted-cmd");
  });

  test("without a resolveRepoConfig seam, steps get an empty config (M1 shape, no fetch)", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const test = captureRepoConfigStep("test", [clean]);
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), test }), { t: 0 });
    await startPipeline(id, deps);
    expect(test.seen[0]).toEqual(emptyRepoConfig());
  });
});

// ── StepContext seams (pr/ci plumbing) ──────────────────────────────

describe("StepContext seams", () => {
  test("exposes default gh/sleep + persists prUrl + loads step history", async () => {
    const store = memStore();
    const id = await seedRun(store);
    let ghExit = -1;
    let historyLen = -1;
    const probe: Step = {
      name: "intent",
      async execute(sctx) {
        ghExit = (await sctx.gh(["auth", "status"])).exitCode; // default unavailableGh
        await sctx.sleep(0); // default realSleep
        await sctx.updatePrUrl("https://github.com/o/n/pull/1");
        historyLen = (await sctx.loadStepHistory()).length;
        return {};
      },
    };
    const deps = makeDeps(store, registry({ intent: probe }), { t: 0 });
    await startPipeline(id, deps);
    expect(ghExit).toBe(127); // gh not wired → pr/ci would skip-not-fail
    expect(historyLen).toBeGreaterThanOrEqual(1); // at least the intent step result
    expect((await store.getRun(id))!.prUrl).toBe("https://github.com/o/n/pull/1");
  });
});

// ── checks_passed resting outcome (H2, spec §1 step 9) ──────────────

describe("startPipeline — CI checks_passed rest", () => {
  test("a CI checksPassed outcome rests the run at checks_passed, CI step parked", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const clock = { t: 4000 };
    // A ci step that reports green checks. Every earlier implemented step is clean.
    const ci = scriptStep("ci", [{ checksPassed: true }]);
    const deps = makeDeps(
      store,
      registry({
        intent: scriptStep("intent", [clean]),
        rebase: scriptStep("rebase", [clean]),
        review: scriptStep("review", [clean]),
        push: scriptStep("push", [clean]),
        ci,
      }),
      clock,
    );
    const outcome = await startPipeline(id, deps);
    // Not terminal, not parked — a distinct resting outcome pointing at ci.
    expect(outcome).toEqual({ status: "checks_passed", parkedStep: "ci" });
    const run = (await store.getRun(id))!;
    expect(run.status).toBe("checks_passed");
    // awaitingAgentSince is set so a later reconcile can account the parked time.
    expect(run.awaitingAgentSince).toBe(new Date(clock.t).toISOString());
    // The CI STEP is left parked so reconcileGate finds + completes it on merge.
    expect((await store.getStepResult(id, "ci"))!.status).toBe("awaiting_approval");
  });

  test("a subsequent reconcile on a merged PR advances checks_passed → completed", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const clock = { t: 1000 };
    // A ci step that first rests (checksPassed) then, on the reconcile poll,
    // reports its PR merged.
    const ci: Step = {
      name: "ci",
      async execute() {
        return { checksPassed: true };
      },
      async reconcileApprovalGate() {
        return { resolved: true };
      },
    };
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), ci }), clock);
    expect((await startPipeline(id, deps)).status).toBe("checks_passed");

    // The PR later merges → a reconcile completes the run (worktree already gone).
    clock.t = 9000;
    const outcome = await reconcileGate(id, deps);
    expect(outcome.status).toBe("completed");
    expect((await store.getRun(id))!.status).toBe("completed");
    expect((await store.getStepResult(id, "ci"))!.status).toBe("completed");
  });
});

// ── reconcileGate (opt-in ReconcileApprovalGate driver) ─────────────

describe("reconcileGate", () => {
  /** A step exposing a scripted reconcileApprovalGate. */
  function reconcileStep(name: PipelineStep, result: { resolved: boolean } | Error): Step {
    return {
      name,
      async execute() {
        return { needsApproval: true, findings: "" };
      },
      async reconcileApprovalGate() {
        if (result instanceof Error) throw result;
        return result;
      },
    };
  }

  /** Seed a run parked at `step` (awaiting_approval). */
  async function seedParked(store: RunStore, step: PipelineStep, clock: { t: number }): Promise<string> {
    const id = await seedRun(store, { status: "awaiting_approval", awaitingAgentSince: new Date(clock.t).toISOString() });
    await store.putStepResult({
      runId: id,
      step,
      status: "awaiting_approval",
      findings: emptyFindings(),
      agentPid: null,
      autoFixLimit: 3,
      round: 1,
      autoFixAttempts: 0,
      executionMs: 0,
      fixSummary: null,
    });
    return id;
  }

  test("run not found → failed", async () => {
    const store = memStore();
    const deps = makeDeps(store, registry({}), { t: 0 });
    expect(await reconcileGate("nope", deps)).toEqual({ status: "failed", error: "run nope not found" });
  });

  test("no parked step → parked (nothing to reconcile)", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const deps = makeDeps(store, registry({}), { t: 0 });
    expect(await reconcileGate(id, deps)).toEqual({ status: "parked" });
  });

  test("parked step without a reconcile hook → stays parked", async () => {
    const store = memStore();
    const clock = { t: 1000 };
    const id = await seedParked(store, "review", clock);
    const deps = makeDeps(store, registry({ review: scriptStep("review", [blocking()]) }), clock);
    expect(await reconcileGate(id, deps)).toEqual({ status: "parked", parkedStep: "review" });
  });

  test("CI gate resolves (PR merged) → completes step + run", async () => {
    const store = memStore();
    const clock = { t: 5000 };
    const id = await seedParked(store, "ci", clock);
    const deps = makeDeps(store, registry({ ci: reconcileStep("ci", { resolved: true }) }), clock);
    const outcome = await reconcileGate(id, deps);
    expect(outcome.status).toBe("completed");
    expect((await store.getStepResult(id, "ci"))!.status).toBe("completed");
    const run = await store.getRun(id);
    expect(run!.status).toBe("completed");
    expect(run!.parkedMs).toBeGreaterThanOrEqual(0);
  });

  test("CI gate not resolved (PR still open) → stays parked", async () => {
    const store = memStore();
    const clock = { t: 0 };
    const id = await seedParked(store, "ci", clock);
    const deps = makeDeps(store, registry({ ci: reconcileStep("ci", { resolved: false }) }), clock);
    expect(await reconcileGate(id, deps)).toEqual({ status: "parked", parkedStep: "ci" });
    expect((await store.getStepResult(id, "ci"))!.status).toBe("awaiting_approval");
  });

  test("reconcile error is swallowed → stays parked", async () => {
    const store = memStore();
    const clock = { t: 0 };
    const id = await seedParked(store, "ci", clock);
    const deps = makeDeps(store, registry({ ci: reconcileStep("ci", new Error("gh down")) }), clock);
    expect(await reconcileGate(id, deps)).toEqual({ status: "parked", parkedStep: "ci" });
  });
});

// ── real registry wiring ────────────────────────────────────────────

describe("STEP_REGISTRY (production wiring)", () => {
  test("registers + implements all nine steps (M4 completes pr/ci)", () => {
    for (const s of PIPELINE_STEPS) {
      expect(s in STEP_REGISTRY).toBe(true);
      expect(STEP_REGISTRY[s]).not.toBeNull();
    }
  });
  test("only the CI step opts into ReconcileApprovalGate", () => {
    expect(typeof STEP_REGISTRY.ci!.reconcileApprovalGate).toBe("function");
    expect(STEP_REGISTRY.review!.reconcileApprovalGate).toBeUndefined();
  });
});
