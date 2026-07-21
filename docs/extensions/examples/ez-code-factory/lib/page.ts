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
import type {
  HubPageTree,
  PageActionDescriptor,
  PageCellInput,
  PageCellTone,
  PageProjectRef,
} from "@ezcorp/sdk/runtime";
import { EXTENSION_NAME, PAGE_ID, repoId } from "./gate";
import { PIPELINE_STEPS, type PipelineStep } from "./config";
import type {
  FindingAction,
  FindingSeverity,
  Findings,
  RunRecord,
  RunStatus,
  StepResultRecord,
  StepRoundRecord,
  StepStatus,
} from "./runs";
import type { StepIORecord } from "./step-io";

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
  stalled: "⚠ stalled",
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

/**
 * Semantic tone per RUN status — the DRY sibling of `STATUS_BADGE` (same key
 * set, so a new status can't get a glyph without a tone or vice-versa). Red =
 * failed/aborted, green = completed/checks_passed, orange = the run has a
 * question for the user (awaiting_approval); everything mid-flight stays
 * neutral. Consumed by `statusCell`.
 */
export const STATUS_TONE: Record<RunStatus, PageCellTone> = {
  created: "neutral",
  worktree_ready: "neutral",
  running: "neutral",
  awaiting_approval: "warning",
  checks_passed: "success",
  completed: "success",
  failed: "danger",
  aborted: "danger",
  // A run whose executor died mid-step — a truthful warning, not a failure
  // (non-terminal; a racing dispatch can still move it on). Derived-display +
  // step-level stalled rendering land in Phase 3; the map entry is here because
  // the RunStatus union is compiler-forced to be exhaustive.
  stalled: "warning",
};

/** Semantic tone per STEP status — DRY sibling of `STEP_STATUS_BADGE`. Parked
 *  gates (awaiting_approval / fix_review) warn; completed passes; failed is
 *  danger; the in-flight/neutral states carry no colour. Consumed by
 *  `stepStatusCell`. */
export const STEP_STATUS_TONE: Record<StepStatus, PageCellTone> = {
  pending: "neutral",
  running: "neutral",
  fixing: "neutral",
  awaiting_approval: "warning",
  fix_review: "warning",
  completed: "success",
  skipped: "neutral",
  failed: "danger",
};

/**
 * The Status table cell for a run: the glyph text carrying its DRY tone. A
 * neutral status returns a BARE string (not `{text, tone:"neutral"}`) so a
 * mid-flight row keeps the exact pre-tone wire shape — the host would fold the
 * neutral object to a string anyway, but emitting the string here keeps the
 * builders' own output minimal + unsurprising.
 */
function statusCell(status: RunStatus): PageCellInput {
  const text = STATUS_BADGE[status];
  const tone = STATUS_TONE[status];
  return tone === "neutral" ? text : { text, tone };
}

/** The Status table cell for a pipeline step — the step-status twin of
 *  `statusCell`. Neutral → bare string (see `statusCell`). */
function stepStatusCell(status: StepStatus): PageCellInput {
  const text = STEP_STATUS_BADGE[status];
  const tone = STEP_STATUS_TONE[status];
  return tone === "neutral" ? text : { text, tone };
}

/**
 * The EFFECTIVE run status for display (L3): a `running` run whose id is in the
 * derived `stalledRunIds` set renders as `stalled` — the sweep's persisted
 * `stalled` needs no override (it already IS stalled). This is where OQ2 lands:
 * builders PRE-MAP to the effective status here and hand it to the pure
 * `statusCell`/`STATUS_BADGE`, so those stay unchanged single-arg lookups and
 * every call site is a one-liner. Pure.
 */
export function effectiveRunStatus(
  run: Pick<RunRecord, "id" | "status">,
  stalledRunIds?: ReadonlySet<string>,
): RunStatus {
  return run.status === "running" && stalledRunIds?.has(run.id) ? "stalled" : run.status;
}

/** The step-detail cell for a step whose RUN is stalled (persisted or derived):
 *  an in-flight step (`running`/`fixing`) surfaces `⚠ stalled` with warning tone
 *  (display-derived only — the StepStatus union is unchanged, L3). Any other
 *  step status renders its own cell. */
function effectiveStepCell(status: StepStatus, runStalled: boolean): PageCellInput {
  if (runStalled && (status === "running" || status === "fixing")) {
    return { text: STATUS_BADGE.stalled, tone: "warning" };
  }
  return stepStatusCell(status);
}

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

/** Append the pipeline step-list table (every step, in fixed order). Each row
 *  LINKS to that step's detail (`?run=<id>&step=<name>`); when the run is
 *  stalled, an in-flight step's Status cell surfaces `⚠ stalled` (L3). `opts`
 *  carries the run's stalled-ness + the resolved projectId (for the href form).
 */
function appendStepTable(
  page: PageBuilder,
  detail: RunDetail,
  opts?: { runStalled?: boolean; projectId?: string },
): void {
  const byName = stepIndex(detail.steps);
  const runStalled = opts?.runStalled === true;
  page.table(
    ["Step", "Status", "Rounds"],
    PIPELINE_STEPS.map((step) => {
      const sr = byName.get(step);
      const status: StepStatus = sr?.status ?? "pending";
      return {
        cells: [step, effectiveStepCell(status, runStalled), String(sr?.round ?? 0)],
        href: stepDetailHref(opts?.projectId, detail.run.id, step),
      };
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
  opts?: { interactive?: boolean },
): void {
  // `interactive` (default true) attaches the per-finding fix action + the
  // triage empty-state — the parked-gate dashboard uses it. The read-only
  // run-detail view passes `false`: findings render as a plain reference table
  // (no fix action), and an empty list is simply skipped by the caller.
  const interactive = opts?.interactive !== false;
  if (findings.items.length === 0) {
    if (interactive) {
      page.emptyState(
        "No findings to triage",
        "This gate is parked for a human decision — approve to continue, or skip the step.",
      );
    }
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
      ...(interactive ? { action: fixAction(runId, step, f.id) } : {}),
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
export function appendRunDetail(
  page: PageBuilder,
  detail: RunDetail,
  opts?: { stalledRunIds?: ReadonlySet<string>; projectId?: string },
): void {
  const { run } = detail;
  const effStatus = effectiveRunStatus(run, opts?.stalledRunIds);
  const runStalled = effStatus === "stalled";
  page.section(`Run ${run.id} · ${run.branch}`, (section) => {
    section.stats([
      { label: "Status", value: STATUS_BADGE[effStatus] },
      { label: "Head", value: shortSha(run.headSha) },
      { label: "Intent", value: run.intent ? "explicit" : "none", hint: run.intent ?? undefined },
    ]);
    appendStepTable(section, detail, { runStalled, projectId: opts?.projectId });

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

// ── Run-detail VIEW (the `?run=<id>` render variant) ─────────────────

/** Deep-link from a turn row into its chat sub-conversation on the project.
 *  Both ids are `encodeURIComponent`d, so each path segment is free of `/` and
 *  `\` — the result is internal + safe by construction (the host re-checks
 *  `isSafeInternalHref` when it validates the tree on ingest). Mirrors the
 *  `/project/[id]/chat/[convId]` route. */
function chatHref(projectId: string, subConversationId: string): string {
  return `/project/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(subConversationId)}`;
}

/**
 * Append the recorded agent-dispatch provenance for a step — one row per
 * dispatch, each deep-linking (when a project is resolvable) into that
 * dispatch's chat sub-conversation.
 *
 * PRIVACY (the ez-code precedent, index.ts ~462): this page tree is CACHED and
 * served to ALL users for 60s (page-cache.ts), so it must never bake a private
 * conversation's CONTENT into the shared tree. Two facts let us ship the
 * `/chat/<subConversationId>` deep-link WITHOUT crossing that line:
 *   1. We link, we never inline. A render must NOT read turn content into the
 *      tree — not for lack of capability (the host
 *      `runtime.conversations.getMessages` RPC takes an ARBITRARY conversation
 *      id, so a render could technically read any sub-conversation), but
 *      because that text would then sit in the shared cross-user page cache.
 *      So a row carries only the dispatch's ids / role / time — never a turn.
 *   2. The link itself leaks nothing. The chat route is fail-closed authz'd
 *      (web/src/routes/api/conversations/[id]/+server.ts: an unowned or
 *      other-user conversation 404s for non-admins), so a shared deep-link only
 *      OPENS for a viewer already entitled to that conversation — everyone else
 *      hits the route's own per-user authorization. The sub-conversation id is
 *      already published as text in this tree regardless, so the href adds
 *      reachability, not exposure.
 * The deep-link needs a project to address; an orphan / global-view run (no
 * resolvable project — see `projectIdForRun`) omits the href and keeps the ids
 * as plain provenance text. Old runs recorded no linkage and render an honest
 * "no recorded turns" note.
 */
function appendAgentTurns(page: PageBuilder, sr: StepResultRecord, projectId?: string): void {
  const dispatches = sr.agentDispatches ?? [];
  if (dispatches.length === 0) {
    page.emptyState(
      "No recorded turns",
      "This step recorded no agent dispatch — an old run (pre-linkage), or a step that ran no agent.",
    );
    return;
  }
  page.heading(3, "Agent turns");
  page.table(
    ["#", "Role", "Sub-conversation", "Assignment", "When"],
    dispatches.map((d, i) => ({
      cells: [String(i + 1), d.role, d.subConversationId, d.assignmentId, shortTime(d.at)],
      // A project-scoped detail deep-links each row to its chat sub-conversation;
      // an orphan/global view has no project to address and stays text-only.
      ...(projectId ? { href: chatHref(projectId, d.subConversationId) } : {}),
    })),
  );
}

/** Statuses of a step worth expanding into its own detail subsection. A
 *  `pending` step with nothing recorded is skipped (the step table already
 *  lists it). */
function stepHasDetail(sr: StepResultRecord): boolean {
  return (
    sr.findings.items.length > 0 ||
    sr.findings.summary !== "" ||
    sr.findings.testingSummary !== "" ||
    sr.fixSummary !== null ||
    (sr.agentDispatches?.length ?? 0) > 0
  );
}

/**
 * Build the standalone run-DETAIL page (the `?run=<id>` render variant): the
 * run's metadata, the full pipeline step table (tone-coloured), and — per step
 * that recorded anything — its findings, log/summary panel, and agent-turn
 * provenance. Pure. `detail === null` (unknown run id) renders an honest
 * "not found" note rather than an error. Distinct from `buildRunDetail`
 * (the parked-gate TRIAGE surface with its approve/fix/skip controls); this
 * view is READ-ONLY and covers every step, not just the parked one.
 *
 * `projectId` (the run's owning project — resolved by the caller via
 * `projectIdForRun`) enables the per-turn chat deep-links; omit it for an
 * orphan / global-view run and the turn rows stay text-only provenance.
 */
export function buildRunDetailView(
  runId: string,
  detail: RunDetail | null,
  projectId?: string,
  stalledRunIds?: ReadonlySet<string>,
): HubPageTree {
  const page = new PageBuilder(`ez-code-factory — run ${runId}`);
  if (!detail) {
    page.emptyState(
      "Run not found",
      `No run ${runId} is recorded on this deployment — it may have been swept, or the link is stale.`,
    );
    return page.build();
  }

  const { run, steps } = detail;
  const effStatus = effectiveRunStatus(run, stalledRunIds);
  page.section(`Run ${run.id} · ${run.branch}`, (section) => {
    section.stats([
      { label: "Status", value: STATUS_BADGE[effStatus] },
      { label: "Head", value: shortSha(run.headSha) },
      { label: "Updated", value: shortTime(run.updatedAt) },
      { label: "Intent", value: run.intent ? "explicit" : "none", hint: run.intent ?? undefined },
    ]);
    appendStepTable(section, detail, { runStalled: effStatus === "stalled", projectId });
  });

  const byName = stepIndex(steps);
  for (const step of PIPELINE_STEPS) {
    const sr = byName.get(step);
    if (!sr || !stepHasDetail(sr)) continue;
    page.section(`${step} · ${STEP_STATUS_BADGE[sr.status]}`, (section) => {
      appendRiskLine(section, sr.findings);
      // Read-only findings reference (no per-finding fix action here).
      appendFindingsTable(section, run.id, step as PipelineStep, sr.findings, { interactive: false });
      appendLogPanel(section, sr, sr.findings);
      appendAgentTurns(section, sr, projectId);
    });
  }

  return page.build();
}

// ── Step-detail VIEW (the `?run=<id>&step=<name>` render variant) ────

/** Max chars of any stored blob rendered into a cell. The BUILDER pre-truncates
 *  because the 64 KB tree-envelope check runs on the RAW input BEFORE the
 *  validator's own per-cell 300-char truncation (page-schema.ts) — a stored
 *  32 KB blob passed whole would reject the ENTIRE tree. Full bounded content
 *  stays in storage; this view shows an excerpt. */
const STEP_IO_EXCERPT_CHARS = 280;

/** Latest N rounds rendered in a step detail — bounds the node count well under
 *  the 500-node tree cap (~12 nodes/round × 10 ≈ 120). Older rounds get a note. */
const MAX_STEP_DETAIL_ROUNDS = 10;

/** Pre-truncate a stored blob to a cell-safe excerpt with an explicit size note
 *  (e.g. "…[4210 chars · excerpt]"). "—" for empty. NEVER fed to a markdown
 *  node — table cells only (the XSS invariant). Pure. */
function ioExcerpt(text: string): string {
  if (text === "") return "—";
  if (text.length <= STEP_IO_EXCERPT_CHARS) return text;
  const keep = STEP_IO_EXCERPT_CHARS - 28;
  return `${text.slice(0, keep).trimEnd()} …[${text.length} chars · excerpt]`;
}

/** The step + everything recorded for it — the input to the step-detail view.
 *  `result`/`rounds` come from step_results/step_rounds; `io` from listStepIO
 *  (prefix listing — NOT a 1..sr.round loop, since an errored final attempt
 *  writes an IO record beyond sr.round). */
export interface StepDetail {
  run: RunRecord;
  step: PipelineStep;
  result: StepResultRecord | null;
  rounds: StepRoundRecord[];
  io: StepIORecord[];
}

/** Append one round's IO detail — inputs, agent dispatches (deep-linked, work
 *  product only), and trusted shell commands. When the round has a step_round
 *  but no IO record (a pre-feature round of a live run) an honest note shows. */
function appendStepIORound(
  page: PageBuilder,
  round: StepRoundRecord | undefined,
  io: StepIORecord | undefined,
  projectId?: string,
): void {
  if (!io) {
    page.emptyState(
      "No recorded IO for this round",
      "This round executed before per-round IO recording was enabled.",
    );
    if (round?.fixSummary) {
      page.table(["Field", "Detail"], [{ cells: ["Last fix", round.fixSummary] }]);
    }
    return;
  }

  // Inputs — every value is a bounded scalar; a stored blob (error) is excerpted.
  const inputRows: Array<[string, string]> = [
    ["Branch", io.branch || "—"],
    ["Head", shortSha(io.headSha)],
    ["Worktree", io.worktreePath || "—"],
    ["Agent", io.repoConfig.agent || "default"],
    ["Commands", `test: ${io.repoConfig.commandTest || "—"} · lint: ${io.repoConfig.commandLint || "—"}`],
    ["Started", shortTime(io.startedAt)],
    ["Ended", shortTime(io.endedAt)],
    ["Duration", `${io.durationMs} ms`],
  ];
  if (io.error) inputRows.push(["Error", ioExcerpt(io.error)]);
  page.table(
    ["Field", "Detail"],
    inputRows.map(([label, value]) => ({ cells: [label, value] })),
  );

  // Agent dispatches — prompt + bounded RESULT PREVIEW (work product), each
  // row deep-linking its chat sub-conversation (never inlining transcript
  // content — the same privacy rule as appendAgentTurns).
  if (io.dispatches.length > 0) {
    page.heading(3, "Agent dispatches");
    page.table(
      ["#", "Role", "Prompt", "Result", "When"],
      io.dispatches.map((d, i) => ({
        cells: [
          String(i + 1),
          d.role,
          ioExcerpt(d.promptText),
          d.error ? `error: ${ioExcerpt(d.error)}` : ioExcerpt(d.resultPreview),
          shortTime(d.at),
        ],
        ...(projectId && d.subConversationId ? { href: chatHref(projectId, d.subConversationId) } : {}),
      })),
    );
  }

  // Trusted shell commands (test/lint) — command, exit code, duration, output
  // excerpt. Git plumbing is deliberately absent (L7).
  if (io.shellCommands.length > 0) {
    page.heading(3, "Shell commands");
    page.table(
      ["Command", "Exit", "Duration", "Output"],
      io.shellCommands.map((s) => ({
        cells: [ioExcerpt(s.command), String(s.exitCode), `${s.durationMs} ms`, ioExcerpt(s.output)],
      })),
    );
  }
}

/**
 * Build the standalone STEP-detail page (the `?run=<id>&step=<name>` variant):
 * the step's metadata, its aggregate findings/log/turns (reusing the run-detail
 * builders verbatim), then per-ROUND IO sections newest-first — inputs, prompts,
 * shell commands, dispatch deep-links, timings, and errors. Pure. `detail ===
 * null` (unknown run/step) renders an honest note. The RUN's effective status
 * drives the stalled-aware step badge (L3). Every excerpt is builder-truncated
 * so a 32 KB stored blob can never blow the 64 KB tree envelope.
 */
export function buildStepDetailView(
  detail: StepDetail | null,
  projectId?: string,
  stalledRunIds?: ReadonlySet<string>,
): HubPageTree {
  const page = new PageBuilder("ez-code-factory — step");
  if (!detail) {
    page.emptyState(
      "Step not found",
      "No such run/step is recorded on this deployment — the link may be stale, or the step never ran.",
    );
    return page.build();
  }

  const { run, step, result, rounds, io } = detail;
  const runStalled = effectiveRunStatus(run, stalledRunIds) === "stalled";
  const stepStatus: StepStatus = result?.status ?? "pending";
  // Step-level stalled: an in-flight step of a stalled run surfaces ⚠ stalled.
  const statusBadge =
    runStalled && (stepStatus === "running" || stepStatus === "fixing")
      ? STATUS_BADGE.stalled
      : STEP_STATUS_BADGE[stepStatus];

  page.section(`Run ${run.id} · ${step}`, (section) => {
    section.stats([
      { label: "Run", value: run.id },
      { label: "Branch", value: run.branch },
      { label: "Step", value: step },
      { label: "Status", value: statusBadge },
      { label: "Rounds", value: String(result?.round ?? 0) },
      { label: "Duration", value: `${result?.executionMs ?? 0} ms` },
      { label: "Updated", value: shortTime(run.updatedAt) },
    ]);
  });

  // Aggregate step findings/log/turns (verbatim reuse of the run-detail
  // builders) when the step recorded anything worth expanding.
  if (result && stepHasDetail(result)) {
    page.section(`${step} summary`, (section) => {
      appendRiskLine(section, result.findings);
      appendFindingsTable(section, run.id, step, result.findings, { interactive: false });
      appendLogPanel(section, result, result.findings);
      appendAgentTurns(section, result, projectId);
    });
  }

  // Per-round IO. LEFT-join step_rounds with step_io over the UNION of round
  // numbers — an errored final round has an IO record but NO step_round, while
  // a pre-feature round has a step_round but NO IO. Newest first, clamped.
  const roundByN = new Map(rounds.map((r) => [r.round, r]));
  const ioByN = new Map(io.map((r) => [r.round, r]));
  const allRounds = [...new Set([...roundByN.keys(), ...ioByN.keys()])].sort((a, b) => b - a);

  if (allRounds.length === 0) {
    page.emptyState(
      "No recorded IO for this step (run predates IO recording)",
      "This step recorded no rounds — an old run from before per-round IO recording, or a step that never executed on this run.",
    );
    return page.build();
  }

  const shownRounds = allRounds.slice(0, MAX_STEP_DETAIL_ROUNDS);
  if (allRounds.length > shownRounds.length) {
    page.markdown(
      `Showing the latest ${shownRounds.length} of ${allRounds.length} rounds.`,
      "muted",
    );
  }

  for (const n of shownRounds) {
    const rr = roundByN.get(n);
    const ir = ioByN.get(n);
    const trigger = ir?.trigger ?? rr?.trigger ?? "initial";
    page.section(`Round ${n} · ${trigger}`, (section) => {
      appendStepIORound(section, rr, ir, projectId);
    });
  }

  return page.build();
}

// ── Dashboard variants (global fallback / per-project / home) ────────

/** One platform project, as the host hands it to a `perProject` render —
 *  the SDK's own type, so host-contract changes reach these builders. */
export type ProjectRef = PageProjectRef;

/** The full hub page id as it appears in URLs — home rows deep-link to
 *  `/project/<projectId>/hub/<this>`. */
export const FULL_PAGE_ID = `ext:${EXTENSION_NAME}:${PAGE_ID}`;

/** Deep-link to a run's DETAIL render variant on the PROJECT hub — the
 *  per-project dashboard's run rows carry it (`?run=<id>` is a query-only
 *  navigation on the same page, so the host re-pulls with `ctx.run` set). */
function projectRunHref(projectId: string, runId: string): string {
  return `/project/${projectId}/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=${encodeURIComponent(runId)}`;
}

/** Deep-link to a run's DETAIL render variant on the GLOBAL hub — used for
 *  orphan runs (no registered project) and the context-less dashboard, which
 *  have no project to scope the link to. */
function globalRunHref(runId: string): string {
  return `/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=${encodeURIComponent(runId)}`;
}

/** Deep-link to a STEP's detail render variant (`?run=<id>&step=<name>`) — the
 *  project-hub form when a projectId resolves, the global-hub form otherwise
 *  (mirrors projectRunHref/globalRunHref). Both are query-only navigations on
 *  the same page, so the host re-pulls with `ctx.run` + `ctx.step` set. */
function stepDetailHref(projectId: string | undefined, runId: string, step: string): string {
  const base = projectId
    ? `/project/${projectId}/hub/${encodeURIComponent(FULL_PAGE_ID)}`
    : `/hub/${encodeURIComponent(FULL_PAGE_ID)}`;
  return `${base}?run=${encodeURIComponent(runId)}&step=${encodeURIComponent(step)}`;
}

/** The host silently TRUNCATES tables past 100 rows (page-schema
 *  MAX_TABLE_ROWS `.slice`) — clamp the projects table ourselves so we
 *  can render the "showing first N" notice instead of dropping rows
 *  without a trace. */
const MAX_PROJECT_ROWS = 100;

const EMPTY_STATE_DETAIL =
  "Run the `init_gate` tool on this project, then `git push gate <branch>` to intercept a push.";

/** Run-count stats row shared by every dashboard variant. Buckets read the
 *  EFFECTIVE status (a derived-stalled `running` run counts as Stalled, NOT
 *  Active), and a "Stalled" bucket appears when > 0 — a persisted- or
 *  derived-stalled run otherwise falls into none of Active/Completed/Failed
 *  (review finding, L3). */
function appendRunStats(
  page: PageBuilder,
  runs: RunRecord[],
  stalledRunIds?: ReadonlySet<string>,
): void {
  const effective = runs.map((r) => effectiveRunStatus(r, stalledRunIds));
  const active = effective.filter((s) => ACTIVE_STATUSES.has(s)).length;
  const completed = effective.filter((s) => s === "completed").length;
  const failed = effective.filter((s) => s === "failed" || s === "aborted").length;
  const stalled = effective.filter((s) => s === "stalled").length;
  page.stats([
    { label: "Total runs", value: String(runs.length) },
    { label: "Active", value: String(active) },
    ...(stalled > 0 ? [{ label: "Stalled", value: String(stalled) }] : []),
    { label: "Completed", value: String(completed) },
    { label: "Failed", value: String(failed) },
  ]);
}

/** Truncate a row list to the host's table cap, appending a muted
 *  "showing first N" notice when rows were dropped — the host itself
 *  silently `.slice`s past 100, which loses data without a trace. */
function clampRows<T>(page: PageBuilder, items: T[], label: string): T[] {
  if (items.length <= MAX_PROJECT_ROWS) return items;
  page.markdown(
    `Showing the first ${MAX_PROJECT_ROWS} of ${items.length} ${label}.`,
    "muted",
  );
  return items.slice(0, MAX_PROJECT_ROWS);
}

/** The runs table + inline triage detail — the body every variant shares.
 *  Rows clamp with a visible notice; details are filtered to the runs
 *  actually shown. Each row is a LINK to the run's detail view (built by
 *  `runHref` — project-scoped or global) and its Status cell carries the DRY
 *  status→tone colour. */
function appendRunsSection(
  page: PageBuilder,
  runs: RunRecord[],
  details: RunDetail[],
  runHref: (runId: string) => string,
  opts?: { stalledRunIds?: ReadonlySet<string>; projectId?: string },
): void {
  const shownRuns = clampRows(page, runs, "runs");
  page.table(
    ["Run", "Branch", "Head", "Status", "Updated"],
    shownRuns.map((r) => ({
      cells: [
        r.id,
        r.branch,
        shortSha(r.headSha),
        // The Status cell renders the EFFECTIVE status (stalled overrides
        // running) with its DRY tone — a dead run shows ⚠ stalled (warning).
        statusCell(effectiveRunStatus(r, opts?.stalledRunIds)),
        shortTime(r.updatedAt),
      ],
      href: runHref(r.id),
    })),
  );
  // Inline the triage detail for every parked run (typically 0–2), so a human
  // can act on findings without navigating away from the shared dashboard.
  const shown = new Set(shownRuns.map((r) => r.id));
  for (const detail of details) {
    if (shown.has(detail.run.id)) {
      appendRunDetail(page, detail, { stalledRunIds: opts?.stalledRunIds, projectId: opts?.projectId });
    }
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

/** The repo id a project's runs carry — the SAME derivation the gate
 *  uses, over the normalized registered path. */
function projectRepoId(project: ProjectRef): string {
  return repoId(normalizeProjectPath(project.path));
}

/** Runs belonging to one project — matched by `projectRepoId`, so path
 *  handling stays in one place. */
export function runsForProject(project: ProjectRef, runs: RunRecord[]): RunRecord[] {
  const id = projectRepoId(project);
  return runs.filter((r) => r.repoId === id);
}

/** Runs whose repo matches NO registered project — membership depends
 *  only on repo ids, never on how many project rows a page displays. */
export function orphanRuns(projects: ProjectRef[], runs: RunRecord[]): RunRecord[] {
  const known = new Set(projects.map(projectRepoId));
  return runs.filter((r) => !known.has(r.repoId));
}

/** The registered project that OWNS a run (its `repoId` matches the project's
 *  derived repo id), resolved from whatever project context a run-detail render
 *  carries — the FULL list on the global hub, the SINGLE project on the project
 *  hub. Returns the project id, or undefined for an orphan run / no project in
 *  context. Deliberately a pure function of the RUN (not of which hub surfaced
 *  the link): the run-detail page cache is keyed by run id ALONE, so keying the
 *  turn deep-links off the run's own repo keeps the cached tree coherent for
 *  every viewer regardless of entry point. */
export function projectIdForRun(run: RunRecord, projects: ProjectRef[]): string | undefined {
  return projects.find((p) => projectRepoId(p) === run.repoId)?.id;
}

/**
 * Build the dashboard tree from a run list (newest first) plus the parked-run
 * details to inline. Pure — no IO. An empty list renders a call-to-action
 * pointing at `init_gate`; each parked run gets an inline triage section.
 * Rendered when the host provides NO project context (older host, or the
 * `perProject` flag removed) — behavior identical to the pre-perProject page.
 */
export function buildDashboard(
  runs: RunRecord[],
  details: RunDetail[] = [],
  stalledRunIds?: ReadonlySet<string>,
): HubPageTree {
  const page = new PageBuilder("ez-code-factory").markdownBlock(
    "Runs created by `git push gate <branch>`. Each push lands in the local " +
      "gate repo, whose post-receive hook triggers this extension to record a " +
      "run and materialize a disposable worktree.",
  );
  appendRunStats(page, runs, stalledRunIds);

  if (runs.length === 0) {
    page.emptyState("No gate runs yet", EMPTY_STATE_DETAIL);
    return page.build();
  }

  // No project context (older host / flag off): run rows deep-link to the
  // GLOBAL-hub detail variant.
  appendRunsSection(page, runs, details, globalRunHref, { stalledRunIds });
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
  stalledRunIds?: ReadonlySet<string>,
): HubPageTree {
  const own = runsForProject(project, runs);
  const page = new PageBuilder(`ez-code-factory — ${project.name}`);
  appendRunStats(page, own, stalledRunIds);

  if (own.length === 0) {
    page.emptyState("No gate runs for this project yet", EMPTY_STATE_DETAIL);
    return page.build();
  }

  // R1: this project's run rows carry a href to their detail on the SAME
  // project hub (project context preserved via the route prefix). The step-row
  // deep-links + inline triage carry the project id for their own hrefs.
  appendRunsSection(page, own, details, (runId) => projectRunHref(project.id, runId), {
    stalledRunIds,
    projectId: project.id,
  });
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
  stalledRunIds?: ReadonlySet<string>,
): HubPageTree {
  const page = new PageBuilder("ez-code-factory").markdownBlock(
    "Runs created by `git push gate <branch>`, grouped by project. Open a " +
      "project row for its dedicated dashboard; runs from repos outside any " +
      "registered project are triaged below.",
  );
  appendRunStats(page, runs, stalledRunIds);

  if (projects.length === 0 && runs.length === 0) {
    page.emptyState("No gate runs yet", EMPTY_STATE_DETAIL);
    return page.build();
  }

  if (projects.length > 0) {
    // One pass over runs, one hash per project — project rows read from
    // the index instead of rescanning the run list per project.
    const runsByRepo = new Map<string, RunRecord[]>();
    for (const r of runs) {
      const bucket = runsByRepo.get(r.repoId);
      if (bucket) bucket.push(r);
      else runsByRepo.set(r.repoId, [r]);
    }
    page.heading(2, "Projects");
    const shown = clampRows(page, projects, "projects");
    page.table(
      ["Project", "Runs", "Active", "Parked", "Last push"],
      shown.map((p) => {
        const own = runsByRepo.get(projectRepoId(p)) ?? [];
        // Effective status so a derived-stalled run isn't miscounted as Active.
        const active = own.filter((r) =>
          ACTIVE_STATUSES.has(effectiveRunStatus(r, stalledRunIds)),
        ).length;
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
  }

  // Orphan membership depends only on repo ids — NEVER on the display
  // clamp above — so a project past row 100 still owns its runs.
  const orphans = orphanRuns(projects, runs);
  if (orphans.length > 0) {
    page.heading(2, "Runs outside registered projects");
    // Orphans have no project to scope to — deep-link to the GLOBAL-hub detail.
    appendRunsSection(page, orphans, details, globalRunHref, { stalledRunIds });
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
