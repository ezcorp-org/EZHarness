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
 * `visibleWhen` really does hide a field live as the `workflow` select
 * changes, and that a hidden field is OMITTED from the submitted payload.
 * That omission is what makes the UI agree with the job store's
 * per-workflow input allowlist (invariant B) instead of submitting a key
 * the store would refuse — a claim asserted against the SCHEMA in the bun
 * suite and against the real renderer only here.
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
      ...(job ? { payload: { job_id: job.id ?? "j1" } } : {}),
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

/** Capture the one save POST's body. */
async function captureSave(page: import("@playwright/test").Page): Promise<() => unknown> {
  let body: unknown = null;
  await page.route(SAVE_EVENT, async (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  return () => body;
}

test.describe("ez-factory job editor", () => {
  test("a create renders ONE form with an empty name and a Create button", async ({
    page,
    mockApi,
  }) => {
    await mockApi({ projects: [proj] });
    await routeEditor(page, null);

    await page.goto(`/hub/${encodeURIComponent(JOB)}`);
    await expect(page.getByTestId("hub-page-title")).toHaveText("ez-factory — job");
    // "One inline form, one Save" — a second would mean two save paths.
    await expect(page.getByTestId("hub-inline-form")).toHaveCount(1);
    await expect(page.getByTestId("hub-inline-field-name")).toHaveValue("");
    await expect(page.getByTestId("hub-inline-form-submit")).toHaveText("Create job");
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
    await expect(page.getByTestId("hub-inline-form-submit")).toHaveText("Save job");
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
    await page.getByTestId("hub-inline-form-submit").click();

    await expect.poll(saved).not.toBeNull();
    const body = saved() as { payload: Record<string, string> };
    expect(body.payload.job_id).toBe("j1");
    expect(body.payload.name).toBe("Renamed");
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
