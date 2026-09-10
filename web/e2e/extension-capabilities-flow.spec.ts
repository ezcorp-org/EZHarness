/**
 * Extension host-capability policy — current detail-page surface.
 *
 * The former editable CapabilitiesPanel was retired. The extension detail now
 * displays the server-resolved, install-time policy as read-only JSON under
 * Settings. These checks preserve the supported outcomes: effective policy
 * visibility, server clamping, and the same safe view for a member.
 */
import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";

const ADMIN_ME = { user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" } };
const MEMBER_ME = { user: { id: "member-1", email: "member@test.local", name: "Member", role: "member" } };
const proj = makeProject({ id: "proj-1", name: "Test Project" });

function makeSearchDetail() {
  return {
    id: "ext-search", name: "web-search", version: "1.0.0",
    description: "Search-capable extension.", enabled: true, source: "bundled",
    installPath: "/bundled/web-search", checksumVerified: true, consecutiveFailures: 0,
    manifest: {
      author: "EZCorp", entrypoint: "./index.ts", persistent: false, tools: [],
      permissions: { search: { quota: 1000 } },
    },
    grantedPermissions: { network: [], filesystem: [], shell: false, env: [], grantedAt: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function installEffectivePolicy(page: Page, effective: Record<string, unknown>, grant: unknown) {
  await page.route("**/api/extensions/ext-search/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ json: {
      schema: null, declaredDefaults: {}, userValues: {}, resolved: {},
      capabilities: [{ cap: "search", effective, grant }],
    } });
  });
}

test.describe("Extension host-capability policy — current read-only detail", () => {
  test("admin sees the resolved inherited search policy", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj], routes: {
      "/api/extensions/ext-search": makeSearchDetail,
      "/api/auth/me": () => ADMIN_ME,
    } });
    await installEffectivePolicy(page, { denied: false, quota: 100, maxResults: 5, providers: "all" }, "inherit");

    await page.goto("/extensions/ext-search");
    const section = page.getByTestId("extension-settings-section");
    await expect(section).toBeVisible();
    await expect(section.getByText("Effective host capability policy", { exact: true })).toBeVisible();
    await expect(section).toContainText('"cap": "search"');
    await expect(section).toContainText('"quota": 100');
    await expect(section).toContainText('"providers": "all"');
  });

  test("detail shows the server-clamped effective quota, never a submitted value", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj], routes: {
      "/api/extensions/ext-search": makeSearchDetail,
      "/api/auth/me": () => ADMIN_ME,
    } });
    // The policy route has already clamped an attempted quota of 500 to 100.
    await installEffectivePolicy(page, { denied: false, quota: 100, maxResults: 5, providers: "all" }, { quota: 100 });

    await page.goto("/extensions/ext-search");
    const section = page.getByTestId("extension-settings-section");
    await expect(section).toContainText('"quota": 100');
    await expect(section).not.toContainText('"quota": 500');
  });

  test("member sees the same policy without an editable capability control", async ({ page, mockApi }) => {
    await mockApi({ projects: [proj], routes: {
      "/api/extensions/ext-search": makeSearchDetail,
      "/api/auth/me": () => MEMBER_ME,
    } });
    await installEffectivePolicy(page, { denied: true }, false);

    await page.goto("/extensions/ext-search");
    const section = page.getByTestId("extension-settings-section");
    await expect(section.getByText("Effective host capability policy", { exact: true })).toBeVisible();
    await expect(section).toContainText('"denied": true');
    await expect(page.getByTestId("capability-search-save")).toHaveCount(0);
    await expect(page.getByTestId("capability-search-mode-custom")).toHaveCount(0);
  });
});
