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
import { repoDispatchOptions, runStepShellCommand, type Step, type StepContext, type StepOutcome } from "./steps/common";
import { emptyRepoConfig, TrustedConfigError, type RepoConfig } from "./repo-config";
import { emptyOutcomeFlags, type StepIORecord } from "./step-io";

// ── in-memory store ─────────────────────────────────────────────────

function memStore(): RunStore & {
  rounds: Map<string, StepRoundRecord[]>;
  steps: Map<string, StepResultRecord>;
  stepIO: Map<string, StepIORecord>;
} {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, StepResultRecord>();
  const rounds = new Map<string, StepRoundRecord[]>();
  const stepIO = new Map<string, StepIORecord>();
  const key = (r: string, s: string) => `${r}/${s}`;
  return {
    steps,
    rounds,
    stepIO,
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
    async putStepIO(record) {
      stepIO.set(`${record.runId}/${record.step}/${record.round}`, { ...record });
    },
    async getStepIO(runId, step, round) {
      const r = stepIO.get(`${runId}/${step}/${round}`);
      return r ? { ...r } : null;
    },
    async listStepIO(runId, step) {
      const prefix = `${runId}/${step}/`;
      return [...stepIO.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => ({ ...v }))
        .sort((a, b) => a.round - b.round);
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

/** A dispatcher that stamps unique, resolvable handle ids on each dispatch —
 *  drives the executor's linkage-recording path. The noop dispatcher above
 *  returns no ids, so it records nothing (the pre-linkage / hand-built case). */
function linkingDispatcher(): AgentDispatcher {
  let n = 0;
  return {
    async dispatch() {
      n += 1;
      return {
        output: null,
        text: "",
        subConversationId: `sub-${n}`,
        assignmentId: `asg-${n}`,
        agentRunId: `run-${n}`,
      };
    },
  };
}

/** A step that dispatches ONE agent turn per execute (role-tagged) then returns
 *  the scripted outcome — exercises the executor's per-round dispatch recorder
 *  (`scriptStep` never dispatches, so it records nothing). */
function dispatchingStep(
  name: PipelineStep,
  role: "reviewer" | "fixer" | "generic",
  outcomes: StepOutcome[],
): Step {
  let i = 0;
  return {
    name,
    async execute(sctx: StepContext) {
      await sctx.dispatcher.dispatch({ role, prompt: "p", cwd: sctx.worktree });
      const o = outcomes[Math.min(i, outcomes.length - 1)]!;
      i += 1;
      return o;
    },
  };
}

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

  // Control plane (L5): every REAL status transition flows through the
  // setRunStatus choke and appends a `run-status` audit entry (id + status
  // only). A run driven to completion records at least a `running` and a
  // `completed` transition; a bare parkedMs bump (no status) is NOT audited.
  test("run status transitions are audited via the setRunStatus choke", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const entries: Array<{ kind: string; runId?: string; detail?: unknown }> = [];
    const audit = {
      async append(e: { kind: string; runId?: string; detail?: unknown }) { entries.push(e); },
      async readDay() { return []; },
      async listDays() { return []; },
      async pruneRetention() { return []; },
    };
    const deps: ExecutorDeps = {
      ...makeDeps(store, registry({
        intent: scriptStep("intent", [clean]),
        rebase: scriptStep("rebase", [clean]),
        review: scriptStep("review", [clean]),
        push: scriptStep("push", [clean]),
      }), { t: 0 }),
      audit,
    };
    await startPipeline(id, deps);
    const statuses = entries.filter((e) => e.kind === "run-status").map((e) => (e.detail as { status: string }).status);
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");
    // Every run-status entry carries the run id and no prompt/finding content.
    for (const e of entries.filter((e) => e.kind === "run-status")) {
      expect(e.runId).toBe(id);
      expect(Object.keys(e.detail as object).every((k) => k === "status" || k === "error")).toBe(true);
    }
  });

  // Control plane (L4): a job's skipSteps are marked `skipped` BEFORE dispatch —
  // an IMPLEMENTED step in skipSteps must NOT execute (no agent runs), while
  // non-skipped implemented steps still run normally.
  test("job skipSteps skip an implemented step without executing it", async () => {
    const store = memStore();
    const id = await seedRun(store);
    let testRan = false;
    const testStep: Step = { name: "test", async execute() { testRan = true; return {}; } };
    const deps: ExecutorDeps = {
      ...makeDeps(store, registry({
        intent: scriptStep("intent", [clean]),
        rebase: scriptStep("rebase", [clean]),
        review: scriptStep("review", [clean]),
        push: scriptStep("push", [clean]),
        test: testStep,
      }), { t: 0 }),
      skipSteps: ["test"],
      jobName: "Nightly",
    };
    const logs: string[] = [];
    deps.log = (_r, _s, m) => logs.push(m);
    const outcome = await startPipeline(id, deps);
    expect(outcome.status).toBe("completed");
    // The implemented `test` step was JOB-skipped, never executed.
    expect(testRan).toBe(false);
    expect((await store.getStepResult(id, "test"))!.status).toBe("skipped");
    expect(logs.some((l) => l === "skipped by job Nightly")).toBe(true);
    // A non-skipped implemented step still ran.
    expect((await store.getStepResult(id, "review"))!.status).toBe("completed");
  });

  // Control plane (L4): a job's agentName threads deps → StepContext →
  // repoDispatchOptions, so every step's DISPATCH carries the job's agent
  // override (preferred over the repo-config agent).
  test("job agentName threads through deps into the step dispatch options", async () => {
    const store = memStore();
    const id = await seedRun(store);
    let dispatchAgent: string | undefined = "UNSET";
    const review: Step = {
      name: "review",
      async execute(sctx) {
        // repoDispatchOptions is exactly what the real steps spread into their
        // DispatchOptions — capture the agent it resolves for this run.
        dispatchAgent = repoDispatchOptions(sctx).agentName;
        return clean;
      },
    };
    const deps: ExecutorDeps = {
      ...makeDeps(store, registry({
        intent: scriptStep("intent", [clean]),
        rebase: scriptStep("rebase", [clean]),
        review,
        push: scriptStep("push", [clean]),
      }), { t: 0 }),
      jobAgentName: "job-agent",
    };
    await startPipeline(id, deps);
    // The run's repoConfig has no agent (emptyRepoConfig), so the job override is
    // what reaches the dispatch — proving the full deps→sctx→dispatch thread.
    expect(dispatchAgent).toBe("job-agent");
  });

  // Control plane (L4): a job's operator prompt instructions thread deps →
  // StepContext exactly like agentName, so each step's call site can prepend the
  // sanitized section to its historySection.
  test("job prompt instructions thread through deps onto the step context", async () => {
    const store = memStore();
    const id = await seedRun(store);
    let seen: Pick<StepContext, "jobReviewInstructions" | "jobFixInstructions" | "jobDocumentInstructions"> = {};
    const review: Step = {
      name: "review",
      async execute(sctx) {
        seen = {
          jobReviewInstructions: sctx.jobReviewInstructions,
          jobFixInstructions: sctx.jobFixInstructions,
          jobDocumentInstructions: sctx.jobDocumentInstructions,
        };
        return clean;
      },
    };
    const deps: ExecutorDeps = {
      ...makeDeps(store, registry({
        intent: scriptStep("intent", [clean]),
        rebase: scriptStep("rebase", [clean]),
        review,
        push: scriptStep("push", [clean]),
      }), { t: 0 }),
      jobReviewInstructions: "review guidance",
      jobFixInstructions: "fix guidance",
      jobDocumentInstructions: "doc guidance",
    };
    await startPipeline(id, deps);
    expect(seen.jobReviewInstructions).toBe("review guidance");
    expect(seen.jobFixInstructions).toBe("fix guidance");
    expect(seen.jobDocumentInstructions).toBe("doc guidance");
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

describe("agent dispatch linkage recording (R3)", () => {
  test("records a dispatching step's spawn linkage on its step result", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const at = 1_700_000_000_000;
    const deps: ExecutorDeps = {
      ...makeDeps(
        store,
        registry({
          intent: scriptStep("intent", [clean]), // never dispatches
          rebase: dispatchingStep("rebase", "reviewer", [clean]),
        }),
        { t: 0 },
      ),
      dispatcher: linkingDispatcher(),
      now: () => at,
    };
    await startPipeline(id, deps);

    const sr = (await store.getStepResult(id, "rebase"))!;
    expect(sr.agentDispatches).toEqual([
      {
        role: "reviewer",
        assignmentId: "asg-1",
        subConversationId: "sub-1",
        agentRunId: "run-1",
        at: new Date(at).toISOString(),
      },
    ]);
    // A step that never dispatched carries no linkage (undefined, not []).
    expect((await store.getStepResult(id, "intent"))!.agentDispatches).toBeUndefined();
  });

  test("accumulates one ref per fix round (initial + auto-fix), oldest first", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const deps: ExecutorDeps = {
      ...makeDeps(
        store,
        registry({
          intent: scriptStep("intent", [clean]),
          // initial round → auto-fixable; the single fix round → clean.
          rebase: dispatchingStep("rebase", "fixer", [blocking("auto-fix"), clean]),
        }),
        { t: 0 },
      ),
      dispatcher: linkingDispatcher(),
    };
    expect((await startPipeline(id, deps)).status).toBe("completed");

    const sr = (await store.getStepResult(id, "rebase"))!;
    expect(sr.agentDispatches?.map((d) => d.assignmentId)).toEqual(["asg-1", "asg-2"]);
    expect(sr.agentDispatches?.every((d) => d.role === "fixer")).toBe(true);
  });

  test("a dispatcher without handle ids records nothing (fail-soft, no fabricated ref)", async () => {
    const store = memStore();
    const id = await seedRun(store);
    // Default noopDispatcher returns no ids — the recorder must not invent one.
    const deps = makeDeps(
      store,
      registry({
        intent: scriptStep("intent", [clean]),
        rebase: dispatchingStep("rebase", "reviewer", [clean]),
      }),
      { t: 0 },
    );
    await startPipeline(id, deps);
    expect((await store.getStepResult(id, "rebase"))!.agentDispatches).toBeUndefined();
  });
});

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

// ── step_io observability capture (L1/L2) + per-run heartbeat (L3) ──

describe("step_io capture", () => {
  test("writes a step_io record on the SUCCESS path under attemptRound with inputs + outcome flags", async () => {
    const store = memStore();
    const id = await seedRun(store, { intent: "ship it" });
    const review = scriptStep("review", [{ needsApproval: true, autoFixable: false }]); // parks
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), review }), { t: 1000 });
    await startPipeline(id, deps);

    const io = await store.getStepIO(id, "review", 1);
    expect(io).not.toBeNull();
    expect(io!.round).toBe(1);
    expect(io!.trigger).toBe("initial");
    expect(io!.branch).toBe("feat/x");
    expect(io!.headSha).toBe("abc");
    expect(io!.worktreePath).toBe("/wt");
    expect(io!.repoConfig).toBeDefined();
    expect(io!.error).toBeNull();
    expect(io!.outcome.needsApproval).toBe(true);
    // The clean intent step also recorded its own round-1 IO.
    expect(await store.getStepIO(id, "intent", 1)).not.toBeNull();
  });

  test("captures dispatch IO (prompt + preview + linkage) into the round record on success", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const deps = makeDeps(
      store,
      registry({ review: dispatchingStep("review", "reviewer", [{ needsApproval: true }]) }),
      { t: 0 },
    );
    deps.dispatcher = linkingDispatcher();
    await startPipeline(id, deps);

    const io = (await store.getStepIO(id, "review", 1))!;
    expect(io.dispatches).toHaveLength(1);
    expect(io.dispatches[0]!.role).toBe("reviewer");
    expect(io.dispatches[0]!.promptText).toBe("p");
    expect(io.dispatches[0]!.subConversationId).toBe("sub-1");
    expect(io.dispatches[0]!.assignmentId).toBe("asg-1");
    expect(io.dispatches[0]!.error).toBeUndefined();
  });

  test("drains TRUSTED shell commands from the round sink into the IO record", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const review: Step = {
      name: "review",
      async execute(sctx) {
        await runStepShellCommand(sctx, "true");
        return { needsApproval: true };
      },
    };
    const deps = makeDeps(store, registry({ review }), { t: 0 });
    await startPipeline(id, deps);

    const io = (await store.getStepIO(id, "review", 1))!;
    expect(io.shellCommands.map((c) => c.command)).toEqual(["true"]);
    expect(io.shellCommands[0]!.exitCode).toBe(0);
  });

  test("writes a step_io record on the THROW path (initial throw → round 1) carrying the error", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const rebase: Step = {
      name: "rebase",
      async execute() {
        throw new Error("git exploded");
      },
    };
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]), rebase }), { t: 2000 });
    await startPipeline(id, deps);

    const io = (await store.getStepIO(id, "rebase", 1))!;
    expect(io.round).toBe(1);
    expect(io.error).toContain("git exploded");
    expect(io.outcome).toEqual(emptyOutcomeFlags());
    // The throw happened before appendStepRound — no step_round exists.
    expect(await store.getStepRounds(id, "rebase")).toEqual([]);
  });

  test("a fix-round throw records under prior+1 (round 2) WITHOUT overwriting round 1's record", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const review: Step = {
      name: "review",
      async execute(sctx) {
        if (sctx.fixing) throw new Error("fix crashed");
        return { needsApproval: true, findings: "" };
      },
    };
    const deps = makeDeps(store, registry({ review }), { t: 100 });
    await startPipeline(id, deps); // parks at review round 1
    expect((await store.getStepIO(id, "review", 1))!.error).toBeNull();

    const outcome = await respondToGate(id, { step: "review", action: "fix", findingIds: [] }, deps);
    expect(outcome.status).toBe("failed");
    // Round 1's completed record is untouched; round 2 carries the fix error.
    expect((await store.getStepIO(id, "review", 1))!.error).toBeNull();
    const round2 = (await store.getStepIO(id, "review", 2))!;
    expect(round2.round).toBe(2);
    expect(round2.trigger).toBe("auto_fix");
    expect(round2.error).toContain("fix crashed");
  });

  test("captures a dispatch ERROR into the round IO (and the round throw records it)", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const deps = makeDeps(
      store,
      registry({ review: dispatchingStep("review", "reviewer", [clean]) }),
      { t: 0 },
    );
    deps.dispatcher = {
      async dispatch() {
        throw new Error("agent timed out");
      },
    };
    const outcome = await startPipeline(id, deps);
    expect(outcome.status).toBe("failed");

    const io = (await store.getStepIO(id, "review", 1))!;
    expect(io.error).toContain("agent timed out"); // the step rethrew the dispatch error
    expect(io.dispatches).toHaveLength(1);
    expect(io.dispatches[0]!.error).toContain("agent timed out");
    expect(io.dispatches[0]!.assignmentId).toBe(""); // a thrown dispatch has no handle
  });
});

describe("per-run heartbeat (L3)", () => {
  test("wraps execute in the heartbeat when wired — immediate + interval beats", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const beats: string[] = [];
    let capturedTick: (() => void) | null = null;
    let stopped = false;
    const review: Step = {
      name: "review",
      async execute() {
        capturedTick?.(); // one interval tick mid-execute
        return { needsApproval: true };
      },
    };
    const deps = makeDeps(store, registry({ review }), { t: 0 });
    deps.heartbeat = {
      write: async (runId) => {
        beats.push(runId);
      },
      schedule: (fn) => {
        capturedTick = fn;
        return () => {
          stopped = true;
        };
      },
    };
    await startPipeline(id, deps);
    await Promise.resolve();
    await Promise.resolve();
    // Immediate beat + one interval tick = 2 beats, all for this run.
    expect(beats.filter((b) => b === id).length).toBeGreaterThanOrEqual(2);
    expect(stopped).toBe(true); // interval cleared when execute settled
  });

  test("executes normally when no heartbeat is wired (backward compatible)", async () => {
    const store = memStore();
    const id = await seedRun(store);
    const deps = makeDeps(store, registry({ intent: scriptStep("intent", [clean]) }), { t: 0 });
    expect(deps.heartbeat).toBeUndefined();
    expect((await startPipeline(id, deps)).status).toBe("completed");
  });
});

describe("step_io write-failure resilience (L1 record-and-continue)", () => {
  /** A store whose putStepIO ALWAYS rejects — the write path must swallow it. */
  function rejectingIOStore() {
    const store = memStore();
    store.putStepIO = async () => {
      throw new Error("storage down");
    };
    return store;
  }

  test("a putStepIO rejection on the SUCCESS path never fails the run — it parks + logs", async () => {
    const store = rejectingIOStore();
    const id = await seedRun(store);
    const logs: string[] = [];
    const deps = {
      ...makeDeps(store, registry({ review: scriptStep("review", [{ needsApproval: true }]) }), { t: 0 }),
      log: (_r: string, _s: PipelineStep, m: string) => logs.push(m),
    };
    // The pipeline reaches its normal PARKED outcome and never rejects.
    const outcome = await startPipeline(id, deps);
    expect(outcome.status).toBe("parked");
    expect((await store.getRun(id))!.status).toBe("awaiting_approval");
    // The round + result still persisted (only the step_io write failed).
    expect(await store.getStepRounds(id, "review")).toHaveLength(1);
    // The failure was LOGGED, not propagated.
    expect(logs.some((m) => m.includes("step_io write failed (continuing)"))).toBe(true);
    // …and nothing landed in step_io (the write rejected).
    expect(await store.getStepIO(id, "review", 1)).toBeNull();
  });

  test("a putStepIO rejection on the THROW path preserves the STEP's error, not the storage error", async () => {
    const store = rejectingIOStore();
    const id = await seedRun(store);
    const logs: string[] = [];
    const rebase: Step = {
      name: "rebase",
      async execute() {
        throw new Error("git exploded");
      },
    };
    const deps = {
      ...makeDeps(store, registry({ intent: scriptStep("intent", [clean]), rebase }), { t: 0 }),
      log: (_r: string, _s: PipelineStep, m: string) => logs.push(m),
    };
    const outcome = await startPipeline(id, deps);
    // Fails with the STEP's error — the swallowed storage-down never surfaces.
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("git exploded");
    expect(outcome.error).not.toContain("storage down");
    expect((await store.getRun(id))!.status).toBe("failed");
    expect(logs.some((m) => m.includes("step_io write failed (continuing)"))).toBe(true);
  });
});

describe("resultPreviewText (via captured dispatch IO)", () => {
  /** A dispatcher whose dispatch resolves to a fixed result. */
  function fixedDispatcher(result: import("./agent").DispatchResult): AgentDispatcher {
    return { async dispatch() { return result; } };
  }
  async function capturedPreview(result: import("./agent").DispatchResult): Promise<string> {
    const store = memStore();
    const id = await seedRun(store);
    const deps = makeDeps(
      store,
      registry({ review: dispatchingStep("review", "reviewer", [{ needsApproval: true }]) }),
      { t: 0 },
    );
    deps.dispatcher = fixedDispatcher(result);
    await startPipeline(id, deps);
    return (await store.getStepIO(id, "review", 1))!.dispatches[0]!.resultPreview;
  }

  test("structured output is JSON-serialized into the preview", async () => {
    expect(await capturedPreview({ output: { summary: "ok" }, text: "ignored" })).toBe('{"summary":"ok"}');
  });

  test("a non-serializable (circular) output falls back to the final text", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await capturedPreview({ output: circular, text: "FALLBACK_TEXT" })).toBe("FALLBACK_TEXT");
  });

  test("a null output uses the final text directly", async () => {
    expect(await capturedPreview({ output: null, text: "FINAL_ANSWER" })).toBe("FINAL_ANSWER");
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
