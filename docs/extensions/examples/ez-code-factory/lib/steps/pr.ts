// ── PR step — port of internal/pipeline/steps/pr.go ─────────────────
//
// After the local steps pass and the branch is force-pushed to the real
// upstream (`origin` of the gate repo), open or update a pull request. The title
// is a conventional-commit subject and the body is assembled DETERMINISTICALLY:
// the LLM authors ONLY the "## What Changed" slice; `## Intent` is the verbatim
// sanitized run.intent, and `## Risk Assessment` / `## Testing` / `## Pipeline`
// are computed from the persisted step results + rounds (pr-body.ts). GitHub-only
// (decision #3): the provider is detected from the gate repo's upstream URL;
// anything but github.com — or a default-branch push, or an unauthenticated /
// missing gh — SKIPS (skip-not-fail), mirroring upstream.

import type { DispatchResult } from "../agent";
import {
  detectProvider,
  extractHost,
  makeGitHubHost,
  repoSlug,
  type GitHubHost,
  type PRContent,
} from "../github";
import {
  assemblePRBody,
  fallbackTitle,
  stripGeneratedSections,
  unwrapNestedPRBody,
  MAX_PR_BODY_BYTES,
} from "../pr-body";
import { tightenTitle, RELEASE_TYPE_RULE } from "../conventional";
import {
  cleanedUserIntent,
  executionContextPromptSection,
  userIntentPromptSection,
  PR_CONTENT_SCHEMA,
} from "../prompts";
import {
  intentIsAuthoritative,
  repoDispatchOptions,
  resolveBranchBaseSHA,
  type Step,
  type StepContext,
  type StepOutcome,
} from "./common";

export const prStep: Step = {
  name: "pr",
  execute: executePR,
};

/** Strip a `refs/heads/` prefix. */
function branchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** The gate repo's upstream URL (its `origin`, set at init to the real remote),
 *  read from the worktree — a linked worktree shares the repo's remote config.
 *  "" when unreadable (→ provider unknown → skip). */
async function resolveUpstreamUrl(sctx: StepContext): Promise<string> {
  const r = await sctx.hostGit.try("remote", "get-url", "origin");
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

async function executePR(sctx: StepContext): Promise<StepOutcome> {
  const branch = branchName(sctx.run.branch);
  const defaultBranch = sctx.repo.defaultBranch.trim() || "main";
  if (branch === defaultBranch) {
    sctx.log(`skipping PR creation on default branch ${branch}`);
    return { skipped: true };
  }

  const upstreamUrl = await resolveUpstreamUrl(sctx);
  if (detectProvider(upstreamUrl) !== "github") {
    sctx.log("skipping PR creation: not a GitHub upstream");
    return { skipped: true };
  }
  const host = makeGitHubHost(sctx.gh, { host: extractHost(upstreamUrl), repo: repoSlug(upstreamUrl) });
  const unavailable = await host.available();
  if (unavailable !== null) {
    sctx.log(`skipping PR creation: ${unavailable}`);
    return { skipped: true };
  }

  const baseSHA = await resolveBranchBaseSHA(sctx.hostGit, sctx.run.baseSha, defaultBranch);
  const content = await buildPRContent(sctx, branch, baseSHA, defaultBranch);

  sctx.log(`checking for existing pull request on branch ${branch}...`);
  const existing = await host.findPR(branch, defaultBranch);
  if (existing !== null) {
    sctx.log(`pull request already exists: ${existing.url}, updating...`);
    let updatedUrl = existing.url;
    try {
      updatedUrl = (await host.updatePR(existing, content)).url;
    } catch (err) {
      sctx.log(`warning: failed to update PR: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (updatedUrl !== "") await sctx.updatePrUrl(updatedUrl);
    return {};
  }

  sctx.log("creating pull request...");
  const created = await host.createPR(branch, defaultBranch, content);
  if (created !== null && created.url !== "") {
    sctx.log(`created pull request: ${created.url}`);
    await sctx.updatePrUrl(created.url);
  }
  return {};
}

/** Best-effort `git log --oneline base..head`. "" on error. */
async function commitLogText(sctx: StepContext, baseSHA: string): Promise<string> {
  const r = await sctx.hostGit.try("log", "--oneline", "--no-decorate", `${baseSHA}..${sctx.run.headSha}`);
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

/** Best-effort `git diff --stat base..head`. "" on error. */
async function diffStatText(sctx: StepContext, baseSHA: string): Promise<string> {
  const r = await sctx.hostGit.try("diff", "--stat", `${baseSHA}..${sctx.run.headSha}`);
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

/**
 * Build the PR title + body. The agent authors only "## What Changed"; on any
 * failure (dispatch throw, unusable output) fall back to a deterministic title
 * (first commit subject) + a commit-log body. Either way the body is assembled
 * through the deterministic Intent/Risk/Testing/Pipeline pipeline with the
 * truncation ladder.
 */
async function buildPRContent(
  sctx: StepContext,
  branch: string,
  baseSHA: string,
  defaultBranch: string,
): Promise<PRContent> {
  const steps = await sctx.loadStepHistory();
  const commitLog = await commitLogText(sctx, baseSHA);
  const diffStat = await diffStatText(sctx, baseSHA);
  const cleanedIntent = cleanedUserIntent(sctx.run.intent);
  const intentCtx = { intent: sctx.run.intent, authoritative: intentIsAuthoritative(sctx.run) };

  const prompt = buildPRPrompt({
    branch,
    baseSHA,
    targetSHA: sctx.run.headSha,
    defaultBranch,
    commitLog,
    diffStat,
    intentCtx,
  });

  let result: DispatchResult | null = null;
  try {
    result = await sctx.dispatcher.dispatch({
      role: "generic",
      prompt,
      cwd: sctx.worktree,
      jsonSchema: PR_CONTENT_SCHEMA,
      ...repoDispatchOptions(sctx),
    });
  } catch (err) {
    sctx.log(`agent failed for PR content, using fallback: ${err instanceof Error ? err.message : String(err)}`);
  }

  const agentContent = result !== null ? parseAgentPRContent(result) : null;
  if (agentContent !== null) {
    const whatChanged = stripGeneratedSections(unwrapNestedPRBody(agentContent.body));
    if (whatChanged !== "") {
      return {
        title: tightenTitle(agentContent.title),
        body: assemblePRBody({ cleanedIntent, whatChanged, steps }),
      };
    }
  }

  // Fallback: derive a title from the commit log and a body from it.
  const title = fallbackTitle(commitLog, branch);
  const body = commitLog !== "" ? `## What Changed\n\n${commitLog}` : `## What Changed\n\n- ${title}`;
  return { title, body: assemblePRBody({ cleanedIntent, whatChanged: body, steps }) };
}

/** Extract a valid `{title, body}` from the agent's structured output, or null. */
function parseAgentPRContent(result: DispatchResult): { title: string; body: string } | null {
  const o = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : null;
  if (o === null) return null;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const body = typeof o.body === "string" ? o.body.trim() : "";
  if (title === "" || body === "") return null;
  return { title, body };
}

interface PRPromptInput {
  branch: string;
  baseSHA: string;
  targetSHA: string;
  defaultBranch: string;
  commitLog: string;
  diffStat: string;
  intentCtx: { intent: string | null; authoritative: boolean };
}

/** The verbatim PR-content prompt (pr.go buildPRContent), built as a single
 *  template so its prose lines never split into phantom coverage rows. */
function buildPRPrompt(input: PRPromptInput): string {
  const { branch, baseSHA, targetSHA, defaultBranch, commitLog, diffStat, intentCtx } = input;
  const budgetNote = `\n\n- This repository's host caps the entire PR description at ${MAX_PR_BODY_BYTES} bytes. The Intent, Risk Assessment, and Pipeline sections are appended automatically; a Testing section is included when budget allows. Keep the "## What Changed" section to a few short bullet points.`;
  return `Draft a pull request title and summary for the full branch delta.

Context:
- branch: ${branch}
- base commit: ${baseSHA}
- target commit: ${targetSHA}
- default branch: ${defaultBranch}

Rules:
- Cover the full branch delta, not just the latest commit.
- Title must use conventional commit format: "type(scope): description" or "type: description". Valid types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Scope is optional. Do not capitalize the type. Do not use the raw branch name.
${RELEASE_TYPE_RULE}
- When including a scope, it MUST be a real package/module name that exists in the codebase, identified by inspecting the changed paths. Pick the primary module affected by the change, not a secondary or incidental one.
- Keep the scope at a coarse level, not too granular. Prefer a broad module name over a narrow file or sub-feature name. If you cannot confidently identify a real primary module, omit the scope and use "type: description".
- Body: a "## What Changed" section in GitHub-flavored markdown. 1-3 concise bullet points describing the concrete changes in this branch (what code/behavior shifted), not the user's motivation. Do not include Intent, Risk Assessment, Testing, or Pipeline sections - those are prepended/appended separately. The body value must be plain markdown text, never a JSON object or serialized JSON string.
- Do not invent tests or behavior.

Commit history:
${commitLog}

Diff stat:
${diffStat}${userIntentPromptSection(intentCtx)}${executionContextPromptSection()}${budgetNote}`;
}
