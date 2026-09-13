/**
 * E2E — the author page's "Your installations" list names what it links to
 * (frontend-visual change ⇒ `@evidence` per the feature contract).
 *
 * The list used to print a raw installation id per row, which told an author
 * nothing about which workspace a row would open. Each row now leads with the
 * extension name and keeps the id as muted secondary text underneath. A row
 * whose name is not known yet falls back to the id alone — no empty second
 * line, no placeholder.
 *
 * RENDER tier: `mockPageData` fulfils the SvelteKit `__data.json` request for
 * the author route, so the list is reached through a client-side navigation
 * from /extensions (an injected same-origin link, which the SvelteKit router
 * intercepts). Name RESOLUTION is unit-tested in
 * `installation-name.server.test.ts`; this spec pins what a user SEES.
 */
import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeProject } from "./fixtures/data.js";
import { mockPageData } from "./fixtures/page-data.js";
import type { Page } from "@playwright/test";

const NAMED = "3b0f9c41-6f3a-4d0b-9a2e-1c7d5e8f4a62";
const UNNAMED = "a94d27e8-51bc-4f37-8c6a-0e9b3d2f7c15";
const proj = makeProject({ id: "proj-author-installations", name: "Authoring Project" });

function installation(id: string, name: string | null, status: string): Record<string, unknown> {
	return { id, name, status, ownerId: "mock-owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, grants: [], acknowledgedGeneration: 0 };
}

/** The LIST branch of the author load: no selected installation, so no state. */
const listData: Record<string, unknown> = {
	installations: [installation(NAMED, "memory-extractor", "active"), installation(UNNAMED, null, "disabled")],
	state: null,
	extensionName: null,
	breadcrumbTail: null,
	workspace: null,
	files: {},
	sourceUnavailable: null,
	canApprove: false,
	canBindProject: false,
	projects: [],
	projectBinding: null,
};

/** Client-side navigation to the author route so the mocked loader answers. */
async function openInstallationList(page: Page) {
	await mockPageData(page, "/extensions/author", listData);
	await page.goto("/extensions");
	await page.evaluate(() => {
		const link = document.createElement("a");
		link.href = "/extensions/author";
		link.textContent = "Open author page";
		link.dataset.testid = "e2e-open-author";
		document.body.append(link);
	});
	await page.getByTestId("e2e-open-author").click();
	await expect(page).toHaveURL((url) => url.pathname === "/extensions/author" && !url.searchParams.has("installation"));
	await expect(page.getByRole("heading", { name: "Your installations" })).toBeVisible();
}

test.describe("Extension author page — installation list", () => {
	test.describe("desktop", () => {
		test.use({ viewport: { width: 1280, height: 800 } });

		test("leads each row with the extension name and keeps the id secondary @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj] });
			await openInstallationList(page);

			const named = page.getByRole("link", { name: /memory-extractor/ });
			await expect(named).toHaveAttribute("href", `?installation=${NAMED}`);
			await expect(named.locator(".installation-id")).toHaveText(NAMED);
			await expect(named.locator(".installation-status")).toHaveText("active");

			const unnamed = page.getByRole("link", { name: new RegExp(UNNAMED) });
			await expect(unnamed).toHaveAttribute("href", `?installation=${UNNAMED}`);
			await expect(unnamed).toHaveText(`${UNNAMED}disabled`);
			await expect(unnamed.locator(".installation-id")).toHaveCount(0);

			await captureEvidence(page, testInfo, "extension-author-installations-named");
		});
	});

	test.describe("mobile", () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test("fits the name, id and status in a phone-width row @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj] });
			await openInstallationList(page);

			// A 36-character id under a name is the widest this row ever gets.
			// The id column and the status must stay side by side, inside the
			// viewport — not overlapping, not scrolling the page sideways.
			const named = page.getByRole("link", { name: /memory-extractor/ });
			const row = (await named.boundingBox())!;
			const id = (await named.locator(".installation-id").boundingBox())!;
			const status = (await named.locator(".installation-status").boundingBox())!;
			expect(row.x + row.width).toBeLessThanOrEqual(390);
			expect(id.x + id.width).toBeLessThanOrEqual(status.x);
			expect(id.y).toBeGreaterThan(status.y);

			// The id wraps (it is one long unbroken token), but the status is a
			// word and must never break mid-word to make room for it. One client
			// rect per status = one line.
			for (const badge of await page.locator(".installation-status").all()) {
				expect(await badge.evaluate((node) => node.getClientRects().length)).toBe(1);
			}

			await captureEvidence(page, testInfo, "extension-author-installations-named-mobile");
		});
	});
});
