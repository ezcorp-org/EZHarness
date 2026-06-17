/**
 * file-organizer Hub — page-level e2e (mockApi + emitSse, no Docker).
 *
 * Drives the user-visible flow across the 3 pages against mocked
 * `/api/hub/pages*` (render) + `/api/extensions/file-organizer/events/*`
 * (action) routes. The applier/CAS/grant logic is covered by the bun
 * suites; here the mocks return already-validated trees + `{ok}` action
 * envelopes.
 *
 * EXTENSION page actions POST to `/api/extensions/<ext>/events/<event>`
 * with `{source:"hub", pageId, payload}` (NOT the core `/actions/` route);
 * the response is `{ok, message}` (no inline tree), so the open tab
 * re-pulls the render endpoint — we serve the updated tree on the 2nd pull.
 * Follows web/e2e/hub.spec.ts conventions (data-testid hooks).
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

const OVERVIEW = "ext:file-organizer:overview";
const REVIEW = "ext:file-organizer:review";
const FOLDERS = "ext:file-organizer:folders";

const listing = {
  pages: [
    { id: OVERVIEW, title: "File Organizer", kind: "ext" },
    { id: REVIEW, title: "Review", kind: "ext" },
    { id: FOLDERS, title: "Folders & Rules", kind: "ext" },
  ],
};

/** Extension action endpoint for a bare event suffix. */
function evt(suffix: string): string {
  return `**/api/extensions/file-organizer/events/${suffix}`;
}

// ── Tree fixtures (plain JSON — mocks return validated trees) ────────

function overviewTree(opts: { pending: number; unclassified: number; running?: boolean }) {
  const nodes: unknown[] = [
    { type: "section", nodes: [{ type: "status", label: opts.running === false ? "Watcher stopped" : "Watcher running", state: opts.running === false ? "warning" : "success" }] },
    { type: "stats", items: [
      { label: "Pending review", value: String(opts.pending) },
      { label: "Unclassified", value: String(opts.unclassified) },
      { label: "Quarantined", value: "0" },
      { label: "Applied today", value: "0" },
    ] },
    { type: "link", label: "Open review", href: "/hub/ext%3Afile-organizer%3Areview" },
  ];
  if (opts.unclassified > 0) {
    nodes.push({
      type: "section",
      title: "Needs your attention",
      nodes: [
        { type: "markdown", content: `${opts.unclassified} file(s) don't match any rule.` },
        { type: "table", columns: ["File"], rows: [{ cells: ["/watched/mystery.xyz"], action: { event: "file-organizer:focus", payload: { proposalId: "u1" } } }] },
        { type: "button", label: "Teach a rule", action: { event: "file-organizer:teach-rule", prompt: { label: "Rule", field: "rule" } } },
      ],
    });
  }
  return { title: "File Organizer", nodes };
}

function reviewMovesTree(label = "") {
  return {
    title: "Review",
    nodes: [
      ...(label ? [{ type: "section", title: "Last action", nodes: [{ type: "status", label, state: "success" }] }] : []),
      { type: "stats", items: [{ label: "Pending", value: "2" }, { label: "Quarantined", value: "0" }] },
      { type: "section", title: "Route to Images", nodes: [
        { type: "kv", pairs: [{ key: "From", value: "/watched/a.png" }, { key: "To", value: "/watched/Images/a.png" }] },
        { type: "button", label: "Accept", style: "primary", action: { event: "file-organizer:accept", payload: { proposalId: "m1" } } },
        { type: "button", label: "Reject", style: "secondary", action: { event: "file-organizer:reject", payload: { proposalId: "m1" } } },
      ] },
    ],
  };
}

function reviewDeletesTree() {
  return {
    title: "Review",
    nodes: [
      { type: "section", title: "Pending deletes", nodes: [
        { type: "table", columns: ["File", "Reason"], rows: [{ cells: ["/watched/junk.tmp", "junk"] }] },
        { type: "button", label: "Confirm these 1 deletes", style: "primary", action: { event: "file-organizer:confirm-deletes", confirm: "Move 1 file(s) to quarantine (restorable)?" } },
      ] },
    ],
  };
}

function reviewAutoBatchTree() {
  return {
    title: "Review",
    nodes: [
      { type: "section", nodes: [
        { type: "status", label: "Auto-organized 0 file(s), quarantined 2", state: "success" },
        { type: "button", label: "Undo last auto-batch", style: "danger", action: { event: "file-organizer:undo-batch", payload: { batchId: "batch-1" } } },
      ] },
    ],
  };
}

function reviewQuarantineTree(empty = false) {
  return {
    title: "Review",
    nodes: empty
      ? [{ type: "section", title: "Quarantine", nodes: [{ type: "empty-state", title: "Quarantine is empty" }] }]
      : [{ type: "section", title: "Quarantine", nodes: [
          { type: "table", columns: ["Original", "Expires in", "Size"], rows: [{ cells: ["/watched/old.bak", "29d", "12 B"], action: { event: "file-organizer:focus", payload: { quarantineId: "q1" } } }] },
          { type: "button", label: "Restore all", style: "secondary", action: { event: "file-organizer:restore", payload: { all: true } } },
        ] }],
  };
}

function foldersTree(opts: { folders?: boolean; mode?: string; preset?: boolean } = {}) {
  if (!opts.folders) {
    return {
      title: "Folders & Rules",
      nodes: [
        { type: "section", nodes: [
          { type: "button", label: "Add watched folder", style: "primary", action: { event: "file-organizer:add-folder", prompt: { label: "Folder path", placeholder: "/watched/Downloads", field: "path" } } },
          { type: "button", label: "Add ignore", style: "secondary", action: { event: "file-organizer:add-ignore", prompt: { label: "Ignore path or name", field: "path" } } },
        ] },
        { type: "empty-state", title: "No folders watched" },
      ],
    };
  }
  return {
    title: "Folders & Rules",
    nodes: [
      { type: "section", nodes: [
        { type: "button", label: "Add ignore", style: "secondary", action: { event: "file-organizer:add-ignore", payload: { folderId: "f1" }, prompt: { label: "Ignore", field: "path" } } },
      ] },
      { type: "section", title: "/watched/Downloads", nodes: [
        { type: "kv", pairs: [{ key: "Mode", value: opts.mode ?? "ask-everything" }, { key: "Presets", value: opts.preset ? "junk-sweep" : "none" }] },
        { type: "section", title: "Mode", nodes: [
          { type: "button", label: "Ask", style: opts.mode === "fully-auto" ? "secondary" : "primary", action: { event: "file-organizer:set-mode", payload: { folderId: "f1", mode: "ask-everything" } } },
          { type: "button", label: "Auto", style: opts.mode === "fully-auto" ? "primary" : "secondary", action: { event: "file-organizer:set-mode", payload: { folderId: "f1", mode: "fully-auto" } } },
        ] },
        { type: "section", title: "Presets", nodes: [
          { type: "button", label: `${opts.preset ? "✓ " : ""}junk-sweep`, style: opts.preset ? "primary" : "secondary", action: { event: "file-organizer:toggle-preset", payload: { folderId: "f1", preset: "junk-sweep" } } },
        ] },
      ] },
    ],
  };
}

// ── Tests ───────────────────────────────────────────────────────────

test.describe("file-organizer Hub", () => {
  test("overview: status + stats + the unclassified alert table render", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(OVERVIEW)}`, (route) =>
      route.fulfill({ json: { page: overviewTree({ pending: 3, unclassified: 1, running: true }), renderedAt: Date.now() } }),
    );

    await page.goto(`/hub/${encodeURIComponent(OVERVIEW)}`);
    await expect(page.getByTestId("hub-page-title")).toHaveText("File Organizer");
    await expect(page.getByTestId("hub-node-status").first()).toContainText("Watcher running");
    await expect(page.getByTestId("hub-node-stats")).toContainText("3");
    await expect(page.getByText("Needs your attention")).toBeVisible();
  });

  test("review: accept a move → POST events/accept {payload} → re-pull fresh tree", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let acceptBody: unknown = null;
    let renders = 0;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(REVIEW)}`, (route) => {
      renders++;
      return route.fulfill({ json: { page: reviewMovesTree(renders === 1 ? "" : "Applied"), renderedAt: Date.now() } });
    });
    await page.route(evt("accept"), async (route) => {
      acceptBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Applied" } });
    });

    await page.goto(`/hub/${encodeURIComponent(REVIEW)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Accept" }).click();
    // No inline page in the events response ⇒ the tab re-pulls the render.
    await expect(page.getByTestId("hub-node-status")).toContainText("Applied");
    expect(acceptBody).toEqual({ source: "hub", pageId: "review", payload: { proposalId: "m1" } });
    expect(renders).toBe(2);
  });

  test("review: reject a move POSTs events/reject", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let rejectBody: unknown = null;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(REVIEW)}`, (route) =>
      route.fulfill({ json: { page: reviewMovesTree(), renderedAt: Date.now() } }),
    );
    await page.route(evt("reject"), async (route) => {
      rejectBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Rejected" } });
    });

    await page.goto(`/hub/${encodeURIComponent(REVIEW)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Reject" }).click();
    await expect.poll(() => rejectBody).toEqual({ source: "hub", pageId: "review", payload: { proposalId: "m1" } });
  });

  test("review: batch-confirm deletes is confirm-gated then POSTs", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let confirmBody: unknown = null;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(REVIEW)}`, (route) =>
      route.fulfill({ json: { page: reviewDeletesTree(), renderedAt: Date.now() } }),
    );
    await page.route(evt("confirm-deletes"), async (route) => {
      confirmBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Quarantined 1" } });
    });

    await page.goto(`/hub/${encodeURIComponent(REVIEW)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Confirm these 1 deletes" }).click();
    await expect(page.getByTestId("hub-confirm-dialog")).toContainText("Move 1 file(s) to quarantine");
    await page.getByTestId("hub-confirm-ok").click();
    await expect.poll(() => confirmBody).toEqual({ source: "hub", pageId: "review" });
  });

  test("review: undo last auto-batch POSTs the batchId", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let undoBody: unknown = null;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(REVIEW)}`, (route) =>
      route.fulfill({ json: { page: reviewAutoBatchTree(), renderedAt: Date.now() } }),
    );
    await page.route(evt("undo-batch"), async (route) => {
      undoBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Restored 2" } });
    });

    await page.goto(`/hub/${encodeURIComponent(REVIEW)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Undo last auto-batch" }).click();
    await expect.poll(() => undoBody).toEqual({ source: "hub", pageId: "review", payload: { batchId: "batch-1" } });
  });

  test("review: restore from quarantine POSTs events/restore → re-pull empty tree", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let restoreBody: unknown = null;
    let renders = 0;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(REVIEW)}`, (route) => {
      renders++;
      return route.fulfill({ json: { page: reviewQuarantineTree(renders > 1), renderedAt: Date.now() } });
    });
    await page.route(evt("restore"), async (route) => {
      restoreBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Restored 1" } });
    });

    await page.goto(`/hub/${encodeURIComponent(REVIEW)}`);
    await expect(page.getByTestId("hub-node-table")).toContainText("/watched/old.bak");
    await page.getByTestId("hub-node-button").filter({ hasText: "Restore all" }).click();
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("Quarantine is empty");
    expect(restoreBody).toEqual({ source: "hub", pageId: "review", payload: { all: true } });
  });

  test("folders: add a folder via the prompt → POST events/add-folder {payload:{path}}", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let addBody: unknown = null;
    let renders = 0;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) => {
      renders++;
      return route.fulfill({ json: { page: foldersTree({ folders: renders > 1 }), renderedAt: Date.now() } });
    });
    await page.route(evt("add-folder"), async (route) => {
      addBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Folder added" } });
    });

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("No folders watched");
    await page.getByTestId("hub-node-button").filter({ hasText: "Add watched folder" }).click();
    await expect(page.getByTestId("hub-prompt-dialog")).toBeVisible();
    await page.getByTestId("hub-prompt-input").fill("/watched/Downloads");
    await page.getByTestId("hub-prompt-submit").click();
    await expect(page.getByText("/watched/Downloads")).toBeVisible();
    expect(addBody).toEqual({ source: "hub", pageId: "folders", payload: { path: "/watched/Downloads" } });
  });

  test("folders: set mode (Auto) POSTs events/set-mode", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let modeBody: unknown = null;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) =>
      route.fulfill({ json: { page: foldersTree({ folders: true }), renderedAt: Date.now() } }),
    );
    await page.route(evt("set-mode"), async (route) => {
      modeBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Mode set" } });
    });

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Auto" }).first().click();
    await expect.poll(() => modeBody).toEqual({ source: "hub", pageId: "folders", payload: { folderId: "f1", mode: "fully-auto" } });
  });

  test("folders: toggle a preset POSTs events/toggle-preset → re-pull shows the check", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let presetBody: unknown = null;
    let renders = 0;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) => {
      renders++;
      return route.fulfill({ json: { page: foldersTree({ folders: true, preset: renders > 1 }), renderedAt: Date.now() } });
    });
    await page.route(evt("toggle-preset"), async (route) => {
      presetBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Toggled" } });
    });

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "junk-sweep" }).click();
    await expect(page.getByText("✓ junk-sweep")).toBeVisible();
    expect(presetBody).toEqual({ source: "hub", pageId: "folders", payload: { folderId: "f1", preset: "junk-sweep" } });
  });

  test("folders: add an ignore via the prompt", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let ignoreBody: unknown = null;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) =>
      route.fulfill({ json: { page: foldersTree({ folders: true }), renderedAt: Date.now() } }),
    );
    await page.route(evt("add-ignore"), async (route) => {
      ignoreBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Ignore added" } });
    });

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Add ignore" }).click();
    await page.getByTestId("hub-prompt-input").fill("secrets");
    await page.getByTestId("hub-prompt-submit").click();
    await expect.poll(() => ignoreBody).toEqual({ source: "hub", pageId: "folders", payload: { folderId: "f1", path: "secrets" } });
  });

  test("unclassified: Teach-a-rule prompt POSTs the mini-DSL rule", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let teachBody: unknown = null;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(OVERVIEW)}`, (route) =>
      route.fulfill({ json: { page: overviewTree({ pending: 0, unclassified: 1, running: true }), renderedAt: Date.now() } }),
    );
    await page.route(evt("teach-rule"), async (route) => {
      teachBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Rule added" } });
    });

    await page.goto(`/hub/${encodeURIComponent(OVERVIEW)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Teach a rule" }).click();
    await page.getByTestId("hub-prompt-input").fill("*.xyz -> Misc");
    await page.getByTestId("hub-prompt-submit").click();
    await expect.poll(() => teachBody).toEqual({ source: "hub", pageId: "overview", payload: { rule: "*.xyz -> Misc" } });
  });

  test("live invalidation: an ext:page-state signal re-pulls the review tree", async ({ page, mockApi, emitSse }) => {
    await mockApi({ projects: [proj] });
    let renders = 0;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(REVIEW)}`, (route) => {
      renders++;
      return route.fulfill({ json: { page: reviewMovesTree(renders === 1 ? "" : "Refreshed"), renderedAt: Date.now() } });
    });

    await page.goto(`/hub/${encodeURIComponent(REVIEW)}`);
    await expect(page.getByTestId("hub-page-title")).toHaveText("Review");
    expect(renders).toBe(1);

    await emitSse({
      type: "ext:page-state",
      data: { extensionId: "ext-fo", extensionName: "file-organizer", pageId: "review", timestamp: Date.now() },
    });
    await expect(page.getByTestId("hub-node-status")).toContainText("Refreshed");
    expect(renders).toBe(2);
  });
});
