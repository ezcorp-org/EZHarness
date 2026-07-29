// ── Review step — port of internal/pipeline/steps/review.go ─────────
//
// Structured AI review of the branch diff: findings {severity, action} + a risk
// assessment. Auto-fix cap defaults to 0 (config), so review ALWAYS parks a
// blocking finding for a human. The main + fix prompts are ported VERBATIM
// (only Go %s substitution → template literals); the intent-conformance clause
// and round-history / execution-context / user-intent sections come from
// prompts.ts. `ignore_patterns` filter an empty changeset to an auto-pass.

import { basename } from "node:path";
import { deserializeFindings, serializeFindings } from "../runs";
import {
  REVIEW_FINDINGS_SCHEMA,
  COMMIT_SUMMARY_SCHEMA,
  executionContextPromptSection,
  roundHistoryPromptSection,
  userIntentPromptSection,
  intentConformanceReviewClause,
  jobInstructionsPromptSection,
  reviewMainPromptBody,
  reviewFixPromptBody,
} from "../prompts";
import { hasBlockingFindings } from "../findings";
import {
  intentIsAuthoritative,
  repoDispatchOptions,
  resolveBranchBaseSHA,
  executeFixMode,
  type Step,
  type StepContext,
  type StepOutcome,
} from "./common";

export const reviewStep: Step = {
  name: "review",
  execute: executeReview,
};

/** gitignore-lite glob → RegExp. `*`/`?` do not cross `/`. Everything else is a
 *  literal. (Char classes are not special in M1 — ignore patterns are `*.ext`
 *  and `dir/**`, the latter handled by the /** case below.) */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (const c of glob) {
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

/** gitignore-like match. Verbatim matchIgnorePattern semantics. */
export function matchIgnorePattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -"/**".length);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (!pattern.includes("/")) return globToRegExp(pattern).test(basename(path));
  return globToRegExp(pattern).test(path);
}

async function executeReview(sctx: StepContext): Promise<StepOutcome> {
  const defaultBranch = sctx.repo.defaultBranch.trim() || "main";
  const baseSHA = await resolveBranchBaseSHA(sctx.hostGit, sctx.run.baseSha, defaultBranch);
  const branch = sctx.run.branch;
  const ignorePatterns = sctx.config.ignorePatterns.length > 0 ? sctx.config.ignorePatterns.join(", ") : "none";
  const reviewScope = sctx.fixing
    ? `current worktree and HEAD changes relative to base commit ${baseSHA} (starting head ${sctx.run.headSha})`
    : `branch changes between ${baseSHA} and ${sctx.run.headSha}`;
  const intentCtx = { intent: sctx.run.intent, authoritative: intentIsAuthoritative(sctx.run) };
  const reviewBase = {
    branch,
    baseCommit: baseSHA,
    targetCommit: sctx.run.headSha,
    reviewScope,
    defaultBranch,
    ignorePatterns,
  };

  let fixSummary = "";
  if (sctx.fixing) {
    // review-fix carries BOTH operator sections (review first, then fix) prepended
    // to the history — the review family gets reviewInstructions, every fix round
    // gets fixInstructions.
    const historySection =
      jobInstructionsPromptSection(sctx.jobReviewInstructions) +
      jobInstructionsPromptSection(sctx.jobFixInstructions) +
      executionContextPromptSection() + roundHistoryPromptSection(sctx.rounds) + userIntentPromptSection(intentCtx);
    const fixPrompt = reviewFixPromptBody({
      ...reviewBase,
      historySection,
      previousFindings: sctx.previousFindings,
    });
    fixSummary = await executeFixMode(sctx, "review", {
      requirePreviousFindings: true,
      missingFindingsError: "review fix requires previous review findings",
      logMessage: "asking agent to fix identified issues...",
      prompt: fixPrompt,
      errorPrefix: "agent fix",
      fallbackSummary: "address review findings",
      role: "fixer",
      jsonSchema: COMMIT_SUMMARY_SCHEMA,
    });
  }

  // Reviewable changed files after ignore filtering.
  const diffArgs = sctx.fixing
    ? ["diff", "--name-only", baseSHA]
    : ["diff", "--name-only", `${baseSHA}..${sctx.run.headSha}`];
  let changedFiles: string;
  try {
    changedFiles = await sctx.hostGit.run(...diffArgs);
  } catch (err) {
    throw new Error(`get changed files: ${err instanceof Error ? err.message : String(err)}`);
  }
  let hasReviewableChanges = false;
  for (const raw of changedFiles.split("\n")) {
    const path = raw.trim();
    if (path === "") continue;
    if (!sctx.config.ignorePatterns.some((p) => matchIgnorePattern(path, p))) {
      hasReviewableChanges = true;
      break;
    }
  }

  if (!hasReviewableChanges) {
    sctx.log("no changes to review");
    const noChange = deserializeFindings({ risk_level: "low", risk_rationale: "no reviewable changes" });
    return { findings: serializeFindings(noChange), fixSummary };
  }

  sctx.log("reviewing changes...");
  const historySection =
    jobInstructionsPromptSection(sctx.jobReviewInstructions) +
    executionContextPromptSection() +
    roundHistoryPromptSection(sctx.rounds) +
    userIntentPromptSection(intentCtx) +
    intentConformanceReviewClause(intentCtx);
  const prompt = reviewMainPromptBody({ ...reviewBase, historySection });

  let result;
  try {
    result = await sctx.dispatcher.dispatch({
      role: "reviewer",
      prompt,
      cwd: sctx.worktree,
      jsonSchema: REVIEW_FINDINGS_SCHEMA,
      // Trusted per-repo agent selection + project-instruction boundary —
      // required on EVERY dispatch (see repoDispatchOptions). Omitting it
      // here made the review step spawn the conventional "default" agent,
      // which most deployments don't define ("Agent not found: default").
      ...repoDispatchOptions(sctx),
    });
  } catch (err) {
    throw new Error(`agent review: ${err instanceof Error ? err.message : String(err)}`);
  }

  let findings;
  if (result.output !== null) {
    findings = deserializeFindings(result.output);
  } else {
    sctx.log("could not parse structured output, using text response");
    findings = deserializeFindings({ summary: result.text });
  }

  return {
    needsApproval: hasBlockingFindings(findings.items),
    autoFixable: findings.items.length > 0,
    findings: serializeFindings(findings),
    fixSummary,
  };
}
