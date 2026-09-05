/**
 * ez-factory: fire a saved job FROM THE CONSOLE, for real, and find the run
 * again.
 *
 * ## Why this spec is in the real-auth tier and not the mock one
 *
 * `web/e2e/ez-factory-console.spec.ts` stubs `/api/hub/pages*` with
 * hand-written trees. It proves the Hub SHELL renders what a builder emits,
 * and it structurally cannot prove any of the things this feature is about:
 * it never starts the render subprocess, never touches the job store, never
 * reaches the workflow runner and never writes a `workflow_runs` row. The
 * whole reason this work exists is that everything here had previously been
 * verified in isolation and against hand-written trees, and the job layer
 * turned out not to be wired to anything at all.
 *
 * So this one runs against a built server, a real PGlite DB, the real
 * source import, isolated build, human-approved release and real executor, and
 * asserts the chain end to end:
 *
 *   create a job through the console's own form
 *     -> click the console's own Run button (through its confirm dialog)
 *     -> a real `workflow_runs` row exists, carrying `jobRef` = the job id
 *     -> the console's Recent-runs tab shows that run, named by its job.
 *
 * ## What it deliberately does NOT assert
 *
 * The run's terminal STATUS. `etl-factory`'s first step is a real
 * `read_files` tool step, and the agent step after it resolves a model from
 * the install's provider config — which a fresh harness DB does not have.
 * A run that ends `error` at the agent step proves every link in the chain
 * above exactly as well as one that ends `success`, because the
 * `workflow_runs` row, its `job_ref` and the console's view of it are all
 * written before the agent step is ever reached. Asserting a terminal status
 * here would be asserting that this harness has model credentials, which is
 * a fact about the harness and not about the feature.
 *
 * What IS asserted about status is the thing that can actually regress: the
 * status the console renders is the status the host reports. That is read
 * from the API and compared to the cell, rather than pinned to a literal.
 */
import type { Page, APIRequestContext } from "@playwright/test";
import { test, expect } from "../fixtures/hydration.js";
import { importAndActivateBundledExtension } from "../fixtures/extension-v4";
import { acceptMemberInvitation } from "../fixtures/member-session";

const FACTORY_PAGE = "ext:ez-factory:factory";
const JOB_PAGE = "ext:ez-factory:job";

/** Long enough for the bundled subprocess to spawn and the executor to write
 *  the `running` row; short enough to fail fast when the wiring is broken. */
const RUN_APPEARS_TIMEOUT_MS = 45_000;

interface ApiRun {
  id: string;
  workflowName: string;
  status: string;
  jobRef: string | null;
}

/** The caller's own workflow runs, newest first, straight from core. */
async function apiRuns(request: APIRequestContext): Promise<ApiRun[]> {
  const res = await request.get("/api/workflows/runs?limit=50");
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { runs?: ApiRun[] };
  return body.runs ?? [];
}

/** Open a console view and wait for the extension's tree to arrive. A Hub
 *  page is a render pull into a subprocess, so the first paint is the
 *  loading shell, not the tree. */
async function openConsole(page: Page, view?: string): Promise<void> {
  const suffix = view === undefined ? "" : `?view=${view}`;
  await page.goto(`/hub/${encodeURIComponent(FACTORY_PAGE)}${suffix}`);
  await expect(page.getByTestId("hub-page-title")).toHaveText("ez-factory", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("hub-error-card")).toHaveCount(0);
}

test.describe("ez-factory — a job fired from the console produces a correlated run", () => {
  test("create, run, and find the run again by its job", async ({ page, request, browser, baseURL }) => {
    test.setTimeout(360000);
    const installed = await importAndActivateBundledExtension({ page, request, baseURL: baseURL!, name: "ez-factory" });
    try {
    const member = await browser.newContext({ baseURL });
    try {
      await acceptMemberInvitation(request, member.request, "Workflow Privacy Member");
      for (const query of ["type=workflow&q=ez-factory", "q=ez-factory"]) {
        const ownerResponse = await request.get(`/api/mentions/search?${query}`);
        expect(ownerResponse.status(), await ownerResponse.text()).toBe(200);
        const ownerResults = await ownerResponse.json() as Array<{ name: string; kind: string }>;
        expect(ownerResults.some(result => result.kind === "workflow" && result.name === "ez-factory:etl-factory")).toBe(true);
        const memberResponse = await member.request.get(`/api/mentions/search?${query}`);
        expect(memberResponse.status(), await memberResponse.text()).toBe(200);
        expect((await memberResponse.json() as Array<{ name: string; kind: string }>).filter(result => result.kind === "workflow" && result.name.startsWith("ez-factory:"))).toEqual([]);
      }
    } finally { await member.close(); }
    // ── 1. Create a job through the console's own editor ──────────────
    //
    // Not seeded through storage: the point is that the console can be
    // written to, which is a property of the `job-save` grant, the form
    // node surviving `validatePageTree`, and the events route accepting
    // the POST. Seeding would skip all three.
    await page.goto(`/hub/${encodeURIComponent(JOB_PAGE)}`);
    await expect(page.getByTestId("hub-page-title")).toHaveText("ez-factory — job", {
      timeout: 30_000,
    });

    // A CREATE renders exactly ONE form. The schedule form appears only
    // once the job exists — a background trigger is inert until a human
    // consents to a delegation for it, and there is nothing to consent
    // against without a job id.
    const form = page.getByTestId("hub-inline-form");
    await expect(form).toHaveCount(1);
    await expect(form).toBeVisible();

    const jobName = `e2e run correlation ${Date.now()}`;
    await page.getByTestId("hub-inline-field-name").fill(jobName);
    await page
      .getByTestId("hub-inline-field-description")
      .fill("Fired by the real-auth e2e to prove job -> run correlation.");
    await page.getByTestId("hub-inline-field-workflow").selectOption("etl-factory");
    // `outPath` must be a SINGLE-LINE input — the fix for the nit where
    // every input rendered as a 3-row textarea. Asserted structurally, so
    // a regression to `multiline: true` fails here rather than only
    // looking wrong.
    const outPath = page.getByTestId("hub-inline-field-input_outpath");
    await expect(outPath).toHaveJSProperty("tagName", "INPUT");
    await outPath.fill(".ezcorp/extension-data/ez-factory/e2e-out.json");
    // `globs` genuinely is newline-separated, so it stays a textarea.
    const globs = page.getByTestId("hub-inline-field-input_globs");
    await expect(globs).toHaveJSProperty("tagName", "TEXTAREA");
    await globs.fill("package.json");

    const savedResponse = page.waitForResponse(response => response.url().endsWith("/api/extensions/ez-factory/events/job-save") && response.request().method() === "POST");
    await page.getByTestId("hub-inline-form-submit").click();
    const saved = await savedResponse;
    expect(saved.status(), await saved.text()).toBe(200);

    await openConsole(page);
    await expect(page.getByTestId("hub-node-table")).toContainText(jobName, {
      timeout: 30_000,
    });

    // ── 2. Fire it from the console ──────────────────────────────────
    //
    // The row's own anchor, not the `<tr>`: the Hub renders a row `href`
    // as a link INSIDE the row, so clicking the cell area navigates
    // nowhere. Same affordance a user clicks; different element.
    await page
      .getByTestId("hub-table-row")
      .filter({ hasText: jobName })
      .getByTestId("hub-row-link")
      .click();
    await expect(page.getByTestId("hub-page-title")).toHaveText("ez-factory — job", {
      timeout: 30_000,
    });
    // `.first()` because an EXISTING job's editor renders TWO sections —
    // the job and "When it fires". The job's own section is the first, and
    // it is the one titled with the job name.
    await expect(page.getByTestId("hub-node-section").first()).toContainText(jobName, {
      timeout: 30_000,
    });
    // The schedule form is there and defaults to `manual`: the console
    // creates an attended job and scheduling is a deliberate second act.
    await expect(page.getByTestId("hub-inline-form")).toHaveCount(2);
    await expect(page.getByTestId("hub-inline-field-trigger_kind")).toHaveValue("manual");
    // Neither bound is rendered for a manual job, and a hidden field is
    // OMITTED from the payload — which is what makes "only a background
    // trigger carries bounds" true on the wire rather than merely intended.
    await expect(page.getByTestId("hub-inline-field-trigger_runs_per_day")).toHaveCount(0);
    await expect(page.getByTestId("hub-inline-field-trigger_tokens_per_run")).toHaveCount(0);

    // The job id is what the run must correlate to. Read it off the
    // editor's own stats block, so the assertion below compares the
    // console's idea of the job to the host's idea of the run.
    const stats = page.getByTestId("hub-node-stats");
    await expect(stats).toContainText("Job id");
    const jobId = (await stats.innerText())
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^[0-9a-f-]{36}$/i.test(line));
    expect(jobId, "the editor renders the job id").toBeTruthy();

    const runsBefore = await apiRuns(request);
    expect(runsBefore.some((r) => r.jobRef === jobId)).toBe(false);

    const runButton = page.getByTestId("hub-node-button").filter({ hasText: "Run now" });
    await expect(runButton).toBeVisible();
    await runButton.click();

    // The confirm dialog is host-rendered and names the workflow — a
    // shared console must not fire real spend on one click.
    const dialog = page.getByTestId("hub-confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("etl-factory");
    await page.getByTestId("hub-confirm-ok").click();

    // ── 3. A real run exists, and it names the job ───────────────────
    let correlated: ApiRun | undefined;
    await expect
      .poll(
        async () => {
          correlated = (await apiRuns(request)).find((r) => r.jobRef === jobId);
          return correlated && ["success", "error", "cancelled"].includes(correlated.status) ? correlated.id : null;
        },
        {
          timeout: RUN_APPEARS_TIMEOUT_MS,
          message: "a settled workflow_runs row carrying this job's id as job_ref before opening its render-time history snapshot",
        },
      )
      .not.toBeNull();
    expect(correlated?.workflowName).toBe("ez-factory:etl-factory");

    // ── 4. The console shows it, attributed to the job ───────────────
    //
    // This is the tab that read "No runs recorded" after eight real runs.
    // It is populated by the render-time reconcile, which folds back only
    // runs the host attributes to a known job by that same `jobRef`.
    await openConsole(page, "runs");
    const runRow = page.getByTestId("hub-table-row").filter({ hasText: jobName });
    await expect(runRow).toHaveCount(1, { timeout: 30_000 });
    const cells = runRow.getByTestId("hub-table-cell");
    await expect(cells.nth(0)).toHaveText(jobName);
    await expect(cells.nth(1)).toHaveText("ez-factory:etl-factory");

    const live = (await apiRuns(request)).find((r) => r.id === correlated?.id);
    expect(live, "the run is still readable").toBeTruthy();
    await expect(cells.nth(2)).toHaveText(live!.status);

    // The row deep-links to that exact run's trace — the only route by
    // which anything the run produced is reachable from this shared page.
    await expect(runRow.getByTestId("hub-row-link")).toHaveAttribute(
      "href",
      `/workflows/runs/${correlated!.id}`,
    );
    } finally {
      await installed.client.extensionControl("extensions_release", { action: "uninstall", installationId: installed.state.installation.id, idempotencyKey: crypto.randomUUID() });
    }
  });
});
