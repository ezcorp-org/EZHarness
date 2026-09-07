/**
 * B2-UI — the extension detail page DISPLAYS the capability-tier grants
 * (storage / spawnAgents / eventSubscriptions) that are auto-granted at install
 * from the manifest.
 *
 * These are all-or-nothing: they're granted at install (no per-cap toggle) and
 * the PUT /permissions endpoint re-strips custom event subscriptions via
 * `clampExtensionPermissions`. So the UI renders them READ-ONLY ("granted at
 * install"), never as editable toggles. This spec pins that surface against a
 * mocked extension whose manifest declares all three.
 *
 * The `@evidence`-tagged case satisfies the Visual evidence CI gate (a
 * frontend-visual change to the extension detail page). `captureEvidence` is a
 * hard no-op unless `EZCORP_E2E_EVIDENCE=1`.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";
import { setupAuthorReviewMock } from "./fixtures/extension-source-import.js";

const EXT_ID = "ext-ecf";

function makeDetail() {
	return {
		id: EXT_ID,
		name: "ez-code-factory",
		version: "0.1.0",
		description: "Git gate + review pipeline as an extension.",
		enabled: true,
		source: "local",
		installPath: `/tmp/${EXT_ID}`,
		checksumVerified: true,
		consecutiveFailures: 0,
		manifest: {
			schemaVersion: 2,
			name: "ez-code-factory",
			author: { name: "EZCorp" },
			entrypoint: "./index.ts",
			persistent: true,
			tools: [],
			permissions: {
				network: [],
				filesystem: [],
				shell: true,
				env: [],
				storage: true,
				spawnAgents: { maxPerHour: 200, maxConcurrent: 10 },
				eventSubscriptions: ["ez-code-factory:push-received", "run:complete"],
				// W2 — the extension may start runs of the workflows it ships.
				workflows: { names: ["gate", "review"], maxRunsPerHour: 12 },
			},
		},
		grantedPermissions: {
			network: [],
			filesystem: [],
			shell: true,
			env: [],
			grantedAt: { storage: Date.now(), spawnAgents: Date.now() },
		},
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

async function installExtMock(page: Page) {
	await page.route(`**/api/extensions/${EXT_ID}`, (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return route.fulfill({ json: makeDetail() });
	});
	// The detail page also probes settings + audit; return empty payloads.
	await page.route(`**/api/extensions/${EXT_ID}/settings`, (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return route.fulfill({ status: 409, json: {} });
	});
}

test.describe("Extension install-granted capabilities", () => {
	const proj = makeProject({ id: "proj-1" });

	test("renders storage / spawnAgents / event subscriptions read-only @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		await installExtMock(page);

		await page.goto(`/extensions/${EXT_ID}`);

		const permissions = page.getByTestId("release-permissions");
		await expect(permissions).toBeVisible();
		await expect(permissions).toContainText("Declared permissions");
		await expect(permissions).toContainText('"storage": true');
		await expect(permissions).toContainText('"maxPerHour": 200');
		await expect(permissions).toContainText('"maxConcurrent": 10');
		await expect(permissions).toContainText("ez-code-factory:push-received");
		await expect(permissions).toContainText("run:complete");
		await expect(permissions).toContainText("gate");
		await expect(permissions).toContainText("review");
		await expect(permissions).toContainText('"maxRunsPerHour": 12');
		await expect(permissions).toContainText("Current grants");
		// Release permissions are JSON evidence, not editable controls.
		await expect(permissions.locator('input[type="checkbox"]')).toHaveCount(0);
		await permissions.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "install-granted-capabilities-read-only-v4", { fullPage: true });
	});

	test("displays install-granted caps and captures evidence @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		await installExtMock(page);

		await page.goto(`/extensions/${EXT_ID}`);

		const permissions = page.getByTestId("release-permissions");
		await expect(permissions).toBeVisible();
		await expect(permissions).toContainText("Current grants");
		await expect(permissions).toContainText("storage");
		await permissions.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "install-granted-capabilities-v4", { fullPage: true });
		const review = await setupAuthorReviewMock(page, { installationId: EXT_ID });
		await page.getByTestId("review-extension-release").click();
		await review.expectReview();
		await captureEvidence(page, testInfo, "install-granted-capabilities-review-v4", { fullPage: true });
		await review.close();

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "install-granted-capabilities-v4" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "install-granted-capabilities-v4")).toBe(false);
		}
	});
});
