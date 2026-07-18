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

	test("renders storage / spawnAgents / event subscriptions read-only", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await installExtMock(page);

		await page.goto(`/extensions/${EXT_ID}`);

		const block = page.getByTestId("install-granted-capabilities");
		await expect(block).toBeVisible();
		await expect(page.getByTestId("install-grant-storage")).toBeVisible();
		await expect(page.getByTestId("install-grant-spawn-agents")).toContainText("200/hr");
		// One badge per declared event subscription.
		await expect(page.getByTestId("install-grant-event")).toHaveCount(2);
		await expect(block).toContainText("Read-only");

		// These are NOT editable toggles — no checkbox inside the read-only block.
		await expect(block.locator('input[type="checkbox"]')).toHaveCount(0);
	});

	test("displays install-granted caps and captures evidence @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		await installExtMock(page);

		await page.goto(`/extensions/${EXT_ID}`);

		await expect(page.getByTestId("install-granted-capabilities")).toBeVisible();
		await captureEvidence(page, testInfo, "install-granted-capabilities");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "install-granted-capabilities" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "install-granted-capabilities")).toBe(false);
		}
	});
});
