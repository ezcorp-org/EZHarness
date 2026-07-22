import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionHostRunner, type ShellRunner } from "./shell";
import { makeGit } from "./git";
import { defaultPipelineConfig } from "./config";
import { emptyRepoConfig } from "./repo-config";
import type { AgentDispatcher, DispatchOptions, DispatchResult } from "./agent";
import {
  normalizedBranchRef,
  bareBranchName,
  deterministicFixCommitMessage,
  intentIsAuthoritative,
  resolveBranchBaseSHA,
  resolveBaseSHA,
  mergeBaseWithDefaultBranch,
  assertPipelineHeadContinuity,
  HeadContinuityError,
  commitAgentFixes,
  extractCommitSummary,
  executeFixMode,
  gitAt,
  makeRunShared,
  type StepContext,
  type RunView,
} from "./steps/common";
import { intentStep } from "./steps/intent";
import { rebaseStep } from "./steps/rebase";
import { reviewStep, matchIgnorePattern } from "./steps/review";
import { pushStep, resolveForcePushDecision, remoteCommitsNotIncorporated, ForcePushWouldDiscardError } from "./steps/push";
import { serializeFindings, deserializeFindings } from "./runs";

// ── git fixture helpers ─────────────────────────────────────────────

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

/** A dispatcher whose behaviour each test controls; records the prompts it saw. */
interface FakeDispatcher extends AgentDispatcher {
  calls: DispatchOptions[];
}
function fakeDispatcher(impl: (opts: DispatchOptions) => Promise<DispatchResult> | DispatchResult): FakeDispatcher {
  const calls: DispatchOptions[] = [];
  return {
    calls,
    async dispatch(opts) {
      calls.push(opts);
      return impl(opts);
    },
  };
}

interface CtxOverrides {
  run?: Partial<RunView>;
  repo?: Partial<StepContext["repo"]>;
  fixing?: boolean;
  previousFindings?: string;
  rounds?: StepContext["rounds"];
  dispatcher?: AgentDispatcher;
  gateDir?: string;
  jailedRunner?: ShellRunner;
  hostRunner?: ShellRunner;
  config?: StepContext["config"];
  repoConfig?: StepContext["repoConfig"];
  shared?: StepContext["shared"];
  tmpBase?: string;
}

function makeCtx(worktree: string, headSha: string, over: CtxOverrides = {}): {
  ctx: StepContext;
  logs: string[];
  headUpdates: string[];
} {
  const logs: string[] = [];
  const headUpdates: string[] = [];
  const hostRunner = over.hostRunner ?? productionHostRunner;
  const jailedRunner = over.jailedRunner ?? productionHostRunner;
  const ctx: StepContext = {
    worktree,
    gateDir: over.gateDir ?? worktree,
    tmpBase: over.tmpBase ?? "/tmp",
    run: {
      id: "r1",
      branch: "feat/x",
      ref: "refs/heads/feat/x",
      headSha,
      baseSha: headSha,
      intent: null,
      intentSource: null,
      prUrl: null,
      ...over.run,
    },
    repo: { defaultBranch: "main", workingPath: "", ...over.repo },
    config: over.config ?? defaultPipelineConfig(),
    repoConfig: over.repoConfig ?? emptyRepoConfig(),
    shared: over.shared ?? makeRunShared(),
    fixing: over.fixing ?? false,
    previousFindings: over.previousFindings ?? "",
    rounds: over.rounds ?? [],
    dispatcher: over.dispatcher ?? fakeDispatcher(() => ({ output: { summary: "did it" }, text: "" })),
    hostGit: makeGit(hostRunner, worktree),
    jailedGit: makeGit(jailedRunner, worktree),
    hostRunner,
    gh: async () => ({ exitCode: 127, stdout: "", stderr: "gh not wired" }),
    now: () => 0,
    sleep: async () => {},
    log: (m) => logs.push(m),
    updateHeadSha: async (sha) => {
      headUpdates.push(sha);
    },
    updatePrUrl: async () => {},
    loadStepHistory: async () => [],
  };
  return { ctx, logs, headUpdates };
}

// ── intent step ─────────────────────────────────────────────────────

describe("intentStep", () => {
  test("explicit intent → no-op {} and logs it", async () => {
    const { ctx, logs } = makeCtx("/wt", "abc", { run: { intent: "add a flag" } });
    expect(await intentStep.execute(ctx)).toEqual({});
    expect(logs.join()).toContain("using intent supplied by the agent");
  });
  test("blank / absent intent → skipped", async () => {
    const { ctx: c1 } = makeCtx("/wt", "abc", { run: { intent: "   " } });
    expect(await intentStep.execute(c1)).toEqual({ skipped: true });
    const { ctx: c2, logs } = makeCtx("/wt", "abc", { run: { intent: null } });
    expect(await intentStep.execute(c2)).toEqual({ skipped: true });
    expect(logs.join()).toContain("inference lands in M5");
  });
});

// ── pure common helpers ─────────────────────────────────────────────

describe("common pure helpers", () => {
  test("normalizedBranchRef", () => {
    expect(normalizedBranchRef("feat/x")).toBe("refs/heads/feat/x");
    expect(normalizedBranchRef("refs/heads/main")).toBe("refs/heads/main");
  });
  test("bareBranchName strips a leading refs/heads/ (inverse of normalizedBranchRef)", () => {
    expect(bareBranchName("refs/heads/feat/x")).toBe("feat/x");
    expect(bareBranchName("feat/x")).toBe("feat/x");
  });
  test("deterministicFixCommitMessage renames the prefix", () => {
    expect(deterministicFixCommitMessage("review", "fix a bug")).toBe("ez-code-factory(review): fix a bug");
    expect(deterministicFixCommitMessage("push", "")).toBe("ez-code-factory(push): apply fixes");
  });
  test("intentIsAuthoritative only for source 'agent'", () => {
    expect(intentIsAuthoritative({ intentSource: "agent" } as RunView)).toBe(true);
    expect(intentIsAuthoritative({ intentSource: "claude" } as RunView)).toBe(false);
    expect(intentIsAuthoritative({ intentSource: null } as RunView)).toBe(false);
  });
  test("extractCommitSummary parses + cleans; missing → ''", () => {
    expect(extractCommitSummary({ output: { summary: "  fix   the\tbug. " }, text: "" })).toBe("fix the bug");
    expect(extractCommitSummary({ output: null, text: "x" })).toBe("");
    expect(extractCommitSummary({ output: { summary: 42 }, text: "" })).toBe("");
  });
});

// ── base-SHA resolution + head-continuity + commit (real git) ───────

describe("common git helpers (real repo)", () => {
  let dir: string;
  let c1: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ezcf-common-"));
    await initRepo(dir);
    c1 = await commit(dir, "a.txt", "one\n", "c1");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("mergeBaseWithDefaultBranch → '' when no such ref; resolveBaseSHA falls back to empty tree", async () => {
    const g = makeGit(productionHostRunner, dir);
    expect(await mergeBaseWithDefaultBranch(g, "")).toBe("");
    expect(await resolveBaseSHA(g, "0".repeat(40), "nope")).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(await resolveBaseSHA(g, c1, "main")).toBe(c1);
  });
  test("resolveBranchBaseSHA uses merge-base when available", async () => {
    // A second branch off c1, then main advances: merge-base(HEAD, main) is c1.
    await sh(["git", "checkout", "-b", "feat"], dir);
    await commit(dir, "b.txt", "b\n", "cb");
    await sh(["git", "checkout", "main"], dir);
    await commit(dir, "c.txt", "c\n", "cc");
    await sh(["git", "checkout", "feat"], dir);
    const g = makeGit(productionHostRunner, dir);
    expect(await resolveBranchBaseSHA(g, c1, "main")).toBe(c1);
  });

  test("C2 pin: a first-fire synthesized run (ZERO base) resolves to merge-base, NOT the full tree", async () => {
    // A synthesized run's FIRST fire carries no bookkept head, so index.ts's
    // runJobLifecycle passes `oldSha: "0"*40` (the documented C2 divergence). The
    // pipeline never trusts that base as-is: resolveBranchBaseSHA prefers the real
    // merge-base, so review/lint/document/ci/rebase diff against the merge-base —
    // NOT the empty tree (which would diff the WHOLE branch). This pins the
    // divergence's safety claim both validators confirmed.
    await sh(["git", "checkout", "-b", "feat2"], dir);
    await commit(dir, "b2.txt", "b\n", "cb2");
    await sh(["git", "checkout", "main"], dir);
    await commit(dir, "c2.txt", "c\n", "cc2");
    await sh(["git", "checkout", "feat2"], dir);
    const g = makeGit(productionHostRunner, dir);
    const base = await resolveBranchBaseSHA(g, "0".repeat(40), "main");
    // The true merge-base (c1), never the empty-tree fallback.
    expect(base).toBe(c1);
    expect(base).not.toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  test("assertPipelineHeadContinuity: equal + forward OK; divergent + backward abort; empty recorded OK", async () => {
    const c2 = await commit(dir, "a.txt", "two\n", "c2");
    const { ctx } = makeCtx(dir, c2);
    // equal
    await assertPipelineHeadContinuity(ctx, "review");
    // forward: recorded c1, live c2 (c1 ancestor of c2) → OK
    ctx.run.headSha = c1;
    await assertPipelineHeadContinuity(ctx, "review");
    // empty recorded → OK
    ctx.run.headSha = "";
    await assertPipelineHeadContinuity(ctx, "review");
    // backward: recorded c2, reset live HEAD to c1 → not descendant → abort
    await sh(["git", "reset", "--hard", c1], dir);
    ctx.run.headSha = c2;
    await expect(assertPipelineHeadContinuity(ctx, "review")).rejects.toBeInstanceOf(HeadContinuityError);
  });

  test("commitAgentFixes: clean → no-op; dirty → commits, advances head, updates ref", async () => {
    const { ctx, logs, headUpdates } = makeCtx(dir, c1);
    await commitAgentFixes(ctx, "review", "s", "fallback");
    expect(logs.join()).toContain("no agent changes to commit");
    // Now dirty the worktree (simulating an agent fix) and commit.
    writeFileSync(join(dir, "a.txt"), "edited\n");
    await commitAgentFixes(ctx, "review", "cleaned it up", "fallback");
    const log = (await sh(["git", "log", "-1", "--pretty=%s"], dir)).stdout.trim();
    expect(log).toBe("ez-code-factory(review): cleaned it up");
    expect(ctx.run.headSha).not.toBe(c1);
    expect(headUpdates).toHaveLength(1);
  });

  test("commitAgentFixes uses the fallback summary when the agent gave none", async () => {
    const { ctx } = makeCtx(dir, c1);
    writeFileSync(join(dir, "a.txt"), "edited2\n");
    await commitAgentFixes(ctx, "review", "", "address review findings");
    const log = (await sh(["git", "log", "-1", "--pretty=%s"], dir)).stdout.trim();
    expect(log).toBe("ez-code-factory(review): address review findings");
  });

  test("gitAt binds host git to another dir", async () => {
    const { ctx } = makeCtx(dir, c1);
    const g = gitAt(ctx, dir);
    expect(await g.headSha()).toBe(c1);
  });
});

// ── executeFixMode ──────────────────────────────────────────────────

describe("executeFixMode", () => {
  let dir: string;
  let c1: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ezcf-fix-"));
    await initRepo(dir);
    c1 = await commit(dir, "a.txt", "one\n", "c1");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("not fixing → '' (no dispatch)", async () => {
    const { ctx } = makeCtx(dir, c1, { fixing: false });
    expect(await executeFixMode(ctx, "review", opts())).toBe("");
  });
  test("requirePreviousFindings with none → throws the configured error", async () => {
    const { ctx } = makeCtx(dir, c1, { fixing: true, previousFindings: "" });
    await expect(
      executeFixMode(ctx, "review", { ...opts(), requirePreviousFindings: true, missingFindingsError: "need findings" }),
    ).rejects.toThrow("need findings");
  });
  test("dispatch error → wrapped with errorPrefix", async () => {
    const { ctx } = makeCtx(dir, c1, {
      fixing: true,
      previousFindings: "x",
      dispatcher: fakeDispatcher(() => {
        throw new Error("boom");
      }),
    });
    await expect(
      executeFixMode(ctx, "review", { ...opts(), errorPrefix: "agent fix" }),
    ).rejects.toThrow("agent fix: boom");
  });
  test("success: agent edits the worktree, changes are committed, summary returned", async () => {
    const { ctx } = makeCtx(dir, c1, {
      fixing: true,
      previousFindings: "prev",
      dispatcher: fakeDispatcher(() => {
        writeFileSync(join(dir, "a.txt"), "agent edited\n");
        return { output: { summary: "tightened validation" }, text: "" };
      }),
    });
    const summary = await executeFixMode(ctx, "review", opts());
    expect(summary).toBe("tightened validation");
    const log = (await sh(["git", "log", "-1", "--pretty=%s"], dir)).stdout.trim();
    expect(log).toBe("ez-code-factory(review): tightened validation");
  });
});

function opts() {
  return {
    prompt: "fix it",
    errorPrefix: "agent fix",
    fallbackSummary: "address findings",
    role: "fixer" as const,
    jsonSchema: { type: "object" },
  };
}

// ── rebase step (real remotes) ──────────────────────────────────────

/** A bare "upstream" seeded with one main commit. */
async function setupUpstream(dirs: string[]): Promise<{ upstream: string; mainSha: string }> {
  const upstream = mkdtempSync(join(tmpdir(), "ezcf-up-"));
  dirs.push(upstream);
  await sh(["git", "init", "--bare", "-b", "main", upstream], upstream);
  const seed = mkdtempSync(join(tmpdir(), "ezcf-seed-"));
  dirs.push(seed);
  await sh(["git", "clone", upstream, seed], seed);
  await initConfig(seed);
  const mainSha = await commit(seed, "README.md", "# seed\n", "seed");
  await sh(["git", "push", "origin", "HEAD:refs/heads/main"], seed);
  return { upstream, mainSha };
}

async function initConfig(dir: string): Promise<void> {
  await sh(["git", "config", "user.email", "t@t.com"], dir);
  await sh(["git", "config", "user.name", "t"], dir);
  await sh(["git", "config", "commit.gpgsign", "false"], dir);
}

/** Clone the upstream into a fresh worktree dir with origin wired. */
async function cloneWorktree(upstream: string, dirs: string[]): Promise<string> {
  const wt = mkdtempSync(join(tmpdir(), "ezcf-wt-"));
  dirs.push(wt);
  await sh(["git", "clone", upstream, wt], wt);
  await initConfig(wt);
  return wt;
}

/** Advance the upstream default branch out of band (a second clone pushes). */
async function advanceUpstreamMain(upstream: string, dirs: string[], file: string, content: string): Promise<string> {
  const other = mkdtempSync(join(tmpdir(), "ezcf-other-"));
  dirs.push(other);
  await sh(["git", "clone", upstream, other], other);
  await initConfig(other);
  const sha = await commit(other, file, content, "advance main");
  await sh(["git", "push", "origin", "HEAD:refs/heads/main"], other);
  return sha;
}

describe("rebaseStep (real remotes)", () => {
  let dirs: string[];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("clean rebase of a unique commit onto an advanced main → updates head, no skip", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "feature.txt", "mine\n", "add feature");
    await advanceUpstreamMain(upstream, dirs, "other.txt", "theirs\n"); // disjoint file → no conflict
    const { ctx, headUpdates } = makeCtx(wt, b, { run: { baseSha: b } });
    const outcome = await rebaseStep.execute(ctx);
    expect(outcome.skipRemaining).toBeUndefined();
    expect(headUpdates.length).toBe(1);
    // The branch now contains BOTH the advanced main file and the feature.
    const files = (await sh(["git", "ls-files"], wt)).stdout;
    expect(files).toContain("feature.txt");
    expect(files).toContain("other.txt");
  });

  test("conflict → PARKS ask-user (needsApproval, NOT autoFixable)", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "README.md", "# mine\n", "edit readme");
    await advanceUpstreamMain(upstream, dirs, "README.md", "# theirs\n"); // same file → conflict
    const { ctx } = makeCtx(wt, b, { run: { baseSha: b } });
    const outcome = await rebaseStep.execute(ctx);
    // Park-first parity (upstream rebase.go): the FIRST conflict round parks for a
    // human — it must NOT flag autoFixable, and the finding's fail-closed default
    // action must be ask-user (never auto-fix). Auto-resolution only runs later
    // under sctx.fixing, after a human "fix" response.
    expect(outcome.needsApproval).toBe(true);
    expect(outcome.autoFixable).toBeUndefined();
    const findings = deserializeFindings(JSON.parse(outcome.findings!));
    expect(findings.summary).toContain("conflict rebasing onto origin/main");
    expect(findings.items[0]!.file).toBe("README.md");
    expect(findings.items[0]!.action).toBe("ask-user");
  });

  test("empty diff after rebase (branch behind main) → skipRemaining", async () => {
    const { upstream, mainSha } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    // feat/x sits at main with NO unique commits; main advances.
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    await advanceUpstreamMain(upstream, dirs, "other.txt", "theirs\n");
    const { ctx } = makeCtx(wt, mainSha, { run: { baseSha: mainSha } });
    const outcome = await rebaseStep.execute(ctx);
    expect(outcome.skipRemaining).toBe(true);
  });

  test("already ahead of main → skip that target, head unchanged, non-empty diff", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "feature.txt", "mine\n", "add feature"); // ahead of main, main not advanced
    const { ctx, logs, headUpdates } = makeCtx(wt, b, { run: { baseSha: b } });
    const outcome = await rebaseStep.execute(ctx);
    expect(outcome).toEqual({});
    expect(headUpdates.length).toBe(0);
    expect(logs.join()).toContain("already ahead of origin/main");
  });

  test("already up-to-date with the pushed-branch tracking ref → skip", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "feature.txt", "mine\n", "add feature");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], wt); // origin/feat/x == HEAD
    const { ctx, logs } = makeCtx(wt, b, { run: { baseSha: b } });
    await rebaseStep.execute(ctx);
    expect(logs.join()).toContain("already up-to-date with origin/feat/x");
  });

  test("force push: pushed-branch tracking ref is NOT refreshed (stale anchor asymmetry)", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const x1 = await commit(wt, "feature.txt", "v1\n", "v1");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], wt); // origin/feat/x = x1
    // Rewrite history (force-push shape): reset to main + a divergent commit.
    await sh(["git", "reset", "--hard", "HEAD~1"], wt);
    const y = await commit(wt, "feature.txt", "v2-rewritten\n", "v2");
    // Record every fetch the step issues.
    const fetched: string[] = [];
    const recordingRunner: ShellRunner = async (cmd, cwd, opts) => {
      if (cmd.includes("fetch")) fetched.push(cmd.join(" "));
      return productionHostRunner(cmd, cwd, opts);
    };
    const { ctx } = makeCtx(wt, y, { run: { baseSha: x1 }, hostRunner: recordingRunner });
    await rebaseStep.execute(ctx);
    // origin/<default> IS fetched, but the pushed branch (feat/x) is NOT — the
    // deliberately stale anchor the push step relies on for its content check.
    expect(fetched.some((f) => f.includes("refs/heads/main:"))).toBe(true);
    expect(fetched.some((f) => f.includes("refs/heads/feat/x:"))).toBe(false);
  });

  test("fix mode: agent resolves the conflict + completes the rebase", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "README.md", "# mine\n", "edit readme");
    await advanceUpstreamMain(upstream, dirs, "README.md", "# theirs\n");
    const dispatcher = fakeDispatcher(async (o) => {
      // Resolve the conflict + continue the rebase, as the real agent would.
      writeFileSync(join(o.cwd, "README.md"), "# merged\n");
      await sh(["git", "add", "README.md"], o.cwd);
      await productionHostRunner(["git", "rebase", "--continue"], o.cwd, {});
      return { output: { summary: "merged readme" }, text: "" };
    });
    const { ctx, headUpdates } = makeCtx(wt, b, { run: { baseSha: b }, fixing: true, dispatcher });
    const outcome = await rebaseStep.execute(ctx);
    expect(outcome).toEqual({});
    expect(headUpdates.length).toBe(1);
    expect((await sh(["git", "status", "--porcelain"], wt)).stdout.trim()).toBe("");
  });

  test("fix mode: agent leaves the rebase in progress → aborts + throws", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "README.md", "# mine\n", "edit readme");
    await advanceUpstreamMain(upstream, dirs, "README.md", "# theirs\n");
    const dispatcher = fakeDispatcher(() => ({ output: { summary: "did nothing" }, text: "" }));
    const { ctx } = makeCtx(wt, b, { run: { baseSha: b }, fixing: true, dispatcher });
    await expect(rebaseStep.execute(ctx)).rejects.toThrow("agent did not complete the rebase");
    // The failed rebase was aborted (worktree clean).
    expect((await sh(["git", "status", "--porcelain"], wt)).stdout.trim()).toBe("");
  });

  test("bundled-local-default guard: branch carries unpushed local-main commits → ask-user", async () => {
    const { upstream } = await setupUpstream(dirs);
    // The user's working repo: local main advances WITHOUT pushing.
    const working = await cloneWorktree(upstream, dirs);
    const localTip = await commit(working, "local.txt", "unpushed\n", "unpushed local main work");
    await sh(["git", "checkout", "-b", "feat/x"], working); // feat/x built off the unpushed tip
    const b = await commit(working, "feature.txt", "mine\n", "feature on top");
    // The gate worktree carries feat/x (push it to origin's gate namespace so the
    // objects — including localTip — are reachable), origin/main still at seed.
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "fetch", working, "feat/x:refs/heads/feat/x"], wt);
    await sh(["git", "checkout", "feat/x"], wt);
    const { ctx } = makeCtx(wt, b, { run: { baseSha: b }, repo: { defaultBranch: "main", workingPath: working } });
    const outcome = await rebaseStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(outcome.autoFixable).toBe(false);
    const findings = deserializeFindings(JSON.parse(outcome.findings!));
    expect(findings.summary).toContain("bundles 1 unpushed main commit");
    expect(findings.items[0]!.action).toBe("ask-user");
    void localTip;
  });
});

/** Runner that fails (exit 128) for commands matching `fail`, else delegates. */
function failingRunner(fail: (cmd: string[]) => boolean): ShellRunner {
  return async (cmd, cwd, opts) => {
    if (fail(cmd)) return { exitCode: 128, stdout: "", stderr: "injected failure" };
    return productionHostRunner(cmd, cwd, opts);
  };
}

describe("rebaseStep edge + error branches", () => {
  let dirs: string[];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("fetch of origin/<default> fails → logs a warning, still proceeds", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "feature.txt", "mine\n", "feat");
    const hostRunner = failingRunner((cmd) => cmd.includes("fetch") && cmd.some((a) => a.includes("refs/heads/main:")));
    const { ctx, logs } = makeCtx(wt, b, { run: { baseSha: b }, hostRunner });
    await rebaseStep.execute(ctx);
    expect(logs.join()).toContain("could not fetch origin/main");
  });

  test("fetch of the pushed branch fails on a normal push → logs a warning", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "feature.txt", "mine\n", "feat");
    const hostRunner = failingRunner((cmd) => cmd.includes("fetch") && cmd.some((a) => a.includes("refs/heads/feat/x:")));
    const { ctx, logs } = makeCtx(wt, b, { run: { baseSha: b }, hostRunner });
    await rebaseStep.execute(ctx);
    expect(logs.join()).toContain("could not fetch origin/feat/x");
  });

  test("force-push TO the default branch after the remote advanced → warning finding", async () => {
    const { upstream, mainSha } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    // Our last pushed main tip (the base): S + M1.
    const m1 = await commit(wt, "m1.txt", "m1\n", "m1");
    await sh(["git", "push", "origin", "HEAD:refs/heads/main"], wt);
    // The remote advances out of band past our base.
    await advanceUpstreamMain(upstream, dirs, "remote.txt", "remote work\n");
    // We rewrite local main to a commit that diverges from the pushed base
    // (force-push shape: the base is no longer an ancestor of HEAD).
    await sh(["git", "reset", "--hard", mainSha], wt);
    const divergent = await commit(wt, "local.txt", "rewritten\n", "divergent");
    const { ctx } = makeCtx(wt, divergent, {
      run: { branch: "main", ref: "refs/heads/main", baseSha: m1 },
    });
    const outcome = await rebaseStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    const findings = deserializeFindings(JSON.parse(outcome.findings!));
    expect(findings.summary).toContain("remote main advanced during force push");
  });

  test("force-push detection tolerates an ls-remote failure (catch)", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const x1 = await commit(wt, "feature.txt", "v1\n", "v1");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], wt);
    await sh(["git", "reset", "--hard", "HEAD~1"], wt);
    const y = await commit(wt, "feature.txt", "v2\n", "v2");
    // ls-remote throws → the branch-remote check is skipped, falls through to the
    // localRef path (origin/feat/x tracking ref) → still detected as force.
    const hostRunner = failingRunner((cmd) => cmd.includes("ls-remote"));
    const fetched: string[] = [];
    const recording: ShellRunner = async (cmd, cwd, opts) => {
      if (cmd.includes("fetch")) fetched.push(cmd.join(" "));
      return (hostRunner as ShellRunner)(cmd, cwd, opts);
    };
    // Seed the tracking ref so the localRef path resolves.
    await sh(["git", "fetch", "origin", "+refs/heads/feat/x:refs/remotes/origin/feat/x"], wt);
    const { ctx } = makeCtx(wt, y, { run: { baseSha: x1 }, hostRunner: recording });
    await rebaseStep.execute(ctx);
    // Force detected via the localRef fallback → pushed-branch fetch was skipped.
    expect(fetched.some((f) => f.includes("refs/heads/feat/x:"))).toBe(false);
  });

  test("rebase failure with NO conflict files → throws", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "feature.txt", "mine\n", "feat");
    await advanceUpstreamMain(upstream, dirs, "other.txt", "theirs\n");
    // Jailed `git rebase <target>` fails, but there are no conflict markers.
    const jailedRunner = failingRunner((cmd) => cmd.includes("rebase") && !cmd.includes("--abort"));
    const { ctx } = makeCtx(wt, b, { run: { baseSha: b }, jailedRunner });
    await expect(rebaseStep.execute(ctx)).rejects.toThrow("rebase onto origin/main failed");
  });

  test("fix mode: agent dispatch throws → aborts + rethrows", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "README.md", "# mine\n", "edit");
    await advanceUpstreamMain(upstream, dirs, "README.md", "# theirs\n");
    const dispatcher = fakeDispatcher(() => {
      throw new Error("agent crashed");
    });
    const { ctx } = makeCtx(wt, b, { run: { baseSha: b }, fixing: true, dispatcher });
    await expect(rebaseStep.execute(ctx)).rejects.toThrow("agent resolve conflicts: agent crashed");
    expect((await sh(["git", "status", "--porcelain"], wt)).stdout.trim()).toBe("");
  });

  test("fix mode: rebaseInProgress tolerates a rev-parse --git-path failure (catch)", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "README.md", "# mine\n", "edit");
    await advanceUpstreamMain(upstream, dirs, "README.md", "# theirs\n");
    const dispatcher = fakeDispatcher(async (o) => {
      writeFileSync(join(o.cwd, "README.md"), "# merged\n");
      await sh(["git", "add", "README.md"], o.cwd);
      await productionHostRunner(["git", "rebase", "--continue"], o.cwd, {});
      return { output: { summary: "merged" }, text: "" };
    });
    // `rev-parse --git-path` fails → rebaseInProgress catches and treats each dir
    // as absent (returns false), so the completed rebase is accepted.
    const hostRunner = failingRunner((cmd) => cmd.includes("--git-path"));
    const { ctx } = makeCtx(wt, b, { run: { baseSha: b }, fixing: true, dispatcher, hostRunner });
    const outcome = await rebaseStep.execute(ctx);
    expect(outcome).toEqual({});
  });

  test("bundled guard tolerates a `git log` failure (catch → proceeds)", async () => {
    const { upstream } = await setupUpstream(dirs);
    const working = await cloneWorktree(upstream, dirs);
    await commit(working, "local.txt", "unpushed\n", "unpushed");
    await sh(["git", "checkout", "-b", "feat/x"], working);
    const b = await commit(working, "feature.txt", "mine\n", "feat");
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "fetch", working, "feat/x:refs/heads/feat/x"], wt);
    await sh(["git", "checkout", "feat/x"], wt);
    const hostRunner = failingRunner((cmd) => cmd.includes("log"));
    const { ctx } = makeCtx(wt, b, {
      run: { baseSha: b },
      repo: { defaultBranch: "main", workingPath: working },
      hostRunner,
    });
    // With `git log` failing, the guard returns null (proceeds) instead of parking.
    const outcome = await rebaseStep.execute(ctx);
    expect(outcome.needsApproval).toBeUndefined();
  });

  test("not a force push when the base diverges but the branch was never pushed", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    // A sibling commit off the seed — a real object in the worktree that is NOT
    // an ancestor of HEAD (so ancestry returns "no", not "error").
    await sh(["git", "checkout", "-b", "sibling"], wt);
    const sibling = await commit(wt, "sibling.txt", "s\n", "sibling");
    await sh(["git", "checkout", "main"], wt);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "feature.txt", "mine\n", "feat");
    // baseSha diverges from HEAD, yet feat/x was never pushed and has no tracking
    // ref → force is NOT inferred (fall-through), and the step proceeds normally.
    const { ctx } = makeCtx(wt, b, { run: { baseSha: sibling } });
    const outcome = await rebaseStep.execute(ctx);
    expect(outcome.needsApproval).toBeUndefined();
  });

  test("fix mode: rebase fails with no conflicts → aborts + throws", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    const b = await commit(wt, "feature.txt", "mine\n", "feat");
    await advanceUpstreamMain(upstream, dirs, "other.txt", "theirs\n");
    const jailedRunner = failingRunner((cmd) => cmd.includes("rebase") && !cmd.includes("--abort"));
    const { ctx } = makeCtx(wt, b, { run: { baseSha: b }, fixing: true, jailedRunner });
    await expect(rebaseStep.execute(ctx)).rejects.toThrow("no conflicts detected");
  });

  test("multi-file conflict findings are deduped", async () => {
    const { upstream } = await setupUpstream(dirs);
    const wt = await cloneWorktree(upstream, dirs);
    // Two shared files on main.
    writeFileSync(join(wt, "f1.txt"), "base1\n");
    writeFileSync(join(wt, "f2.txt"), "base2\n");
    await sh(["git", "add", "-A"], wt);
    await sh(["git", "commit", "-m", "add f1+f2"], wt);
    await sh(["git", "push", "origin", "HEAD:refs/heads/main"], wt);
    // feat/x: ONE commit editing BOTH files.
    await sh(["git", "checkout", "-b", "feat/x"], wt);
    writeFileSync(join(wt, "f1.txt"), "mine1\n");
    writeFileSync(join(wt, "f2.txt"), "mine2\n");
    await sh(["git", "commit", "-am", "edit both mine"], wt);
    const head = (await sh(["git", "rev-parse", "HEAD"], wt)).stdout.trim();
    // main advances with ONE commit editing BOTH files → both conflict at once.
    const other = mkdtempSync(join(tmpdir(), "ezcf-other2-"));
    dirs.push(other);
    await sh(["git", "clone", upstream, other], other);
    await initConfig(other);
    writeFileSync(join(other, "f1.txt"), "theirs1\n");
    writeFileSync(join(other, "f2.txt"), "theirs2\n");
    await sh(["git", "commit", "-am", "edit both theirs"], other);
    await sh(["git", "push", "origin", "HEAD:refs/heads/main"], other);
    const { ctx } = makeCtx(wt, head, { run: { baseSha: head } });
    const outcome = await rebaseStep.execute(ctx);
    const findings = deserializeFindings(JSON.parse(outcome.findings!));
    // Both files conflict in one rebase stop → two findings (dedup loop runs).
    expect(findings.items.length).toBe(2);
  });
});

// ── review step ─────────────────────────────────────────────────────

/** Build findings JSON in the agent wire shape. */
function reviewFindings(items: unknown[], risk = "low", rationale = "ok"): Record<string, unknown> {
  return { findings: items, risk_level: risk, risk_rationale: rationale };
}

describe("matchIgnorePattern", () => {
  test("dir/** matches anything under the dir", () => {
    expect(matchIgnorePattern("dist/a/b.js", "dist/**")).toBe(true);
    expect(matchIgnorePattern("dist", "dist/**")).toBe(true);
    expect(matchIgnorePattern("distant/x", "dist/**")).toBe(false);
  });
  test("no-slash pattern matches the basename", () => {
    expect(matchIgnorePattern("pkg/foo.snap", "*.snap")).toBe(true);
    expect(matchIgnorePattern("pkg/foo.ts", "*.snap")).toBe(false);
  });
  test("slashed pattern matches the full path", () => {
    expect(matchIgnorePattern("web/generated.ts", "web/*.ts")).toBe(true);
    expect(matchIgnorePattern("web/a/b.ts", "web/*.ts")).toBe(false); // * does not cross /
  });
});

describe("reviewStep (real repo)", () => {
  let dir: string;
  let head: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ezcf-review-"));
    await initRepo(dir);
    await commit(dir, "a.txt", "one\n", "base");
    await sh(["git", "checkout", "-b", "feat/x"], dir);
    head = await commit(dir, "a.txt", "two\n", "change");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("blocking findings → needsApproval + autoFixable + serialized findings", async () => {
    const dispatcher = fakeDispatcher(() => ({
      output: reviewFindings([
        { id: "f1", severity: "error", file: "a.txt", line: 1, description: "bug", action: "auto-fix" },
      ]),
      text: "",
    }));
    const { ctx } = makeCtx(dir, head, { run: { baseSha: head }, dispatcher });
    const outcome = await reviewStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(outcome.autoFixable).toBe(true);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.items[0]!.description).toBe("bug");
  });

  test("info-only findings → not blocking but autoFixable (items > 0)", async () => {
    const dispatcher = fakeDispatcher(() => ({
      output: reviewFindings([{ severity: "info", description: "nit", action: "no-op" }]),
      text: "",
    }));
    const { ctx } = makeCtx(dir, head, { run: { baseSha: head }, dispatcher });
    const outcome = await reviewStep.execute(ctx);
    expect(outcome.needsApproval).toBe(false);
    expect(outcome.autoFixable).toBe(true);
  });

  test("no reviewable changes (branch == base) → auto-pass low risk, no dispatch", async () => {
    // feat/x with no diff vs main: reset it back to main's content.
    await sh(["git", "checkout", "main"], dir);
    await sh(["git", "checkout", "-B", "feat/x", "main"], dir);
    const h = (await sh(["git", "rev-parse", "HEAD"], dir)).stdout.trim();
    const dispatcher = fakeDispatcher(() => {
      throw new Error("should not dispatch");
    });
    const { ctx, logs } = makeCtx(dir, h, { run: { baseSha: h }, dispatcher });
    const outcome = await reviewStep.execute(ctx);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.riskLevel).toBe("low");
    expect(f.riskRationale).toBe("no reviewable changes");
    expect(logs.join()).toContain("no changes to review");
  });

  test("all changed files ignored → auto-pass (no dispatch)", async () => {
    // Add a change to an ignored file only.
    await commit(dir, "snapshot.snap", "snap\n", "add snap");
    const h = (await sh(["git", "rev-parse", "HEAD"], dir)).stdout.trim();
    const config = defaultPipelineConfig();
    config.ignorePatterns = ["*.snap", "*.txt"];
    const dispatcher = fakeDispatcher(() => {
      throw new Error("should not dispatch");
    });
    const { ctx } = makeCtx(dir, h, { run: { baseSha: h }, dispatcher, config });
    const outcome = await reviewStep.execute(ctx);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.riskRationale).toBe("no reviewable changes");
  });

  test("unparseable agent output → falls back to text as summary", async () => {
    const dispatcher = fakeDispatcher(() => ({ output: null, text: "free-form review" }));
    const { ctx, logs } = makeCtx(dir, head, { run: { baseSha: head }, dispatcher });
    const outcome = await reviewStep.execute(ctx);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.summary).toBe("free-form review");
    expect(logs.join()).toContain("could not parse structured output");
  });

  test("agent review error → wrapped 'agent review: …'", async () => {
    const dispatcher = fakeDispatcher(() => {
      throw new Error("provider down");
    });
    const { ctx } = makeCtx(dir, head, { run: { baseSha: head }, dispatcher });
    await expect(reviewStep.execute(ctx)).rejects.toThrow("agent review: provider down");
  });

  test("fix mode: fixer edits + commits, then re-review returns findings + fixSummary", async () => {
    const dispatcher = fakeDispatcher(async (o) => {
      if (o.role === "fixer") {
        writeFileSync(join(dir, "a.txt"), "fixed\n");
        await sh(["git", "add", "a.txt"], dir);
        return { output: { summary: "applied fix" }, text: "" };
      }
      return { output: reviewFindings([]), text: "" };
    });
    const prev = serializeFindings(
      deserializeFindings({ findings: [{ id: "f1", severity: "error", description: "bug", action: "auto-fix" }] }),
    );
    const { ctx } = makeCtx(dir, head, {
      run: { baseSha: head },
      fixing: true,
      previousFindings: prev,
      dispatcher,
    });
    const outcome = await reviewStep.execute(ctx);
    expect(outcome.fixSummary).toBe("applied fix");
    // The fix was committed with the renamed prefix.
    const log = (await sh(["git", "log", "-1", "--pretty=%s"], dir)).stdout.trim();
    expect(log).toBe("ez-code-factory(review): applied fix");
  });

  test("fix mode requires previous findings", async () => {
    const { ctx } = makeCtx(dir, head, { run: { baseSha: head }, fixing: true, previousFindings: "" });
    await expect(reviewStep.execute(ctx)).rejects.toThrow("review fix requires previous review findings");
  });

  test("changed-files diff failure → wrapped 'get changed files'", async () => {
    const hostRunner = failingRunner((cmd) => cmd.includes("diff") && cmd.includes("--name-only"));
    const { ctx } = makeCtx(dir, head, { run: { baseSha: head }, hostRunner });
    await expect(reviewStep.execute(ctx)).rejects.toThrow("get changed files");
  });

  test("authoritative intent adds the conformance clause to the review prompt", async () => {
    const dispatcher = fakeDispatcher(() => ({ output: reviewFindings([]), text: "" }));
    const { ctx } = makeCtx(dir, head, {
      run: { baseSha: head, intent: "must keep the flag", intentSource: "agent" },
      dispatcher,
    });
    await reviewStep.execute(ctx);
    const reviewCall = (dispatcher as FakeDispatcher).calls.find((c) => c.role === "reviewer")!;
    expect(reviewCall.prompt).toContain("Intent conformance (required)");
    expect(reviewCall.prompt).toContain("AUTHORITATIVE acceptance criteria");
  });
});

// ── push step + force-push safety (real remotes) ────────────────────

/** upstream bare + a wt clone with origin wired + a base commit on feat/x. */
async function pushFixture(dirs: string[]): Promise<{ up: string; wt: string; base: string }> {
  const up = mkdtempSync(join(tmpdir(), "ezcf-pup-"));
  dirs.push(up);
  await sh(["git", "init", "--bare", "-b", "main", up], up);
  const wt = mkdtempSync(join(tmpdir(), "ezcf-pwt-"));
  dirs.push(wt);
  await sh(["git", "init", "-b", "main", wt], wt);
  await initConfig(wt);
  await sh(["git", "remote", "add", "origin", up], wt);
  const base = await commit(wt, "base.txt", "base\n", "base");
  await sh(["git", "push", "origin", "HEAD:refs/heads/main"], wt);
  await sh(["git", "checkout", "-b", "feat/x"], wt);
  return { up, wt, base };
}

describe("resolveForcePushDecision matrix (real remotes)", () => {
  let dirs: string[];
  const ref = "refs/heads/feat/x";
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("branch absent on remote → newBranch", async () => {
    const { wt, base } = await pushFixture(dirs);
    const head = await commit(wt, "f.txt", "x\n", "feat");
    const g = makeGit(productionHostRunner, wt);
    const d = await resolveForcePushDecision(g, "origin", ref, head, "", base);
    expect(d.newBranch).toBe(true);
  });

  test("remote already at the head → upToDate", async () => {
    const { wt, base } = await pushFixture(dirs);
    const head = await commit(wt, "f.txt", "x\n", "feat");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], wt);
    const g = makeGit(productionHostRunner, wt);
    const d = await resolveForcePushDecision(g, "origin", ref, head, "", base);
    expect(d.upToDate).toBe(true);
    expect(d.remoteSHA).toBe(head);
  });

  test("remote unchanged since last observed → safe lease (remote == lastSeen)", async () => {
    const { wt, base } = await pushFixture(dirs);
    const r = await commit(wt, "f.txt", "remote\n", "remote head");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], wt);
    // A new local head to push, with lastSeen == the current remote.
    const head = await commit(wt, "f.txt", "local2\n", "local head");
    const g = makeGit(productionHostRunner, wt);
    const d = await resolveForcePushDecision(g, "origin", ref, head, r, base);
    expect(d.newBranch).toBe(false);
    expect(d.upToDate).toBe(false);
    expect(d.remoteSHA).toBe(r);
  });

  test("out-of-band remote commit not incorporated → REFUSES (ForcePushWouldDiscardError)", async () => {
    const { up, wt, base } = await pushFixture(dirs);
    // The remote branch gains a commit from another contributor.
    const other = mkdtempSync(join(tmpdir(), "ezcf-pother-"));
    dirs.push(other);
    await sh(["git", "clone", "--branch", "main", up, other], other);
    await initConfig(other);
    await sh(["git", "checkout", "-b", "feat/x"], other);
    const oob = await commit(other, "theirs.txt", "their work\n", "out of band");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], other);
    // Our head does NOT contain the out-of-band commit; lastSeen is stale (base).
    const head = await commit(wt, "mine.txt", "my work\n", "mine");
    const g = makeGit(productionHostRunner, wt);
    let err: unknown;
    try {
      await resolveForcePushDecision(g, "origin", ref, head, base, base);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForcePushWouldDiscardError);
    expect((err as ForcePushWouldDiscardError).dropped).toContain(oob);
    expect((err as Error).message).toContain("refusing to force-push");
  });

  test("patch-id-equivalent remote commit → proceeds (dropped empty)", async () => {
    const { up, wt, base } = await pushFixture(dirs);
    // Remote head = base + a change to shared.txt.
    const other = mkdtempSync(join(tmpdir(), "ezcf-peq-"));
    dirs.push(other);
    await sh(["git", "clone", "--branch", "main", up, other], other);
    await initConfig(other);
    await sh(["git", "checkout", "-b", "feat/x"], other);
    const remoteHead = await commit(other, "shared.txt", "the change\n", "add shared");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], other);
    // Our head applies the SAME change (same patch-id, different sha).
    const head = await commit(wt, "shared.txt", "the change\n", "add shared (rebased)");
    const g = makeGit(productionHostRunner, wt);
    // Remote's commit is patch-equivalent to ours → not discarded → proceed.
    const d = await resolveForcePushDecision(g, "origin", ref, head, base, base);
    expect(d.remoteSHA).toBe(remoteHead);
    expect(d.newBranch).toBe(false);
    expect(d.upToDate).toBe(false);
  });

  test("ls-remote failure → fails closed ('resolve remote head')", async () => {
    const { wt, base } = await pushFixture(dirs);
    const head = await commit(wt, "f.txt", "x\n", "feat");
    const g = makeGit(failingRunner((cmd) => cmd.includes("ls-remote")), wt);
    await expect(resolveForcePushDecision(g, "origin", ref, head, "", base)).rejects.toThrow(
      "resolve remote head",
    );
  });

  test("verify-safety wrap: a fetch failure during the content check fails closed", async () => {
    const { up, wt, base } = await pushFixture(dirs);
    const other = mkdtempSync(join(tmpdir(), "ezcf-pv-"));
    dirs.push(other);
    await sh(["git", "clone", "--branch", "main", up, other], other);
    await initConfig(other);
    await sh(["git", "checkout", "-b", "feat/x"], other);
    await commit(other, "theirs.txt", "x\n", "oob");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], other);
    const head = await commit(wt, "mine.txt", "mine\n", "mine");
    // ls-remote succeeds, but the fetch inside remoteCommitsNotIncorporated fails.
    const runner = failingRunner((cmd) => cmd.includes("fetch"));
    const g = makeGit(runner, wt);
    await expect(resolveForcePushDecision(g, "origin", ref, head, base, base)).rejects.toThrow(
      "verify force-push safety",
    );
  });
});

describe("remoteCommitsNotIncorporated", () => {
  let dirs: string[];
  const ref = "refs/heads/feat/x";
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("omits ^base when base is the zero SHA (stricter check still works)", async () => {
    const { up, wt } = await pushFixture(dirs);
    const other = mkdtempSync(join(tmpdir(), "ezcf-rc-"));
    dirs.push(other);
    await sh(["git", "clone", "--branch", "main", up, other], other);
    await initConfig(other);
    await sh(["git", "checkout", "-b", "feat/x"], other);
    const oob = await commit(other, "t.txt", "x\n", "oob");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], other);
    const head = await commit(wt, "mine.txt", "m\n", "mine");
    const g = makeGit(productionHostRunner, wt);
    const dropped = await remoteCommitsNotIncorporated(g, "origin", ref, head, oob, "0".repeat(40));
    expect(dropped).toContain(oob);
  });
});

describe("pushStep (real remotes)", () => {
  let dirs: string[];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("commits dirty agent state, pushes a new branch, advances the recorded head", async () => {
    const { up, wt } = await pushFixture(dirs);
    const head = await commit(wt, "f.txt", "committed\n", "feat");
    // An uncommitted agent fix in the worktree.
    writeFileSync(join(wt, "extra.txt"), "agent fix\n");
    const { ctx, headUpdates } = makeCtx(wt, head, { run: { baseSha: head } });
    const outcome = await pushStep.execute(ctx);
    expect(outcome).toEqual({});
    // The dirty state was committed with the fixed message.
    const log = (await sh(["git", "log", "-1", "--pretty=%s"], wt)).stdout.trim();
    expect(log).toBe("ez-code-factory: apply agent fixes");
    // The branch reached the remote.
    const remote = (await sh(["git", "ls-remote", "--heads", up, "feat/x"], wt)).stdout;
    expect(remote).toContain("refs/heads/feat/x");
    // The recorded head advanced (dirty commit).
    expect(headUpdates.length).toBeGreaterThanOrEqual(1);
    expect(ctx.run.headSha).not.toBe(head);
  });

  test("clean worktree, existing branch at last-seen anchor → guarded force-with-lease", async () => {
    const { up, wt, base } = await pushFixture(dirs);
    const r = await commit(wt, "f.txt", "v1\n", "v1");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], wt);
    await sh(["git", "fetch", "origin", "+refs/heads/feat/x:refs/remotes/origin/feat/x"], wt);
    // Amend to a new head; lastSeen (tracking ref) still equals the remote → safe.
    await sh(["git", "commit", "--amend", "-m", "v1 amended"], wt);
    const amended = (await sh(["git", "rev-parse", "HEAD"], wt)).stdout.trim();
    const { ctx } = makeCtx(wt, amended, { run: { baseSha: base } });
    await pushStep.execute(ctx);
    const remoteHead = (await sh(["git", "ls-remote", up, "refs/heads/feat/x"], wt)).stdout.split(/\s+/)[0];
    expect(remoteHead).toBe(amended);
    void r;
  });

  test("remote already up-to-date → no push, no error", async () => {
    const { wt, base } = await pushFixture(dirs);
    const head = await commit(wt, "f.txt", "v1\n", "v1");
    await sh(["git", "push", "origin", "HEAD:refs/heads/feat/x"], wt);
    const { ctx, logs } = makeCtx(wt, head, { run: { baseSha: base } });
    const outcome = await pushStep.execute(ctx);
    expect(outcome).toEqual({});
    expect(logs.join()).toContain("pushed successfully");
  });
});
