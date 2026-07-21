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
  sanitizedPreviousFindingsForPrompt,
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
    const previousSection =
      sctx.previousFindings !== ""
        ? `\n\nPrevious test findings to address:\n${sanitizedPreviousFindingsForPrompt(sctx.previousFindings)}`
        : "";
    const fixPrompt = `Fix the failing tests in this repository. Run the tests, identify failures, and fix either the tests or the code to make them pass.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}

Rules:
- Make the smallest correct root-cause fix.
- Do not refactor beyond what is needed for that root-cause fix.
- If tests fail, determine whether the problem is a real product/code failure, a setup/environment problem you can fix, or a flaky/infrastructure issue.
- Do NOT run linters, formatters, or static analysis tools.
- Re-run the relevant tests before finishing.
- Before finishing, remove any transient artifacts your testing created in the working tree (downloaded models, caches, build outputs, large binaries, or generated data directories) so they are not committed and pushed. Do not remove intentional source or test-file changes.
- Return JSON with a single "summary" field when you are done.
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${historySection}${previousSection}`;
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
  return `You are validating a code change by testing it. Examine the repository and run the appropriate tests yourself.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}
${configuredTestCommand}

Task:
- Understand the user intent before testing it. If extracted user intent is present, use it as the primary hint for what success means.
- Decide what evidence or artifacts would clearly demonstrate the user intent is satisfied. Unit tests passing is not sufficient evidence by itself.
- Demonstrate the user intent working end-to-end in a way consistent with how an end user would actually experience it.
- Prefer product-level artifacts: screenshots, GIFs, videos, rendered UI, CLI transcripts, API responses, persisted database state, generated PR markdown, logs, or other outputs that directly show the intended behavior working.
- For UI, HTML, CSS, Electron renderer, browser, visual layout, or copy-placement changes, attempt to capture reviewer-visible visual evidence.
- Prefer screenshots, images, videos, GIFs, or rendered HTML artifacts that show the actual end-user surface.
- DOM snapshots, selector assertions, and text-only render summaries are not substitutes for visual evidence when a rendered surface is available.
- If a UI-facing change has no screenshot, image, video, GIF, or rendered HTML artifact, state why in testing_summary.
${evidenceGuidance}
- Do not move, commit, or modify source files only to make evidence linkable. Record local evidence file paths exactly where you created them.
- Only use command output as an artifact when that output directly demonstrates the end-user experience or requested behavior. Generic pass/fail, coverage, or clean-worktree output is not sufficient evidence.
- Look for existing tests that would generate sufficient evidence. If they exist, run the smallest relevant set.
- If no existing test produces sufficient evidence, write or improve a test so that it does.
- If automated testing cannot produce the needed evidence, execute manual verification steps and record the evidence-producing steps you performed.
- If sufficient evidence is not possible, report a warning finding explaining what evidence is missing and why the user needs to decide what to do.
- Include a concise "testing_summary" sentence describing what you exercised and the overall result.
- The "testing_summary" must account for the complete test step: baseline commands that already ran, automated tests, manual or evidence-producing checks, artifacts gathered, and the overall result.
- Record the exact tests, manual checks, and evidence-producing steps you ran in a "tested" array. Prefer concrete commands or test selectors wrapped in backticks.
- Always include an "artifacts" array of strings. Leave it empty when you produced no reviewer-visible evidence artifacts. Record each artifact as a string: a file path for file artifacts (including absolute paths for temporary local evidence files when available), a URL for externally visible artifacts, or short inline log/command-output content to show directly in the PR.
- If tests fail, determine whether the problem is a real product/code failure, a setup/environment problem you can fix, or a flaky/infrastructure issue.
- If the issue is setup-related and fixable, fix it and retry the tests.

Rules:
- Do NOT run linters, formatters, or static analysis tools.
- Focus on testing and test-related fixes only.
- Before finishing, remove any transient artifacts your testing created in the working tree (downloaded models, caches, build outputs, large binaries, or generated data directories) so they are not committed and pushed. Do not remove intentional source or test-file changes, and leave evidence files in the dedicated evidence directory untouched.
- Keep "testing_summary" high-signal and natural language. Avoid raw logs and noisy counts.
- Always return a non-empty "tested" array describing what you exercised, even when all tests pass.
- Only report actionable findings: test failures, unfixable setup issues, flaky tests you identified, or missing evidence that prevents you from demonstrating the user intent.
- Do NOT report passing tests (whether existing or new), test counts, coverage summaries, or other non-actionable information.
- If all tests pass and there are no issues, return an empty findings array.
- Set action to "ask-user" for missing-evidence warning findings and only otherwise when a test failure seems desired and you question the author's intent of having the test in the first place. Set action to "auto-fix" for objective test failures that can be safely fixed. Set action to "no-op" for informational notes.${reassessHistory}`;
}
