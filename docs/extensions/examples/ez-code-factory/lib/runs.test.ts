import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetChannelForTests, getChannel } from "@ezcorp/sdk/runtime";
import type { HostChannel } from "@ezcorp/sdk/runtime";
import {
  deserializeFinding,
  deserializeFindings,
  emptyFindings,
  parsePushReceived,
  newRunId,
  worktreePathFor,
  createRunStore,
  runGateLifecycle,
  type RunRecord,
  type RunStore,
  type StepResultRecord,
} from "./runs";
import { productionHostRunner, type ShellRunner } from "./shell";

// ── findings deserialization (fail-closed) ──────────────────────────

describe("deserializeFinding — fail-closed action", () => {
  test("missing action → ask-user", () => {
    expect(deserializeFinding({ severity: "info" }).action).toBe("ask-user");
  });
  test("empty/whitespace action → ask-user", () => {
    expect(deserializeFinding({ action: "" }).action).toBe("ask-user");
    expect(deserializeFinding({ action: "   " }).action).toBe("ask-user");
  });
  test("unrecognized action → ask-user", () => {
    expect(deserializeFinding({ action: "delete-everything" }).action).toBe("ask-user");
  });
  test("valid actions are preserved", () => {
    expect(deserializeFinding({ action: "no-op" }).action).toBe("no-op");
    expect(deserializeFinding({ action: "auto-fix" }).action).toBe("auto-fix");
    expect(deserializeFinding({ action: "ask-user" }).action).toBe("ask-user");
  });
  test("unknown severity → error (conservative); known preserved", () => {
    expect(deserializeFinding({ action: "no-op" }).severity).toBe("error");
    expect(deserializeFinding({ action: "no-op", severity: "warning" }).severity).toBe("warning");
  });
  test("source normalizes to agent unless explicitly user", () => {
    expect(deserializeFinding({ action: "no-op" }).source).toBe("agent");
    expect(deserializeFinding({ action: "no-op", source: "user" }).source).toBe("user");
    expect(deserializeFinding({ action: "no-op", source: "bogus" }).source).toBe("agent");
  });
  test("line is a finite number or null; string fields default to ''", () => {
    expect(deserializeFinding({ action: "no-op", line: 42 }).line).toBe(42);
    expect(deserializeFinding({ action: "no-op", line: "x" }).line).toBeNull();
    expect(deserializeFinding({ action: "no-op", line: Infinity }).line).toBeNull();
    expect(deserializeFinding(null).file).toBe("");
    expect(deserializeFinding({ action: "no-op", id: "f1", description: "d", category: "c", userInstructions: "u" })).toMatchObject({
      id: "f1",
      description: "d",
      category: "c",
      userInstructions: "u",
    });
  });
});

describe("deserializeFindings", () => {
  test("maps items + coerces envelope fields; never throws", () => {
    const f = deserializeFindings({
      items: [{ action: "auto-fix" }, {}],
      summary: "s",
      tested: ["a", 1, "b"],
      testingSummary: "ts",
      artifacts: ["x"],
      riskLevel: "low",
      riskRationale: "r",
    });
    expect(f.items).toHaveLength(2);
    expect(f.items[0]!.action).toBe("auto-fix");
    expect(f.items[1]!.action).toBe("ask-user"); // fail-closed
    expect(f.tested).toEqual(["a", "b"]); // non-strings dropped
    expect(f.summary).toBe("s");
    expect(f.riskLevel).toBe("low");
  });
  test("non-object / missing items → empty, well-formed blob", () => {
    expect(deserializeFindings(null).items).toEqual([]);
    expect(deserializeFindings({ items: "nope" }).items).toEqual([]);
    const e = emptyFindings();
    expect(e.items).toEqual([]);
    expect(e.summary).toBe("");
    expect(e.artifacts).toEqual([]);
  });
});

// ── parsePushReceived (untrusted payload) ───────────────────────────

describe("parsePushReceived", () => {
  const ok = {
    repoId: "0123456789ab",
    branch: "feat/x",
    ref: "refs/heads/feat/x",
    newSha: "abcdef1234567890abcdef1234567890abcdef12",
  };
  test("accepts a well-formed payload", () => {
    expect(parsePushReceived(ok)).toEqual(ok);
  });
  test("rejects non-objects + missing fields", () => {
    expect(parsePushReceived(null)).toBeNull();
    expect(parsePushReceived("x")).toBeNull();
    expect(parsePushReceived({ ...ok, branch: "" })).toBeNull();
    expect(parsePushReceived({ ...ok, newSha: "" })).toBeNull();
  });
  test("rejects a non-hex sha + wrong-length repoId", () => {
    expect(parsePushReceived({ ...ok, newSha: "nothex!" })).toBeNull();
    expect(parsePushReceived({ ...ok, repoId: "short" })).toBeNull();
  });
  test("rejects shell metacharacters + path traversal in ref/branch", () => {
    expect(parsePushReceived({ ...ok, branch: "a;rm -rf" })).toBeNull();
    expect(parsePushReceived({ ...ok, branch: "../evil" })).toBeNull();
    expect(parsePushReceived({ ...ok, ref: "refs/heads/../x" })).toBeNull();
    expect(parsePushReceived({ ...ok, ref: "refs/heads/a b" })).toBeNull();
  });
  test("rejects an all-zero SHA (a branch deletion)", () => {
    expect(parsePushReceived({ ...ok, newSha: "0".repeat(40) })).toBeNull();
    expect(parsePushReceived({ ...ok, newSha: "0".repeat(64) })).toBeNull();
  });
  test("rejects a non-branch ref (tags and other namespaces)", () => {
    expect(parsePushReceived({ ...ok, ref: "refs/tags/v1", branch: "v1" })).toBeNull();
    expect(parsePushReceived({ ...ok, ref: "refs/notes/commits", branch: "commits" })).toBeNull();
    // A bare branch name (no refs/heads/ prefix) is likewise rejected.
    expect(parsePushReceived({ ...ok, ref: "feat/x" })).toBeNull();
  });
});

describe("id + path helpers", () => {
  test("newRunId is unique + prefixed", () => {
    const a = newRunId();
    expect(a).toMatch(/^run_[0-9a-z]+_[0-9a-z]+$/);
    expect(newRunId()).not.toBe(a);
  });
  test("worktreePathFor nests under tmp/worktrees/<repoId>/<runId>", () => {
    expect(worktreePathFor("/tmp/ext", "abc", "run_1")).toBe("/tmp/ext/worktrees/abc/run_1");
  });
});

// ── createRunStore (channel-stubbed Storage) ────────────────────────

describe("createRunStore (Storage-backed)", () => {
  beforeEach(() => __resetChannelForTests());
  afterEach(() => __resetChannelForTests());

  /** Stub the channel's storage RPC with an in-memory map (get/set only). */
  function stubStorage(): Map<string, unknown> {
    const mem = new Map<string, unknown>();
    const ch = getChannel() as HostChannel;
    spyOn(ch, "request").mockImplementation((async (_method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      const key = `${p.scope}:${p.key}`;
      if (p.action === "set") {
        mem.set(key, p.value);
        return { ok: true, sizeBytes: 1 };
      }
      // get
      return mem.has(key) ? { value: mem.get(key), exists: true } : { value: null, exists: false };
    }) as HostChannel["request"]);
    return mem;
  }

  function rec(id: string, over: Partial<RunRecord> = {}): RunRecord {
    return {
      id,
      repoId: "0123456789ab",
      branch: "b",
      ref: "refs/heads/b",
      headSha: "deadbeef",
      status: "created",
      worktreePath: null,
      createdAt: "2026-07-15T08:00:00.000Z",
      updatedAt: "2026-07-15T08:00:00.000Z",
      parkedMs: 0,
      awaitingAgentSince: null,
      ...over,
    };
  }

  test("create + get round-trip; missing get → null", async () => {
    stubStorage();
    const store = createRunStore("global");
    await store.createRun(rec("r1"));
    expect((await store.getRun("r1"))!.id).toBe("r1");
    expect(await store.getRun("missing")).toBeNull();
  });

  test("updateRun merges + bumps updatedAt; missing → null", async () => {
    stubStorage();
    const store = createRunStore();
    await store.createRun(rec("r1"));
    const next = await store.updateRun("r1", { status: "completed" });
    expect(next!.status).toBe("completed");
    expect(next!.updatedAt).not.toBe("2026-07-15T08:00:00.000Z");
    expect(await store.updateRun("nope", { status: "failed" })).toBeNull();
  });

  test("listRuns returns index members newest-first (dedup on re-create)", async () => {
    stubStorage();
    const store = createRunStore();
    await store.createRun(rec("r1", { createdAt: "2026-07-15T08:00:00.000Z" }));
    await store.createRun(rec("r2", { createdAt: "2026-07-15T09:00:00.000Z" }));
    await store.createRun(rec("r1", { createdAt: "2026-07-15T08:00:00.000Z" })); // idempotent index
    const runs = await store.listRuns();
    expect(runs.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  test("listRuns tolerates an index entry whose run row vanished", async () => {
    const mem = stubStorage();
    const store = createRunStore();
    await store.createRun(rec("r1"));
    mem.delete("global:runs/r1"); // orphan the index entry
    expect(await store.listRuns()).toEqual([]);
  });

  test("empty store → [] (no index yet)", async () => {
    stubStorage();
    expect(await createRunStore().listRuns()).toEqual([]);
  });

  test("step_results round-trip; missing → null", async () => {
    stubStorage();
    const store = createRunStore();
    const step: StepResultRecord = {
      runId: "r1",
      step: "review",
      findings: emptyFindings(),
      agentPid: null,
      autoFixLimit: 0,
    };
    await store.putStepResult(step);
    expect((await store.getStepResult("r1", "review"))!.step).toBe("review");
    expect(await store.getStepResult("r1", "missing")).toBeNull();
  });
});

// ── runGateLifecycle (real git worktree) ────────────────────────────

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ezcf-runs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const git = (args: string[], cwd: string) => productionHostRunner(["git", ...args], cwd);

/** An in-memory RunStore for lifecycle tests (isolates the git behaviour). */
function memStore(): RunStore & { runs: Map<string, RunRecord> } {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, StepResultRecord>();
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
  };
}

/** Seed a bare gate repo holding one commit on `feat/x`; return its SHA. */
async function seedGate(): Promise<{ gateDir: string; sha: string; repoId: string }> {
  const src = join(root, "src");
  mkdirSync(src);
  await git(["init", "-b", "feat/x"], src);
  await git(["config", "user.email", "t@t"], src);
  await git(["config", "user.name", "t"], src);
  writeFileSync(join(src, "a.txt"), "hi\n");
  await git(["add", "-A"], src);
  await git(["commit", "-m", "c"], src);
  const gateDir = join(root, "gate.git");
  await git(["init", "--bare", gateDir], root);
  await git(["remote", "add", "gate", gateDir], src);
  await git(["push", "gate", "feat/x"], src);
  const rev = await git(["rev-parse", "feat/x"], src);
  return { gateDir, sha: rev.stdout.trim(), repoId: "0123456789ab" };
}

/** Seed a bare gate repo holding TWO branches (`feat/x`, `feat/y`); return both
 *  head SHAs. Used to exercise the per-(repo,branch) mutex across branches. */
async function seedGateTwo(): Promise<{
  gateDir: string;
  shaX: string;
  shaY: string;
  repoId: string;
}> {
  const src = join(root, "src2");
  mkdirSync(src);
  await git(["init", "-b", "feat/x"], src);
  await git(["config", "user.email", "t@t"], src);
  await git(["config", "user.name", "t"], src);
  writeFileSync(join(src, "a.txt"), "hi\n");
  await git(["add", "-A"], src);
  await git(["commit", "-m", "cx"], src);
  await git(["checkout", "-b", "feat/y"], src);
  writeFileSync(join(src, "b.txt"), "yo\n");
  await git(["add", "-A"], src);
  await git(["commit", "-m", "cy"], src);
  const gateDir = join(root, "gate2.git");
  await git(["init", "--bare", gateDir], root);
  await git(["remote", "add", "gate", gateDir], src);
  await git(["push", "gate", "feat/x"], src);
  await git(["push", "gate", "feat/y"], src);
  const rx = await git(["rev-parse", "feat/x"], src);
  const ry = await git(["rev-parse", "feat/y"], src);
  return { gateDir, shaX: rx.stdout.trim(), shaY: ry.stdout.trim(), repoId: "0123456789ab" };
}

/** Wrap a runner to count worktree-adds concurrently in flight. Each add holds
 *  a ~15ms window (a `Bun.sleep`) so a genuine overlap is observable; `maxIn`
 *  reports the peak. Under the per-(repo,branch) mutex, same-branch adds are
 *  strictly serial (peak 1); distinct branches may overlap (peak 2). */
function instrumentedRunner(real: ShellRunner): { runner: ShellRunner; maxIn: () => number } {
  let inFlight = 0;
  let maxInFlight = 0;
  const runner: ShellRunner = async (cmd, cwd, opts) => {
    if (cmd.includes("worktree") && cmd.includes("add")) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(15);
      const res = await real(cmd, cwd, opts);
      inFlight -= 1;
      return res;
    }
    return real(cmd, cwd, opts);
  };
  return { runner, maxIn: () => maxInFlight };
}

describe("runGateLifecycle (real git)", () => {
  test("creates a worktree at the pushed sha, records it, then tears it down", async () => {
    const { gateDir, sha, repoId } = await seedGate();
    const store = memStore();
    const tmpBase = join(root, "tmp");
    const changes: string[] = [];
    const res = await runGateLifecycle(
      { repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: sha },
      { gateDir, tmpBase, store, run: productionHostRunner, onChange: () => void changes.push("x") },
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe("completed");
    // The worktree was created then removed (never leaks a checkout).
    expect(existsSync(res.worktreePath)).toBe(false);
    // The run record reached `completed` and recorded the worktree path.
    const run = store.runs.get(res.runId)!;
    expect(run.status).toBe("completed");
    expect(run.headSha).toBe(sha);
    expect(run.worktreePath).toBe(res.worktreePath);
    // Containment: the worktree lived under tmpBase, the git dir under gateDir.
    expect(res.worktreePath.startsWith(tmpBase)).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
  });

  test("worktree-add failure marks the run failed without leaking a checkout", async () => {
    const { gateDir, repoId } = await seedGate();
    const store = memStore();
    const res = await runGateLifecycle(
      { repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: "0".repeat(40) },
      { gateDir, tmpBase: join(root, "tmp"), store, run: productionHostRunner },
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe("failed");
    expect(existsSync(res.worktreePath)).toBe(false);
    expect(store.runs.get(res.runId)!.status).toBe("failed");
  });

  test("falls back to `worktree prune` when `remove` fails", async () => {
    const { gateDir, sha, repoId } = await seedGate();
    const store = memStore();
    const calls: string[] = [];
    // Real git, except `worktree remove` fails → the prune fallback must run.
    const runner: ShellRunner = async (cmd, cwd, opts) => {
      calls.push(cmd.join(" "));
      if (cmd.includes("remove")) return { exitCode: 1, stdout: "", stderr: "locked" };
      return productionHostRunner(cmd, cwd, opts);
    };
    const res = await runGateLifecycle(
      { repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: sha },
      { gateDir, tmpBase: join(root, "tmp"), store, run: runner },
    );
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.includes("worktree remove"))).toBe(true);
    expect(calls.some((c) => c.includes("worktree prune"))).toBe(true);
  });

  test("concurrent pushes on the SAME branch serialize (both complete, 2 runs)", async () => {
    const { gateDir, sha, repoId } = await seedGate();
    const store = memStore();
    const push = { repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: sha };
    const deps = { gateDir, tmpBase: join(root, "tmp"), store, run: productionHostRunner };
    const [a, b] = await Promise.all([
      runGateLifecycle(push, deps),
      runGateLifecycle(push, deps),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.runId).not.toBe(b.runId);
    expect(store.runs.size).toBe(2);
  });

  test("a THROW mid-lifecycle marks the run failed + tears the worktree down", async () => {
    const { gateDir, sha, repoId } = await seedGate();
    const base = memStore();
    // updateRun throws exactly once — on the worktree_ready transition — so the
    // failure lands AFTER the worktree exists (proving teardown still runs). The
    // best-effort failed-mark that follows then succeeds.
    let thrown = false;
    const store: RunStore & { runs: Map<string, RunRecord> } = {
      ...base,
      async updateRun(id, patch) {
        if (!thrown && patch.status === "worktree_ready") {
          thrown = true;
          throw new Error("storage boom");
        }
        return base.updateRun(id, patch);
      },
    };
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      stderr.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    try {
      const res = await runGateLifecycle(
        { repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: sha },
        { gateDir, tmpBase: join(root, "tmp-throw"), store, run: productionHostRunner },
      );
      expect(res.ok).toBe(false);
      expect(res.status).toBe("failed");
      // The run was marked failed (the best-effort mark succeeded on retry)…
      expect(base.runs.get(res.runId)!.status).toBe("failed");
      // …the worktree was still torn down despite the throw…
      expect(existsSync(res.worktreePath)).toBe(false);
      // …and one stderr line surfaced the otherwise-swallowed error.
      expect(stderr.join("")).toContain("lifecycle error");
    } finally {
      spy.mockRestore();
    }
  });

  test("MUTEX PROOF: same-(repo,branch) worktree-adds never overlap (max in-flight 1)", async () => {
    const { gateDir, shaX, repoId } = await seedGateTwo();
    const store = memStore();
    const { runner, maxIn } = instrumentedRunner(productionHostRunner);
    const push = { repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: shaX };
    const deps = { gateDir, tmpBase: join(root, "tmp-same"), store, run: runner };
    const [a, b] = await Promise.all([runGateLifecycle(push, deps), runGateLifecycle(push, deps)]);
    expect(a.ok && b.ok).toBe(true);
    expect(store.runs.size).toBe(2);
    // The per-(repo,branch) lock kept the two worktree-adds strictly serial.
    // (Remove the lock and this becomes 2 — that is what the test guards.)
    expect(maxIn()).toBe(1);
  });

  test("MUTEX PROOF: different-branch worktree-adds run concurrently (overlap observed)", async () => {
    const { gateDir, shaX, shaY, repoId } = await seedGateTwo();
    const store = memStore();
    const { runner, maxIn } = instrumentedRunner(productionHostRunner);
    const deps = { gateDir, tmpBase: join(root, "tmp-diff"), store, run: runner };
    const [a, b] = await Promise.all([
      runGateLifecycle({ repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: shaX }, deps),
      runGateLifecycle({ repoId, branch: "feat/y", ref: "refs/heads/feat/y", newSha: shaY }, deps),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(store.runs.size).toBe(2);
    // Distinct locks → the two worktree-adds genuinely overlapped.
    expect(maxIn()).toBe(2);
  });

  test("containment: a sibling .ezcorp/data fixture is untouched by a run", async () => {
    const { gateDir, sha, repoId } = await seedGate();
    const store = memStore();
    // A fixture outside the worktree tree that must survive the run untouched.
    const fixtureDir = join(root, ".ezcorp", "data");
    mkdirSync(fixtureDir, { recursive: true });
    const fixture = join(fixtureDir, "keep.txt");
    writeFileSync(fixture, "precious");
    const res = await runGateLifecycle(
      { repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: sha },
      { gateDir, tmpBase: join(root, "tmp-contain"), store, run: productionHostRunner },
    );
    expect(res.ok).toBe(true);
    expect(existsSync(fixture)).toBe(true);
    expect(readFileSync(fixture, "utf8")).toBe("precious");
  });
});
