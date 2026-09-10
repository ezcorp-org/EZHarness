import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeExtension } from "./fixtures/data.js";
import { mockPageData, resumePage } from "./fixtures/page-data.js";

const EXT_ID = "ext-audit-1";

const auditEntries = [
	{
		kind: "capability",
		id: "cap-1",
		createdAt: new Date("2026-05-01T10:00:00Z").toISOString(),
		capability: "llm",
		action: "complete",
		success: true,
		durationMs: 1200,
		resourceType: null,
		resourceId: null,
		tokensUsed: 1230,
		costUsd: 0.003,
		provider: "openai",
		model: "gpt-4o-mini",
		errorCode: null,
		errorMessage: null,
		conversationId: "conv-1",
		onBehalfOf: "u-1",
		before: null,
		after: { redacted: "[REDACTED]" },
	},
	{
		kind: "governance",
		id: "gov-1",
		createdAt: new Date("2026-05-01T09:00:00Z").toISOString(),
		action: "ext:permission-granted",
		target: EXT_ID,
		userId: "u-1",
		metadata: { reason: "admin install" },
	},
];

const stats = {
	totalCalls: 2,
	totalCostUsd: 0.003,
	successRate: 1,
	denialCount: 0,
};

const extension = makeExtension({ id: EXT_ID, name: "audit-test-ext", grantedPermissions: { storage: true, network: ["https://api.example.com"], grantedAt: { storage: 1, network: 2 } } });

// This lane proves the UI with controlled loader/API data. Real role checks
// and audit writes run in real-auth/permission-backbone.spec.ts.
async function setupAuditMocks(page: import("@playwright/test").Page) {
  await mockPageData(page, `/extensions/${EXT_ID}/audit`, { extension, entries: auditEntries, nextCursor: null, stats });
  await page.route(`**/api/extensions/${EXT_ID}/audit**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/stats")) return route.fulfill({ json: stats });
    const entries = url.searchParams.get("status") === "denial" ? [] : auditEntries;
    return route.fulfill({ json: { entries, nextCursor: null } });
  });
}

test.describe("Per-extension audit drill-down", () => {
  test.beforeEach(async ({ page, mockApi }) => {
    await mockApi({ projects: [makeProject({ id: "proj-1" })], extensions: [extension], routes: { [`/api/extensions/${EXT_ID}`]: () => extension } });
    await setupAuditMocks(page);
  });

  test("navigates from extension detail to its audit timeline", async ({ page }) => {
    await page.goto(`/extensions/${EXT_ID}`);
    await expect(page.getByRole("heading", { name: extension.name, exact: true })).toBeVisible();
    await page.getByTestId("extension-detail-audit-link").click();
    await expect(page).toHaveURL(new RegExp(`/extensions/${EXT_ID}/audit$`));
    await expect(page.getByTestId("audit-timeline")).toBeVisible();
    await expect(page.getByTestId("audit-row")).toHaveCount(2);
  });

  test("renders the timeline, stats, and cost disclaimer", async ({ page }) => {
    await resumePage(page, `/extensions/${EXT_ID}/audit`);
    await expect(page.getByTestId("audit-stats-total")).toHaveText("2");
    await expect(page.getByTestId("audit-stats-denials")).toHaveText("0");
    await expect(page.getByText("approximate; provider billing may differ", { exact: false })).toBeVisible();
    await expect(page.getByTestId("audit-row")).toHaveCount(2);
  });

  test("Denials sends the exact filter and replaces the timeline", async ({ page }) => {
    await resumePage(page, `/extensions/${EXT_ID}/audit`);
    await expect(page.getByTestId("audit-row")).toHaveCount(2);
    const [filtered] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === `/api/extensions/${EXT_ID}/audit` && new URL(response.url()).searchParams.get("status") === "denial"),
      page.getByTestId("audit-filter-denials").click(),
    ]);
    expect(filtered.status()).toBe(200);
    await expect(page.getByTestId("audit-row")).toHaveCount(0);
    await expect(page.getByText("No audit entries match the current filters.")).toBeVisible();
    await page.getByTestId("audit-filter-all").click();
    await expect(page.getByTestId("audit-row")).toHaveCount(2);
  });

  test("row expansion displays the server-redacted metadata", async ({ page }, testInfo) => {
    await resumePage(page, `/extensions/${EXT_ID}/audit`);
    const row = page.getByTestId("audit-row").and(page.locator('[data-entry-id="cap-1"]'));
    await expect(page.getByTestId("audit-row-detail")).toHaveCount(0);
    await row.getByRole("button").click();
    await expect(row.getByTestId("audit-row-detail")).toContainText("[REDACTED]");
    await expect(row.getByTestId("audit-row-detail")).toContainText("After (redacted)");
    await captureEvidence(page, testInfo, "extension-audit-expanded");
    await row.getByRole("button").click();
    await expect(page.getByTestId("audit-row-detail")).toHaveCount(0);
  });

  test("current grants display excludes internal grant timestamps", async ({ page }) => {
    await resumePage(page, `/extensions/${EXT_ID}/audit`);
    await expect(page.getByTestId("audit-grants")).toContainText("storage");
    await expect(page.getByTestId("audit-grants")).toContainText("network");
    await expect(page.getByTestId("audit-grants")).toContainText("https://api.example.com");
    await expect(page.getByTestId("audit-grants")).not.toContainText("grantedAt");
  });
});
