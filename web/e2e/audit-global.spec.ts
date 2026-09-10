import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { mockPageData, resumePage } from "./fixtures/page-data.js";
import AxeBuilder from "@axe-core/playwright";

// The UI consumes controlled loader/API data here. Real admin/member/anonymous
// authorization and audit persistence run in real-auth/permission-backbone.
const entries = [{ kind: "governance", id: "audit-1", action: "ext:permission-granted", target: "ext-a", userId: "admin-1", metadata: { reason: "Reviewed release" }, createdAt: "2026-05-01T10:00:00Z" }];
const stats = { windowMs: 86_400_000, denialCount: 2, totalCalls: 100, totalCostUsd: 1.234,
  topChattiest: [{ extensionId: "ext-a", name: "lessons-keeper", calls: 60 }],
  topLlmSpenders: [{ extensionId: "ext-a", name: "lessons-keeper", costUsd: 1 }],
};

test.describe("Global audit UI", () => {
  test.beforeEach(async ({ page, mockApi }) => {
    await mockApi({});
    await mockPageData(page, "/audit", { entries, nextCursor: null, stats, extensionFacets: [{ id: "ext-a", name: "lessons-keeper", isBundled: true }] });
    await page.route("**/api/audit**", route => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: url.pathname.endsWith("/stats") ? stats : { entries: url.searchParams.get("denialOnly") === "true" ? [] : entries, nextCursor: null } });
    });
    await resumePage(page, "/audit");
  });

  test("renders stats, filters, and the named extension audit entry", async ({ page }, testInfo) => {
    await expect(page.getByTestId("stats-total-calls")).toHaveText("100");
    await expect(page.getByTestId("stats-denials")).toHaveText("2");
    await expect(page.getByTestId("global-audit-filters")).toBeVisible();
    await expect(page.getByTestId("global-audit-row")).toHaveCount(1);
    await expect(page.getByTestId("global-audit-row")).toContainText("lessons-keeper");
    await expect(page.getByTestId("global-audit-row")).toContainText("Reviewed release");
    const accessibility = await new AxeBuilder({ page }).include('[data-testid="global-audit-stats"]').analyze();
    expect(accessibility.violations).toEqual([]);
    await captureEvidence(page, testInfo, "global-audit-loaded");
  });

  test("the Denials filter changes the request and the visible rows", async ({ page }) => {
    await expect(page.getByTestId("global-audit-row")).toHaveCount(1);
    const [filtered] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/audit" && new URL(response.url()).searchParams.get("denialOnly") === "true"),
      page.getByTestId("filter-denial-only").check(),
    ]);
    expect(filtered.status()).toBe(200);
    await expect(page.getByTestId("global-audit-row")).toHaveCount(0);
    await expect(page.getByText("No audit entries match the current filters.")).toBeVisible();
    await page.getByTestId("filter-denial-only").uncheck();
    await expect(page.getByTestId("global-audit-row")).toHaveCount(1);
  });

  test("failed filtering keeps the current rows and allows retry", async ({ page }) => {
    await page.route("**/api/audit?**", route => route.fulfill({ status: 500, json: { error: "Audit unavailable" } }), { times: 1 });
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.getByText("Audit fetch failed: 500", { exact: true })).toBeVisible();
    await expect(page.getByTestId("global-audit-row")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
    await page.route("**/api/audit?**", route => route.fulfill({ json: { entries: [{ ...entries[0], metadata: { reason: "Review received after retry" } }], nextCursor: null } }), { times: 1 });
    const [retried] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/audit"),
      page.getByRole("button", { name: "Apply", exact: true }).click(),
    ]);
    expect(retried.status()).toBe(200);
    await expect(page.getByTestId("global-audit-row")).toContainText("Review received after retry");
  });
});
