// ── Dashboard + run-detail trees — pure builders ─────────────────────
//
// The Hub page renders one row per gate run (id, branch, head SHA, status)
// and, for any run PARKED at a gate, an inline run-detail section: the
// pipeline step list, the parked step's findings table, its risk line, a
// log/summary panel, and the approve / fix / skip / abort + yolo controls.
//
// This module is pure: it maps run + step records to a declarative page tree
// the host renders as native Svelte. Every user/agent-derived string (branch,
// file, description, risk rationale, summaries) is emitted ONLY into
// text-interpolated node types (headings, stats, table cells, empty-state,
// section titles) — never the `markdown` node (the Hub's sole `{@html}`) — so
// the render is XSS-safe by construction (page-schema.ts truncates; the client
// escapes). No user-specific data is emitted — the tree is the SHARED
// (cross-user cached) Hub page, and gate runs live in the global scope.
//
// Action-payload shape note: the host page-schema REJECTS action payloads with
// nested arrays/objects (page-schema.ts validateAction), so every respond
// action this module emits carries FLAT scalars only (`runId`, `step`,
// `action`, and — for a per-finding fix — `findingId` + a prompt-collected
// `instruction`). `normalizeRespondPayload` folds that scalar wire shape back
// into M1's canonical `parseRespondPayload` shape (findingIds[]/instructions{})
// at the event boundary, so parseRespondPayload stays the single validator.

import { PageBuilder } from "@ezcorp/sdk/runtime";
import type { HubPageTree, PageActionDescriptor, PageProjectRef } from "@ezcorp/sdk/runtime";
import { EXTENSION_NAME, PAGE_ID, repoId } from "./gate";
import { PIPELINE_STEPS, type PipelineStep } from "./config";
import type {
  FindingAction,
  FindingSeverity,
  Findings,
  RunRecord,
  RunStatus,
  StepResultRecord,
  StepStatus,
} from "./runs";

/** The full namespaced events the detail controls dispatch. All are declared
 *  in `ezcorp.config.ts` eventSubscriptions (the host allowlists page actions
 *  against that list). */
export const RESPOND_EVENT = `${EXTENSION_NAME}:respond`;
export const YOLO_EVENT = `${EXTENSION_NAME}:yolo`;
/** The M4 reconcile event: re-check a run parked at (or rested past) the CI gate.
 *  A read-only PR-state poll that completes the run once its PR merges/closes. */
export const RECONCILE_EVENT = `${EXTENSION_NAME}:reconcile`;

/** Human badge per run status. */
export const STATUS_BADGE: Record<RunStatus, string> = {
  created: "◌ created",
  worktree_ready: "▶ worktree",
  running: "● running",
  awaiting_approval: "⏸ awaiting approval",
  checks_passed: "☑ checks passed",
  completed: "✓ completed",
  failed: "✗ failed",
  aborted: "⊘ aborted",
};

/** Human badge per pipeline STEP status (distinct vocabulary from run status —
 *  a step can be fixing / fix_review / pending, which a run never is). */
export const STEP_STATUS_BADGE: Record<StepStatus, string> = {
  pending: "◌ pending",
  running: "● running",
  fixing: "✎ fixing",
  awaiting_approval: "⏸ awaiting approval",
  fix_review: "⏸ fix review",
  completed: "✓ completed",
  skipped: "→ skipped",
  failed: "✗ failed",
};

/** Severity glyph + label for a findings-table cell. */
export const SEVERITY_ICON: Record<FindingSeverity, string> = {
  error: "⛔ error",
  warning: "⚠ warning",
  info: "ℹ info",
};

/** Action badge for a findings-table cell (the fail-closed disposition). */
export const ACTION_BADGE: Record<FindingAction, string> = {
  "no-op": "no-op",
  "auto-fix": "auto-fix",
  "ask-user": "ask-user",
};

/** Statuses that count as "active" (in-flight) on the dashboard. */
const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "created",
  "worktree_ready",
  "running",
  "awaiting_approval",
]);

/** Step statuses at which a step is parked awaiting a human respond. */
const PARKED_STEP_STATUSES: ReadonlySet<StepStatus> = new Set<StepStatus>([
  "awaiting_approval",
  "fix_review",
]);

/** Short head-SHA for the table (first 8 chars). Pure. */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** Trim an ISO timestamp to `YYYY-MM-DD HH:MM` for a table cell. */
function shortTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

// ── Run detail (parked-gate triage) ──────────────────────────────────

/** A run plus its recorded step results — the input to the detail builder. */
export interface RunDetail {
  run: RunRecord;
  /** Step results for the run (any order; indexed by step name here). */
  steps: StepResultRecord[];
}

/** The step a run is parked at (awaiting_approval | fix_review), or undefined
 *  when nothing is parked (the run is mid-flight or terminal). */
export function parkedStep(steps: StepResultRecord[]): StepResultRecord | undefined {
  return steps.find((s) => PARKED_STEP_STATUSES.has(s.status));
}

/** Index step results by step name for O(1) lookup during rendering. */
function stepIndex(steps: StepResultRecord[]): Map<string, StepResultRecord> {
  return new Map(steps.map((s) => [s.step, s]));
}

/** A step-level respond action descriptor (approve / skip / abort). */
function stepAction(
  runId: string,
  step: PipelineStep,
  action: "approve" | "skip" | "abort",
  confirm?: string,
): PageActionDescriptor {
  return {
    event: RESPOND_EVENT,
    payload: { runId, step, action },
    ...(confirm !== undefined ? { confirm } : {}),
  };
}

/** The per-finding fix action: a scalar `findingId` in the payload plus a host
 *  prompt collecting an optional `instruction` (merged into `payload.instruction`).
 *  `normalizeRespondPayload` folds these into findingIds[]/instructions{}. */
function fixAction(runId: string, step: PipelineStep, findingId: string): PageActionDescriptor {
  return {
    event: RESPOND_EVENT,
    payload: { runId, step, action: "fix", findingId },
    prompt: {
      label: "Fix instruction (optional)",
      field: "instruction",
      placeholder: "e.g. prefer a guard clause; ignore the snapshot churn",
      submitLabel: "Request fix",
      maxLength: 500,
    },
  };
}

/** Append the pipeline step-list table (every step, in fixed order). */
function appendStepTable(page: PageBuilder, detail: RunDetail): void {
  const byName = stepIndex(detail.steps);
  page.table(
    ["Step", "Status", "Rounds"],
    PIPELINE_STEPS.map((step) => {
      const sr = byName.get(step);
      const status: StepStatus = sr?.status ?? "pending";
      return { cells: [step, STEP_STATUS_BADGE[status], String(sr?.round ?? 0)] };
    }),
  );
}

/** Append the parked step's findings table (severity, file, description,
 *  action) — each row's click requests a fix for that finding. Empty findings
 *  render an empty-state instead of a zero-row table. */
function appendFindingsTable(
  page: PageBuilder,
  runId: string,
  step: PipelineStep,
  findings: Findings,
): void {
  if (findings.items.length === 0) {
    page.emptyState(
      "No findings to triage",
      "This gate is parked for a human decision — approve to continue, or skip the step.",
    );
    return;
  }
  page.table(
    ["Severity", "File", "Description", "Action"],
    findings.items.map((f) => ({
      // A blank file/description renders as an em dash so the cell is never empty.
      cells: [
        SEVERITY_ICON[f.severity],
        f.file || "—",
        f.description || "—",
        ACTION_BADGE[f.action],
      ],
      action: fixAction(runId, step, f.id),
    })),
  );
}

/** Append the review risk line as a stats row, when the parked findings carry
 *  a risk level (review's structured output). */
function appendRiskLine(page: PageBuilder, findings: Findings): void {
  if (!findings.riskLevel && !findings.riskRationale) return;
  page.stats([
    { label: "Risk", value: findings.riskLevel || "—", hint: findings.riskRationale || undefined },
  ]);
}

/** Append the log/summary panel: the step summary, the latest fix summary, the
 *  testing summary, and the tested / artifact lists — all as text nodes. */
function appendLogPanel(page: PageBuilder, sr: StepResultRecord, findings: Findings): void {
  const rows: Array<{ label: string; value: string }> = [];
  if (findings.summary) rows.push({ label: "Summary", value: findings.summary });
  if (sr.fixSummary) rows.push({ label: "Last fix", value: sr.fixSummary });
  if (findings.testingSummary) rows.push({ label: "Testing", value: findings.testingSummary });
  if (findings.tested.length > 0) rows.push({ label: "Tested", value: findings.tested.join(", ") });
  if (findings.artifacts.length > 0) {
    rows.push({ label: "Artifacts", value: findings.artifacts.join(", ") });
  }
  if (rows.length === 0) return;
  page.table(
    ["Field", "Detail"],
    rows.map((r) => ({ cells: [r.label, r.value] })),
  );
}

/**
 * Append the full run-detail (triage) section for a parked run to `page`. When
 * the run is not parked (mid-flight / terminal / no parked step) it renders the
 * step list plus a state note only — no action controls. Pure.
 */
export function appendRunDetail(page: PageBuilder, detail: RunDetail): void {
  const { run } = detail;
  page.section(`Run ${run.id} · ${run.branch}`, (section) => {
    section.stats([
      { label: "Status", value: STATUS_BADGE[run.status] },
      { label: "Head", value: shortSha(run.headSha) },
      { label: "Intent", value: run.intent ? "explicit" : "none", hint: run.intent ?? undefined },
    ]);
    appendStepTable(section, detail);

    const parked = parkedStep(detail.steps);
    if (!parked) {
      section.emptyState(
        run.status === "awaiting_approval" ? "Loading gate…" : "Nothing to triage",
        run.status === "awaiting_approval"
          ? "This run is parked; its step findings are loading."
          : "This run is not parked at a gate — no action is needed right now.",
      );
      return;
    }

    const step = parked.step as PipelineStep;
    section.heading(3, `Gate: ${step} (${STEP_STATUS_BADGE[parked.status]})`);
    appendRiskLine(section, parked.findings);
    appendFindingsTable(section, run.id, step, parked.findings);
    appendLogPanel(section, parked, parked.findings);

    // Step-level controls. Approve continues; skip marks the step skipped;
    // abort cancels the run; yolo runs the fix-once autopilot — it auto-fixes
    // each remaining gate's `auto-fix` findings ONCE, then approves, but STOPS at
    // the first gate carrying an `ask-user` finding (a human decision it will not
    // make). Skip, abort, and yolo confirm.
    section.button("Approve step", stepAction(run.id, step, "approve"), "primary");
    // CI gate only: re-check the PR state (read-only reconcile). Completes the run
    // once its PR merges/closes; leaves it parked/resting while still open. This is
    // the intended action for a checks_passed run (worktree already torn down) and
    // a CI-timeout-parked run alike — no confirm (it never mutates the branch).
    if (step === "ci") {
      section.button(
        "Re-check PR state",
        { event: RECONCILE_EVENT, payload: { runId: run.id } },
        "secondary",
      );
    }
    section.button(
      "Skip step",
      stepAction(run.id, step, "skip", `Skip the "${step}" step for run ${run.id}?`),
      "secondary",
    );
    section.button(
      "Yolo — fix once, then approve remaining gates",
      {
        event: YOLO_EVENT,
        payload: { runId: run.id, step },
        confirm: `Yolo for run ${run.id}: auto-fix each remaining gate's findings once and approve — but STOP at any gate that needs a human decision (an ask-user finding). Continue?`,
      },
      "secondary",
    );
    section.button(
      "Abort run",
      stepAction(run.id, step, "abort", `Abort run ${run.id}? This cancels the whole pipeline.`),
      "danger",
    );
  });
}

/** Build a standalone run-detail page tree (the "run-detail page"). Reused
 *  inline by the dashboard for parked runs; exported for direct rendering +
 *  focused tests. */
export function buildRunDetail(detail: RunDetail): HubPageTree {
  const page = new PageBuilder("ez-code-factory");
  appendRunDetail(page, detail);
  return page.build();
}

// ── Dashboard variants (global fallback / per-project / home) ────────

/** One platform project, as the host hands it to a `perProject` render —
 *  the SDK's own type, so host-contract changes reach these builders. */
export type ProjectRef = PageProjectRef;

/** The full hub page id as it appears in URLs — home rows deep-link to
 *  `/project/<projectId>/hub/<this>`. */
export const FULL_PAGE_ID = `ext:${EXTENSION_NAME}:${PAGE_ID}`;

/** The host silently TRUNCATES tables past 100 rows (page-schema
 *  MAX_TABLE_ROWS `.slice`) — clamp the projects table ourselves so we
 *  can render the "showing first N" notice instead of dropping rows
 *  without a trace. */
const MAX_PROJECT_ROWS = 100;

const EMPTY_STATE_DETAIL =
  "Run the `init_gate` tool on this project, then `git push gate <branch>` to intercept a push.";

/** Run-count stats row shared by every dashboard variant. */
function appendRunStats(page: PageBuilder, runs: RunRecord[]): void {
  const active = runs.filter((r) => ACTIVE_STATUSES.has(r.status)).length;
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed = runs.filter((r) => r.status === "failed" || r.status === "aborted").length;
  page.stats([
    { label: "Total runs", value: String(runs.length) },
    { label: "Active", value: String(active) },
    { label: "Completed", value: String(completed) },
    { label: "Failed", value: String(failed) },
  ]);
}

/** The runs table + inline triage detail — the body every variant shares.
 *  Details are filtered to the runs actually shown. */
function appendRunsSection(page: PageBuilder, runs: RunRecord[], details: RunDetail[]): void {
  page.table(
    ["Run", "Branch", "Head", "Status", "Updated"],
    runs.map((r) => ({
      cells: [
        r.id,
        r.branch,
        shortSha(r.headSha),
        STATUS_BADGE[r.status],
        shortTime(r.updatedAt),
      ],
    })),
  );
  // Inline the triage detail for every parked run (typically 0–2), so a human
  // can act on findings without navigating away from the shared dashboard.
  const shown = new Set(runs.map((r) => r.id));
  for (const detail of details) {
    if (shown.has(detail.run.id)) appendRunDetail(page, detail);
  }
}

/** A registered project path may carry a trailing slash the gate's
 *  cwd-derived root never has — strip it (but keep bare "/") so both
 *  sides hash to the same repo id. NEVER applied inside `repoId` itself:
 *  existing gate directories on disk are named by the unnormalized hash. */
export function normalizeProjectPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Runs belonging to one project — matched by the SAME derivation the gate
 *  uses (`repoId(<normalized project.path>)`), so path handling stays in
 *  one place. */
export function runsForProject(project: ProjectRef, runs: RunRecord[]): RunRecord[] {
  const id = repoId(normalizeProjectPath(project.path));
  return runs.filter((r) => r.repoId === id);
}

/**
 * Build the dashboard tree from a run list (newest first) plus the parked-run
 * details to inline. Pure — no IO. An empty list renders a call-to-action
 * pointing at `init_gate`; each parked run gets an inline triage section.
 * Rendered when the host provides NO project context (older host, or the
 * `perProject` flag removed) — behavior identical to the pre-perProject page.
 */
export function buildDashboard(runs: RunRecord[], details: RunDetail[] = []): HubPageTree {
  const page = new PageBuilder("ez-code-factory").markdownBlock(
    "Runs created by `git push gate <branch>`. Each push lands in the local " +
      "gate repo, whose post-receive hook triggers this extension to record a " +
      "run and materialize a disposable worktree.",
  );
  appendRunStats(page, runs);

  if (runs.length === 0) {
    page.emptyState("No gate runs yet", EMPTY_STATE_DETAIL);
    return page.build();
  }

  appendRunsSection(page, runs, details);
  return page.build();
}

/**
 * Project-scoped dashboard (`/project/<id>/hub/...`): ONLY this project's
 * runs + triage. Pure — filters from the full lists so the caller never
 * pre-slices.
 */
export function buildProjectDashboard(
  project: ProjectRef,
  runs: RunRecord[],
  details: RunDetail[] = [],
): HubPageTree {
  const own = runsForProject(project, runs);
  const page = new PageBuilder(`ez-code-factory — ${project.name}`);
  appendRunStats(page, own);

  if (own.length === 0) {
    page.emptyState("No gate runs for this project yet", EMPTY_STATE_DETAIL);
    return page.build();
  }

  appendRunsSection(page, own, details);
  return page.build();
}

/**
 * Global-hub home (`/hub/...`): one row per registered project deep-linking
 * into its project-scoped dashboard, then a triage section for runs whose
 * repo matches NO registered project — a gate initialized on a non-project
 * checkout still needs approve/fix/skip from somewhere.
 */
export function buildHome(
  projects: ProjectRef[],
  runs: RunRecord[],
  details: RunDetail[] = [],
): HubPageTree {
  const page = new PageBuilder("ez-code-factory").markdownBlock(
    "Runs created by `git push gate <branch>`, grouped by project. Open a " +
      "project row for its dedicated dashboard; runs from repos outside any " +
      "registered project are triaged below.",
  );
  appendRunStats(page, runs);

  if (projects.length === 0 && runs.length === 0) {
    page.emptyState("No gate runs yet", EMPTY_STATE_DETAIL);
    return page.build();
  }

  const matched = new Set<string>();
  if (projects.length > 0) {
    page.heading(2, "Projects");
    const shown = projects.slice(0, MAX_PROJECT_ROWS);
    page.table(
      ["Project", "Runs", "Active", "Parked", "Last push"],
      shown.map((p) => {
        const own = runsForProject(p, runs);
        for (const r of own) matched.add(r.id);
        const active = own.filter((r) => ACTIVE_STATUSES.has(r.status)).length;
        const parked = own.filter((r) => r.status === "awaiting_approval").length;
        const last = own.reduce<string | null>(
          (acc, r) => (acc === null || r.updatedAt > acc ? r.updatedAt : acc),
          null,
        );
        return {
          cells: [
            p.name,
            String(own.length),
            String(active),
            String(parked),
            last ? shortTime(last) : "—",
          ],
          href: `/project/${p.id}/hub/${encodeURIComponent(FULL_PAGE_ID)}`,
        };
      }),
    );
    if (projects.length > MAX_PROJECT_ROWS) {
      page.markdown(`Showing the first ${MAX_PROJECT_ROWS} of ${projects.length} projects.`, "muted");
    }
    // Runs for projects PAST the row clamp still belong to a registered
    // project — keep them out of the orphan section.
    for (const p of projects.slice(MAX_PROJECT_ROWS)) {
      for (const r of runsForProject(p, runs)) matched.add(r.id);
    }
  }

  const orphans = runs.filter((r) => !matched.has(r.id));
  if (orphans.length > 0) {
    page.heading(2, "Runs outside registered projects");
    appendRunsSection(page, orphans, details);
  }

  return page.build();
}

// ── respond-payload normalization (scalar UI shape → canonical) ──────

/**
 * Fold the FLAT scalar respond payload the Hub emits (page action payloads
 * cannot nest arrays/objects — page-schema.ts rejects them) back into M1's
 * canonical `parseRespondPayload` shape:
 *   - `findingId` (scalar) → `findingIds: [findingId]`
 *   - `instruction` (scalar) → `instructions: { [findingId]: instruction }`
 *
 * Non-destructive + additive: when the caller already supplied the canonical
 * `findingIds` array / `instructions` object (the harness/tool POST path sends
 * them directly), those are left untouched. A non-object input is returned
 * as-is so the downstream `parseRespondPayload` rejects it. Never throws.
 */
export function normalizeRespondPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const p = { ...(raw as Record<string, unknown>) };

  const findingId = typeof p.findingId === "string" ? p.findingId.trim() : "";
  if (findingId && !Array.isArray(p.findingIds)) {
    p.findingIds = [findingId];
  }

  const instruction = typeof p.instruction === "string" ? p.instruction : "";
  if (instruction.trim() !== "" && (p.instructions == null || typeof p.instructions !== "object")) {
    // Key the per-finding note by the resolved finding id (the scalar, or the
    // first canonical id when only findingIds was supplied). Without a key the
    // note has nowhere to attach, so it is dropped.
    const key =
      findingId ||
      (Array.isArray(p.findingIds) && typeof p.findingIds[0] === "string" ? p.findingIds[0] : "");
    if (key) p.instructions = { [key]: instruction };
  }

  return p;
}

/**
 * Validate a single-run action payload — requires a non-empty string `runId`.
 * Returns the trimmed runId or null (the handler logs "invalid payload" and
 * no-ops). Never throws. Deliberately minimal: the handlers (yolo autopilot,
 * reconcile) re-read the run + its parked step from the store, so no other field
 * is trusted from the wire — hence a neutral name shared by both callers.
 */
export function parseRunIdPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const runId = (payload as Record<string, unknown>).runId;
  if (typeof runId !== "string") return null;
  const trimmed = runId.trim();
  return trimmed === "" ? null : trimmed;
}
