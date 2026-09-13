/**
 * E2E — the extension author page names the extension it is editing
 * (frontend-visual change ⇒ `@evidence` per the feature contract).
 *
 * The page heading, the document title and the Command Deck breadcrumb
 * strip all read the name the page load resolves (`extensionName` /
 * `breadcrumbTail`). The strip is the only breadcrumb on every screen size,
 * so the page adds none of its own. Without a name the heading stays
 * "Extension workspace" and the strip shows no trailing crumb.
 *
 * RENDER tier: `setupAuthorReviewMock` fulfils the SvelteKit `__data.json`
 * request for the author route, so the page is reached through a client-side
 * navigation from /extensions (an injected same-origin link, which the
 * SvelteKit router intercepts). The name resolution itself is unit-tested in
 * `installation-name.server.test.ts`; this spec pins what a user SEES.
 */
import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeProject } from "./fixtures/data.js";
import { setupAuthorReviewMock } from "./fixtures/extension-source-import.js";
import type { Page } from "@playwright/test";

const INSTALLATION = "f8e7b665-d62e-4623-8a17-55c25fa21591";
const proj = makeProject({ id: "proj-author-heading", name: "Authoring Project" });

function reviewData(extensionName: string | null): Record<string, unknown> {
	const installation = {
		id: INSTALLATION,
		ownerId: "mock-owner",
		scope: "global",
		activeReleaseId: null,
		generation: 0,
		enabled: false,
		uninstalled: false,
		status: "disabled",
		grants: [],
		acknowledgedGeneration: 0,
	};
	return {
		installations: [installation],
		state: { installation, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: {} },
		extensionName,
		breadcrumbTail: extensionName,
		workspace: null,
		files: {},
		sourceUnavailable: null,
		canApprove: false,
		canBindProject: false,
		projects: [],
		projectBinding: null,
	};
}

/** Client-side navigation to the author route so the mocked loader answers. */
async function openAuthorPage(page: Page) {
	await page.goto("/extensions");
	await page.evaluate((href) => {
		const link = document.createElement("a");
		link.href = href;
		link.textContent = "Open author page";
		link.dataset.testid = "e2e-open-author";
		document.body.append(link);
	}, `/extensions/author?installation=${INSTALLATION}`);
	await page.getByTestId("e2e-open-author").click();
	await expect(page).toHaveURL((url) => url.pathname === "/extensions/author" && url.searchParams.get("installation") === INSTALLATION);
}

test.describe("Extension author page — heading and breadcrumb", () => {
	test.describe("desktop", () => {
		test.use({ viewport: { width: 1280, height: 800 } });

		test("names the extension in the heading, title and deck breadcrumb @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj] });
			const review = await setupAuthorReviewMock(page, { installationId: INSTALLATION, reviewData: () => reviewData("memory-extractor") });
			try {
				await openAuthorPage(page);
				await expect(page.getByRole("heading", { level: 1 })).toHaveText("memory-extractor");
				await expect(page).toHaveTitle("memory-extractor · Extension workspace");
				const crumb = page.getByTestId("deck-breadcrumb");
				await expect(crumb).toContainText("Extensions");
				await expect(crumb.getByTestId("deck-breadcrumb-tail")).toHaveText("memory-extractor");
				await captureEvidence(page, testInfo, "extension-author-heading-named");
			} finally {
				await review.close();
			}
		});
	});

	test.describe("mobile", () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test("names the extension in the heading and the breadcrumb strip on a phone @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj] });
			const review = await setupAuthorReviewMock(page, { installationId: INSTALLATION, reviewData: () => reviewData("memory-extractor") });
			try {
				await openAuthorPage(page);
				await expect(page.getByRole("heading", { level: 1 })).toHaveText("memory-extractor");
				const crumb = page.getByTestId("deck-breadcrumb");
				await expect(crumb).toBeVisible();
				await expect(crumb.getByTestId("deck-breadcrumb-tail")).toHaveText("memory-extractor");
				await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
				await captureEvidence(page, testInfo, "extension-author-heading-named-mobile");
			} finally {
				await review.close();
			}
		});
	});

	test("keeps the generic heading when the installation has no name yet", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const review = await setupAuthorReviewMock(page, { installationId: INSTALLATION, reviewData: () => reviewData(null) });
		try {
			await openAuthorPage(page);
			await expect(page.getByRole("heading", { level: 1 })).toHaveText("Extension workspace");
			await expect(page).toHaveTitle("Extension workspace");
			await expect(page.getByTestId("deck-breadcrumb-tail")).toHaveCount(0);
		} finally {
			await review.close();
		}
	});
});
