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
  FACTORY_WORKFLOWS,
  JOB_SETTABLE_INPUT_KEYS,
  MAX_JOB_DESCRIPTION_LEN,
  MAX_JOB_NAME_LEN,
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
 * The ONE page action this console dispatches.
 *
 * It must be declared in `permissions.eventSubscriptions` or it does not
 * exist: `validatePageTree` DROPS any button/form/row whose event is outside
 * the granted list (`allowedEvents`, from the runtime grant), and the events
 * route 404s an unregistered event. A form node with an ungranted action is
 * not rendered read-only — it is deleted from the tree, silently.
 *
 * Deliberately singular. Every additional event is additional attack surface
 * reachable from a page that is shared across users, so v1 buys exactly one:
 * retire a job with `enabled: false` rather than deleting it, and fire one
 * from chat or core's workflow UI.
 */
export const JOB_SAVE_EVENT = `${EXTENSION_NAME}:job-save`;

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

/** Human badge + tone per run status. Core's `workflow_runs.status` is an open
 *  string at this boundary, so an unrecognised value renders verbatim and
 *  neutral rather than being dropped — an honest "I do not know this status"
 *  beats a blank cell. */
const RUN_STATUS_TONE: Record<string, "success" | "danger" | "warning"> = {
  completed: "success",
  failed: "danger",
  aborted: "danger",
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

/** One-line label for a job trigger. v1 only ever creates `manual`; the other
 *  shapes are labelled so a job written by a later version still renders. */
export function triggerLabel(trigger: JobTrigger): string {
  switch (trigger.kind) {
    case "manual":
      return "manual";
    case "cron":
      return `cron · ${trigger.cron} · ${trigger.timezone}`;
    case "webhook":
      return "webhook";
    case "event":
      return `event · ${trigger.event}`;
    case "workflow":
      return `workflow · ${trigger.onWorkflow} · ${trigger.onStatus.join(",")}`;
  }
}

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
  "Jobs are **install-wide**: everyone with access to this Hub sees, and can edit, the same list. " +
  "A job names one of the shipped workflow templates and the inputs to run it with — " +
  "firing it, and answering any approval gate it parks on, happen in the workflow UI.";

export const TEMPLATES_HELP =
  "These three workflows ship with the extension. They are **assets, not code you can edit here** — " +
  "open one in the workflow UI to read its steps, or fork it there to make your own.";

export const RUNS_HELP =
  "The most recent runs started from a job on this install. " +
  "Each row opens that run's full trace — step outputs and artifacts live there, never on this shared page.";

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
      "A run appears here once a job has been fired and the console has seen its result.",
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
 *  DROPPED host-side with no fall-back, so these are not free-form. */
export const JOB_FORM_FIELDS = {
  jobId: "job_id",
  name: "name",
  description: "description",
  workflow: "workflow",
  enabled: "enabled",
} as const;

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
      multiline: true,
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
  /** Candidate draft, for {@link validateJobDraft}. Deliberately `unknown`:
   *  nothing here has been validated yet. */
  draft: Record<string, unknown>;
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

  const rawId = str(JOB_FORM_FIELDS.jobId)?.trim();

  return {
    jobId: rawId !== undefined && isValidJobId(rawId) ? rawId : null,
    draft: {
      name: str(JOB_FORM_FIELDS.name) ?? "",
      description: str(JOB_FORM_FIELDS.description) ?? "",
      // Unknown values ride through to the store's validator on purpose.
      workflow: raw[JOB_FORM_FIELDS.workflow],
      input,
      trigger: { kind: "manual" },
      enabled: str(JOB_FORM_FIELDS.enabled) !== ENABLED_NO,
    },
  };
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
      section.link(
        "Runs of this job",
        hubHref(FACTORY_FULL_PAGE_ID, projectId, "runs"),
      );
    }
    section.form(
      jobFormFields(editing),
      {
        event: JOB_SAVE_EVENT,
        // The job id rides on the ACTION payload rather than a form field:
        // payload keys the operator cannot retype are the ones that should
        // not be typeable. A create carries no id and the handler mints one.
        ...(editing ? { payload: { [JOB_FORM_FIELDS.jobId]: editing.id } } : {}),
      },
      editing ? "Save job" : "Create job",
    );
  });

  return page.build();
}
