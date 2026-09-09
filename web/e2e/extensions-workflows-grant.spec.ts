/**
 * Workflow permission declarations are read-only release evidence. A human
 * reviews the exact release in the author workspace before activation.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeExtension } from "./fixtures/data.js";
import { setupAuthorReviewMock } from "./fixtures/extension-source-import.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "ext-wf";

function workflowExtension(withWorkflows = true) {
	return makeExtension({
		id: EXT_ID,
		name: "release-bot",
		enabled: false,
		isBundled: false,
		manifest: {
			schemaVersion: 4,
			name: "release-bot",
			version: "1.0.0",
			description: "Ships two workflows and triggers them itself",
			author: { name: "tester" },
			entrypoint: "./index.ts",
			persistent: false,
			tools: [{ name: "noop", description: "n", inputSchema: { type: "object" } }],
			permissions: withWorkflows
				? { workflows: { names: ["deploy", "rollback"], maxRunsPerHour: 6 } }
				: {},
		},
	});
}

async function openWorkflowDetail(
	page: import("@playwright/test").Page,
	mockApi: (overrides?: Record<string, unknown>) => Promise<void>,
	extension = workflowExtension(),
) {
	await mockApi({
		projects: [proj],
		extensions: [extension],
		routes: {
			[`/api/extensions/${EXT_ID}`]: (url: URL) => {
				if (url.pathname === `/api/extensions/${EXT_ID}`) return extension;
				if (url.pathname.endsWith("/settings")) return { schema: {}, userValues: {} };
				if (url.pathname.endsWith("/expired-grants")) return { grants: [] };
				if (url.pathname.endsWith("/audit")) return { entries: [] };
				if (url.pathname.endsWith("/violations")) return [];
				if (url.pathname.endsWith("/permissions")) return extension.grantedPermissions;
				return {};
			},
		},
	});
	await page.goto(`/extensions/${EXT_ID}`);
	await expect(page.getByRole("heading", { name: "release-bot" })).toBeVisible();
}

test.describe("Extensions review — workflow declaration", () => {
	test("renders the exact workflow declaration as read-only release evidence", async ({ page, mockApi }) => {
		await openWorkflowDetail(page, mockApi);

		const permissions = page.getByTestId("release-permissions");
		await expect(permissions).toContainText("Declared permissions");
		await expect(permissions).toContainText("deploy");
		await expect(permissions).toContainText("rollback");
		await expect(permissions).toContainText('"maxRunsPerHour": 6');
		await expect(permissions.locator('input[type="checkbox"]')).toHaveCount(0);
	});

	test("Review opens the exact installation without authority mutation", async ({ page, mockApi }) => {
		await openWorkflowDetail(page, mockApi);
		// Exact human approval and activation remain real-auth coverage in
		// real-auth/extension-source-import.spec.ts and extension-author-flow.spec.ts.
		const mutations: string[] = [];
		await page.route("**/api/**", async route => {
			if (route.request().method() === "GET") return route.fallback();
			mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
			return route.fulfill({ status: 409, json: { message: "Review must not mutate authority." } });
		});
		const review = await setupAuthorReviewMock(page, { installationId: EXT_ID });

		await page.getByTestId("review-extension-release").click();
		await review.expectReview();
		await expect(page.getByText("No verified releases yet. Failed builds cannot be approved.", { exact: true })).toBeVisible();
		expect(mutations).toEqual([]);
		await review.close();
	});

	test("an extension declaring no workflows does not invent a workflow grant", async ({ page, mockApi }) => {
		await openWorkflowDetail(page, mockApi, workflowExtension(false));
		const permissions = page.getByTestId("release-permissions");
		await expect(permissions).toContainText("Declared permissions");
		await expect(permissions).not.toContainText("workflows");
		await expect(permissions.locator('input[type="checkbox"]')).toHaveCount(0);
	});

	test("Review shows saved-source recovery without edit or build controls @evidence", async ({ page, mockApi }, testInfo) => {
		await openWorkflowDetail(page, mockApi);
		const mutations: string[] = [];
		await page.route("**/api/**", async route => {
			if (route.request().method() === "GET") return route.fallback();
			mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
			return route.fulfill({ status: 409, json: { message: "Source recovery must not mutate authority." } });
		});
		const missing = { id: "missing-workspace", installationId: EXT_ID, revision: 3, sourceDigest: "a".repeat(64), createdAt: "2026-09-09T00:00:00.000Z" };
		const available = { id: "available-workspace", installationId: EXT_ID, revision: 2, sourceDigest: "b".repeat(64), createdAt: "2026-09-08T00:00:00.000Z" };
		const installation = { id: EXT_ID, ownerId: "mock-owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 };
		const review = await setupAuthorReviewMock(page, {
			installationId: EXT_ID,
			reviewData: () => ({ installations: [installation], state: { installation, workspaces: { [missing.id]: missing, [available.id]: available }, revisions: {}, releases: {}, approvals: {}, operations: {} }, workspace: null, files: {}, sourceUnavailable: { workspaceId: missing.id }, canApprove: false, canBindProject: false, projects: [], projectBinding: null }),
		});

		await page.getByTestId("review-extension-release").click();
		await review.expectReview();
		const recovery = page.getByTestId("source-unavailable");
		await expect(recovery).toContainText("Saved source is unavailable");
		await expect(recovery.getByRole("link", { name: "Import source to create a new candidate" })).toHaveAttribute("href", "/extensions/import-source");
		await expect(recovery.getByRole("link", { name: "Revision 2" })).toHaveAttribute("href", `?installation=${EXT_ID}&workspace=${available.id}`);
		await expect(page.getByRole("button", { name: "Save revision" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Save and build" })).toHaveCount(0);
		await captureEvidence(page, testInfo, "extensions-source-unavailable-recovery", { fullPage: true });
		expect(mutations).toEqual([]);
		await review.close();
	});

	test("renders the workflows release declaration and captures evidence @evidence", async ({ page, mockApi }, testInfo) => {
		await openWorkflowDetail(page, mockApi);
		const permissions = page.getByTestId("release-permissions");
		await expect(permissions).toBeVisible();
		await expect(permissions).toContainText("workflows");
		await permissions.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "extensions-workflows-grant-v4", { fullPage: true });
		const review = await setupAuthorReviewMock(page, { installationId: EXT_ID });
		await page.getByTestId("review-extension-release").click();
		await review.expectReview();
		await captureEvidence(page, testInfo, "extensions-workflows-review-v4", { fullPage: true });
		await review.close();

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(testInfo.attachments.some((a) => a.name === "extensions-workflows-grant-v4" && a.contentType === "image/png")).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "extensions-workflows-grant-v4")).toBe(false);
		}
	});
});
