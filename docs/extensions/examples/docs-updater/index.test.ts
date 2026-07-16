// docs-updater — unit tests for the flagship proactive PR-drafter.
//
// Drives the pure helpers, the check + act bodies, the sandboxed `gh`
// pipeline (finalize/discard), the deferred → proposal composition
// (onComplete), the dashboard builder, and the approve/decline row actions
// with hand-built contexts + injected seams (git reader, sandboxed shell,
// approve/decline resolvers) so every branch is covered without a live
// channel. `readGitHead`/`readCommitSubjects` run against a REAL throwaway
// git repo. The full trigger → check → act → onComplete → approve/decline
// path is proven by the real-subprocess integration test.

import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type {
  LoopActContext,
  LoopCheckContext,
  LoopCompleteContext,
  LoopRunState,
  PageActionEvent,
} from "@ezcorp/sdk/runtime";
import {
  parseGitHead,
  parseCommitSubjects,
  readGitHead,
  readCommitSubjects,
  resolveRepoPath,
  resolveWritePaths,
  isSelfRepo,
  filterOutsideWritePaths,
  parsePrRef,
  buildAgentPrompt,
  isGhUnavailable,
  statusLabel,
  checkDocsActivity,
  docsUpdaterAct,
  readPrChangedFiles,
  readPrStatus,
  finalizeDocsPr,
  discardDocsPr,
  docsUpdaterOnComplete,
  buildDashboard,
  handleApproveAction,
  handleDeclineAction,
  makeProductionShell,
  getShell,
  _setGitHeadForTests,
  _setCommitSubjectsForTests,
  _setProjectRootForTests,
  _setShellForTests,
  _setResolversForTests,
  APPROVE_EVENT,
  DECLINE_EVENT,
  LOOP_ID,
  type DocsInput,
  type DocsOutcome,
  type ShellResult,
  type ShellRunner,
} from "./index";
import config from "./ezcorp.config";
import { validateManifestV2 } from "../../../../src/extensions/manifest";

afterEach(() => {
  _setGitHeadForTests(null);
  _setCommitSubjectsForTests(null);
  _setProjectRootForTests(null);
  _setShellForTests(null);
  _setResolversForTests(null, null);
});

// ── context builders ────────────────────────────────────────────────

function makeCheckCtx(
  overrides: { settings?: Record<string, unknown>; cursor?: string } = {},
): { ctx: LoopCheckContext<DocsInput>; getCursor: () => unknown; logs: string[] } {
  let cursorValue: unknown = overrides.cursor;
  const logs: string[] = [];
  const ctx: LoopCheckContext<DocsInput> = {
    input: {} as DocsInput,
    settings: overrides.settings ?? {},
    fire: {
      id: "fire-1",
      firedAt: "2026-07-16T00:00:00.000Z",
      trigger: { kind: "cron", cron: "0 6 * * *" },
      catchUp: false,
    },
    cursor: {
      get: async <T,>() => cursorValue as T | undefined,
      set: async <T,>(v: T) => {
        cursorValue = v;
      },
    },
    fetch: (async () => new Response("")) as unknown as typeof fetch,
    log: (msg) => logs.push(msg),
  };
  return { ctx, getCursor: () => cursorValue, logs };
}

function makeActCtx(
  overrides: {
    input?: DocsInput;
    settings?: Record<string, unknown>;
    spawn?: LoopActContext<DocsInput>["spawn"];
  } = {},
): { ctx: LoopActContext<DocsInput>; logs: string[]; spawnCalls: unknown[] } {
  const logs: string[] = [];
  const spawnCalls: unknown[] = [];
  const defaultSpawn = (async (input: unknown) => {
    spawnCalls.push(input);
    return {
      subConversationId: "sub-1",
      agentRunId: "run-agent-1",
      taskId: "task-1",
      assignmentId: "assign-1",
    };
  }) as LoopActContext<DocsInput>["spawn"];
  const ctx: LoopActContext<DocsInput> = {
    fire: {
      id: "fire-1",
      firedAt: "2026-07-16T00:00:00.000Z",
      trigger: { kind: "manual", tool: "run_docs_update" },
      catchUp: false,
    },
    input: overrides.input ?? { headHash: "abcdef1234567890", subjects: ["feat: x"] },
    settings: overrides.settings ?? {},
    llm: { complete: async () => { throw new Error("llm not used"); } } as never,
    recentMessages: async () => [],
    formatMessages: (m) => m.map((x) => `[${x.id}] ${x.role}: ${x.content}`).join("\n\n"),
    spawn: overrides.spawn ?? defaultSpawn,
    log: (msg) => logs.push(msg),
  };
  return { ctx, logs, spawnCalls };
}

function makeRun(overrides: Partial<LoopRunState<DocsOutcome>> = {}): LoopRunState<DocsOutcome> {
  return {
    id: overrides.id ?? "run-1",
    loopId: LOOP_ID,
    scope: "global",
    status: overrides.status ?? "drafting",
    events: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeCompleteCtx(
  overrides: {
    input?: DocsInput;
    resultPreview?: string;
    settings?: Record<string, unknown>;
    status?: string;
  } = {},
): { ctx: LoopCompleteContext<DocsOutcome>; logs: string[] } {
  const logs: string[] = [];
  const ctx: LoopCompleteContext<DocsOutcome> = {
    run: makeRun({ input: overrides.input ?? { headHash: "abcdef1234567890", subjects: ["feat: x"] } }),
    status: overrides.status ?? "completed",
    ...(overrides.resultPreview !== undefined ? { resultPreview: overrides.resultPreview } : {}),
    settings: overrides.settings ?? {},
    log: (msg) => logs.push(msg),
  };
  return { ctx, logs };
}

/** Build a scripted shell that dispatches on the gh subcommand (cmd[1]). */
function scriptedShell(
  handler: (cmd: string[], cwd: string) => ShellResult,
): ShellRunner {
  return async (cmd, cwd) => handler(cmd, cwd);
}
const OK: ShellResult = { exitCode: 0, stdout: "", stderr: "" };
const GH_ABSENT: ShellResult = { exitCode: 127, stdout: "", stderr: "gh: not found" };

// ── parseGitHead (pure) ─────────────────────────────────────────────

describe("parseGitHead", () => {
  test("normal hash + subject", () => {
    expect(parseGitHead("deadbeef\0fix: the bug", 0)).toEqual({ hash: "deadbeef", subject: "fix: the bug" });
  });
  test("non-zero exit → null", () => {
    expect(parseGitHead("whatever", 1)).toBeNull();
  });
  test("empty output → null", () => {
    expect(parseGitHead("   \n", 0)).toBeNull();
  });
  test("no NUL → whole line is hash, empty subject", () => {
    expect(parseGitHead("cafebabe", 0)).toEqual({ hash: "cafebabe", subject: "" });
  });
  test("leading NUL (empty hash) → null", () => {
    expect(parseGitHead("\0orphan", 0)).toBeNull();
  });
});

// ── parseCommitSubjects (pure) ──────────────────────────────────────

describe("parseCommitSubjects", () => {
  test("multi-line trimmed non-empty", () => {
    expect(parseCommitSubjects("feat: a\n  fix: b  \n\ndocs: c\n", 0)).toEqual(["feat: a", "fix: b", "docs: c"]);
  });
  test("non-zero exit → []", () => {
    expect(parseCommitSubjects("feat: a", 1)).toEqual([]);
  });
});

// ── resolveRepoPath / resolveWritePaths / isSelfRepo (pure) ──────────

describe("resolveRepoPath", () => {
  test("configured setting wins", () => {
    expect(resolveRepoPath({ repo_path: "/x/y" }, "/proj")).toBe("/x/y");
  });
  test("blank setting → project root", () => {
    expect(resolveRepoPath({ repo_path: "" }, "/proj")).toBe("/proj");
  });
  test("no setting, no root → /repo", () => {
    expect(resolveRepoPath({}, undefined)).toBe("/repo");
  });
});

describe("resolveWritePaths", () => {
  test("parses comma list, trims + filters empties", () => {
    expect(resolveWritePaths({ write_paths: "README.md, docs/ ,, CHANGES" })).toEqual(["README.md", "docs/", "CHANGES"]);
  });
  test("blank → default", () => {
    expect(resolveWritePaths({ write_paths: "" })).toEqual(["README.md", "docs/"]);
  });
  test("only separators → default", () => {
    expect(resolveWritePaths({ write_paths: " , , " })).toEqual(["README.md", "docs/"]);
  });
});

describe("isSelfRepo", () => {
  test("/repo → true", () => expect(isSelfRepo("/repo")).toBe(true));
  test("endsWith /repo → true", () => expect(isSelfRepo("/home/dev/repo")).toBe(true));
  test("other → false", () => expect(isSelfRepo("/home/dev/project")).toBe(false));
});

// ── filterOutsideWritePaths (pure — the write-scope jail) ────────────

describe("filterOutsideWritePaths", () => {
  test("all within scope → empty", () => {
    expect(filterOutsideWritePaths(["README.md", "docs/a.md", "docs/sub/b.md"], ["README.md", "docs/"])).toEqual([]);
  });
  test("out-of-scope files flagged", () => {
    expect(filterOutsideWritePaths(["README.md", "src/x.ts", "package.json"], ["README.md", "docs/"])).toEqual(["src/x.ts", "package.json"]);
  });
  test("write path with no trailing slash matches dir prefix + exact", () => {
    expect(filterOutsideWritePaths(["docs", "docs/a.md", "other"], ["docs"])).toEqual(["other"]);
  });
});

// ── parsePrRef (pure) ───────────────────────────────────────────────

describe("parsePrRef", () => {
  test("full github url", () => {
    expect(parsePrRef("Opened https://github.com/o/r/pull/42 for review")).toBe("https://github.com/o/r/pull/42");
  });
  test("bare #number", () => {
    expect(parsePrRef("Created PR #17 with the docs")).toBe("#17");
  });
  test("no PR → null", () => {
    expect(parsePrRef("Nothing to change")).toBeNull();
  });
  test("undefined → null", () => {
    expect(parsePrRef(undefined)).toBeNull();
  });
});

// ── buildAgentPrompt (pure) ─────────────────────────────────────────

describe("buildAgentPrompt", () => {
  test("with sinceHash + subjects names the span + write scope", () => {
    const p = buildAgentPrompt({ headHash: "aaaaaaaa1111", sinceHash: "bbbbbbbb2222", subjects: ["feat: a", "fix: b"] }, ["README.md", "docs/"]);
    expect(p).toContain("merged since bbbbbbbb");
    expect(p).toContain("- feat: a");
    expect(p).toContain("Only edit files under: README.md, docs/");
  });
  test("first-ever run (no sinceHash) + empty subjects", () => {
    const p = buildAgentPrompt({ headHash: "cccccccc3333", subjects: [] }, ["README.md"]);
    expect(p).toContain("up to cccccccc");
    expect(p).toContain("(no commit subjects available)");
  });
});

// ── isGhUnavailable / statusLabel (pure) ────────────────────────────

describe("isGhUnavailable", () => {
  test("127 → true", () => expect(isGhUnavailable({ exitCode: 127, stdout: "", stderr: "" })).toBe(true));
  test("other → false", () => expect(isGhUnavailable({ exitCode: 1, stdout: "", stderr: "" })).toBe(false));
});

describe("statusLabel", () => {
  test("each status", () => {
    expect(statusLabel(makeRun({ status: "awaiting_approval" }))).toBe("Awaiting approval");
    expect(statusLabel(makeRun({ status: "finalizing" }))).toBe("Finalizing");
    expect(statusLabel(makeRun({ status: "finalizing", verifyManually: true }))).toBe("Verify manually");
    expect(statusLabel(makeRun({ status: "approved" }))).toBe("Approved");
    expect(statusLabel(makeRun({ status: "declined" }))).toBe("Declined");
    expect(statusLabel(makeRun({ status: "drafting" }))).toBe("Drafting");
    expect(statusLabel(makeRun({ status: "no_pr" }))).toBe("no_pr");
  });
});

// ── readGitHead / readCommitSubjects (real throwaway repo) ───────────

describe("git readers (real repo)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = join(tmpdir(), `du-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(repo, { recursive: true });
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-C", repo, ...args], {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      await p.exited;
    };
    await git("init", "-q");
    await git("config", "user.email", "probe@example.test");
    await git("config", "user.name", "Probe");
    writeFileSync(join(repo, "README.md"), "# probe\n");
    await git("add", "README.md");
    await git("commit", "-q", "-m", "feat: initial");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("readGitHead reads HEAD hash + subject", async () => {
    const head = await readGitHead(repo);
    expect(head!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head!.subject).toBe("feat: initial");
  });
  test("readGitHead on a non-repo → null", async () => {
    expect(await readGitHead(join(tmpdir(), `du-nope-${Date.now()}`))).toBeNull();
  });
  test("readCommitSubjects with no since → just HEAD subject", async () => {
    expect(await readCommitSubjects(repo, undefined)).toEqual(["feat: initial"]);
  });
  test("readCommitSubjects over a range returns the new subjects", async () => {
    const first = (await readGitHead(repo))!.hash;
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-C", repo, ...args], {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      await p.exited;
    };
    writeFileSync(join(repo, "docs.md"), "docs\n");
    await git("add", "docs.md");
    await git("commit", "-q", "-m", "docs: add");
    expect(await readCommitSubjects(repo, first)).toEqual(["docs: add"]);
  });
});

// ── checkDocsActivity ───────────────────────────────────────────────

describe("checkDocsActivity", () => {
  test("enabled=false → skip", async () => {
    let called = false;
    _setGitHeadForTests(async () => { called = true; return { hash: "x", subject: "y" }; });
    const { ctx } = makeCheckCtx({ settings: { enabled: false } });
    expect(await checkDocsActivity(ctx)).toEqual({ proceed: false, reason: "settings_disabled" });
    expect(called).toBe(false);
  });
  test("no git head → skip", async () => {
    _setGitHeadForTests(async () => null);
    const { ctx } = makeCheckCtx({ settings: { repo_path: "/r" } });
    expect(await checkDocsActivity(ctx)).toEqual({ proceed: false, reason: "no_git_head" });
  });
  test("cursor at HEAD → skip, cursor unchanged", async () => {
    _setGitHeadForTests(async () => ({ hash: "same", subject: "s" }));
    const { ctx, getCursor } = makeCheckCtx({ settings: { repo_path: "/r" }, cursor: "same" });
    expect(await checkDocsActivity(ctx)).toEqual({ proceed: false, reason: "no_new_commits" });
    expect(getCursor()).toBe("same");
  });
  test("first-ever commit → proceed + cursor set + subjects (no sinceHash)", async () => {
    _setGitHeadForTests(async () => ({ hash: "h1", subject: "feat: x" }));
    _setCommitSubjectsForTests(async () => ["feat: x"]);
    const { ctx, getCursor, logs } = makeCheckCtx({ settings: { repo_path: "/r" } });
    expect(await checkDocsActivity(ctx)).toEqual({ proceed: true, input: { headHash: "h1", subjects: ["feat: x"] } });
    expect(getCursor()).toBe("h1");
    expect(logs[0]).toContain("new work h1");
    expect(logs[0]).toContain("1 commit");
  });
  test("subsequent new commits → proceed carries sinceHash + plural log", async () => {
    _setGitHeadForTests(async () => ({ hash: "h2", subject: "fix: y" }));
    _setCommitSubjectsForTests(async () => ["fix: y", "chore: z"]);
    const { ctx, getCursor, logs } = makeCheckCtx({ settings: { repo_path: "/r" }, cursor: "h1" });
    expect(await checkDocsActivity(ctx)).toEqual({ proceed: true, input: { headHash: "h2", sinceHash: "h1", subjects: ["fix: y", "chore: z"] } });
    expect(getCursor()).toBe("h2");
    expect(logs[0]).toContain("2 commits");
  });
  test("blank repo_path falls back to the project root seam", async () => {
    let seen: string | undefined;
    _setGitHeadForTests(async (p) => { seen = p; return null; });
    _setProjectRootForTests(() => "/proj/root");
    const { ctx } = makeCheckCtx({ settings: {} });
    await checkDocsActivity(ctx);
    expect(seen).toBe("/proj/root");
  });
});

// ── docsUpdaterAct (deferred) ───────────────────────────────────────

describe("docsUpdaterAct", () => {
  test("spawns the configured agent + returns a deferred result", async () => {
    const { ctx, logs, spawnCalls } = makeActCtx({
      input: { headHash: "deadbeefcafe", subjects: ["feat: x"] },
      settings: { agent_name: "docs-bot" },
    });
    const result = await docsUpdaterAct(ctx);
    expect(result).toEqual({
      kind: "deferred",
      runId: "run-agent-1",
      status: "drafting",
      awaitEvent: "task:assignment_update",
      assignmentId: "assign-1",
      taskId: "task-1",
      subConversationId: "sub-1",
    });
    expect((spawnCalls[0] as { agentName: string }).agentName).toBe("docs-bot");
    expect((spawnCalls[0] as { task: string }).task).toContain("Only edit files under");
    expect(logs[0]).toContain("dispatched docs-bot");
  });
  test("defaults the agent to coder when unset", async () => {
    const { ctx, spawnCalls } = makeActCtx({ settings: {} });
    await docsUpdaterAct(ctx);
    expect((spawnCalls[0] as { agentName: string }).agentName).toBe("coder");
  });
});

// ── readPrChangedFiles / readPrStatus (gh, injected shell) ──────────

describe("readPrChangedFiles", () => {
  test("parses the name-only diff", async () => {
    const shell = scriptedShell(() => ({ exitCode: 0, stdout: "README.md\ndocs/a.md\n\n", stderr: "" }));
    expect(await readPrChangedFiles(shell, "/r", "#1")).toEqual({ files: ["README.md", "docs/a.md"], unavailable: false });
  });
  test("gh absent (127) → unavailable", async () => {
    const shell = scriptedShell(() => GH_ABSENT);
    expect(await readPrChangedFiles(shell, "/r", "#1")).toEqual({ files: [], unavailable: true });
  });
  test("gh error (non-zero) → empty files, available", async () => {
    const shell = scriptedShell(() => ({ exitCode: 1, stdout: "", stderr: "boom" }));
    expect(await readPrChangedFiles(shell, "/r", "#1")).toEqual({ files: [], unavailable: false });
  });
});

describe("readPrStatus", () => {
  test("parses state + mergeable JSON", async () => {
    const shell = scriptedShell(() => ({ exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" }));
    expect(await readPrStatus(shell, "/r", "#1")).toEqual({ state: "OPEN", mergeable: "MERGEABLE", unavailable: false });
  });
  test("gh absent → unavailable", async () => {
    expect(await readPrStatus(scriptedShell(() => GH_ABSENT), "/r", "#1")).toEqual({ unavailable: true });
  });
  test("non-zero → error", async () => {
    const r = await readPrStatus(scriptedShell(() => ({ exitCode: 1, stdout: "", stderr: "no pr" })), "/r", "#1");
    expect(r).toEqual({ unavailable: false, error: "no pr" });
  });
  test("non-zero with empty stderr → exit-coded error", async () => {
    const r = await readPrStatus(scriptedShell(() => ({ exitCode: 2, stdout: "", stderr: "" })), "/r", "#1");
    expect(r).toEqual({ unavailable: false, error: "exit 2" });
  });
  test("non-JSON stdout → parse error", async () => {
    const r = await readPrStatus(scriptedShell(() => ({ exitCode: 0, stdout: "not json", stderr: "" })), "/r", "#1");
    expect(r).toEqual({ unavailable: false, error: "gh pr view returned non-JSON" });
  });
});

// ── finalizeDocsPr (the gh approval pipeline) ───────────────────────

const IN_SCOPE_DIFF = { exitCode: 0, stdout: "README.md\ndocs/a.md\n", stderr: "" };
function ghFinalize(map: Partial<Record<string, ShellResult>>): ShellRunner {
  return scriptedShell((cmd) => {
    const sub = cmd.slice(1, 3).join(" "); // e.g. "pr diff"
    return map[sub] ?? OK;
  });
}

describe("finalizeDocsPr", () => {
  const base = { repo: "/r", prRef: "#1", writePaths: ["README.md", "docs/"], selfRepo: true, autoMerge: false };

  test("out-of-scope change → rejected_out_of_scope (never marks)", async () => {
    const shell = ghFinalize({ "pr diff": { exitCode: 0, stdout: "src/x.ts\n", stderr: "" } });
    const r = await finalizeDocsPr(shell, base);
    expect(r.marked).toBe("rejected_out_of_scope");
    expect(r.note).toContain("src/x.ts");
  });
  test("gh absent at diff → skipped_gh_unavailable", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": GH_ABSENT }), base);
    expect(r.marked).toBe("skipped_gh_unavailable");
  });
  test("gh absent at view → skipped", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": GH_ABSENT }), base);
    expect(r.marked).toBe("skipped_gh_unavailable");
  });
  test("pr view error → pr_read_failed", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 1, stdout: "", stderr: "gone" } }), base);
    expect(r.marked).toBe("pr_read_failed");
    expect(r.note).toBe("gone");
  });
  test("PR not OPEN → already_<state>", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "MERGED" }), stderr: "" } }), base);
    expect(r.marked).toBe("already_merged");
  });
  test("conflicting → not_mergeable", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "CONFLICTING" }), stderr: "" } }), base);
    expect(r.marked).toBe("not_mergeable");
  });
  test("gh absent at comment → skipped", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" }, "pr comment": GH_ABSENT }), base);
    expect(r.marked).toBe("skipped_gh_unavailable");
  });
  test("gh absent at ready → skipped", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" }, "pr ready": GH_ABSENT }), base);
    expect(r.marked).toBe("skipped_gh_unavailable");
  });
  test("/repo → ready (never merges) + note", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" } }), base);
    expect(r.marked).toBe("ready");
    expect(r.note).toContain("manual");
  });
  test("non-/repo without auto-merge → ready, no note", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" } }), { ...base, selfRepo: false });
    expect(r.marked).toBe("ready");
    expect(r.note).toBeUndefined();
  });
  test("non-/repo + auto-merge → merged", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" } }), { ...base, selfRepo: false, autoMerge: true });
    expect(r.marked).toBe("merged");
  });
  test("auto-merge gh absent → skipped", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" }, "pr merge": GH_ABSENT }), { ...base, selfRepo: false, autoMerge: true });
    expect(r.marked).toBe("skipped_gh_unavailable");
  });
  test("auto-merge failure → merge_failed", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" }, "pr merge": { exitCode: 1, stdout: "", stderr: "blocked" } }), { ...base, selfRepo: false, autoMerge: true });
    expect(r.marked).toBe("merge_failed");
    expect(r.note).toBe("blocked");
  });
  test("auto-merge failure with empty stderr → exit-coded", async () => {
    const r = await finalizeDocsPr(ghFinalize({ "pr diff": IN_SCOPE_DIFF, "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" }, "pr merge": { exitCode: 3, stdout: "", stderr: "" } }), { ...base, selfRepo: false, autoMerge: true });
    expect(r.note).toBe("exit 3");
  });
});

// ── discardDocsPr ───────────────────────────────────────────────────

describe("discardDocsPr", () => {
  test("closes the PR (no throw)", async () => {
    let closed = false;
    const shell = scriptedShell((cmd) => { if (cmd[2] === "close") closed = true; return OK; });
    await discardDocsPr(shell, "/r", "#1");
    expect(closed).toBe(true);
  });
  test("gh absent → skip-not-fail (no throw)", async () => {
    await expect(discardDocsPr(scriptedShell(() => GH_ABSENT), "/r", "#1")).resolves.toBeUndefined();
  });
});

// ── docsUpdaterOnComplete (deferred → proposal) ─────────────────────

describe("docsUpdaterOnComplete", () => {
  test("no PR in the completion → terminal no_pr", async () => {
    const { ctx, logs } = makeCompleteCtx({ resultPreview: "Nothing to update" });
    const r = await docsUpdaterOnComplete(ctx);
    expect(r).toEqual({ kind: "terminal", status: "no_pr", outcome: { headHash: "abcdef1234567890", note: "no PR drafted" } });
    expect(logs[0]).toContain("without opening a PR");
  });
  test("in-scope PR → parks a proposal (kind pr)", async () => {
    _setShellForTests(scriptedShell(() => IN_SCOPE_DIFF));
    const { ctx } = makeCompleteCtx({ resultPreview: "Opened https://github.com/o/r/pull/9" });
    const r = await docsUpdaterOnComplete(ctx);
    expect(r.kind).toBe("proposal");
    if (r.kind !== "proposal") throw new Error("expected proposal");
    expect(r.proposal).toEqual({
      title: "Docs update for abcdef12",
      summary: "Drafted PR https://github.com/o/r/pull/9 updating docs for 1 commit(s).",
      kind: "pr",
      ref: "https://github.com/o/r/pull/9",
    });
    expect(typeof r.finalize).toBe("function");
    expect(typeof r.discard).toBe("function");
  });
  test("out-of-scope PR → closed + terminal rejected_out_of_scope", async () => {
    let closed = false;
    _setShellForTests(scriptedShell((cmd) => {
      if (cmd[2] === "diff") return { exitCode: 0, stdout: "src/evil.ts\n", stderr: "" };
      if (cmd[2] === "close") { closed = true; return OK; }
      return OK;
    }));
    const { ctx, logs } = makeCompleteCtx({ resultPreview: "PR #5" });
    const r = await docsUpdaterOnComplete(ctx);
    expect(r).toMatchObject({ kind: "terminal", status: "rejected_out_of_scope" });
    expect(closed).toBe(true);
    expect(logs.join(" ")).toContain("out-of-scope");
  });
  test("out-of-scope discard failure is swallowed (best-effort)", async () => {
    _setShellForTests(scriptedShell((cmd) => {
      if (cmd[2] === "diff") return { exitCode: 0, stdout: "src/evil.ts\n", stderr: "" };
      throw new Error("close blew up");
    }));
    const { ctx } = makeCompleteCtx({ resultPreview: "PR #5" });
    const r = await docsUpdaterOnComplete(ctx);
    expect(r).toMatchObject({ kind: "terminal", status: "rejected_out_of_scope" });
  });
  test("gh unavailable → parks with a scope re-check note", async () => {
    _setShellForTests(scriptedShell(() => GH_ABSENT));
    const { ctx } = makeCompleteCtx({ resultPreview: "PR #9", input: { headHash: "aaaabbbbcccc", subjects: [] } });
    const r = await docsUpdaterOnComplete(ctx);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    expect(r.proposal.summary).toContain("re-checked at approval");
  });
  test("finalize closure threads the head hash", async () => {
    _setShellForTests(scriptedShell((cmd) => {
      if (cmd[2] === "diff") return IN_SCOPE_DIFF;
      if (cmd[2] === "view") return { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" };
      return OK;
    }));
    const { ctx } = makeCompleteCtx({ resultPreview: "PR #9", input: { headHash: "abcdef123456", subjects: ["feat: a"] }, settings: { repo_path: "/x" } });
    const r = await docsUpdaterOnComplete(ctx);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    const outcome = await r.finalize();
    expect(outcome.headHash).toBe("abcdef123456");
    expect(outcome.marked).toBe("ready");
  });
  test("discard closure closes the PR", async () => {
    let closed = false;
    _setShellForTests(scriptedShell((cmd) => {
      if (cmd[2] === "diff") return IN_SCOPE_DIFF;
      if (cmd[2] === "close") { closed = true; return OK; }
      return OK;
    }));
    const { ctx } = makeCompleteCtx({ resultPreview: "PR #9" });
    const r = await docsUpdaterOnComplete(ctx);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    await r.discard!();
    expect(closed).toBe(true);
  });
});

// ── buildDashboard ──────────────────────────────────────────────────

describe("buildDashboard", () => {
  test("empty → empty-state", () => {
    const tree = buildDashboard([]).build();
    const json = JSON.stringify(tree);
    expect(json).toContain("No runs yet");
  });
  test("parked run gets Approve + Decline buttons + PR ref", () => {
    const run = makeRun({ id: "run-x", status: "awaiting_approval", proposal: { title: "Docs update", summary: "s", kind: "pr", ref: "#9" } });
    const json = JSON.stringify(buildDashboard([run]).build());
    expect(json).toContain(APPROVE_EVENT);
    expect(json).toContain(DECLINE_EVENT);
    expect(json).toContain("#9");
    expect(json).toContain("run-x");
  });
  test("non-parked run gets no action buttons", () => {
    const run = makeRun({ id: "run-y", status: "approved", proposal: { title: "T", summary: "s", kind: "pr" } });
    const json = JSON.stringify(buildDashboard([run]).build());
    expect(json).not.toContain(APPROVE_EVENT);
  });
});

// ── row actions (host-stamped decidedBy) ────────────────────────────

function makeEvent(overrides: Partial<PageActionEvent> = {}): PageActionEvent {
  return { source: "hub", pageId: "dashboard", userId: "user-42", ...overrides };
}

describe("handleApproveAction", () => {
  test("threads host-stamped userId as decidedBy", async () => {
    const calls: unknown[] = [];
    _setResolversForTests(async (loopId, runId, decidedBy) => { calls.push([loopId, runId, decidedBy]); return { ok: true, runId, decision: "approved", finalized: true }; }, null);
    await handleApproveAction(makeEvent({ payload: { runId: "run-7" } }));
    expect(calls[0]).toEqual([LOOP_ID, "run-7", "user-42"]);
  });
  test("missing runId → no-op", async () => {
    let called = false;
    _setResolversForTests(async () => { called = true; return { ok: false, reason: "x" }; }, null);
    await handleApproveAction(makeEvent({ payload: {} }));
    expect(called).toBe(false);
  });
  test("missing host userId → refuses (no empty decidedBy)", async () => {
    let called = false;
    _setResolversForTests(async () => { called = true; return { ok: false, reason: "x" }; }, null);
    await handleApproveAction(makeEvent({ userId: "", payload: { runId: "run-7" } }));
    expect(called).toBe(false);
  });
});

describe("handleDeclineAction", () => {
  test("threads userId + note", async () => {
    const calls: unknown[] = [];
    _setResolversForTests(null, async (loopId, runId, decidedBy, note) => { calls.push([loopId, runId, decidedBy, note]); return { ok: true, runId, decision: "declined" }; });
    await handleDeclineAction(makeEvent({ payload: { runId: "run-8", note: "stale" } }));
    expect(calls[0]).toEqual([LOOP_ID, "run-8", "user-42", "stale"]);
  });
  test("no note → undefined note", async () => {
    const calls: unknown[] = [];
    _setResolversForTests(null, async (loopId, runId, decidedBy, note) => { calls.push([runId, note]); return { ok: true, runId, decision: "declined" }; });
    await handleDeclineAction(makeEvent({ payload: { runId: "run-8" } }));
    expect(calls[0]).toEqual(["run-8", undefined]);
  });
  test("missing runId → no-op", async () => {
    let called = false;
    _setResolversForTests(null, async () => { called = true; return { ok: false, reason: "x" }; });
    await handleDeclineAction(makeEvent({ payload: {} }));
    expect(called).toBe(false);
  });
  test("missing host userId → refuses", async () => {
    let called = false;
    _setResolversForTests(null, async () => { called = true; return { ok: false, reason: "x" }; });
    await handleDeclineAction(makeEvent({ userId: "", payload: { runId: "run-8" } }));
    expect(called).toBe(false);
  });
});

// ── getShell / makeProductionShell ──────────────────────────────────

describe("shell resolution", () => {
  test("getShell returns the injected seam, else a production runner", () => {
    const fake = scriptedShell(() => OK);
    _setShellForTests(fake);
    expect(getShell("/r")).toBe(fake);
    _setShellForTests(null);
    expect(typeof getShell("/r")).toBe("function");
  });
  test("makeProductionShell threads cmd + cwd through the sandbox seam", async () => {
    const dir = join(tmpdir(), `du-ps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const shell = makeProductionShell(dir);
      const r = await shell(["/bin/sh", "-c", "echo DU_OK"], dir);
      expect(typeof r.exitCode).toBe("number");
      expect(typeof r.stdout).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── manifest ────────────────────────────────────────────────────────

describe("manifest", () => {
  test("passes validateManifestV2 (snake_case settings keys)", () => {
    const result = validateManifestV2(config);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(Object.keys(config.settings ?? {})).toEqual(
      expect.arrayContaining(["enabled", "repo_path", "agent_name", "write_paths", "base_branch", "auto_merge"]),
    );
  });
  test("declares the loop grants (spawnAgents, loopEvents, page-action events)", () => {
    expect(config.name).toBe("docs-updater");
    expect(config.persistent).toBe(true);
    expect(config.permissions?.spawnAgents).toBeDefined();
    expect(config.permissions?.loopEvents).toBe(true);
    expect(config.permissions?.shell).toBe(true);
    expect(config.permissions?.schedule?.crons).toEqual(["0 6 * * *"]);
    expect(config.permissions?.eventSubscriptions).toEqual(
      expect.arrayContaining(["task:assignment_update", APPROVE_EVENT, DECLINE_EVENT]),
    );
    expect(config.pages?.[0]?.id).toBe("dashboard");
  });
});
