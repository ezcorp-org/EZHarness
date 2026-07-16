import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetChannelForTests, getChannel } from "@ezcorp/sdk/runtime";
import type { HostChannel } from "@ezcorp/sdk/runtime";
import {
  deserializeFinding,
  deserializeFindings,
  serializeFindings,
  emptyFindings,
  parsePushReceived,
  parseIntentOption,
  parseRespondPayload,
  newRunId,
  worktreePathFor,
  createRunStore,
  runGateLifecycle,
  resumeGateLifecycle,
  isTerminalRunStatus,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type StepResultRecord,
  type StepRoundRecord,
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

// ── deserializeFindings wire-shape acceptance ───────────────────────

describe("deserializeFindings accepts both wire shapes", () => {
  test("`findings` key wins over legacy `items`", () => {
    const f = deserializeFindings({
      findings: [{ action: "no-op", severity: "info", description: "new" }],
      items: [{ action: "no-op", severity: "info", description: "legacy" }],
    });
    expect(f.items).toHaveLength(1);
    expect(f.items[0]!.description).toBe("new");
  });
  test("an EMPTY `findings` falls back to a non-empty legacy `items` (length-based)", () => {
    // Presence-based precedence wrongly dropped f1 here; upstream is length-based
    // (`if len(items) == 0 && len(legacy) > 0 { items = legacy }`).
    const f = deserializeFindings({
      findings: [],
      items: [{ action: "no-op", severity: "info", description: "legacy" }],
    });
    expect(f.items).toHaveLength(1);
    expect(f.items[0]!.description).toBe("legacy");
  });
  test("camelCase scalars are accepted as a fallback", () => {
    const f = deserializeFindings({
      findings: [],
      testingSummary: "camel-ts",
      riskLevel: "high",
      riskRationale: "camel-rr",
    });
    expect(f.testingSummary).toBe("camel-ts");
    expect(f.riskLevel).toBe("high");
    expect(f.riskRationale).toBe("camel-rr");
  });
});

// ── parseIntentOption (untrusted push options) ──────────────────────

describe("parseIntentOption", () => {
  test("non-array → null; no intent= → null", () => {
    expect(parseIntentOption(undefined)).toBeNull();
    expect(parseIntentOption(["ci=skip"])).toBeNull();
  });
  test("skips non-string entries, returns first intent=", () => {
    expect(parseIntentOption([42, null, "intent=go"])).toBe("go");
  });
  test("caps an over-long intent at MAX_INTENT_LEN (4000)", () => {
    const long = "x".repeat(5000);
    const got = parseIntentOption([`intent=${long}`]);
    expect(got).not.toBeNull();
    expect(got!.length).toBe(4000);
  });
});

// ── serializeFindings ↔ deserializeFindings round-trip ──────────────

describe("serializeFindings", () => {
  test("emits the agent wire shape (findings key, snake_case) and round-trips", () => {
    const f = deserializeFindings({
      findings: [
        {
          id: "f1",
          severity: "warning",
          file: "a.ts",
          line: 3,
          description: "d",
          action: "auto-fix",
          source: "user",
          user_instructions: "please",
          category: "lint",
        },
      ],
      summary: "s",
      tested: ["t"],
      testing_summary: "ts",
      artifacts: ["art"],
      risk_level: "low",
      risk_rationale: "rr",
    });
    const wire = JSON.parse(serializeFindings(f));
    expect(wire.findings[0].id).toBe("f1");
    expect(wire.findings[0].user_instructions).toBe("please");
    expect(wire.findings[0].risk_level).toBeUndefined(); // scalar lives at top level
    expect(wire.risk_level).toBe("low");
    expect(wire.testing_summary).toBe("ts");
    // Re-parsing the wire yields an equivalent Findings.
    expect(deserializeFindings(wire)).toEqual(f);
  });
  test("omits empty optional fields", () => {
    const wire = JSON.parse(serializeFindings(emptyFindings()));
    expect(wire).toEqual({ findings: [], summary: "" });
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
  test("accepts a well-formed payload (intent null, oldSha defaults to zeros)", () => {
    expect(parsePushReceived(ok)).toEqual({ ...ok, oldSha: "0".repeat(40), intent: null });
  });
  test("extracts a valid oldSha; a malformed oldrev falls back to zeros", () => {
    const old = "1111111111111111111111111111111111111111";
    expect(parsePushReceived({ ...ok, oldSha: old })?.oldSha).toBe(old);
    expect(parsePushReceived({ ...ok, oldSha: "nothex" })?.oldSha).toBe("0".repeat(40));
  });
  test("extracts an explicit intent= push option", () => {
    expect(parsePushReceived({ ...ok, pushOptions: ["intent=fix the bug"] })?.intent).toBe(
      "fix the bug",
    );
    // First intent= wins; non-intent options ignored; blank → null.
    expect(
      parsePushReceived({ ...ok, pushOptions: ["ci=skip", "intent=  do X  ", "intent=later"] })
        ?.intent,
    ).toBe("do X");
    expect(parsePushReceived({ ...ok, pushOptions: ["intent="] })?.intent).toBeNull();
    expect(parsePushReceived({ ...ok, pushOptions: "not-an-array" })?.intent).toBeNull();
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
      baseSha: "0000000000000000",
      status: "created",
      worktreePath: null,
      createdAt: "2026-07-15T08:00:00.000Z",
      updatedAt: "2026-07-15T08:00:00.000Z",
      parkedMs: 0,
      awaitingAgentSince: null,
      intent: null,
      intentSource: null,
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
      status: "pending",
      findings: emptyFindings(),
      agentPid: null,
      autoFixLimit: 0,
      round: 0,
      autoFixAttempts: 0,
      executionMs: 0,
      fixSummary: null,
    };
    await store.putStepResult(step);
    expect((await store.getStepResult("r1", "review"))!.step).toBe("review");
    expect(await store.getStepResult("r1", "missing")).toBeNull();
  });

  test("step_rounds append / get / patch-last round-trip", async () => {
    stubStorage();
    const store = createRunStore();
    const round = (n: number): StepRoundRecord => ({
      runId: "r1",
      step: "review",
      round: n,
      trigger: "initial",
      findingsJson: null,
      userFindingsJson: null,
      selectedFindingIds: null,
      selectionSource: null,
      fixSummary: null,
      durationMs: 0,
    });
    // Empty until appended.
    expect(await store.getStepRounds("r1", "review")).toEqual([]);
    await store.appendStepRound(round(1));
    await store.appendStepRound(round(2));
    const rounds = await store.getStepRounds("r1", "review");
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
    // Patch the last round; a step with no rounds is a no-op.
    await store.patchLastStepRound("r1", "review", { selectionSource: "user" });
    expect((await store.getStepRounds("r1", "review"))[1]!.selectionSource).toBe("user");
    await store.patchLastStepRound("r1", "no-rounds", { selectionSource: "user" }); // no-op
    expect(await store.getStepRounds("r1", "no-rounds")).toEqual([]);
  });
});

// ── parseRespondPayload (untrusted gate action) ─────────────────────

describe("parseRespondPayload", () => {
  const ok = { runId: "run1", step: "review", action: "approve" };
  test("accepts a minimal valid payload (fix fields default empty)", () => {
    expect(parseRespondPayload(ok)).toEqual({
      runId: "run1",
      step: "review",
      action: "approve",
      findingIds: [],
      instructions: {},
      addedFindings: [],
    });
  });
  test("carries findingIds, instructions, and addedFindings for a fix", () => {
    const got = parseRespondPayload({
      ...ok,
      action: "fix",
      findingIds: ["f1", 2, "f2"],
      instructions: { f1: "do X", bad: 5 },
      addedFindings: [{ description: "extra" }],
    })!;
    expect(got.findingIds).toEqual(["f1", "f2"]);
    expect(got.instructions).toEqual({ f1: "do X" });
    expect(got.addedFindings).toHaveLength(1);
  });
  test("rejects non-objects, blank runId, unknown step, unknown action", () => {
    expect(parseRespondPayload(null)).toBeNull();
    expect(parseRespondPayload("x")).toBeNull();
    expect(parseRespondPayload({ ...ok, runId: "" })).toBeNull();
    expect(parseRespondPayload({ ...ok, step: "bogus" })).toBeNull();
    expect(parseRespondPayload({ ...ok, action: "nuke" })).toBeNull();
  });
  test("ignores a non-object instructions field", () => {
    expect(parseRespondPayload({ ...ok, instructions: "nope" })!.instructions).toEqual({});
  });

  // ── size caps (defence-in-depth: the payload is attacker-reachable) ──
  test("rejects an over-cap findingIds count; accepts at the limit", () => {
    const many = Array.from({ length: 201 }, (_, i) => `f${i}`);
    expect(parseRespondPayload({ ...ok, action: "fix", findingIds: many })).toBeNull();
    expect(parseRespondPayload({ ...ok, action: "fix", findingIds: many.slice(0, 200) })).not.toBeNull();
  });
  test("rejects an over-long per-finding instruction; accepts at the limit", () => {
    const longNote = "x".repeat(4001);
    expect(parseRespondPayload({ ...ok, action: "fix", instructions: { f1: longNote } })).toBeNull();
    expect(
      parseRespondPayload({ ...ok, action: "fix", instructions: { f1: longNote.slice(0, 4000) } }),
    ).not.toBeNull();
  });
  test("rejects an over-cap addedFindings count; accepts at the limit", () => {
    const many = Array.from({ length: 101 }, () => ({ description: "x" }));
    expect(parseRespondPayload({ ...ok, action: "fix", addedFindings: many })).toBeNull();
    expect(parseRespondPayload({ ...ok, action: "fix", addedFindings: many.slice(0, 100) })).not.toBeNull();
  });
  test("rejects an over-long added-finding description or user_instructions", () => {
    const longField = "y".repeat(4001);
    expect(parseRespondPayload({ ...ok, action: "fix", addedFindings: [{ description: longField }] })).toBeNull();
    expect(
      parseRespondPayload({ ...ok, action: "fix", addedFindings: [{ user_instructions: longField }] }),
    ).toBeNull();
    expect(
      parseRespondPayload({ ...ok, action: "fix", addedFindings: [{ description: longField.slice(0, 4000) }] }),
    ).not.toBeNull();
  });
  test("non-object addedFindings entries pass the size check (no field to measure)", () => {
    expect(parseRespondPayload({ ...ok, action: "fix", addedFindings: [null, "x", 5] })).not.toBeNull();
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

  test("a pipeline that reaches a terminal state (not parked) tears the worktree down here", async () => {
    const { gateDir, sha, repoId } = await seedGate();
    const store = memStore();
    let ran = false;
    const res = await runGateLifecycle(
      { repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: sha },
      {
        gateDir,
        tmpBase: join(root, "tmp-terminal"),
        store,
        run: productionHostRunner,
        // The pipeline runs, marks the run completed, and does NOT park → the
        // lifecycle reads the final status and tears the worktree down here.
        runPipeline: async ({ runId }) => {
          ran = true;
          await store.updateRun(runId, { status: "completed" });
          return { parked: false };
        },
      },
    );
    expect(ran).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.status).toBe("completed");
    // Not parked → the worktree was released (not kept for a human).
    expect(existsSync(res.worktreePath)).toBe(false);
    expect(store.runs.get(res.runId)!.status).toBe("completed");
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

// ── resumeGateLifecycle (teardown keys off the PERSISTED status) ────

describe("isTerminalRunStatus", () => {
  test("completed/failed/aborted are terminal; every other status is not", () => {
    const expected: Record<RunStatus, boolean> = {
      created: false,
      worktree_ready: false,
      running: false,
      awaiting_approval: false,
      completed: true,
      failed: true,
      aborted: true,
    };
    for (const [status, terminal] of Object.entries(expected)) {
      expect(isTerminalRunStatus(status as RunStatus)).toBe(terminal);
    }
  });
});

describe("resumeGateLifecycle (real git)", () => {
  /** Drive a push through runGateLifecycle with a pipeline that PARKS, leaving
   *  the run awaiting_approval with its worktree kept on disk (the real M1
   *  parked shape a respond later resumes). */
  async function seedParkedLifecycle(store: RunStore & { runs: Map<string, RunRecord> }) {
    const { gateDir, sha, repoId } = await seedGate();
    const res = await runGateLifecycle(
      { repoId, branch: "feat/x", ref: "refs/heads/feat/x", newSha: sha },
      {
        gateDir,
        tmpBase: join(root, "tmp-resume"),
        store,
        run: productionHostRunner,
        runPipeline: async ({ runId }) => {
          await store.updateRun(runId, { status: "awaiting_approval" });
          return { parked: true };
        },
      },
    );
    expect(res.status).toBe("awaiting_approval");
    expect(existsSync(res.worktreePath)).toBe(true);
    return { gateDir, runId: res.runId, worktreePath: res.worktreePath };
  }

  test("CRITICAL regression: a REJECTED respond is side-effect-free — the kept worktree survives and a later correct respond still resumes", async () => {
    const store = memStore();
    const { gateDir, runId, worktreePath } = await seedParkedLifecycle(store);

    // A stale dashboard responds to the wrong step: respondToGate REJECTS it
    // ({status:"failed"}) without touching the run — which stays parked.
    const rejected = await resumeGateLifecycle(runId, {
      gateDir,
      store,
      run: productionHostRunner,
      respond: async () => ({ parked: false }),
    });
    expect(rejected).toEqual({ status: "awaiting_approval", parked: true });
    // The kept worktree MUST survive a rejected respond…
    expect(existsSync(worktreePath)).toBe(true);
    expect(store.runs.get(runId)!.worktreePath).toBe(worktreePath);

    // …so the RIGHT respond can still resume the run to a terminal state,
    // which is what finally releases the checkout.
    const changes: string[] = [];
    const resumed = await resumeGateLifecycle(runId, {
      gateDir,
      store,
      run: productionHostRunner,
      onChange: () => void changes.push("x"),
      respond: async () => {
        await store.updateRun(runId, { status: "completed" });
        return { parked: false };
      },
    });
    expect(resumed).toEqual({ status: "completed", parked: false });
    expect(existsSync(worktreePath)).toBe(false);
    expect(changes.length).toBe(1);
  });

  test("a respond that THROWS while the run is still parked keeps the worktree", async () => {
    const store = memStore();
    const { gateDir, runId, worktreePath } = await seedParkedLifecycle(store);
    await expect(
      resumeGateLifecycle(runId, {
        gateDir,
        store,
        run: productionHostRunner,
        respond: async () => {
          throw new Error("respond boom");
        },
      }),
    ).rejects.toThrow("respond boom");
    // Still parked → the kept worktree survives the throw.
    expect(store.runs.get(runId)!.status).toBe("awaiting_approval");
    expect(existsSync(worktreePath)).toBe(true);
  });

  test("an unreadable store at teardown time KEEPS the worktree (doubt = keep)", async () => {
    const base = memStore();
    const { gateDir, runId, worktreePath } = await seedParkedLifecycle(base);
    // getRun succeeds for the initial load, then the store goes dark for the
    // post-respond re-read — teardown must not fire on an unknown state.
    let reads = 0;
    const store: RunStore & { runs: Map<string, RunRecord> } = {
      ...base,
      async getRun(id) {
        reads += 1;
        if (reads > 1) throw new Error("storage dark");
        return base.getRun(id);
      },
    };
    const res = await resumeGateLifecycle(runId, {
      gateDir,
      store,
      run: productionHostRunner,
      respond: async () => {
        await base.updateRun(runId, { status: "completed" });
        return { parked: false };
      },
    });
    // Unknown persisted state → report failed, but KEEP the checkout: a leaked
    // worktree is recoverable, a destroyed kept one is not.
    expect(res).toEqual({ status: "failed", parked: false });
    expect(existsSync(worktreePath)).toBe(true);
  });

  test("a persisted aborted state releases the worktree", async () => {
    const store = memStore();
    const { gateDir, runId, worktreePath } = await seedParkedLifecycle(store);
    const res = await resumeGateLifecycle(runId, {
      gateDir,
      store,
      run: productionHostRunner,
      respond: async () => {
        await store.updateRun(runId, { status: "aborted" });
        return { parked: false };
      },
    });
    expect(res).toEqual({ status: "aborted", parked: false });
    expect(existsSync(worktreePath)).toBe(false);
  });
});
