import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCiStep, type BaseBranchTip } from "./ci";
import { makeGit } from "../git";
import { defaultPipelineConfig } from "../config";
import { emptyRepoConfig } from "../repo-config";
import { makeRunShared, type StepContext } from "./common";
import type { ShellResult, ShellRunner } from "../shell";
import { productionHostRunner } from "../shell";
import type { GhRunner } from "../github";
import type { AgentDispatcher } from "../agent";

const ok = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" });
const gitErr = (): ShellResult => ({ exitCode: 1, stdout: "", stderr: "no" });

/** A gh runner scripted with per-poll queues for state/mergeable/checks. */
function fakeGh(cfg: {
  auth?: ShellResult;
  states?: string[];
  mergeables?: string[];
  checks?: Array<Array<Record<string, unknown>>>;
  runList?: ShellResult;
  runView?: ShellResult;
}): GhRunner {
  const states = [...(cfg.states ?? ["OPEN"])];
  const mergeables = [...(cfg.mergeables ?? ["MERGEABLE"])];
  const checks = [...(cfg.checks ?? [[]])];
  const shiftOrLast = <T>(q: T[]): T => (q.length > 1 ? q.shift()! : q[0]!);
  return async (args: string[]) => {
    if (args[0] === "auth") return cfg.auth ?? ok("");
    if (args[0] === "pr" && args[1] === "view") {
      if (args.includes("state")) return ok(shiftOrLast(states));
      if (args.includes("mergeable")) return ok(shiftOrLast(mergeables));
    }
    if (args[0] === "pr" && args[1] === "checks") return ok(JSON.stringify(shiftOrLast(checks)));
    if (args[0] === "run" && args[1] === "list") return cfg.runList ?? ok("[]");
    if (args[0] === "run" && args[1] === "view") return cfg.runView ?? ok("");
    return ok("");
  };
}

/** A "no-change" git runner: origin is GitHub, worktree clean, HEAD constant. */
const noChangeGit: ShellRunner = async (cmd: string[]) => {
  const a = cmd.slice(3);
  if (a[0] === "remote" && a[1] === "get-url") return ok("https://github.com/o/n.git");
  if (a[0] === "status") return ok(""); // clean
  if (a[0] === "rev-parse" && a[1] === "HEAD") return ok("deadbeef");
  if (a[0] === "merge-base") return gitErr();
  if (a[0] === "fetch") return ok("");
  return ok("");
};

interface CiCtxOptions {
  gh: GhRunner;
  git?: ShellRunner;
  jailed?: ShellRunner;
  ciTimeoutMs?: number;
  ciCap?: number;
  fixing?: boolean;
  prUrl?: string | null;
  dispatch?: () => Promise<{ output: null; text: string }>;
  intent?: string | null;
}

function makeCtx(opts: CiCtxOptions): { ctx: StepContext; logs: string[]; clock: { t: number } } {
  const logs: string[] = [];
  const clock = { t: 0 };
  const git = opts.git ?? noChangeGit;
  const jailed = opts.jailed ?? git;
  const config = defaultPipelineConfig();
  if (opts.ciTimeoutMs !== undefined) config.ciTimeoutMs = opts.ciTimeoutMs;
  if (opts.ciCap !== undefined) config.autoFixLimits.ci = opts.ciCap;
  const dispatcher: AgentDispatcher = {
    async dispatch() {
      return opts.dispatch ? opts.dispatch() : { output: null, text: "" };
    },
  };
  const ctx: StepContext = {
    worktree: "/wt",
    gateDir: "/gate.git",
    tmpBase: "/tmp",
    run: {
      id: "r1",
      branch: "feat/x",
      ref: "refs/heads/feat/x",
      headSha: "deadbeef",
      baseSha: "1234567",
      intent: opts.intent ?? null,
      intentSource: opts.intent ? "agent" : null,
      prUrl: opts.prUrl === undefined ? "https://github.com/o/n/pull/7" : opts.prUrl,
    },
    repo: { defaultBranch: "main", workingPath: "/proj" },
    config,
    repoConfig: emptyRepoConfig(),
    shared: makeRunShared(),
    fixing: opts.fixing ?? false,
    previousFindings: "",
    rounds: [],
    dispatcher,
    hostGit: makeGit(git, "/wt"),
    jailedGit: makeGit(jailed, "/wt"),
    hostRunner: git,
    gh: opts.gh,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    log: (m) => logs.push(m),
    updateHeadSha: async () => {},
    updatePrUrl: async () => {},
    loadStepHistory: async () => [],
  };
  return { ctx, logs, clock };
}

/** No base-branch re-arm (resolved:false). */
const noTip = async (): Promise<BaseBranchTip> => ({ sha: "", resolved: false });

const step = (over = {}) => makeCiStep({ baseBranchTip: noTip, pollIntervalMs: 1000, gracePeriodMs: 60_000, ...over });

// ── skip conditions ──────────────────────────────────────────────────

describe("ci skip conditions", () => {
  test("not GitHub → skip", async () => {
    const git: ShellRunner = async (cmd) => (cmd.slice(3)[0] === "remote" ? ok("https://gitlab.com/o/n") : ok(""));
    // PR URL is also non-GitHub, so the provider fallback stays unknown.
    const { ctx, logs } = makeCtx({ gh: fakeGh({}), git, prUrl: "https://gitlab.com/o/n/merge_requests/1" });
    expect(await step().execute(ctx)).toEqual({ skipped: true });
    expect(logs.join()).toContain("not a GitHub upstream");
  });
  test("unauthenticated → skip", async () => {
    const { ctx, logs } = makeCtx({ gh: fakeGh({ auth: gitErr() }) });
    expect(await step().execute(ctx)).toEqual({ skipped: true });
    expect(logs.join()).toContain("not authenticated");
  });
  test("no PR URL → skip", async () => {
    const { ctx, logs } = makeCtx({ gh: fakeGh({}), prUrl: null });
    expect(await step().execute(ctx)).toEqual({ skipped: true });
    expect(logs.join()).toContain("no PR URL");
  });
  test("unparseable PR URL → throws", async () => {
    const { ctx } = makeCtx({ gh: fakeGh({}), prUrl: "https://github.com/o/n/pull/notanumber" });
    await expect(step().execute(ctx)).rejects.toThrow("extract PR number");
  });
  test("provider falls back to the PR URL when origin is unreadable", async () => {
    const git: ShellRunner = async (cmd) => {
      const a = cmd.slice(3);
      if (a[0] === "remote") return gitErr(); // origin unreadable
      if (a[0] === "status") return ok("");
      if (a[0] === "rev-parse") return ok("deadbeef");
      if (a[0] === "merge-base") return gitErr();
      return ok("");
    };
    // states end MERGED so the loop terminates.
    const { ctx } = makeCtx({ gh: fakeGh({ states: ["OPEN", "MERGED"], checks: [[]] }), git });
    expect(await step().execute(ctx)).toEqual({});
  });
});

// ── happy paths ──────────────────────────────────────────────────────

describe("ci monitoring outcomes", () => {
  test("checks pass then PR merges → complete", async () => {
    const passing = [[{ name: "build", bucket: "pass", completedAt: "" }]];
    const { ctx, logs } = makeCtx({ gh: fakeGh({ states: ["OPEN", "OPEN", "MERGED"], checks: passing }) });
    expect(await step().execute(ctx)).toEqual({});
    expect(logs.join()).toContain("checks passed");
    expect(logs.join()).toContain("PR has been merged");
  });

  test("PR closed → complete", async () => {
    const { ctx, logs } = makeCtx({ gh: fakeGh({ states: ["CLOSED"] }) });
    expect(await step().execute(ctx)).toEqual({});
    expect(logs.join()).toContain("PR has been closed");
  });

  test("idle timeout with no checks → monitoring-timeout park", async () => {
    const { ctx, logs } = makeCtx({ gh: fakeGh({ states: ["OPEN"], checks: [[]] }), ciTimeoutMs: 2500 });
    const outcome = await step().execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(logs.join()).toContain("CI timeout reached");
  });

  test("unlimited timeout logs no-timeout and still completes on merge", async () => {
    const { ctx, logs } = makeCtx({ gh: fakeGh({ states: ["OPEN", "MERGED"] }), ciTimeoutMs: -1 });
    expect(await step().execute(ctx)).toEqual({});
    expect(logs.join()).toContain("no timeout");
  });

  test("empty-checks grace period logs 'waiting for checks to register'", async () => {
    // grace 5000 > pollInterval; first polls have elapsed < grace.
    const { ctx, logs } = makeCtx({
      gh: fakeGh({ states: ["OPEN", "OPEN", "MERGED"], checks: [[]] }),
      ciTimeoutMs: -1,
    });
    await makeCiStep({ baseBranchTip: noTip, pollIntervalMs: 1000, gracePeriodMs: 5000 }).execute(ctx);
    expect(logs.join()).toContain("waiting for checks to register");
  });

  test("empty checks after grace → 'no CI checks reported'", async () => {
    const { ctx, logs } = makeCtx({ gh: fakeGh({ states: ["OPEN", "MERGED"], checks: [[]] }), ciTimeoutMs: -1 });
    await makeCiStep({ baseBranchTip: noTip, pollIntervalMs: 1000, gracePeriodMs: 0 }).execute(ctx);
    expect(logs.join()).toContain("no CI checks reported");
  });

  test("pending checks with no failures → 'checks running'", async () => {
    const { ctx, logs } = makeCtx({
      gh: fakeGh({ states: ["OPEN", "MERGED"], checks: [[{ name: "b", bucket: "pending", completedAt: "" }]] }),
      ciTimeoutMs: -1,
    });
    await step().execute(ctx);
    expect(logs.join()).toContain("checks running");
  });
});

// ── transient-error tolerance ────────────────────────────────────────

describe("ci transient errors", () => {
  test("PR-state + mergeable + checks errors are tolerated (keep polling)", async () => {
    let poll = 0;
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      poll++;
      if (poll <= 3) return gitErr(); // first iteration: state/mergeable/checks all error
      if (args.includes("state")) return ok("MERGED");
      return ok("MERGEABLE");
    };
    const { ctx, logs } = makeCtx({ gh, ciTimeoutMs: -1 });
    expect(await step().execute(ctx)).toEqual({});
    expect(logs.join()).toContain("could not check PR state");
    expect(logs.join()).toContain("could not check mergeable state");
    expect(logs.join()).toContain("could not check CI");
  });

  test("pending mergeable sets a blocked reason; timeout → mergeability park", async () => {
    const gh = fakeGh({ states: ["OPEN"], mergeables: ["UNKNOWN"], checks: [[]] });
    const { ctx, logs } = makeCtx({ gh, ciTimeoutMs: 2500 });
    const outcome = await step().execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(logs.join()).toContain("mergeable state still pending");
    expect(logs.join()).toContain("CI timeout reached");
  });
});

// ── base-branch re-arm ───────────────────────────────────────────────

describe("ci idle-timeout re-arm on base-branch advance", () => {
  test("advancing base branch re-arms the timeout", async () => {
    const tips: BaseBranchTip[] = [
      { sha: "aaa", resolved: true },
      { sha: "bbb", resolved: true }, // advanced → re-arm
      { sha: "bbb", resolved: true },
    ];
    let i = 0;
    const baseBranchTip = async (): Promise<BaseBranchTip> => tips[Math.min(i++, tips.length - 1)]!;
    // A FINITE timeout so the re-arm block runs (skipped when unlimited); large
    // enough that the loop completes on MERGED before it fires.
    const { ctx, logs } = makeCtx({ gh: fakeGh({ states: ["OPEN", "OPEN", "MERGED"] }), ciTimeoutMs: 100_000 });
    await makeCiStep({ baseBranchTip, pollIntervalMs: 1000, gracePeriodMs: 0 }).execute(ctx);
    expect(logs.join()).toContain("re-arming CI monitor timeout");
  });
});

// ── auto-fix decision branches (no git changes) ──────────────────────

describe("ci auto-fix decisions", () => {
  const failing = [[{ name: "build", bucket: "fail", completedAt: "2026-07-16T00:00:00Z" }]];

  test("auto-fix disabled (cap 0) → park immediately", async () => {
    const { ctx, logs } = makeCtx({ gh: fakeGh({ states: ["OPEN"], checks: failing }), ciCap: 0, ciTimeoutMs: -1 });
    const outcome = await step().execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(logs.join()).toContain("auto-fix disabled");
  });

  test("auto-fix produces no changes → retries until cap, then parks", async () => {
    // Each poll re-reports the same failing check with a LATER completedAt so the
    // re-run detector clears the attempt marker and the retry path fires again.
    let t = 0;
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      if (args.includes("state")) return ok("OPEN");
      if (args.includes("mergeable")) return ok("MERGEABLE");
      if (args[1] === "checks") {
        t += 3600_000;
        return ok(JSON.stringify([{ name: "build", bucket: "fail", completedAt: new Date(t).toISOString() }]));
      }
      return ok("");
    };
    const { ctx, logs } = makeCtx({ gh, ciCap: 2, ciTimeoutMs: -1 });
    const outcome = await step().execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(logs.join()).toContain("auto-fixing (attempt 1/2)");
    expect(logs.join()).toContain("auto-fixing (attempt 2/2)");
    expect(logs.join()).toContain("max auto-fix attempts");
  });

  test("pending + issues → waits for checks to complete", async () => {
    const gh = fakeGh({
      states: ["OPEN", "MERGED"],
      checks: [[
        { name: "build", bucket: "fail", completedAt: "" },
        { name: "lint", bucket: "pending", completedAt: "" },
      ]],
    });
    const { ctx, logs } = makeCtx({ gh, ciTimeoutMs: -1 });
    await step().execute(ctx);
    expect(logs.join()).toContain("checks still pending");
  });

  test("manual fix (fixing) with no changes → returns for manual intervention", async () => {
    const { ctx, logs } = makeCtx({ gh: fakeGh({ states: ["OPEN"], checks: failing }), fixing: true, ciTimeoutMs: -1 });
    const outcome = await step().execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(logs.join()).toContain("manual fix requested");
    expect(logs.join()).toContain("produced no changes");
  });

  test("merge conflict alone → auto-fix path (no changes) parks at cap", async () => {
    const gh = fakeGh({ states: ["OPEN"], mergeables: ["CONFLICTING"], checks: [[]] });
    const { ctx, logs } = makeCtx({ gh, ciCap: 1, ciTimeoutMs: -1 });
    const outcome = await step().execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(logs.join()).toContain("merge conflict");
  });
});

// ── default base-branch-tip resolver ────────────────────────────────

describe("ci default baseBranchTip resolver", () => {
  test("fetch + rev-parse resolves the tip (no override)", async () => {
    const git: ShellRunner = async (cmd) => {
      const a = cmd.slice(3);
      if (a[0] === "remote") return ok("https://github.com/o/n.git");
      if (a[0] === "fetch") return ok("");
      if (a[0] === "rev-parse" && a.includes("HEAD")) return ok("deadbeef");
      if (a[0] === "rev-parse" && a[1] === "--verify") return ok("basetip"); // origin/main tip
      if (a[0] === "status") return ok("");
      if (a[0] === "merge-base") return gitErr();
      return ok("");
    };
    const { ctx, logs } = makeCtx({ gh: fakeGh({ states: ["OPEN", "MERGED"] }), git, ciTimeoutMs: 100_000 });
    // No baseBranchTip override → the default resolver runs.
    await makeCiStep({ pollIntervalMs: 1000, gracePeriodMs: 0 }).execute(ctx);
    expect(logs.join()).toContain("PR has been merged");
  });
  test("fetch failure → unresolved tip (no re-arm)", async () => {
    const git: ShellRunner = async (cmd) => {
      const a = cmd.slice(3);
      if (a[0] === "remote") return ok("https://github.com/o/n.git");
      if (a[0] === "fetch") return gitErr(); // fetch fails → resolved:false
      if (a[0] === "rev-parse" && a.includes("HEAD")) return ok("deadbeef");
      if (a[0] === "status") return ok("");
      if (a[0] === "merge-base") return gitErr();
      return ok("");
    };
    const { ctx } = makeCtx({ gh: fakeGh({ states: ["OPEN", "MERGED"] }), git, ciTimeoutMs: 100_000 });
    expect(await makeCiStep({ pollIntervalMs: 1000, gracePeriodMs: 0 }).execute(ctx)).toEqual({});
  });
});

// ── timeout WITH failing checks ─────────────────────────────────────

describe("ci timeout with known failures", () => {
  test("failing + pending checks until timeout → failure park", async () => {
    const gh = fakeGh({
      states: ["OPEN"],
      checks: [[
        { name: "build", bucket: "fail", completedAt: "" },
        { name: "lint", bucket: "pending", completedAt: "" },
      ]],
    });
    const { ctx, logs } = makeCtx({ gh, ciTimeoutMs: 2500 });
    const outcome = await step().execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(outcome.findings!).toContain("CI check failing: build");
    expect(logs.join()).toContain("CI timeout reached");
    expect(logs.join()).toContain("checks still pending");
  });
});

// ── auto-fix prompt variants + error handling (no-change fix) ────────

describe("ci auto-fix prompt + errors", () => {
  const failing = [[{ name: "build", bucket: "fail", completedAt: "2026-07-16T00:00:00Z" }]];

  test("failing + merge conflict → both-variant fix prompt", async () => {
    let prompt = "";
    const dispatcher: AgentDispatcher = {
      async dispatch(o) {
        prompt = (o as { prompt: string }).prompt;
        return { output: null, text: "" };
      },
    };
    const gh = fakeGh({ states: ["OPEN"], mergeables: ["CONFLICTING"], checks: failing });
    const { ctx } = makeCtx({ gh, ciCap: 1, ciTimeoutMs: -1 });
    ctx.dispatcher = dispatcher;
    await step().execute(ctx);
    expect(prompt).toContain("have failed and the PR has merge conflicts");
    expect(prompt).toContain("rebase target commit");
  });

  test("fetch-logs failure is tolerated (gh throws on run list)", async () => {
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      if (args.includes("state")) return ok("OPEN");
      if (args.includes("mergeable")) return ok("MERGEABLE");
      if (args[1] === "checks") return ok(JSON.stringify([{ name: "build", bucket: "fail", completedAt: "" }]));
      if (args[1] === "list") throw new Error("gh exploded");
      return ok("");
    };
    const { ctx, logs } = makeCtx({ gh, ciCap: 1, ciTimeoutMs: -1 });
    // Auto-fix disabled after one no-change attempt would loop; cap the loop with
    // a timeout so it parks. The point is the fetch-logs catch fired.
    ctx.config.ciTimeoutMs = 2500;
    await step().execute(ctx);
    expect(logs.join()).toContain("failed to fetch CI logs");
  });

  test("large CI logs are middle-truncated", async () => {
    const bigLog = "L".repeat(40 * 1024);
    let prompt = "";
    const dispatcher: AgentDispatcher = {
      async dispatch(o) {
        prompt = (o as { prompt: string }).prompt;
        return { output: null, text: "" };
      },
    };
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      if (args.includes("state")) return ok("OPEN");
      if (args.includes("mergeable")) return ok("MERGEABLE");
      if (args[1] === "checks") return ok(JSON.stringify([{ name: "build", bucket: "fail", completedAt: "" }]));
      if (args[1] === "list") return ok(JSON.stringify([{ databaseId: 1, name: "build" }]));
      if (args[1] === "view") return ok(bigLog);
      return ok("");
    };
    const { ctx } = makeCtx({ gh, ciCap: 1, ciTimeoutMs: -1 });
    ctx.dispatcher = dispatcher;
    await step().execute(ctx);
    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(bigLog.length);
  });

  test("agent dispatch failure aborts the step", async () => {
    const dispatcher: AgentDispatcher = {
      async dispatch() {
        throw new Error("model down");
      },
    };
    const gh = fakeGh({ states: ["OPEN"], checks: failing });
    const { ctx } = makeCtx({ gh, ciCap: 1, ciTimeoutMs: -1 });
    ctx.dispatcher = dispatcher;
    await expect(step().execute(ctx)).rejects.toThrow("agent CI fix");
  });
});

// ── reconcileApprovalGate ────────────────────────────────────────────

describe("reconcileApprovalGate", () => {
  test("merged → resolved", async () => {
    const { ctx } = makeCtx({ gh: fakeGh({ states: ["MERGED"] }) });
    expect(await step().reconcileApprovalGate!(ctx)).toEqual({ resolved: true });
  });
  test("closed → resolved", async () => {
    const { ctx } = makeCtx({ gh: fakeGh({ states: ["CLOSED"] }) });
    expect(await step().reconcileApprovalGate!(ctx)).toEqual({ resolved: true });
  });
  test("open → not resolved", async () => {
    const { ctx } = makeCtx({ gh: fakeGh({ states: ["OPEN"] }) });
    expect(await step().reconcileApprovalGate!(ctx)).toEqual({ resolved: false });
  });
  test("unknown state → throws", async () => {
    const { ctx } = makeCtx({ gh: fakeGh({ states: ["WEIRD"] }) });
    await expect(step().reconcileApprovalGate!(ctx)).rejects.toThrow("unresolved");
  });
  test("skip (not github) → throws", async () => {
    const git: ShellRunner = async (cmd) => (cmd.slice(3)[0] === "remote" ? ok("https://gitlab.com/o/n") : ok(""));
    const { ctx } = makeCtx({ gh: fakeGh({}), git, prUrl: "https://gitlab.com/o/n/merge_requests/1" });
    await expect(step().reconcileApprovalGate!(ctx)).rejects.toThrow("cannot check PR state");
  });
  test("no PR URL → throws", async () => {
    const { ctx } = makeCtx({ gh: fakeGh({ states: ["OPEN"] }), prUrl: null });
    await expect(step().reconcileApprovalGate!(ctx)).rejects.toThrow("no PR URL");
  });
  test("unparseable PR URL → throws", async () => {
    const { ctx } = makeCtx({ gh: fakeGh({ states: ["OPEN"] }), prUrl: "https://github.com/o/n/pull/xx" });
    await expect(step().reconcileApprovalGate!(ctx)).rejects.toThrow("extract PR number");
  });
});

// ── real-repo fix + guarded force-push ───────────────────────────────

describe("ci auto-fix commit + push (real git)", () => {
  let root: string;
  let work: string;
  let origin: string;

  const sh = (args: string[], cwd: string) => productionHostRunner(args, cwd);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cf-ci-"));
    origin = join(root, "origin.git");
    work = join(root, "work");
    await sh(["git", "init", "--bare", "-b", "main", origin], root);
    await sh(["git", "init", "-b", "main", work], root);
    await sh(["git", "-C", work, "config", "user.email", "t@t.com"], root);
    await sh(["git", "-C", work, "config", "user.name", "t"], root);
    await sh(["git", "-C", work, "config", "commit.gpgsign", "false"], root);
    await sh(["git", "-C", work, "remote", "add", "origin", `https://github.com/o/n.git`], root);
    // A real 'origin' for pushes uses a second remote name; the step pushes to
    // 'origin', so point origin's URL at the bare repo AFTER provider detection
    // reads the github URL... instead, use the bare path as origin and stub the
    // provider via the gh host (repo slug from the github PR URL).
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("dirty worktree → commit + guarded force-push (new branch)", async () => {
    // origin points at the bare repo so the real push lands there; the CI step
    // detects GitHub from the PR URL fallback (origin URL is the bare path).
    await sh(["git", "-C", work, "remote", "set-url", "origin", origin], root);
    writeFileSync(join(work, "a.txt"), "hello");
    await sh(["git", "-C", work, "add", "-A"], root);
    await sh(["git", "-C", work, "commit", "-m", "init"], root);
    const head = (await sh(["git", "-C", work, "rev-parse", "HEAD"], root)).stdout.trim();

    // The agent "fixes" by writing a new file → dirty worktree.
    const dispatcher: AgentDispatcher = {
      async dispatch() {
        writeFileSync(join(work, "fix.txt"), "patched");
        return { output: null, text: "" };
      },
    };
    const runner = productionHostRunner;
    const config = defaultPipelineConfig();
    config.autoFixLimits.ci = 1;
    config.ciTimeoutMs = -1;
    const clock = { t: 0 };
    const logs: string[] = [];
    // One failing poll (drives a fix), then MERGED so the loop completes.
    let polls = 0;
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      if (args.includes("state")) return ok(polls++ < 1 ? "OPEN" : "MERGED");
      if (args.includes("mergeable")) return ok("MERGEABLE");
      if (args[1] === "checks") return ok(JSON.stringify([{ name: "build", bucket: "fail", completedAt: "" }]));
      return ok("");
    };
    const ctx: StepContext = {
      worktree: work,
      gateDir: origin,
      tmpBase: "/tmp",
      run: {
        id: "r1",
        branch: "feat/x",
        ref: "refs/heads/feat/x",
        headSha: head,
        baseSha: "0".repeat(40),
        intent: null,
        intentSource: null,
        prUrl: "https://github.com/o/n/pull/7",
      },
      repo: { defaultBranch: "main", workingPath: work },
      config,
      repoConfig: emptyRepoConfig(),
      shared: makeRunShared(),
      fixing: false,
      previousFindings: "",
      rounds: [],
      dispatcher,
      hostGit: makeGit(runner, work),
      jailedGit: makeGit(runner, work),
      hostRunner: runner,
      gh,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: (m) => logs.push(m),
      updateHeadSha: async () => {},
      updatePrUrl: async () => {},
      loadStepHistory: async () => [],
    };
    const outcome = await makeCiStep({ baseBranchTip: noTip, pollIntervalMs: 1000, gracePeriodMs: 0 }).execute(ctx);
    expect(outcome).toEqual({}); // merged
    expect(logs.join()).toContain("committed and pushed fixes");
    // The fix commit landed on the branch in origin.
    const remoteBranch = (await sh(["git", "-C", origin, "rev-parse", "refs/heads/feat/x"], root)).stdout.trim();
    expect(remoteBranch).not.toBe(head);
  });

  test("clean worktree but HEAD advanced → up-to-date push (update-ref only)", async () => {
    await sh(["git", "-C", work, "remote", "set-url", "origin", origin], root);
    writeFileSync(join(work, "a.txt"), "hello");
    await sh(["git", "-C", work, "add", "-A"], root);
    await sh(["git", "-C", work, "commit", "-m", "init"], root);
    // Push the branch so the remote already carries HEAD (→ upToDate).
    await sh(["git", "-C", work, "push", "origin", "HEAD:refs/heads/feat/x"], root);
    const head = (await sh(["git", "-C", work, "rev-parse", "HEAD"], root)).stdout.trim();

    // Agent makes NO changes; run.headSha is stale (empty tree) so commitAndPush
    // takes the "no changes to commit" → headSha advanced → pushUpdatedHead path.
    const dispatcher: AgentDispatcher = { async dispatch() { return { output: null, text: "" }; } };
    const runner = productionHostRunner;
    const config = defaultPipelineConfig();
    config.autoFixLimits.ci = 1;
    config.ciTimeoutMs = -1;
    const clock = { t: 0 };
    const logs: string[] = [];
    let polls = 0;
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      if (args.includes("state")) return ok(polls++ < 1 ? "OPEN" : "MERGED");
      if (args.includes("mergeable")) return ok("MERGEABLE");
      if (args[1] === "checks") return ok(JSON.stringify([{ name: "build", bucket: "fail", completedAt: "" }]));
      return ok("");
    };
    let headUpdates = 0;
    const ctx: StepContext = {
      worktree: work,
      gateDir: origin,
      tmpBase: "/tmp",
      run: {
        id: "r1",
        branch: "feat/x",
        ref: "refs/heads/feat/x",
        headSha: "0000000000000000000000000000000000000000",
        baseSha: "0".repeat(40),
        intent: null,
        intentSource: null,
        prUrl: "https://github.com/o/n/pull/7",
      },
      repo: { defaultBranch: "main", workingPath: work },
      config,
      repoConfig: emptyRepoConfig(),
      shared: makeRunShared(),
      fixing: false,
      previousFindings: "",
      rounds: [],
      dispatcher,
      hostGit: makeGit(runner, work),
      jailedGit: makeGit(runner, work),
      hostRunner: runner,
      gh,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: (m) => logs.push(m),
      updateHeadSha: async () => {
        headUpdates++;
      },
      updatePrUrl: async () => {},
      loadStepHistory: async () => [],
    };
    const outcome = await makeCiStep({ baseBranchTip: noTip, pollIntervalMs: 1000, gracePeriodMs: 0 }).execute(ctx);
    expect(outcome).toEqual({});
    expect(headUpdates).toBeGreaterThanOrEqual(1); // headSha advanced to the real HEAD
    expect(ctx.run.headSha).toBe(head);
  });
});

// ── real-repo multi-poll: fix-pushed dedup + marker clearing ─────────

describe("ci fix-pushed dedup / marker clearing (real git)", () => {
  let root: string;
  let work: string;
  let origin: string;
  const sh = (args: string[], cwd: string) => productionHostRunner(args, cwd);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cf-ci2-"));
    origin = join(root, "origin.git");
    work = join(root, "work");
    await sh(["git", "init", "--bare", "-b", "main", origin], root);
    await sh(["git", "init", "-b", "main", work], root);
    await sh(["git", "-C", work, "config", "user.email", "t@t.com"], root);
    await sh(["git", "-C", work, "config", "user.name", "t"], root);
    await sh(["git", "-C", work, "config", "commit.gpgsign", "false"], root);
    await sh(["git", "-C", work, "remote", "add", "origin", origin], root);
    writeFileSync(join(work, "a.txt"), "hello");
    await sh(["git", "-C", work, "add", "-A"], root);
    await sh(["git", "-C", work, "commit", "-m", "init"], root);
    await sh(["git", "-C", work, "push", "origin", "HEAD:refs/heads/feat/x"], root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Build a real-repo CI ctx whose agent writes a unique file per fix (→ push). */
  async function realCtx(cfg: { gh: GhRunner; fixing?: boolean; ciCap?: number }): Promise<{
    ctx: StepContext;
    logs: string[];
  }> {
    const head = (await sh(["git", "-C", work, "rev-parse", "HEAD"], root)).stdout.trim();
    const logs: string[] = [];
    const clock = { t: 0 };
    const runner = productionHostRunner;
    const config = defaultPipelineConfig();
    config.autoFixLimits.ci = cfg.ciCap ?? 3;
    config.ciTimeoutMs = -1;
    let fixN = 0;
    const dispatcher: AgentDispatcher = {
      async dispatch() {
        writeFileSync(join(work, `fix-${fixN++}.txt`), "patched");
        return { output: null, text: "" };
      },
    };
    const ctx: StepContext = {
      worktree: work,
      gateDir: origin,
      tmpBase: "/tmp",
      run: {
        id: "r1",
        branch: "feat/x",
        ref: "refs/heads/feat/x",
        headSha: head,
        baseSha: head, // last-observed remote head = what we pushed
        intent: null,
        intentSource: null,
        prUrl: "https://github.com/o/n/pull/7",
      },
      repo: { defaultBranch: "main", workingPath: work },
      config,
      repoConfig: emptyRepoConfig(),
      shared: makeRunShared(),
      fixing: cfg.fixing ?? false,
      previousFindings: "",
      rounds: [],
      dispatcher,
      hostGit: makeGit(runner, work),
      jailedGit: makeGit(runner, work),
      hostRunner: runner,
      gh: cfg.gh,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: (m) => logs.push(m),
      updateHeadSha: async () => {},
      updatePrUrl: async () => {},
      loadStepHistory: async () => [],
    };
    return { ctx, logs };
  }

  const run = (ctx: StepContext) => makeCiStep({ baseBranchTip: noTip, pollIntervalMs: 1000, gracePeriodMs: 0 }).execute(ctx);

  test("manual fix (fixing) pushes then dedups the same issue until CI re-runs", async () => {
    let poll = 0;
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      // Two OPEN polls (fix, then dedup on the same fixKey), then MERGED.
      if (args.includes("state")) return ok(poll++ < 2 ? "OPEN" : "MERGED");
      if (args.includes("mergeable")) return ok("MERGEABLE");
      if (args[1] === "checks") return ok(JSON.stringify([{ name: "build", bucket: "fail", completedAt: "" }]));
      return ok("");
    };
    const { ctx, logs } = await realCtx({ gh, fixing: true });
    expect(await run(ctx)).toEqual({});
    expect(logs.join()).toContain("manual fix requested");
    expect(logs.join()).toContain("committed and pushed fixes");
    expect(logs.join()).toContain("fix already attempted for these issues");
  });

  test("same failing checks after a pushed fix → 'already attempted' dedup", async () => {
    let poll = 0;
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      if (args.includes("state")) return ok(poll < 2 ? "OPEN" : "MERGED");
      if (args.includes("mergeable")) return ok("MERGEABLE");
      if (args[1] === "checks") {
        poll++;
        // Same failing check, SAME completedAt (no re-run) across polls.
        return ok(JSON.stringify([{ name: "build", bucket: "fail", completedAt: "2026-07-16T00:00:00Z" }]));
      }
      return ok("");
    };
    const { ctx, logs } = await realCtx({ gh });
    expect(await run(ctx)).toEqual({});
    expect(logs.join()).toContain("auto-fixing (attempt 1/3)");
    expect(logs.join()).toContain("fix already attempted for these issues");
  });

  test("failing check re-completes after a pushed fix → attempt marker cleared", async () => {
    let poll = 0;
    const times = ["2026-07-16T00:00:00Z", "2026-07-16T01:00:00Z", "2026-07-16T02:00:00Z"];
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      if (args.includes("state")) return ok(poll < 2 ? "OPEN" : "MERGED");
      if (args.includes("mergeable")) return ok("MERGEABLE");
      if (args[1] === "checks") {
        const t = times[Math.min(poll, times.length - 1)]!;
        poll++;
        return ok(JSON.stringify([{ name: "build", bucket: "fail", completedAt: t }]));
      }
      return ok("");
    };
    const { ctx, logs } = await realCtx({ gh });
    expect(await run(ctx)).toEqual({});
    // A later completedAt clears the marker so a second attempt fires.
    expect(logs.join()).toContain("auto-fixing (attempt 2/3)");
  });

  test("pending check matching a pushed fix clears the stale marker", async () => {
    let poll = 0;
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return ok("");
      if (args.includes("state")) return ok(poll < 2 ? "OPEN" : "MERGED");
      if (args.includes("mergeable")) return ok("MERGEABLE");
      if (args[1] === "checks") {
        const p = poll++;
        if (p === 0) return ok(JSON.stringify([{ name: "build", bucket: "fail", completedAt: "" }]));
        // Poll 2: build is now pending + another check failing → pending match.
        return ok(JSON.stringify([
          { name: "build", bucket: "pending", completedAt: "" },
          { name: "other", bucket: "fail", completedAt: "" },
        ]));
      }
      return ok("");
    };
    const { ctx, logs } = await realCtx({ gh });
    expect(await run(ctx)).toEqual({});
    expect(logs.join()).toContain("checks still pending");
  });
});
