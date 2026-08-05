/**
 * ez-factory console Hub page — page-level e2e (mockApi, no Docker).
 *
 * ⚠️ THIS SUITE IS 100% MOCK-BACKEND. It stubs `/api/hub/pages*` with
 * hand-written trees and validates UI RENDERING and LINK WIRING only. It
 * does NOT start the render subprocess, the job store, or the workflow
 * runner, so it is NOT end-to-end validation of the extension. The real
 * logic is covered by the bun suites (`extensions/ez-factory/**`), and the
 * page builders specifically by `extensions/ez-factory/lib/page.test.ts`.
 * Precedent + conventions: `web/e2e/file-organizer-hub.spec.ts`.
 *
 * What this DOES prove, and the bun suite cannot: that the trees the
 * builders emit survive the real Hub shell — that `?view=` reaches the
 * render pull as a query param, that a row `href` becomes a navigable
 * link, and that the two links OUT (approvals inbox, workflows) point at
 * routes that exist rather than at 404s.
 *
 * NOT visual-evidence tagged, deliberately. `VISUAL_SURFACE_GLOBS`
 * (`scripts/check-visual-evidence.ts`) is route/layout `+page.svelte`,
 * `web/src/lib/components/**` and CSS; `extensions/ez-factory/**` matches
 * none of them, so the Visual evidence gate does not fire for this feature
 * and a capture-tagged spec here would be a no-op that still costs a
 * screenshot upload on every run.
 *
 * Note for the next author: `isEvidenceTaggedContent`
 * (`scripts/visual-evidence/select-specs.ts`) is a bare substring test, so
 * writing the tag token ANYWHERE in this file — even in a comment saying
 * the file does not use it — classifies the spec as capture-tagged and
 * hard-fails `src/__tests__/visual-evidence-covers.test.ts` for a missing
 * covers-map entry. Hence the circumlocution.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

const FACTORY = "ext:ez-factory:factory";
const JOB = "ext:ez-factory:job";

const listing = {
  pages: [
    { id: FACTORY, title: "Factory", kind: "ext" },
    { id: JOB, title: "Job", kind: "ext" },
  ],
};

/** The nav strip every view of the console carries. */
function nav() {
  return [
    { type: "link", label: "Jobs", href: `/hub/${encodeURIComponent(FACTORY)}` },
    { type: "link", label: "Templates", href: `/hub/${encodeURIComponent(FACTORY)}?view=templates` },
    { type: "link", label: "Recent runs", href: `/hub/${encodeURIComponent(FACTORY)}?view=runs` },
    { type: "link", label: "New job", href: `/hub/${encodeURIComponent(JOB)}` },
    { type: "link", label: "Approvals inbox", href: "/workflows/approvals" },
    { type: "link", label: "Workflows", href: "/workflows" },
  ];
}

function jobsTree(opts: { jobs?: boolean } = {}) {
  return {
    title: "ez-factory",
    nodes: [
      ...nav(),
      {
        type: "section",
        title: "Jobs",
        nodes: [
          {
            type: "markdown",
            content:
              "Jobs are **install-wide**: everyone with access to this Hub sees, and can edit, the same list.",
          },
          {
            type: "stats",
            items: [
              { label: "Jobs", value: opts.jobs ? "2" : "0" },
              { label: "Enabled", value: opts.jobs ? "1" : "0" },
              { label: "Runs recorded", value: "0" },
            ],
          },
          ...(opts.jobs
            ? [
                {
                  type: "table",
                  columns: ["Job", "Workflow", "Trigger", "Inputs", "State", "Last run"],
                  rows: [
                    {
                      cells: [
                        "Nightly docs",
                        "docs-factory",
                        "manual",
                        "globs=src/**/*.ts · outPath=docs/api.md",
                        { text: "✓ enabled", tone: "success" },
                        "2026-08-01 12:00 · completed",
                      ],
                      href: `/hub/${encodeURIComponent(JOB)}?view=job%3Aj1`,
                    },
                    {
                      cells: ["ETL nightly", "etl-factory", "manual", "—", "○ disabled", "—"],
                      href: `/hub/${encodeURIComponent(JOB)}?view=job%3Aj2`,
                    },
                    // A CRON job whose last unattended fire was refused
                    // because the authority behind it went stale. The cell
                    // is what `jobStateCell` emits for
                    // `lastFire.kind === "consent"`.
                    {
                      cells: [
                        "Weekly ETL",
                        "etl-factory",
                        "cron · 0 3 * * * · UTC · ≤5/day · ≤100000 tok/run",
                        "globs=src/**/*.ts",
                        { text: "✓ enabled · consent stale — re-authorize", tone: "warning" },
                        "2026-08-01 12:00 · success",
                      ],
                      href: `/hub/${encodeURIComponent(JOB)}?view=job%3Aj3`,
                    },
                    // …and one stopped by a BOUND rather than by anything
                    // being wrong. Deliberately untoned: a red cell here
                    // would train operators to ignore red cells.
                    {
                      cells: [
                        "Chatty ETL",
                        "etl-factory",
                        "cron · 0 * * * * · UTC · ≤5/day · ≤100000 tok/run",
                        "globs=src/**/*.ts",
                        "✓ enabled · paused by a limit",
                        "2026-08-01 12:00 · success",
                      ],
                      href: `/hub/${encodeURIComponent(JOB)}?view=job%3Aj4`,
                    },
                  ],
                },
              ]
            : [
                {
                  type: "empty-state",
                  title: "No jobs yet",
                  detail:
                    "Create one to pair a shipped workflow template with the inputs you want to run it with.",
                },
              ]),
        ],
      },
    ],
  };
}

function templatesTree() {
  return {
    title: "ez-factory",
    nodes: [
      ...nav(),
      {
        type: "section",
        title: "Shipped templates",
        nodes: [
          { type: "markdown", content: "These three workflows ship with the extension." },
          {
            type: "table",
            columns: ["Template", "What it does", "Job-settable inputs"],
            rows: [
              {
                cells: ["docs-factory", "Read source files, draft documentation…", "globs, outPath"],
                href: "/workflows/ez-factory%3Adocs-factory",
              },
              {
                cells: ["etl-factory", "Read a set of files, extract and normalise…", "globs, outPath"],
                href: "/workflows/ez-factory%3Aetl-factory",
              },
              {
                cells: ["draft-and-verify", "Verify one draft against its sources…", "draft, sources"],
                href: "/workflows/ez-factory%3Adraft-and-verify",
              },
            ],
          },
        ],
      },
    ],
  };
}

function runsTree() {
  return {
    title: "ez-factory",
    nodes: [
      ...nav(),
      {
        type: "section",
        title: "Recent runs",
        nodes: [
          {
            type: "markdown",
            content:
              "Each row opens that run's full trace — step outputs and artifacts live there, never on this shared page.",
          },
          {
            type: "table",
            columns: ["Job", "Workflow", "Status", "Started", "Finished", "Resumable"],
            rows: [
              {
                cells: [
                  "Nightly docs",
                  "ez-factory:docs-factory",
                  { text: "completed", tone: "success" },
                  "2026-08-01 12:00",
                  "2026-08-01 12:05",
                  "no",
                ],
                href: "/workflows/runs/wr-9",
              },
              {
                cells: [
                  "Nightly docs",
                  "ez-factory:docs-factory",
                  { text: "awaiting_approval", tone: "warning" },
                  "2026-08-01 11:00",
                  "—",
                  "yes",
                ],
                href: "/workflows/runs/wr-8",
              },
            ],
          },
        ],
      },
    ],
  };
}

function unknownViewTree() {
  return {
    title: "ez-factory",
    nodes: [
      ...nav(),
      {
        type: "empty-state",
        title: "Unknown view",
        detail: "That link points at a console view this version does not have.",
      },
    ],
  };
}

/** Serve the console page, dispatching on the `?view=` the shell forwards.
 *  Returns the views the shell actually asked for. */
async function routeConsole(page: import("@playwright/test").Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
  await page.route(`**/api/hub/pages/${encodeURIComponent(FACTORY)}*`, (route) => {
    const view = new URL(route.request().url()).searchParams.get("view") ?? "";
    asked.push(view);
    const tree =
      view === "templates"
        ? templatesTree()
        : view === "runs"
          ? runsTree()
          : view === ""
            ? jobsTree({ jobs: true })
            : unknownViewTree();
    return route.fulfill({ json: { page: tree, renderedAt: Date.now() } });
  });
  return asked;
}

test.describe("ez-factory console", () => {
  test("jobs view: stats, the install-wide warning, and one row per job", async ({
    page,
    mockApi,
  }) => {
    await mockApi({ projects: [proj] });
    await routeConsole(page);

    await page.goto(`/hub/${encodeURIComponent(FACTORY)}`);
    await expect(page.getByTestId("hub-page-title")).toHaveText("ez-factory");
    await expect(page.getByTestId("hub-node-stats")).toContainText("Jobs");
    // Jobs are global-scope with no per-job owner check; the page has to say so.
    await expect(page.getByTestId("hub-node-markdown")).toContainText("install-wide");
    await expect(page.getByTestId("hub-table-row")).toHaveCount(4);
    await expect(page.getByTestId("hub-node-table")).toContainText("Nightly docs");
    await expect(page.getByTestId("hub-node-table")).toContainText("✓ enabled");
    await expect(page.getByTestId("hub-node-table")).toContainText("○ disabled");
  });

  test("a job stopped by a STALE CONSENT says so, and differently from one a limit paused", async ({
    page,
    mockApi,
  }) => {
    // The operator-facing half of the unattended fire path. A cron job that
    // stops firing used to render exactly like one whose next tick had not
    // come round — and the two reasons that matter most had the SAME
    // appearance: "the authority you granted went stale, re-consent it" and
    // "a bound you chose paused it, nothing is wrong".
    //
    // The strings are produced by `jobStateCell`
    // (`extensions/ez-factory/lib/page.ts`) from a closed set this
    // extension authors; this asserts they survive the real Hub shell,
    // including the TONE, which is the part a builder unit test cannot see.
    await mockApi({ projects: [proj] });
    await routeConsole(page);
    await page.goto(`/hub/${encodeURIComponent(FACTORY)}`);

    const table = page.getByTestId("hub-node-table");
    await expect(table).toContainText("consent stale — re-authorize");
    await expect(table).toContainText("paused by a limit");

    // TONED differently, not merely worded differently — the shell puts the
    // cell's tone on `data-tone`, so this is the colour an operator sees.
    // The one that needs a human draws the eye; the one that is a bound
    // working as configured does not.
    const staleRow = page.getByTestId("hub-table-row").filter({ hasText: "Weekly ETL" });
    const quotaRow = page.getByTestId("hub-table-row").filter({ hasText: "Chatty ETL" });
    await expect(
      staleRow.getByTestId("hub-table-cell").filter({ hasText: "consent stale" }),
    ).toHaveAttribute("data-tone", "warning");
    await expect(
      quotaRow.getByTestId("hub-table-cell").filter({ hasText: "paused by a limit" }),
    ).toHaveAttribute("data-tone", "neutral");

    // And a healthy job carries no fire state at all — silence means
    // working, so the notice only ever appears when something needs saying.
    const healthy = page.getByTestId("hub-table-row").filter({ hasText: "Nightly docs" });
    await expect(healthy).not.toContainText("consent stale");
    await expect(healthy).not.toContainText("paused by a limit");
  });

  test("an empty install renders the empty state and NO table", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FACTORY)}*`, (route) =>
      route.fulfill({ json: { page: jobsTree({ jobs: false }), renderedAt: Date.now() } }),
    );

    await page.goto(`/hub/${encodeURIComponent(FACTORY)}`);
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("No jobs yet");
    await expect(page.getByTestId("hub-node-table")).toHaveCount(0);
  });

  test("a job row links into that job's editor", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await routeConsole(page);

    await page.goto(`/hub/${encodeURIComponent(FACTORY)}`);
    const link = page.getByTestId("hub-row-link").first();
    await expect(link).toHaveAttribute(
      "href",
      `/hub/${encodeURIComponent(JOB)}?view=job%3Aj1`,
    );
  });

  test("`?view=` reaches the render pull and selects the surface", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    const asked = await routeConsole(page);

    await page.goto(`/hub/${encodeURIComponent(FACTORY)}?view=templates`);
    await expect(page.getByTestId("hub-node-section")).toContainText("Shipped templates");
    await expect(page.getByTestId("hub-node-table")).toContainText("draft-and-verify");
    // The load-bearing wiring: the shell forwarded the view, so the
    // multiplexing is real and not a URL the extension never sees.
    expect(asked).toContain("templates");
  });

  test("templates link out to core's workflow UI under the NAMESPACED name", async ({
    page,
    mockApi,
  }) => {
    await mockApi({ projects: [proj] });
    await routeConsole(page);

    await page.goto(`/hub/${encodeURIComponent(FACTORY)}?view=templates`);
    await expect(page.getByTestId("hub-row-link").first()).toHaveAttribute(
      "href",
      "/workflows/ez-factory%3Adocs-factory",
    );
  });

  test("runs view: each row deep-links to core's run trace", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await routeConsole(page);

    await page.goto(`/hub/${encodeURIComponent(FACTORY)}?view=runs`);
    await expect(page.getByTestId("hub-node-table")).toContainText("awaiting_approval");
    const hrefs = await page.getByTestId("hub-row-link").evaluateAll((els) =>
      els.map((e) => e.getAttribute("href")),
    );
    expect(hrefs).toEqual(["/workflows/runs/wr-9", "/workflows/runs/wr-8"]);
  });

  test("the shell renders a run row as its cells plus a trace link, and nothing more", async ({
    page,
    mockApi,
  }) => {
    // NOT a proof of invariant K. The tree here is authored by this spec, so
    // "no run content in it" would be a fact about the fixture; the real
    // control is `lib/page.test.ts`'s "run-derived PROSE never renders",
    // which drives the BUILDER with a probe reason on the record.
    //
    // What this does prove is the other half, which no bun test can reach:
    // the Hub shell renders exactly the cells it was given and turns the row
    // `href` into a real anchor — so a builder that withholds run content
    // really does produce a page from which that content is unreachable
    // except through the authorized trace route.
    await mockApi({ projects: [proj] });
    await routeConsole(page);

    await page.goto(`/hub/${encodeURIComponent(FACTORY)}?view=runs`);
    // `toHaveText` with an array, NOT a one-shot `allInnerTexts()`: the
    // latter does not retry, so it can read the jobs tree still on screen
    // while the `?view=runs` pull is in flight. It did exactly that on the
    // first full-lane run and passed in isolation.
    await expect(
      page.getByTestId("hub-table-row").first().getByTestId("hub-table-cell"),
    ).toHaveText([
      "Nightly docs",
      "ez-factory:docs-factory",
      "completed",
      "2026-08-01 12:00",
      "2026-08-01 12:05",
      "no",
    ]);
    // The trace link is present — the ONE way run content is reachable.
    await expect(page.getByTestId("hub-row-link").first()).toHaveAttribute(
      "href",
      "/workflows/runs/wr-9",
    );
  });

  test("the approvals inbox and workflows are LINKS OUT, not rendered lists", async ({
    page,
    mockApi,
  }) => {
    // Both are deliberate: `pendingApprovals()` is per-acting-user and this
    // tree is shared (invariant K), and a forked workflow gets a bare name
    // the extension cannot run (B7).
    await mockApi({ projects: [proj] });
    await routeConsole(page);

    await page.goto(`/hub/${encodeURIComponent(FACTORY)}`);
    const links = page.getByTestId("hub-node-link");
    await expect(links.filter({ hasText: "Approvals inbox" })).toHaveAttribute(
      "href",
      "/workflows/approvals",
    );
    await expect(links.filter({ hasText: "Workflows" }).first()).toHaveAttribute(
      "href",
      "/workflows",
    );
  });

  test("an unrecognised ?view= renders an honest empty state, not an error card", async ({
    page,
    mockApi,
  }) => {
    await mockApi({ projects: [proj] });
    await routeConsole(page);

    await page.goto(`/hub/${encodeURIComponent(FACTORY)}?view=nonsense`);
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("Unknown view");
    await expect(page.getByTestId("hub-error-card")).toHaveCount(0);
  });
});
