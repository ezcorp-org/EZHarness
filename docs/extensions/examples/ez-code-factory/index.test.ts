import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetChannelForTests,
  __resetPagesForTests,
  getChannel,
  withToolContext,
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
  _setInvalidatePageForTests,
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
  _setRunHeartbeatKVForTests,
  runReconcileSweep,
  handleScheduleFire,
  synthesizeScheduledRuns,
  recoverOnStart,
  _setJobStoreForTests,
  _setAuditForTests,
  handleJobSave,
  handleJobToggle,
  handleJobDelete,
  handleRunNow,
} from "./index";
import { buildDefaultJob, DEFAULT_JOB_ID, type Job, type JobStore } from "./lib/jobs";
import type { AuditEntry, AuditLog } from "./lib/audit";
import type { ChatToolDeps } from "./lib/chat-tools";
import {
  gateDir as gateDirFor,
  repoId as repoIdOf,
  dataDir as dataDirFor,
  credentialPath as credentialPathFor,
  GATE_REMOTE,
  HOOK_MARKER,
} from "./lib/gate";
import { SWEEP_CRON, type SweepHeartbeat } from "./lib/sweep";
import { productionHostRunner, type ShellRunner } from "./lib/shell";
import { _setLogSinkForTests } from "./lib/log";
import { emptyFindings } from "./lib/runs";
import type { Finding, ParsedRespond, RunRecord, RunStore, StepResultRecord, StepRoundRecord, StepStatus } from "./lib/runs";
import type { StepIORecord } from "./lib/step-io";

// ── in-memory store + fakes ─────────────────────────────────────────

function memStore(): RunStore & { runs: Map<string, RunRecord> } {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, StepResultRecord>();
  const rounds = new Map<string, StepRoundRecord[]>();
  const stepIO = new Map<string, StepIORecord>();
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
    async putStepIO(record) {
      stepIO.set(`${record.runId}/${record.step}/${record.round}`, record);
    },
    async getStepIO(runId, step, round) {
      return stepIO.get(`${runId}/${step}/${round}`) ?? null;
    },
    async listStepIO(runId, step) {
      const prefix = `${runId}/${step}/`;
      return [...stepIO.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .sort((a, b) => a.round - b.round);
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
/** In-memory JobStore fake (control plane). Seeded with the default job so the
 *  existing push tests proceed exactly as before (default matches every branch). */
function fakeJobStore(jobs: Job[]): JobStore & { jobs: Map<string, Job> } {
  const map = new Map<string, Job>(jobs.map((j) => [j.id, j]));
  return {
    jobs: map,
    async createJob(j) { map.set(j.id, j); },
    async getJob(id) { return map.get(id) ?? null; },
    async updateJob(id, patch) {
      const cur = map.get(id);
      if (!cur) return null;
      const next: Job = { ...cur, ...patch, updatedAt: new Date().toISOString() };
      map.set(id, next);
      return next;
    },
    async deleteJob(id) { return map.delete(id); },
    async listJobs() { return [...map.values()]; },
  };
}

/** Collected audit entries for the current test (reset per test). */
const auditEntries: AuditEntry[] = [];
function fakeAudit(): AuditLog {
  return {
    async append(e) {
      auditEntries.push({
        at: e.at ?? "t",
        actor: e.actor,
        kind: e.kind,
        ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
        ...(e.runId !== undefined ? { runId: e.runId } : {}),
        ...(e.step !== undefined ? { step: e.step } : {}),
        ...(e.detail !== undefined ? { detail: e.detail } : {}),
      });
    },
    async readDay() { return []; },
    async listDays() { return []; },
    async pruneRetention() { return []; },
  };
}

beforeEach(() => {
  _setSettingsReadForTests(async () => ({}));
  // Default: the acting user HOLDS every triage scope (the pre-M6 ungated
  // behaviour). The production default calls `new Rbac().check`, which hangs
  // against the stub channel; RBAC-specific tests override this per-scope.
  _setRbacCheckForTests(async () => true);
  // Control plane: inject in-memory job store (seeded with the default job) +
  // audit so push handling never hits the real Storage channel. Tests that
  // exercise specific jobs re-inject their own store.
  auditEntries.length = 0;
  _setJobStoreForTests(fakeJobStore([buildDefaultJob("2026-07-15T00:00:00.000Z")]));
  _setAuditForTests(fakeAudit());
});

afterEach(() => {
  _setProjectRootForTests(null);
  _setShellForTests(null);
  _setStoreForTests(null);
  _setInvalidatePageForTests(null);
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
  _setRunHeartbeatKVForTests(null);
  _setJobStoreForTests(null);
  _setAuditForTests(null);
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

/** Collect the extension's sandbox-safe log output via the `lib/log` sink seam
 *  (the sink deliberately bypasses `process.stderr`, so a spy on it sees
 *  nothing); `.restore()` re-installs the default Bun.stderr sink. */
function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  _setLogSinkForTests((line: string) => {
    lines.push(line);
  });
  return { text: () => lines.join(""), restore: () => _setLogSinkForTests(null) };
}

// ── sandbox-safe logging (B1 regression) ────────────────────────────
//
// The extension loads in EZCorp's Phase-3 sandbox, where `process.stderr.write`
// lazily inits a poisoned `node:fs` WriteStream and THROWS. Before the fix every
// log site used `process.stderr.write`, so the FIRST logged line crashed the
// subprocess on start — a bug all 914 unit tests missed because none simulated
// the poison. Here we make `process.stderr.write` throw the sandbox error, then
// drive real handler log paths and assert they survive. This FAILS against the
// old `process.stderr.write` code (the guard's log throws, then the outer
// catch's own `process.stderr.write` throws again and escapes) and PASSES with
// the `logLine` → Bun.stderr sink.
describe("sandbox-safe logging (B1 regression)", () => {
  test("a poisoned process.stderr does not crash handlers that log", async () => {
    _setProjectRootForTests(() => undefined); // force each guard's log path
    _setStoreForTests(memStore());
    // The sweep no longer early-bails on a missing root (runs resolve their
    // own stamped roots), so its heartbeat write needs the in-memory fake —
    // the default KV would RPC over the (absent) test channel.
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    const spy = spyOn(process.stderr, "write").mockImplementation((() => {
      throw new Error("Extension sandbox: 'fs module' blocked");
    }) as typeof process.stderr.write);
    try {
      await expect(
        handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH }),
      ).resolves.toBeUndefined();
      await expect(
        handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD }),
      ).resolves.toBeUndefined();
      await expect(
        handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "r" } }),
      ).resolves.toBeUndefined();
      await expect(
        handleReconcile({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "r" } }),
      ).resolves.toBeUndefined();
      // recoverOnStart is the actual `start()` path that crashed the subprocess.
      // (Empty store → zero-count summaries; the assertion is crash-safety.)
      await expect(recoverOnStart()).resolves.toBeDefined();
      await expect(runReconcileSweep()).resolves.toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});

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
    // No credential was minted → the result reports the gap + the exact next step
    // so the "initialized" reply cannot be a bare success (silent-setup gap #1).
    expect(out.credentialPresent).toBe(false);
    expect(out.nextStep).toContain("ezcorp key mint --scopes read,chat");
    expect(out.nextStep).toContain("umask 077");
  });

  test("with the credential minted → credentialPresent true and no nextStep", async () => {
    const work = join(root, "with-cred");
    mkdirSync(work);
    await productionHostRunner(["git", "init", "-b", "main"], work);
    await productionHostRunner(["git", "remote", "add", "origin", "https://up/x.git"], work);
    mkdirSync(dataDirFor(work), { recursive: true });
    writeFileSync(credentialPathFor(work), "minted-key");
    _setProjectRootForTests(() => work);
    _setShellForTests(productionHostRunner);
    _setBaseUrlForTests(() => "http://127.0.0.1:9");

    const res = await initGateTool({});
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content[0]!.text);
    expect(out.credentialPresent).toBe(true);
    expect(out.nextStep).toBeUndefined();
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

// ── B5: init_gate resolves the CONVERSATION's project via ctx.projectRoot ──
//
// The host forwards the conversation's active project root on the per-call
// `_meta.ezProjectRoot`, which the SDK surfaces as `ctx.projectRoot`. The
// DEFAULT project-root resolver must PREFER that over the process-wide
// `EZCORP_PROJECT_ROOT` env var (one persistent subprocess serves every
// conversation, so the env var only ever names ONE project). These tests use
// the REAL default resolver (`_setProjectRootForTests(null)`), toggling the
// tool context + env to prove precedence.
describe("initGateTool — ctx.projectRoot (B5)", () => {
  let root: string;
  let savedEnv: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ezcf-b5-"));
    savedEnv = process.env.EZCORP_PROJECT_ROOT;
    _setProjectRootForTests(null); // exercise the REAL default resolver
    _setShellForTests(productionHostRunner);
    _setBaseUrlForTests(() => "http://127.0.0.1:9");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.EZCORP_PROJECT_ROOT;
    else process.env.EZCORP_PROJECT_ROOT = savedEnv;
  });

  async function realRepo(name: string): Promise<string> {
    const work = join(root, name);
    mkdirSync(work);
    await productionHostRunner(["git", "init", "-b", "main"], work);
    await productionHostRunner(["git", "remote", "add", "origin", "https://up/x.git"], work);
    return work;
  }

  test("uses ctx.projectRoot (no env) to gate the conversation's project", async () => {
    delete process.env.EZCORP_PROJECT_ROOT; // env is NOT the source here
    const work = await realRepo("ctx-proj");

    const res = await withToolContext({ projectRoot: work }, () => initGateTool({}));

    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content[0]!.text);
    expect(out.ok).toBe(true);
    // Gate provisioned UNDER the ctx-resolved project root.
    expect(existsSync(gateDirFor(work, out.repoId))).toBe(true);
  });

  test("falls back to EZCORP_PROJECT_ROOT env when no tool context is bound", async () => {
    const work = await realRepo("env-proj");
    process.env.EZCORP_PROJECT_ROOT = work;

    // No withToolContext wrapper → getToolContext() is undefined → env fallback.
    const res = await initGateTool({});

    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content[0]!.text);
    expect(existsSync(gateDirFor(work, out.repoId))).toBe(true);
  });

  test("ctx.projectRoot WINS over the env var (correct project under concurrency)", async () => {
    const ctxWork = await realRepo("ctx-wins");
    process.env.EZCORP_PROJECT_ROOT = join(root, "stale-env-proj"); // wrong project

    const res = await withToolContext({ projectRoot: ctxWork }, () => initGateTool({}));

    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content[0]!.text);
    // Gate landed under the ctx project, NOT the (stale) env project.
    expect(existsSync(gateDirFor(ctxWork, out.repoId))).toBe(true);
    expect(existsSync(gateDirFor(join(root, "stale-env-proj"), out.repoId))).toBe(false);
  });

  test("no ctx and no env → the unset error (default resolver returns undefined)", async () => {
    delete process.env.EZCORP_PROJECT_ROOT;
    const res = await initGateTool({});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("EZCORP_PROJECT_ROOT unset");
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

  test("resolves the project from the hook-baked payload root when ctx/env are unset (repoId-hash validated)", async () => {
    // The PROD shape: one persistent subprocess, no tool-call context on a git
    // push, EZCORP_PROJECT_ROOT never set. The managed hook bakes the root into
    // its payload; the handler accepts it only because sha256(root)[:12]
    // matches the payload's repoId.
    _setProjectRootForTests(() => undefined);
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "completed"));
    _setInvalidatePageForTests(() => {});
    const root = "/proj/from-hook";
    await handlePushReceived({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { ...VALID_PUSH, repoId: repoIdOf(root), projectRoot: root },
    });
    expect(store.runs.size).toBe(1);
    const run = [...store.runs.values()][0]!;
    expect(run.repoId).toBe(repoIdOf(root));
    // The validated root is stamped for later context-free fires
    // (respond/yolo/reconcile/sweep/recovery).
    expect(run.projectRoot).toBe(root);
  });

  test("hash-validated payload root WINS over a set env root naming a DIFFERENT project", async () => {
    // One persistent subprocess serves every project: the process-wide env
    // root names whichever project spawned it (here /proj/other), not this
    // push's. The self-binding claim (sha256(root)[:12] === payload repoId)
    // must win, or every path (gate dir, tmp base, worktrees) derives from
    // the WRONG project tree — the latent wrong-tree bug behind drive-3.
    _setProjectRootForTests(() => "/proj/other");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "completed"));
    _setInvalidatePageForTests(() => {});
    const root = "/proj/from-hook";
    await handlePushReceived({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { ...VALID_PUSH, repoId: repoIdOf(root), projectRoot: root },
    });
    expect(store.runs.size).toBe(1);
    const run = [...store.runs.values()][0]!;
    expect(run.projectRoot).toBe(root); // NOT /proj/other
  });

  test("rejects a payload root that fails the repoId hash binding (forged root)", async () => {
    _setProjectRootForTests(() => undefined);
    const store = memStore();
    _setStoreForTests(store);
    await handlePushReceived({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { ...VALID_PUSH, projectRoot: "/proj/forged" }, // VALID_PUSH.repoId ≠ hash of this root
    });
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
    _setInvalidatePageForTests((pageId) => pushes.push(pageId));

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
    _setInvalidatePageForTests(() => {});

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
    _setInvalidatePageForTests(() => {});

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
    _setInvalidatePageForTests(() => {});
    const cap = captureStderr();
    try {
      await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
      expect(cap.text()).toContain("push-received handler error");
    } finally {
      cap.restore();
    }
  });
});

// ── handlePushReceived — job matching (control plane, L4) ────────────

describe("handlePushReceived — job matching", () => {
  test("stamps the matched job's id onto the created run", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "completed"));
    _setInvalidatePageForTests(() => {});
    // A specific enabled job for feat/x beats the default catch-all.
    _setJobStoreForTests(fakeJobStore([
      buildDefaultJob("2026-07-15T00:00:00.000Z"),
      { ...buildDefaultJob("2026-07-15T00:00:00.000Z"), id: "featjob", name: "Feature", trigger: { kind: "push", branchPattern: "feat/*" } },
    ]));
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    const run = [...store.runs.values()][0]!;
    expect(run.jobId).toBe("featjob");
  });

  test("a push matching NO enabled job is IGNORED (no run) and audited push-ignored", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    const store = memStore();
    _setStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    // Only the default job, DISABLED → nothing matches feat/x.
    _setJobStoreForTests(fakeJobStore([
      { ...buildDefaultJob("2026-07-15T00:00:00.000Z"), enabled: false },
    ]));
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    // No run was created.
    expect([...store.runs.values()]).toHaveLength(0);
    // The ignore was audited (never silent), with branch + reason.
    const ignored = auditEntries.find((e) => e.kind === "push-ignored");
    expect(ignored).toBeDefined();
    expect((ignored!.detail as { branch: string }).branch).toBe("feat/x");
    expect(ignored!.actor).toBe("system");
  });

  test("the auto-seeded default job matches any branch (today's behavior preserved)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "completed"));
    _setInvalidatePageForTests(() => {});
    // Empty store → loadJobsWithDefault seeds the default job on first read.
    _setJobStoreForTests(fakeJobStore([]));
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    const run = [...store.runs.values()][0]!;
    expect(run.jobId).toBe("default");
    // The seed itself is audited as actor "system".
    expect(auditEntries.some((e) => e.kind === "job-seed" && e.actor === "system")).toBe(true);
  });
});

// ── audit sinks (control plane, L5) ─────────────────────────────────

describe("audit sinks", () => {
  test("a respond action is audited with the acting user + action + finding ids (no content)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setInvalidatePageForTests(() => {});
    const store = memStore();
    const id = await seedParkedRun(store); // parked at review (clean gate → approve ok)
    _setStoreForTests(store);
    _setRespondRunnerForTests(() => async () => ({ parked: false }));
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    await handleRespond({
      source: "hub", pageId: "dashboard", userId: "alice",
      payload: { runId: id, step: "review", action: "approve" },
    });

    const respondAudit = auditEntries.find((e) => e.kind === "respond");
    expect(respondAudit).toBeDefined();
    expect(respondAudit!.actor).toBe("alice"); // event.userId stamped as actor
    expect(respondAudit!.runId).toBe(id);
    const detail = respondAudit!.detail as { action: string; findingIds: string[] };
    expect(detail.action).toBe("approve");
    // Privacy: the detail carries ids/action only — no finding descriptions.
    expect(JSON.stringify(respondAudit!.detail)).not.toContain("description");
  });

  test("handleScheduleFire audits the sweep summary and prunes audit retention", async () => {
    _setProjectRootForTests(() => "/proj");
    _setStoreForTests(memStore());
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    _setRunHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    // Only a push job → no schedule synthesis; we just want the sweep + prune.
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    // A fake audit that records appends AND the prune call.
    let pruneCalled = false;
    _setAuditForTests({
      async append(e) {
        auditEntries.push({ at: e.at ?? "t", actor: e.actor, kind: e.kind, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
      },
      async readDay() { return []; },
      async listDays() { return []; },
      async pruneRetention() { pruneCalled = true; return []; },
    });

    await handleScheduleFire({ cron: SWEEP_CRON, scheduledAt: "t", firedAt: "t", fireId: "f", catchUp: false, retry: false, attempt: 1 });

    const sweepAudit = auditEntries.find((e) => e.kind === "sweep");
    expect(sweepAudit).toBeDefined();
    expect(sweepAudit!.actor).toBe("system");
    expect(sweepAudit!.detail).toMatchObject({ scanned: expect.any(Number), stalled: expect.any(Number) });
    expect(pruneCalled).toBe(true);
  });
});

// ── synthesizeScheduledRuns — schedule tick routing (control plane, L4) ──

describe("synthesizeScheduledRuns", () => {
  const NEW_SHA = "cafebabecafebabecafebabecafebabecafebabe";
  /** Shell that returns `sha` for rev-parse and exit 0 for every other git op. */
  function revParseShell(sha: string): ShellRunner {
    return async (cmd) =>
      cmd.includes("rev-parse")
        ? { exitCode: 0, stdout: `${sha}\n`, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };
  }
  function schedJob(over: Partial<Job>): Job {
    return { ...buildDefaultJob("2026-07-15T00:00:00.000Z"), id: "nightly", name: "Nightly", trigger: { kind: "schedule", every: "daily", branch: "main" }, ...over };
  }

  test("a due schedule job whose head advanced synthesizes a run + audits + bookkeeps the head", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setInvalidatePageForTests(() => {});
    _setShellForTests(revParseShell(NEW_SHA));
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "completed"));
    const jobStore = fakeJobStore([schedJob({ lastHeadSha: "oldsha" })]);
    _setJobStoreForTests(jobStore);

    await synthesizeScheduledRuns(new Date("2026-07-21T00:00:00.000Z"));

    const run = [...store.runs.values()][0]!;
    expect(run.jobId).toBe("nightly");
    expect(run.branch).toBe("main");
    expect(run.headSha).toBe(NEW_SHA);
    expect(auditEntries.some((e) => e.kind === "schedule-fire" && e.jobId === "nightly" && e.runId === run.id)).toBe(true);
    // Head + fire-time bookkept for the next tick's no-change check.
    expect(jobStore.jobs.get("nightly")!.lastHeadSha).toBe(NEW_SHA);
    expect(jobStore.jobs.get("nightly")!.lastScheduleFireAt).toBeDefined();
  });

  test("no-change (head unchanged) mints NO run and audits schedule-no-change", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(revParseShell("samesha"));
    const store = memStore();
    _setStoreForTests(store);
    _setJobStoreForTests(fakeJobStore([schedJob({ trigger: { kind: "schedule", every: "15m", branch: "main" }, lastHeadSha: "samesha" })]));

    await synthesizeScheduledRuns(new Date());

    expect([...store.runs.values()]).toHaveLength(0);
    expect(auditEntries.some((e) => e.kind === "schedule-no-change")).toBe(true);
  });

  test("a branch the gate never received audits schedule-no-branch, no run", async () => {
    _setProjectRootForTests(() => "/proj");
    // rev-parse fails (branch absent) → exit 128.
    _setShellForTests(async (cmd) => cmd.includes("rev-parse") ? { exitCode: 128, stdout: "", stderr: "unknown revision" } : { exitCode: 0, stdout: "", stderr: "" });
    const store = memStore();
    _setStoreForTests(store);
    _setJobStoreForTests(fakeJobStore([schedJob({ trigger: { kind: "schedule", every: "15m", branch: "ghost" } })]));

    await synthesizeScheduledRuns(new Date());

    expect([...store.runs.values()]).toHaveLength(0);
    expect(auditEntries.some((e) => e.kind === "schedule-no-branch")).toBe(true);
  });

  test("a NOT-due schedule job (already fired this hour) is skipped", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(revParseShell(NEW_SHA));
    const store = memStore();
    _setStoreForTests(store);
    _setJobStoreForTests(fakeJobStore([schedJob({ trigger: { kind: "schedule", every: "hourly", branch: "main" }, lastScheduleFireAt: "2026-07-21T13:00:00.000Z" })]));

    await synthesizeScheduledRuns(new Date("2026-07-21T13:15:00.000Z")); // same hour → not due
    expect([...store.runs.values()]).toHaveLength(0);
  });

  test("push-trigger + disabled schedule jobs are never synthesized", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(revParseShell(NEW_SHA));
    const store = memStore();
    _setStoreForTests(store);
    _setJobStoreForTests(fakeJobStore([
      buildDefaultJob("t"), // push
      schedJob({ id: "off", enabled: false, trigger: { kind: "schedule", every: "15m", branch: "main" } }),
    ]));
    await synthesizeScheduledRuns(new Date());
    expect([...store.runs.values()]).toHaveLength(0);
  });

  test("no resolvable project root → context-free no-op", async () => {
    _setProjectRootForTests(() => undefined);
    const store = memStore();
    _setStoreForTests(store);
    _setJobStoreForTests(fakeJobStore([schedJob({ trigger: { kind: "schedule", every: "15m", branch: "main" } })]));
    await synthesizeScheduledRuns(new Date());
    expect([...store.runs.values()]).toHaveLength(0);
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
      _setInvalidatePageForTests(() => {});

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

/** Build a Finding with sensible defaults. Shared fixture reused by the
 *  no-blanket-approval (respond-contract) tests + the M6 hardening tests. */
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

/** A `run-parked` review step result carrying `items`. Reused to seed a parked
 *  gate with real finding ids (so the respond-contract cross-check has real ids
 *  to validate against) across the respond-contract + M6 test blocks. */
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

const RESPOND_PAYLOAD = { runId: "run-parked", step: "review", action: "approve" };

describe("handleRespond", () => {
  test("ignores respond with no active project (no-op: runner not called, run unmutated)", async () => {
    _setProjectRootForTests(() => undefined);
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store); // a parked run that must survive the no-op untouched
    let runnerCalls = 0;
    _setRespondRunnerForTests(() => async () => {
      runnerCalls++;
      return { parked: false };
    });
    const cap = captureStderr();
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
    } finally {
      cap.restore();
    }
    // The project-root guard short-circuits BEFORE any resume — observable no-op:
    // the expected stderr line, the resume runner never fired, the run unchanged.
    // (No ctx/env root and the seeded run carries no stamped root.)
    expect(cap.text()).toContain("no resolvable project root");
    expect(runnerCalls).toBe(0);
    expect((await store.getRun("run-parked"))!.status).toBe("awaiting_approval");
  });

  test("ignores an invalid respond payload (no-op: runner not called, nothing mutated)", async () => {
    _setProjectRootForTests(() => "/proj");
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    let runnerCalls = 0;
    _setRespondRunnerForTests(() => async () => {
      runnerCalls++;
      return { parked: false };
    });
    const cap = captureStderr();
    try {
      await handleRespond({
        source: "hub",
        pageId: "dashboard",
        userId: "u",
        payload: { runId: "x", step: "bogus", action: "approve" }, // unknown step → parse rejects
      });
    } finally {
      cap.restore();
    }
    // parseRespondPayload rejects the unknown step → the handler no-ops: the
    // expected stderr line, the resume runner never fired, the seeded run intact.
    expect(cap.text()).toContain("invalid payload");
    expect(runnerCalls).toBe(0);
    expect((await store.getRun("run-parked"))!.status).toBe("awaiting_approval");
  });

  test("ignores respond for an unknown run", async () => {
    _setProjectRootForTests(() => "/proj");
    _setStoreForTests(memStore());
    const cap = captureStderr();
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
      expect(cap.text()).toContain("unknown run");
    } finally {
      cap.restore();
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
    const cap = captureStderr();
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
      expect(cap.text()).toContain("could not resume");
    } finally {
      cap.restore();
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
    const cap = captureStderr();
    try {
      await handleRespond({ source: "hub", pageId: "dashboard", userId: "u", payload: RESPOND_PAYLOAD });
      expect(cap.text()).toContain("respond handler error");
      // The run never left awaiting_approval → its kept worktree survives.
      expect((await store.getRun("run-parked"))!.status).toBe("awaiting_approval");
      expect(removed.length).toBe(0);
    } finally {
      cap.restore();
    }
  });

  test("normalizes a per-finding fix (scalar findingId/instruction → canonical findingIds/instructions)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    const store = memStore();
    _setStoreForTests(store);
    await seedParkedRun(store);
    // The parked review step must actually carry the finding being fixed, or the
    // no-blanket-approval cross-check rejects the named id as a junk (non-existent)
    // finding. Seed a real `f1` so this test isolates the normalize→parse concern.
    await store.putStepResult(reviewStep([mkFinding({ id: "f1", action: "auto-fix" })], "awaiting_approval"));
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

describe("handleRespond — no-blanket-approval on the Hub/events path (spec §1 inv2)", () => {
  // The Hub `respond` action shares the SAME enforceRespondContract chokepoint as
  // the chat `code_factory_respond` tool: a raw events POST must NOT be able to
  // bulk-clear a gate carrying ask-user findings by omitting findingIds. Each
  // test seeds a run parked at the review gate WITH ask-user findings, wires a
  // respond runner that would mutate + tear down if it ran, and asserts the
  // observable no-op (or pass-through) on the store + runner spy.

  /** Drive one Hub respond; report whether the resume runner fired + stderr. */
  async function driveRespond(
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

  test("REJECTS a blanket (ids-free) approve of a gate WITH ask-user findings — no mutation, run stays parked", async () => {
    const store = memStore();
    await seedParkedRun(store);
    await store.putStepResult(reviewStep([mkFinding({ id: "a1", action: "ask-user" })], "awaiting_approval"));
    const { runnerCalls, removed, stderr } = await driveRespond(store, {
      runId: "run-parked",
      step: "review",
      action: "approve", // no findingIds → would blanket-clear the ask-user gate
    });
    // Refused BEFORE the resume runner: no mutation, the kept worktree survives.
    expect(runnerCalls).toBe(0);
    expect(removed.length).toBe(0);
    expect(stderr).toContain("respond refused");
    expect(stderr).toContain("must name the explicit findingIds");
    const run = (await store.getRun("run-parked"))!;
    expect(run.status).toBe("awaiting_approval");
    expect(run.worktreePath).not.toBeNull();
  });

  test("ALLOWS a named-id approve of the same ask-user gate (drives the resume runner)", async () => {
    const store = memStore();
    await seedParkedRun(store);
    await store.putStepResult(reviewStep([mkFinding({ id: "a1", action: "ask-user" })], "awaiting_approval"));
    // Capture the parsed respond to prove the named id rode through to the runner
    // ([] until it fires, so a wrongly-rejected respond fails the toEqual below).
    let capturedIds: string[] = [];
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setStoreForTests(store);
    _setRespondRunnerForTests((_pr, _gd, respond) => async ({ runId }) => {
      capturedIds = respond!.findingIds;
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    await handleRespond({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { runId: "run-parked", step: "review", action: "approve", findingIds: ["a1"] },
    });
    expect(capturedIds).toEqual(["a1"]);
    expect((await store.getRun("run-parked"))!.status).toBe("completed");
  });

  test("REJECTS an approve naming a finding id that is NOT on the parked step (junk id) — no mutation", async () => {
    const store = memStore();
    await seedParkedRun(store);
    await store.putStepResult(reviewStep([mkFinding({ id: "a1", action: "ask-user" })], "awaiting_approval"));
    const { runnerCalls, removed, stderr } = await driveRespond(store, {
      runId: "run-parked",
      step: "review",
      action: "approve",
      findingIds: ["ghost"], // not among the parked step's real findings
    });
    expect(runnerCalls).toBe(0);
    expect(removed.length).toBe(0);
    expect(stderr).toContain("not in the parked");
    expect((await store.getRun("run-parked"))!.status).toBe("awaiting_approval");
  });

  test("consentAll:true in the raw payload bypasses the block AND is audit-logged", async () => {
    const store = memStore();
    await seedParkedRun(store);
    await store.putStepResult(
      reviewStep(
        [mkFinding({ id: "a1", action: "ask-user" }), mkFinding({ id: "a2", action: "ask-user" })],
        "awaiting_approval",
      ),
    );
    const { runnerCalls, stderr } = await driveRespond(store, {
      runId: "run-parked",
      step: "review",
      action: "approve",
      consentAll: true, // standing consent → the ids-free clear proceeds, logged
    });
    expect(runnerCalls).toBe(1);
    expect((await store.getRun("run-parked"))!.status).toBe("completed");
    expect(stderr).toContain("consentAll bypass");
    expect(stderr).toContain("2 ask-user finding");
  });

  test("a CLEAN gate (no ask-user findings) still accepts an ids-free approve (de-normalization intact)", async () => {
    const store = memStore();
    await seedParkedRun(store); // review step seeded with emptyFindings() → clean
    const { runnerCalls, stderr } = await driveRespond(store, {
      runId: "run-parked",
      step: "review",
      action: "approve", // ids-free, but nothing was withheld → allowed
    });
    expect(runnerCalls).toBe(1);
    expect(stderr).not.toContain("respond refused");
    expect((await store.getRun("run-parked"))!.status).toBe("completed");
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
    _setInvalidatePageForTests(() => {});
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
    _setInvalidatePageForTests(() => {});
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
    _setInvalidatePageForTests(() => {});
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

  test("no resolvable project root (no ctx/env, run not stamped) → ignored", async () => {
    _setProjectRootForTests(() => undefined);
    const store = memStore();
    _setStoreForTests(store);
    await store.createRun({
      id: "r1", repoId: "0123456789ab", branch: "feat/x", ref: "refs/heads/feat/x",
      headSha: "abc", baseSha: "0".repeat(40), status: "checks_passed", worktreePath: "/wt/r1",
      createdAt: "t", updatedAt: "t", parkedMs: 0, awaitingAgentSince: "t", intent: null, intentSource: null,
    });
    const stderr = captureStderr();
    try {
      await handleReconcile(evt({ runId: "r1" }));
      expect(stderr.text()).toContain("no resolvable project root");
      expect(store.runs.get("r1")!.status).toBe("checks_passed");
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
    _setInvalidatePageForTests(() => {});
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
    _setInvalidatePageForTests(() => {});
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
      if (method === "ezcorp/invoke") return { default_branch: "main" };
      return { value: null, exists: false };
    }) as HostChannel["request"]);
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(trustedOkShell);
    const store = memStore();
    _setStoreForTests(store);
    _setInvalidatePageForTests(() => {});
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
    _setInvalidatePageForTests(() => {});
    try {
      await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
      // Defaults applied → the pipeline still runs to completion.
      expect([...store.runs.values()][0]!.status).toBe("completed");
    } finally {
      __resetChannelForTests();
    }
  });

  test("a NON-default settings value flows through resolveLiveConfig into the pipeline", async () => {
    // `autofix_cap` is the flat settings knob for rebase/test/document/lint/ci
    // (default 3). A mutation making resolveLiveConfig ignore the stub (always
    // `resolvePipelineConfig({})`) drops the read (fails (a)) and/or leaves the
    // recorded cap at 3 (fails (b)) — so this locks the live read, not just that
    // the run completed.
    const NON_DEFAULT_CAP = 7;
    let getMineCalls = 0;
    _setSettingsReadForTests(async () => {
      getMineCalls++;
      return { autofix_cap: NON_DEFAULT_CAP };
    });
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(trustedOkShell); // host no-ops + resolvable trusted branch → real executor runs to completion
    const store = memStore();
    _setStoreForTests(store);
    _setInvalidatePageForTests(() => {});
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
  test("ignores yolo when no project root resolves (no ctx/env, run not stamped)", async () => {
    _setProjectRootForTests(() => undefined);
    const store = memStore();
    _setStoreForTests(store);
    await store.createRun({
      id: "r1", repoId: "0123456789ab", branch: "feat/x", ref: "refs/heads/feat/x",
      headSha: "abc", baseSha: "0".repeat(40), status: "awaiting_approval", worktreePath: "/wt/r1",
      createdAt: "t", updatedAt: "t", parkedMs: 0, awaitingAgentSince: "t", intent: null, intentSource: null,
    });
    const stderr = captureStderr();
    try {
      await handleYolo({ source: "hub", pageId: "dashboard", userId: "u", payload: { runId: "r1" } });
      expect(stderr.text()).toContain("no resolvable project root");
      expect(store.runs.get("r1")!.status).toBe("awaiting_approval");
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
    _setInvalidatePageForTests(() => {});
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
    _setInvalidatePageForTests(() => {});
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
// (Shared fixtures `mkFinding` + `reviewStep` are defined near `seedParkedRun`.)

describe("RBAC on triage actions (M6)", () => {
  test("handleRespond proceeds when `respond-gate` is granted", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setInvalidatePageForTests(() => {});
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
    _setInvalidatePageForTests(() => {});
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
    _setInvalidatePageForTests(() => {});
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
      "credential",
      "curl",
      "gh",
      "token",
      "default-branch",
      "trusted-upstream",
      "reconcile-sweep",
    ]);
    expect(report.checks.find((c) => c.name === "gate")!.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "hook")!.status).toBe("ok");
  });
});

describe("reconcile sweep wiring (M6)", () => {
  test("runReconcileSweep with no ctx/env root: a run WITHOUT a stamped root is skipped, one WITH a stamped root advances", async () => {
    _setProjectRootForTests(() => undefined);
    _setShellForTests(okShell);
    _setInvalidatePageForTests(() => {});
    const store = memStore();
    _setStoreForTests(store);
    const base = {
      branch: "feat/x", ref: "refs/heads/feat/x", headSha: "abc", baseSha: "0".repeat(40),
      status: "checks_passed" as const, createdAt: "t", updatedAt: "t", parkedMs: 0,
      awaitingAgentSince: "t", intent: null, intentSource: null,
    };
    // Pre-fix row: no stamped root → with no ctx/env either, the sweep must
    // skip it (logged) instead of resolving a wrong project.
    await store.createRun({ ...base, id: "old", repoId: "0123456789ab", worktreePath: "/wt/old" });
    // Post-fix row: the stamped root hash-matches its repoId → reconciles
    // with NO env var at all.
    await store.createRun({
      ...base, id: "new", repoId: repoIdOf("/proj"), worktreePath: "/wt/new", projectRoot: "/proj",
    });
    _setReconcileRunnerForTests(() => async ({ runId }) => {
      await store.updateRun(runId, { status: "completed" });
      return { parked: false };
    });
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    const stderr = captureStderr();
    try {
      const summary = await runReconcileSweep();
      expect(summary.skipped).toBe(1);
      expect(summary.advanced).toBe(1);
      expect(stderr.text()).toContain("run old has no resolvable project root");
      expect(store.runs.get("new")!.status).toBe("completed");
      expect(store.runs.get("old")!.status).toBe("checks_passed");
    } finally {
      stderr.restore();
    }
  });

  test("runReconcileSweep advances a checks_passed run whose reconcile completes it + writes a heartbeat", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setInvalidatePageForTests(() => {});
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

  test("runReconcileSweep marks a running run whose per-run heartbeat is silent as stalled (L3 wiring)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(okShell);
    _setInvalidatePageForTests(() => {});
    const store = memStore();
    _setStoreForTests(store);
    await store.createRun({
      id: "dead", repoId: "0123456789ab", branch: "feat/x", ref: "refs/heads/feat/x",
      headSha: "abc", baseSha: "0".repeat(40), status: "running", worktreePath: "/wt/dead",
      createdAt: "t", updatedAt: "t", parkedMs: 0, awaitingAgentSince: null, intent: null, intentSource: null,
    });
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    // No per-run heartbeat + frozen updatedAt → trips the stall threshold now.
    _setRunHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    const summary = await runReconcileSweep();
    expect(summary.stalled).toBe(1);
    expect(store.runs.get("dead")!.status).toBe("stalled");
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
    // Seed a TERMINAL run so "scanned 0" is a real assertion — the sweep walked
    // the run list and correctly filtered a non-reconcilable run, not just an
    // empty store.
    await store.createRun({
      id: "done", repoId: "0123456789ab", branch: "feat/x", ref: "refs/heads/feat/x",
      headSha: "abc", baseSha: "0".repeat(40), status: "completed", worktreePath: null,
      createdAt: "t", updatedAt: "t", parkedMs: 0, awaitingAgentSince: null, intent: null, intentSource: null,
    });
    let wrote = 0;
    let lastHeartbeat: SweepHeartbeat | null = null;
    _setHeartbeatKVForTests(() => ({
      async read() { return null; },
      async write(hb) { wrote++; lastHeartbeat = hb; },
    }));
    await handleScheduleFire({ cron: SWEEP_CRON, scheduledAt: "t", firedAt: "t", fireId: "f", catchUp: false, retry: false, attempt: 1 });
    // The fire actually ran a sweep to completion: it recorded exactly one
    // heartbeat, and with no RECONCILABLE runs the summary is all-zeros (the
    // terminal run was skipped, never scanned).
    expect(wrote).toBe(1);
    expect(lastHeartbeat).not.toBeNull();
    expect(lastHeartbeat!.summary).toEqual({ scanned: 0, advanced: 0, stillParked: 0, skipped: 0, stalled: 0 });
  });
});

describe("crash recovery wiring (M6)", () => {
  test("recoverOnStart with no ctx/env root: a rootless run's worktree is NOT reaped (logged), a stamped one is", async () => {
    _setProjectRootForTests(() => undefined);
    const removed: string[] = [];
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) removed.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    const base = {
      branch: "feat/x", ref: "refs/heads/feat/x", headSha: "abc", baseSha: "0".repeat(40),
      status: "completed" as const, createdAt: "t", updatedAt: "t", parkedMs: 0,
      awaitingAgentSince: null, intent: null, intentSource: null,
    };
    await store.createRun({ ...base, id: "old", repoId: "0123456789ab", worktreePath: "/wt/old" });
    await store.createRun({
      ...base, id: "new", repoId: repoIdOf("/proj"), worktreePath: "/wt/new", projectRoot: "/proj",
    });
    const stderr = captureStderr();
    try {
      const summary = await recoverOnStart();
      // Both rows count as "reap attempted" (worktreePath cleared for
      // idempotency), but only the stamped run's shell reap actually ran.
      expect(summary.reaped).toBe(2);
      expect(removed.length).toBe(1);
      expect(removed[0]).toContain("/wt/new");
      expect(stderr.text()).toContain("run old has no resolvable project root — worktree not reaped");
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
    _setInvalidatePageForTests(() => {});
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

// ── renderDashboard — perProject context dispatch ────────────────────

describe("renderDashboard — perProject context dispatch", () => {
  const PROJECT = { id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff", name: "My App", path: "/home/dev/my-app" };

  async function seededStore() {
    const store = memStore();
    await store.createRun({
      id: "r-mine",
      repoId: repoIdOf(PROJECT.path),
      branch: "feat/mine",
      ref: "refs/heads/feat/mine",
      headSha: "abcdef0123456789",
      baseSha: "0000000000000000",
      status: "completed",
      worktreePath: null,
      createdAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "2026-07-17T08:00:00.000Z",
      parkedMs: 0,
      awaitingAgentSince: null,
      intent: null,
      intentSource: null,
    });
    await store.createRun({
      id: "r-foreign",
      repoId: "feedfacecafe",
      branch: "feat/other",
      ref: "refs/heads/feat/other",
      headSha: "1234567890abcdef",
      baseSha: "0000000000000000",
      status: "completed",
      worktreePath: null,
      createdAt: "2026-07-17T09:00:00.000Z",
      updatedAt: "2026-07-17T09:00:00.000Z",
      parkedMs: 0,
      awaitingAgentSince: null,
      intent: null,
      intentSource: null,
    });
    return store;
  }

  function tableRowIds(tree: { nodes: unknown[] }): string[] {
    const tables = (tree.nodes as Array<Record<string, unknown>>).filter(
      (n) => n.type === "table",
    ) as Array<{ rows: Array<{ cells: string[] }> }>;
    return tables.flatMap((t) => t.rows.map((r) => r.cells[0]!));
  }

  test("ctx.project renders ONLY that project's runs, titled per project", async () => {
    _setStoreForTests(await seededStore());
    const tree = await renderDashboard({ project: PROJECT });
    expect(tree.title).toBe("ez-code-factory — My App");
    expect(tableRowIds(tree)).toEqual(["r-mine"]);
  });

  test("ctx.projects renders the home view with a project row + orphan triage", async () => {
    _setStoreForTests(await seededStore());
    const tree = await renderDashboard({ projects: [PROJECT] });
    expect(tree.title).toBe("ez-code-factory");
    const ids = tableRowIds(tree);
    expect(ids).toContain("My App"); // projects table row
    expect(ids).toContain("r-foreign"); // orphan runs table row
    expect(ids).not.toContain("r-mine"); // project-owned run lives on its project page
  });

  test("no ctx falls back to the classic combined dashboard", async () => {
    _setStoreForTests(await seededStore());
    const tree = await renderDashboard();
    expect(tree.title).toBe("ez-code-factory");
    expect(tableRowIds(tree).sort()).toEqual(["r-foreign", "r-mine"]);
  });

  test("ctx.run renders the run-detail view, taking precedence over project", async () => {
    const store = await seededStore();
    const sr: StepResultRecord = {
      runId: "r-mine",
      step: "review",
      status: "completed",
      findings: { ...emptyFindings(), summary: "looked good" },
      agentPid: null,
      autoFixLimit: 0,
      round: 1,
      autoFixAttempts: 0,
      executionMs: 0,
      fixSummary: null,
      agentDispatches: [
        {
          role: "reviewer",
          assignmentId: "asg-1",
          subConversationId: "sub-1",
          agentRunId: "arun-1",
          at: "2026-07-18T09:30:00.000Z",
        },
      ],
    };
    await store.putStepResult(sr);
    _setStoreForTests(store);

    // `run` wins even with project context present.
    const tree = await renderDashboard({ project: PROJECT, run: "r-mine" });
    expect(tree.title).toContain("run r-mine");
    // The step table + the agent-turn provenance table both render.
    const tableCols = (tree.nodes as Array<Record<string, unknown>>)
      .flatMap((n) => {
        if (n.type === "table") return [n];
        if (n.type === "section" && Array.isArray(n.nodes)) return n.nodes as Array<Record<string, unknown>>;
        return [];
      })
      .filter((n) => n.type === "table")
      .map((n) => (n.columns as string[])[0]);
    expect(tableCols).toContain("Step");
  });

  test("ctx.run for an unknown id renders a 'Run not found' note (never an error)", async () => {
    _setStoreForTests(await seededStore());
    const tree = await renderDashboard({ run: "r-nope" });
    expect(tree.title).toContain("run r-nope");
    const empty = (tree.nodes as Array<Record<string, unknown>>).find((n) => n.type === "empty-state");
    expect(empty).toBeTruthy();
    expect(String((empty as Record<string, unknown>).title)).toContain("not found");
  });
});

// ── renderDashboard — step-detail routing + loader + derived stalled ──

describe("renderDashboard — step-detail + stalled", () => {
  const PROJECT = { id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff", name: "My App", path: "/home/dev/my-app" };

  function allNodes(nodes: unknown[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const raw of nodes) {
      const n = raw as Record<string, unknown>;
      out.push(n);
      if (n.type === "section" && Array.isArray(n.nodes)) out.push(...allNodes(n.nodes as unknown[]));
    }
    return out;
  }

  async function seedRunWithStep(store: ReturnType<typeof memStore>, id: string): Promise<void> {
    await store.createRun({
      id,
      repoId: repoIdOf(PROJECT.path),
      branch: "feat/mine",
      ref: "refs/heads/feat/mine",
      headSha: "abcdef0123456789",
      baseSha: "0000000000000000",
      status: "completed",
      worktreePath: null,
      createdAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "2026-07-17T08:00:00.000Z",
      parkedMs: 0,
      awaitingAgentSince: null,
      intent: null,
      intentSource: null,
    });
    await store.putStepResult({
      runId: id,
      step: "review",
      status: "completed",
      findings: emptyFindings(),
      agentPid: null,
      autoFixLimit: 0,
      round: 1,
      autoFixAttempts: 0,
      executionMs: 4200,
      fixSummary: null,
    });
  }

  const ioRec = (runId: string, round: number, over: Record<string, unknown> = {}) => ({
    runId,
    step: "review" as const,
    round,
    trigger: (round === 1 ? "initial" : "auto_fix") as "initial" | "auto_fix",
    branch: "feat/mine",
    headSha: "abcdef0123456789",
    worktreePath: "/wt",
    repoConfig: { agent: "", allowRepoCommands: false, disableProjectSettings: false, commandTest: "", commandLint: "" },
    startedAt: "2026-07-17T08:00:00.000Z",
    dispatches: [],
    shellCommands: [],
    endedAt: "2026-07-17T08:00:05.000Z",
    durationMs: 5000,
    error: null,
    outcome: { needsApproval: false, autoFixable: false, skipped: false, skipRemaining: false, checksPassed: false },
    ...over,
  });

  test("ctx.run + ctx.step renders the STEP detail, taking precedence over run + project", async () => {
    const store = memStore();
    await seedRunWithStep(store, "r-mine");
    await store.putStepIO(ioRec("r-mine", 1));
    _setStoreForTests(store);
    const tree = await renderDashboard({ project: PROJECT, run: "r-mine", step: "review" });
    expect(tree.title).toBe("ez-code-factory — step");
    const stats = allNodes(tree.nodes).find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
    expect(stats.items.find((i) => i.label === "Step")!.value).toBe("review");
    expect(stats.items.find((i) => i.label === "Run")!.value).toBe("r-mine");
  });

  test("an unknown step → 'Step not found' empty state (never throws)", async () => {
    const store = memStore();
    await seedRunWithStep(store, "r-mine");
    _setStoreForTests(store);
    const tree = await renderDashboard({ run: "r-mine", step: "bogus-step" });
    const empty = (tree.nodes as Array<Record<string, unknown>>).find((n) => n.type === "empty-state");
    expect(String((empty as Record<string, unknown>).title)).toContain("not found");
  });

  test("an unknown run with a valid step → 'Step not found' empty state", async () => {
    _setStoreForTests(memStore());
    const tree = await renderDashboard({ run: "r-nope", step: "review" });
    const empty = (tree.nodes as Array<Record<string, unknown>>).find((n) => n.type === "empty-state");
    expect(String((empty as Record<string, unknown>).title)).toContain("not found");
  });

  test("the loader lists IO by PREFIX — an errored round beyond sr.round still renders (LEFT-join)", async () => {
    const store = memStore();
    await seedRunWithStep(store, "r-mine"); // sr.round = 1
    await store.appendStepRound({
      runId: "r-mine", step: "review", round: 1, trigger: "initial",
      findingsJson: null, userFindingsJson: null, selectedFindingIds: null,
      selectionSource: null, fixSummary: null, durationMs: 0,
    });
    await store.putStepIO(ioRec("r-mine", 1));
    // An errored final attempt wrote an IO record at round 2 with NO step_round.
    await store.putStepIO(ioRec("r-mine", 2, { error: "step review failed: boom" }));
    _setStoreForTests(store);
    const tree = await renderDashboard({ run: "r-mine", step: "review" });
    const titles = allNodes(tree.nodes).filter((n) => n.type === "section").map((n) => String(n.title));
    expect(titles.some((t) => t.startsWith("Round 2"))).toBe(true);
    const content = JSON.stringify(tree.nodes);
    expect(content).toContain("step review failed: boom");
  });

  test("DERIVED stalled: a running run with a silent heartbeat renders ⚠ stalled on the dashboard", async () => {
    const store = memStore();
    await store.createRun({
      id: "r-live",
      repoId: repoIdOf(PROJECT.path),
      branch: "feat/mine",
      ref: "refs/heads/feat/mine",
      headSha: "abcdef0123456789",
      baseSha: "0000000000000000",
      status: "running",
      worktreePath: "/wt/live",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z", // frozen far in the past → stale now
      parkedMs: 0,
      awaitingAgentSince: null,
      intent: null,
      intentSource: null,
    });
    _setStoreForTests(store);
    // No per-run heartbeat → the frozen updatedAt trips the stall threshold.
    _setRunHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    const tree = await renderDashboard();
    const row = allNodes(tree.nodes)
      .filter((n) => n.type === "table")
      .flatMap((n) => n.rows as Array<{ cells: unknown[] }>)
      .find((r) => r.cells[0] === "r-live");
    expect(row!.cells[3]).toEqual({ text: "⚠ stalled", tone: "warning" });
    const stats = (tree.nodes as Array<Record<string, unknown>>).find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
    expect(stats.items.find((i) => i.label === "Stalled")!.value).toBe("1");
  });
});

// ── Control-plane views + job actions (L6/L7) ────────────────────────

function allNodesDeep(nodes: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of nodes) {
    const n = raw as Record<string, unknown>;
    out.push(n);
    if (n.type === "section" && Array.isArray(n.nodes)) out.push(...allNodesDeep(n.nodes as unknown[]));
  }
  return out;
}

describe("renderDashboard — ?view= routing (L6 precedence)", () => {
  beforeEach(() => {
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
  });

  test("view=config renders the config surface", async () => {
    _setStoreForTests(memStore());
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    const tree = await renderDashboard({ view: "config" });
    expect(tree.title).toBe("ez-code-factory — config");
  });

  test("view=job:<id> renders that job's editor; an unknown id → not-found", async () => {
    _setStoreForTests(memStore());
    _setJobStoreForTests(fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Nightly" }]));
    const ok = await renderDashboard({ view: "job:j1" });
    expect(ok.title).toContain("Nightly");
    const missing = await renderDashboard({ view: "job:ghost" });
    expect(allNodesDeep(missing.nodes).some((n) => n.type === "empty-state" && String(n.title).includes("not found"))).toBe(true);
  });

  test("view=audit renders the audit surface (newest day)", async () => {
    _setStoreForTests(memStore());
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    _setAuditForTests({
      async append() {},
      async readDay() { return [{ at: "2026-07-21T00:00:00.000Z", actor: "system", kind: "sweep" }]; },
      async listDays() { return ["2026-07-21"]; },
      async pruneRetention() { return []; },
    });
    const tree = await renderDashboard({ view: "audit" });
    expect(tree.title).toContain("audit 2026-07-21");
  });

  test("an unknown/malformed view → empty state (never throws)", async () => {
    _setStoreForTests(memStore());
    const tree = await renderDashboard({ view: "bogus" });
    expect(allNodesDeep(tree.nodes).some((n) => n.type === "empty-state" && String(n.title).includes("Unknown view"))).toBe(true);
  });

  test("view WINS over project context, but run+step/run WIN over view (precedence)", async () => {
    _setStoreForTests(memStore());
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    // view beats project (a config render on the project hub is the config).
    const cfg = await renderDashboard({ project: { id: "p1", name: "P", path: "/p" }, view: "config" });
    expect(cfg.title).toBe("ez-code-factory — config");
    // run beats view (a run detail is reachable everywhere).
    _setRunHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    const runDetail = await renderDashboard({ run: "run_missing", view: "config" });
    expect(runDetail.title).toContain("run run_missing");
  });
});

describe("handleJobSave", () => {
  const ev = (payload: Record<string, unknown>, userId = "alice") => ({ source: "hub" as const, pageId: "dashboard", userId, payload });

  test("RBAC deny → refuses, mutates NOTHING, audits NOTHING", async () => {
    _setRbacCheckForTests(async () => false);
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Old" }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    const cap = captureStderr();
    try {
      await handleJobSave(ev({ jobId: "j1", name: "Hacked" }));
    } finally {
      cap.restore();
    }
    expect(cap.text()).toContain("job-save refused");
    expect(store.jobs.get("j1")!.name).toBe("Old"); // unchanged
    expect(auditEntries).toHaveLength(0); // audits nothing
  });

  test("create (no jobId) → a new DISABLED push/main job, audited job-create with the acting user", async () => {
    const store = fakeJobStore([buildDefaultJob("t")]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    await handleJobSave(ev({ name: "Nightly main" }));
    const created = [...store.jobs.values()].find((j) => j.name === "Nightly main");
    expect(created).toBeDefined();
    expect(created!.enabled).toBe(false);
    expect(created!.trigger).toEqual({ kind: "push", branchPattern: "main" });
    expect(created!.createdBy).toBe("alice");
    const audit = auditEntries.find((e) => e.kind === "job-create" && e.jobId === created!.id);
    expect(audit).toBeDefined();
    expect(audit!.actor).toBe("alice");
  });

  test("edit → validates the merged draft, applies it, audits the field DIFF", async () => {
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Old", trigger: { kind: "push", branchPattern: "feat/*" } }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    await handleJobSave(ev({ jobId: "j1", name: "Renamed" }));
    expect(store.jobs.get("j1")!.name).toBe("Renamed");
    const audit = auditEntries.find((e) => e.kind === "job-save" && e.jobId === "j1");
    expect(audit).toBeDefined();
    expect((audit!.detail as { name: { from: string; to: string } }).name).toEqual({ from: "Old", to: "Renamed" });
    expect(audit!.actor).toBe("alice");
  });

  test("a PROTECTED-step skip fails validation → no-op (job unchanged) + audited job-edit-rejected", async () => {
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Keep", skipSteps: [] }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    const cap = captureStderr();
    try {
      await handleJobSave(ev({ jobId: "j1", skip_steps: "review" })); // review is protected
    } finally {
      cap.restore();
    }
    expect(cap.text()).toContain("protected");
    expect(store.jobs.get("j1")!.skipSteps).toEqual([]); // unchanged
    expect(auditEntries.some((e) => e.kind === "job-save")).toBe(false);
    // A failed validateJobDraft now leaves a trail, mirroring the no-field case.
    const rejected = auditEntries.find((e) => e.kind === "job-edit-rejected" && e.jobId === "j1");
    expect(rejected).toBeDefined();
    expect((rejected!.detail as { reason: string }).reason).toContain("protected");
  });

  test("a payload with NO recognized editable field is REJECTED — no mutation, audits job-edit-rejected", async () => {
    // The live bug's guard: a camelCase field the host rewrote to `value` (or any
    // drift) carries no recognized key → we must NOT re-persist the unchanged job
    // (which would stamp updatedBy + a bogus audit). Simulate the host fallback.
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Keep", updatedBy: "system" }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    const cap = captureStderr();
    try {
      await handleJobSave({ source: "hub", pageId: "dashboard", userId: "alice", payload: { jobId: "j1", value: "typed-but-lost" } });
    } finally {
      cap.restore();
    }
    // No mutation: updatedBy unchanged (NOT stamped to alice), agentName untouched.
    expect(store.jobs.get("j1")!.updatedBy).toBe("system");
    // No job-save audit; a job-edit-rejected entry names the offending key + reason.
    expect(auditEntries.some((e) => e.kind === "job-save")).toBe(false);
    const rejected = auditEntries.find((e) => e.kind === "job-edit-rejected" && e.jobId === "j1");
    expect(rejected).toBeDefined();
    expect(rejected!.actor).toBe("alice");
    expect((rejected!.detail as { reason: string; keys: string[] }).keys).toEqual(["value"]);
    expect(cap.text()).toContain("no recognized editable field");
  });

  test("an unparseable trigger spec is refused (no save) + audited job-edit-rejected", async () => {
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Keep" }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    const cap = captureStderr();
    try {
      await handleJobSave(ev({ jobId: "j1", trigger: "nonsense" }));
    } finally {
      cap.restore();
    }
    expect(cap.text()).toContain("trigger must be like");
    expect(auditEntries.some((e) => e.kind === "job-save")).toBe(false);
    // A failed applyJobEdit now audits the refusal (reason + offending keys).
    const rejected = auditEntries.find((e) => e.kind === "job-edit-rejected" && e.jobId === "j1");
    expect(rejected).toBeDefined();
    expect((rejected!.detail as { reason: string; keys: string[] }).keys).toEqual(["trigger"]);
  });

  test("toggle_step round-trips: skip a running step, then run it again (audits skipSteps diff)", async () => {
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "N", skipSteps: [] }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    // Skip `test`.
    await handleJobSave(ev({ jobId: "j1", toggle_step: "test" }));
    expect(store.jobs.get("j1")!.skipSteps).toEqual(["test"]);
    const skipAudit = auditEntries.find((e) => e.kind === "job-save" && e.jobId === "j1");
    expect((skipAudit!.detail as { skipSteps: { from: unknown; to: unknown } }).skipSteps).toEqual({ from: [], to: ["test"] });
    // Toggle again → runs again.
    await handleJobSave(ev({ jobId: "j1", toggle_step: "test" }));
    expect(store.jobs.get("j1")!.skipSteps).toEqual([]);
  });

  test("a PROTECTED-step toggle is refused (no mutation) + audited job-edit-rejected", async () => {
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Keep", skipSteps: [] }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    const cap = captureStderr();
    try {
      await handleJobSave(ev({ jobId: "j1", toggle_step: "review" }));
    } finally {
      cap.restore();
    }
    expect(store.jobs.get("j1")!.skipSteps).toEqual([]); // unchanged
    expect(auditEntries.some((e) => e.kind === "job-save")).toBe(false);
    const rejected = auditEntries.find((e) => e.kind === "job-edit-rejected" && e.jobId === "j1");
    expect(rejected).toBeDefined();
    expect((rejected!.detail as { reason: string }).reason).toContain("protected step 'review'");
  });

  test("an UNKNOWN-step toggle is refused + audited job-edit-rejected", async () => {
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Keep", skipSteps: [] }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    const cap = captureStderr();
    try {
      await handleJobSave(ev({ jobId: "j1", toggle_step: "bogus" }));
    } finally {
      cap.restore();
    }
    expect(auditEntries.some((e) => e.kind === "job-save")).toBe(false);
    const rejected = auditEntries.find((e) => e.kind === "job-edit-rejected" && e.jobId === "j1");
    expect((rejected!.detail as { reason: string }).reason).toContain("unknown step: bogus");
  });

  test("an intent-template edit round-trips, including clear-to-empty", async () => {
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "N" }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    await handleJobSave(ev({ jobId: "j1", intent_template: "Keep the API stable" }));
    expect(store.jobs.get("j1")!.intentTemplate).toBe("Keep the API stable");
    // Clearing it (blank) removes the override.
    await handleJobSave(ev({ jobId: "j1", intent_template: "   " }));
    expect(store.jobs.get("j1")!.intentTemplate).toBeUndefined();
  });
});

describe("handleJobToggle", () => {
  const ev = (payload: Record<string, unknown>) => ({ source: "hub" as const, pageId: "dashboard", userId: "bob", payload });

  test("flips enabled and audits job-toggle with the new state", async () => {
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "N", enabled: true }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    await handleJobToggle(ev({ jobId: "j1" }));
    expect(store.jobs.get("j1")!.enabled).toBe(false);
    const audit = auditEntries.find((e) => e.kind === "job-toggle" && e.jobId === "j1");
    expect(audit).toBeDefined();
    expect((audit!.detail as { enabled: boolean }).enabled).toBe(false);
    expect(audit!.actor).toBe("bob");
  });

  test("RBAC deny → no toggle, audits nothing", async () => {
    _setRbacCheckForTests(async () => false);
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", enabled: true }]);
    _setJobStoreForTests(store);
    const cap = captureStderr();
    try {
      await handleJobToggle(ev({ jobId: "j1" }));
    } finally {
      cap.restore();
    }
    expect(store.jobs.get("j1")!.enabled).toBe(true);
    expect(auditEntries).toHaveLength(0);
  });
});

describe("handleJobDelete", () => {
  const ev = (payload: Record<string, unknown>) => ({ source: "hub" as const, pageId: "dashboard", userId: "carol", payload });

  test("deletes a non-default job and audits job-delete with its name", async () => {
    const store = fakeJobStore([buildDefaultJob("t"), { ...buildDefaultJob("t"), id: "j1", name: "Nightly" }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    await handleJobDelete(ev({ jobId: "j1" }));
    expect(store.jobs.has("j1")).toBe(false);
    const audit = auditEntries.find((e) => e.kind === "job-delete" && e.jobId === "j1");
    expect(audit).toBeDefined();
    expect((audit!.detail as { name: string }).name).toBe("Nightly");
    expect(audit!.actor).toBe("carol");
  });

  test("the DEFAULT job is protected — deletion refused, no audit", async () => {
    const store = fakeJobStore([buildDefaultJob("t")]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    const cap = captureStderr();
    try {
      await handleJobDelete(ev({ jobId: DEFAULT_JOB_ID }));
    } finally {
      cap.restore();
    }
    expect(cap.text()).toContain("default job cannot be deleted");
    expect(store.jobs.has(DEFAULT_JOB_ID)).toBe(true);
    expect(auditEntries.some((e) => e.kind === "job-delete")).toBe(false);
  });

  test("RBAC deny → no delete, audits nothing", async () => {
    _setRbacCheckForTests(async () => false);
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1" }]);
    _setJobStoreForTests(store);
    const cap = captureStderr();
    try {
      await handleJobDelete(ev({ jobId: "j1" }));
    } finally {
      cap.restore();
    }
    expect(store.jobs.has("j1")).toBe(true);
    expect(auditEntries).toHaveLength(0);
  });
});

describe("handleRunNow", () => {
  const NEW_SHA = "feedfacefeedfacefeedfacefeedfacefeedface";
  function revParseShell(sha: string): ShellRunner {
    return async (cmd) =>
      cmd.includes("rev-parse") ? { exitCode: 0, stdout: `${sha}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
  }
  const ev = (payload: Record<string, unknown>) => ({ source: "hub" as const, pageId: "dashboard", userId: "dana", payload });

  test("an ENABLED job with a concrete branch synthesizes a run (jobId stamped) + audits run-now + bookkeeps head", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(revParseShell(NEW_SHA));
    _setInvalidatePageForTests(() => {});
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "completed"));
    const jobStore = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Manual", enabled: true, trigger: { kind: "manual", branch: "main" } }]);
    _setJobStoreForTests(jobStore);

    await handleRunNow(ev({ jobId: "j1" }));

    const created = [...store.runs.values()][0]!;
    expect(created.jobId).toBe("j1");
    expect(created.branch).toBe("main");
    expect(created.headSha).toBe(NEW_SHA);
    const audit = auditEntries.find((e) => e.kind === "run-now" && e.jobId === "j1");
    expect(audit).toBeDefined();
    expect(audit!.runId).toBe(created.id);
    expect(audit!.actor).toBe("dana");
    expect(jobStore.jobs.get("j1")!.lastHeadSha).toBe(NEW_SHA);
  });

  test("a DISABLED job is refused (run-now requires an enabled job) — no run, no run-now audit", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(revParseShell(NEW_SHA));
    const store = memStore();
    _setStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    _setJobStoreForTests(fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", enabled: false, trigger: { kind: "manual", branch: "main" } }]));
    const cap = captureStderr();
    try {
      await handleRunNow(ev({ jobId: "j1" }));
    } finally {
      cap.restore();
    }
    expect([...store.runs.values()]).toHaveLength(0);
    expect(cap.text()).toContain("is disabled");
    expect(auditEntries.some((e) => e.kind === "run-now")).toBe(false);
  });

  test("a glob push job (no concrete branch) is refused — no run", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(revParseShell(NEW_SHA));
    const store = memStore();
    _setStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    _setJobStoreForTests(fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", enabled: true, trigger: { kind: "push", branchPattern: "feat/*" } }]));
    const cap = captureStderr();
    try {
      await handleRunNow(ev({ jobId: "j1" }));
    } finally {
      cap.restore();
    }
    expect([...store.runs.values()]).toHaveLength(0);
    expect(cap.text()).toContain("needs a concrete branch");
  });

  test("a branch the gate never received audits run-now-no-branch, no run", async () => {
    _setProjectRootForTests(() => "/proj");
    // rev-parse fails (branch absent).
    _setShellForTests(async (cmd) => (cmd.includes("rev-parse") ? { exitCode: 128, stdout: "", stderr: "unknown" } : { exitCode: 0, stdout: "", stderr: "" }));
    const store = memStore();
    _setStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    _setJobStoreForTests(fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", enabled: true, trigger: { kind: "manual", branch: "ghost" } }]));
    await handleRunNow(ev({ jobId: "j1" }));
    expect([...store.runs.values()]).toHaveLength(0);
    expect(auditEntries.some((e) => e.kind === "run-now-no-branch")).toBe(true);
  });

  test("RBAC deny → no run, audits nothing", async () => {
    _setRbacCheckForTests(async () => false);
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(revParseShell(NEW_SHA));
    const store = memStore();
    _setStoreForTests(store);
    _setJobStoreForTests(fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", enabled: true, trigger: { kind: "manual", branch: "main" } }]));
    const cap = captureStderr();
    try {
      await handleRunNow(ev({ jobId: "j1" }));
    } finally {
      cap.restore();
    }
    expect([...store.runs.values()]).toHaveLength(0);
    expect(auditEntries).toHaveLength(0);
  });
});

describe("handleJobSave — agentName edit (L4)", () => {
  test("editing agent_name round-trips + audits the diff; the override reaches future dispatches", async () => {
    const store = fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Nightly" }]);
    _setJobStoreForTests(store);
    _setInvalidatePageForTests(() => {});
    // The slug-legal key the Edit-agent prompt emits (camelCase would be dropped).
    await handleJobSave({ source: "hub", pageId: "dashboard", userId: "alice", payload: { jobId: "j1", agent_name: "critic" } });
    // Persisted on the job (buildExecutorDeps threads it into jobAgentName).
    expect(store.jobs.get("j1")!.agentName).toBe("critic");
    const audit = auditEntries.find((e) => e.kind === "job-save" && e.jobId === "j1");
    expect(audit).toBeDefined();
    expect((audit!.detail as { agentName: { from: unknown; to: string } }).agentName).toEqual({ from: null, to: "critic" });
  });
});

// ── Control-plane audit sinks — lifecycle transitions (L5) ───────────
//
// The three transitions OUTSIDE the executor's setRunStatus sink — run CREATION
// + SUPERSEDE (runs.ts) and the sweep's STALL (sweep.ts) — plus the yolo +
// reconcile triage sinks, all emit `run-status`/action audit entries with the
// acting identity. Mirrors the existing respond-sink assertion.

describe("audit sinks — L5 lifecycle transitions", () => {
  test("run CREATION emits a run-status 'created' entry (bypasses the executor sink)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "completed"));
    _setInvalidatePageForTests(() => {});
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    const created = auditEntries.find((e) => e.kind === "run-status" && (e.detail as { status?: string }).status === "created");
    expect(created).toBeDefined();
    expect(created!.actor).toBe("system");
    expect(created!.runId).toBe([...store.runs.values()][0]!.id);
  });

  test("SUPERSEDE emits a run-status 'aborted' entry with reason 'superseded'", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = memStore();
    _setStoreForTests(store);
    _setRunPipelineForTests(fakePipeline(store, "parked")); // both runs park (non-terminal)
    _setInvalidatePageForTests(() => {});
    // Two pushes to the SAME branch/default job → the 2nd supersedes the 1st.
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    const aborted = auditEntries.find(
      (e) => e.kind === "run-status" && (e.detail as { status?: string; reason?: string }).status === "aborted",
    );
    expect(aborted).toBeDefined();
    expect((aborted!.detail as { reason: string }).reason).toBe("superseded");
  });

  test("the sweep's STALL transition emits a run-status 'stalled' entry", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    _setRunHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    const store = memStore();
    // A `running` run with a frozen updatedAt + no heartbeat → stale.
    await store.createRun({
      id: "run-live", repoId: "0123456789ab", branch: "feat/x", ref: "refs/heads/feat/x",
      headSha: "abc", baseSha: "0".repeat(40), status: "running", worktreePath: "/wt",
      createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
      parkedMs: 0, awaitingAgentSince: null, intent: null, intentSource: null,
    });
    _setStoreForTests(store);
    await runReconcileSweep();
    const stalled = auditEntries.find((e) => e.kind === "run-status" && (e.detail as { status?: string }).status === "stalled");
    expect(stalled).toBeDefined();
    expect(stalled!.runId).toBe("run-live");
    expect((await store.getRun("run-live"))!.status).toBe("stalled");
  });

  test("YOLO emits a 'yolo' entry with the acting user", async () => {
    _setProjectRootForTests(() => "/proj");
    _setInvalidatePageForTests(() => {});
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = memStore();
    await seedParkedRun(store);
    _setStoreForTests(store);
    _setRespondRunnerForTests(() => async () => ({ parked: false }));
    await handleYolo({ source: "hub", pageId: "dashboard", userId: "dana", payload: { runId: "run-parked" } });
    const audit = auditEntries.find((e) => e.kind === "yolo" && e.runId === "run-parked");
    expect(audit).toBeDefined();
    expect(audit!.actor).toBe("dana");
  });

  test("RECONCILE emits a 'reconcile' entry with the acting user", async () => {
    _setProjectRootForTests(() => "/proj");
    _setInvalidatePageForTests(() => {});
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = memStore();
    await seedParkedRun(store);
    _setStoreForTests(store);
    _setReconcileRunnerForTests(() => async () => ({ parked: true }));
    await handleReconcile({ source: "hub", pageId: "dashboard", userId: "erin", payload: { runId: "run-parked" } });
    const audit = auditEntries.find((e) => e.kind === "reconcile" && e.runId === "run-parked");
    expect(audit).toBeDefined();
    expect(audit!.actor).toBe("erin");
  });

  test("synthesizeScheduledRuns audits schedule-error when a per-job synthesis throws", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    // rev-parse THROWS → resolveJobHead throws → the per-job catch audits schedule-error.
    _setShellForTests(async (cmd) => {
      if (cmd.includes("rev-parse")) throw new Error("git exploded");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = memStore();
    _setStoreForTests(store);
    _setJobStoreForTests(fakeJobStore([
      { ...buildDefaultJob("t"), id: "nightly", name: "Nightly", enabled: true, trigger: { kind: "schedule", every: "15m", branch: "main" } },
    ]));
    const cap = captureStderr();
    try {
      await synthesizeScheduledRuns(new Date());
    } finally {
      cap.restore();
    }
    expect([...store.runs.values()]).toHaveLength(0);
    const err = auditEntries.find((e) => e.kind === "schedule-error" && e.jobId === "nightly");
    expect(err).toBeDefined();
    expect((err!.detail as { error: string }).error).toContain("git exploded");
  });
});

// ── job-action handlers: no-op + error branches (coverage) ───────────

describe("job-action handlers — no-op + error branches", () => {
  const ev = (payload: Record<string, unknown>) => ({ source: "hub" as const, pageId: "dashboard", userId: "u", payload });
  /** fakeJobStore whose ONE named method throws (the rest delegate). */
  function throwingJobStore(jobs: Job[], method: "updateJob" | "deleteJob" | "listJobs"): JobStore {
    const inner = fakeJobStore(jobs);
    return {
      ...inner,
      updateJob: method === "updateJob" ? async () => { throw new Error("store boom"); } : inner.updateJob,
      deleteJob: method === "deleteJob" ? async () => { throw new Error("store boom"); } : inner.deleteJob,
      listJobs: method === "listJobs" ? async () => { throw new Error("store boom"); } : inner.listJobs,
    };
  }

  test("job-save: a store throw is caught + logged (handler error path)", async () => {
    _setJobStoreForTests(throwingJobStore([{ ...buildDefaultJob("t"), id: "j1", name: "Old" }], "updateJob"));
    _setInvalidatePageForTests(() => {});
    const cap = captureStderr();
    try { await handleJobSave(ev({ jobId: "j1", name: "New" })); } finally { cap.restore(); }
    expect(cap.text()).toContain("job-save handler error");
  });

  test("job-toggle: invalid payload / unknown job / store throw", async () => {
    _setInvalidatePageForTests(() => {});
    // invalid payload (no jobId)
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    let cap = captureStderr();
    try { await handleJobToggle(ev({})); } finally { cap.restore(); }
    expect(cap.text()).toContain("job-toggle with invalid payload");
    // unknown job
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    cap = captureStderr();
    try { await handleJobToggle(ev({ jobId: "ghost" })); } finally { cap.restore(); }
    expect(cap.text()).toContain("job-toggle for unknown job");
    // store throw → caught
    _setJobStoreForTests(throwingJobStore([{ ...buildDefaultJob("t"), id: "j1", enabled: true }], "updateJob"));
    cap = captureStderr();
    try { await handleJobToggle(ev({ jobId: "j1" })); } finally { cap.restore(); }
    expect(cap.text()).toContain("job-toggle handler error");
  });

  test("job-delete: invalid payload / unknown job / store throw", async () => {
    _setInvalidatePageForTests(() => {});
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    let cap = captureStderr();
    try { await handleJobDelete(ev({})); } finally { cap.restore(); }
    expect(cap.text()).toContain("job-delete with invalid payload");
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    cap = captureStderr();
    try { await handleJobDelete(ev({ jobId: "ghost" })); } finally { cap.restore(); }
    expect(cap.text()).toContain("job-delete for unknown job");
    _setJobStoreForTests(throwingJobStore([buildDefaultJob("t"), { ...buildDefaultJob("t"), id: "j1" }], "deleteJob"));
    cap = captureStderr();
    try { await handleJobDelete(ev({ jobId: "j1" })); } finally { cap.restore(); }
    expect(cap.text()).toContain("job-delete handler error");
  });

  test("run-now: invalid payload / no project root / unknown job / shell throw", async () => {
    _setInvalidatePageForTests(() => {});
    // invalid payload
    _setProjectRootForTests(() => "/proj");
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    let cap = captureStderr();
    try { await handleRunNow(ev({})); } finally { cap.restore(); }
    expect(cap.text()).toContain("run-now with invalid payload");
    // no resolvable project root
    _setProjectRootForTests(() => undefined);
    cap = captureStderr();
    try { await handleRunNow(ev({ jobId: "j1" })); } finally { cap.restore(); }
    expect(cap.text()).toContain("no resolvable project root");
    // unknown job
    _setProjectRootForTests(() => "/proj");
    _setJobStoreForTests(fakeJobStore([buildDefaultJob("t")]));
    cap = captureStderr();
    try { await handleRunNow(ev({ jobId: "ghost" })); } finally { cap.restore(); }
    expect(cap.text()).toContain("run-now for unknown job");
    // shell throw (rev-parse) → caught by the handler
    _setProjectRootForTests(() => "/proj");
    _setJobStoreForTests(fakeJobStore([{ ...buildDefaultJob("t"), id: "j1", enabled: true, trigger: { kind: "manual", branch: "main" } }]));
    _setShellForTests(async (c) => { if (c.includes("rev-parse")) throw new Error("git boom"); return { exitCode: 0, stdout: "", stderr: "" }; });
    cap = captureStderr();
    try { await handleRunNow(ev({ jobId: "j1" })); } finally { cap.restore(); }
    expect(cap.text()).toContain("run-now handler error");
  });

  test("handleScheduleFire: a synthesize throw AND a retention-prune throw are each caught + logged", async () => {
    _setProjectRootForTests(() => "/proj");
    _setStoreForTests(memStore());
    _setHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    _setRunHeartbeatKVForTests(() => ({ async read() { return null; }, async write() {} }));
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    // jobStore.listJobs throws → synthesizeScheduledRuns throws → caught (routing error).
    _setJobStoreForTests(throwingJobStore([buildDefaultJob("t")], "listJobs"));
    // audit.pruneRetention throws → caught (retention prune error). append records the sweep summary.
    _setAuditForTests({
      async append() {},
      async readDay() { return []; },
      async listDays() { return []; },
      async pruneRetention() { throw new Error("prune boom"); },
    });
    const cap = captureStderr();
    try {
      await handleScheduleFire({ cron: SWEEP_CRON, scheduledAt: "t", firedAt: "t", fireId: "f", catchUp: false, retry: false, attempt: 1 });
    } finally {
      cap.restore();
    }
    expect(cap.text()).toContain("schedule job routing error");
    expect(cap.text()).toContain("audit retention prune error");
  });
});
