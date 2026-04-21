import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const MOBILE_WIDTH = 375;
const MOBILE_HEIGHT = 812;
const DESKTOP_WIDTH = 1024;
const DESKTOP_HEIGHT = 768;

test.describe("Mobile navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({
      width: MOBILE_WIDTH,
      height: MOBILE_HEIGHT,
    });
  });

  test("mobile tab bar is visible on project page", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    await mockApi({ projects: [proj] });
    await page.goto(`/project/${proj.id}`);

    const tabBar = page.locator('nav[aria-label="Mobile navigation"]');
    await expect(tabBar).toBeVisible();

    await expect(tabBar.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(tabBar.getByRole("link", { name: "Chat" })).toBeVisible();
    await expect(tabBar.getByRole("link", { name: "Settings" })).toBeVisible();
  });

  test("mobile tab bar is hidden on desktop viewport", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    await mockApi({ projects: [proj] });

    await page.setViewportSize({
      width: DESKTOP_WIDTH,
      height: DESKTOP_HEIGHT,
    });
    await page.goto(`/project/${proj.id}`);

    const tabBar = page.locator('nav[aria-label="Mobile navigation"]');
    await expect(tabBar).not.toBeVisible();
  });

  test("mobile tab bar highlights active Chat tab", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    const conv = makeConversation({ projectId: proj.id });
    await mockApi({ projects: [proj], conversations: [conv] });
    await page.goto(`/project/${proj.id}/chat`);

    const tabBar = page.locator('nav[aria-label="Mobile navigation"]');
    const chatTab = tabBar.getByRole("link", { name: "Chat" });

    await expect(chatTab).toHaveAttribute("aria-current", "page");

    // Other tabs should NOT have aria-current
    const dashboardTab = tabBar.getByRole("link", { name: "Dashboard" });
    const settingsTab = tabBar.getByRole("link", { name: "Settings" });
    await expect(dashboardTab).not.toHaveAttribute("aria-current", "page");
    await expect(settingsTab).not.toHaveAttribute("aria-current", "page");
  });

  test("mobile tab bar navigates to Settings on click", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    await mockApi({ projects: [proj] });
    await page.goto(`/project/${proj.id}`);

    const tabBar = page.locator('nav[aria-label="Mobile navigation"]');
    await tabBar.getByRole("link", { name: "Settings" }).click();

    await expect(page).toHaveURL(new RegExp(`/project/${proj.id}/settings`));
  });

  test("conversation list is visible on mobile chat page", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    const conv = makeConversation({ projectId: proj.id });
    await mockApi({ projects: [proj], conversations: [conv] });
    await page.goto(`/project/${proj.id}/chat`);

    await expect(page.getByText("Conversations")).toBeVisible();
  });

  test("conversation list fills viewport width on mobile", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    const conv = makeConversation({ projectId: proj.id });
    await mockApi({ projects: [proj], conversations: [conv] });
    await page.goto(`/project/${proj.id}/chat`);

    const conversationList = page.getByText("Conversations").locator("..");
    const box = await conversationList.boundingBox();
    expect(box).not.toBeNull();
    // The container should span (nearly) the full viewport width
    expect(box!.width).toBeGreaterThanOrEqual(MOBILE_WIDTH - 20);
  });

  test("pull to refresh indicator is hidden by default", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    await mockApi({ projects: [proj] });
    await page.goto(`/project/${proj.id}`);

    const refreshIndicator = page.locator("[data-testid='pull-to-refresh']");
    // Either not in DOM or not visible
    const count = await refreshIndicator.count();
    if (count > 0) {
      await expect(refreshIndicator).not.toBeVisible();
    } else {
      expect(count).toBe(0);
    }
  });
});
