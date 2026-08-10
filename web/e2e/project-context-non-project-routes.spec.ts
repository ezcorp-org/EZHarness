/**
 * Regression: opening an extension must NOT drop you out of your project.
 *
 * The `(app)` layout keeps `store.activeProjectId` in lock-step with the URL
 * so a direct link / refresh into `/project/<id>/…` restores the workspace.
 * That sync used to read `page.params.id` — but `[id]` is NOT unique to the
 * project route: `/extensions/[id]`, `/extensions/[id]/audit`, `/marketplace/[id]`
 * and `/runs/[id]` all declare the same param name. Clicking an extension card
 * therefore wrote the EXTENSION id into `activeProjectId`, which:
 *   - blanked the sidebar's active-context line + status bar (no project row
 *     matches an extension id),
 *   - repointed every project nav link at `/project/<extension-id>/…`, and
 *   - persisted the bogus id to `localStorage`, so the next reload resumed
 *     into a workspace that does not exist.
 *
 * The sync now derives the id from the pathname (`/project/<id>/…` only), so
 * these specs walk the real UI and assert the project survives a round-trip
 * through each non-project `[id]` route.
 *
 * Desktop viewport: the sidebar (`desktop-sidebar`) only renders at ≥lg.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject, makeConversation, makeExtension } from "./fixtures/data.js";

const PROJ_ID = "proj-1";
const PROJ_NAME = "My Project";
const OTHER_ID = "proj-2";
const OTHER_NAME = "Other Project";
const CONV_ID = "conv-1";
const EXT_ID = "ext-1";
const EXT_NAME = "my-extension";

const project = makeProject({ id: PROJ_ID, name: PROJ_NAME });
const otherProject = makeProject({ id: OTHER_ID, name: OTHER_NAME });
const conversation = makeConversation({ id: CONV_ID, projectId: PROJ_ID, title: "Hello" });

const extension = makeExtension({
  id: EXT_ID,
  name: EXT_NAME,
  description: "A handy extension for testing",
});

const sidebar = (page: Page) => page.getByTestId("desktop-sidebar");

/** The sidebar's active-context line — the user-visible "which project am I in". */
const contextName = (page: Page) => sidebar(page).getByTestId("active-context-name");

/** The project-scoped "Chat" nav link, whose href embeds the active project id. */
const chatNavLink = (page: Page) => sidebar(page).getByRole("link", { name: "Chat", exact: true });

const readActiveProjectId = (page: Page) =>
  page.evaluate(() => localStorage.getItem("activeProjectId"));

/** Assert every surface that reads `activeProjectId` still names `proj-1`. */
async function expectStillInProject(page: Page) {
  await expect(contextName(page)).toHaveText(PROJ_NAME);
  await expect(chatNavLink(page)).toHaveAttribute("href", `/project/${PROJ_ID}/chat`);
  await expect(page.getByTestId("deck-statusbar")).toContainText(PROJ_NAME);
  expect(await readActiveProjectId(page)).toBe(PROJ_ID);
}

test.describe("Project context survives non-project [id] routes @ desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page, mockApi }) => {
    await mockApi({
      projects: [project, otherProject],
      conversations: [conversation],
      extensions: [extension],
    });
    // Registered AFTER mockApi so it wins, and scoped to the exact path so
    // the `/settings`, `/violations`, `/audit`, `/expired-grants` sub-routes
    // still fall through to the fixture's own handlers.
    await page.route("**/api/extensions/ext-1", (route) => route.fulfill({ json: extension }));
  });

  test("clicking an extension card keeps the project open @evidence", async ({
    page,
  }, testInfo) => {
    await page.goto(`/project/${PROJ_ID}/chat/${CONV_ID}`);
    await expectStillInProject(page);

    // Walk the real navigation: sidebar → Extensions → the card's title link.
    await sidebar(page).getByRole("link", { name: "Extensions" }).click();
    await expect(page).toHaveURL(/\/extensions$/);
    await expectStillInProject(page);

    const card = page.locator(`[data-testid="ext-card"][data-ext-id="${EXT_ID}"]`);
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: EXT_NAME }).click();

    await expect(page).toHaveURL(new RegExp(`/extensions/${EXT_ID}$`));
    // The bug: `activeProjectId` became "ext-1" here, blanking the sidebar.
    await expectStillInProject(page);

    await captureEvidence(page, testInfo, "extension-detail-keeps-project");
  });

  test("a direct link to the extension detail page keeps the saved project", async ({ page }) => {
    await page.goto(`/project/${PROJ_ID}/chat/${CONV_ID}`);
    await expectStillInProject(page);

    // Full reload straight into the detail route — the layout re-runs its
    // URL sync against a pathname that carries no project segment.
    await page.goto(`/extensions/${EXT_ID}`);
    await expect(page.getByRole("heading", { name: EXT_NAME })).toBeVisible();
    await expectStillInProject(page);
  });

  test("the extension audit sub-route keeps the project too", async ({ page }) => {
    await page.goto(`/project/${PROJ_ID}/chat/${CONV_ID}`);
    await expectStillInProject(page);

    await page.goto(`/extensions/${EXT_ID}/audit`);
    await expect(page).toHaveURL(new RegExp(`/extensions/${EXT_ID}/audit$`));
    await expectStillInProject(page);
  });

  test("a real project route still switches the workspace", async ({ page }) => {
    // The other half of the fix: the sync must still FIRE for project
    // routes, otherwise a deep link would strand the sidebar on the old one.
    await page.goto(`/project/${PROJ_ID}/chat/${CONV_ID}`);
    await expectStillInProject(page);

    await page.goto(`/project/${OTHER_ID}/chat`);

    await expect(contextName(page)).toHaveText(OTHER_NAME);
    await expect(chatNavLink(page)).toHaveAttribute("href", `/project/${OTHER_ID}/chat`);
    expect(await readActiveProjectId(page)).toBe(OTHER_ID);
  });
});
