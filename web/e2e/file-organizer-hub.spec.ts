/**
 * file-organizer Hub — page-level e2e (mockApi + emitSse, no Docker).
 *
 * ⚠️ THIS SUITE IS 100% MOCK-BACKEND. It validates UI RENDERING and
 * action-WIRING ONLY. Every case stubs `/api/hub/pages*` (render) and
 * `/api/extensions/file-organizer/events/*` (action) with hand-written
 * trees + `{ok}` envelopes. It does NOT start the real render subprocess,
 * the daemon, the applier, the real add-folder validator, or the real
 * `/api/fs/list`. A green run here proves the UI renders the tree the mock
 * handed it and POSTs the body we expected — it is NOT end-to-end
 * validation of the feature. The REAL stack is exercised by the
 * Docker-gated `file-organizer-real.spec.ts` and the host bun suites
 * (`src/__tests__/file-organizer-*.test.ts`). See
 * `docs/extensions/examples/file-organizer/TEST-COVERAGE.md`.
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

// The extension now ships ONE Hub page; the former Review / Folders & Rules
// tabs are sections of it. Every case below navigates to this single page id
// and stubs its render — the host Hub shell renders whatever tree the mock
// hands back, so a focused per-section tree is still a valid UI-shell check.
const OVERVIEW = "ext:file-organizer:overview";
// Back-compat aliases so the per-section cases keep reading naturally —
// all three resolve to the one page now.
const REVIEW = OVERVIEW;
const FOLDERS = OVERVIEW;

const listing = {
  pages: [
    { id: OVERVIEW, title: "File Organizer", kind: "ext" },
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
    title: "File Organizer",
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
    title: "File Organizer",
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
    title: "File Organizer",
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
    title: "File Organizer",
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
      title: "File Organizer",
      nodes: [
        { type: "section", nodes: [
          { type: "button", label: "Add watched folder", style: "primary", action: { event: "file-organizer:add-folder", prompt: { label: "Folder path", placeholder: "/watched/Downloads", field: "path", format: "file-path" } } },
          { type: "button", label: "Add ignore", style: "secondary", action: { event: "file-organizer:add-ignore", prompt: { label: "Ignore path or name", field: "path" } } },
        ] },
        { type: "empty-state", title: "No folders watched" },
      ],
    };
  }
  return {
    title: "File Organizer",
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
    expect(acceptBody).toEqual({ source: "hub", pageId: "overview", payload: { proposalId: "m1" } });
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
    await expect.poll(() => rejectBody).toEqual({ source: "hub", pageId: "overview", payload: { proposalId: "m1" } });
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
    await expect.poll(() => confirmBody).toEqual({ source: "hub", pageId: "overview" });
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
    await expect.poll(() => undoBody).toEqual({ source: "hub", pageId: "overview", payload: { batchId: "batch-1" } });
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
    expect(restoreBody).toEqual({ source: "hub", pageId: "overview", payload: { all: true } });
  });

  test("folders: BROWSE + select in the file-path picker yields an ABSOLUTE path → POST events/add-folder", async ({ page, mockApi }) => {
    // ⚠️ COMPONENT-LOGIC CHECK ONLY — NOT a real backend flow. Against the
    // live app `GET /api/fs/list?dir=/` returns 403 (the endpoint is
    // sandbox-jailed to the project root), so Browse CANNOT list `/` and
    // the point-and-click add is UNREACHABLE in production. This case mocks
    // fs-list to fake `/` entries purely to prove the picker is in
    // absolute mode (browses `/`, not `~`) and emits a `/`-rooted value —
    // the regression guard below. The REAL add-folder path is a TYPED
    // absolute path, covered by `file-organizer-real.spec.ts`. See
    // TEST-COVERAGE.md §3 for the full rationale.
    //
    // Regression for the "Path must be an absolute, valid filesystem path."
    // bug: the picker defaulted to a ~-relative root, so browse + select
    // (the realistic interaction) emitted `~/Downloads`, which the real
    // `normalizeFolderPath` rejects. We DRIVE the picker (Browse → click a
    // dir entry) rather than typing a hardcoded absolute string, and assert
    // the dispatched payload is the absolute `/Downloads` the validator
    // accepts. The fs-list mock returns entries at `/` so a real absolute
    // value is produced by the (now absolute-mode) picker.
    await mockApi({ projects: [proj] });
    let addBody: unknown = null;
    let renders = 0;
    const fsListDirs: string[] = [];
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) => {
      renders++;
      return route.fulfill({ json: { page: foldersTree({ folders: renders > 1 }), renderedAt: Date.now() } });
    });
    await page.route("**/api/fs/list**", (route) => {
      // Record the dir the picker browsed — absolute mode MUST browse `/`,
      // never `~`. Serve a single dir entry to select.
      const dir = new URL(route.request().url()).searchParams.get("dir") ?? "";
      fsListDirs.push(dir);
      return route.fulfill({ json: [{ name: "Downloads", isDir: true }] });
    });
    await page.route(evt("add-folder"), async (route) => {
      addBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Folder added" } });
    });

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("No folders watched");
    await page.getByTestId("hub-node-button").filter({ hasText: "Add watched folder" }).click();
    await expect(page.getByTestId("hub-prompt-dialog")).toBeVisible();
    // The plain text input is gone — the DRY SharedFilePicker drives it now.
    await expect(page.getByTestId("hub-prompt-input")).toHaveCount(0);

    // Click the picker's Browse button, then select the "Downloads" dir.
    const picker = page.getByTestId("hub-prompt-format");
    await picker.getByTitle("Browse").click();
    await picker.getByRole("button", { name: /Downloads/ }).first().click();

    // Absolute mode browsed `/` (NOT `~`) — proving the bug fix at the
    // network seam.
    expect(fsListDirs).toContain("/");
    expect(fsListDirs).not.toContain("~");
    // The field now holds an absolute path the validator accepts.
    await expect(picker.locator("input")).toHaveValue(/^\/Downloads/);

    await page.getByTestId("hub-prompt-submit").click();
    await expect(page.getByText("/watched/Downloads")).toBeVisible();
    // The dispatched path is absolute — `/Downloads` or `/Downloads/`.
    const body = addBody as { source: string; pageId: string; payload: { path: string } };
    expect(body.source).toBe("hub");
    expect(body.pageId).toBe("overview");
    expect(body.payload.path).toMatch(/^\/Downloads\/?$/);
  });

  test("folders: typing an ABSOLUTE path still passes through unmodified", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let addBody: unknown = null;
    let renders = 0;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) => {
      renders++;
      return route.fulfill({ json: { page: foldersTree({ folders: renders > 1 }), renderedAt: Date.now() } });
    });
    await page.route("**/api/fs/list**", (route) => route.fulfill({ json: [{ name: "Downloads", isDir: true }] }));
    await page.route(evt("add-folder"), async (route) => {
      addBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, message: "Folder added" } });
    });

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Add watched folder" }).click();
    await page.getByTestId("hub-prompt-format").locator("input").fill("/watched/Downloads");
    await page.getByTestId("hub-prompt-submit").click();
    await expect.poll(() => addBody).toEqual({ source: "hub", pageId: "overview", payload: { path: "/watched/Downloads" } });
  });

  test("folders: a refused add (HTTP 200 {ok:false}) surfaces the EXACT validator error instead of silently doing nothing", async ({ page, mockApi }) => {
    // If a non-absolute value ever reaches the add handler (e.g. a typed
    // relative name), the real `addFolder` refuses it with the exact
    // absolute-path message. The Hub must render that as an error toast —
    // not drop it. We serve the REAL refusal string the validator returns.
    await mockApi({ projects: [proj] });
    let addBody: unknown = null;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) =>
      route.fulfill({ json: { page: foldersTree({ folders: false }), renderedAt: Date.now() } }),
    );
    await page.route("**/api/fs/list**", (route) => route.fulfill({ json: [] }));
    await page.route(evt("add-folder"), (route) => {
      addBody = route.request().postDataJSON();
      // Exact message returned by config.ts `addFolder` / `checkReachability`
      // for a non-absolute path.
      return route.fulfill({ json: { ok: false, message: "Path must be an absolute, valid filesystem path." } });
    });

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Add watched folder" }).click();
    // Type a relative name (no leading slash) — the value the picker used to
    // hand back from a bare typed entry / browse-select.
    await page.getByTestId("hub-prompt-format").locator("input").fill("relative/Downloads");
    await page.getByTestId("hub-prompt-submit").click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Path must be an absolute, valid filesystem path." }),
    ).toBeVisible({ timeout: 3000 });
    // Nothing was added — but the user now knows WHY, instead of a dead click.
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("No folders watched");
    expect((addBody as { payload: { path: string } }).payload.path).toBe("relative/Downloads");
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
    await expect.poll(() => modeBody).toEqual({ source: "hub", pageId: "overview", payload: { folderId: "f1", mode: "fully-auto" } });
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
    expect(presetBody).toEqual({ source: "hub", pageId: "overview", payload: { folderId: "f1", preset: "junk-sweep" } });
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
    await expect.poll(() => ignoreBody).toEqual({ source: "hub", pageId: "overview", payload: { folderId: "f1", path: "secrets" } });
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
    await expect(page.getByTestId("hub-page-title")).toHaveText("File Organizer");
    expect(renders).toBe(1);

    await emitSse({
      type: "ext:page-state",
      data: { extensionId: "ext-fo", extensionName: "file-organizer", pageId: "overview", timestamp: Date.now() },
    });
    await expect(page.getByTestId("hub-node-status")).toContainText("Refreshed");
    expect(renders).toBe(2);
  });

  // ── UI-state coverage (still 100% MOCK-BACKEND) ───────────────────
  // These assert the host page shell's rendering states: loading skeleton,
  // render-error card + retry, empty states, and dialog cancel paths. They
  // do NOT exercise the real render subprocess.

  test("loading: the skeleton shows while the render is in flight, then resolves", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    await page.route(`**/api/hub/pages/${encodeURIComponent(OVERVIEW)}`, async (route) => {
      await gate; // hold the render open so the skeleton is observable
      return route.fulfill({ json: { page: overviewTree({ pending: 0, unclassified: 0, running: true }), renderedAt: Date.now() } });
    });

    await page.goto(`/hub/${encodeURIComponent(OVERVIEW)}`);
    await expect(page.getByText("Loading page…")).toBeVisible();
    release();
    await expect(page.getByTestId("hub-page-title")).toHaveText("File Organizer");
    await expect(page.getByText("Loading page…")).toHaveCount(0);
  });

  test("render error: a render failure shows the error card; Retry re-pulls and recovers", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    let renders = 0;
    await page.route(`**/api/hub/pages/${encodeURIComponent(OVERVIEW)}`, (route) => {
      renders++;
      // 1st pull: the subprocess failed to render → `{error}` envelope.
      if (renders === 1) return route.fulfill({ json: { error: "This page failed to render." } });
      // Retry: healthy tree.
      return route.fulfill({ json: { page: overviewTree({ pending: 1, unclassified: 0, running: true }), renderedAt: Date.now() } });
    });

    await page.goto(`/hub/${encodeURIComponent(OVERVIEW)}`);
    await expect(page.getByTestId("hub-error-card")).toContainText("This page failed to render.");
    await page.getByTestId("hub-retry-btn").click();
    await expect(page.getByTestId("hub-page-title")).toHaveText("File Organizer");
    await expect(page.getByTestId("hub-error-card")).toHaveCount(0);
    expect(renders).toBe(2);
  });

  test("404 render: a disabled/unknown page shows the not-exist error card (no retry loop crash)", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(OVERVIEW)}`, (route) =>
      route.fulfill({ status: 404, json: { error: "Not found" } }),
    );

    await page.goto(`/hub/${encodeURIComponent(OVERVIEW)}`);
    await expect(page.getByTestId("hub-error-card")).toContainText("This page doesn't exist");
  });

  test("overview empty: no pending + no unclassified renders the clean state (no attention section)", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(OVERVIEW)}`, (route) =>
      route.fulfill({ json: { page: overviewTree({ pending: 0, unclassified: 0, running: true }), renderedAt: Date.now() } }),
    );

    await page.goto(`/hub/${encodeURIComponent(OVERVIEW)}`);
    await expect(page.getByTestId("hub-page-title")).toHaveText("File Organizer");
    await expect(page.getByText("Needs your attention")).toHaveCount(0);
  });

  test("folders empty: the No-folders-watched empty-state renders with the add affordance", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) =>
      route.fulfill({ json: { page: foldersTree({ folders: false }), renderedAt: Date.now() } }),
    );

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("No folders watched");
    await expect(page.getByTestId("hub-node-button").filter({ hasText: "Add watched folder" })).toBeVisible();
  });

  test("review empty: the quarantine empty-state renders", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(REVIEW)}`, (route) =>
      route.fulfill({ json: { page: reviewQuarantineTree(true), renderedAt: Date.now() } }),
    );

    await page.goto(`/hub/${encodeURIComponent(REVIEW)}`);
    await expect(page.getByTestId("hub-node-empty-state")).toContainText("Quarantine is empty");
  });

  test("confirm cancel: dismissing the delete confirm does NOT POST the action", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let posted = false;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(REVIEW)}`, (route) =>
      route.fulfill({ json: { page: reviewDeletesTree(), renderedAt: Date.now() } }),
    );
    await page.route(evt("confirm-deletes"), (route) => {
      posted = true;
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto(`/hub/${encodeURIComponent(REVIEW)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Confirm these 1 deletes" }).click();
    await expect(page.getByTestId("hub-confirm-dialog")).toBeVisible();
    await page.getByTestId("hub-confirm-cancel").click();
    await expect(page.getByTestId("hub-confirm-dialog")).toHaveCount(0);
    // Give any (erroneous) dispatch a beat to fire, then assert it didn't.
    await page.waitForTimeout(150);
    expect(posted).toBe(false);
  });

  test("prompt cancel: dismissing the add-folder prompt does NOT POST", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj] });
    let posted = false;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) =>
      route.fulfill({ json: { page: foldersTree({ folders: false }), renderedAt: Date.now() } }),
    );
    await page.route("**/api/fs/list**", (route) => route.fulfill({ json: [] }));
    await page.route(evt("add-folder"), (route) => {
      posted = true;
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Add watched folder" }).click();
    await expect(page.getByTestId("hub-prompt-dialog")).toBeVisible();
    await page.getByTestId("hub-prompt-cancel").click();
    await expect(page.getByTestId("hub-prompt-dialog")).toHaveCount(0);
    await page.waitForTimeout(150);
    expect(posted).toBe(false);
  });

  test("prompt Escape: pressing Escape in the plain-text prompt cancels without POSTing", async ({ page, mockApi }) => {
    // The add-ignore prompt uses the PLAIN text input (no format widget),
    // which owns the Enter-submit / Escape-cancel keyboard handling.
    await mockApi({ projects: [proj] });
    let posted = false;
    await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
    await page.route(`**/api/hub/pages/${encodeURIComponent(FOLDERS)}`, (route) =>
      route.fulfill({ json: { page: foldersTree({ folders: true }), renderedAt: Date.now() } }),
    );
    await page.route(evt("add-ignore"), (route) => {
      posted = true;
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto(`/hub/${encodeURIComponent(FOLDERS)}`);
    await page.getByTestId("hub-node-button").filter({ hasText: "Add ignore" }).click();
    await page.getByTestId("hub-prompt-input").fill("secrets");
    await page.getByTestId("hub-prompt-input").press("Escape");
    await expect(page.getByTestId("hub-prompt-dialog")).toHaveCount(0);
    await page.waitForTimeout(150);
    expect(posted).toBe(false);
  });
});
