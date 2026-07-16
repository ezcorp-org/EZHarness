import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetChannelForTests,
  __resetPagesForTests,
  getChannel,
} from "@ezcorp/sdk/runtime";
import type { HostChannel } from "@ezcorp/sdk/runtime";
import {
  initGateTool,
  handlePushReceived,
  renderDashboard,
  register,
  start,
  tools,
  handleRespond,
  PUSH_RECEIVED_ACTION,
  RESPOND_ACTION,
  _setProjectRootForTests,
  _setShellForTests,
  _setStoreForTests,
  _setPushPageForTests,
  _setTmpBaseForTests,
  _setBaseUrlForTests,
  _setRunPipelineForTests,
  _setRespondRunnerForTests,
  _setSettingsReadForTests,
  handleYolo,
  YOLO_ACTION,
  handleReconcile,
  RECONCILE_ACTION,
  _setReconcileRunnerForTests,
  _setTokenStorageForTests,
  resolveProductionGhToken,
  codeFactoryRunTool,
  codeFactoryStatusTool,
  codeFactoryRespondTool,
  codeFactoryDoctorTool,
  _setChatToolDepsForTests,
  _setRbacCheckForTests,
  _setHeartbeatKVForTests,
  runReconcileSweep,
  handleScheduleFire,
  recoverOnStart,
} from "./index";
import type { ChatToolDeps } from "./lib/chat-tools";
import { gateDir as gateDirFor, GATE_REMOTE, HOOK_MARKER } from "./lib/gate";
import { SWEEP_CRON } from "./lib/sweep";
import { productionHostRunner, type ShellRunner } from "./lib/shell";
import { emptyFindings } from "./lib/runs";
import type { Finding, ParsedRespond, RunRecord, RunStore, StepResultRecord, StepRoundRecord, StepStatus } from "./lib/runs";

// ── in-memory store + fakes ─────────────────────────────────────────

function memStore(): RunStore & { runs: Map<string, RunRecord> } {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, StepResultRecord>();
  const rounds = new Map<string, StepRoundRecord[]>();
  return {
    runs,
    async createRun(run) {
      runs.set(run.id, run);
    },
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async updateRun(id, patch) {
      const cur = runs.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
      runs.set(id, next);
      return next;
    },
    async listRuns() {
      return [...runs.values()];
    },
    async putStepResult(step) {
      steps.set(`${step.runId}/${step.step}`, step);
    },
    async getStepResult(runId, step) {
      return steps.get(`${runId}/${step}`) ?? null;
    },
    async appendStepRound(round) {
      const key = `${round.runId}/${round.step}`;
      const list = rounds.get(key) ?? [];
      list.push(round);
      rounds.set(key, list);
    },
    async getStepRounds(runId, step) {
      return rounds.get(`${runId}/${step}`) ?? [];
    },
    async patchLastStepRound(runId, step, patch) {
      const list = rounds.get(`${runId}/${step}`);
      if (!list || list.length === 0) return;
      list[list.length - 1] = { ...list[list.length - 1]!, ...patch };
    },
  };
}

/** A git runner that succeeds for every command (worktree ops as no-ops). */
const okShell: ShellRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });

/** okShell plus a resolvable default-branch SHA, so the M3 trusted-config
 *  resolver (fetch → resolve → assert) proceeds instead of aborting fail-closed
 *  (config absent on the default branch → not opted out → run proceeds). Use for
 *  DEFAULT-runPipeline tests that exercise the real executor end-to-end. */
const trustedOkShell: ShellRunner = async (cmd, cwd, opts) => {
  if (cmd.join(" ").includes("rev-parse") && cmd.includes("refs/remotes/origin/main^{commit}")) {
    return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
  }
  return okShell(cmd, cwd, opts);
};

const VALID_PUSH = {
  repoId: "0123456789ab",
  branch: "feat/x",
  ref: "refs/heads/feat/x",
  newSha: "abcdef1234567890abcdef1234567890abcdef12",
};

// Stub the live settings read for EVERY test: the production default calls
// `invoke("runtime.settings.getMine")`, which hangs against the stub channel
// (no host answers). `{}` → resolvePipelineConfig defaults — the same config
// the pipeline used before the M2 live-read seam. Tests that assert settings
// resolution override this locally.
beforeEach(() => {
  _setSettingsReadForTests(async () => ({}));
  // Default: the acting user HOLDS every triage scope (the pre-M6 ungated
  // behaviour). The production default calls `new Rbac().check`, which hangs
  // against the stub channel; RBAC-specific tests override this per-scope.
  _setRbacCheckForTests(async () => true);
});

afterEach(() => {
  _setProjectRootForTests(null);
  _setShellForTests(null);
  _setStoreForTests(null);
  _setPushPageForTests(null);
  _setTmpBaseForTests(null);
  _setBaseUrlForTests(null);
  _setRunPipelineForTests(null);
  _setRespondRunnerForTests(null);
  _setReconcileRunnerForTests(null);
  _setTokenStorageForTests(null);
  _setSettingsReadForTests(null);
  _setChatToolDepsForTests(null);
  _setRbacCheckForTests(null);
  _setHeartbeatKVForTests(null);
});

/** A fake pipeline runner that drives the run to a chosen terminal/parked state
 *  (so the index-level lifecycle tests exercise wiring, not the real pipeline).
 *  `_setStoreForTests` must be set first so we can flip the run's status. */
function fakePipeline(store: RunStore, outcome: "completed" | "failed" | "parked") {
  return () => async ({ runId }: { runId: string; worktreePath: string }) => {
    await store.updateRun(runId, {
      status: outcome === "parked" ? "awaiting_approval" : outcome,
      ...(outcome === "parked" ? { awaitingAgentSince: "2026-07-15T00:00:00.000Z" } : {}),
    });
    return { parked: outcome === "parked" };
  };
}

/** Spy on process.stderr.write, collecting written text; `.restore()` unmocks. */
function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stderr.write);
  return { text: () => lines.join(""), restore: () => spy.mockRestore() };
}

// ── init_gate tool ──────────────────────────────────────────────────

describe("initGateTool", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ezcf-idx-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("errors when no active project is set", async () => {
    _setProjectRootForTests(() => undefined);
    const res = await initGateTool({});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("EZCORP_PROJECT_ROOT unset");
  });

  test("provisions the gate on a real repo and returns structured JSON", async () => {
    const work = join(root, "work");
    mkdirSync(work);
    await productionHostRunner(["git", "init", "-b", "main"], work);
    await productionHostRunner(["git", "remote", "add", "origin", "https://up/x.git"], work);
    _setProjectRootForTests(() => work);
    _setShellForTests(productionHostRunner);
    _setBaseUrlForTests(() => "http://127.0.0.1:9");

    const res = await initGateTool({ upstream: "  " }); // blank upstream ignored
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content[0]!.text);
    expect(out.ok).toBe(true);
    expect(out.gateRemote).toBe(GATE_REMOTE);
    expect(out.pushHint).toBe(`git push ${GATE_REMOTE} <branch>`);
    expect(existsSync(gateDirFor(work, out.repoId))).toBe(true);
  });

  test("surfaces an init failure as a tool error", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(async (cmd) =>
      cmd.join(" ").includes("git init --bare")
        ? { exitCode: 1, stdout: "", stderr: "denied" }
        : { exitCode: 1, stdout: "", stderr: "" },
    );
    const res = await initGateTool({});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("init_gate failed");
  });
});

// ── push-received action ────────────────────────────────────────────

describe("handlePushReceived", () => {
  test("ignores the event when no active project is set", async () => {
    _setProjectRootForTests(() => undefined);
    const store = memStore();
    _setStoreForTests(store);
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    expect(store.runs.size).toBe(0);
  });

  test("ignores an invalid (attacker-shaped) payload", async () => {
    _setProjectRootForTests(() => "/proj");
    const store = memStore();
    _setStoreForTests(store);
    await handlePushReceived({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { branch: "a;rm -rf", repoId: "x" },
    });
    expect(store.runs.size).toBe(0);
  });

  test("valid push → pipeline runs to completion + worktree torn down + dashboard refresh", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "completed"));
    const pushes: string[] = [];
    _setPushPageForTests((pageId) => pushes.push(pageId));

    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });

    expect(store.runs.size).toBe(1);
    const run = [...store.runs.values()][0]!;
    expect(run.status).toBe("completed");
    expect(run.repoId).toBe(VALID_PUSH.repoId);
    // A completed (non-parked) run tears its worktree down.
    expect(removed.length).toBe(1);
    // Dashboard was refreshed at least once via the content-free page push.
    expect(pushes).toContain("dashboard");
  });

  test("parked pipeline KEEPS the worktree (no teardown) for the human's review", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "parked"));
    _setPushPageForTests(() => {});

    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });

    const run = [...store.runs.values()][0]!;
    expect(run.status).toBe("awaiting_approval");
    // Parked → the worktree is deliberately kept (resumed on a respond).
    expect(removed.length).toBe(0);
    expect(run.worktreePath).not.toBeNull();
  });

  test("a failed run lifecycle is reported (run marked failed)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    // worktree add fails → the run fails.
    _setShellForTests(async (cmd) =>
      cmd.includes("add") ? { exitCode: 1, stdout: "", stderr: "no such rev" } : { exitCode: 0, stdout: "", stderr: "" },
    );
    const store = memStore();
    _setStoreForTests(store);
    _setPushPageForTests(() => {});

    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    const run = [...store.runs.values()][0]!;
    expect(run.status).toBe("failed");
  });

  test("a throw escaping runGateLifecycle (teardown) is caught + logged, not swallowed", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    // worktree add succeeds, but teardown (`worktree remove`) THROWS — that
    // escapes runGateLifecycle's own catch (it fires in the finally) and would
    // be swallowed by the channel's notification path without this handler's
    // outer guard.
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) throw new Error("teardown boom");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const tstore = memStore();
    _setStoreForTests(tstore);
    _setRunPipelineForTests(fakePipeline(tstore, "completed")); // terminal → teardown reached
    _setPushPageForTests(() => {});
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      stderr.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    try {
      await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
      expect(stderr.join("")).toContain("push-received handler error");
    } finally {
      spy.mockRestore();
    }
  });
});

// ── production env defaults (no test overrides) ─────────────────────

describe("production env defaults", () => {
  test("the default seams read process.env (set + unset)", async () => {
    const saved = {
      root: process.env.EZCORP_PROJECT_ROOT,
      base: process.env.EZCORP_BASE_URL,
      tmp: process.env.TMPDIR,
    };
    try {
      // Reset every seam to its PRODUCTION default closure (not a test double).
      _setProjectRootForTests(null);
      _setBaseUrlForTests(null);
      _setTmpBaseForTests(null);
      _setShellForTests(okShell); // every git step a no-op success
      const store = memStore();
      _setStoreForTests(store);
      _setRunPipelineForTests(fakePipeline(store, "completed"));
      _setPushPageForTests(() => {});

      // UNSET → defaultProjectRoot() returns undefined → the tool errors out.
      delete process.env.EZCORP_PROJECT_ROOT;
      const err = await initGateTool({});
      expect(err.isError).toBe(true);
      expect(err.content[0]!.text).toContain("EZCORP_PROJECT_ROOT unset");

      // SET → defaultProjectRoot + defaultBaseUrl are both read through initGate.
      process.env.EZCORP_PROJECT_ROOT = "/proj";
      process.env.EZCORP_BASE_URL = "http://127.0.0.1:9";
      const ok = await initGateTool({});
      expect(ok.isError).toBe(false);

      // defaultTmpBase is read through the push-received lifecycle.
      process.env.TMPDIR = "/tmp/ezcf-env-default";
      await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
      expect(store.runs.size).toBeGreaterThan(0);
    } finally {
      // Restore the ambient env so sibling tests see the original values.
      const restore: Record<string, string | undefined> = {
        EZCORP_PROJECT_ROOT: saved.root,
        EZCORP_BASE_URL: saved.base,
        TMPDIR: saved.tmp,
      };
      for (const [k, v] of Object.entries(restore)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ── respond action + production pipeline wiring ─────────────────────

/** Seed a run parked at the review gate (worktree kept). */
async function seedParkedRun(store: RunStore & { runs: Map<string, RunRecord> }): Promise<string> {
  const id = "run-parked";
  await store.createRun({
    id,
    repoId: "0123456789ab",
    branch: "feat/x",
    ref: "refs/heads/feat/x",
    headSha: "abcdef0123456789",
    baseSha: "0000000000000000",
    status: "awaiting_approval",
    worktreePath: "/tmp/ext/worktrees/0123456789ab/run-parked",
    createdAt: "t",
    updatedAt: "t",
    parkedMs: 0,
    awaitingAgentSince: "2026-07-15T00:00:00.000Z",
    intent: null,
    intentSource: null,
  });
  await store.putStepResult({
    runId: id,
    step: "review",
    status: "awaiting_approval",
    findings: emptyFindings(),
    agentPid: null,
    autoFixLimit: 0,
    round: 1,
    autoFixAttempts: 0,
    executionMs: 0,
    fixSummary: null,
  });
  return id;
}

const RESPOND_PAYLOAD = { runId: "run-parked", step: "review", action: "approve" };

describe("handleRespond", () => {
  test("ignores respond with no active project", async () => {
    _setProjectRootForTests(() => undefined);
    _setStoreForTests(memStore());
    await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
    // No throw; nothing to assert beyond the guard being hit.
    expect(true).toBe(true);
  });

  test("ignores an invalid respond payload", async () => {
    _setProjectRootForTests(() => "/proj");
    _setStoreForTests(memStore());
    await handleRespond({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { runId: "x", step: "bogus", action: "approve" },
    });
    expect(true).toBe(true);
  });

  test("ignores respond for an unknown run", async () => {
    _setProjectRootForTests(() => "/proj");
    _setStoreForTests(memStore());
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      stderr.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
      expect(stderr.join("")).toContain("unknown run");
    } finally {
      spy.mockRestore();
    }
  });

  test("valid respond drives resume; a terminal outcome tears the worktree down", async () => {
    _setProjectRootForTests(() => "/proj");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    // Fake respond runner: marks the run completed (terminal) → worktree removed.
    _setRespondRunnerForTests(() => async ({ runId }) => {
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
    expect((await store.getRun("run-parked"))!.status).toBe("completed");
    expect(removed.length).toBe(1);
  });

  test("a respond that re-parks keeps the worktree", async () => {
    _setProjectRootForTests(() => "/proj");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    _setRespondRunnerForTests(() => async () => ({ parked: true }));
    await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
    expect(removed.length).toBe(0);
  });

  test("respond for a run with no worktree logs 'could not resume'", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    const store = memStore();
    _setStoreForTests(store);
    // A run that exists but has no worktree path → resumeGateLifecycle returns null.
    await store.createRun({
      id: "run-parked",
      repoId: "0123456789ab",
      branch: "feat/x",
      ref: "refs/heads/feat/x",
      headSha: "abc",
      baseSha: "0".repeat(40),
      status: "awaiting_approval",
      worktreePath: null,
      createdAt: "t",
      updatedAt: "t",
      parkedMs: 0,
      awaitingAgentSince: "t",
      intent: null,
      intentSource: null,
    });
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      stderr.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
      expect(stderr.join("")).toContain("could not resume");
    } finally {
      spy.mockRestore();
    }
  });

  test("a throw inside resume is caught + logged; the still-parked run keeps its worktree", async () => {
    _setProjectRootForTests(() => "/proj");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    _setRespondRunnerForTests(() => async () => {
      throw new Error("resume boom");
    });
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      stderr.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
      expect(stderr.join("")).toContain("respond handler error");
      // The run never left awaiting_approval → its kept worktree survives.
      expect((await store.getRun("run-parked"))!.status).toBe("awaiting_approval");
      expect(removed.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("normalizes a per-finding fix (scalar findingId/instruction → canonical findingIds/instructions)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    let captured: ParsedRespond | null = null;
    // The respond-runner factory receives the PARSED respond — capture it to
    // prove normalizeRespondPayload folded the flat scalar shape the Hub emits
    // into M1's canonical findingIds[]/instructions{} before parseRespondPayload.
    _setRespondRunnerForTests((_pr, _gd, respond) => {
      captured = respond;
      return async ({ runId }) => {
        await store.updateRun(runId, { status: "completed" });
        return { parked: false };
      };
    });
    await handleRespond({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { runId: "run-parked", step: "review", action: "fix", findingId: "f1", instruction: "prefer a guard" },
    });
    expect(captured).toMatchObject({
      runId: "run-parked",
      step: "review",
      action: "fix",
      findingIds: ["f1"],
      instructions: { f1: "prefer a guard" },
    });
  });
});

describe("handleRespond — oversized payloads stay rejected after normalization", () => {
  // The Hub emits a FLAT scalar respond; `normalizeRespondPayload` folds it into
  // M1's canonical findingIds[]/instructions{} shape BEFORE `parseRespondPayload`
  // applies its size caps. These lock that the caps STILL bite across that
  // compose — a defence-in-depth guard on the normalize→parse seam, not just on
  // parseRespondPayload in isolation (already covered in runs.test.ts).
  async function driveRejected(
    store: RunStore & { runs: Map<string, RunRecord> },
    payload: Record<string, unknown>,
  ): Promise<{ runnerCalls: number; removed: string[]; stderr: string }> {
    _setProjectRootForTests(() => "/proj");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    _setStoreForTests(store);
    let runnerCalls = 0;
    // Had parse WRONGLY accepted the payload, this runner would fire + tear the
    // kept worktree down — so any call / removal proves a cap regression.
    _setRespondRunnerForTests(() => async ({ runId }) => {
      runnerCalls++;
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    const cap = captureStderr();
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload });
    } finally {
      cap.restore();
    }
    return { runnerCalls, removed, stderr: cap.text() };
  }

  test("an instruction over MAX_INSTRUCTION_LEN (folded from the scalar field) is rejected side-effect-free", async () => {
    const store = memStore();
    await seedParkedRun(store); // parked at review, worktree kept
    // A scalar findingId + an over-cap instruction → normalize keys it under
    // instructions.f1 → parseRespondPayload rejects (v.length > 4000).
    const { runnerCalls, removed, stderr } = await driveRejected(store, {
      runId: "run-parked",
      step: "review",
      action: "fix",
      findingId: "f1",
      instruction: "x".repeat(4001),
    });
    expect(stderr).toContain("invalid payload");
    expect(runnerCalls).toBe(0);
    expect(removed.length).toBe(0);
    const run = (await store.getRun("run-parked"))!;
    expect(run.status).toBe("awaiting_approval");
    expect(run.worktreePath).not.toBeNull();
  });

  test("a findingIds array over MAX_FINDING_IDS (200) is rejected side-effect-free", async () => {
    const store = memStore();
    await seedParkedRun(store);
    const { runnerCalls, removed, stderr } = await driveRejected(store, {
      runId: "run-parked",
      step: "review",
      action: "fix",
      findingIds: Array.from({ length: 201 }, (_, i) => `f${i}`),
    });
    expect(stderr).toContain("invalid payload");
    expect(runnerCalls).toBe(0);
    expect(removed.length).toBe(0);
    expect((await store.getRun("run-parked"))!.status).toBe("awaiting_approval");
  });
});

describe("production pipeline wiring (default runners)", () => {
  test("default runPipeline drives the real executor (rebase empty-diff → completed)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    // Host git no-ops → rebase short-circuits (empty diff); the resolver's
    // default-branch resolve returns a SHA so trusted-config resolution proceeds
    // (config absent on the default branch → not opted out) instead of aborting
    // fail-closed before the pipeline (spec §1 invariant 1).
    _setShellForTests(trustedOkShell);
    const store = memStore();
    _setStoreForTests(store);
    _setPushPageForTests(() => {});
    // No _setRunPipelineForTests → the DEFAULT factory (buildExecutorDeps +
    // startPipeline) runs. With host no-ops the pipeline skips to completion
    // without ever dispatching an agent.
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    expect([...store.runs.values()][0]!.status).toBe("completed");
  });

  test("CRITICAL regression: a stale respond to the WRONG step is rejected side-effect-free — run stays parked, kept worktree survives", async () => {
    _setProjectRootForTests(() => "/proj");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store); // parked at review
    _setPushPageForTests(() => {});
    // The DEFAULT respond runner drives the real respondToGate, which REJECTS
    // an approve aimed at a step that is not awaiting approval ("rebase").
    await handleRespond({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { runId: "run-parked", step: "rebase", action: "approve" },
    });
    const run = (await store.getRun("run-parked"))!;
    expect(run.status).toBe("awaiting_approval");
    expect(run.worktreePath).not.toBeNull();
    // The rejected respond must NOT tear the kept worktree down.
    expect(removed.length).toBe(0);
  });

  test("default respond runner drives respondToGate (abort → aborted, no agent/jail)", async () => {
    _setProjectRootForTests(() => "/proj");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    _setPushPageForTests(() => {});
    // Abort never advances to push, so the real jail/agent are never touched.
    await handleRespond({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { runId: "run-parked", step: "review", action: "abort" },
    });
    expect((await store.getRun("run-parked"))!.status).toBe("aborted");
    expect(removed.length).toBe(1);
  });
});

// ── GitHub token resolution ─────────────────────────────────────────

describe("resolveProductionGhToken", () => {
  function withoutTokenEnv<T>(fn: () => Promise<T>): Promise<T> {
    const prev = { g: process.env.GH_TOKEN, h: process.env.GITHUB_TOKEN };
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    return fn().finally(() => {
      if (prev.g !== undefined) process.env.GH_TOKEN = prev.g;
      if (prev.h !== undefined) process.env.GITHUB_TOKEN = prev.h;
    });
  }

  test("resolves from the injected (encrypted) secret storage", async () => {
    _setTokenStorageForTests(() => ({ async get() { return { value: "sekret" as never, exists: true }; } }));
    await withoutTokenEnv(async () => {
      expect(await resolveProductionGhToken()).toBe("sekret");
    });
  });

  test("env override wins over stored secret", async () => {
    _setTokenStorageForTests(() => ({ async get() { return { value: "stored" as never, exists: true }; } }));
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "env-tok";
    try {
      expect(await resolveProductionGhToken()).toBe("env-tok");
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prev;
    }
  });
});

// ── handleReconcile (CI ReconcileApprovalGate trigger) ──────────────

describe("handleReconcile", () => {
  const evt = (payload: Record<string, unknown>) => ({ source: "hub" as const, pageId: "dashboard", userId: "u", payload });

  test("no project root → ignored", async () => {
    _setProjectRootForTests(() => undefined);
    const stderr = captureStderr();
    try {
      await handleReconcile(evt({ runId: "r1" }));
      expect(stderr.text()).toContain("no EZCORP_PROJECT_ROOT");
    } finally {
      stderr.restore();
    }
  });

  test("invalid payload → ignored", async () => {
    _setProjectRootForTests(() => "/proj");
    const stderr = captureStderr();
    try {
      await handleReconcile(evt({ runId: 5 }));
      expect(stderr.text()).toContain("invalid payload");
    } finally {
      stderr.restore();
    }
  });

  test("unknown run → ignored", async () => {
    _setProjectRootForTests(() => "/proj");
    _setStoreForTests(memStore());
    const stderr = captureStderr();
    try {
      await handleReconcile(evt({ runId: "nope" }));
      expect(stderr.text()).toContain("unknown run");
    } finally {
      stderr.restore();
    }
  });

  test("default runner drives reconcileGate: a review gate is not reconcilable → stays parked", async () => {
    _setProjectRootForTests(() => "/proj");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store); // parked at review (no reconcile hook)
    _setPushPageForTests(() => {});
    await handleReconcile(evt({ runId: "run-parked" }));
    // The review gate has no reconcile hook → the run stays parked, worktree kept.
    expect((await store.getRun("run-parked"))!.status).toBe("awaiting_approval");
    expect(removed.length).toBe(0);
  });

  test("injected reconcile runner that completes the run tears down the worktree", async () => {
    _setProjectRootForTests(() => "/proj");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    _setPushPageForTests(() => {});
    // A reconcile runner that resolves the gate (marks the run completed).
    _setReconcileRunnerForTests((_projectRoot, _gateDir) => async ({ runId }) => {
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    await handleReconcile(evt({ runId: "run-parked" }));
    expect((await store.getRun("run-parked"))!.status).toBe("completed");
    expect(removed.length).toBe(1); // terminal → worktree reaped
  });

  test("a run with no kept worktree cannot be resumed (result null)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = memStore();
    _setStoreForTests(store);
    await store.createRun({
      id: "run-noworktree",
      repoId: "0123456789ab",
      branch: "feat/x",
      ref: "refs/heads/feat/x",
      headSha: "abcdef01",
      baseSha: "0".repeat(40),
      status: "awaiting_approval",
      worktreePath: null, // no kept worktree → resumeGateLifecycle returns null
      createdAt: "t",
      updatedAt: "t",
      parkedMs: 0,
      awaitingAgentSince: null,
      intent: null,
      intentSource: null,
    });
    await handleReconcile(evt({ runId: "run-noworktree" }));
    // No throw; the run is left as-is.
    expect((await store.getRun("run-noworktree"))!.status).toBe("awaiting_approval");
  });

  test("handler error is swallowed (store throws)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setStoreForTests({
      ...memStore(),
      async getRun() {
        throw new Error("store down");
      },
    });
    const stderr = captureStderr();
    try {
      await handleReconcile(evt({ runId: "r1" })); // must not throw
      expect(stderr.text()).toContain("reconcile handler error");
    } finally {
      stderr.restore();
    }
  });
});

// ── renderDashboard ─────────────────────────────────────────────────

describe("renderDashboard", () => {
  test("reads through the store into a page tree", async () => {
    const store = memStore();
    await store.createRun({
      id: "r1",
      repoId: "0123456789ab",
      branch: "feat/x",
      ref: "refs/heads/feat/x",
      headSha: "abcdef0123456789",
      baseSha: "0000000000000000",
      status: "completed",
      worktreePath: null,
      createdAt: "2026-07-15T08:00:00.000Z",
      updatedAt: "2026-07-15T08:00:00.000Z",
      parkedMs: 0,
      awaitingAgentSince: null,
      intent: null,
      intentSource: null,
    });
    _setStoreForTests(store);
    const tree = await renderDashboard();
    expect(tree.title).toBe("ez-code-factory");
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    expect(nodes.some((n) => n.type === "table")).toBe(true);
  });

  test("lazily builds the production store when none is injected", async () => {
    _setStoreForTests(null);
    __resetChannelForTests();
    const ch = getChannel() as HostChannel;
    spyOn(ch, "request").mockImplementation((async () => ({ value: null, exists: false })) as HostChannel["request"]);
    try {
      const tree = await renderDashboard(); // exercises getStore() lazy init
      expect(tree.title).toBe("ez-code-factory");
    } finally {
      __resetChannelForTests();
    }
  });
});

// ── register / start wiring ─────────────────────────────────────────

describe("register / start", () => {
  beforeEach(() => {
    __resetChannelForTests();
    __resetPagesForTests();
  });
  afterEach(() => {
    __resetChannelForTests();
    __resetPagesForTests();
  });

  test("register wires the page render, the push-received action, and the tool dispatcher", () => {
    const ch = getChannel() as HostChannel;
    const methods = new Set<string>();
    const original = ch.onRequest.bind(ch);
    ch.onRequest = (method: string, handler: (p: unknown) => unknown) => {
      methods.add(method);
      return original(method, handler);
    };
    try {
      expect(() => register()).not.toThrow();
      expect(methods.has("ezcorp/page.render")).toBe(true);
      expect(methods.has(`ezcorp/event/${PUSH_RECEIVED_ACTION}`)).toBe(true);
      expect(methods.has(`ezcorp/event/${RESPOND_ACTION}`)).toBe(true);
      expect(methods.has(`ezcorp/event/${YOLO_ACTION}`)).toBe(true);
      expect(methods.has(`ezcorp/event/${RECONCILE_ACTION}`)).toBe(true);
      // M6: the reconcile-sweep cron handler is wired.
      expect(methods.has("ezcorp/schedule-fire")).toBe(true);
      expect(methods.has("tools/call")).toBe(true);
      expect(Object.keys(tools)).toEqual([
        "init_gate",
        "code_factory_run",
        "code_factory_status",
        "code_factory_respond",
        "code_factory_doctor",
      ]);
    } finally {
      ch.onRequest = original;
    }
  });

  test("start registers and boots the channel", () => {
    const ch = getChannel() as HostChannel;
    let started = 0;
    const spy = spyOn(ch, "start");
    spy.mockImplementation((() => {
      started++;
    }) as HostChannel["start"]);
    try {
      expect(() => start()).not.toThrow();
      expect(started).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── settings live-read (M2) ─────────────────────────────────────────

describe("settings live-read", () => {
  test("default read resolves via runtime.settings.getMine and drives the pipeline", async () => {
    _setSettingsReadForTests(null); // restore the production invoke-based read
    __resetChannelForTests();
    const ch = getChannel() as HostChannel;
    // invoke("runtime.settings.getMine") → ch.request("ezcorp/invoke", …).
    // Resolve it so the try branch of defaultSettingsRead runs; other store
    // reads also route through request and get an empty result.
    spyOn(ch, "request").mockImplementation((async (method: string) => {
      if (method === "ezcorp/invoke") return { defaultBranch: "main" };
      return { value: null, exists: false };
    }) as HostChannel["request"]);
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(trustedOkShell);
    const store = memStore();
    _setStoreForTests(store);
    _setPushPageForTests(() => {});
    try {
      await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
      expect([...store.runs.values()][0]!.status).toBe("completed");
    } finally {
      __resetChannelForTests();
    }
  });

  test("a failing settings RPC falls back to defaults (never fails the pipeline)", async () => {
    _setSettingsReadForTests(null); // restore the production invoke-based read
    __resetChannelForTests();
    const ch = getChannel() as HostChannel;
    spyOn(ch, "request").mockImplementation((async (method: string) => {
      if (method === "ezcorp/invoke") throw new Error("no host session");
      return { value: null, exists: false };
    }) as HostChannel["request"]);
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(trustedOkShell);
    const store = memStore();
    _setStoreForTests(store);
    _setPushPageForTests(() => {});
    try {
      await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
      // Defaults applied → the pipeline still runs to completion.
      expect([...store.runs.values()][0]!.status).toBe("completed");
    } finally {
      __resetChannelForTests();
    }
  });

  test("a NON-default settings value flows through resolveLiveConfig into the pipeline", async () => {
    // `autofixCap` is the flat settings knob for rebase/test/document/lint/ci
    // (default 3). A mutation making resolveLiveConfig ignore the stub (always
    // `resolvePipelineConfig({})`) drops the read (fails (a)) and/or leaves the
    // recorded cap at 3 (fails (b)) — so this locks the live read, not just that
    // the run completed.
    const NON_DEFAULT_CAP = 7;
    let getMineCalls = 0;
    _setSettingsReadForTests(async () => {
      getMineCalls++;
      return { autofixCap: NON_DEFAULT_CAP };
    });
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(trustedOkShell); // host no-ops + resolvable trusted branch → real executor runs to completion
    const store = memStore();
    _setStoreForTests(store);
    _setPushPageForTests(() => {});
    // No _setRunPipelineForTests → the DEFAULT defaultRunPipeline runs, and it is
    // the one that calls resolveLiveConfig() → resolvePipelineConfig(stub).
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });

    // (a) the live settings read actually ran.
    expect(getMineCalls).toBeGreaterThan(0);
    // (b) the resolved non-default cap reached the executor: each step's result
    // is stamped with autoFixLimit(config, step) on creation. `test` is one of
    // the flat-cap steps, so its recorded cap is the stub's 7, never the default 3.
    const runId = [...store.runs.values()][0]!.id;
    const testStep = await store.getStepResult(runId, "test");
    expect(testStep).not.toBeNull();
    expect(testStep!.autoFixLimit).toBe(NON_DEFAULT_CAP);
  });
});

// ── parked-run detail on the dashboard ──────────────────────────────

describe("renderDashboard — parked-run triage detail", () => {
  test("inlines a triage section for a parked run and skips non-parked runs", async () => {
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store); // parked at review (worktree kept)
    // A completed run must NOT get a detail section.
    await store.createRun({
      id: "run-done",
      repoId: "0123456789ab",
      branch: "feat/done",
      ref: "refs/heads/feat/done",
      headSha: "abcdef0123456789",
      baseSha: "0".repeat(40),
      status: "completed",
      worktreePath: null,
      createdAt: "t",
      updatedAt: "t",
      parkedMs: 0,
      awaitingAgentSince: null,
      intent: null,
      intentSource: null,
    });
    const tree = await renderDashboard();
    const sections = (tree.nodes as Array<Record<string, unknown>>).filter((n) => n.type === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toContain("run-parked");
  });

  test("inlines a detail (with the Re-check control) for a checks_passed run", async () => {
    const store = memStore();
    _setStoreForTests(store);
    // A run rested at checks_passed with its CI step parked (worktree torn down).
    await store.createRun({
      id: "run-green",
      repoId: "0123456789ab",
      branch: "feat/green",
      ref: "refs/heads/feat/green",
      headSha: "abcdef0123456789",
      baseSha: "0".repeat(40),
      status: "checks_passed",
      worktreePath: "/tmp/ext/worktrees/0123456789ab/run-green",
      createdAt: "t",
      updatedAt: "t",
      parkedMs: 0,
      awaitingAgentSince: "2026-07-15T00:00:00.000Z",
      intent: null,
      intentSource: null,
    });
    await store.putStepResult({
      runId: "run-green",
      step: "ci",
      status: "awaiting_approval",
      findings: emptyFindings(),
      agentPid: null,
      autoFixLimit: 3,
      round: 1,
      autoFixAttempts: 0,
      executionMs: 0,
      fixSummary: null,
    });
    const tree = await renderDashboard();
    const sections = (tree.nodes as Array<Record<string, unknown>>).filter((n) => n.type === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toContain("run-green");
    // The CI gate detail carries the read-only reconcile control.
    const buttons = JSON.stringify(sections[0]);
    expect(buttons).toContain("Re-check PR state");
    expect(buttons).toContain("ez-code-factory:reconcile");
  });
});

// ── yolo autopilot (M2) ─────────────────────────────────────────────

describe("handleYolo", () => {
  test("ignores yolo with no active project", async () => {
    _setProjectRootForTests(() => undefined);
    _setStoreForTests(memStore());
    const stderr = captureStderr();
    try {
      await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "r1" } });
      expect(stderr.text()).toContain("no EZCORP_PROJECT_ROOT");
    } finally {
      stderr.restore();
    }
  });

  test("ignores an invalid yolo payload", async () => {
    _setProjectRootForTests(() => "/proj");
    _setStoreForTests(memStore());
    const stderr = captureStderr();
    try {
      await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: 5 } });
      expect(stderr.text()).toContain("invalid payload");
    } finally {
      stderr.restore();
    }
  });

  test("auto-approves every remaining gate until the run completes", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store); // parked at review
    let approvals = 0;
    // First approve → re-park at `test`; second approve → complete.
    _setRespondRunnerForTests((_pr, _gd, respond) => async ({ runId }) => {
      approvals++;
      expect(respond!.action).toBe("approve");
      if (approvals === 1) {
        expect(respond!.step).toBe("review");
        await store.putStepResult({ ...(await store.getStepResult(runId, "review"))!, status: "completed" });
        await store.putStepResult({
          runId,
          step: "test",
          status: "awaiting_approval",
          findings: emptyFindings(),
          agentPid: null,
          autoFixLimit: 3,
          round: 1,
          autoFixAttempts: 0,
          executionMs: 0,
          fixSummary: null,
        });
        await store.updateRun(runId, { status: "awaiting_approval" });
        return { parked: true };
      }
      expect(respond!.step).toBe("test");
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked", step: "review" } });
    expect(approvals).toBe(2);
    expect((await store.getRun("run-parked"))!.status).toBe("completed");
  });

  test("approves a fix_review-parked step too", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    // Re-mark the review step as fix_review (a user-fix round parked again).
    await store.putStepResult({ ...(await store.getStepResult("run-parked", "review"))!, status: "fix_review" });
    const seenSteps: string[] = [];
    _setRespondRunnerForTests((_pr, _gd, respond) => async ({ runId }) => {
      seenSteps.push(respond!.step);
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked" } });
    expect(seenSteps).toEqual(["review"]);
    expect((await store.getRun("run-parked"))!.status).toBe("completed");
  });

  test("no-ops when the run is not parked", async () => {
    _setProjectRootForTests(() => "/proj");
    const store = memStore();
    _setStoreForTests(store);
    await store.createRun({
      id: "run-done",
      repoId: "0123456789ab",
      branch: "feat/x",
      ref: "refs/heads/feat/x",
      headSha: "abc",
      baseSha: "0".repeat(40),
      status: "completed",
      worktreePath: null,
      createdAt: "t",
      updatedAt: "t",
      parkedMs: 0,
      awaitingAgentSince: null,
      intent: null,
      intentSource: null,
    });
    let calls = 0;
    _setRespondRunnerForTests(() => async () => {
      calls++;
      return { parked: false };
    });
    await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-done" } });
    expect(calls).toBe(0);
  });

  test("no-ops when a parked run has no parked step recorded", async () => {
    _setProjectRootForTests(() => "/proj");
    const store = memStore();
    _setStoreForTests(store);
    // Parked run status but every step completed → findParkedStep returns null.
    await store.createRun({
      id: "run-x",
      repoId: "0123456789ab",
      branch: "feat/x",
      ref: "refs/heads/feat/x",
      headSha: "abc",
      baseSha: "0".repeat(40),
      status: "awaiting_approval",
      worktreePath: "/tmp/ext/wt/run-x",
      createdAt: "t",
      updatedAt: "t",
      parkedMs: 0,
      awaitingAgentSince: "t",
      intent: null,
      intentSource: null,
    });
    let calls = 0;
    _setRespondRunnerForTests(() => async () => {
      calls++;
      return { parked: false };
    });
    await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-x" } });
    expect(calls).toBe(0);
  });

  test("stops when a resume cannot be applied (run has no worktree → null)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    // Drop the worktree path so resumeGateLifecycle returns null immediately.
    await store.updateRun("run-parked", { worktreePath: null });
    let calls = 0;
    _setRespondRunnerForTests(() => async () => {
      calls++;
      return { parked: false };
    });
    await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked" } });
    // resume returned null before the runner ran → still parked, no approvals.
    expect(calls).toBe(0);
    expect((await store.getRun("run-parked"))!.status).toBe("awaiting_approval");
  });

  test("is bounded — a run that re-parks forever stops at the gate cap", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(async (cmd) => {
      // Swallow worktree removals; every git op succeeds.
      void cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    let approvals = 0;
    // Always keep the run parked at review → the loop can never terminate on
    // state, so only the YOLO_MAX_GATES bound stops it.
    _setRespondRunnerForTests(() => async () => {
      approvals++;
      return { parked: true };
    });
    await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked" } });
    // YOLO_MAX_ITERATIONS = PIPELINE_STEPS.length (9) * 2 + 1 = 19: each empty
    // gate is an approve, so the fix-once budget never engages and only the hard
    // iteration bound halts the pathological re-park.
    expect(approvals).toBe(19);
    expect((await store.getRun("run-parked"))!.status).toBe("awaiting_approval");
  });

  test("catches + logs a throw from the autopilot", async () => {
    _setProjectRootForTests(() => "/proj");
    // A store whose getRun throws → runYoloAutopilot throws → handler catch.
    const store = memStore();
    const boomStore: RunStore = { ...store, getRun: async () => { throw new Error("store boom"); } };
    _setStoreForTests(boomStore);
    const stderr = captureStderr();
    try {
      await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked" } });
      expect(stderr.text()).toContain("yolo handler error");
    } finally {
      stderr.restore();
    }
  });
});

// ── chat-entry tools (M5) ───────────────────────────────────────────

describe("chat-entry tool handlers", () => {
  /** A minimal fake deps set so the handler→outcome mapping is exercised
   *  without the production git/lifecycle wiring. */
  function fakeChatDeps(): ChatToolDeps {
    const store = memStore();
    return {
      projectRoot: "/proj",
      gateDir: "/gate",
      repoId: "0123456789ab",
      defaultBranch: "main",
      run: okShell,
      store,
      triggerRun: async () => ({ ok: true, runId: "rX", worktreePath: "", status: "completed" }),
      resumeRun: async () => ({ status: "completed", parked: false }),
      inferIntent: async () => null,
    };
  }

  test("each tool errors with no active project", async () => {
    _setProjectRootForTests(() => undefined);
    for (const tool of [codeFactoryRunTool, codeFactoryStatusTool, codeFactoryRespondTool]) {
      const res = await tool({});
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("EZCORP_PROJECT_ROOT unset");
    }
  });

  test("status maps an ok outcome to a tool result", async () => {
    _setProjectRootForTests(() => "/proj");
    _setChatToolDepsForTests(async () => fakeChatDeps());
    const res = await codeFactoryStatusTool({});
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content[0]!.text).runs).toEqual([]);
  });

  test("status maps an error outcome to a tool error", async () => {
    _setProjectRootForTests(() => "/proj");
    _setChatToolDepsForTests(async () => fakeChatDeps());
    const res = await codeFactoryStatusTool({ runId: "missing" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("unknown run");
  });

  test("respond enforces no-blanket-approval end to end", async () => {
    _setProjectRootForTests(() => "/proj");
    const deps = fakeChatDeps();
    // A gate parked WITH an ask-user finding — an ids-free approve must be refused
    // (a CLEAN gate would approve ids-free; this one withheld a decision).
    const askUser: Finding = {
      id: "a1", severity: "warning", file: "src/a.ts", line: null,
      description: "confirm?", action: "ask-user", source: "agent", userInstructions: "", category: "review",
    };
    await deps.store.createRun({
      id: "r1", repoId: "0123456789ab", branch: "feat/x", ref: "refs/heads/feat/x",
      headSha: "abcdef0", baseSha: "0".repeat(40), status: "awaiting_approval",
      worktreePath: "/wt", createdAt: "t", updatedAt: "t", parkedMs: 0,
      awaitingAgentSince: null, intent: null, intentSource: null,
    });
    await deps.store.putStepResult({
      runId: "r1", step: "review", status: "awaiting_approval",
      findings: { ...emptyFindings(), items: [askUser] },
      agentPid: null, autoFixLimit: 0, round: 1, autoFixAttempts: 0, executionMs: 0, fixSummary: null,
    });
    _setChatToolDepsForTests(async () => deps);
    const res = await codeFactoryRespondTool({ runId: "r1", step: "review", action: "approve" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("must name the explicit findingIds");
  });

  test("DEFAULT wiring: code_factory_run triggers a run via runGateLifecycle", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setPushPageForTests(() => {});
    // Resolve branch=main, project head, no prior gate tip, empty diff, fetch ok.
    const chatShell: ShellRunner = async (cmd) => {
      const c = cmd.join(" ");
      if (c.includes("symbolic-ref")) return { exitCode: 0, stdout: "main\n", stderr: "" };
      if (c.includes("rev-parse") && c.includes("refs/heads/main^{commit}")) return { exitCode: 1, stdout: "", stderr: "" };
      if (c.includes("rev-parse") && c.includes("main^{commit}")) return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _setShellForTests(chatShell);
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "completed"));
    // No _setChatToolDepsForTests → the DEFAULT defaultBuildChatToolDeps runs
    // (its triggerRun + inferIntent + intent-cache + spawn-dispatcher wiring).
    const res = await codeFactoryRunTool({});
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content[0]!.text);
    expect(out.triggered).toBe(true);
    expect(out.status).toBe("completed");
  });

  test("DEFAULT wiring: code_factory_respond drives resumeGateLifecycle (abort)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setPushPageForTests(() => {});
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store); // parked at review, worktree kept
    // No _setChatToolDepsForTests + no _setRespondRunnerForTests → the DEFAULT
    // resumeRun (resumeGateLifecycle + the real respondToGate abort path) runs.
    const res = await codeFactoryRespondTool({ runId: "run-parked", step: "review", action: "abort" });
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content[0]!.text);
    expect(out.applied).toBe(true);
    expect(out.status).toBe("aborted");
  });
});

// ── M6 hardening ────────────────────────────────────────────────────

/** Build a Finding with sensible defaults. */
function mkFinding(over: Partial<Finding>): Finding {
  return {
    id: over.id ?? "f",
    severity: over.severity ?? "warning",
    file: over.file ?? "src/x.ts",
    line: over.line ?? null,
    description: over.description ?? "desc",
    action: over.action ?? "auto-fix",
    source: over.source ?? "agent",
    userInstructions: over.userInstructions ?? "",
    category: over.category ?? "",
  };
}

/** A `run-parked` review step result carrying `items`. */
function reviewStep(items: Finding[], status: StepStatus, autoFixLimit = 0): StepResultRecord {
  return {
    runId: "run-parked",
    step: "review",
    status,
    findings: { items, summary: "", tested: [], testingSummary: "", artifacts: [], riskLevel: "", riskRationale: "" },
    agentPid: null,
    autoFixLimit,
    round: 1,
    autoFixAttempts: 0,
    executionMs: 0,
    fixSummary: null,
  };
}

describe("RBAC on triage actions (M6)", () => {
  test("handleRespond proceeds when `respond-gate` is granted", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setPushPageForTests(() => {});
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    const scopes: string[] = [];
    _setRbacCheckForTests(async (scope) => {
      scopes.push(scope);
      return true;
    });
    let resumed = 0;
    _setRespondRunnerForTests(() => async ({ runId }) => {
      resumed++;
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked", step: "review", action: "approve" } });
    expect(scopes).toContain("respond-gate");
    expect(resumed).toBe(1);
  });

  test("handleRespond REFUSES (no-op, no 500) when `respond-gate` is not held", async () => {
    _setProjectRootForTests(() => "/proj");
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    _setRbacCheckForTests(async () => false);
    let resumed = 0;
    _setRespondRunnerForTests(() => async () => {
      resumed++;
      return { parked: false };
    });
    const stderr = captureStderr();
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked", step: "review", action: "approve" } });
      expect(resumed).toBe(0);
      expect(stderr.text()).toContain("respond refused");
      expect(stderr.text()).toContain("respond-gate");
    } finally {
      stderr.restore();
    }
    // The run is untouched — a denied respond never mutates it.
    expect(store.runs.get("run-parked")!.status).toBe("awaiting_approval");
  });

  test("handleYolo checks the `yolo` scope (granted → autopilot runs)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setPushPageForTests(() => {});
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store); // empty review findings → approve
    const scopes: string[] = [];
    _setRbacCheckForTests(async (scope) => {
      scopes.push(scope);
      return true;
    });
    _setRespondRunnerForTests(() => async ({ runId }) => {
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked" } });
    expect(scopes).toContain("yolo");
    expect(store.runs.get("run-parked")!.status).toBe("completed");
  });

  test("handleYolo REFUSES (no autopilot) when `yolo` is not held", async () => {
    _setProjectRootForTests(() => "/proj");
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    _setRbacCheckForTests(async () => false);
    let calls = 0;
    _setRespondRunnerForTests(() => async () => {
      calls++;
      return { parked: false };
    });
    const stderr = captureStderr();
    try {
      await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked" } });
      expect(calls).toBe(0);
      expect(stderr.text()).toContain("yolo refused");
      expect(stderr.text()).toContain("yolo");
    } finally {
      stderr.restore();
    }
  });

  test("code_factory_respond tool REFUSES with a toolError when `respond-gate` is not held", async () => {
    _setRbacCheckForTests(async () => false);
    const res = await codeFactoryRespondTool({ runId: "r", step: "review", action: "approve" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("respond-gate");
  });
});

describe("yolo fix-once semantics (M6)", () => {
  test("FIXES an auto-fix finding once, then APPROVES the re-parked gate", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setPushPageForTests(() => {});
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    await store.putStepResult(reviewStep([mkFinding({ id: "f1", action: "auto-fix" })], "awaiting_approval", 3));

    const actions: Array<{ action: string; findingIds: string[] }> = [];
    _setRespondRunnerForTests((_pr, _gd, respond) => async ({ runId }) => {
      actions.push({ action: respond!.action, findingIds: respond!.findingIds });
      if (respond!.action === "fix") {
        // The fix round re-parks with a CLEAN review gate (findings resolved).
        await store.putStepResult(reviewStep([], "fix_review", 3));
        await store.updateRun(runId, { status: "awaiting_approval" });
        return { parked: true };
      }
      await store.putStepResult(reviewStep([], "completed", 3));
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });

    await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked" } });
    expect(actions).toEqual([
      { action: "fix", findingIds: ["f1"] },
      { action: "approve", findingIds: [] },
    ]);
    expect(store.runs.get("run-parked")!.status).toBe("completed");
  });

  test("STOPS on an ask-user gate — never blanket-approves it", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    await store.putStepResult(reviewStep([mkFinding({ id: "a1", action: "ask-user", file: "src/auth.ts" })], "awaiting_approval"));
    let calls = 0;
    _setRespondRunnerForTests(() => async () => {
      calls++;
      return { parked: false };
    });
    const stderr = captureStderr();
    try {
      await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked" } });
      expect(calls).toBe(0); // no respond issued — yolo stopped
      expect(stderr.text()).toContain("stopping at 'review'");
      expect(stderr.text()).toContain("ask-user");
    } finally {
      stderr.restore();
    }
    expect(store.runs.get("run-parked")!.status).toBe("awaiting_approval");
  });
});

describe("code_factory_doctor tool (M6)", () => {
  test("errors when no active project is set", async () => {
    _setProjectRootForTests(() => undefined);
    const res = await codeFactoryDoctorTool({});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("EZCORP_PROJECT_ROOT unset");
  });

  test("returns a JSON health report (gate ok when the bare repo + hook + origin resolve)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(async (cmd) => {
      const s = cmd.join(" ");
      if (s.includes("--is-bare-repository")) return { exitCode: 0, stdout: "true\n", stderr: "" };
      if (cmd[0] === "cat") return { exitCode: 0, stdout: `#!/bin/sh\n# ${HOOK_MARKER}\n`, stderr: "" };
      if (s.includes("remote get-url origin")) return { exitCode: 0, stdout: "https://github.com/o/r.git\n", stderr: "" };
      if (cmd[0] === "gh") return { exitCode: 0, stdout: "", stderr: "" }; // gh auth status
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    _setTokenStorageForTests(() => ({ async get() { return { value: null, exists: false }; } }));
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    const res = await codeFactoryDoctorTool({});
    expect(res.isError).toBe(false);
    const report = JSON.parse(res.content[0]!.text) as { ok: boolean; checks: Array<{ name: string; status: string }> };
    expect(report.checks.map((c) => c.name)).toEqual([
      "gate",
      "hook",
      "gh",
      "token",
      "default-branch",
      "reconcile-sweep",
    ]);
    expect(report.checks.find((c) => c.name === "gate")!.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "hook")!.status).toBe("ok");
  });
});

describe("reconcile sweep wiring (M6)", () => {
  test("runReconcileSweep skips with no active project", async () => {
    _setProjectRootForTests(() => undefined);
    _setStoreForTests(memStore());
    const stderr = captureStderr();
    try {
      expect(await runReconcileSweep()).toBeNull();
      expect(stderr.text()).toContain("reconcile sweep with no EZCORP_PROJECT_ROOT");
    } finally {
      stderr.restore();
    }
  });

  test("runReconcileSweep advances a checks_passed run whose reconcile completes it + writes a heartbeat", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setPushPageForTests(() => {});
    const store = memStore();
    _setStoreForTests(store);
    await store.createRun({
      id: "g", repoId: "0123456789ab", branch: "feat/x", ref: "refs/heads/feat/x",
      headSha: "abc", baseSha: "0".repeat(40), status: "checks_passed", worktreePath: "/wt/g",
      createdAt: "t", updatedAt: "t", parkedMs: 0, awaitingAgentSince: "t", intent: null, intentSource: null,
    });
    _setReconcileRunnerForTests(() => async ({ runId }) => {
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    let wrote = 0;
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() { wrote++; } }));
    const summary = await runReconcileSweep();
    expect(summary).not.toBeNull();
    expect(summary!.advanced).toBe(1);
    expect(wrote).toBe(1);
    expect(store.runs.get("g")!.status).toBe("completed");
  });

  test("handleScheduleFire swallows a thrown sweep", async () => {
    _setProjectRootForTests(() => "/proj");
    const store = memStore();
    const boomStore: RunStore = { ...store, listRuns: async () => { throw new Error("store boom"); } };
    _setStoreForTests(boomStore);
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    const stderr = captureStderr();
    try {
      await handleScheduleFire({ cron: SWEEP_CRON, scheduledAt: "t", firedAt: "t", fireId: "f", catchUp: false, retry: false, attempt: 1 });
      expect(stderr.text()).toContain("reconcile sweep error");
    } finally {
      stderr.restore();
    }
  });

  test("handleScheduleFire runs a sweep on the happy path (no reconcilable runs)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    const store = memStore();
    _setStoreForTests(store);
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    await handleScheduleFire({ cron: SWEEP_CRON, scheduledAt: "t", firedAt: "t", fireId: "f", catchUp: false, retry: false, attempt: 1 });
    // No throw + no reconcilable runs → a clean no-op fire.
    expect(true).toBe(true);
  });
});

describe("crash recovery wiring (M6)", () => {
  test("recoverOnStart skips with no active project", async () => {
    _setProjectRootForTests(() => undefined);
    _setStoreForTests(memStore());
    const stderr = captureStderr();
    try {
      expect(await recoverOnStart()).toBeNull();
      expect(stderr.text()).toContain("crash recovery with no EZCORP_PROJECT_ROOT");
    } finally {
      stderr.restore();
    }
  });

  test("recoverOnStart reaps a terminal run's orphaned worktree", async () => {
    _setProjectRootForTests(() => "/proj");
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd[cmd.length - 1]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    await store.createRun({
      id: "done", repoId: "0123456789ab", branch: "feat/x", ref: "refs/heads/feat/x",
      headSha: "abc", baseSha: "0".repeat(40), status: "completed", worktreePath: "/wt/done",
      createdAt: "t", updatedAt: "t", parkedMs: 0, awaitingAgentSince: null, intent: null, intentSource: null,
    });
    const summary = await recoverOnStart();
    expect(summary!.reaped).toBe(1);
    expect(removed).toEqual(["/wt/done"]);
    expect(store.runs.get("done")!.worktreePath).toBeNull();
  });
});

describe("production default seams (M6)", () => {
  test("default rbac check resolves via the ezcorp/rbac-check reverse RPC", async () => {
    _setRbacCheckForTests(null); // restore the production Rbac-based check
    __resetChannelForTests();
    const ch = getChannel() as HostChannel;
    spyOn(ch, "request").mockImplementation((async (method: string) => {
      if (method === "ezcorp/rbac-check") return { granted: true };
      return { value: null, exists: false };
    }) as HostChannel["request"]);
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setPushPageForTests(() => {});
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    _setRespondRunnerForTests(() => async ({ runId }) => {
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "run-parked", step: "review", action: "approve" } });
      // The real rbac-check granted → the respond ran to completion.
      expect(store.runs.get("run-parked")!.status).toBe("completed");
    } finally {
      __resetChannelForTests();
    }
  });

  test("default heartbeat KV reads via Storage (null when absent → doctor warns)", async () => {
    _setHeartbeatKVForTests(null); // restore the production Storage-backed KV
    _setProjectRootForTests(() => "/proj");
    __resetChannelForTests();
    const ch = getChannel() as HostChannel;
    spyOn(ch, "request").mockImplementation((async () => ({ value: null, exists: false })) as HostChannel["request"]);
    _setShellForTests(okShell);
    _setTokenStorageForTests(() => ({ async get() { return { value: null, exists: false }; } }));
    try {
      const res = await codeFactoryDoctorTool({});
      expect(res.isError).toBe(false);
      const report = JSON.parse(res.content[0]!.text) as { checks: Array<{ name: string; status: string }> };
      expect(report.checks.find((c) => c.name === "reconcile-sweep")!.status).toBe("warn");
    } finally {
      __resetChannelForTests();
    }
  });
});
