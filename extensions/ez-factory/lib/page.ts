// ── ez-factory Hub pages — pure builders ─────────────────────────────
//
// Two pages, both pure `record → tree` functions with no IO of their own:
//
//   `factory` — the console. `?view=` multiplexes three surfaces: the saved
//               jobs table (default), the shipped workflow templates, and
//               recent runs (each row deep-linking into core's run trace).
//   `job`     — one job's editor. ONE inline form, ONE Save.
//
// ── INVARIANT J · XSS SINK DISCIPLINE ───────────────────────────────
//
// **Every job- or run-derived string in this module lands ONLY in a
// host-escaped node type** — headings, section titles, stats, table cells,
// empty-state, link labels, form field labels and prefill values. NONE of
// them reaches `markdownBlock`, the Hub's sole `{@html}` node.
//
// The threat here is NOT raw script injection, and getting that wrong is how
// the rule gets relaxed by someone who checked. `markdown` IS
// DOMPurify-sanitized on render (`web/src/lib/components/hub/
// HubComponentRenderer.svelte` → `web/src/lib/markdown.ts`), so
// `<img onerror=…>` in a job name would be stripped. What survives DOMPurify
// is MARKDOWN ITSELF:
//
//   • `[Approve this run](https://evil.example)` in a job name renders as a
//     real, clickable link — link spoofing inside a trusted-looking console.
//   • `![](https://evil.example/beacon.png)` renders as an image the viewer's
//     browser fetches, turning a shared page render into a read receipt for
//     whoever planted the name.
//   • backticks, headings and bold let an operator-authored string
//     impersonate host UI chrome.
//
// So this is an AUTHORED discipline with a regression test, not a platform
// guarantee. Hub pages are XSS-safe *because* builders route untrusted text
// away from the sink. `lib/page.test.ts` pins it, and its negative is real:
// it asserts the probe IS carried somewhere before asserting every carrier is
// escaped, and asserts markdown nodes EXIST so "no markdown node carries the
// probe" cannot pass vacuously.
//
// The one markdown node each page emits is {@link CONSOLE_HELP} / the
// per-view help below — a module CONSTANT with no interpolation. If you ever
// need a template literal there, you have just moved a field into the sink.
//
// ── INVARIANT K · THE SHARED TREE CARRIES NO PRIVATE CONTENT ────────
//
// The page cache is keyed `(extensionId, pageId, variant)` with variant =
// projectId — NOT the viewer. One render is served to EVERY user with Hub
// access. Two consequences are load-bearing here:
//
//   1. **No user identity in the tree.** A job's `createdBy` / `updatedBy` /
//      `runAs.id` are stored and audited; they are never rendered. There is
//      no per-viewer filtering available at this layer, so "show the author"
//      would publish one user's id to everyone. The trail keeps it instead.
//   2. **No run content in the tree.** A run row carries its ids, status and
//      timestamps and DEEP-LINKS to `/workflows/runs/<id>`. Nothing produced
//      by a run — no step output, no artifact body, no agent turn — is
//      inlined. The link leaks nothing the tree does not already publish:
//      the route enforces its own authorization, so it opens only for a
//      viewer already entitled to it.
//
// The approvals inbox lives at core's `/workflows/approvals` for exactly this
// reason and is a LINK here, never a rendered list: `pendingApprovals()` is
// per-acting-user by construction and each entry names what is about to be
// done, so rendering it into the shared tree would hand one user's parked
// decisions to every viewer. Same for Fork — a session-only route producing a
// bare workflow name this extension could not then run.

import { PageBuilder } from "@ezcorp/sdk/runtime";
import type {
  HubPageTree,
  PageCellInput,
  PageFormFieldDescriptor,
  PageStatItem,
  PageTableRowInput,
} from "@ezcorp/sdk/runtime";

import {
  BACKGROUND_TRIGGER_KINDS,
  FACTORY_WORKFLOWS,
  JOB_SETTABLE_INPUT_KEYS,
  MAX_CRON_LEN,
  MAX_JOB_DESCRIPTION_LEN,
  MAX_JOB_NAME_LEN,
  MAX_JOB_RUNS_PER_DAY,
  MAX_JOB_TOKENS_PER_RUN,
  MAX_TIMEZONE_LEN,
  isBackgroundTrigger,
  isValidJobId,
  type FactoryJob,
  type FactoryWorkflow,
  type JobRunRecord,
  type JobTrigger,
} from "./jobs";

export const EXTENSION_NAME = "ez-factory";

/** Manifest page ids. Must match `ezcorp.config.ts` `pages[].id`. */
export const FACTORY_PAGE_ID = "factory";
export const JOB_PAGE_ID = "job";

/** Hub-addressable page ids (`ext:<extension>:<page>`), as `parseHubPageId`
 *  expects them in a route. */
export const FACTORY_FULL_PAGE_ID = `ext:${EXTENSION_NAME}:${FACTORY_PAGE_ID}`;
export const JOB_FULL_PAGE_ID = `ext:${EXTENSION_NAME}:${JOB_PAGE_ID}`;

/**
 * The page actions this console dispatches.
 *
 * Each must be declared in `permissions.eventSubscriptions` or it does not
 * exist: `validatePageTree` DROPS any button/form/row whose event is outside
 * the granted list (`allowedEvents`, from the runtime grant), and the events
 * route 404s an unregistered event. A form node with an ungranted action is
 * not rendered read-only — it is deleted from the tree, silently. Adding a
 * name here means adding it to the MANIFEST, the `bundled.ts` install grant
 * AND the `bundled-ceiling.ts` row — `intersectPermissions` drops whatever
 * any two of the three disagree on.
 *
 * TWO, and the second one was the whole point of the console.
 *
 * `job-save` writes a job. `job-run` FIRES one, and until it existed a saved
 * job was a note to self: the console could describe work it had no way to
 * start, so `recordRun` / `touchJob` had no callers outside their own tests
 * and the Recent-runs tab read "No runs recorded" after eight real runs.
 *
 * `job-run` buys no new authority. It dispatches `ctx.workflows.run()`,
 * whose 13-rung host ladder — including core's shared `canRunWorkflow` —
 * decides everything, attributed to the CLICKING user via the host-issued
 * provenance token on the fire. It is a button on a path that already
 * existed, not a new path.
 */
export const JOB_SAVE_EVENT = `${EXTENSION_NAME}:job-save`;
export const JOB_RUN_EVENT = `${EXTENSION_NAME}:job-run`;

/** Every event this console can dispatch, for the manifest-parity test. */
export const PAGE_EVENTS: readonly string[] = [JOB_SAVE_EVENT, JOB_RUN_EVENT];

/** Core's approvals inbox — where a parked gate is answered. A LINK, never a
 *  rendered list (invariant K; see the module header). */
export const APPROVALS_HREF = "/workflows/approvals";

/** Core's workflow index — where a template is inspected, forked or run by
 *  hand. Fork is session-only and yields a bare name this extension cannot
 *  address, so it is a link out rather than an action. */
export const WORKFLOWS_HREF = "/workflows";

/** Deep link into core's run trace for one workflow run. */
export function runTraceHref(workflowRunId: string): string {
  return `/workflows/runs/${encodeURIComponent(workflowRunId)}`;
}

/** Core's delegation surface — the ONE place standing, unattended authority
 *  is minted. A link, and it could not be anything else: this extension has
 *  no way to write a delegation and must not have one. */
export const DELEGATIONS_HREF = "/workflows/delegations";

/**
 * The trigger kinds a delegation can be granted for.
 *
 * `manual` is absent because a manual run is started by a human the host
 * has already authorized — it spends no standing authority, so offering to
 * delegate it would be offering a grant nothing will ever use. `workflow`
 * (fire on another workflow's status) is absent because core's consent
 * surface does not offer it; a link naming it would be refused there, and a
 * link this builder KNOWS would be refused is a link it should not emit.
 */
export const DELEGATABLE_TRIGGER_KINDS: ReadonlySet<string> = new Set([
  "cron",
  "webhook",
  "event",
]);

/**
 * The deep link that hands ONE job to core's consent surface — or `null`
 * when this job needs no delegation.
 *
 * ## Why this exists
 *
 * A delegation row binds `(extension_id, job_ref)`, and until this link
 * existed the only way to create one was to read a job's id off this
 * console and retype it into a free-text box on another page. A single
 * mistyped character produces `DELEGATION_NOT_FOUND` at the first cron
 * tick — audited without a `delegation_id`, and core's own delegations page
 * states plainly that it cannot surface that denial. So the typo's entire
 * feedback is an unattended job that silently never runs.
 *
 * ## What this link is, and what it is NOT
 *
 * It carries NO authority. It is four query parameters that core's page
 * matches against lists it loaded itself: the extension must be one an
 * administrator granted `allowDelegated`, and the workflow must be one the
 * viewer can already see. Whatever survives that is shown to the person,
 * who then opens a review dialog, types two spend bounds that have no
 * default and no unlimited value, and presses Approve. A URL alone cannot
 * make a delegation exist, and this link is deliberately not the shortest
 * possible path to one.
 *
 * `extensionId` carries this extension's NAME. A Hub page render is not
 * told the install row's id — pages are addressed `ext:<name>:<page>` —
 * and core resolves the parameter by id OR name for exactly that reason.
 *
 * The workflow name is PREFIXED (`ez-factory:docs-factory`): a job stores a
 * bare template name, and the host prefixes it before resolving, so the
 * bare form names nothing core could match.
 *
 * Mirrors the query contract documented on `GRANT_PARAMS` in
 * `web/src/lib/workflow-delegations-logic.ts`. The two ends are bound by
 * `src/__tests__/delegation-consent-handoff.test.ts`, which feeds this
 * builder's output into core's resolver.
 */
export function delegationConsentHref(job: FactoryJob): string | null {
  if (!DELEGATABLE_TRIGGER_KINDS.has(job.trigger.kind)) return null;
  const q = [
    `extensionId=${encodeURIComponent(EXTENSION_NAME)}`,
    `jobRef=${encodeURIComponent(job.id)}`,
    `workflowName=${encodeURIComponent(`${EXTENSION_NAME}:${job.workflow}`)}`,
    `triggerKind=${encodeURIComponent(job.trigger.kind)}`,
  ].join("&");
  return `${DELEGATIONS_HREF}?${q}`;
}

// ── `?view=` parsing ────────────────────────────────────────────────

/** The `factory` page's parsed `?view=`. Absent → the jobs table. */
export type FactoryView =
  | { kind: "jobs" }
  | { kind: "templates" }
  | { kind: "runs" }
  | { kind: "unknown" };

/** Parse the `factory` page's raw `?view=`. An unknown value maps to
 *  `unknown` → an honest empty-state, never a throw. */
export function parseFactoryView(view?: string): FactoryView {
  if (view === undefined || view === "" || view === "jobs") return { kind: "jobs" };
  if (view === "templates") return { kind: "templates" };
  if (view === "runs") return { kind: "runs" };
  return { kind: "unknown" };
}

/** The `job` page's parsed `?view=`. Absent → the create form. */
export type JobView = { kind: "new" } | { kind: "edit"; jobId: string } | { kind: "unknown" };

const JOB_VIEW_PREFIX = "job:";

/**
 * Parse the `job` page's raw `?view=`. `job:<id>` opens an existing job;
 * absent (or `new`) opens the create form.
 *
 * The id is validated with the store's own {@link isValidJobId} rather than
 * "non-empty", because it is spliced into a storage key downstream. Rejecting
 * here means the handler never sees a shape the store would have to defend
 * against a second time.
 */
export function parseJobView(view?: string): JobView {
  if (view === undefined || view === "" || view === "new") return { kind: "new" };
  if (!view.startsWith(JOB_VIEW_PREFIX)) return { kind: "unknown" };
  const jobId = view.slice(JOB_VIEW_PREFIX.length).trim();
  return isValidJobId(jobId) ? { kind: "edit", jobId } : { kind: "unknown" };
}

/** The `?view=` value that opens a given job in the editor. */
export function jobViewValue(jobId: string): string {
  return `${JOB_VIEW_PREFIX}${jobId}`;
}

// ── Hrefs ───────────────────────────────────────────────────────────

/**
 * A link to one of this extension's own pages, project-scoped when the render
 * has a project. Every segment and the view value are `encodeURIComponent`d,
 * so the result carries no `/` or `\` beyond the ones written here — the host
 * re-checks with `isSafeInternalHref` on ingest.
 */
export function hubHref(fullPageId: string, projectId?: string, view?: string): string {
  const base = projectId
    ? `/project/${encodeURIComponent(projectId)}/hub/${encodeURIComponent(fullPageId)}`
    : `/hub/${encodeURIComponent(fullPageId)}`;
  return view === undefined ? base : `${base}?view=${encodeURIComponent(view)}`;
}

// ── Display helpers (pure, all output escaped-node-bound) ────────────

/**
 * Tone per run status.
 *
 * **Keyed on core's RUN vocabulary**, which is the six values in
 * `RUN_STATUS_FILTERS` (`src/runtime/workflow-run-trace.ts`): `running`,
 * `success`, `error`, `cancelled`, `awaiting_approval`, `suspended`.
 *
 * It used to be keyed on `completed` / `failed` / `aborted` — the AGENT
 * run vocabulary, which a `workflow_runs` row never uses. The effect was
 * silent and total: the three statuses this table actually receives most
 * often (`success`, `error`, `cancelled`) matched nothing and rendered
 * neutral, so a failed run looked exactly like a successful one. Caught by
 * firing a real job and reading the cell the console produced.
 *
 * Core's `workflow_runs.status` is still an open string at this boundary,
 * so an unrecognised value renders verbatim and neutral rather than being
 * dropped — an honest "I do not know this status" beats a blank cell.
 * `running` is deliberately absent: in progress is not a verdict, and
 * toning it would make a live run read as an outcome.
 */
const RUN_STATUS_TONE: Record<string, "success" | "danger" | "warning"> = {
  success: "success",
  error: "danger",
  cancelled: "danger",
  awaiting_approval: "warning",
  suspended: "warning",
};

/** The Status cell for a run. A neutral status returns a BARE string (the host
 *  folds a `neutral` object to one anyway; emitting the string keeps the
 *  builder's own output minimal). */
export function runStatusCell(status: string): PageCellInput {
  const tone = RUN_STATUS_TONE[status];
  return tone === undefined ? status : { text: status, tone };
}

/** Enabled/disabled cell with tone. */
export function enabledCell(enabled: boolean): PageCellInput {
  return enabled ? { text: "✓ enabled", tone: "success" } : "○ disabled";
}

/** `2026-08-01 14:22` from an ISO instant; the raw string when it does not
 *  parse (never a throw, never a silent blank). */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * One-line label for a job trigger.
 *
 * The console creates `manual`, `cron` and `webhook`; `event` / `workflow`
 * are labelled anyway so a job written by a later version still renders
 * rather than showing a blank cell.
 *
 * A BACKGROUND trigger always renders its bounds. They are the only thing
 * standing between a saved cron and unattended spend, so they belong on the
 * row an operator scans — not one click in. Both are numbers this console
 * validated into a small range, so neither is operator-authored free text
 * in the XSS sense (invariant J), and both land in a table cell regardless.
 */
export function triggerLabel(trigger: JobTrigger): string {
  switch (trigger.kind) {
    case "manual":
      return "manual";
    case "cron":
      return `cron · ${trigger.cron} · ${trigger.timezone} · ${boundsLabel(trigger)}`;
    case "webhook":
      return `webhook · ${boundsLabel(trigger)}`;
    case "event":
      return `event · ${trigger.event}`;
    case "workflow":
      return `workflow · ${trigger.onWorkflow} · ${trigger.onStatus.join(",")}`;
  }
}

/** The `≤N/day · ≤N tok/run` half of a background trigger's label. */
function boundsLabel(bounds: { maxRunsPerDay: number; maxTokensPerRun: number }): string {
  return `≤${bounds.maxRunsPerDay}/day · ≤${bounds.maxTokensPerRun} tok/run`;
}

/**
 * The one-line reminder that a background job is SAVED but not ARMED.
 *
 * Saving a cron job mints no authority: firing needs a
 * `workflow_delegations` row, which only a human can create through core's
 * session-only consent route. Without this line the console would show a
 * job whose Trigger column reads "cron · 0 3 * * *" and which never runs,
 * and the operator's only clue would be its absence from Recent runs.
 *
 * A module CONSTANT, not a template literal — it renders through an
 * escaped node, and interpolating a job field here would put one in reach
 * of the sink (invariant J).
 */
export const BACKGROUND_TRIGGER_NOTE =
  "Saved, not yet armed — a background trigger fires only after someone authorizes it in the workflow UI. Until then this job runs when Run is pressed.";

/**
 * A job `input` value rendered for a table cell or a form prefill.
 *
 * Bounded on the way out: the host truncates a cell at 300 chars and clamps a
 * form field's prefill to its `maxLength`, but the 64 KB tree-envelope check
 * runs on the RAW input FIRST — a job carrying the store's full
 * `MAX_JOB_INPUT_CHARS` in one field, passed whole, would reject the ENTIRE
 * tree rather than truncate one cell. So the builder pre-truncates.
 *
 * An object/array value is serialized; the store allows nested input, and a
 * `[object Object]` cell is a bug report waiting to happen.
 */
export const INPUT_EXCERPT_CHARS = 280;

export function inputValueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      return "[unserializable]";
    }
  }
  if (text.length <= INPUT_EXCERPT_CHARS) return text;
  return `${text.slice(0, INPUT_EXCERPT_CHARS - 24).trimEnd()} …[${text.length} chars]`;
}

/** The job's inputs as one compact `k=v · k=v` cell. Values are excerpted by
 *  {@link inputValueText}; the whole cell is a table cell, never markdown. */
export function inputSummary(job: FactoryJob): string {
  const parts = Object.entries(job.input).map(
    ([key, value]) => `${key}=${inputValueText(value)}`,
  );
  return parts.length === 0 ? "—" : parts.join(" · ");
}

// ── Static help — the ONLY markdown nodes in this module ─────────────
//
// Module constants, never interpolated. See invariant J in the header: the
// moment one of these becomes a template literal, a field has entered the
// `{@html}` sink.

export const CONSOLE_HELP =
  "Jobs are **install-wide**: everyone with access to this Hub sees, edits, and can run the same list. " +
  "A job names one of the shipped workflow templates and the inputs to run it with. " +
  "Open a job to run it; answering any approval gate it parks on happens in the workflow UI.";

export const TEMPLATES_HELP =
  "These three workflows ship with the extension. They are **assets, not code you can edit here** — " +
  "open one in the workflow UI to read its steps, or fork it there to make your own.";

export const RUNS_HELP =
  "The most recent runs started from a job on this install, refreshed each time this view is opened. " +
  "Each row opens that run's full trace — step outputs and artifacts live there, never on this shared page.";

export const TRIGGER_HELP =
  "**Manual** jobs run when someone presses Run. **Cron** and **webhook** jobs run with nobody watching, " +
  "so they need two limits you choose yourself — there is no default and no unlimited. " +
  "Saving a schedule does not start anything: a background job stays inert until a person authorizes it in the workflow UI.";

// ── Templates ───────────────────────────────────────────────────────

/** One shipped template, as the templates view describes it. Static, authored
 *  copy — nothing here is operator-derived. */
export interface TemplateBlurb {
  workflow: FactoryWorkflow;
  summary: string;
}

export const TEMPLATE_BLURBS: readonly TemplateBlurb[] = [
  {
    workflow: "docs-factory",
    summary:
      "Read source files, draft documentation, review it in a loop until accepted, then write the accepted doc.",
  },
  {
    workflow: "etl-factory",
    summary:
      "Read a set of files, extract and normalise them into one structured artifact, gated on the extraction being clean.",
  },
  {
    workflow: "draft-and-verify",
    summary:
      "Verify one draft against its sources and return a verdict. Also used as docs-factory's review sub-workflow.",
  },
];

// ── The `factory` page ──────────────────────────────────────────────

/** Everything the `factory` page renders. */
export interface FactoryPageInput {
  view: FactoryView;
  jobs: readonly FactoryJob[];
  /** Recent runs across every job, newest first — the store's fast index over
   *  core's `workflow_runs`, not the record. */
  runs: readonly JobRunRecord[];
  /** Present on the project hub; scopes this page's own hrefs. */
  projectId?: string;
}

/** Nav strip into the page's sibling views and out to core's surfaces. */
function appendNav(page: PageBuilder, projectId: string | undefined): void {
  page.link("Jobs", hubHref(FACTORY_FULL_PAGE_ID, projectId));
  page.link("Templates", hubHref(FACTORY_FULL_PAGE_ID, projectId, "templates"));
  page.link("Recent runs", hubHref(FACTORY_FULL_PAGE_ID, projectId, "runs"));
  page.link("New job", hubHref(JOB_FULL_PAGE_ID, projectId));
  // Out to core. Both are links BY DESIGN — see invariant K in the header.
  page.link("Approvals inbox", APPROVALS_HREF);
  page.link("Workflows", WORKFLOWS_HREF);
}

function appendJobsView(page: PageBuilder, input: FactoryPageInput): void {
  const { jobs, runs, projectId } = input;
  page.markdownBlock(CONSOLE_HELP);
  page.stats([
    { label: "Jobs", value: String(jobs.length) },
    { label: "Enabled", value: String(jobs.filter((j) => j.enabled).length) },
    { label: "Runs recorded", value: String(runs.length) },
  ]);

  if (jobs.length === 0) {
    page.emptyState(
      "No jobs yet",
      "Create one to pair a shipped workflow template with the inputs you want to run it with.",
    );
    return;
  }

  const lastRun = new Map<string, JobRunRecord>();
  for (const run of runs) {
    if (!lastRun.has(run.jobId)) lastRun.set(run.jobId, run);
  }

  page.table(
    ["Job", "Workflow", "Trigger", "Inputs", "State", "Last run"],
    jobs.map((job): PageTableRowInput => {
      const recent = lastRun.get(job.id);
      return {
        cells: [
          job.name,
          job.workflow,
          triggerLabel(job.trigger),
          inputSummary(job),
          enabledCell(job.enabled),
          recent ? `${shortTime(recent.startedAt)} · ${recent.status}` : shortTime(job.lastRunAt),
        ],
        href: hubHref(JOB_FULL_PAGE_ID, projectId, jobViewValue(job.id)),
      };
    }),
  );
}

function appendTemplatesView(page: PageBuilder, projectId: string | undefined): void {
  page.markdownBlock(TEMPLATES_HELP);
  page.table(
    ["Template", "What it does", "Job-settable inputs"],
    TEMPLATE_BLURBS.map((blurb): PageTableRowInput => ({
      cells: [
        blurb.workflow,
        blurb.summary,
        JOB_SETTABLE_INPUT_KEYS[blurb.workflow].join(", "),
      ],
      href: `${WORKFLOWS_HREF}/${encodeURIComponent(`${EXTENSION_NAME}:${blurb.workflow}`)}`,
    })),
  );
  page.link("New job", hubHref(JOB_FULL_PAGE_ID, projectId));
}

function appendRunsView(page: PageBuilder, input: FactoryPageInput): void {
  const { jobs, runs } = input;
  page.markdownBlock(RUNS_HELP);

  if (runs.length === 0) {
    page.emptyState(
      "No runs recorded",
      "Open a job and press Run now. Its run appears here as soon as this view refreshes.",
    );
    return;
  }

  const jobName = new Map(jobs.map((job) => [job.id, job.name]));
  page.table(
    ["Job", "Workflow", "Status", "Started", "Finished", "Resumable"],
    runs.map((run): PageTableRowInput => ({
      cells: [
        // A run whose job has since been deleted still has a trace worth
        // opening — name it by id rather than dropping the row.
        jobName.get(run.jobId) ?? run.jobId,
        run.workflowName,
        runStatusCell(run.status),
        shortTime(run.startedAt),
        shortTime(run.finishedAt),
        run.resumable ? "yes" : "no",
      ],
      // The deep link is the ONLY way a run's content is reachable from this
      // page — nothing it produced is inlined (invariant K).
      href: runTraceHref(run.workflowRunId),
    })),
  );
}

/** Build the `factory` console page. Pure. */
export function buildFactoryPage(input: FactoryPageInput): HubPageTree {
  const page = new PageBuilder("ez-factory");
  appendNav(page, input.projectId);

  switch (input.view.kind) {
    case "jobs":
      page.section("Jobs", (section) => appendJobsView(section, input));
      break;
    case "templates":
      page.section("Shipped templates", (section) =>
        appendTemplatesView(section, input.projectId),
      );
      break;
    case "runs":
      page.section("Recent runs", (section) => appendRunsView(section, input));
      break;
    case "unknown":
      page.emptyState(
        "Unknown view",
        "That link points at a console view this version does not have. Pick one above.",
      );
      break;
  }

  return page.build();
}

// ── The `job` page ──────────────────────────────────────────────────

/** Form field ids. Slugs (`/^[a-z0-9][a-z0-9_]{0,31}$/`) — a non-slug field is
 *  DROPPED host-side with no fall-back, so these are not free-form.
 *
 *  The five `trigger*` ids are phase 9: until then the console could not
 *  express a background trigger AT ALL — `draftFromFormPayload` hardcoded
 *  `{kind: "manual"}` — so a cron job was unreachable from the UI even
 *  after the store learned to accept one. All five are lowercase-only by
 *  the same rule that forced `input_outpath`: `trigger_maxRunsPerDay`
 *  would be dropped host-side with nothing logged, and the operator's
 *  typed value would simply never arrive. */
export const JOB_FORM_FIELDS = {
  jobId: "job_id",
  name: "name",
  description: "description",
  workflow: "workflow",
  enabled: "enabled",
  triggerKind: "trigger_kind",
  triggerCron: "trigger_cron",
  triggerTimezone: "trigger_timezone",
  triggerRunsPerDay: "trigger_runs_per_day",
  triggerTokensPerRun: "trigger_tokens_per_run",
} as const;

/**
 * The trigger kinds the console OFFERS.
 *
 * A strict subset of {@link JobTrigger}'s union: `event` and `workflow` are
 * modelled by the store for round-tripping and dispatched by nothing, so
 * offering them would build a job that saves and never fires. The validator
 * refuses them independently — this list is the UI agreeing with it rather
 * than a second rule.
 */
export const OFFERED_TRIGGER_KINDS = ["manual", "cron", "webhook"] as const;

export type OfferedTriggerKind = (typeof OFFERED_TRIGGER_KINDS)[number];

/** The two kinds whose bound fields are shown. Mirrors the store's
 *  {@link BACKGROUND_TRIGGER_KINDS}; pinned equal by a test. */
const BACKGROUND_KINDS: readonly string[] = [...BACKGROUND_TRIGGER_KINDS];

/** Labels for the trigger select. Authored copy, never operator data. */
const TRIGGER_KIND_LABELS: Record<OfferedTriggerKind, string> = {
  manual: "Manual — someone presses Run",
  cron: "Cron — on a schedule",
  webhook: "Webhook — when something calls in",
};

/** The `enabled` select's two values. A select constrains the UI, never the
 *  wire — the handler still validates whatever arrives. */
export const ENABLED_YES = "yes";
export const ENABLED_NO = "no";

/**
 * The union of every workflow's job-settable input keys, in a stable order.
 *
 * The form declares ALL of them and hides the irrelevant ones with
 * `visibleWhen` on the `workflow` select. That is not a cosmetic choice: a
 * hidden field is OMITTED from the submitted payload, so selecting
 * `draft-and-verify` cannot submit a `globs` the store would reject as
 * outside that workflow's allowlist. The allowlist stays the authority — this
 * makes the UI agree with it instead of fighting it.
 */
export const ALL_INPUT_KEYS: readonly string[] = [
  ...new Set(FACTORY_WORKFLOWS.flatMap((w) => JOB_SETTABLE_INPUT_KEYS[w])),
];

/**
 * Per-input form field id (`input_globs`, `input_outpath`, …).
 *
 * **LOWERCASED, and that is not cosmetic.** A form field id must match
 * `/^[a-z0-9][a-z0-9_]{0,31}$/` or the host DROPS the field — with no
 * fall-back, unlike a prompt, and with nothing logged. The store's input keys
 * are camelCase (`outPath`), so a naive `input_${key}` produces `input_outPath`
 * and that field silently does not exist: the editor renders, the operator
 * types an output path, and the value never reaches the payload.
 */
export function inputFieldId(key: string): string {
  return `input_${key.toLowerCase()}`;
}

/**
 * The input key an `input_*` form field carries, or `null` for anything else.
 *
 * A LOOKUP over the allowlist union rather than string surgery, because
 * {@link inputFieldId} is lossy — `input_outpath` cannot be un-lowercased by
 * inspection. Building the reverse map from {@link ALL_INPUT_KEYS} also makes
 * it fail closed twice over: a field naming a key no workflow allows resolves
 * to `null` and is ignored, so only keys the store would accept can arrive at
 * all.
 */
const FIELD_TO_INPUT_KEY: ReadonlyMap<string, string> = new Map(
  ALL_INPUT_KEYS.map((key) => [inputFieldId(key), key]),
);

export function inputKeyOfField(field: string): string | null {
  return FIELD_TO_INPUT_KEY.get(field) ?? null;
}

/** Which workflows may set `key` — the `visibleWhen.equals` list for its
 *  field. */
export function workflowsAccepting(key: string): FactoryWorkflow[] {
  return FACTORY_WORKFLOWS.filter((w) => JOB_SETTABLE_INPUT_KEYS[w].includes(key));
}

/** Human labels for the input keys the templates actually declare. An
 *  unlabelled key falls back to its own name rather than vanishing. */
const INPUT_LABELS: Record<string, string> = {
  globs: "Source globs (one per line)",
  outPath: "Output path",
  draft: "Draft to verify",
  sources: "Sources to verify against",
};

/**
 * Which input fields render as a TEXTAREA rather than a single line.
 *
 * An allowlist, not a blanket `multiline: true`. Every input field used to
 * get a textarea, which made "Output path" — a single filesystem path,
 * where a newline is never correct — a three-row box that invited one.
 * The three listed here genuinely hold multi-line values: `globs` is
 * newline-separated by contract (the tool's own schema says so), and
 * `draft` / `sources` are documents.
 *
 * A key absent from this set gets a single-line input, which is also the
 * right default for any key added later without thinking about it.
 */
export const MULTILINE_INPUT_KEYS: ReadonlySet<string> = new Set([
  "globs",
  "draft",
  "sources",
]);

/** Everything the `job` page renders. */
export interface JobPageInput {
  view: JobView;
  /** The job being edited — `null` for a create, or for an id that no longer
   *  resolves. */
  job: FactoryJob | null;
  projectId?: string;
}

/**
 * The editor's fields, in render order.
 *
 * `job_id` is a hidden-ish carrier: on an edit it prefills the job's id so the
 * one Save handler knows which job to write, and on a create it is absent
 * entirely. It is NOT a trust boundary — the handler re-validates the id and
 * re-reads the job under its own lock; this only saves a second round trip.
 */
export function jobFormFields(job: FactoryJob | null): PageFormFieldDescriptor[] {
  const fields: PageFormFieldDescriptor[] = [];

  fields.push({
    field: JOB_FORM_FIELDS.name,
    label: "Name",
    maxLength: MAX_JOB_NAME_LEN,
    placeholder: "Nightly API docs",
    ...(job ? { value: job.name } : {}),
  });
  fields.push({
    field: JOB_FORM_FIELDS.description,
    label: "Description",
    multiline: true,
    // The store's cap is 500 and the host clamps a field hint to [1,500], so
    // these agree exactly — a larger hint would be silently clamped and the
    // form would accept less than the store does.
    maxLength: MAX_JOB_DESCRIPTION_LEN,
    ...(job ? { value: job.description } : {}),
  });
  fields.push({
    field: JOB_FORM_FIELDS.workflow,
    label: "Workflow",
    options: FACTORY_WORKFLOWS.map((w) => ({ value: w, label: w })),
    ...(job ? { value: job.workflow } : {}),
  });
  fields.push({
    field: JOB_FORM_FIELDS.enabled,
    label: "Enabled",
    options: [
      { value: ENABLED_YES, label: "Enabled" },
      { value: ENABLED_NO, label: "Disabled" },
    ],
    value: job === null || job.enabled ? ENABLED_YES : ENABLED_NO,
  });

  for (const key of ALL_INPUT_KEYS) {
    const accepting = workflowsAccepting(key);
    const raw = job?.input[key];
    fields.push({
      field: inputFieldId(key),
      label: INPUT_LABELS[key] ?? key,
      // Textarea only where the value is genuinely multi-line — see
      // {@link MULTILINE_INPUT_KEYS}.
      ...(MULTILINE_INPUT_KEYS.has(key) ? { multiline: true } : {}),
      // Shown only while `workflow` names a workflow whose allowlist carries
      // this key — and a hidden field is omitted from the payload, so the UI
      // cannot submit an out-of-allowlist input.
      visibleWhen: { field: JOB_FORM_FIELDS.workflow, equals: accepting },
      ...(raw === undefined ? {} : { value: inputValueText(raw) }),
    });
  }

  return fields;
}

/**
 * The TRIGGER editor's fields — a SECOND form, and the reason it is second
 * is a hard host bound rather than taste.
 *
 * `validateFormNode` caps a form at `MAX_FORM_FIELDS` = 10
 * (`src/extensions/page-schema.ts`) and DROPS the excess silently. Worse,
 * `pruneDanglingConditions` then deletes `visibleWhen` from any survivor
 * whose condition names a dropped field — so an 11-field form does not just
 * lose its last field, it also un-hides the ones that depended on it. The
 * job editor already declares 8 (name, description, workflow, enabled, and
 * the four input keys), and an honest background trigger needs 5. Putting
 * them on one form would have silently deleted two input fields and then
 * shown every remaining input on every workflow.
 *
 * Both forms dispatch the SAME granted `ez-factory:job-save` event. That is
 * deliberate: a third page action would be a real grant widening across
 * three files (manifest, install grant, ceiling) to buy a split the payload
 * can already express. The submissions are told apart by
 * {@link EDIT_SCOPE_FIELD} on the ACTION payload — server-rendered, and NOT
 * a trust boundary: the handler re-reads the job and re-runs the one
 * validator over a COMPLETE draft either way, exactly as `handleJobRun`
 * already does before it spends anything.
 *
 * Rendered only for a job that EXISTS. A job is created attended and
 * scheduled afterwards, which matches what actually has to happen: a
 * background trigger is inert until a human consents to a delegation for
 * it, and there is nothing to consent to until the job has an id.
 */
export function triggerFormFields(job: FactoryJob): PageFormFieldDescriptor[] {
  const trigger = job.trigger;
  const bg = isBackgroundTrigger(trigger) ? trigger : null;
  return [
    {
      field: JOB_FORM_FIELDS.triggerKind,
      label: "Fires",
      options: OFFERED_TRIGGER_KINDS.map((kind) => ({
        value: kind,
        label: TRIGGER_KIND_LABELS[kind],
      })),
      // A job written by some later version as `event` / `workflow` has no
      // option to select, so the select shows `manual` rather than
      // rendering with no match — and the stat strip above the form still
      // reports the honest current trigger. Saving this form would move it
      // to `manual`, which is the safe direction: it un-schedules.
      value: (OFFERED_TRIGGER_KINDS as readonly string[]).includes(trigger.kind)
        ? trigger.kind
        : "manual",
    },
    {
      field: JOB_FORM_FIELDS.triggerCron,
      label: "Cron expression — 5 fields: min hour dom month dow",
      maxLength: MAX_CRON_LEN,
      placeholder: "0 3 * * *",
      // `visibleWhen` is load-bearing, not cosmetic: a HIDDEN FIELD IS
      // OMITTED FROM THE PAYLOAD, so switching back to `manual` cannot
      // resubmit a stale cron, and the two bound fields cannot arrive on a
      // manual job at all. The store's rule — a background trigger carries
      // bounds, an attended one carries none — is expressed by the form
      // rather than fought by it.
      visibleWhen: { field: JOB_FORM_FIELDS.triggerKind, equals: ["cron"] },
      ...(bg?.kind === "cron" ? { value: bg.cron } : {}),
    },
    {
      field: JOB_FORM_FIELDS.triggerTimezone,
      label: "Time zone — an IANA name",
      maxLength: MAX_TIMEZONE_LEN,
      placeholder: "America/New_York",
      visibleWhen: { field: JOB_FORM_FIELDS.triggerKind, equals: ["cron"] },
      ...(bg?.kind === "cron" ? { value: bg.timezone } : {}),
    },
    {
      // NOT PREFILLED on a job that has no bounds yet, deliberately. These
      // two are the blast-radius bound on unattended spend, and core's own
      // consent route refuses to default them for the same reason: a
      // default is a number nobody chose, and an "unlimited" option is the
      // number everybody chooses. The placeholder states the legal range so
      // an empty box is a question rather than a puzzle.
      field: JOB_FORM_FIELDS.triggerRunsPerDay,
      label: "Most runs per day",
      placeholder: `1-${MAX_JOB_RUNS_PER_DAY}`,
      visibleWhen: { field: JOB_FORM_FIELDS.triggerKind, equals: [...BACKGROUND_KINDS] },
      ...(bg ? { value: String(bg.maxRunsPerDay) } : {}),
    },
    {
      field: JOB_FORM_FIELDS.triggerTokensPerRun,
      label: "Most tokens per run",
      placeholder: `1-${MAX_JOB_TOKENS_PER_RUN}`,
      visibleWhen: { field: JOB_FORM_FIELDS.triggerKind, equals: [...BACKGROUND_KINDS] },
      ...(bg ? { value: String(bg.maxTokensPerRun) } : {}),
    },
  ];
}

/**
 * The inverse of {@link jobFormFields}: fold a submitted page-action payload
 * back into the shape {@link validateJobDraft} validates.
 *
 * PURE, and deliberately NOT a validator. It reads the fields it knows, in
 * their declared types, and ignores everything else; every semantic rule —
 * which workflow names exist, which input keys that workflow allows, how long
 * a name may be — stays in the store's one validator. Two checkers of the same
 * rule is how the two drift.
 *
 * What the shape of the wire forces:
 *   - Every submitted value is a STRING (the host's form node collects
 *     scalars), so `enabled` arrives as `"yes"`/`"no"` and is mapped here.
 *     Anything other than {@link ENABLED_NO} is `true`, matching the store's
 *     own `enabled !== false` default — an absent or garbled select cannot
 *     silently disable a job.
 *   - `workflow` is passed through UNTOUCHED even when it is not a known
 *     workflow. A select constrains the UI, never the wire; letting the
 *     store reject it produces the real error message instead of this
 *     function inventing one.
 *   - An EMPTY input value is OMITTED rather than stored as `""`. A blank
 *     optional field means "unset", and an empty string is a value the
 *     template would go on to interpolate.
 *   - A hidden field never arrives at all (the host omits it), which is what
 *     makes the `visibleWhen` wiring agree with the per-workflow allowlist
 *     rather than fight it.
 */
export interface SubmittedJobForm {
  /** The job to write, from the action payload — `null` for a create. */
  jobId: string | null;
  /** Which of the job page's two forms this came from. See
   *  {@link EDIT_SCOPE_FIELD}. */
  scope: JobEditScope;
  /** Candidate draft, for {@link validateJobDraft}. Deliberately `unknown`:
   *  nothing here has been validated yet. */
  draft: Record<string, unknown>;
}

/**
 * Which of the job page's two forms a submission came from.
 *
 * `"job"` — the editor: name, description, workflow, enabled, inputs.
 * `"trigger"` — the schedule: kind, cron, timezone, and the two bounds.
 */
export type JobEditScope = "job" | "trigger";

/**
 * The ACTION-payload key that says which form submitted.
 *
 * Deliberately NOT a form field id, and deliberately not a value an
 * operator types — the same reasoning `job_id` rides the action payload
 * under. It is also NOT a trust boundary: a forged value can only make a
 * save be read as the other scope, and BOTH scopes re-read the stored job
 * and re-run the one validator over a complete draft. Nothing is reachable
 * that way that a person with Hub access cannot already do by opening the
 * other form — jobs are install-wide and editable by every viewer, which
 * the console says out loud.
 */
export const EDIT_SCOPE_FIELD = "edit_scope";
export const EDIT_SCOPE_TRIGGER: JobEditScope = "trigger";
export const EDIT_SCOPE_JOB: JobEditScope = "job";

/** The scope a page-action payload declares. Anything unrecognised reads as
 *  `"job"`, the scope that carries every field and therefore cannot be used
 *  to skip a check by omission. */
export function editScopeFromActionPayload(payload: unknown): JobEditScope {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return EDIT_SCOPE_JOB;
  }
  return (payload as Record<string, unknown>)[EDIT_SCOPE_FIELD] === EDIT_SCOPE_TRIGGER
    ? EDIT_SCOPE_TRIGGER
    : EDIT_SCOPE_JOB;
}

/**
 * The job id a page-action payload carries, or `null`.
 *
 * **The single reader of that key, and that is the point.** Both actions
 * put the id on the ACTION PAYLOAD under {@link JOB_FORM_FIELDS.jobId} —
 * `job_id`, the slug the host's field-id regex forces — and a second
 * reader that guessed `jobId` would return `null` for every real payload.
 * The failure is silent by construction: `handleJobRun` would refuse
 * every click with "no valid job id", the Hub would still answer
 * `{ok:true}`, and the button would look like it did nothing. That is
 * exactly what happened before this function existed, and it took a real
 * server to see it.
 *
 * Attacker-reachable: it never throws and never yields a string that
 * could escape its storage key ({@link isValidJobId} enforces the same
 * charset the store does).
 */
export function jobIdFromActionPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const raw = (payload as Record<string, unknown>)[JOB_FORM_FIELDS.jobId];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return isValidJobId(trimmed) ? trimmed : null;
}

export function draftFromFormPayload(payload: unknown): SubmittedJobForm {
  const raw: Record<string, unknown> =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  const str = (field: string): string | undefined => {
    const value = raw[field];
    return typeof value === "string" ? value : undefined;
  };

  const input: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(raw)) {
    const key = inputKeyOfField(field);
    if (key === null || typeof value !== "string" || value === "") continue;
    input[key] = value;
  }

  return {
    // Shared with the run action, so the two can never disagree about
    // where the id lives.
    jobId: jobIdFromActionPayload(payload),
    scope: editScopeFromActionPayload(payload),
    draft: {
      name: str(JOB_FORM_FIELDS.name) ?? "",
      description: str(JOB_FORM_FIELDS.description) ?? "",
      // Unknown values ride through to the store's validator on purpose.
      workflow: raw[JOB_FORM_FIELDS.workflow],
      input,
      ...triggerDraftFrom(raw),
      enabled: str(JOB_FORM_FIELDS.enabled) !== ENABLED_NO,
    },
  };
}

/**
 * The COMPLETE candidate draft to validate, given a submission and the job
 * it targets.
 *
 * ## Why this exists at all: the silent un-scheduling it prevents
 *
 * The trigger moved to its own form because of the host's 10-field cap (see
 * {@link triggerFormFields}). That split created a trap: the job editor no
 * longer submits any trigger field, so a draft folded from it carries no
 * `trigger` key, `validateJobDraft` applies its documented `undefined →
 * manual` default, and **editing a cron job's name would silently
 * un-schedule it.** No error, no diff the operator reads as a warning —
 * the Trigger column would just say `manual` the next time they looked.
 *
 * So each scope takes its half from the submission and the OTHER half from
 * the stored job:
 *
 *   - `"job"`     — the submitted five fields, plus the STORED trigger.
 *   - `"trigger"` — the submitted trigger, plus the STORED five fields.
 *
 * A create (`stored === null`) has no other half to take, so it passes the
 * submission through unchanged and lands as `manual` by the store's own
 * default — which is the right shape: there is nothing to schedule until
 * the job has an id to consent against.
 *
 * ## This is NOT a patch path
 *
 * The result is a WHOLE draft that goes through `validateJobDraft`, the one
 * door, and comes out branded. Nothing is merged into a stored row behind
 * the validator's back — the deliberate divergence from `ez-code-factory`'s
 * `updateJob(id, patch)` that this module's header calls out. `handleJobRun`
 * already re-reads and re-validates the same six fields before it spends
 * anything; this is that move, one surface over.
 *
 * Pure: no storage, no clock. The caller supplies `stored`.
 */
export function candidateDraft(
  submission: SubmittedJobForm,
  stored: FactoryJob | null,
): Record<string, unknown> {
  if (stored === null) return submission.draft;
  if (submission.scope === EDIT_SCOPE_TRIGGER) {
    return {
      name: stored.name,
      description: stored.description,
      workflow: stored.workflow,
      input: stored.input,
      enabled: stored.enabled,
      // The one field this scope is allowed to move. Absent from the
      // payload (a submission carrying no kind at all) means the store's
      // `undefined → manual` default applies, which un-schedules rather
      // than leaving a half-written trigger — the safe direction.
      ...(submission.draft.trigger === undefined
        ? {}
        : { trigger: submission.draft.trigger }),
    };
  }
  return {
    ...submission.draft,
    // Preserve the schedule the other form owns. Only when the submission
    // carried none, so a payload that DOES name a trigger still wins — the
    // scope decides, not the presence of a stored value.
    ...(submission.draft.trigger === undefined ? { trigger: stored.trigger } : {}),
  };
}

/**
 * The `trigger` half of {@link draftFromFormPayload}, or `{}` when the form
 * carried no trigger at all.
 *
 * ## This function replaced a hardcoded `trigger: {kind: "manual"}`
 *
 * That literal is why the console could not express a background trigger
 * even after the store learned to accept one: whatever the operator picked,
 * the payload folded to `manual` and the job saved as attended. The
 * symptom would have been a Trigger column that always read "manual" with
 * no error anywhere.
 *
 * ## Still not a validator
 *
 * Same contract as the rest of this module: it reads the fields it knows
 * and invents nothing. Specifically —
 *
 *   - The `kind` is passed through UNTOUCHED, even if it is a value no
 *     select offers. The store owns "which kinds exist" and produces the
 *     real message; a second opinion here is how the two drift.
 *   - The two bounds are passed through as the STRINGS the wire carries.
 *     Coercing them here would put the numeric rule in two places, and
 *     `validateJobDraft` already accepts a numeric string for exactly this
 *     reason. A blank box therefore arrives as `""`, which the store
 *     rejects with "required" — the correct answer, not a silent 0.
 *   - The whole `trigger` key is OMITTED when the kind field is absent, so
 *     the store's own `undefined → manual` default applies rather than
 *     being restated here. That is what makes a payload from an older
 *     rendered form still save as a manual job instead of failing.
 *   - Hidden fields never arrive (the host omits them), so a manual job
 *     cannot carry a stale cron expression and a webhook job cannot carry
 *     one at all.
 */
function triggerDraftFrom(
  raw: Record<string, unknown>,
): { trigger?: Record<string, unknown> } {
  const kind = raw[JOB_FORM_FIELDS.triggerKind];
  if (kind === undefined) return {};
  const trigger: Record<string, unknown> = { kind };
  for (const [field, key] of [
    [JOB_FORM_FIELDS.triggerCron, "cron"],
    [JOB_FORM_FIELDS.triggerTimezone, "timezone"],
    [JOB_FORM_FIELDS.triggerRunsPerDay, "maxRunsPerDay"],
    [JOB_FORM_FIELDS.triggerTokensPerRun, "maxTokensPerRun"],
  ] as const) {
    if (raw[field] !== undefined) trigger[key] = raw[field];
  }
  return { trigger };
}

/** Read-only facts about the job being edited. Ids and timestamps only —
 *  `createdBy` / `updatedBy` / `runAs.id` are deliberately absent (invariant
 *  K: this tree is shared across every viewer). */
function jobStats(job: FactoryJob): PageStatItem[] {
  return [
    { label: "Job id", value: job.id },
    { label: "Workflow", value: job.workflow },
    { label: "Trigger", value: triggerLabel(job.trigger) },
    { label: "Updated", value: shortTime(job.updatedAt) },
    { label: "Last run", value: shortTime(job.lastRunAt) },
  ];
}

/**
 * The Run action for one job.
 *
 * ## Why it lives on the JOB page and not as a jobs-table row action
 *
 * A `PageTableRowInput` carries EITHER an `href` or an `action`, never
 * both, and the jobs table's `href` is how you open a job at all. More
 * to the point: this button starts real agent spend, and a table row is a
 * navigation affordance people click without reading. Firing belongs one
 * deliberate step in, next to the inputs it will run with — which the
 * editor is already showing.
 *
 * ## The confirm is not decoration
 *
 * The Hub renders `confirm` as a blocking dialog before it POSTs, and it
 * names the workflow. The console is a SHARED page (invariant K) whose
 * job list anyone with Hub access can edit, so the person clicking Run
 * may not be the person who wrote the inputs. Naming the target is the
 * cheapest way to make "I did not realise it would do that" a decision
 * rather than an accident.
 *
 * The payload carries the job id under the same field the save action
 * uses, so one `parseJobIdPayload` validates both.
 */
export function jobRunAction(job: FactoryJob): {
  event: string;
  payload: Record<string, string>;
  confirm: string;
} {
  return {
    event: JOB_RUN_EVENT,
    payload: { [JOB_FORM_FIELDS.jobId]: job.id },
    confirm: `Run "${job.workflow}" now with this job's saved inputs? It starts a real workflow run and may spend model credits.`,
  };
}

/** Build the `job` editor page. Pure. */
export function buildJobPage(input: JobPageInput): HubPageTree {
  const { view, job, projectId } = input;
  const page = new PageBuilder("ez-factory — job");

  page.link("Back to jobs", hubHref(FACTORY_FULL_PAGE_ID, projectId));

  if (view.kind === "unknown") {
    page.emptyState(
      "Unknown job link",
      "That link does not name a job this console can open. Pick one from the jobs table.",
    );
    return page.build();
  }

  if (view.kind === "edit" && job === null) {
    page.emptyState(
      "Job not found",
      "No job with that id is saved on this install — it may have been deleted, or the link is stale.",
    );
    return page.build();
  }

  const editing = view.kind === "edit" ? job : null;

  page.section(editing ? editing.name : "New job", (section) => {
    if (editing) {
      section.stats(jobStats(editing));
      // Run FIRST, then the link to its history — the two things an
      // operator opening a saved job actually came for. Both sit above
      // the form so neither is below the fold on a job with four inputs.
      //
      // A DISABLED job gets no button at all rather than a disabled one:
      // `enabled: false` is this console's "retire" (there is no delete),
      // and a greyed control invites a second click. The handler refuses
      // it independently — the button's absence is UI, not the check.
      if (editing.enabled) {
        section.button("Run now", jobRunAction(editing), "primary");
      }
      section.link(
        "Runs of this job",
        hubHref(FACTORY_FULL_PAGE_ID, projectId, "runs"),
      );
      // ── The job → consent handoff ─────────────────────────────────
      //
      // Only for a job that fires on its own. A manual job is started by
      // a human the host already authorized, so a delegation for it
      // would be standing authority nothing ever spends — and an
      // affordance offering it would teach people to grant it anyway.
      //
      // A LINK, like the approvals inbox and for the same reason: minting
      // authority is core's act, on core's page, in front of the person
      // it belongs to. This extension carries the job's id there so
      // nobody has to retype it; that is the whole of its contribution.
      const consentHref = delegationConsentHref(editing);
      if (consentHref !== null) {
        section.link("Let this run unattended…", consentHref);
      }
    }
    section.form(
      jobFormFields(editing),
      {
        event: JOB_SAVE_EVENT,
        // The job id rides on the ACTION payload rather than a form field:
        // payload keys the operator cannot retype are the ones that should
        // not be typeable. A create carries no id and the handler mints one.
        ...(editing
          ? {
              payload: {
                [JOB_FORM_FIELDS.jobId]: editing.id,
                [EDIT_SCOPE_FIELD]: EDIT_SCOPE_JOB,
              },
            }
          : {}),
      },
      editing ? "Save job" : "Create job",
    );
  });

  // The schedule, in its own section and its own form — the host caps a
  // form at 10 fields and the editor above already declares 8 (see
  // `triggerFormFields`). Only for a job that exists: a background trigger
  // is inert until a human consents to a delegation for it, and there is
  // nothing to consent against until the job has an id.
  if (editing) {
    page.section("When it fires", (section) => {
      section.markdownBlock(TRIGGER_HELP);
      section.form(
        triggerFormFields(editing),
        {
          event: JOB_SAVE_EVENT,
          payload: {
            [JOB_FORM_FIELDS.jobId]: editing.id,
            [EDIT_SCOPE_FIELD]: EDIT_SCOPE_TRIGGER,
          },
        },
        "Save schedule",
      );
      if (isBackgroundTrigger(editing.trigger)) {
        // Saving a schedule mints no authority — a delegation does, and
        // only a human can create one through core's session-only consent
        // route. Without this the console would show a job whose Trigger
        // column reads `cron · 0 3 * * *` and which never runs, and the
        // only clue would be its absence from Recent runs.
        section.emptyState("Saved, not yet armed", BACKGROUND_TRIGGER_NOTE);
      }
    });
  }

  return page.build();
}
