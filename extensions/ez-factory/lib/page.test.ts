import { describe, expect, test } from "bun:test";
import type { HubPageTree } from "@ezcorp/sdk/runtime";

import manifest from "../ezcorp.config";
import {
  ALL_INPUT_KEYS,
  APPROVALS_HREF,
  BACKGROUND_TRIGGER_NOTE,
  buildFactoryPage,
  buildJobPage,
  candidateDraft,
  CONSOLE_HELP,
  DELEGATABLE_TRIGGER_KINDS,
  DELEGATIONS_HREF,
  delegationConsentHref,
  draftFromFormPayload,
  editScopeFromActionPayload,
  EDIT_SCOPE_FIELD,
  EDIT_SCOPE_JOB,
  EDIT_SCOPE_TRIGGER,
  OFFERED_TRIGGER_KINDS,
  TRIGGER_HELP,
  triggerFormFields,
  enabledCell,
  ENABLED_NO,
  ENABLED_YES,
  EXTENSION_NAME,
  FACTORY_FULL_PAGE_ID,
  FACTORY_PAGE_ID,
  hubHref,
  inputFieldId,
  inputKeyOfField,
  inputSummary,
  inputValueText,
  INPUT_EXCERPT_CHARS,
  JOB_FORM_FIELDS,
  JOB_FULL_PAGE_ID,
  JOB_PAGE_ID,
  JOB_RUN_EVENT,
  JOB_SAVE_EVENT,
  jobFormFields,
  jobIdFromActionPayload,
  jobRunAction,
  jobViewValue,
  MULTILINE_INPUT_KEYS,
  parseFactoryView,
  parseJobView,
  RUNS_HELP,
  runStatusCell,
  runTraceHref,
  shortTime,
  TEMPLATE_BLURBS,
  TEMPLATES_HELP,
  triggerLabel,
  workflowsAccepting,
  WORKFLOWS_HREF,
  type FactoryView,
} from "./page";
import {
  FACTORY_WORKFLOWS,
  JOB_SETTABLE_INPUT_KEYS,
  MAX_JOB_DESCRIPTION_LEN,
  MAX_JOB_NAME_LEN,
  validateJobDraft,
  type FactoryJob,
  type JobRunRecord,
} from "./jobs";

const NOW = "2026-08-01T12:00:00.000Z";

function job(over: Partial<FactoryJob> = {}): FactoryJob {
  return {
    id: "j1",
    name: "Nightly docs",
    description: "Regenerate the API reference",
    workflow: "docs-factory",
    input: { globs: "src/**/*.ts", outPath: "docs/api.md" },
    trigger: { kind: "manual" },
    enabled: true,
    runAs: { kind: "user", id: "user-1" },
    consentHash: null,
    createdBy: "user-1",
    createdAt: NOW,
    updatedBy: "user-1",
    updatedAt: NOW,
    ...over,
  };
}

function runRecord(over: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    jobId: "j1",
    workflowRunId: "run-1",
    workflowName: "ez-factory:docs-factory",
    status: "completed",
    startedAt: NOW,
    finishedAt: "2026-08-01T12:05:00.000Z",
    suspendedReason: null,
    resumable: false,
    ...over,
  };
}

// ── Tree walking helpers ────────────────────────────────────────────

type Node = Record<string, unknown>;

/** Every node in a tree, recursing fully into section children. */
function allNodes(nodes: unknown[]): Node[] {
  const out: Node[] = [];
  for (const raw of nodes) {
    const n = raw as Node;
    out.push(n);
    if (n.type === "section" && Array.isArray(n.nodes)) out.push(...allNodes(n.nodes as unknown[]));
  }
  return out;
}

/**
 * Every raw string reachable inside a node, EXCLUDING its `nodes` child array
 * (section children are visited independently by `allNodes`). Concatenates
 * the verbatim values — not JSON — so quote/backslash escaping can never mask
 * a match.
 */
function ownContent(n: Node): string {
  const collect = (v: unknown): string => {
    if (typeof v === "string") return `${v} `;
    if (Array.isArray(v)) return v.map(collect).join("");
    if (v && typeof v === "object") return Object.values(v).map(collect).join("");
    return "";
  };
  const shallow: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) if (k !== "nodes") shallow[k] = v;
  return collect(shallow);
}

/** Every string anywhere in a tree, including section children. */
function treeContent(tree: { nodes: unknown[] }): string {
  return allNodes(tree.nodes).map(ownContent).join(" ");
}

function nodesOfType(tree: { nodes: unknown[] }, type: string): Node[] {
  return allNodes(tree.nodes).filter((n) => n.type === type);
}

function firstTable(tree: { nodes: unknown[] }): {
  columns: string[];
  rows: { cells: unknown[]; href?: string }[];
} {
  return nodesOfType(tree, "table")[0] as unknown as {
    columns: string[];
    rows: { cells: unknown[]; href?: string }[];
  };
}

/**
 * Page node types whose author strings the host validator `<>`-strips and
 * truncates (`src/extensions/page-schema.ts`). The ONE page node rendered
 * through `{@html}` is `markdown` (DOMPurify, NOT `<>`-stripped —
 * `validateMarkdown` truncates only), so a job- or run-derived string must
 * never land in a `markdown` node.
 */
const ESCAPED_PAGE_TYPES = new Set([
  "section",
  "heading",
  "stats",
  "table",
  "button",
  "link",
  "empty-state",
  // The inline form node's strings (labels, prefill values, placeholders)
  // render through host-owned inputs — Svelte text/attribute interpolation,
  // never `{@html}` — and the validator `<>`-strips them like the rest.
  "form",
]);

// ── `?view=` parsing ────────────────────────────────────────────────

describe("parseFactoryView", () => {
  test("absent, empty and 'jobs' all mean the jobs table", () => {
    for (const raw of [undefined, "", "jobs"]) {
      expect(parseFactoryView(raw)).toEqual({ kind: "jobs" });
    }
  });

  test("the two named views parse", () => {
    expect(parseFactoryView("templates")).toEqual({ kind: "templates" });
    expect(parseFactoryView("runs")).toEqual({ kind: "runs" });
  });

  test("anything else is `unknown`, never a throw", () => {
    for (const raw of ["audit", "JOBS", "job:j1", "../etc", "runs "]) {
      expect(parseFactoryView(raw)).toEqual({ kind: "unknown" });
    }
  });
});

describe("parseJobView", () => {
  test("absent, empty and 'new' all mean the create form", () => {
    for (const raw of [undefined, "", "new"]) {
      expect(parseJobView(raw)).toEqual({ kind: "new" });
    }
  });

  test("`job:<id>` opens that job", () => {
    expect(parseJobView("job:abc-123")).toEqual({ kind: "edit", jobId: "abc-123" });
    // Surrounding whitespace is trimmed, not rejected.
    expect(parseJobView("job:  abc-123  ")).toEqual({ kind: "edit", jobId: "abc-123" });
  });

  test("an id the STORE would reject is refused here, not passed along", () => {
    // The id is spliced into a storage key (`job:<id>`), so an id carrying
    // `:` could forge a key belonging to another job. Rejecting at the parse
    // boundary means the handler never sees a shape the store has to defend
    // against a second time.
    for (const bad of ["job:", "job:   ", "job:a:b", "job:../x", "job:with space", `job:${"x".repeat(65)}`]) {
      expect(parseJobView(bad)).toEqual({ kind: "unknown" });
    }
  });

  test("a non-`job:` value is unknown", () => {
    expect(parseJobView("templates")).toEqual({ kind: "unknown" });
    expect(parseJobView("j1")).toEqual({ kind: "unknown" });
  });

  test("jobViewValue round-trips through parseJobView", () => {
    expect(parseJobView(jobViewValue("abc-123"))).toEqual({ kind: "edit", jobId: "abc-123" });
  });
});

// ── Hrefs ───────────────────────────────────────────────────────────

describe("hubHref", () => {
  test("global hub when there is no project", () => {
    expect(hubHref(FACTORY_FULL_PAGE_ID, undefined)).toBe("/hub/ext%3Aez-factory%3Afactory");
  });

  test("project-scoped when there is one", () => {
    expect(hubHref(JOB_FULL_PAGE_ID, "p1")).toBe("/project/p1/hub/ext%3Aez-factory%3Ajob");
  });

  test("the view value is encoded so a compound `job:<id>` round-trips", () => {
    expect(hubHref(JOB_FULL_PAGE_ID, undefined, "job:a b")).toBe(
      "/hub/ext%3Aez-factory%3Ajob?view=job%3Aa%20b",
    );
  });

  test("a hostile project id cannot escape its path segment", () => {
    const href = hubHref(FACTORY_FULL_PAGE_ID, "../../evil");
    expect(href).toBe("/project/..%2F..%2Fevil/hub/ext%3Aez-factory%3Afactory");
    // `isSafeInternalHref` rejects a backslash and a `//` prefix; the encoding
    // above means neither can appear from the id.
    expect(href.startsWith("/")).toBe(true);
    expect(href.startsWith("//")).toBe(false);
    expect(href.includes("\\")).toBe(false);
  });
});

describe("runTraceHref", () => {
  test("points at core's run trace with the id encoded", () => {
    expect(runTraceHref("run-1")).toBe("/workflows/runs/run-1");
    expect(runTraceHref("a/b")).toBe("/workflows/runs/a%2Fb");
  });
});

describe("page ids", () => {
  test("match the manifest's declared pages exactly", () => {
    // A page id the manifest does not declare renders nowhere: the events
    // route 404s an undeclared `pageId` and the Hub has nothing to pull.
    expect(manifest.pages?.map((p) => p.id).sort()).toEqual(
      [FACTORY_PAGE_ID, JOB_PAGE_ID].sort(),
    );
    expect(FACTORY_FULL_PAGE_ID).toBe(`ext:${EXTENSION_NAME}:${FACTORY_PAGE_ID}`);
    expect(JOB_FULL_PAGE_ID).toBe(`ext:${EXTENSION_NAME}:${JOB_PAGE_ID}`);
  });

  test("the save event is namespaced to this extension", () => {
    expect(JOB_SAVE_EVENT).toBe(`${EXTENSION_NAME}:job-save`);
    expect(EXTENSION_NAME).toBe(manifest.name);
  });
});

// ── Display helpers ─────────────────────────────────────────────────

describe("runStatusCell", () => {
  test("the tones are keyed on core's RUN vocabulary, not the agent one", () => {
    // The whole six-value set core can put in `workflow_runs.status`
    // (`RUN_STATUS_FILTERS`). This table used to be keyed on `completed` /
    // `failed` / `aborted` — the AGENT statuses, which a workflow run
    // never carries — so `success` and `error` matched nothing and a
    // failed run rendered exactly like a successful one. Asserting the
    // whole vocabulary is what makes that unrepeatable.
    expect(runStatusCell("success")).toEqual({ text: "success", tone: "success" });
    expect(runStatusCell("error")).toEqual({ text: "error", tone: "danger" });
    expect(runStatusCell("cancelled")).toEqual({ text: "cancelled", tone: "danger" });
    expect(runStatusCell("awaiting_approval")).toEqual({
      text: "awaiting_approval",
      tone: "warning",
    });
    expect(runStatusCell("suspended")).toEqual({ text: "suspended", tone: "warning" });
    // In progress is not a verdict — toning it would make a live run read
    // as an outcome.
    expect(runStatusCell("running")).toBe("running");
  });

  test("the OLD agent-run keys are gone, not merely joined", () => {
    // Discrimination: leaving them in would have let the fix pass while
    // the table still claimed to understand statuses it never receives.
    expect(runStatusCell("completed")).toBe("completed");
    expect(runStatusCell("failed")).toBe("failed");
    expect(runStatusCell("aborted")).toBe("aborted");
  });

  test("an unrecognised status renders VERBATIM rather than being dropped", () => {
    // Core's `workflow_runs.status` is an open string at this boundary. An
    // honest "I do not know this status" beats a blank cell.
    expect(runStatusCell("some_new_status")).toBe("some_new_status");
  });
});

describe("enabledCell", () => {
  test("enabled is toned, disabled is a bare string", () => {
    expect(enabledCell(true)).toEqual({ text: "✓ enabled", tone: "success" });
    expect(enabledCell(false)).toBe("○ disabled");
  });
});

describe("shortTime", () => {
  test("renders an ISO instant as `YYYY-MM-DD HH:MM`", () => {
    expect(shortTime(NOW)).toBe("2026-08-01 12:00");
  });

  test("absent values render as an em dash", () => {
    expect(shortTime(undefined)).toBe("—");
    expect(shortTime(null)).toBe("—");
    expect(shortTime("")).toBe("—");
  });

  test("an unparseable value is returned as-is, never silently blanked", () => {
    expect(shortTime("not a date")).toBe("not a date");
  });
});

describe("triggerLabel", () => {
  test("labels every trigger shape the store can round-trip", () => {
    expect(triggerLabel({ kind: "manual" })).toBe("manual");
    expect(triggerLabel({ kind: "event", event: "run:complete" })).toBe("event · run:complete");
    expect(
      triggerLabel({ kind: "workflow", onWorkflow: "other", onStatus: ["completed", "failed"] }),
    ).toBe("workflow · other · completed,failed");
  });

  test("a BACKGROUND trigger always renders its bounds", () => {
    // The bounds are the only thing between a saved cron and unattended
    // spend, so they belong on the row an operator scans rather than one
    // click in. A label that dropped them would make an unbounded-looking
    // job indistinguishable from a tightly-bounded one.
    expect(
      triggerLabel({
        kind: "cron",
        cron: "0 2 * * *",
        timezone: "UTC",
        maxRunsPerDay: 4,
        maxTokensPerRun: 50_000,
      }),
    ).toBe("cron · 0 2 * * * · UTC · ≤4/day · ≤50000 tok/run");
    expect(
      triggerLabel({ kind: "webhook", maxRunsPerDay: 20, maxTokensPerRun: 1000 }),
    ).toBe("webhook · ≤20/day · ≤1000 tok/run");
  });
});

describe("inputValueText", () => {
  test("a short string passes through", () => {
    expect(inputValueText("src/**")).toBe("src/**");
  });

  test("absent values render empty", () => {
    expect(inputValueText(undefined)).toBe("");
    expect(inputValueText(null)).toBe("");
  });

  test("an object is serialized rather than stringified to [object Object]", () => {
    expect(inputValueText({ a: 1 })).toBe('{"a":1}');
    expect(inputValueText(["a", "b"])).toBe('["a","b"]');
  });

  test("BUILDER pre-truncates so a big value cannot reject the whole tree", () => {
    // The 64 KB tree-envelope check runs on the RAW input BEFORE the
    // validator's per-cell 300-char truncation, so a job carrying the
    // store's full input budget in one field would reject the ENTIRE tree
    // rather than truncate one cell.
    const big = "x".repeat(9000);
    const out = inputValueText(big);
    expect(out.length).toBeLessThanOrEqual(INPUT_EXCERPT_CHARS);
    expect(out).toContain("[9000 chars]");
    // Discrimination: the untruncated value really was over the bound.
    expect(big.length).toBeGreaterThan(INPUT_EXCERPT_CHARS);
  });

  test("exactly at the bound is kept whole", () => {
    const exact = "y".repeat(INPUT_EXCERPT_CHARS);
    expect(inputValueText(exact)).toBe(exact);
  });

  test("an unserializable value degrades to a marker instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(inputValueText(cyclic)).toBe("[unserializable]");
  });
});

describe("inputSummary", () => {
  test("renders `k=v` pairs", () => {
    expect(inputSummary(job())).toBe("globs=src/**/*.ts · outPath=docs/api.md");
  });

  test("no inputs renders an em dash", () => {
    expect(inputSummary(job({ input: {} }))).toBe("—");
  });
});

// ── The factory page ────────────────────────────────────────────────

describe("buildFactoryPage — nav", () => {
  test("every view carries the same nav strip, including the two links OUT", () => {
    const views: FactoryView[] = [
      { kind: "jobs" },
      { kind: "templates" },
      { kind: "runs" },
      { kind: "unknown" },
    ];
    for (const view of views) {
      const tree = buildFactoryPage({ view, jobs: [], runs: [] });
      const hrefs = nodesOfType(tree, "link").map((n) => n.href);
      // The approvals inbox and Fork are links BY DESIGN (invariant K /
      // B7) — a rendered approvals list would publish one user's parked
      // decisions to every viewer of this shared tree.
      expect(hrefs).toContain(APPROVALS_HREF);
      expect(hrefs).toContain(WORKFLOWS_HREF);
    }
  });

  test("nav links stay inside the project hub when there is a project", () => {
    const tree = buildFactoryPage({ view: { kind: "jobs" }, jobs: [], runs: [], projectId: "p1" });
    const own = nodesOfType(tree, "link")
      .map((n) => String(n.href))
      .filter((h) => h.includes("hub/"));
    expect(own.length).toBeGreaterThan(0);
    for (const href of own) expect(href.startsWith("/project/p1/hub/")).toBe(true);
  });
});

describe("buildFactoryPage — jobs view", () => {
  test("empty state when there are no jobs, and no table", () => {
    const tree = buildFactoryPage({ view: { kind: "jobs" }, jobs: [], runs: [] });
    expect(nodesOfType(tree, "empty-state")).toHaveLength(1);
    expect(nodesOfType(tree, "table")).toHaveLength(0);
  });

  test("one row per job, each deep-linking to its editor", () => {
    const tree = buildFactoryPage({
      view: { kind: "jobs" },
      jobs: [job(), job({ id: "j2", name: "ETL", workflow: "etl-factory", enabled: false })],
      runs: [],
    });
    const table = firstTable(tree);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]!.cells[0]).toBe("Nightly docs");
    expect(table.rows[0]!.href).toBe(`/hub/ext%3Aez-factory%3Ajob?view=job%3Aj1`);
    expect(table.rows[1]!.cells[4]).toBe("○ disabled");
  });

  test("the last-run cell prefers a recorded run over the job's own bookkeeping", () => {
    const tree = buildFactoryPage({
      view: { kind: "jobs" },
      jobs: [job({ lastRunAt: "2020-01-01T00:00:00.000Z" })],
      runs: [runRecord({ startedAt: NOW, status: "failed" })],
    });
    expect(String(firstTable(tree).rows[0]!.cells[5])).toBe("2026-08-01 12:00 · failed");
  });

  test("a job with no runs at all falls back to its bookkeeping", () => {
    const tree = buildFactoryPage({
      view: { kind: "jobs" },
      jobs: [job({ lastRunAt: undefined })],
      runs: [],
    });
    expect(firstTable(tree).rows[0]!.cells[5]).toBe("—");
  });

  test("the install-wide warning is on the page", () => {
    // Jobs are global-scope: everyone who can reach this Hub sees and can
    // edit the same list, and there is no per-job owner check anywhere.
    // The store's header says a UI built on it must say so.
    const tree = buildFactoryPage({ view: { kind: "jobs" }, jobs: [job()], runs: [] });
    expect(treeContent(tree)).toContain("install-wide");
  });
});

describe("buildFactoryPage — templates view", () => {
  test("describes exactly the three shipped workflows", () => {
    const tree = buildFactoryPage({ view: { kind: "templates" }, jobs: [], runs: [] });
    const table = firstTable(tree);
    expect(table.rows.map((r) => r.cells[0])).toEqual([...FACTORY_WORKFLOWS].sort((a, b) =>
      TEMPLATE_BLURBS.findIndex((t) => t.workflow === a) -
      TEMPLATE_BLURBS.findIndex((t) => t.workflow === b),
    ));
  });

  test("each row shows that workflow's job-settable input keys, from the store's allowlist", () => {
    const tree = buildFactoryPage({ view: { kind: "templates" }, jobs: [], runs: [] });
    for (const row of firstTable(tree).rows) {
      const workflow = row.cells[0] as keyof typeof JOB_SETTABLE_INPUT_KEYS;
      expect(row.cells[2]).toBe(JOB_SETTABLE_INPUT_KEYS[workflow].join(", "));
    }
  });

  test("rows link out to core's workflow UI under the NAMESPACED name", () => {
    // The host produces `ez-factory:<name>`; the bare name is what the
    // extension supplies to `ctx.workflows.run()`. A link has to use the
    // namespaced form because that is what core's route resolves.
    const tree = buildFactoryPage({ view: { kind: "templates" }, jobs: [], runs: [] });
    expect(firstTable(tree).rows[0]!.href).toBe("/workflows/ez-factory%3Adocs-factory");
  });
});

describe("buildFactoryPage — runs view", () => {
  test("empty state when nothing has run", () => {
    const tree = buildFactoryPage({ view: { kind: "runs" }, jobs: [job()], runs: [] });
    expect(nodesOfType(tree, "empty-state")).toHaveLength(1);
  });

  test("each run row deep-links to core's trace", () => {
    const tree = buildFactoryPage({
      view: { kind: "runs" },
      jobs: [job()],
      runs: [runRecord({ workflowRunId: "wr-9" })],
    });
    expect(firstTable(tree).rows[0]!.href).toBe("/workflows/runs/wr-9");
    expect(firstTable(tree).rows[0]!.cells[0]).toBe("Nightly docs");
  });

  test("a run whose job was deleted still renders, named by id", () => {
    const tree = buildFactoryPage({
      view: { kind: "runs" },
      jobs: [],
      runs: [runRecord({ jobId: "gone" })],
    });
    expect(firstTable(tree).rows[0]!.cells[0]).toBe("gone");
  });
});

describe("buildFactoryPage — unknown view", () => {
  test("renders an honest empty state, never a throw", () => {
    const tree = buildFactoryPage({ view: { kind: "unknown" }, jobs: [job()], runs: [] });
    expect(nodesOfType(tree, "empty-state")).toHaveLength(1);
    expect(nodesOfType(tree, "table")).toHaveLength(0);
  });
});

// ── The job page ────────────────────────────────────────────────────

describe("buildJobPage", () => {
  test("a create renders one form with no prefilled name", () => {
    const tree = buildJobPage({ view: { kind: "new" }, job: null });
    const forms = nodesOfType(tree, "form");
    expect(forms).toHaveLength(1);
    expect((forms[0] as { submitLabel: string }).submitLabel).toBe("Create job");
    const fields = (forms[0] as { fields: { field: string; value?: string }[] }).fields;
    expect(fields.find((f) => f.field === JOB_FORM_FIELDS.name)!.value).toBeUndefined();
  });

  test("an edit renders TWO forms — the job and its schedule — on ONE granted event", () => {
    // Two forms, not one, and the reason is a hard host bound rather than
    // taste: `validateFormNode` caps a form at MAX_FORM_FIELDS = 10 and
    // DROPS the excess silently, after which `pruneDanglingConditions`
    // strips `visibleWhen` from the survivors that depended on a dropped
    // field. The editor already declares 8 and an honest background
    // trigger needs 5.
    //
    // Both dispatch the SAME granted event: a third page action would be
    // a real grant widening across three files to buy a split the action
    // payload can already express.
    const tree = buildJobPage({ view: { kind: "edit", jobId: "j1" }, job: job() });
    const forms = nodesOfType(tree, "form") as {
      submitLabel: string;
      action: { event: string; payload?: Record<string, string> };
      fields: { field: string; value?: string }[];
    }[];
    expect(forms).toHaveLength(2);
    for (const form of forms) expect(form.action.event).toBe(JOB_SAVE_EVENT);

    const [jobForm, triggerForm] = forms as [(typeof forms)[0], (typeof forms)[0]];
    expect(jobForm.submitLabel).toBe("Save job");
    expect(triggerForm.submitLabel).toBe("Save schedule");

    // The id rides on the payload, not a typeable field — on BOTH forms,
    // alongside the scope that tells the one handler which half arrived.
    expect(jobForm.action.payload).toEqual({
      [JOB_FORM_FIELDS.jobId]: "j1",
      [EDIT_SCOPE_FIELD]: EDIT_SCOPE_JOB,
    });
    expect(triggerForm.action.payload).toEqual({
      [JOB_FORM_FIELDS.jobId]: "j1",
      [EDIT_SCOPE_FIELD]: EDIT_SCOPE_TRIGGER,
    });
    expect(jobForm.fields.some((f) => f.field === JOB_FORM_FIELDS.jobId)).toBe(false);
    expect(jobForm.fields.find((f) => f.field === JOB_FORM_FIELDS.name)!.value).toBe(
      "Nightly docs",
    );
  });

  test("a CREATE renders only the job form — there is nothing to schedule yet", () => {
    // A background trigger is inert until a human consents to a delegation
    // for it, and there is nothing to consent against until the job has an
    // id. So a create is attended by construction and the schedule form
    // appears once the job exists.
    const tree = buildJobPage({ view: { kind: "new" }, job: null });
    const forms = nodesOfType(tree, "form") as { submitLabel: string }[];
    expect(forms).toHaveLength(1);
    expect(forms[0]!.submitLabel).toBe("Create job");
  });

  test("EVERY form on the page stays inside the host's 10-field cap", () => {
    // Asserted over the rendered TREE, not just `jobFormFields`, because
    // the overflow is silent: field 11 is dropped and the `visibleWhen` of
    // whatever pointed at it is deleted too, so the page renders looking
    // finished with inputs shown on the wrong workflow.
    for (const view of [
      { kind: "new" as const },
      { kind: "edit" as const, jobId: "j1" },
    ]) {
      const tree = buildJobPage({ view, job: view.kind === "edit" ? job() : null });
      for (const form of nodesOfType(tree, "form") as { fields: unknown[] }[]) {
        expect(form.fields.length).toBeLessThanOrEqual(10);
      }
    }
  });

  test("an id that no longer resolves renders 'not found', not an empty editor", () => {
    const tree = buildJobPage({ view: { kind: "edit", jobId: "gone" }, job: null });
    expect(nodesOfType(tree, "empty-state")).toHaveLength(1);
    // No form: a Save here would create a NEW job under a stale link.
    expect(nodesOfType(tree, "form")).toHaveLength(0);
  });

  test("an unknown view renders an empty state and no form", () => {
    const tree = buildJobPage({ view: { kind: "unknown" }, job: null });
    expect(nodesOfType(tree, "empty-state")).toHaveLength(1);
    expect(nodesOfType(tree, "form")).toHaveLength(0);
  });

  test("the action event is exactly the one the manifest grants", () => {
    // A tree whose action is outside the granted `eventSubscriptions` has
    // its form node DELETED by `validatePageTree` — the page would render
    // complete and have no Save.
    const tree = buildJobPage({ view: { kind: "new" }, job: null });
    const event = (nodesOfType(tree, "form")[0] as { action: { event: string } }).action.event;
    expect(manifest.permissions?.eventSubscriptions).toContain(event);
  });
});

describe("jobFormFields", () => {
  test("stays within the host's 10-field ceiling", () => {
    // At most 10 fields survive host validation; an 11th is dropped
    // silently, so the form would lose an input with nothing failing.
    expect(jobFormFields(null).length).toBeLessThanOrEqual(10);
  });

  test("every field id is a host-accepted slug", () => {
    // A non-slug field is DROPPED host-side with no fall-back (unlike a
    // prompt, which falls back). These are not free-form.
    const slug = /^[a-z0-9][a-z0-9_]{0,31}$/;
    for (const f of jobFormFields(job())) expect(slug.test(f.field)).toBe(true);
  });

  test("length hints agree with the store's caps rather than exceeding them", () => {
    // The host clamps a hint to [1,500]. A larger hint is silently clamped,
    // so the form would accept less than the store does.
    const fields = jobFormFields(null);
    expect(fields.find((f) => f.field === JOB_FORM_FIELDS.name)!.maxLength).toBe(MAX_JOB_NAME_LEN);
    expect(fields.find((f) => f.field === JOB_FORM_FIELDS.description)!.maxLength).toBe(
      MAX_JOB_DESCRIPTION_LEN,
    );
    for (const f of fields) {
      if (f.maxLength !== undefined) expect(f.maxLength).toBeLessThanOrEqual(500);
    }
  });

  test("the workflow select offers exactly the three shipped names", () => {
    const workflow = jobFormFields(null).find((f) => f.field === JOB_FORM_FIELDS.workflow)!;
    expect(workflow.options?.map((o) => o.value)).toEqual([...FACTORY_WORKFLOWS]);
    // 2..12 options survive host validation; three is inside that.
    expect(workflow.options!.length).toBeGreaterThanOrEqual(2);
  });

  test("`enabled` defaults to enabled on a create and mirrors the job on an edit", () => {
    const enabledOf = (j: FactoryJob | null): string | undefined =>
      jobFormFields(j).find((f) => f.field === JOB_FORM_FIELDS.enabled)!.value;
    expect(enabledOf(null)).toBe(ENABLED_YES);
    expect(enabledOf(job({ enabled: true }))).toBe(ENABLED_YES);
    expect(enabledOf(job({ enabled: false }))).toBe(ENABLED_NO);
  });

  test("INVARIANT B in the UI: every input field is gated on the workflows that allow it", () => {
    // A hidden field is OMITTED from the submitted payload, so selecting a
    // workflow cannot submit an input outside ITS allowlist. This makes the
    // UI agree with the store's allowlist instead of fighting it.
    for (const key of ALL_INPUT_KEYS) {
      const field = jobFormFields(null).find((f) => f.field === inputFieldId(key))!;
      expect(field.visibleWhen).toEqual({
        field: JOB_FORM_FIELDS.workflow,
        equals: workflowsAccepting(key),
      });
    }
  });

  test("the gate is DISCRIMINATING — a key is gated on strictly fewer than all workflows", () => {
    // Guards the vacuous pass: if every key were visible for every
    // workflow, the assertion above would hold and the gate would do
    // nothing. `draft` belongs to draft-and-verify alone.
    expect(workflowsAccepting("draft")).toEqual(["draft-and-verify"]);
    expect(workflowsAccepting("globs")).toEqual(["docs-factory", "etl-factory"]);
    expect(workflowsAccepting("draft").length).toBeLessThan(FACTORY_WORKFLOWS.length);
  });

  test("ALL_INPUT_KEYS is the deduplicated union of the store's per-workflow allowlists", () => {
    const union = new Set(FACTORY_WORKFLOWS.flatMap((w) => JOB_SETTABLE_INPUT_KEYS[w]));
    expect([...ALL_INPUT_KEYS].sort()).toEqual([...union].sort());
    // `globs` and `outPath` appear in two allowlists; the union must not
    // render two identical fields (duplicate ids collide in the payload).
    expect(new Set(ALL_INPUT_KEYS).size).toBe(ALL_INPUT_KEYS.length);
  });

  test("an unknown key with no allowlist would be gated on NOTHING, never shown always", () => {
    // Fail-closed: a key nobody accepts is invisible, not universally
    // visible. `equals: []` matches no select value.
    expect(workflowsAccepting("madeUpKey")).toEqual([]);
  });

  test("existing input values prefill their fields", () => {
    const fields = jobFormFields(job());
    expect(fields.find((f) => f.field === inputFieldId("globs"))!.value).toBe("src/**/*.ts");
    // An input the job does not carry has no prefill at all.
    expect(fields.find((f) => f.field === inputFieldId("draft"))!.value).toBeUndefined();
  });
});

describe("inputFieldId / inputKeyOfField", () => {
  test("round-trip across every allowlisted key", () => {
    for (const key of ALL_INPUT_KEYS) expect(inputKeyOfField(inputFieldId(key))).toBe(key);
  });

  test("the id is LOWERCASED — a camelCase key would be dropped host-side", () => {
    // `/^[a-z0-9][a-z0-9_]{0,31}$/` or the host drops the field, silently
    // and with no fall-back. `outPath` is the key that proves it.
    expect(ALL_INPUT_KEYS).toContain("outPath");
    expect(inputFieldId("outPath")).toBe("input_outpath");
    // Discrimination: the naive form really would have failed the slug rule.
    expect(/^[a-z0-9][a-z0-9_]{0,31}$/.test("input_outPath")).toBe(false);
  });

  test("no two allowlisted keys collide once lowercased", () => {
    // Lowercasing is lossy, so two keys differing only in case would map to
    // ONE field: the second would overwrite the first in the payload and an
    // operator's value would land under the wrong key. Nothing prevents such
    // a pair being added to the allowlist except this test.
    const ids = ALL_INPUT_KEYS.map(inputFieldId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a non-input field yields null so the handler ignores it rather than guessing", () => {
    expect(inputKeyOfField(JOB_FORM_FIELDS.name)).toBeNull();
    expect(inputKeyOfField("input_")).toBeNull();
    expect(inputKeyOfField("")).toBeNull();
  });

  test("an input field naming a key NO workflow allows resolves to null", () => {
    // Fail-closed: only keys the store would accept can arrive at all.
    expect(inputKeyOfField("input_needsreview")).toBeNull();
    expect(inputKeyOfField("input_when")).toBeNull();
  });
});

// ── The form's inverse ──────────────────────────────────────────────

describe("draftFromFormPayload", () => {
  test("folds a full create submission into a draft the store accepts", () => {
    const { jobId, scope, draft } = draftFromFormPayload({
      [JOB_FORM_FIELDS.name]: "Docs",
      [JOB_FORM_FIELDS.description]: "d",
      [JOB_FORM_FIELDS.workflow]: "docs-factory",
      [JOB_FORM_FIELDS.enabled]: ENABLED_YES,
      [inputFieldId("globs")]: "src/**",
    });
    expect(jobId).toBeNull();
    // An unmarked payload reads as the JOB scope — the one that carries
    // every field, so it cannot be used to skip a check by omission.
    expect(scope).toBe(EDIT_SCOPE_JOB);
    // NO `trigger` key: the job form does not carry one, and inventing
    // `{kind:"manual"}` here is exactly the hardcode that used to make a
    // background trigger inexpressible from the console.
    expect(draft).toEqual({
      name: "Docs",
      description: "d",
      workflow: "docs-factory",
      input: { globs: "src/**" },
      enabled: true,
    });
    // End to end: the store's ONE validator accepts what this produced,
    // and applies its own documented `undefined → manual` default.
    const validated = validateJobDraft(draft);
    expect(validated.ok).toBe(true);
    expect(validated.ok && validated.value.trigger).toEqual({ kind: "manual" });
  });

  test("a schedule submission carries the trigger fields VERBATIM, uncoerced", () => {
    // Still not a validator: the bounds ride through as the strings the
    // wire carries, because `validateJobDraft` already accepts a numeric
    // string and two coercions of one rule is how the two drift.
    const { scope, draft } = draftFromFormPayload({
      [JOB_FORM_FIELDS.jobId]: "j1",
      [EDIT_SCOPE_FIELD]: EDIT_SCOPE_TRIGGER,
      [JOB_FORM_FIELDS.triggerKind]: "cron",
      [JOB_FORM_FIELDS.triggerCron]: "0 3 * * *",
      [JOB_FORM_FIELDS.triggerTimezone]: "America/New_York",
      [JOB_FORM_FIELDS.triggerRunsPerDay]: "4",
      [JOB_FORM_FIELDS.triggerTokensPerRun]: "50000",
    });
    expect(scope).toBe(EDIT_SCOPE_TRIGGER);
    expect(draft.trigger).toEqual({
      kind: "cron",
      cron: "0 3 * * *",
      timezone: "America/New_York",
      maxRunsPerDay: "4",
      maxTokensPerRun: "50000",
    });
  });

  test("an unknown trigger kind rides through UNTOUCHED to the store's validator", () => {
    // Same rule the `workflow` select follows: a select constrains the UI,
    // never the wire, and letting the store reject it produces the real
    // message instead of this function inventing one.
    const { draft } = draftFromFormPayload({
      [JOB_FORM_FIELDS.triggerKind]: "sunrise",
    });
    expect(draft.trigger).toEqual({ kind: "sunrise" });
  });

  test("a hidden trigger field never arrives, so a manual save carries no stale cron", () => {
    // `visibleWhen` is load-bearing: the host OMITS a hidden field, so
    // switching the select back to `manual` cannot resubmit the cron
    // expression that was in the box a moment ago.
    const { draft } = draftFromFormPayload({
      [JOB_FORM_FIELDS.triggerKind]: "manual",
    });
    expect(draft.trigger).toEqual({ kind: "manual" });
    const validated = validateJobDraft({
      ...draft,
      name: "J",
      workflow: "docs-factory",
    });
    expect(validated.ok && validated.value.trigger).toEqual({ kind: "manual" });
  });

  test("an edit carries the job id from the action payload", () => {
    expect(draftFromFormPayload({ [JOB_FORM_FIELDS.jobId]: " j1 " }).jobId).toBe("j1");
  });

  test("an id the store would reject is dropped to null — a create, never a forged key", () => {
    // The alternative is passing `a:b` to `saveJob`, which splices ids into
    // storage keys. Refusing here means a malformed id cannot address
    // another job's key.
    for (const bad of ["a:b", "../x", "", "   ", 7, null]) {
      expect(draftFromFormPayload({ [JOB_FORM_FIELDS.jobId]: bad }).jobId).toBeNull();
    }
  });

  test("a hidden field never arrives, so its input key is simply absent", () => {
    // The host omits a hidden field from the payload. Selecting
    // draft-and-verify therefore cannot submit `globs`, which that
    // workflow's allowlist would reject.
    const { draft } = draftFromFormPayload({
      [JOB_FORM_FIELDS.name]: "V",
      [JOB_FORM_FIELDS.workflow]: "draft-and-verify",
      [inputFieldId("draft")]: "some text",
    });
    expect(draft.input).toEqual({ draft: "some text" });
    expect(validateJobDraft(draft).ok).toBe(true);
  });

  test("an EMPTY input value is omitted rather than stored as an empty string", () => {
    const { draft } = draftFromFormPayload({
      [JOB_FORM_FIELDS.name]: "D",
      [JOB_FORM_FIELDS.workflow]: "docs-factory",
      [inputFieldId("globs")]: "src/**",
      [inputFieldId("outPath")]: "",
    });
    expect(draft.input).toEqual({ globs: "src/**" });
  });

  test("`enabled` is true unless the select says otherwise", () => {
    const enabledFor = (v: unknown): unknown =>
      draftFromFormPayload({ [JOB_FORM_FIELDS.enabled]: v }).draft.enabled;
    expect(enabledFor(ENABLED_YES)).toBe(true);
    expect(enabledFor(ENABLED_NO)).toBe(false);
    // An absent or garbled select must not silently disable a job.
    expect(enabledFor(undefined)).toBe(true);
    expect(enabledFor("nonsense")).toBe(true);
  });

  test("an unknown workflow rides through UNTOUCHED for the store to reject", () => {
    // A select constrains the UI, never the wire. Two checkers of the same
    // rule is how the two drift — so this one does not check.
    const { draft } = draftFromFormPayload({
      [JOB_FORM_FIELDS.name]: "X",
      [JOB_FORM_FIELDS.workflow]: "ez-factory:docs-factory",
    });
    expect(draft.workflow).toBe("ez-factory:docs-factory");
    const result = validateJobDraft(draft);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("BARE name");
  });

  test("a non-object payload yields an empty draft the validator refuses", () => {
    for (const bad of [undefined, null, "str", 7, ["a"]]) {
      const { jobId, draft } = draftFromFormPayload(bad);
      expect(jobId).toBeNull();
      expect(validateJobDraft(draft).ok).toBe(false);
    }
  });

  test("a non-string field value is ignored rather than coerced", () => {
    const { draft } = draftFromFormPayload({
      [JOB_FORM_FIELDS.name]: 42,
      [inputFieldId("globs")]: 42,
    });
    expect(draft.name).toBe("");
    expect(draft.input).toEqual({});
  });

  test("a stray unknown field cannot smuggle a job field in", () => {
    // The store's shape is CLOSED, and this reads only the fields it knows,
    // so a payload key like `when` never reaches the draft at all.
    const { draft } = draftFromFormPayload({
      [JOB_FORM_FIELDS.name]: "X",
      [JOB_FORM_FIELDS.workflow]: "docs-factory",
      when: "always",
      skipDependents: "false",
    });
    expect(Object.keys(draft).sort()).toEqual([
      "description",
      "enabled",
      "input",
      "name",
      "workflow",
    ]);
    expect(validateJobDraft(draft).ok).toBe(true);
  });
});

describe("editScopeFromActionPayload", () => {
  test("reads the trigger scope only from the exact marker", () => {
    expect(
      editScopeFromActionPayload({ [EDIT_SCOPE_FIELD]: EDIT_SCOPE_TRIGGER }),
    ).toBe(EDIT_SCOPE_TRIGGER);
    expect(editScopeFromActionPayload({ [EDIT_SCOPE_FIELD]: EDIT_SCOPE_JOB })).toBe(
      EDIT_SCOPE_JOB,
    );
  });

  test("anything unrecognised reads as the JOB scope, which carries every field", () => {
    // Fails toward the scope that submits the whole job, so a garbled
    // marker cannot be used to skip a check by omission.
    for (const bad of [{}, { [EDIT_SCOPE_FIELD]: "TRIGGER" }, { [EDIT_SCOPE_FIELD]: 1 }, null, [], "trigger", undefined]) {
      expect(editScopeFromActionPayload(bad)).toBe(EDIT_SCOPE_JOB);
    }
  });
});

describe("triggerFormFields", () => {
  const cronJob = (): FactoryJob =>
    job({
      trigger: {
        kind: "cron",
        cron: "0 3 * * 1",
        timezone: "America/New_York",
        maxRunsPerDay: 4,
        maxTokensPerRun: 50_000,
      },
    });

  test("declares exactly the five trigger fields, all host-accepted slugs", () => {
    // A non-slug id is DROPPED host-side with nothing logged — the
    // `input_outPath` failure, one surface over. `trigger_maxRunsPerDay`
    // would simply not exist and the typed value would never arrive.
    const slug = /^[a-z0-9][a-z0-9_]{0,31}$/;
    const fields = triggerFormFields(job());
    expect(fields.map((f) => f.field)).toEqual([
      JOB_FORM_FIELDS.triggerKind,
      JOB_FORM_FIELDS.triggerCron,
      JOB_FORM_FIELDS.triggerTimezone,
      JOB_FORM_FIELDS.triggerRunsPerDay,
      JOB_FORM_FIELDS.triggerTokensPerRun,
    ]);
    for (const f of fields) expect(slug.test(f.field)).toBe(true);
  });

  test("offers only the kinds something actually dispatches", () => {
    // `event` and `workflow` are modelled by the store and dispatched by
    // nothing; offering them would build a job that saves and never fires.
    const options = triggerFormFields(job()).find(
      (f) => f.field === JOB_FORM_FIELDS.triggerKind,
    )!.options!;
    expect(options.map((o) => o.value)).toEqual([...OFFERED_TRIGGER_KINDS]);
    expect(options.map((o) => o.value)).not.toContain("event");
    expect(options.map((o) => o.value)).not.toContain("workflow");
    // The host caps a select at 12 options.
    expect(options.length).toBeLessThanOrEqual(12);
  });

  test("cron fields are gated on the cron kind; bounds on BOTH background kinds", () => {
    // A hidden field is omitted from the payload, so this wiring is what
    // makes "a manual job carries no bounds" true on the wire rather than
    // merely intended.
    const by = (id: string) => triggerFormFields(job()).find((f) => f.field === id)!;
    expect(by(JOB_FORM_FIELDS.triggerCron).visibleWhen).toEqual({
      field: JOB_FORM_FIELDS.triggerKind,
      equals: ["cron"],
    });
    expect(by(JOB_FORM_FIELDS.triggerTimezone).visibleWhen).toEqual({
      field: JOB_FORM_FIELDS.triggerKind,
      equals: ["cron"],
    });
    for (const id of [JOB_FORM_FIELDS.triggerRunsPerDay, JOB_FORM_FIELDS.triggerTokensPerRun]) {
      expect(by(id).visibleWhen).toEqual({
        field: JOB_FORM_FIELDS.triggerKind,
        equals: ["cron", "webhook"],
      });
    }
  });

  test("every visibleWhen names a field that is actually declared", () => {
    // `pruneDanglingConditions` DELETES a condition whose target is not in
    // the surviving field set, which would silently un-hide the field.
    const fields = triggerFormFields(job());
    const declared = new Set(fields.map((f) => f.field));
    for (const f of fields) {
      if (f.visibleWhen) expect(declared.has(f.visibleWhen.field)).toBe(true);
    }
  });

  test("a manual job prefills the kind and NOTHING else — no invented bounds", () => {
    // The two bounds are the blast-radius bound on unattended spend, and
    // core's own consent route refuses to default them for the same
    // reason: a default is a number nobody chose.
    const fields = triggerFormFields(job());
    const by = (id: string) => fields.find((f) => f.field === id)!;
    expect(by(JOB_FORM_FIELDS.triggerKind).value).toBe("manual");
    expect(by(JOB_FORM_FIELDS.triggerCron).value).toBeUndefined();
    expect(by(JOB_FORM_FIELDS.triggerTimezone).value).toBeUndefined();
    expect(by(JOB_FORM_FIELDS.triggerRunsPerDay).value).toBeUndefined();
    expect(by(JOB_FORM_FIELDS.triggerTokensPerRun).value).toBeUndefined();
    // …but the legal range IS stated, so the empty box is a question
    // rather than a puzzle.
    expect(by(JOB_FORM_FIELDS.triggerRunsPerDay).placeholder).toBe("1-20");
    expect(by(JOB_FORM_FIELDS.triggerTokensPerRun).placeholder).toBe("1-250000");
  });

  test("a cron job prefills every field, bounds as strings", () => {
    const by = (id: string) => triggerFormFields(cronJob()).find((f) => f.field === id)!;
    expect(by(JOB_FORM_FIELDS.triggerKind).value).toBe("cron");
    expect(by(JOB_FORM_FIELDS.triggerCron).value).toBe("0 3 * * 1");
    expect(by(JOB_FORM_FIELDS.triggerTimezone).value).toBe("America/New_York");
    expect(by(JOB_FORM_FIELDS.triggerRunsPerDay).value).toBe("4");
    expect(by(JOB_FORM_FIELDS.triggerTokensPerRun).value).toBe("50000");
  });

  test("a webhook job prefills its bounds and no cron fields", () => {
    const fields = triggerFormFields(
      job({ trigger: { kind: "webhook", maxRunsPerDay: 9, maxTokensPerRun: 1234 } }),
    );
    const by = (id: string) => fields.find((f) => f.field === id)!;
    expect(by(JOB_FORM_FIELDS.triggerKind).value).toBe("webhook");
    expect(by(JOB_FORM_FIELDS.triggerCron).value).toBeUndefined();
    expect(by(JOB_FORM_FIELDS.triggerTimezone).value).toBeUndefined();
    expect(by(JOB_FORM_FIELDS.triggerRunsPerDay).value).toBe("9");
    expect(by(JOB_FORM_FIELDS.triggerTokensPerRun).value).toBe("1234");
  });

  test("a kind the console does not offer falls back to manual rather than no match", () => {
    // A row written by some later version as `event`. The select shows
    // `manual`, which is the SAFE direction — saving it un-schedules.
    const fields = triggerFormFields(job({ trigger: { kind: "event", event: "run:complete" } }));
    expect(fields.find((f) => f.field === JOB_FORM_FIELDS.triggerKind)!.value).toBe("manual");
  });

  test("length hints stay inside the host's [1,500] clamp", () => {
    for (const f of triggerFormFields(cronJob())) {
      if (f.maxLength !== undefined) expect(f.maxLength).toBeLessThanOrEqual(500);
    }
  });
});

describe("candidateDraft — each form supplies half a job, the store supplies the rest", () => {
  const stored = (): FactoryJob =>
    job({
      name: "Nightly docs",
      description: "d",
      workflow: "docs-factory",
      input: { globs: "src/**" },
      enabled: true,
      trigger: {
        kind: "cron",
        cron: "0 3 * * 1",
        timezone: "UTC",
        maxRunsPerDay: 4,
        maxTokensPerRun: 50_000,
      },
    });

  test("THE SILENT UN-SCHEDULING: a job-form save PRESERVES the stored trigger", () => {
    // The trap the two-form split created. The job editor submits no
    // trigger field, so a draft folded straight from it carries no
    // `trigger`, `validateJobDraft` applies its documented
    // `undefined → manual` default, and renaming a cron job would
    // un-schedule it — no error, no warning, just `manual` in the Trigger
    // column the next time anyone looked.
    const submission = draftFromFormPayload({
      [JOB_FORM_FIELDS.jobId]: "j1",
      [EDIT_SCOPE_FIELD]: EDIT_SCOPE_JOB,
      [JOB_FORM_FIELDS.name]: "Renamed",
      [JOB_FORM_FIELDS.workflow]: "docs-factory",
      [JOB_FORM_FIELDS.enabled]: ENABLED_YES,
      [inputFieldId("globs")]: "src/**",
    });
    const draft = candidateDraft(submission, stored());
    expect(draft.name).toBe("Renamed");
    expect(draft.trigger).toEqual(stored().trigger);

    // …and the result is a WHOLE job the one validator accepts.
    const validated = validateJobDraft(draft);
    expect(validated.ok).toBe(true);
    expect(validated.ok && validated.value.trigger).toEqual(stored().trigger);
  });

  test("a trigger-form save keeps every field the OTHER form owns", () => {
    const submission = draftFromFormPayload({
      [JOB_FORM_FIELDS.jobId]: "j1",
      [EDIT_SCOPE_FIELD]: EDIT_SCOPE_TRIGGER,
      [JOB_FORM_FIELDS.triggerKind]: "webhook",
      [JOB_FORM_FIELDS.triggerRunsPerDay]: "2",
      [JOB_FORM_FIELDS.triggerTokensPerRun]: "100",
    });
    const draft = candidateDraft(submission, stored());
    // The schedule moved…
    expect(draft.trigger).toEqual({
      kind: "webhook",
      maxRunsPerDay: "2",
      maxTokensPerRun: "100",
    });
    // …and nothing else did. Without this the trigger form's empty name
    // box would blank the job's name, or fail validation outright.
    expect(draft.name).toBe("Nightly docs");
    expect(draft.description).toBe("d");
    expect(draft.workflow).toBe("docs-factory");
    expect(draft.input).toEqual({ globs: "src/**" });
    expect(draft.enabled).toBe(true);

    const validated = validateJobDraft(draft);
    expect(validated.ok).toBe(true);
    expect(validated.ok && validated.value.trigger).toEqual({
      kind: "webhook",
      maxRunsPerDay: 2,
      maxTokensPerRun: 100,
    });
  });

  test("a trigger-form save that names no kind un-schedules rather than half-writing", () => {
    // The safe direction: `undefined → manual` by the store's own default.
    const submission = draftFromFormPayload({
      [JOB_FORM_FIELDS.jobId]: "j1",
      [EDIT_SCOPE_FIELD]: EDIT_SCOPE_TRIGGER,
    });
    const draft = candidateDraft(submission, stored());
    expect(draft.trigger).toBeUndefined();
    const validated = validateJobDraft(draft);
    expect(validated.ok && validated.value.trigger).toEqual({ kind: "manual" });
  });

  test("a CREATE passes the submission through — there is no stored half to take", () => {
    const submission = draftFromFormPayload({
      [JOB_FORM_FIELDS.name]: "Fresh",
      [JOB_FORM_FIELDS.workflow]: "docs-factory",
    });
    expect(candidateDraft(submission, null)).toBe(submission.draft);
    const validated = validateJobDraft(candidateDraft(submission, null));
    expect(validated.ok && validated.value.trigger).toEqual({ kind: "manual" });
  });

  test("a job-scope submission that DOES name a trigger still wins over the stored one", () => {
    // The scope decides which half is authoritative, not the presence of a
    // stored value — otherwise a forged scope marker could pin a trigger
    // no form can change.
    const submission = draftFromFormPayload({
      [JOB_FORM_FIELDS.jobId]: "j1",
      [JOB_FORM_FIELDS.name]: "N",
      [JOB_FORM_FIELDS.workflow]: "docs-factory",
      [JOB_FORM_FIELDS.triggerKind]: "manual",
    });
    expect(candidateDraft(submission, stored()).trigger).toEqual({ kind: "manual" });
  });

  test("the assembled draft carries EXACTLY the store's six fields", () => {
    // The store's shape is CLOSED — an unknown key is a refusal, not a
    // dropped value — so an assembler that copied a stored bookkeeping
    // field (`lastRunAt`, `createdBy`) would fail every trigger save.
    const submission = draftFromFormPayload({
      [JOB_FORM_FIELDS.jobId]: "j1",
      [EDIT_SCOPE_FIELD]: EDIT_SCOPE_TRIGGER,
      [JOB_FORM_FIELDS.triggerKind]: "manual",
    });
    expect(Object.keys(candidateDraft(submission, stored())).sort()).toEqual([
      "description",
      "enabled",
      "input",
      "name",
      "trigger",
      "workflow",
    ]);
  });
});

// ── INVARIANT J — XSS sink discipline ───────────────────────────────
//
// The threat is NOT raw script injection: the `markdown` node IS
// DOMPurify-sanitized on render (HubComponentRenderer.svelte →
// web/src/lib/markdown.ts), so `<img onerror=…>` would be stripped. What
// survives DOMPurify is MARKDOWN ITSELF — its config allows `a` (href,
// target, rel) and `img` (src, referrerpolicy), so a job name containing
// `[click](…)` renders a live link and `![](…)` renders a beacon the
// viewer's browser fetches. On a tree that is SHARED across users, that is
// link spoofing and a read receipt.
//
// So the probe below is a markdown payload, not a script tag, and the rule
// is the same either way: no job- or run-derived string reaches the sink.

describe("invariant J — job/run strings never reach the markdown ({@html}) sink", () => {
  /**
   * A payload that is dangerous specifically BECAUSE it survives DOMPurify.
   * The sentinel keeps the substring search unambiguous against the trees'
   * static help text.
   */
  const PROBE = `[Approve this run](https://evil.example/ezf_probe) ![](https://evil.example/ezf_beacon.png) \`ezf_probe\``;

  /** A job whose every operator-authored field carries the payload. */
  const probeJob = job({
    name: PROBE,
    description: PROBE,
    input: { globs: PROBE, outPath: PROBE },
  });

  const probeRun = runRecord({
    jobId: probeJob.id,
    workflowName: PROBE,
    status: PROBE,
    workflowRunId: "wr-1",
  });

  /** Every node whose OWN content carries the payload. */
  function carriers(tree: { nodes: unknown[] }): Node[] {
    return allNodes(tree.nodes).filter((n) => ownContent(n).includes(PROBE));
  }

  /**
   * The shared WALK — it computes, it does not assert. Each test asserts on
   * the returned verdict itself, which is what makes a failure name the
   * property that broke instead of a line inside a helper, and keeps every
   * test's proof visible in its own body.
   */
  interface SinkVerdict {
    /** Vacuous-pass guard: the probe must actually BE somewhere, else
     *  "only in escaped nodes" is trivially and misleadingly true. */
    probeIsCarried: boolean;
    /** The load-bearing count. Non-zero the instant a builder routes one of
     *  these fields through `page.markdownBlock(...)`. */
    carriersInSink: number;
    /** Defence in depth — carrier node types outside the host-escaped set,
     *  which also catches a brand-new sink type nobody has thought of yet. */
    carriersNotEscaped: string[];
    /** The `carriersInSink` negative is only real if markdown nodes EXIST
     *  in this tree; on a tree with none it is true by construction. */
    markdownNodesExist: boolean;
    markdownCarryingProbe: number;
  }

  function sinkVerdict(tree: { nodes: unknown[] }): SinkVerdict {
    const hit = carriers(tree);
    const markdown = nodesOfType(tree, "markdown");
    return {
      probeIsCarried: hit.length > 0,
      carriersInSink: hit.filter((n) => n.type === "markdown").length,
      carriersNotEscaped: hit
        .map((n) => String(n.type))
        .filter((t) => !ESCAPED_PAGE_TYPES.has(t)),
      markdownNodesExist: markdown.length > 0,
      markdownCarryingProbe: markdown.filter((n) => ownContent(n).includes(PROBE)).length,
    };
  }

  /** The verdict a `factory` surface must produce: the probe is carried, and
   *  every carrier is an escaped node on a tree that really does emit
   *  markdown. */
  const SINK_FREE: SinkVerdict = {
    probeIsCarried: true,
    carriersInSink: 0,
    carriersNotEscaped: [],
    markdownNodesExist: true,
    markdownCarryingProbe: 0,
  };

  test("the jobs view routes name/description/inputs only into escaped nodes", () => {
    expect(
      sinkVerdict(buildFactoryPage({ view: { kind: "jobs" }, jobs: [probeJob], runs: [probeRun] })),
    ).toEqual(SINK_FREE);
  });

  test("the runs view routes workflow name and status only into escaped nodes", () => {
    expect(
      sinkVerdict(buildFactoryPage({ view: { kind: "runs" }, jobs: [probeJob], runs: [probeRun] })),
    ).toEqual(SINK_FREE);
  });

  test("the job editor routes prefills and the section title only into escaped nodes", () => {
    // The editor is the worst case: it renders every field VERBATIM as a
    // form prefill, which is exactly the content an attacker controls.
    const tree = buildJobPage({ view: { kind: "edit", jobId: probeJob.id }, job: probeJob });
    // The editor DOES emit a markdown node now — `TRIGGER_HELP`, on the
    // schedule form — so `markdownCarryingProbe: 0` is doing real work
    // here rather than being true because no sink exists. It was
    // `markdownNodesExist: false` before phase 9 added that form; the help
    // text is a module CONSTANT with no interpolation, which is the whole
    // rule (turn it into a template literal and a field has entered the
    // sink).
    expect(sinkVerdict(tree)).toEqual({
      probeIsCarried: true,
      carriersInSink: 0,
      carriersNotEscaped: [],
      markdownNodesExist: true,
      markdownCarryingProbe: 0,
    });
    // The editor carries the payload in the form node specifically.
    expect(carriers(tree).some((n) => n.type === "form")).toBe(true);
  });

  test("a BACKGROUND job's cron expression and bounds also stay out of the sink", () => {
    // The trigger label interpolates `job.trigger.cron` and
    // `job.trigger.timezone` into the jobs table and the stat strip. Both
    // were operator-typed, so a cron field carrying markdown is a real
    // shape — bounded by the store's validator, but this is the assertion
    // that says so rather than the assumption.
    const cronProbe: FactoryJob = {
      ...probeJob,
      trigger: {
        kind: "cron",
        cron: "0 3 * * *",
        timezone: PROBE,
        maxRunsPerDay: 4,
        maxTokensPerRun: 1000,
      },
    };
    expect(
      sinkVerdict(buildFactoryPage({ view: { kind: "jobs" }, jobs: [cronProbe], runs: [] })),
    ).toMatchObject({ probeIsCarried: true, carriersInSink: 0, carriersNotEscaped: [] });
    expect(
      sinkVerdict(buildJobPage({ view: { kind: "edit", jobId: cronProbe.id }, job: cronProbe })),
    ).toMatchObject({
      probeIsCarried: true,
      carriersInSink: 0,
      carriersNotEscaped: [],
      markdownCarryingProbe: 0,
    });
  });

  test("PROOF THE PROBE IS DANGEROUS: it is markdown that DOMPurify keeps", () => {
    // If the probe were inert, every assertion above would be theatre. Both
    // constructs are in the Hub's DOMPurify allow-list (`a` with href, `img`
    // with src), so reaching the sink really would produce a live link and a
    // browser-fetched beacon.
    expect(PROBE).toContain("](https://evil.example/");
    expect(PROBE).toContain("![](");
  });

  test("PROOF THE WALK REACHES THE SINK: a markdown node carrying the probe IS detected", () => {
    // The detector itself must be shown to work, or "no markdown node
    // carries the payload" could be passing because `carriers` is blind.
    const rigged = {
      nodes: [
        { type: "section", nodes: [{ type: "markdown", content: `x ${PROBE} y` }] },
      ],
    };
    const hit = carriers(rigged);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.type).toBe("markdown");
  });

  test("the static help text is a constant, so no field can ride into it", () => {
    // The only markdown these pages emit. Interpolating ANY value here is
    // how the invariant gets broken, so pin them as literals.
    for (const help of [CONSOLE_HELP, TEMPLATES_HELP, RUNS_HELP]) {
      expect(typeof help).toBe("string");
      expect(help).not.toContain(PROBE);
    }
  });
});

// ── INVARIANT K — the shared cached tree carries nothing private ────
//
// The page cache is keyed (extensionId, pageId, variant=projectId) with NO
// user dimension — `src/extensions/page-cache.ts` says so outright:
// "extension pages are per-extension, not per-user, so the cache can serve
// everyone." One render is served to every viewer.

describe("invariant K — the shared tree carries no user identity or run content", () => {
  const IDENTITY = "user-deadbeef-0000-1111";

  const identifiedJob = job({
    createdBy: IDENTITY,
    updatedBy: IDENTITY,
    runAs: { kind: "user", id: IDENTITY },
  });

  test("no user id reaches ANY node of the jobs view", () => {
    const tree = buildFactoryPage({
      view: { kind: "jobs" },
      jobs: [identifiedJob],
      runs: [runRecord()],
    });
    // Discrimination: the job really does carry the id, so the absence
    // below is the builder's doing and not the fixture's.
    expect(identifiedJob.createdBy).toBe(IDENTITY);
    expect(treeContent(tree)).not.toContain(IDENTITY);
  });

  test("no user id reaches the job editor either — not even as a read-only stat", () => {
    // The tempting feature is an "edited by" line. There is no per-viewer
    // filtering at this layer, so it would publish one user's id to
    // everyone with Hub access.
    const tree = buildJobPage({ view: { kind: "edit", jobId: "j1" }, job: identifiedJob });
    expect(treeContent(tree)).not.toContain(IDENTITY);
  });

  test("no user id reaches the runs view", () => {
    const tree = buildFactoryPage({
      view: { kind: "runs" },
      jobs: [identifiedJob],
      runs: [runRecord()],
    });
    expect(treeContent(tree)).not.toContain(IDENTITY);
  });

  test("run CONTENT is reachable only as a deep link, never inlined", () => {
    // The link leaks nothing the tree does not already publish: core's run
    // route enforces its own authorization, so a shared deep link only
    // opens for a viewer already entitled to it. Inlining a step output
    // would instead bake it into the cross-user cache.
    const tree = buildFactoryPage({
      view: { kind: "runs" },
      jobs: [job()],
      runs: [runRecord({ workflowRunId: "wr-9" })],
    });
    const row = firstTable(tree).rows[0]!;
    expect(row.href).toBe("/workflows/runs/wr-9");
    // The row's own cells are ids, statuses and times — bounded scalars.
    for (const cell of row.cells) {
      const text = typeof cell === "string" ? cell : (cell as { text: string }).text;
      expect(text.length).toBeLessThanOrEqual(300);
    }
  });

  test("run-derived PROSE never renders — not even the one free-text field the record carries", () => {
    // The identity assertions above do NOT reach invariant K's second half.
    // `suspendedReason` is the only free-text field on a `JobRunRecord`, and
    // the RUN writes it — an awaiting-approval reason names what is about to
    // be done. Rendering it would bake one run's prose into a tree that is
    // cached and served to every viewer, which is the same leak the
    // approvals inbox was cut for.
    //
    // Proven necessary by mutation: adding a "Reason" column carrying this
    // field passed every other test in this file.
    const REASON = "awaiting approval: publish CONFIDENTIAL-Q3 to the customer wiki";
    const suspended = runRecord({ status: "awaiting_approval", suspendedReason: REASON });
    // Discrimination: the record really does carry it, so the absence below
    // is the builder's doing and not the fixture's.
    expect(suspended.suspendedReason).toBe(REASON);

    const tree = buildFactoryPage({ view: { kind: "runs" }, jobs: [job()], runs: [suspended] });
    expect(treeContent(tree)).not.toContain(REASON);
    // And the column set is PINNED, so a future column cannot quietly open a
    // new channel for run content. A legitimately new column should fail
    // here and be added deliberately, having been checked against this rule.
    expect(firstTable(tree).columns).toEqual([
      "Job",
      "Workflow",
      "Status",
      "Started",
      "Finished",
      "Resumable",
    ]);
  });

  test("the approvals inbox is a LINK, never a rendered list", () => {
    // `pendingApprovals()` is per-acting-user by construction and each
    // entry names what is about to be done. Rendering it into this shared
    // tree would hand one user's parked decisions to every viewer — this
    // IS invariant K, which is why the inbox was cut from the console.
    const tree = buildFactoryPage({ view: { kind: "jobs" }, jobs: [job()], runs: [] });
    const links = nodesOfType(tree, "link");
    expect(links.map((n) => n.href)).toContain(APPROVALS_HREF);
    // Nothing in the tree renders an approval prompt or a relay line.
    expect(treeContent(tree).toLowerCase()).not.toContain("pending approval");
  });

  test("no builder emits a node type that could carry an unbounded blob", () => {
    // Every surface, walked: the only node types these pages produce are
    // the escaped ones plus the static markdown help.
    const trees = [
      buildFactoryPage({ view: { kind: "jobs" }, jobs: [job()], runs: [runRecord()] }),
      buildFactoryPage({ view: { kind: "templates" }, jobs: [], runs: [] }),
      buildFactoryPage({ view: { kind: "runs" }, jobs: [job()], runs: [runRecord()] }),
      buildJobPage({ view: { kind: "edit", jobId: "j1" }, job: job() }),
    ];
    for (const tree of trees) {
      for (const n of allNodes(tree.nodes)) {
        const type = n.type as string;
        expect(ESCAPED_PAGE_TYPES.has(type) || type === "markdown").toBe(true);
      }
    }
  });
});

// ── The Run action (8.7) ────────────────────────────────────────────

describe("jobRunAction", () => {
  const job = (over: Partial<FactoryJob> = {}): FactoryJob => ({
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "Nightly",
    description: "",
    workflow: "etl-factory",
    input: {},
    trigger: { kind: "manual" },
    enabled: true,
    runAs: { kind: "user", id: "u1" },
    consentHash: null,
    createdBy: "u1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedBy: "u1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  });

  test("carries the job id under the SAME payload key the save action uses", () => {
    // One key, one reader (`jobIdFromActionPayload`). A second key here
    // would refuse every click in silence — the Hub answers `{ok:true}`
    // whatever the handler does with the payload.
    const action = jobRunAction(job());
    expect(action.event).toBe(JOB_RUN_EVENT);
    expect(action.payload).toEqual({ [JOB_FORM_FIELDS.jobId]: job().id });
    expect(jobIdFromActionPayload(action.payload)).toBe(job().id);
  });

  test("names the workflow in the confirm, because the console is SHARED", () => {
    // Invariant K: anyone with Hub access can edit this job list, so the
    // person clicking Run may not be the person who wrote the inputs.
    const action = jobRunAction(job({ workflow: "docs-factory" }));
    expect(action.confirm).toContain("docs-factory");
    expect(action.confirm).toMatch(/credits|spend/i);
  });
});

describe("the job editor's Run button", () => {
  const stored = (over: Partial<FactoryJob> = {}): FactoryJob => ({
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "Nightly",
    description: "",
    workflow: "etl-factory",
    input: {},
    trigger: { kind: "manual" },
    enabled: true,
    runAs: { kind: "user", id: "u1" },
    consentHash: null,
    createdBy: "u1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedBy: "u1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  });

  const buttons = (tree: HubPageTree): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = [];
    const walk = (nodes: unknown[]): void => {
      for (const n of nodes) {
        if (typeof n !== "object" || n === null) continue;
        const node = n as Record<string, unknown>;
        if (node.type === "button") out.push(node);
        if (Array.isArray(node.nodes)) walk(node.nodes);
      }
    };
    walk(tree.nodes);
    return out;
  };

  test("an ENABLED job gets one Run button wired to the run event", () => {
    const tree = buildJobPage({
      view: { kind: "edit", jobId: stored().id },
      job: stored(),
    });
    const found = buttons(tree);
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe("Run now");
    expect((found[0]?.action as { event: string }).event).toBe(JOB_RUN_EVENT);
  });

  test("a DISABLED job gets NO button — `enabled:false` is this console's retire", () => {
    const tree = buildJobPage({
      view: { kind: "edit", jobId: stored().id },
      job: stored({ enabled: false }),
    });
    expect(buttons(tree)).toEqual([]);
  });

  test("the CREATE form has no Run button — there is nothing saved to run", () => {
    expect(buttons(buildJobPage({ view: { kind: "new" }, job: null }))).toEqual([]);
  });
});

// ── the job → consent handoff ────────────────────────────────────────
//
// A delegation binds `(extension_id, job_ref)`. Before this link, the only
// way to make one was to read a job's id off this console and retype it
// into a free-text box on another page — and a single wrong character
// produces `DELEGATION_NOT_FOUND` at the first cron tick, audited with no
// `delegation_id`, on a surface that states it cannot show that denial.
// The whole feedback loop for the typo is an unattended job that quietly
// never runs. These tests are about carrying the id correctly, and about
// the link carrying nothing ELSE.

// Every background trigger arm carries `JobTriggerBounds` — a background job
// without bounds is unconstructible, not merely rejected. These tests are
// about the LINK and the editor, so the values only need to be valid, not
// meaningful. Shared by the two describes below.
const TRIGGER_BOUNDS = { maxRunsPerDay: 1, maxTokensPerRun: 50_000 } as const;
const CRON_TRIGGER = {
  kind: "cron",
  cron: "0 3 * * *",
  timezone: "UTC",
  ...TRIGGER_BOUNDS,
} as const;
const WEBHOOK_TRIGGER = { kind: "webhook", ...TRIGGER_BOUNDS } as const;

describe("delegationConsentHref", () => {
  const cron = (over: Partial<FactoryJob> = {}): FactoryJob =>
    job({ trigger: { ...CRON_TRIGGER }, ...over });

  test("names the extension, the job, the PREFIXED workflow and the trigger", () => {
    const href = delegationConsentHref(cron());
    expect(href).toBe(
      "/workflows/delegations?extensionId=ez-factory&jobRef=j1" +
        "&workflowName=ez-factory%3Adocs-factory&triggerKind=cron",
    );
  });

  test("the workflow name is PREFIXED — a bare template name matches nothing in core", () => {
    // A job stores `docs-factory`; the host prefixes before resolving, so
    // the bare form names no workflow core could ever select. Getting this
    // wrong is silent: the link opens, the workflow field is refused, and
    // the person is left wondering which of the two pages is broken.
    const href = delegationConsentHref(cron()) ?? "";
    expect(new URL(href, "https://x").searchParams.get("workflowName")).toBe(
      `${EXTENSION_NAME}:docs-factory`,
    );
  });

  test("carries the job's OWN id as the job reference", () => {
    const href = delegationConsentHref(cron({ id: "aaaa-bbbb" })) ?? "";
    expect(new URL(href, "https://x").searchParams.get("jobRef")).toBe("aaaa-bbbb");
  });

  test("a MANUAL job gets no link — a human-started run spends no standing authority", () => {
    expect(delegationConsentHref(job({ trigger: { kind: "manual" } }))).toBeNull();
  });

  test("a `workflow`-triggered job gets no link — core's surface cannot grant it", () => {
    // Emitting a link this builder KNOWS the far end will refuse would
    // spend the reader's trust on a dead end.
    expect(
      delegationConsentHref(
        job({ trigger: { kind: "workflow", onWorkflow: "other", onStatus: ["success"] } }),
      ),
    ).toBeNull();
  });

  test("every unattended trigger kind gets a link", () => {
    expect([...DELEGATABLE_TRIGGER_KINDS].sort()).toEqual(["cron", "event", "webhook"]);
    expect(delegationConsentHref(job({ trigger: { ...WEBHOOK_TRIGGER } })) ?? "").toContain(
      "triggerKind=webhook",
    );
    expect(
      delegationConsentHref(job({ trigger: { kind: "event", event: "thing.happened" } })) ?? "",
    ).toContain("triggerKind=event");
  });

  test("a hostile job id cannot break out of the query string", () => {
    // The id is store-validated, but this href is spliced by hand and the
    // host re-checks it with `isSafeInternalHref` on ingest — so the
    // encoding is asserted here rather than assumed twice over.
    const href = delegationConsentHref(cron({ id: "a&triggerKind=cron&x=/../evil" })) ?? "";
    expect(href.startsWith("/workflows/delegations?")).toBe(true);
    expect(href).not.toContain("/../");
    // Exactly four parameters survive: an injected fifth would be a link
    // that says one thing and prefills another.
    const params = new URL(href, "https://x").searchParams;
    expect([...params.keys()]).toEqual([
      "extensionId",
      "jobRef",
      "workflowName",
      "triggerKind",
    ]);
    expect(params.get("jobRef")).toBe("a&triggerKind=cron&x=/../evil");
    expect(params.get("triggerKind")).toBe("cron");
  });

  test("the href is host-internal and carries no origin", () => {
    const href = delegationConsentHref(cron()) ?? "";
    expect(href.startsWith(`${DELEGATIONS_HREF}?`)).toBe(true);
    expect(href.startsWith("//")).toBe(false);
    expect(href).not.toContain("\\");
  });
});

describe("the job editor's delegation link", () => {
  const hrefs = (tree: HubPageTree): string[] =>
    nodesOfType(tree, "link").map((n) => String((n as unknown as { href: string }).href));

  /** The href for a job that HAS one — asserted non-null at the call site so
   *  a builder that started returning `null` fails here loudly rather than
   *  making every `toContain(null)` below vacuously true. */
  const hrefOf = (j: FactoryJob): string => {
    const href = delegationConsentHref(j);
    expect(href).not.toBeNull();
    return href as string;
  };

  test("an unattended job's editor links out to core's consent surface", () => {
    const scheduled = job({ trigger: { ...CRON_TRIGGER } });
    const tree = buildJobPage({ view: { kind: "edit", jobId: scheduled.id }, job: scheduled });
    expect(hrefs(tree)).toContain(hrefOf(scheduled));
    const link = nodesOfType(tree, "link").find(
      (n) => (n as unknown as { href: string }).href === hrefOf(scheduled),
    ) as unknown as { label: string };
    expect(link.label).toBe("Let this run unattended…");
  });

  test("a MANUAL job's editor has no such link", () => {
    const tree = buildJobPage({ view: { kind: "edit", jobId: "j1" }, job: job() });
    expect(hrefs(tree).some((h) => h.startsWith(DELEGATIONS_HREF))).toBe(false);
  });

  test("the CREATE form has no such link — there is no job to delegate yet", () => {
    const tree = buildJobPage({ view: { kind: "new" }, job: null });
    expect(hrefs(tree).some((h) => h.startsWith(DELEGATIONS_HREF))).toBe(false);
  });

  test("a DISABLED unattended job still offers it — consent outlives a pause", () => {
    // `enabled:false` is this console's retire and it suppresses the Run
    // button, but consent is a separate axis: re-enabling a job whose
    // delegation was never granted would produce an unattended job that
    // silently never fires, which is the exact failure this link exists
    // to prevent.
    const paused = job({
      enabled: false,
      trigger: { ...CRON_TRIGGER },
    });
    const tree = buildJobPage({ view: { kind: "edit", jobId: paused.id }, job: paused });
    expect(hrefs(tree)).toContain(hrefOf(paused));
  });
});

describe("input fields render as the right control", () => {
  const fieldsByName = (): Map<string, Record<string, unknown>> =>
    new Map(
      jobFormFields(null).map((f) => [
        f.field,
        f as unknown as Record<string, unknown>,
      ]),
    );

  test("a single-value path is a single line, not a 3-row textarea", () => {
    // Every input used to be `multiline: true`, so "Output path" — one
    // filesystem path, where a newline is never correct — rendered as a
    // textarea that invited one.
    expect(fieldsByName().get(inputFieldId("outPath"))?.multiline).toBeUndefined();
  });

  test("the genuinely multi-line values stay textareas", () => {
    // `globs` is newline-separated by the tool's own schema; `draft` and
    // `sources` are documents.
    for (const key of ["globs", "draft", "sources"]) {
      expect(fieldsByName().get(inputFieldId(key))?.multiline).toBe(true);
    }
  });

  test("the allowlist and the rendered fields agree", () => {
    // Discrimination: a key added to `ALL_INPUT_KEYS` without a decision
    // about its control gets a single line, which is the safe default —
    // but the two lists must still describe the same set of keys.
    for (const key of MULTILINE_INPUT_KEYS) {
      expect(ALL_INPUT_KEYS).toContain(key);
    }
  });
});
