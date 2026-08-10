import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

/**
 * E2E for the bottom-left "Update available" notification (UpdateBanner).
 * The card is mounted in the root layout and fetches /api/version on every
 * page; these specs drive it via the mockApi `routes` override and assert
 * the render / dismiss / re-show behaviour end-to-end in the browser.
 *
 * Render-only (mockApi, no send-flow / SSE) so it runs in plain preview —
 * no Docker harness needed.
 */

const VERSION_PATH = "/api/version";
const proj = makeProject({ id: "proj-upd", name: "Update Project" });

function version(over: Record<string, unknown> = {}) {
  return {
    current: "1.3.0",
    latest: "1.4.0",
    updateAvailable: true,
    checkedAt: "2026-06-01T00:00:00.000Z",
    source: "github-releases",
    releaseUrl: "https://github.com/ezcorp-org/EZCorp/releases/tag/app-v1.4.0",
    ...over,
  };
}

// The card carries role="status"; scope by its text so we never collide with
// other live regions on the page.
const cardLocator = (page: import("@playwright/test").Page) =>
  page.getByRole("status").filter({ hasText: "Update available" });

test.describe("Update-available notification (bottom-left)", () => {
  test("shows the card with latest + current versions and a release-notes link", async ({
    page,
    mockApi,
  }) => {
    await mockApi({ projects: [proj], routes: { [VERSION_PATH]: () => version() } });
    await page.goto(`/project/${proj.id}/chat`);

    const card = cardLocator(page);
    await expect(card).toBeVisible();
    await expect(card).toContainText("1.4.0");
    await expect(card).toContainText("(current: 1.3.0)");

    const link = card.getByRole("link", { name: "Release notes" });
    await expect(link).toHaveAttribute(
      "href",
      "https://github.com/ezcorp-org/EZCorp/releases/tag/app-v1.4.0",
    );
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("renders no card when the API reports no update available", async ({ page, mockApi }) => {
    await mockApi({
      projects: [proj],
      routes: { [VERSION_PATH]: () => version({ updateAvailable: false, latest: "1.3.0" }) },
    });
    await page.goto(`/project/${proj.id}/chat`);

    await expect(page.getByText("Update available")).toHaveCount(0);
  });

  test("dismiss hides the card and it stays hidden across a reload (sessionStorage)", async ({
    page,
    mockApi,
  }) => {
    await mockApi({ projects: [proj], routes: { [VERSION_PATH]: () => version() } });
    await page.goto(`/project/${proj.id}/chat`);

    const card = cardLocator(page);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);

    // Same `latest` was dismissed this session → must not reappear.
    await page.reload();
    await expect(page.getByText("Update available")).toHaveCount(0);
  });

  test("a newer release after a dismissal re-shows the card", async ({ page, mockApi }) => {
    let latest = "1.4.0";
    await mockApi({ projects: [proj], routes: { [VERSION_PATH]: () => version({ latest }) } });
    await page.goto(`/project/${proj.id}/chat`);

    const card = cardLocator(page);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);

    // A newer version lands; the dismissal was keyed to 1.4.0, so 1.5.0 shows.
    latest = "1.5.0";
    await page.reload();
    await expect(cardLocator(page)).toContainText("1.5.0");
  });
});
