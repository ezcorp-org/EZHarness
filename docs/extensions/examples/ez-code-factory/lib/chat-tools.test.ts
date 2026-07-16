import { test, expect, describe } from "bun:test";
import {
  buildGateStatus,
  respondChatTool,
  runChatTool,
  statusChatTool,
  type ChatToolDeps,
} from "./chat-tools";
import { emptyFindings, type Finding, type Findings, type ParsedRespond, type PushReceived, type RunRecord, type RunStatus, type RunStore, type StepResultRecord } from "./runs";
import type { ShellResult } from "./shell";

// ── in-memory store ─────────────────────────────────────────────────

function memStore(): RunStore & { runs: Map<string, RunRecord>; steps: Map<string, StepResultRecord> } {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, StepResultRecord>();
  return {
    runs,
    steps,
    async createRun(run) {
      runs.set(run.id, run);
    },
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async updateRun(id, patch) {
      const cur = runs.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: "t" };
      runs.set(id, next);
      return next;
    },
    async listRuns() {
      return [...runs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async putStepResult(step) {
      steps.set(`${step.runId}/${step.step}`, step);
    },
    async getStepResult(runId, step) {
      return steps.get(`${runId}/${step}`) ?? null;
    },
    async appendStepRound() {},
    async getStepRounds() {
      return [];
    },
    async patchLastStepRound() {},
  };
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    repoId: "0123456789ab",
    branch: "feat/x",
    ref: "refs/heads/feat/x",
    headSha: "abc1234",
    baseSha: "0".repeat(40),
    status: "awaiting_approval",
    worktreePath: "/wt",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "t",
    parkedMs: 0,
    awaitingAgentSince: null,
    intent: null,
    intentSource: null,
    ...over,
  };
}

function findingsWith(items: Partial<Finding>[]): Findings {
  const base: Finding = {
    id: "f1", severity: "warning", file: "src/a.ts", line: 1,
    description: "d", action: "no-op", source: "agent", userInstructions: "", category: "review",
  };
  return { ...emptyFindings(), items: items.map((o) => ({ ...base, ...o })) };
}

/** A shell runner driven by a command→result map (default: exit 0, empty). */
function fakeShell(route: (cmd: string) => Partial<ShellResult> | undefined) {
  return async (cmd: string[]): Promise<ShellResult> => {
    const r = route(cmd.join(" ")) ?? {};
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

const NEW_SHA = "a".repeat(40);

/** Base deps: shell resolves branch=feat/x, newSha, no gate ref (→ ZERO), empty
 *  diff, fetch ok; store empty; triggerRun records a parked run. */
function baseDeps(over: Partial<ChatToolDeps> = {}): ChatToolDeps {
  const store = memStore();
  return {
    projectRoot: "/proj",
    gateDir: "/gate",
    repoId: "0123456789ab",
    defaultBranch: "main",
    run: fakeShell((c) => {
      if (c.includes("symbolic-ref")) return { stdout: "feat/x\n" };
      if (c.includes("rev-parse") && c.includes("feat/x^{commit}") && c.includes("/proj")) return { stdout: `${NEW_SHA}\n` };
      if (c.includes("rev-parse") && c.includes("refs/heads/feat/x^{commit}") && c.includes("/gate")) return { exitCode: 128 };
      if (c.includes("diff")) return { stdout: "" };
      if (c.includes("fetch")) return { exitCode: 0 };
      return {};
    }),
    store,
    triggerRun: async (push: PushReceived) => {
      await store.createRun(run({ id: "r1", intent: push.intent, intentSource: push.intentSource ?? null }));
      await store.putStepResult({
        runId: "r1", step: "review", status: "awaiting_approval",
        findings: findingsWith([{ id: "a1", action: "ask-user", description: "confirm?" }]),
        agentPid: null, autoFixLimit: 0, round: 1, autoFixAttempts: 0, executionMs: 0, fixSummary: null,
      });
      return { ok: true, runId: "r1", worktreePath: "/wt", status: "awaiting_approval" as RunStatus };
    },
    resumeRun: async () => ({ status: "completed" as RunStatus, parked: false }),
    inferIntent: async () => null,
    ...over,
  };
}

// ── buildGateStatus ─────────────────────────────────────────────────

describe("buildGateStatus", () => {
  test("unknown run → null", async () => {
    expect(await buildGateStatus(memStore(), "nope")).toBeNull();
  });

  test("surfaces the parked step + its verbatim-relay split", async () => {
    const store = memStore();
    await store.createRun(run());
    await store.putStepResult({
      runId: "r1", step: "review", status: "awaiting_approval",
      findings: findingsWith([{ id: "a1", action: "ask-user" }, { id: "n1", action: "no-op" }]),
      agentPid: null, autoFixLimit: 0, round: 1, autoFixAttempts: 0, executionMs: 0, fixSummary: null,
    });
    const s = (await buildGateStatus(store, "r1"))!;
    expect(s.parkedStep).toBe("review");
    expect(s.parkedStepStatus).toBe("awaiting_approval");
    expect(s.relay!.stop).toBe(true);
    expect(s.relay!.askUser.map((f) => f.id)).toEqual(["a1"]);
    expect(s.steps).toEqual([{ step: "review", status: "awaiting_approval" }]);
  });

  test("no parked step → relay null", async () => {
    const store = memStore();
    await store.createRun(run({ status: "completed" }));
    await store.putStepResult({
      runId: "r1", step: "review", status: "completed", findings: emptyFindings(),
      agentPid: null, autoFixLimit: 0, round: 1, autoFixAttempts: 0, executionMs: 0, fixSummary: null,
    });
    const s = (await buildGateStatus(store, "r1"))!;
    expect(s.parkedStep).toBeNull();
    expect(s.relay).toBeNull();
  });
});

// ── runChatTool ─────────────────────────────────────────────────────

describe("runChatTool", () => {
  test("triggers a run and returns the verbatim relay when it parks on ask-user", async () => {
    const deps = baseDeps();
    const out = await runChatTool({}, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.data.triggered).toBe(true);
    expect(out.data.mustRelayVerbatim).toBe(true);
    expect(out.data.relayDirective).toBeTypeOf("string");
    expect((out.data.askUserFindings as unknown[]).length).toBe(1);
    expect(out.data.runId).toBe("r1");
  });

  test("explicit intent is used (authoritative source=agent)", async () => {
    let captured: PushReceived | null = null;
    const deps = baseDeps({ triggerRun: async (p) => { captured = p; return { ok: true, runId: "r1", worktreePath: "", status: "completed" }; } });
    await runChatTool({ intent: "  add a --json flag  " }, deps);
    expect(captured!.intent).toBe("add a --json flag");
    expect(captured!.intentSource).toBe("agent");
  });

  test("an over-long explicit intent is capped", async () => {
    let captured: PushReceived | null = null;
    const deps = baseDeps({ triggerRun: async (p) => { captured = p; return { ok: true, runId: "r1", worktreePath: "", status: "completed" }; } });
    await runChatTool({ intent: "z".repeat(5000) }, deps);
    expect(captured!.intent!.length).toBe(4000);
  });

  test("no explicit intent → inferred hint is attached (source=conversation, capped, logged)", async () => {
    const logs: string[] = [];
    let captured: PushReceived | null = null;
    const deps = baseDeps({
      inferIntent: async () => ({ summary: "y".repeat(5000), source: "conversation", score: 1 }),
      triggerRun: async (p) => { captured = p; return { ok: true, runId: "r1", worktreePath: "", status: "completed" }; },
      log: (m) => logs.push(m),
    });
    await runChatTool({}, deps);
    expect(captured!.intentSource).toBe("conversation");
    expect(captured!.intent!.length).toBe(4000);
    expect(logs.join("\n")).toContain("attached inferred intent");
  });

  test("passes the diff files to the inferrer for the relevance gate", async () => {
    let seen: string[] = [];
    const deps = baseDeps({
      run: fakeShell((c) => {
        if (c.includes("symbolic-ref")) return { stdout: "feat/x\n" };
        if (c.includes("feat/x^{commit}") && c.includes("/proj")) return { stdout: `${NEW_SHA}\n` };
        if (c.includes("refs/heads/feat/x^{commit}")) return { exitCode: 1 };
        if (c.includes("diff")) return { stdout: "src/a.ts\nsrc/b.ts\n" };
        return {};
      }),
      inferIntent: async (files) => { seen = files; return null; },
    });
    await runChatTool({}, deps);
    expect(seen).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("resolves the gate's prior tip as the force-push anchor (oldSha)", async () => {
    let captured: PushReceived | null = null;
    const prior = "b".repeat(40);
    const deps = baseDeps({
      run: fakeShell((c) => {
        if (c.includes("symbolic-ref")) return { stdout: "feat/x\n" };
        if (c.includes("feat/x^{commit}") && c.includes("/proj")) return { stdout: `${NEW_SHA}\n` };
        if (c.includes("refs/heads/feat/x^{commit}") && c.includes("/gate")) return { stdout: `${prior}\n` };
        if (c.includes("diff")) return { stdout: "" };
        return {};
      }),
      triggerRun: async (p) => { captured = p; return { ok: true, runId: "r1", worktreePath: "", status: "completed" }; },
    });
    await runChatTool({}, deps);
    expect(captured!.oldSha).toBe(prior);
    expect(captured!.newSha).toBe(NEW_SHA);
  });

  test("an explicit unsafe branch is rejected", async () => {
    const out = await runChatTool({ branch: "a;rm -rf" }, baseDeps());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("safe target branch");
  });

  test("a safe explicit branch overrides the checkout", async () => {
    let captured: PushReceived | null = null;
    const deps = baseDeps({
      run: fakeShell((c) => {
        if (c.includes("release/1.2^{commit}") && c.includes("/proj")) return { stdout: `${NEW_SHA}\n` };
        if (c.includes("refs/heads/release/1.2^{commit}")) return { exitCode: 1 };
        if (c.includes("diff")) return { stdout: "" };
        return {};
      }),
      triggerRun: async (p) => { captured = p; return { ok: true, runId: "r1", worktreePath: "", status: "completed" }; },
    });
    await runChatTool({ branch: "release/1.2" }, deps);
    expect(captured!.branch).toBe("release/1.2");
  });

  test("branch cannot be resolved (detached HEAD) → error", async () => {
    const deps = baseDeps({ run: fakeShell((c) => (c.includes("symbolic-ref") ? { exitCode: 1 } : {})) });
    const out = await runChatTool({}, deps);
    expect(out.ok).toBe(false);
  });

  test("symbolic-ref returns an unsafe branch → error", async () => {
    const deps = baseDeps({ run: fakeShell((c) => (c.includes("symbolic-ref") ? { stdout: "bad branch\n" } : {})) });
    const out = await runChatTool({}, deps);
    expect(out.ok).toBe(false);
  });

  test("newSha unresolvable → error", async () => {
    const deps = baseDeps({
      run: fakeShell((c) => {
        if (c.includes("symbolic-ref")) return { stdout: "feat/x\n" };
        if (c.includes("feat/x^{commit}")) return { exitCode: 128 };
        return {};
      }),
    });
    const out = await runChatTool({}, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("no resolvable commit");
  });

  test("a non-hex rev-parse result is rejected as unresolvable", async () => {
    const deps = baseDeps({
      run: fakeShell((c) => {
        if (c.includes("symbolic-ref")) return { stdout: "feat/x\n" };
        if (c.includes("feat/x^{commit}")) return { stdout: "not-a-sha\n" };
        return {};
      }),
    });
    expect((await runChatTool({}, deps)).ok).toBe(false);
  });

  test("fetch into the gate failing → error mentioning init_gate", async () => {
    const deps = baseDeps({
      run: fakeShell((c) => {
        if (c.includes("symbolic-ref")) return { stdout: "feat/x\n" };
        if (c.includes("feat/x^{commit}") && c.includes("/proj")) return { stdout: `${NEW_SHA}\n` };
        if (c.includes("refs/heads/feat/x^{commit}")) return { exitCode: 1 };
        if (c.includes("diff")) return { stdout: "" };
        if (c.includes("fetch")) return { exitCode: 128, stderr: "not a git repository" };
        return {};
      }),
    });
    const out = await runChatTool({}, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("stage 'feat/x'");
  });

  test("fetch failure with no stderr falls back to the init_gate hint", async () => {
    const deps = baseDeps({
      run: fakeShell((c) => {
        if (c.includes("symbolic-ref")) return { stdout: "feat/x\n" };
        if (c.includes("feat/x^{commit}") && c.includes("/proj")) return { stdout: `${NEW_SHA}\n` };
        if (c.includes("refs/heads/feat/x^{commit}")) return { exitCode: 1 };
        if (c.includes("diff")) return { stdout: "" };
        if (c.includes("fetch")) return { exitCode: 1 };
        return {};
      }),
    });
    const out = await runChatTool({}, deps);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("init_gate first");
  });

  test("store race: run row missing after trigger → fallback to the lifecycle result", async () => {
    const deps = baseDeps({
      triggerRun: async () => ({ ok: false, runId: "ghost", worktreePath: "", status: "failed", error: "boom" }),
    });
    const out = await runChatTool({}, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
  });

  test("store race with a parked lifecycle result is reported ok", async () => {
    const deps = baseDeps({
      triggerRun: async () => ({ ok: false, runId: "ghost", worktreePath: "", status: "awaiting_approval" }),
    });
    const out = await runChatTool({}, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.data.status).toBe("awaiting_approval");
  });
});

// ── statusChatTool ──────────────────────────────────────────────────

describe("statusChatTool", () => {
  test("named run → its status", async () => {
    const deps = baseDeps();
    await deps.store.createRun(run({ id: "r9", status: "completed" }));
    const out = await statusChatTool({ runId: "r9" }, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.data.runId).toBe("r9");
    expect(out.data.status).toBe("completed");
  });

  test("named unknown run → error", async () => {
    const out = await statusChatTool({ runId: "missing" }, baseDeps());
    expect(out.ok).toBe(false);
  });

  test("no runId + no runs → empty list message", async () => {
    const out = await statusChatTool({}, baseDeps());
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.data.runs).toEqual([]);
  });

  test("no runId → newest run, ask-user relay leads the payload", async () => {
    const deps = baseDeps();
    await deps.store.createRun(run({ id: "old", createdAt: "2026-07-16T00:00:00.000Z" }));
    await deps.store.createRun(run({ id: "new", createdAt: "2026-07-16T02:00:00.000Z" }));
    await deps.store.putStepResult({
      runId: "new", step: "review", status: "awaiting_approval",
      findings: findingsWith([{ id: "a1", action: "ask-user" }]),
      agentPid: null, autoFixLimit: 0, round: 1, autoFixAttempts: 0, executionMs: 0, fixSummary: null,
    });
    const out = await statusChatTool({}, deps);
    if (!out.ok) throw new Error("unreachable");
    expect(out.data.runId).toBe("new");
    expect(out.data.mustRelayVerbatim).toBe(true);
  });

  test("a parked gate with only auto-fix findings → mustRelayVerbatim false", async () => {
    const deps = baseDeps();
    await deps.store.createRun(run({ id: "r1", status: "awaiting_approval" }));
    await deps.store.putStepResult({
      runId: "r1", step: "review", status: "awaiting_approval",
      findings: findingsWith([{ id: "n1", action: "no-op" }]),
      agentPid: null, autoFixLimit: 0, round: 1, autoFixAttempts: 0, executionMs: 0, fixSummary: null,
    });
    const out = await statusChatTool({ runId: "r1" }, deps);
    if (!out.ok) throw new Error("unreachable");
    expect(out.data.mustRelayVerbatim).toBe(false);
    expect(out.data.agentDiscretionFindings).toBeDefined();
  });
});

// ── respondChatTool ─────────────────────────────────────────────────

const parked = () => baseDeps();

async function seedParked(deps: ChatToolDeps): Promise<void> {
  await deps.store.createRun(run({ id: "r1", status: "awaiting_approval" }));
  await deps.store.putStepResult({
    runId: "r1", step: "review", status: "awaiting_approval",
    findings: findingsWith([{ id: "a1", action: "ask-user" }]),
    agentPid: null, autoFixLimit: 0, round: 1, autoFixAttempts: 0, executionMs: 0, fixSummary: null,
  });
}

describe("respondChatTool", () => {
  test("invalid payload (bad action) → error", async () => {
    const out = await respondChatTool({ runId: "r1", step: "review", action: "nuke" }, parked());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("invalid respond");
  });

  test("NO BLANKET APPROVAL: approve without findingIds is rejected", async () => {
    const out = await respondChatTool({ runId: "r1", step: "review", action: "approve" }, parked());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("must name the explicit findingIds");
  });

  test("unknown run → error", async () => {
    const out = await respondChatTool(
      { runId: "ghost", step: "review", action: "approve", findingIds: ["a1"] },
      parked(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("unknown run");
  });

  test("approve WITH findingIds resumes and returns the post-respond status", async () => {
    const deps = parked();
    await seedParked(deps);
    let resumed: { runId: string; respond: ParsedRespond } | null = null;
    deps.resumeRun = async (runId, respond) => {
      resumed = { runId, respond };
      await deps.store.updateRun(runId, { status: "completed" });
      return { status: "completed", parked: false };
    };
    const out = await respondChatTool({ runId: "r1", step: "review", action: "approve", findingIds: ["a1"] }, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.data.applied).toBe(true);
    expect(out.data.action).toBe("approve");
    expect(resumed!.respond.findingIds).toEqual(["a1"]);
  });

  test("consentAll allows a blanket approve", async () => {
    const deps = parked();
    await seedParked(deps);
    deps.resumeRun = async (runId) => {
      await deps.store.updateRun(runId, { status: "completed" });
      return { status: "completed", parked: false };
    };
    const out = await respondChatTool({ runId: "r1", step: "review", action: "approve", consentAll: true }, deps);
    expect(out.ok).toBe(true);
  });

  test("skip needs no findingIds", async () => {
    const deps = parked();
    await seedParked(deps);
    deps.resumeRun = async () => ({ status: "running" as RunStatus, parked: false });
    const out = await respondChatTool({ runId: "r1", step: "review", action: "skip" }, deps);
    expect(out.ok).toBe(true);
  });

  test("resume returning null → error", async () => {
    const deps = parked();
    await seedParked(deps);
    deps.resumeRun = async () => null;
    const out = await respondChatTool({ runId: "r1", step: "review", action: "abort" }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("could not resume");
  });

  test("run torn down mid-respond → status unavailable → error", async () => {
    const deps = parked();
    await seedParked(deps);
    deps.resumeRun = async (runId) => {
      (deps.store as ReturnType<typeof memStore>).runs.delete(runId); // concurrent terminal teardown
      return { status: "completed", parked: false };
    };
    const out = await respondChatTool({ runId: "r1", step: "review", action: "abort" }, deps);
    expect(out.ok).toBe(false);
  });
});
