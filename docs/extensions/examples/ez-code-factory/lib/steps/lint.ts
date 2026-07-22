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
  jobInstructionsPromptSection,
  lintColdPromptBody,
  lintFixPromptBody,
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
    const prompt = lintColdPromptBody({
      branch: sctx.run.branch,
      baseCommit: baseSHA,
      targetCommit: sctx.run.headSha,
      reassessHistory,
      previousFindings: sctx.previousFindings,
    });
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
    // Fix round only — the cold lint pass above deliberately gets no operator
    // section (fix instructions reach agents on FIX rounds only).
    const historySection =
      jobInstructionsPromptSection(sctx.jobFixInstructions) +
      executionContextPromptSection() + roundHistoryPromptSection(sctx.rounds) + userIntentPromptSection(intentCtx);
    const fixPrompt = lintFixPromptBody({
      branch: sctx.run.branch,
      baseCommit: baseSHA,
      targetCommit: sctx.run.headSha,
      historySection,
      previousFindings: sctx.previousFindings,
    });
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
  const { output, exitCode } = await runStepShellCommand(sctx, lintCmd);
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
