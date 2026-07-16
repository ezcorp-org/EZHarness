// ── Deterministic PR-body assembly + truncation ladder ──────────────
//
// Port of internal/pipeline/steps/prsummary.go + pr.go's body assembly, adapted
// to this extension's simpler Findings model (string[] tested/artifacts, string
// testingSummary/riskLevel — not upstream's rich TestArtifact objects). The LLM
// authors ONLY the "## What Changed" slice; every other section is computed
// DETERMINISTICALLY from the run's persisted step results + rounds:
//
//   ## Intent          verbatim sanitized run.intent (never LLM-paraphrased)
//   ## What Changed     the agent's body (passed in)
//   ## Risk Assessment  the review step's risk_level/rationale
//   ## Testing          the test step's testing_summary / tested / artifacts
//   ## Pipeline         a per-step status + issue→fix→outcome narrative
//
// Body-size budget: GitHub caps a PR description at 65,536 chars; upstream keeps
// a 2,048-char safety buffer, so the effective cap is 63,488 BYTES. When the
// full body overruns, the priority truncation ladder (spec §11) sheds content in
// this order — GitHub-only, so upstream's two paths (Azure assemblePRBody +
// GitHub appendGeneratedSectionsToCleanBody) are unified into one ladder:
//   1. drop the Testing section (the only unbounded one — it can embed logs),
//   2. drop the OLDEST pipeline rounds progressively (keep the latest state),
//   3. hard-truncate the whole body at a line boundary with a marker.
//
// Pure — no IO; every branch is exercised directly.

import type { PipelineStep } from "./config";
import {
  deserializeFindings,
  type FindingSeverity,
  type Findings,
  type StepResultRecord,
  type StepRoundRecord,
  type StepWithRounds,
} from "./runs";
import { sanitizePromptMultilineText, sanitizePromptText } from "./prompts";
import { tightenTitle } from "./conventional";

export type { StepWithRounds };

/** GitHub's hard PR-description limit. */
const GITHUB_PR_BODY_HARD_LIMIT = 65536;
/** Safety buffer for provider-side formatting drift. */
const PR_BODY_SAFETY_BUFFER = 2048;
/** Effective byte budget for the assembled body. Verbatim maxPullRequestBodyBytes. */
export const MAX_PR_BODY_BYTES = GITHUB_PR_BODY_HARD_LIMIT - PR_BODY_SAFETY_BUFFER;

const PR_SIGNATURE = "Updates from [git push gate](https://github.com/kunchenguid/no-mistakes)";

/** Byte length of a string (GitHub measures its cap in bytes). */
export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

// ── Display helpers ─────────────────────────────────────────────────

const STEP_DISPLAY: Record<PipelineStep, string> = {
  intent: "Intent",
  rebase: "Rebase",
  review: "Review",
  test: "Test",
  document: "Document",
  lint: "Lint",
  push: "Push",
  pr: "PR",
  ci: "CI",
};

function stepDisplayName(step: string): string {
  return STEP_DISPLAY[step as PipelineStep] ?? step;
}

/** Severity glyph for a findings bullet. Total over the severity union (our
 *  Findings always deserialize to a valid severity, so no default is needed).
 *  Verbatim severityEmoji glyphs. */
const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  error: "🚨",
  warning: "⚠️",
  info: "ℹ️",
};
function severityEmoji(severity: FindingSeverity): string {
  return SEVERITY_EMOJI[severity];
}

/** Risk glyph. Verbatim riskEmoji. */
function riskEmoji(level: string): string {
  switch (level) {
    case "low":
      return "✅";
    case "medium":
      return "⚠️";
    case "high":
      return "🚨";
    default:
      return "ℹ️";
  }
}

function capitalizeRisk(level: string): string {
  return level === "" ? level : level[0]!.toUpperCase() + level.slice(1);
}

/** A `N issue(s)` / `N error(s), M warning(s)` count phrase. Verbatim countFindingsBySeverity. */
export function countFindingsBySeverity(findings: Findings): string {
  const items = findings.items;
  if (items.length === 0) return "0 issues";
  const counts: Record<string, number> = {};
  for (const f of items) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const total = items.length;
  const noun = total === 1 ? "issue" : "issues";
  const distinct = Object.keys(counts);
  if (distinct.length === 1) {
    const sev = distinct[0]!;
    const n = counts[sev]!;
    return `${n} ${sev}${n === 1 ? "" : "s"}`;
  }
  const parts: string[] = [];
  for (const sev of ["error", "warning", "info"]) {
    const n = counts[sev];
    if (n !== undefined) parts.push(`${n} ${sev}${n === 1 ? "" : "s"}`);
  }
  return `${total} ${noun} (${parts.join(", ")})`;
}

// ── Round narrative (buildStepDetails, adapted) ─────────────────────

/** True when a round is a fix re-run (auto_fix trigger or a user selection). */
function isFixRound(r: StepRoundRecord): boolean {
  return r.trigger === "auto_fix" || r.selectionSource === "user";
}

/** Parse a round's canonical findings JSON (never throws — "" / null → empty). */
function roundFindings(r: StepRoundRecord): Findings | null {
  if (r.findingsJson === null || r.findingsJson.trim() === "") return null;
  try {
    return deserializeFindings(JSON.parse(r.findingsJson));
  } catch {
    return null;
  }
}

/** Render one round's findings as `file:line - description` bullets. */
function renderFindingItems(findings: Findings): string {
  const lines: string[] = [];
  for (const f of findings.items) {
    let loc = "";
    if (f.file !== "") {
      loc = `\`${f.file}`;
      if (f.line !== null && f.line > 0) loc += `:${f.line}`;
      loc += "\` - ";
    }
    lines.push(`- ${severityEmoji(f.severity)} ${loc}${f.description}`);
  }
  return lines.join("\n");
}

/**
 * Render a step's `<details>` narrative from the given rounds (oldest already
 * dropped by the caller). Each round shows its fix summary (when a fix round)
 * then its findings, or a "no issues" note. Adapted from buildStepDetails.
 */
function renderStepDetails(line: string, rounds: StepRoundRecord[]): string {
  const parts: string[] = [`<details>\n<summary>${line}</summary>\n`];
  for (const r of rounds) {
    const fix = isFixRound(r);
    if (fix) {
      const summary = (r.fixSummary ?? "").trim();
      parts.push(summary === "" ? "🔧 Fix applied." : `🔧 Fix: ${summary}`);
    }
    const findings = roundFindings(r);
    if (findings === null || findings.items.length === 0) {
      parts.push(fix ? "✅ Re-checked — no issues remain." : "✅ No issues found.");
      continue;
    }
    if (fix) parts.push(`${countFindingsBySeverity(findings)} still open:`);
    parts.push(renderFindingItems(findings));
  }
  parts.push("</details>");
  return parts.join("\n");
}

// ── Status line (buildStepEntry, adapted) ───────────────────────────

/** The final Findings on a step result (parsed from the persisted record). */
function finalFindings(sr: StepResultRecord): Findings {
  return sr.findings;
}

/** True when any round recorded at least one finding. */
function roundsHaveFindings(rounds: StepRoundRecord[]): boolean {
  return rounds.some((r) => {
    const f = roundFindings(r);
    return f !== null && f.items.length > 0;
  });
}

/**
 * The one-line pipeline status for a step (emoji + name + outcome). Adapted from
 * buildStepEntry: our Findings always parse (canonical or empty), so the
 * unreadable-findings / parse-failure branches upstream carries do not apply.
 */
export function buildStepLine(sw: StepWithRounds): string {
  const { result: sr, rounds } = sw;
  const name = stepDisplayName(sr.step);
  switch (sr.status) {
    case "pending":
      return `⏳ **${name}** - pending`;
    case "running":
      return `⏳ **${name}** - running`;
    case "awaiting_approval":
      return `⏸️ **${name}** - awaiting approval`;
    case "fixing":
      return `🔄 **${name}** - auto-fixing`;
    case "fix_review":
      return `⏸️ **${name}** - review fix`;
    case "failed":
      return `❌ **${name}** - failed`;
    case "skipped":
      return `⏭️ **${name}** - skipped`;
  }
  // completed:
  const final = finalFindings(sr);
  const initial = rounds.length > 0 ? roundFindings(rounds[0]!) : null;
  const hadInitial = initial !== null && initial.items.length > 0;
  const hasFinal = final.items.length > 0;
  const hadAny = hadInitial || hasFinal || roundsHaveFindings(rounds);
  const riskLevel = sr.step === "review" ? final.riskLevel : "";

  if (sr.step === "review" && (riskLevel === "medium" || riskLevel === "high") && !hadAny) {
    return `${riskEmoji(riskLevel)} **${name}** - ${riskLevel} risk`;
  }
  if (!hadAny) {
    if (rounds.length === 0) return `⚠️ **${name}** - findings unavailable`;
    return `✅ **${name}** - passed`;
  }
  // Had findings that were fixed away (initial had them, final is clear, >1 round).
  if (hadInitial && rounds.length > 1 && !hasFinal) {
    return `🔧 **${name}** - ${buildFixResultText(rounds)} ✅`;
  }
  const current = hasFinal ? final : (initial ?? final);
  return `⚠️ **${name}** - ${countFindingsBySeverity(current)}`;
}

/** `N issue(s) found → auto-fixed (K)` narrative. Verbatim buildFixResultText. */
function buildFixResultText(rounds: StepRoundRecord[]): string {
  const first = roundFindings(rounds[0]!);
  const initialCount = first ? first.items.length : 0;
  let autoFixRounds = 0;
  for (const r of rounds.slice(1)) if (isFixRound(r)) autoFixRounds++;
  const noun = initialCount === 1 ? "issue" : "issues";
  const parts = [`${initialCount} ${noun} found`];
  if (autoFixRounds > 1) parts.push(`auto-fixed (${autoFixRounds})`);
  else if (autoFixRounds === 1) parts.push("auto-fixed");
  return parts.join(" → ");
}

// ── Pipeline section (BuildPipelineSummary, adapted) ────────────────

/** Steps excluded from the Pipeline section (they narrate the pipeline itself). */
function omitFromPipeline(step: string): boolean {
  return step === "pr" || step === "ci";
}

/** The steps that contribute a Pipeline detail block, in order. */
function pipelineSteps(steps: StepWithRounds[]): StepWithRounds[] {
  return steps.filter((sw) => !omitFromPipeline(sw.result.step));
}

/** `_... (N earlier update(s) omitted ...)_` marker. Verbatim pipelineUpdatesOmissionMarker. */
function omissionMarker(omitted: number): string {
  const rounds = omitted === 1 ? "round" : "rounds";
  return `_... (${omitted} earlier update ${rounds} omitted to keep the PR body within GitHub's ${GITHUB_PR_BODY_HARD_LIMIT}-char limit; full history is in the run log.)_`;
}

/**
 * Build the `## Pipeline` section, optionally omitting the `omitOldest` oldest
 * round narratives (distributed oldest-first across steps). Returns "" when no
 * step contributes. Adapted from BuildPipelineSummary + renderPipelineWithOmittedUpdates
 * (data-level omission rather than re-parsing rendered markdown).
 */
export function buildPipelineSection(steps: StepWithRounds[], omitOldest = 0): string {
  const contributing = pipelineSteps(steps);
  if (contributing.length === 0) return "";
  let toOmit = Math.max(0, omitOldest);
  const blocks: string[] = [];
  for (const sw of contributing) {
    const line = buildStepLine(sw);
    const omitHere = Math.min(toOmit, sw.rounds.length);
    toOmit -= omitHere;
    const keptRounds = sw.rounds.slice(omitHere);
    blocks.push(renderStepDetails(line, keptRounds));
  }
  const header = `## Pipeline\n\n${PR_SIGNATURE}\n\n`;
  const omissionLine = omitOldest > 0 ? `${omissionMarker(omitOldest)}\n\n` : "";
  return header + omissionLine + blocks.join("\n");
}

/** Total number of round narratives across the pipeline steps (the ladder's
 *  drop budget). */
export function totalPipelineRounds(steps: StepWithRounds[]): number {
  return pipelineSteps(steps).reduce((n, sw) => n + sw.rounds.length, 0);
}

// ── Risk line (extractRiskLine, adapted) ────────────────────────────

/** The review step's `emoji Risk: rationale` line, or "" when no review risk. */
export function buildRiskLine(steps: StepWithRounds[]): string {
  const review = steps.find((sw) => sw.result.step === "review");
  if (!review) return "";
  let src: Findings | null = review.result.findings.items.length > 0 || review.result.findings.riskLevel !== ""
    ? review.result.findings
    : null;
  if (src === null && review.rounds.length > 0) {
    src = roundFindings(review.rounds[review.rounds.length - 1]!);
  }
  if (src === null || src.riskLevel === "") return "";
  const emoji = riskEmoji(src.riskLevel);
  const label = capitalizeRisk(src.riskLevel);
  return src.riskRationale !== "" ? `${emoji} ${label}: ${src.riskRationale}` : `${emoji} ${label}`;
}

// ── Testing section (BuildTestingSummary, adapted to string artifacts) ──

/** The most recent non-empty testing summary from the test step (result then
 *  latest round). */
function collectTestingSummary(sw: StepWithRounds): string {
  const fromFinal = sanitizePromptMultilineText(sw.result.findings.testingSummary);
  if (fromFinal !== "") return fromFinal;
  for (let i = sw.rounds.length - 1; i >= 0; i--) {
    const f = roundFindings(sw.rounds[i]!);
    if (f) {
      const s = sanitizePromptMultilineText(f.testingSummary);
      if (s !== "") return s;
    }
  }
  return "";
}

/** The evidence Findings for the test step — its result if it carries evidence,
 *  else the latest round that does. */
function testingEvidence(sw: StepWithRounds): Findings | null {
  const hasEvidence = (f: Findings): boolean =>
    f.testingSummary.trim() !== "" || f.tested.length > 0 || f.artifacts.length > 0;
  if (hasEvidence(sw.result.findings)) return sw.result.findings;
  for (let i = sw.rounds.length - 1; i >= 0; i--) {
    const f = roundFindings(sw.rounds[i]!);
    if (f && hasEvidence(f)) return f;
  }
  return null;
}

/** Render a `tested` entry as an inline code span. */
function renderTested(detail: string): string {
  const clean = sanitizePromptText(detail);
  if (clean === "") return "";
  if (clean.startsWith("`") && clean.endsWith("`") && clean.length > 1) return clean;
  return `\`${clean}\``;
}

/**
 * Build the `## Testing` section from the test step's evidence, or "" when there
 * is no test step or no evidence. Adapted to our string tested/artifacts model:
 * a summary paragraph, backtick-wrapped tested commands, and artifact lines
 * (URL → link, else inline).
 */
export function buildTestingSection(steps: StepWithRounds[]): string {
  const test = steps.find((sw) => sw.result.step === "test");
  if (!test) return "";
  const summary = collectTestingSummary(test);
  const evidence = testingEvidence(test);
  const tested = evidence ? evidence.tested : [];
  const artifacts = evidence ? evidence.artifacts : [];
  if (summary === "" && tested.length === 0 && artifacts.length === 0) return "";

  const parts: string[] = ["## Testing", ""];
  if (summary !== "") parts.push(summary, "");
  const seen = new Set<string>();
  for (const t of tested) {
    const rendered = renderTested(t);
    if (rendered === "" || seen.has(rendered)) continue;
    seen.add(rendered);
    parts.push(`- ${rendered}`);
  }
  for (const a of artifacts) {
    const clean = sanitizePromptText(a);
    if (clean === "") continue;
    if (/^https?:\/\/\S+$/i.test(clean)) parts.push(`- Evidence: ${clean}`);
    else parts.push(`- Evidence: \`${clean}\``);
  }
  return parts.join("\n").replace(/\n+$/, "");
}

// ── Agent-body cleaning (pr.go stripGeneratedSections / unwrapNestedPRBody) ──

/** The deterministic section headings the agent must NOT author (we prepend/
 *  append them from DB). Verbatim isGeneratedSectionHeading set. */
const GENERATED_HEADINGS: ReadonlySet<string> = new Set(["intent", "risk assessment", "testing", "tests", "pipeline"]);

/** True when a line is a `## <generated heading>` (case/punctuation-insensitive). */
function isGeneratedSectionHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("##")) return false;
  const heading = trimmed.replace(/^#+/, "").trim().replace(/[:.!?\s]+$/, "").toLowerCase();
  return GENERATED_HEADINGS.has(heading);
}

/**
 * Strip any Intent / Risk Assessment / Testing / Pipeline sections the agent
 * authored, so the deterministic sections are the single source. Verbatim
 * stripGeneratedSections.
 */
export function stripGeneratedSections(body: string): string {
  if (body === "") return "";
  const out: string[] = [];
  let skipping = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (skipping) {
      if (line.startsWith("## ")) {
        if (isGeneratedSectionHeading(line)) continue;
        skipping = false;
      } else {
        continue;
      }
    }
    if (isGeneratedSectionHeading(line)) {
      skipping = true;
      continue;
    }
    out.push(raw);
  }
  return out.join("\n").trim();
}

/** When the agent returned its body as a serialized `{title, body}` JSON string,
 *  extract the real markdown body. Verbatim unwrapNestedPRBody. */
export function unwrapNestedPRBody(body: string): string {
  if (body === "" || body[0] !== "{") return body;
  try {
    const nested = JSON.parse(body) as { body?: unknown };
    if (typeof nested.body === "string" && nested.body.trim() !== "") return nested.body.trim();
  } catch {
    return body;
  }
  return body;
}

/** Derive a fallback PR title from the commit log's first subject, else the
 *  branch, else a chore default — tightened to conventional form. Verbatim
 *  fallbackPRContent title logic. */
export function fallbackTitle(commitLog: string, branch: string): string {
  let title = "";
  for (const raw of commitLog.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const idx = line.indexOf(" ");
    if (idx >= 0 && idx + 1 < line.length) title = line.slice(idx + 1).trim();
    break;
  }
  if (title === "") title = branch.trim();
  if (title === "") return "chore: update pull request";
  return tightenTitle(title);
}

// ── Intent + assembly ───────────────────────────────────────────────

/** Prepend `## Intent` (verbatim cleaned intent) to `body`. Verbatim prependIntentSection. */
export function prependIntent(body: string, cleanedIntent: string): string {
  if (cleanedIntent === "") return body;
  const section = `## Intent\n\n${cleanedIntent}`;
  return body.trim() === "" ? section : `${section}\n\n${body}`;
}

/** Join non-empty sections with a blank line between them. */
function joinSections(sections: string[]): string {
  return sections.filter((s) => s.trim() !== "").join("\n\n");
}

/** Hard-truncate at a line boundary, appending a marker kept inside the budget.
 *  Verbatim truncateTextAtLineBoundary (byte-based). */
export function truncateAtLineBoundary(text: string, maxBytes: number, marker: string): string {
  if (maxBytes <= 0) return "";
  if (byteLen(text) <= maxBytes) return text;
  const fullMarker = marker === "" ? "" : `\n\n${marker}`;
  const available = maxBytes - byteLen(fullMarker);
  if (available <= 0) return byteLen(fullMarker) <= maxBytes ? fullMarker.replace(/^\n+/, "") : "";
  // Cut on a UTF-8 rune boundary at or before `available` bytes.
  let cut = available;
  const bytes = Buffer.from(text, "utf-8");
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  let sliced = bytes.subarray(0, cut).toString("utf-8");
  const nl = sliced.lastIndexOf("\n");
  if (nl > 0) sliced = sliced.slice(0, nl);
  return sliced.replace(/\n+$/, "") + fullMarker;
}

const BODY_TRUNCATION_MARKER = `_... (body truncated to keep the PR body within GitHub's ${GITHUB_PR_BODY_HARD_LIMIT}-char limit.)_`;

/** The essential (non-Testing, non-Pipeline) prefix sections. */
function essentialSections(whatChanged: string, riskLine: string): string[] {
  const sections = [whatChanged];
  if (riskLine !== "") sections.push(`## Risk Assessment\n\n${riskLine}`);
  return sections;
}

export interface AssembleInput {
  /** Cleaned, sanitized intent (verbatim run.intent) — the `## Intent` section. */
  cleanedIntent: string;
  /** The agent-authored `## What Changed` body. */
  whatChanged: string;
  /** Ordered step results + rounds driving Risk/Testing/Pipeline. */
  steps: StepWithRounds[];
}

/**
 * Assemble the final PR body from its deterministic sections and enforce the
 * GitHub byte budget with the priority truncation ladder (drop Testing → drop
 * oldest Pipeline rounds → hard-truncate). Spec §11.
 */
export function assemblePRBody(input: AssembleInput): string {
  const { cleanedIntent, whatChanged, steps } = input;
  const riskLine = buildRiskLine(steps);
  const testingMD = buildTestingSection(steps);
  const essential = essentialSections(whatChanged, riskLine);

  const build = (withTesting: boolean, omitOldest: number): string => {
    const sections = [...essential];
    if (withTesting && testingMD !== "") sections.push(testingMD);
    const pipeline = buildPipelineSection(steps, omitOldest);
    if (pipeline !== "") sections.push(pipeline);
    return prependIntent(joinSections(sections), cleanedIntent);
  };

  // 1. Full body (with Testing, all rounds).
  const full = build(true, 0);
  if (byteLen(full) <= MAX_PR_BODY_BYTES) return full;

  // 2. Drop the Testing section.
  const core = build(false, 0);
  if (byteLen(core) <= MAX_PR_BODY_BYTES) return core;

  // 3. Drop the oldest pipeline rounds progressively.
  const total = totalPipelineRounds(steps);
  for (let dropped = 1; dropped < total; dropped++) {
    const candidate = build(false, dropped);
    if (byteLen(candidate) <= MAX_PR_BODY_BYTES) return candidate;
  }

  // 4. Hard-truncate the minimal body at a line boundary with a marker.
  const minimal = build(false, total);
  return truncateAtLineBoundary(minimal, MAX_PR_BODY_BYTES, BODY_TRUNCATION_MARKER);
}
