// ── Test step — port of internal/pipeline/steps/test.go ─────────────
//
// Runs the TRUSTED `commands.test` (a nonzero exit → a blocking finding), then
// (when there is no test command OR the run carries a user intent) an agent
// "evidence" pass that demonstrates the intent works end-to-end and records
// reviewer-visible artifacts. New test files the agent wrote ALWAYS require
// human approval, even on an otherwise-clean pass. The command is read from the
// trusted default branch only (repo-config.ts) — a pushed branch can never
// inject a test command.
//
// Prompts are ported VERBATIM from test.go. The one documented adaptation:
// evidence `artifacts` are recorded as STRINGS (our Findings.artifacts is
// `string[]` — prompts.ts TEST_FINDINGS_SCHEMA), not upstream's rich objects.

import { deserializeFinding, deserializeFindings, serializeFindings, type Findings } from "../runs";
import { hasBlockingFindings } from "../findings";
import {
  cleanedUserIntent,
  executionContextPromptSection,
  roundHistoryPromptSection,
  userIntentPromptSection,
  testEvidencePromptBody,
  testFixPromptBody,
  COMMIT_SUMMARY_SCHEMA,
  TEST_FINDINGS_SCHEMA,
} from "../prompts";
import {
  detectNewTestFiles,
  executeFixMode,
  intentIsAuthoritative,
  repoDispatchOptions,
  resolveBranchBaseSHA,
  runStepShellCommand,
  type Step,
  type StepContext,
  type StepOutcome,
} from "./common";
import {
  resolveTestEvidenceLocation,
  testEvidenceDir,
  type EvidenceLocation,
} from "./evidence";

export const testStep: Step = {
  name: "test",
  execute: executeTest,
};

/** Build a finding item wire object → deserialize (fail-closed action). */
function findingsFrom(items: Record<string, unknown>[], extra: Record<string, unknown>): Findings {
  return deserializeFindings({ findings: items, ...extra });
}

async function executeTest(sctx: StepContext): Promise<StepOutcome> {
  const defaultBranch = sctx.repo.defaultBranch.trim() || "main";
  const baseSHA = await resolveBranchBaseSHA(sctx.hostGit, sctx.run.baseSha, defaultBranch);
  const intentCtx = { intent: sctx.run.intent, authoritative: intentIsAuthoritative(sctx.run) };

  // Fix mode: ask the agent to fix failing tests first, snapshotting any new
  // test files it wrote BEFORE the commit sweeps them out of `git status`.
  let newTestsFromFix: string[] = [];
  let fixSummary = "";
  if (sctx.fixing) {
    const historySection =
      executionContextPromptSection() + roundHistoryPromptSection(sctx.rounds) + userIntentPromptSection(intentCtx);
    const fixPrompt = testFixPromptBody({
      branch: sctx.run.branch,
      baseCommit: baseSHA,
      targetCommit: sctx.run.headSha,
      historySection,
      previousFindings: sctx.previousFindings,
    });
    fixSummary = await executeFixMode(sctx, "test", {
      logMessage: "asking agent to fix test failures...",
      prompt: fixPrompt,
      errorPrefix: "agent fix tests",
      fallbackSummary: "fix test failures",
      role: "fixer",
      jsonSchema: COMMIT_SUMMARY_SCHEMA,
      afterAgentRun: async () => {
        newTestsFromFix = await detectNewTestFiles(sctx.hostGit);
      },
    });
  }

  const testCmd = sctx.repoConfig.commands.test;
  const tested: string[] = [];
  if (testCmd !== "") {
    sctx.log(`running tests: ${testCmd}`);
    const { output, exitCode } = await runStepShellCommand(sctx, testCmd);
    tested.push(testCmd);
    sctx.log(output);
    if (exitCode !== 0) {
      const findings = findingsFrom(
        [{ severity: "error", description: `tests failed with exit code ${exitCode}` }],
        { summary: output, tested },
      );
      return {
        needsApproval: true,
        autoFixable: true,
        findings: serializeFindings(findings),
        fixSummary,
      };
    }
  }

  const useEvidenceAgent = testCmd === "" || cleanedUserIntent(sctx.run.intent) !== "";
  if (useEvidenceAgent) {
    let location = await resolveTestEvidenceLocation({
      runner: sctx.hostRunner,
      worktree: sctx.worktree,
      branch: sctx.run.branch,
      runId: sctx.run.id,
      tmpBase: sctx.tmpBase,
      evidence: sctx.repoConfig.evidence,
    });
    // An in-repo evidence dir git ignores would never render on the PR; fall
    // back to the temp location so the artifacts are still captured.
    if (location.storeInRepo && (await sctx.hostGit.ok("check-ignore", "--quiet", "--", location.rel))) {
      location = { dir: testEvidenceDir(sctx.tmpBase, sctx.run.id), storeInRepo: false, rel: "" };
    }
    await sctx.hostRunner(["mkdir", "-p", location.dir], sctx.worktree);

    sctx.log(
      testCmd === ""
        ? "no test command configured, asking agent to run tests..."
        : "user intent available, asking agent to gather test evidence...",
    );
    const prompt = buildEvidencePrompt(sctx, baseSHA, testCmd, location, intentCtx);
    let result;
    try {
      result = await sctx.dispatcher.dispatch({
        role: "generic",
        prompt,
        cwd: sctx.worktree,
        jsonSchema: TEST_FINDINGS_SCHEMA,
        ...repoDispatchOptions(sctx),
      });
    } catch (err) {
      throw new Error(`agent run tests: ${err instanceof Error ? err.message : String(err)}`);
    }

    let findings = result.output !== null ? deserializeFindings(result.output) : deserializeFindings({ summary: result.text });
    if (tested.length > 0) findings = { ...findings, tested: [...tested, ...findings.tested] };

    let needsApproval = hasBlockingFindings(findings.items);
    let autoFixable = needsApproval;

    // A new test file the agent wrote ALWAYS requires human approval, even when
    // every test passed — the human decides whether the new test is desired.
    const newTests = await detectNewTestFiles(sctx.hostGit);
    if (newTests.length > 0) {
      needsApproval = true;
      autoFixable = false;
      findings = {
        ...findings,
        items: [
          ...findings.items,
          ...newTests.map((f) =>
            deserializeFinding({ severity: "info", file: f, description: `new test file written by agent: ${f}` }),
          ),
        ],
      };
    }

    return { needsApproval, autoFixable, findings: serializeFindings(findings), fixSummary };
  }

  // A test command passed and no evidence pass ran. In fix mode the agent may
  // still have written new test files — surface them for approval.
  if (sctx.fixing && newTestsFromFix.length > 0) {
    const findings = findingsFrom(
      newTestsFromFix.map((f) => ({
        severity: "info",
        file: f,
        description: `new test file written by agent: ${f}`,
      })),
      { summary: "tests passed, but agent wrote new test files", tested },
    );
    return { needsApproval: true, findings: serializeFindings(findings), fixSummary };
  }

  sctx.log("all tests passed");
  return { findings: serializeFindings(findingsFrom([], { tested })), fixSummary };
}

/** Build the evidence-pass prompt (verbatim test.go, artifacts-as-strings). */
function buildEvidencePrompt(
  sctx: StepContext,
  baseSHA: string,
  testCmd: string,
  location: EvidenceLocation,
  intentCtx: { intent: string | null; authoritative: boolean },
): string {
  const reassessHistory =
    executionContextPromptSection() + roundHistoryPromptSection(sctx.rounds) + userIntentPromptSection(intentCtx);
  const evidenceGuidance = location.storeInRepo
    ? `- Write new evidence files into this in-repo evidence directory; it is committed and pushed automatically, so artifacts render directly on the PR: ${location.dir}`
    : `- Write new evidence files into this temporary evidence directory: ${location.dir}`;
  const configuredTestCommand =
    testCmd !== ""
      ? `\nConfigured test command already ran successfully as baseline: \`${testCmd}\`\n`
      : "";
  return testEvidencePromptBody({
    branch: sctx.run.branch,
    baseCommit: baseSHA,
    targetCommit: sctx.run.headSha,
    configuredTestCommand,
    evidenceGuidance,
    reassessHistory,
  });
}
