#!/usr/bin/env bun
// repo-activity-notify — the reference "check → notify" trust-probe loop.
//
// The smallest end-to-end demonstration of the `check` stage (Phase 1): a
// READ-ONLY loop that, on a cron tick or an on-demand manual run, asks a
// deterministic `check` "are there new commits since I last looked?" and —
// only when there are — runs an `act` that appends a one-line notice to its
// wired conversation and mirrors it to a git-legible artifact.
//
//   trigger (cron | manual)
//     → check  : git HEAD vs the durable cursor (sandboxed `git`, NO LLM)
//         · unchanged → { proceed: false }  (a logged skip, not an error)
//         · new commit → advance cursor, enrich input with the commit
//     → act    : append the notice (append-message precedent) + artifact
//
// There is deliberately NO finalize, NO approval, and NO consequential
// action — appending an excluded notice + writing a mirror is the whole
// side effect. It is the campaign's first live hypothesis test: will a user
// leave an autonomous loop enabled?
//
// The `check` runs deterministic `git` via `Bun.spawn` (shell grant) — the
// check context structurally CANNOT reach an LLM (see LoopCheckContext).
// See docs/extensions/loops.md#the-check-stage for the full reference.

import {
  createToolDispatcher,
  defineLoop,
  getChannel,
  getLoopTools,
  type ActResult,
  type CheckResult,
  type LoopActContext,
  type LoopCheckContext,
} from "@ezcorp/sdk/runtime";

/** The deterministic enrichment a proceeding `check` hands to `act`: the
 *  commit that tripped the cursor. Exported so tests can assert the shape. */
export interface NotifyInput {
  hash: string;
  subject: string;
  /** The prior cursor value, when the loop had already seen a commit. */
  previousHash?: string;
}

/** A recorded notify outcome. Exported for test + artifact assertions. */
export interface NotifyOutcome {
  hash: string;
  subject: string;
  notice: string;
  /** Whether the notice was appended to a conversation (false = artifact
   *  only, e.g. no conversation configured / no message to anchor to). */
  appended: boolean;
}

// ── git HEAD reader (sandboxed exec) ────────────────────────────────

/** The current HEAD commit of a repo: its full hash + subject line. */
export interface GitHead {
  hash: string;
  subject: string;
}
export type GitHeadReader = (repoPath: string) => Promise<GitHead | null>;

/**
 * Parse `git log -1 --format=%H%x00%s` output into a HEAD. Pure — split out
 * so every branch (git failure, empty output, missing subject, empty hash)
 * is unit-testable without spawning git. `%x00` (NUL) separates hash from
 * subject so a subject line can never be confused with the delimiter.
 */
export function parseGitHead(stdout: string, exitCode: number): GitHead | null {
  if (exitCode !== 0) return null;
  const line = stdout.trim();
  if (!line) return null;
  const nul = line.indexOf("\0");
  const hash = nul === -1 ? line : line.slice(0, nul);
  const subject = nul === -1 ? "" : line.slice(nul + 1);
  return hash ? { hash, subject } : null;
}

/**
 * Read `<repo>`'s HEAD commit via `git log -1`. Deterministic + read-only —
 * the exact "structured endpoint" the check firewall is honest about (vs
 * messy HTML). Returns `null` when the repo has no commits or `git` fails
 * (missing repo, not a checkout) so the check degrades to a clean skip.
 *
 * The env pins git hermetic (no user/system config) — a stray global config
 * line must not make git fatal.
 */
export async function readGitHead(repoPath: string): Promise<GitHead | null> {
  const proc = Bun.spawn(
    ["git", "-C", repoPath, "log", "-1", "--format=%H%x00%s"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return parseGitHead(out, code);
}

// ── Module-level seams (test injection) ─────────────────────────────

let gitHeadImpl: GitHeadReader = readGitHead;
/** @internal test-only — substitute the git HEAD reader. */
export function _setGitHeadForTests(fn: GitHeadReader | null): void {
  gitHeadImpl = fn ?? readGitHead;
}

type AppendMessageRpc = (params: Record<string, unknown>) => Promise<unknown>;
const defaultAppendMessage: AppendMessageRpc = (params) =>
  getChannel().request("ezcorp/append-message", params);
let appendMessageImpl: AppendMessageRpc = defaultAppendMessage;
/** @internal test-only — substitute the append-message reverse RPC. */
export function _setAppendMessageForTests(fn: AppendMessageRpc | null): void {
  appendMessageImpl = fn ?? defaultAppendMessage;
}

// ── check ───────────────────────────────────────────────────────────

/**
 * The deterministic gate. Resolves the repo's HEAD and compares it to the
 * durable cursor. No change → `{ proceed: false }` (logged skip). New commit
 * → advance the cursor and enrich the input with the commit so `act` never
 * re-derives it. Exported so a unit test can drive it with an injected git
 * reader + an in-memory cursor.
 */
export async function checkRepoActivity(
  ctx: LoopCheckContext<NotifyInput>,
): Promise<CheckResult<NotifyInput>> {
  if (ctx.settings.enabled === false) {
    return { proceed: false, reason: "settings_disabled" };
  }
  const repoPath =
    typeof ctx.settings.repoPath === "string" && ctx.settings.repoPath.length > 0
      ? ctx.settings.repoPath
      : (process.env.EZCORP_PROJECT_ROOT ?? process.cwd());

  const head = await gitHeadImpl(repoPath);
  if (!head) return { proceed: false, reason: "no_git_head" };

  const previousHash = await ctx.cursor.get<string>();
  if (previousHash === head.hash) {
    return { proceed: false, reason: "no_new_commits" };
  }

  await ctx.cursor.set(head.hash);
  ctx.log(`new commit ${head.hash.slice(0, 8)} — ${head.subject}`);
  return {
    proceed: true,
    input: {
      hash: head.hash,
      subject: head.subject,
      ...(previousHash ? { previousHash } : {}),
    },
  };
}

// ── act ─────────────────────────────────────────────────────────────

/**
 * Append a one-line notice about the new commit to the loop's wired
 * conversation (via the `ezcorp/append-message` precedent — an excluded
 * `role: extension` turn) and return the outcome for the artifact mirror.
 * If no conversation is configured (or it has no message to anchor to) the
 * loop stays useful as an artifact-only trail. Exported for unit tests.
 */
export async function notifyAct(
  ctx: LoopActContext<NotifyInput>,
): Promise<ActResult<NotifyOutcome>> {
  const { hash, subject } = ctx.input;
  const notice = `repo-activity-notify: new commit ${hash.slice(0, 8)} — ${subject}`;

  const conversationId =
    typeof ctx.settings.conversationId === "string" ? ctx.settings.conversationId : "";

  let appended = false;
  if (conversationId) {
    const recent = await ctx.recentMessages(conversationId, 1);
    const parentMessageId = recent.length > 0 ? recent[recent.length - 1]!.id : "";
    if (parentMessageId) {
      await appendMessageImpl({
        conversationId,
        parentMessageId,
        role: "extension",
        content: notice,
        // The host force-applies excluded:true; we pass it to make intent
        // explicit at the call site (mirrors kokoro-tts / ez-code).
        excluded: true,
      });
      appended = true;
    } else {
      ctx.log("no message to anchor the notice; artifact-only", "warn");
    }
  } else {
    ctx.log("no conversationId configured; artifact-only", "warn");
  }

  return {
    kind: "terminal",
    status: "done",
    outcome: { hash, subject, notice, appended },
  };
}

// ── registration ────────────────────────────────────────────────────

/**
 * Register the loop. Exported (not auto-run) so unit tests can register it
 * against a stubbed channel without `import.meta.main`.
 */
export function defineRepoActivityNotifyLoop(): void {
  defineLoop<NotifyInput, NotifyOutcome>({
    id: "repo-activity-notify",
    trigger: [
      // Hourly sweep + an on-demand manual run (explicit start; the
      // dispatcher never spawns this loop for you).
      { kind: "cron", cron: "0 * * * *" },
      { kind: "manual", tool: "check_repo_activity" },
    ],
    contract: { states: ["done"], scope: "global", retention: { maxRuns: 50 } },
    // The deterministic gate: only proceed to act on a genuinely new commit.
    check: checkRepoActivity,
    act: notifyAct,
    log: {
      // Mirror each notice to a git-legible artifact (fail-soft; the durable
      // record lives in Storage, never the file).
      artifact: (run, outcome) => ({
        path: `notices/${run.id}.md`,
        body: `# Repo activity notice\n\n${outcome.notice}\n`,
      }),
    },
  });
}

/**
 * Production boot: register the loop, mount the manual-trigger tool, and
 * start the channel read loop. Exported (not inlined under
 * `import.meta.main`) so a unit test can drive the boot path against the SDK
 * test channel — mirrors the sample-loop example.
 */
export function start(): void {
  defineRepoActivityNotifyLoop();
  createToolDispatcher({ ...getLoopTools() });
  getChannel().start();
}

// Gated on `import.meta.main` so test imports don't open stdin.
if (import.meta.main) start();
