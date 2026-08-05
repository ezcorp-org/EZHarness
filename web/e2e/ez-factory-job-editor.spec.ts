/**
 * ez-factory job editor Hub page — page-level e2e (mockApi, no Docker).
 *
 * ⚠️ THIS SUITE IS 100% MOCK-BACKEND. `/api/hub/pages*` (render) and
 * `/api/extensions/ez-factory/events/job-save` (action) are stubbed with
 * hand-written trees and `{ok}` envelopes. It does NOT run the render
 * subprocess, the job store, or `validateJobDraft` — those are covered by
 * `extensions/ez-factory/lib/*.test.ts` and `boot.test.ts`.
 *
 * What this DOES prove, and no bun test can: the host's INLINE FORM
 * semantics that the whole editor design leans on. Specifically that
 * `visibleWhen` really does hide a field live as a select changes, and
 * that a hidden field is OMITTED from the submitted payload. That omission
 * carries two separate invariants:
 *
 *   1. The UI agrees with the job store's per-workflow input allowlist
 *      (invariant B) instead of submitting a key the store would refuse.
 *   2. (phase 9) A manual job cannot carry `maxRunsPerDay` /
 *      `maxTokensPerRun` at all, so "only a background trigger has bounds"
 *      is enforced by the wire rather than by a check someone could forget.
 *
 * Both are asserted against the SCHEMA in the bun suite and against the
 * real renderer only here.
 *
 * The editor renders TWO forms for an existing job — the job and its
 * schedule — because `validateFormNode` caps a form at 10 fields and drops
 * the excess silently. Both POST the same granted `ez-factory:job-save`
 * and are told apart by `edit_scope` on the action payload.
 *
 * EXTENSION page actions POST to `/api/extensions/<ext>/events/<event>`
 * with `{source:"hub", pageId, payload}` (NOT the core `/actions/` route);
 * the response carries no inline tree, so the open tab re-pulls the render.
 *
 * NOT visual-evidence tagged — see the header of
 * `ez-factory-console.spec.ts` for why, including the substring-match
 * footgun that makes naming the tag token here a build failure.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

const FACTORY = "ext:ez-factory:factory";
const JOB = "ext:ez-factory:job";
const SAVE_EVENT = "**/api/extensions/ez-factory/events/job-save";

const listing = {
  pages: [
    { id: FACTORY, title: "Factory", kind: "ext" },
    { id: JOB, title: "Job", kind: "ext" },
  ],
};

interface JobFixture {
  id?: string;
  name?: string;
  description?: string;
  workflow?: string;
  enabled?: string;
  globs?: string;
  outPath?: string;
  draft?: string;
  sources?: string;
  /** The schedule form's prefills. Absent → a manual job, which is what a
   *  create always is (there is nothing to consent against until the job
   *  has an id). */
  triggerKind?: string;
  cron?: string;
  timezone?: string;
  runsPerDay?: string;
  tokensPerRun?: string;
}

/**
 * The editor's form node, mirroring `jobFormFields` — including the
 * LOWERCASED input field ids (`input_outpath`, not `input_outPath`): a
 * non-slug field id is dropped host-side with no fall-back.
 */
function jobFormNode(job: JobFixture | null) {
  const value = (v: string | undefined) => (v === undefined ? {} : { value: v });
  return {
    type: "form",
    submitLabel: job ? "Save job" : "Create job",
    action: {
      event: "ez-factory:job-save",
      ...(job ? { payload: { job_id: job.id ?? "j1", edit_scope: "job" } } : {}),
    },
    fields: [
      { field: "name", label: "Name", maxLength: 80, ...value(job?.name) },
      {
        field: "description",
        label: "Description",
        multiline: true,
        maxLength: 500,
        ...value(job?.description),
      },
      {
        field: "workflow",
        label: "Workflow",
        options: [
          { value: "docs-factory", label: "docs-factory" },
          { value: "etl-factory", label: "etl-factory" },
          { value: "draft-and-verify", label: "draft-and-verify" },
        ],
        ...value(job?.workflow),
      },
      {
        field: "enabled",
        label: "Enabled",
        options: [
          { value: "yes", label: "Enabled" },
          { value: "no", label: "Disabled" },
        ],
        value: job?.enabled ?? "yes",
      },
      {
        field: "input_globs",
        label: "Source globs (one per line)",
        multiline: true,
        visibleWhen: { field: "workflow", equals: ["docs-factory", "etl-factory"] },
        ...value(job?.globs),
      },
      {
        field: "input_outpath",
        label: "Output path",
        multiline: true,
        visibleWhen: { field: "workflow", equals: ["docs-factory", "etl-factory"] },
        ...value(job?.outPath),
      },
      {
        field: "input_draft",
        label: "Draft to verify",
        multiline: true,
        visibleWhen: { field: "workflow", equals: ["draft-and-verify"] },
        ...value(job?.draft),
      },
      {
        field: "input_sources",
        label: "Sources to verify against",
        multiline: true,
        visibleWhen: { field: "workflow", equals: ["draft-and-verify"] },
        ...value(job?.sources),
      },
    ],
  };
}

/**
 * The SCHEDULE form, mirroring `triggerFormFields`.
 *
 * A second form, and the reason is a hard host bound: `validateFormNode`
 * caps a form at 10 fields and DROPS the excess silently, after which
 * `pruneDanglingConditions` strips `visibleWhen` from any survivor whose
 * target was dropped. The editor above already declares 8. Both forms
 * dispatch the SAME granted `ez-factory:job-save` and are told apart by
 * `edit_scope` on the action payload — a third page action would be a real
 * grant widening across three files to buy a split the payload already
 * expresses.
 */
function triggerFormNode(job: JobFixture) {
  const value = (v: string | undefined) => (v === undefined ? {} : { value: v });
  return {
    type: "form",
    submitLabel: "Save schedule",
    action: {
      event: "ez-factory:job-save",
      payload: { job_id: job.id ?? "j1", edit_scope: "trigger" },
    },
    fields: [
      {
        field: "trigger_kind",
        label: "Fires",
        options: [
          { value: "manual", label: "Manual — someone presses Run" },
          { value: "cron", label: "Cron — on a schedule" },
          { value: "webhook", label: "Webhook — when something calls in" },
        ],
        value: job.triggerKind ?? "manual",
      },
      {
        field: "trigger_cron",
        label: "Cron expression — 5 fields: min hour dom month dow",
        maxLength: 120,
        placeholder: "0 3 * * *",
        visibleWhen: { field: "trigger_kind", equals: ["cron"] },
        ...value(job.cron),
      },
      {
        field: "trigger_timezone",
        label: "Time zone — an IANA name",
        maxLength: 64,
        placeholder: "America/New_York",
        visibleWhen: { field: "trigger_kind", equals: ["cron"] },
        ...value(job.timezone),
      },
      {
        field: "trigger_runs_per_day",
        label: "Most runs per day",
        placeholder: "1-20",
        visibleWhen: { field: "trigger_kind", equals: ["cron", "webhook"] },
        ...value(job.runsPerDay),
      },
      {
        field: "trigger_tokens_per_run",
        label: "Most tokens per run",
        placeholder: "1-250000",
        visibleWhen: { field: "trigger_kind", equals: ["cron", "webhook"] },
        ...value(job.tokensPerRun),
      },
    ],
  };
}

function editorTree(job: JobFixture | null) {
  return {
    title: "ez-factory — job",
    nodes: [
      { type: "link", label: "Back to jobs", href: `/hub/${encodeURIComponent(FACTORY)}` },
      {
        type: "section",
        title: job ? (job.name ?? "Nightly docs") : "New job",
        nodes: [
          ...(job
            ? [
                {
                  type: "stats",
                  items: [
                    { label: "Job id", value: job.id ?? "j1" },
                    { label: "Workflow", value: job.workflow ?? "docs-factory" },
                    { label: "Trigger", value: "manual" },
                    { label: "Updated", value: "2026-08-01 12:00" },
                    { label: "Last run", value: "—" },
                  ],
                },
              ]
            : []),
          jobFormNode(job),
        ],
      },
      // Only for a job that EXISTS: a background trigger is inert until a
      // human consents to a delegation for it, and there is nothing to
      // consent against until the job has an id.
      ...(job
        ? [
            {
              type: "section",
              title: "When it fires",
              nodes: [
                { type: "markdown", markdown: "**Manual** jobs run when someone presses Run." },
                triggerFormNode(job),
                ...(job.triggerKind === "cron" || job.triggerKind === "webhook"
                  ? [
                      {
                        type: "empty-state",
                        title: "Saved, not yet armed",
                        detail:
                          "A background trigger fires only after someone authorizes it in the workflow UI.",
                      },
                    ]
                  : []),
              ],
            },
          ]
        : []),
    ],
  };
}

function notFoundTree() {
  return {
    title: "ez-factory — job",
    nodes: [
      { type: "link", label: "Back to jobs", href: `/hub/${encodeURIComponent(FACTORY)}` },
      {
        type: "empty-state",
        title: "Job not found",
        detail: "No job with that id is saved on this install.",
      },
    ],
  };
}

/** Serve the editor, dispatching on `?view=`. */
async function routeEditor(
  page: import("@playwright/test").Page,
  job: JobFixture | null,
): Promise<void> {
  await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
  await page.route(`**/api/hub/pages/${encodeURIComponent(JOB)}*`, (route) => {
    const view = new URL(route.request().url()).searchParams.get("view") ?? "";
    const tree =
      view === "job:missing" ? notFoundTree() : view === "" ? editorTree(null) : editorTree(job);
    return route.fulfill({ json: { page: tree, renderedAt: Date.now() } });
  });
}

/** Capture the LAST save POST's body. Both forms post to the same event. */
async function captureSave(page: import("@playwright/test").Page): Promise<() => unknown> {
  let body: unknown = null;
  await page.route(SAVE_EVENT, async (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  return () => body;
}

/** The job editor's form, then the schedule's. Order is the render order. */
const jobForm = (page: import("@playwright/test").Page) =>
  page.getByTestId("hub-inline-form").nth(0);
const scheduleForm = (page: import("@playwright/test").Page) =>
  page.getByTestId("hub-inline-form").nth(1);

test.describe("ez-factory job editor", () => {
  test("a create renders ONE form — there is no schedule to set until the job exists", async ({
    page,
    mockApi,
  }) => {
    // A background trigger is inert until a human consents to a delegation
    // for it, and there is nothing to consent against without a job id. So
    // a create is attended by construction and the schedule form appears
    // only once the job has been saved.
    await mockApi({ projects: [proj] });
    await routeEditor(page, null);

    await page.goto(`/hub/${encodeURIComponent(JOB)}`);
    await expect(page.getByTestId("hub-page-title")).toHaveText("ez-factory — job");
    await expect(page.getByTestId("hub-inline-form")).toHaveCount(1);
    await expect(page.getByTestId("hub-inline-field-name")).toHaveValue("");
    await expect(page.getByTestId("hub-inline-form-submit")).toHaveText("Create job");
    await expect(page.getByTestId("hub-inline-field-trigger_kind")).toHaveCount(0);
  });

  test("an edit prefills every field and offers Save", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await routeEditor(page, {
      id: "j1",
      name: "Nightly docs",
      description: "Regenerate the API reference",
      workflow: "docs-factory",
      globs: "src/**/*.ts",
      outPath: "docs/api.md",
    });

    await page.goto(`/hub/${encodeURIComponent(JOB)}?view=job%3Aj1`);
    await expect(page.getByTestId("hub-inline-field-name")).toHaveValue("Nightly docs");
    await expect(page.getByTestId("hub-inline-field-description")).toHaveValue(
      "Regenerate the API reference",
    );
    await expect(page.getByTestId("hub-inline-field-workflow")).toHaveValue("docs-factory");
    await expect(page.getByTestId("hub-inline-field-input_globs")).toHaveValue("src/**/*.ts");
    await expect(jobForm(page).getByTestId("hub-inline-form-submit")).toHaveText("Save job");
    // …and the schedule rides in its own form below it.
    await expect(page.getByTestId("hub-inline-form")).toHaveCount(2);
    await expect(scheduleForm(page).getByTestId("hub-inline-form-submit")).toHaveText(
      "Save schedule",
    );
  });

  test("visibleWhen hides the other workflow's inputs LIVE as the select changes", async ({
    page,
    mockApi,
  }) => {
    // The design's load-bearing behaviour. `docs-factory` accepts
    // globs/outPath; `draft-and-verify` accepts draft/sources. The fields
    // swap without a re-render round trip.
    await mockApi({ projects: [proj] });
    await routeEditor(page, null);

    await page.goto(`/hub/${encodeURIComponent(JOB)}`);
    await page.getByTestId("hub-inline-field-workflow").selectOption("docs-factory");
    await expect(page.getByTestId("hub-inline-field-input_globs")).toBeVisible();
    await expect(page.getByTestId("hub-inline-field-input_draft")).toHaveCount(0);

    await page.getByTestId("hub-inline-field-workflow").selectOption("draft-and-verify");
    await expect(page.getByTestId("hub-inline-field-input_draft")).toBeVisible();
    await expect(page.getByTestId("hub-inline-field-input_globs")).toHaveCount(0);
  });

  test("INVARIANT B: a hidden field is OMITTED from the submitted payload", async ({
    page,
    mockApi,
  }) => {
    // This is why `visibleWhen` was chosen over disabling. A hidden field
    // is absent, not empty, so switching to draft-and-verify cannot submit
    // a `globs` the store's per-workflow allowlist would refuse. Asserted
    // here against the REAL renderer; the schema half is in the bun suite.
    await mockApi({ projects: [proj] });
    await routeEditor(page, null);
    const saved = await captureSave(page);

    await page.goto(`/hub/${encodeURIComponent(JOB)}`);
    // Type into a docs-factory field FIRST, then switch away from it.
    await page.getByTestId("hub-inline-field-workflow").selectOption("docs-factory");
    await page.getByTestId("hub-inline-field-input_globs").fill("src/**/*.ts");
    await page.getByTestId("hub-inline-field-workflow").selectOption("draft-and-verify");
    await page.getByTestId("hub-inline-field-name").fill("Verify the draft");
    await page.getByTestId("hub-inline-field-input_draft").fill("the draft body");
    await page.getByTestId("hub-inline-form-submit").click();

    await expect.poll(saved).not.toBeNull();
    const body = saved() as { source: string; pageId: string; payload: Record<string, string> };
    expect(body.source).toBe("hub");
    expect(body.pageId).toBe("job");
    expect(body.payload.workflow).toBe("draft-and-verify");
    expect(body.payload.input_draft).toBe("the draft body");
    // The retained value is still in the widget's local state — and still
    // absent from the wire. That is the whole invariant.
    expect(body.payload).not.toHaveProperty("input_globs");
    expect(body.payload).not.toHaveProperty("input_outpath");
  });

  test("an edit's save carries the job id from the ACTION payload, not a typed field", async ({
    page,
    mockApi,
  }) => {
    // Payload keys the operator cannot retype are the ones that should not
    // be typeable — there is no `job_id` input in the form.
    await mockApi({ projects: [proj] });
    await routeEditor(page, { id: "j1", name: "Nightly docs", workflow: "docs-factory" });
    const saved = await captureSave(page);

    await page.goto(`/hub/${encodeURIComponent(JOB)}?view=job%3Aj1`);
    await expect(page.getByTestId("hub-inline-field-job_id")).toHaveCount(0);
    await page.getByTestId("hub-inline-field-name").fill("Renamed");
    await jobForm(page).getByTestId("hub-inline-form-submit").click();

    await expect.poll(saved).not.toBeNull();
    const body = saved() as { payload: Record<string, string> };
    expect(body.payload.job_id).toBe("j1");
    expect(body.payload.name).toBe("Renamed");
    // The scope marker travels with it. Both forms POST the same granted
    // event, so this is what tells the one handler which half arrived —
    // and therefore which half to take from the stored job.
    expect(body.payload.edit_scope).toBe("job");
    // The job form carries NO trigger field, which is exactly why the
    // handler has to preserve the stored schedule: a draft folded straight
    // from this payload would default to `manual` and silently un-schedule
    // a cron job on a rename.
    expect(body.payload).not.toHaveProperty("trigger_kind");
    expect(body.payload).not.toHaveProperty("trigger_cron");
  });

  test("a stale link to a deleted job renders 'not found' and NO form", async ({
    page,
    mockApi,
  }) => {
    // A form here would let a stale link silently create a NEW job.
    await mockApi({ projects: [proj] });
    await routeEditor(page, null);

    await page.goto(`/hub/${encodeURIComponent(JOB)}?view=job%3Amissing`);
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("Job not found");
    await expect(page.getByTestId("hub-inline-form")).toHaveCount(0);
  });

  test("the schedule form's cron fields appear ONLY for the cron kind, live", async ({
    page,
    mockApi,
  }) => {
    // Same `visibleWhen` mechanism the input fields lean on, one form over,
    // and asserted against the REAL renderer for the same reason: the
    // schema half is in the bun suite, the live-swap half only exists here.
    await mockApi({ projects: [proj] });
    await routeEditor(page, { id: "j1", name: "Nightly docs", workflow: "docs-factory" });

    await page.goto(`/hub/${encodeURIComponent(JOB)}?view=job%3Aj1`);
    // A manual job shows the kind select and nothing else.
    await expect(page.getByTestId("hub-inline-field-trigger_kind")).toHaveValue("manual");
    await expect(page.getByTestId("hub-inline-field-trigger_cron")).toHaveCount(0);
    await expect(page.getByTestId("hub-inline-field-trigger_runs_per_day")).toHaveCount(0);

    await page.getByTestId("hub-inline-field-trigger_kind").selectOption("cron");
    await expect(page.getByTestId("hub-inline-field-trigger_cron")).toBeVisible();
    await expect(page.getByTestId("hub-inline-field-trigger_timezone")).toBeVisible();
    await expect(page.getByTestId("hub-inline-field-trigger_runs_per_day")).toBeVisible();
    await expect(page.getByTestId("hub-inline-field-trigger_tokens_per_run")).toBeVisible();

    // A webhook has no schedule to state, but still has both bounds — the
    // two things that bound unattended spend do not depend on the kind.
    await page.getByTestId("hub-inline-field-trigger_kind").selectOption("webhook");
    await expect(page.getByTestId("hub-inline-field-trigger_cron")).toHaveCount(0);
    await expect(page.getByTestId("hub-inline-field-trigger_timezone")).toHaveCount(0);
    await expect(page.getByTestId("hub-inline-field-trigger_runs_per_day")).toBeVisible();
    await expect(page.getByTestId("hub-inline-field-trigger_tokens_per_run")).toBeVisible();
  });

  test("a cron schedule submits its expression, zone and BOTH bounds", async ({
    page,
    mockApi,
  }) => {
    // The end-to-end shape the store's validator is built to receive:
    // every value a string, both bounds present, and the scope marker that
    // says the other five job fields come from disk.
    await mockApi({ projects: [proj] });
    await routeEditor(page, { id: "j1", name: "Nightly docs", workflow: "docs-factory" });
    const saved = await captureSave(page);

    await page.goto(`/hub/${encodeURIComponent(JOB)}?view=job%3Aj1`);
    await page.getByTestId("hub-inline-field-trigger_kind").selectOption("cron");
    await page.getByTestId("hub-inline-field-trigger_cron").fill("0 3 * * 1");
    await page.getByTestId("hub-inline-field-trigger_timezone").fill("America/New_York");
    await page.getByTestId("hub-inline-field-trigger_runs_per_day").fill("4");
    await page.getByTestId("hub-inline-field-trigger_tokens_per_run").fill("50000");
    await scheduleForm(page).getByTestId("hub-inline-form-submit").click();

    await expect.poll(saved).not.toBeNull();
    const body = saved() as { pageId: string; payload: Record<string, string> };
    expect(body.pageId).toBe("job");
    expect(body.payload.job_id).toBe("j1");
    expect(body.payload.edit_scope).toBe("trigger");
    expect(body.payload.trigger_kind).toBe("cron");
    expect(body.payload.trigger_cron).toBe("0 3 * * 1");
    expect(body.payload.trigger_timezone).toBe("America/New_York");
    expect(body.payload.trigger_runs_per_day).toBe("4");
    expect(body.payload.trigger_tokens_per_run).toBe("50000");
  });

  test("THE BOUND: switching back to manual OMITS the bounds from the wire", async ({
    page,
    mockApi,
  }) => {
    // The reason `visibleWhen` was chosen over disabling, restated for the
    // trigger: a hidden field is ABSENT, not empty. So a manual job cannot
    // carry `maxRunsPerDay` at all — the store's rule that only a
    // background trigger has bounds is enforced by the wire rather than by
    // a check that could be forgotten. And symmetrically, a cron typed and
    // then abandoned cannot ride along on a manual save.
    await mockApi({ projects: [proj] });
    await routeEditor(page, {
      id: "j1",
      name: "Nightly docs",
      workflow: "docs-factory",
      triggerKind: "cron",
      cron: "0 3 * * 1",
      timezone: "UTC",
      runsPerDay: "4",
      tokensPerRun: "50000",
    });
    const saved = await captureSave(page);

    await page.goto(`/hub/${encodeURIComponent(JOB)}?view=job%3Aj1`);
    await expect(page.getByTestId("hub-inline-field-trigger_cron")).toHaveValue("0 3 * * 1");
    await page.getByTestId("hub-inline-field-trigger_kind").selectOption("manual");
    await scheduleForm(page).getByTestId("hub-inline-form-submit").click();

    await expect.poll(saved).not.toBeNull();
    const body = saved() as { payload: Record<string, string> };
    expect(body.payload.trigger_kind).toBe("manual");
    expect(body.payload).not.toHaveProperty("trigger_cron");
    expect(body.payload).not.toHaveProperty("trigger_timezone");
    expect(body.payload).not.toHaveProperty("trigger_runs_per_day");
    expect(body.payload).not.toHaveProperty("trigger_tokens_per_run");
  });

  test("a background job says out loud that saving it armed nothing", async ({
    page,
    mockApi,
  }) => {
    // Saving a schedule mints no authority — a `workflow_delegations` row
    // does, and only a human can create one. Without this line the console
    // would show a job whose Trigger reads `cron · 0 3 * * 1` and which
    // never runs, and the only clue would be an empty Recent-runs tab.
    await mockApi({ projects: [proj] });
    await routeEditor(page, {
      id: "j1",
      name: "Nightly docs",
      workflow: "docs-factory",
      triggerKind: "cron",
      cron: "0 3 * * 1",
      timezone: "UTC",
      runsPerDay: "4",
      tokensPerRun: "50000",
    });

    await page.goto(`/hub/${encodeURIComponent(JOB)}?view=job%3Aj1`);
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("Saved, not yet armed");
    await expect(page.getByTestId("hub-node-empty-state")).toContainText(
      "authorizes it in the workflow UI",
    );
  });

  test("a MANUAL job shows no 'not yet armed' notice — there is nothing to arm", async ({
    page,
    mockApi,
  }) => {
    // The negative half. A notice on every job would be noise, and noise
    // is how the one that matters stops being read.
    await mockApi({ projects: [proj] });
    await routeEditor(page, { id: "j1", name: "Nightly docs", workflow: "docs-factory" });

    await page.goto(`/hub/${encodeURIComponent(JOB)}?view=job%3Aj1`);
    await expect(page.getByTestId("hub-inline-field-trigger_kind")).toHaveValue("manual");
    await expect(page.getByTestId("hub-node-empty-state")).toHaveCount(0);
  });

  test("the editor links back to the console", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await routeEditor(page, null);

    await page.goto(`/hub/${encodeURIComponent(JOB)}`);
    await expect(page.getByTestId("hub-node-link").first()).toHaveAttribute(
      "href",
      `/hub/${encodeURIComponent(FACTORY)}`,
    );
  });
});
