// ── Document step — port of internal/pipeline/steps/document.go ─────
//
// Keeps documentation accurate for the change under the "one authoritative
// owner per fact" placement policy: the agent finds AND fixes doc gaps in the
// INITIAL pass and reports only what it could not resolve — ANY unresolved
// finding (even info severity) PARKS. The trusted `document.instructions` policy
// (default-branch only — a pushed branch cannot weaken the rules that gate its
// own review) augments the built-in defaults.
//
// When no deterministic `commands.lint` is configured the step ALSO performs
// the agent-driven lint duty in the SAME invocation (one cold agent pass for
// housekeeping instead of two), splits the findings by `category`, and stashes
// the lint half in RunShared for the lint step. Prompts are ported VERBATIM.

import { deserializeFindings, serializeFindings, type Finding, type Findings } from "../runs";
import {
  executionContextPromptSection,
  roundHistoryPromptSection,
  userIntentPromptSection,
  sanitizePromptMultilineText,
  sanitizedPreviousFindingsForPrompt,
  FINDINGS_SCHEMA,
  HOUSEKEEPING_FINDINGS_SCHEMA,
} from "../prompts";
import {
  commitAgentFixes,
  intentIsAuthoritative,
  repoDispatchOptions,
  resolveBranchBaseSHA,
  type Step,
  type StepContext,
  type StepOutcome,
} from "./common";
import { matchIgnorePattern } from "./review";

export const documentStep: Step = {
  name: "document",
  execute: executeDocument,
};

/** Fail-safe default documentation placement policy (verbatim documentPlacementPolicy). */
const DOCUMENT_PLACEMENT_POLICY = `Documentation placement policy (fail-safe defaults; repository-specific instructions may narrow or clarify them, never weaken them):
- Every fact or contract has exactly one authoritative owner document. Update the owner; never synchronize prose copies of the same fact.
- When this change leaves an existing duplicate stale, remove the duplicate or reduce it to a short pointer to the owner instead of updating another full copy.
- Do not create a new documentation surface merely to close a perceived gap.
- Do not add incident narratives or postmortems to AGENTS.md. For a durable incident lesson, preserve the operative invariant in its owner document and point to the regression test or authoritative implementation.
- AGENTS.md is only for high-value project-intrinsic knowledge useful to almost every future session.
- README.md owns the user-facing product introduction and common usage.
- CONTRIBUTING.md owns contribution mechanics, not product or architecture inventories.
- Code comments own non-obvious local intent, safety invariants, and external constraints - never prose that merely restates code.
- Deep reference docs own detailed conditional material; link to them instead of copying them into always-loaded guidance.
- Generated or schema-backed facts must be generated from their authoritative source and checked for drift, never hand-copied.`;

/** Scope discipline bounding the pass to what THIS change made stale (verbatim documentScopeDiscipline). */
const DOCUMENT_SCOPE_DISCIPLINE = `Scope discipline:
- Only touch documentation this change made stale, plus direct contradictions that analysis reveals.
- Do not opportunistically rewrite, expand, or restructure unrelated documentation, and do not perform a broad documentation architecture migration here.
- When a larger consolidation is warranted but out of scope, leave this change safe and report one finding proposing the follow-up instead of multiplying edits.
- Preserve load-bearing user guidance, security rationale, compatibility constraints, and onboarding material. A long document is not a defect by itself; duplication and wrong placement are.
- Prefer consolidation, deletion, and pointers to the owner over addition and synchronization.`;

/** The combined-lint duty appended in housekeeping mode (verbatim housekeepingLintSection). */
const HOUSEKEEPING_LINT_SECTION = `

Combined lint duty (same pass - no separate lint agent will run):
- Discover the configured linters and formatters for this repository.
- Run the relevant checks, preferring only the changed files when possible.
- Apply safe formatter, linter, and static-analysis fixes yourself, then re-run the relevant checks.
- Do not run tests or broader behavioral validation.
- Report only unresolved lint, format, or static-analysis issues as findings with "category" set to "lint". Do not report lint issues you already fixed.

Set "category" on every finding: "documentation" for documentation findings, "lint" for lint findings.`;

async function executeDocument(sctx: StepContext): Promise<StepOutcome> {
  const defaultBranch = sctx.repo.defaultBranch.trim() || "main";
  const baseSHA = await resolveBranchBaseSHA(sctx.hostGit, sctx.run.baseSha, defaultBranch);
  const ignorePatterns = effectiveIgnorePatterns(sctx);
  const ignoreLabel = ignorePatterns.length > 0 ? ignorePatterns.join(", ") : "none";

  // Absorb the lint duty when no deterministic lint command is configured; the
  // lint step then consumes the stash instead of paying its own cold pass.
  const combinedLint = sctx.repoConfig.commands.lint === "";
  if (combinedLint) sctx.shared.clearHousekeepingLint();

  // Nothing the agent would document changed → skip. No lint result is stashed,
  // so the lint step falls back to its own pass; neither duty is silently skipped.
  let changedFiles: string;
  try {
    changedFiles = await sctx.hostGit.run("diff", "--name-only", `${baseSHA}..${sctx.run.headSha}`);
  } catch (err) {
    throw new Error(`get changed files: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!hasNonIgnoredDocumentChanges(changedFiles, ignorePatterns)) {
    sctx.log("no changes to document");
    return {};
  }

  sctx.log(combinedLint ? "housekeeping: updating documentation and linting in one pass..." : "updating documentation...");

  const intentCtx = { intent: sctx.run.intent, authoritative: intentIsAuthoritative(sctx.run) };
  const prompt = buildDocumentPrompt(sctx, baseSHA, ignoreLabel, combinedLint, intentCtx);
  const schema = combinedLint ? HOUSEKEEPING_FINDINGS_SCHEMA : FINDINGS_SCHEMA;

  let result;
  try {
    result = await sctx.dispatcher.dispatch({
      role: "generic",
      prompt,
      cwd: sctx.worktree,
      jsonSchema: schema,
      ...repoDispatchOptions(sctx),
    });
  } catch (err) {
    throw new Error(`agent document: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Commit whatever the agent edited, regardless of how trustworthy its
  // structured output turns out to be.
  const commitSummary = extractDocumentSummary(result.output, "");
  const fallbackSummary = combinedLint ? "update documentation and fix lint" : "update documentation";
  await commitAgentFixes(sctx, "document", commitSummary, fallbackSummary);

  // Without trustworthy structured output we cannot confirm the agent resolved
  // every gap — surface it for human review. Nothing is stashed for lint, which
  // therefore re-assesses with its own pass.
  if (result.output === null) {
    sctx.log("missing structured output, requiring approval");
    return documentApprovalOutcome(fallbackDocumentSummary(result.text));
  }
  const validation = validateRequiredFindings(result.output);
  if (!validation.ok) {
    sctx.log("could not parse structured output, requiring approval");
    return documentApprovalOutcome(fallbackDocumentSummary(extractDocumentSummary(result.output, result.text)));
  }
  const findings = validation.findings;

  let docFindings = findings;
  if (combinedLint) {
    const [doc, lint] = splitHousekeepingFindings(findings);
    docFindings = doc;
    sctx.shared.setHousekeepingLint({ findingsJson: serializeFindings(lint), summary: findings.summary });
    sctx.log(`housekeeping lint result recorded for the lint step: ${lint.items.length} unresolved items`);
  }

  sctx.log(`document findings: ${docFindings.items.length} unresolved items`);
  return {
    needsApproval: docFindings.items.length > 0,
    autoFixable: false,
    findings: serializeFindings(docFindings),
    fixSummary: docFindings.summary,
  };
}

/** The ignore patterns document filtering honors: settings globs ∪ the pushed
 *  branch's non-executing `ignore_patterns` (deduped). Reading them from the
 *  pushed repo config is safe — ignore globs cannot run shell or select a
 *  process (spec §1: non-executing keys may come from the pushed branch). */
function effectiveIgnorePatterns(sctx: StepContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...sctx.config.ignorePatterns, ...sctx.repoConfig.ignorePatterns]) {
    if (p !== "" && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** Assemble the document (or combined document+lint) prompt (verbatim buildPrompt). */
function buildDocumentPrompt(
  sctx: StepContext,
  baseSHA: string,
  ignoreLabel: string,
  combinedLint: boolean,
  intentCtx: { intent: string | null; authoritative: boolean },
): string {
  const historySection =
    executionContextPromptSection() + roundHistoryPromptSection(sctx.rounds) + userIntentPromptSection(intentCtx);
  const intro = combinedLint
    ? "Perform the combined documentation and lint housekeeping pass for this change."
    : "Keep the project documentation accurate for this change.";
  const editRule = combinedLint
    ? "- Documentation edits must only touch documentation files or doc comments. Lint fixes must be safe, mechanical, and behavior-preserving. Never change functional behavior or tests."
    : "- Only edit documentation files or doc comments. Do not change executable behavior or tests.";

  let prompt = `${intro} Analyze what the change made stale, fix each stale fact in its one authoritative location, and report only what you could not resolve.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}
- default branch: ${sctx.repo.defaultBranch}
- ignore patterns: ${ignoreLabel}

${DOCUMENT_PLACEMENT_POLICY}

${DOCUMENT_SCOPE_DISCIPLINE}${trustedDocumentPolicySection(sctx)}

Task:

1. Understand the change
   - Read the diff and changed files to understand what was added, modified, or removed, and the intent of the change.

2. Find what this change made stale
   - For each fact or contract the change altered, locate its one authoritative owner document (README, docs/, doc comments, config examples, etc.).
   - Locate existing duplicates of those facts that are now stale.

3. Fix in the authoritative location
   - Update each altered fact in its owner document. Changed user-facing behavior must leave its authoritative user documentation accurate.
   - Remove stale duplicates or reduce them to a short pointer to the owner; do not synchronize full copies.
   - Re-read what you changed to verify it now reflects the code.

4. Report only what remains
   - Return a finding only for gaps you could not resolve, judgment calls (e.g. ambiguous intent or conflicting docs), or an out-of-scope consolidation worth a follow-up.
   - Do not report gaps you already fixed.
   - If nothing remains, return an empty findings array.${lintDutySection(combinedLint)}

Rules:
${editRule}
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${historySection}`;
  if (sctx.previousFindings !== "") {
    prompt += `

Previous findings to address:
${sanitizedPreviousFindingsForPrompt(sctx.previousFindings)}`;
  }
  return prompt;
}

/**
 * The trusted repository-specific documentation ownership policy. The value comes
 * from the trusted default-branch config (repoConfig.document.instructions), so a
 * contributor's pushed branch cannot weaken the rules that gate its own review.
 * Verbatim trustedDocumentPolicySection.
 */
function trustedDocumentPolicySection(sctx: StepContext): string {
  const instructions = sctx.repoConfig.document.instructions.trim();
  if (instructions === "") return "";
  return (
    "\n\nRepository documentation ownership policy (trusted, from the default branch; augments the defaults above and cannot weaken them):\n" +
    sanitizePromptMultilineText(instructions)
  );
}

function lintDutySection(combinedLint: boolean): string {
  return combinedLint ? HOUSEKEEPING_LINT_SECTION : "";
}

/**
 * Route combined-pass findings to their owning gates. An uncategorized finding
 * counts as documentation — the stricter gate (any documentation finding parks;
 * lint parks only on error/warning) — so miscategorization fails safe. Verbatim
 * splitHousekeepingFindings.
 */
export function splitHousekeepingFindings(findings: Findings): [Findings, Findings] {
  const docItems: Finding[] = [];
  const lintItems: Finding[] = [];
  for (const item of findings.items) {
    if (item.category === "lint") lintItems.push(item);
    else docItems.push(item);
  }
  const doc: Findings = { ...findings, items: docItems };
  const lint: Findings = { ...findings, items: lintItems };
  return [doc, lint];
}

/**
 * A single ask-user finding for cases where the agent's structured output is
 * missing or unparsable, so a human confirms the documentation state instead of
 * silently trusting an opaque response. Verbatim documentApprovalOutcome.
 */
export function documentApprovalOutcome(summary: string): StepOutcome {
  const findings = deserializeFindings({
    findings: [{ severity: "warning", description: summary, action: "ask-user" }],
    summary,
  });
  return {
    needsApproval: true,
    autoFixable: false,
    findings: serializeFindings(findings),
    fixSummary: summary,
  };
}

/** True when any non-ignored path changed. Verbatim hasNonIgnoredDocumentChanges. */
export function hasNonIgnoredDocumentChanges(changedFiles: string, ignorePatterns: string[]): boolean {
  for (const raw of changedFiles.split("\n")) {
    const path = raw.trim();
    if (path === "") continue;
    if (!ignorePatterns.some((p) => matchIgnorePattern(path, p))) return true;
  }
  return false;
}

/** The agent's text as a fallback summary, or a fixed note when blank. Verbatim fallbackDocumentSummary. */
export function fallbackDocumentSummary(text: string): string {
  const cleaned = text.trim();
  return cleaned === "" ? "agent returned no structured output" : cleaned;
}

/** Pull `{summary}` from the (already-parsed) agent output, else `fallback`. Verbatim extractDocumentSummary. */
export function extractDocumentSummary(output: unknown, fallback: string): string {
  if (output && typeof output === "object") {
    const s = (output as { summary?: unknown }).summary;
    if (typeof s === "string" && s.trim() !== "") return s;
  }
  return fallback;
}

/**
 * Validate the required structure of the document agent's output: a findings (or
 * items) array, a non-empty summary, and severity/description/action on every
 * finding. Returns the deserialized findings on success. Verbatim
 * unmarshalRequiredFindings (adapted to already-parsed output). A missing
 * required field means the agent's answer cannot be trusted → the caller parks.
 */
export function validateRequiredFindings(output: unknown): { ok: true; findings: Findings } | { ok: false } {
  if (!output || typeof output !== "object") return { ok: false };
  const o = output as Record<string, unknown>;
  const findingsArr = Array.isArray(o.findings) ? o.findings : null;
  const itemsArr = Array.isArray(o.items) ? o.items : null;
  if (findingsArr === null && itemsArr === null) return { ok: false };
  if (typeof o.summary !== "string" || o.summary.trim() === "") return { ok: false };
  const rawItems = (findingsArr && findingsArr.length > 0 ? findingsArr : itemsArr) ?? [];
  for (const raw of rawItems) {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (str(item.severity).trim() === "") return { ok: false };
    if (str(item.description).trim() === "") return { ok: false };
    if (str(item.action).trim() === "") return { ok: false };
  }
  return { ok: true, findings: deserializeFindings(output) };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
