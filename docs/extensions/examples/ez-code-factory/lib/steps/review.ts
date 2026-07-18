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
  sanitizedPreviousFindingsForPrompt,
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

  let fixSummary = "";
  if (sctx.fixing) {
    const previousFindings = sanitizedPreviousFindingsForPrompt(sctx.previousFindings);
    const historySection =
      executionContextPromptSection() + roundHistoryPromptSection(sctx.rounds) + userIntentPromptSection(intentCtx);
    const fixPrompt = `Investigate previous review findings and address legitimate ones.

Examine the relevant code yourself and apply fixes directly.

Context:
- branch: ${branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}
- review scope: ${reviewScope}
- default branch: ${defaultBranch}
- ignore patterns: ${ignorePatterns}

Rules:
- Always start with double checking whether the findings are legitimate.
- Before changing code, identify whether each finding is a local defect or a symptom of a deeper design, abstraction, validation, ownership, or test-coverage flaw. Prefer the smallest correct root-cause fix within the changed area over patching only the reported line.
- If a narrow fix would leave the same class of bug likely elsewhere, fix the deepest practical cause instead.
- Avoid resolving a finding by removing or reverting the author's intentional code in their original 1st commit. If the original change introduced something on purpose, fix it forward (e.g. add validation, handle edge cases, tighten logic) rather than deleting it. Similarly, if the original change intentionally deleted or simplified code, do not restore or re-add the removed code unless the finding is a legitimate correctness, reliability, or security issue and the smallest reasonable fix happens to reintroduce a small amount of previously deleted logic. When in doubt about whether code is intentional, leave it and report the finding as unresolved.
- Do not add code comments explaining your fixes.
- Apply all the fixes you intend to make first; do not run any verification in between individual fixes.
- After all fixes are applied, run one focused verification limited to the changed area (the specific package, file, or test you touched) at the end of the fix round to confirm the fixes hold.
- Do NOT run the complete repository test suite or lint suite during this fix round. The pipeline has dedicated test and lint steps after review that are the authoritative test and lint gates; their coverage may itself be focused on the changed area when the repository has no configured test or lint commands.
- Return JSON with a single "summary" field when you are done.
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${historySection}

Previous review findings to address:
${previousFindings}`;
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
    executionContextPromptSection() +
    roundHistoryPromptSection(sctx.rounds) +
    userIntentPromptSection(intentCtx) +
    intentConformanceReviewClause(intentCtx);
  const prompt = `Review the code changes and return structured findings with a risk assessment.

Context:
- branch: ${branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}
- review scope: ${reviewScope}
- default branch: ${defaultBranch}
- ignore patterns: ${ignorePatterns}

Task:
- Read the relevant history and diff yourself.
- Focus findings on risks introduced by changed code, but inspect surrounding code, call sites, shared helpers, tests, and invariants when needed to understand root cause.
- Do NOT run tests during review. The pipeline has a dedicated test step after review.
- Analyze for bugs, risks, and code simplification opportunities.
- "Simplification" means reducing code complexity through non-functional refactoring (e.g. deduplication, clearer control flow). It does NOT mean removing features, changing product behavior, or stripping intentional user-facing output.
- Treat security issues, performance regressions, breaking changes, and insufficient error handling as risks.
- Do a full review pass before returning. Do not stop after the first valid finding. Continue inspecting the rest of the changed code until you have enumerated all material issues you can substantiate.

Rules:
- Anchor every finding to a specific file and one-indexed line number in the changed code when possible.
- Use severity "error" for problems that should absolutely not get merged, "warning" for things that are worth addressing but can be done in a follow up, and "info" for things that are nice to have.
- Be concise and actionable. No generic advice like "add more tests".
- Only comment on things that genuinely matter.
- Do NOT report styling, formatting, linting, compilation, or type-checking issues.
- If the change is clean, return an empty findings array.
- For each finding, set the action field to one of:
  - "ask-user": the finding is about functional requirements or product behavior, or otherwise challenges the author's deliberate intent. Even if it seems obviously wrong, we should ask the user for review. Examples: "this feature seems unnecessary", "this hardcoded value should be configurable", "this deletion looks wrong". When in doubt, default to "ask-user".
  - "auto-fix": the finding is a non-functional, non user-visible issue (correctness, error handling, security, performance, mechanical code quality) that can be safely fixed without any discussion about the author's intent.
  - "no-op": the finding is informational and does not require any action (e.g. noting a pattern, acknowledging a tradeoff).

Risk assessment (after listing all findings):
- Set risk_level to "low" if the change is well-bounded, mostly cosmetic, or straightforward with little ambiguity.
- Set risk_level to "medium" if the change has room to improve but is safe to merge first with concerns addressed as follow-ups.
- Set risk_level to "high" if the change should not be merged without explicit human approval - it is fundamental, risky, ambiguous, or has strong negative signals.
- Provide a one-sentence risk_rationale explaining why you chose that risk level.${historySection}`;

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
