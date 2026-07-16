// ── Lint step — port of internal/pipeline/steps/lint.go ─────────────
//
// Runs the TRUSTED `commands.lint` (a nonzero exit → a blocking finding); when
// none is configured it CONSUMES the document step's stashed combined-pass lint
// result (so housekeeping paid one cold agent pass, not two); and when there is
// neither a command nor a stash (a fix round, or a process boundary invalidated
// the stash) it runs its own cold agent lint pass. The command is trusted-only
// (repo-config.ts) — a pushed branch can never inject a lint command. Prompts
// are ported VERBATIM.

import { deserializeFindings, serializeFindings } from "../runs";
import { hasBlockingFindings } from "../findings";
import {
  executionContextPromptSection,
  roundHistoryPromptSection,
  userIntentPromptSection,
  sanitizedPreviousFindingsForPrompt,
  COMMIT_SUMMARY_SCHEMA,
  FINDINGS_SCHEMA,
} from "../prompts";
import {
  commitAgentFixes,
  executeFixMode,
  extractCommitSummary,
  intentIsAuthoritative,
  repoDispatchOptions,
  resolveBranchBaseSHA,
  runStepShellCommand,
  type HousekeepingLintResult,
  type Step,
  type StepContext,
  type StepOutcome,
} from "./common";
import { documentApprovalOutcome } from "./document";

export const lintStep: Step = {
  name: "lint",
  execute: executeLint,
};

async function executeLint(sctx: StepContext): Promise<StepOutcome> {
  const defaultBranch = sctx.repo.defaultBranch.trim() || "main";
  const baseSHA = await resolveBranchBaseSHA(sctx.hostGit, sctx.run.baseSha, defaultBranch);
  const lintCmd = sctx.repoConfig.commands.lint;
  const intentCtx = { intent: sctx.run.intent, authoritative: intentIsAuthoritative(sctx.run) };

  if (lintCmd === "") {
    // The combined document+lint housekeeping pass already did the agent-driven
    // lint duty for this round — consume its stash instead of a second cold
    // agent invocation. A fix round (or a process boundary that dropped the
    // stash) falls through to a full agent pass, so lint is never silently
    // skipped.
    if (!sctx.fixing) {
      const stash = sctx.shared.takeHousekeepingLint();
      if (stash) return lintOutcomeFromHousekeeping(sctx, stash);
    }
    sctx.log("no lint command configured, asking agent to lint and fix...");
    const reassessHistory =
      executionContextPromptSection() + roundHistoryPromptSection(sctx.rounds) + userIntentPromptSection(intentCtx);
    let prompt = `Detect the linting and formatting tools for this project, run the relevant checks yourself, apply safe fixes, and verify the result.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}

Task:
- Discover the configured linters and formatters for this repository.
- Only lint or format the relevant changed files when possible.
- Apply safe formatter, linter, and static-analysis fixes yourself.
- Re-run the relevant checks after fixing.
- Report only unresolved lint, format, or static-analysis issues as structured findings.
- If everything is clean or fixed, return an empty findings array.

Rules:
- Do not run tests or broader behavioral validation.
- Focus on lint, format, and static-analysis issues only.
- Do not report issues you already fixed.
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${reassessHistory}`;
    if (sctx.previousFindings !== "") {
      prompt += `

Previous lint findings to address:
${sanitizedPreviousFindingsForPrompt(sctx.previousFindings)}`;
    }
    let result;
    try {
      result = await sctx.dispatcher.dispatch({
        role: "generic",
        prompt,
        cwd: sctx.worktree,
        jsonSchema: FINDINGS_SCHEMA,
        ...repoDispatchOptions(sctx),
      });
    } catch (err) {
      throw new Error(`agent lint: ${err instanceof Error ? err.message : String(err)}`);
    }
    const findings = result.output !== null ? deserializeFindings(result.output) : deserializeFindings({ summary: result.text });
    const summary = extractCommitSummary(result);
    await commitAgentFixes(sctx, "lint", summary, "fix lint issues");
    return {
      needsApproval: hasBlockingFindings(findings.items),
      autoFixable: false,
      findings: serializeFindings(findings),
      fixSummary: summary,
    };
  }

  // Fix mode: ask the agent to fix lint issues before re-running the command.
  let fixSummary = "";
  if (sctx.fixing) {
    const historySection =
      executionContextPromptSection() + roundHistoryPromptSection(sctx.rounds) + userIntentPromptSection(intentCtx);
    let fixPrompt = `Fix the lint issues in this repository. Run the linter, identify all issues, and fix them.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}

Rules:
- Make the smallest correct root-cause fix.
- Do not refactor beyond what is needed for that root-cause fix.
- Do not run tests or broader behavioral validation.
- Re-run the relevant lint or format commands before finishing.
- Return JSON with a single "summary" field when you are done.
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${historySection}`;
    if (sctx.previousFindings !== "") {
      fixPrompt += `

Previous lint findings to address:
${sanitizedPreviousFindingsForPrompt(sctx.previousFindings)}`;
    }
    fixSummary = await executeFixMode(sctx, "lint", {
      logMessage: "asking agent to fix lint issues...",
      prompt: fixPrompt,
      errorPrefix: "agent fix lint",
      fallbackSummary: "fix lint issues",
      role: "fixer",
      jsonSchema: COMMIT_SUMMARY_SCHEMA,
    });
  }

  sctx.log(`running linter: ${lintCmd}`);
  const { output, exitCode } = await runStepShellCommand(sctx.hostRunner, sctx.worktree, lintCmd);
  sctx.log(output);
  if (exitCode !== 0) {
    const findings = deserializeFindings({
      findings: [{ severity: "warning", description: `linter found issues (exit code ${exitCode})` }],
      summary: output,
    });
    return {
      needsApproval: true,
      autoFixable: true,
      findings: serializeFindings(findings),
      fixSummary,
    };
  }

  sctx.log("lint passed");
  return { fixSummary };
}

/**
 * Report the lint findings the combined document+lint pass produced, with the
 * same gate semantics as the lint step's own agent path: blocking (error/
 * warning) findings park, info findings pass. A malformed stash (should be
 * unreachable — the document step marshalled it) fails safe by parking for a
 * human. Verbatim lintOutcomeFromHousekeeping.
 */
export function lintOutcomeFromHousekeeping(sctx: StepContext, stash: HousekeepingLintResult): StepOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stash.findingsJson);
  } catch {
    sctx.log("could not parse combined housekeeping lint result, requiring approval");
    return documentApprovalOutcome("combined housekeeping lint result unreadable");
  }
  const findings = deserializeFindings(parsed);
  sctx.log(`lint assessed in the combined document+lint housekeeping pass: ${findings.items.length} unresolved items`);
  return {
    needsApproval: hasBlockingFindings(findings.items),
    autoFixable: false,
    findings: stash.findingsJson,
    fixSummary: stash.summary,
  };
}
