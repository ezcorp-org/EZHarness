/**
 * THE DEEP-LINK GUARD (browser side) — @evidence.
 *
 * After a successful install the server hands the user exactly one link:
 * `/extensions/<manifest-name>` (the author form's `redirectUrl`, and the
 * `install_draft` card's "Open extension" button `openUrl`). It landed on
 * "Extension not found", because the detail route resolved its param by id
 * equality only. The existing author-flow spec passed the whole time — it
 * asserted the URL STRING and never looked at the page.
 *
 * So every assertion here is about the RENDERED RESULT of a link, and the
 * links under test are the three the product actually hands a user:
 *
 *   1. the post-install deep-link shape           `/extensions/<name>`
 *   2. the extensions library's card link          `/extensions/<id>`
 *      — read off the RENDERED card's href, not re-typed here
 *   3. the detail page's own "Audit" link          — likewise
 *
 * WHAT THIS TIER PROVES (and what it deliberately leaves to its siblings).
 * The backend is mocked here, so the mock IS the contract: it reproduces the
 * real server's split exactly —
 *
 *   GET /api/extensions/<ref>            resolves id OR manifest name
 *                                        (`getExtensionByRef`)
 *   every other extension endpoint       id ONLY — 404 on a name
 *                                        (settings / permissions / violations
 *                                        / audit / expired-grants / reopen …)
 *
 * — which is why the page must resolve the route reference ONCE and then
 * canonicalise on the row's id for every downstream call. That client-side
 * half is what this spec falsifies: point `extId` back at the raw route param
 * (or fire the loaders before the row resolves) and these tests go red.
 *
 * The SERVER half — that `GET /api/extensions/<name>` really resolves — is
 * covered by `src/__tests__/extension-deep-link-resolution.test.ts` against a
 * real DB and the real install pipeline, and end-to-end against a live server
 * by `web/e2e/real-auth/extension-author-flow.spec.ts`.
 */
import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeProject, makeExtension } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

// A row whose id and name are unmistakably different, so an assertion can
// never accidentally pass by them being interchangeable.
const ROW = makeExtension({
	id: "7f3a91c4-0d2e-4b88-9a51-6c0e2f4d1a77",
	name: "e2e-deeplink-weather",
	description: "Deep-link guard fixture",
	enabled: true,
});
ROW.manifest.name = ROW.name;

/** The deep-link the server mints post-install (`installAuthoredDraft`). */
const POST_INSTALL_LINK = `/extensions/${ROW.name}`;

const USER_ME = {
	user: { id: "user-1", email: "user@test.local", name: "Test User", role: "admin" },
};

/**
 * Install the faithful backend stand-in described in the header, and return
 * the list of sub-resource requests that were addressed by NAME rather than
 * by the row id. On the fixed page that list stays empty; before the fix it
 * held every loader the detail page fires.
 */
async function mockExtensionApi(page: Page): Promise<string[]> {
	const nameAddressed: string[] = [];

	await page.route(/\/api\/extensions\/.+/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const m = /^\/api\/extensions\/([^/]+)(\/.*)?$/.exec(path);
		if (!m) return route.fallback();
		const ref = decodeURIComponent(m[1]!);
		const sub = m[2] ?? "";

		// The detail read — the ONE reference-addressed endpoint.
		if (sub === "") {
			return ref === ROW.id || ref === ROW.name
				? route.fulfill({ json: ROW })
				: route.fulfill({ status: 404, json: { error: "Not found" } });
		}

		// Everything else is id-only in production. A name here is the bug.
		if (ref !== ROW.id) {
			nameAddressed.push(path);
			return route.fulfill({ status: 404, json: { error: "Not found" } });
		}
		if (sub === "/settings") {
			return route.fulfill({
				json: { schema: null, declaredDefaults: {}, userValues: {}, resolved: {}, secrets: {}, capabilities: [] },
			});
		}
		if (sub === "/violations") return route.fulfill({ json: [] });
		if (sub === "/audit") return route.fulfill({ json: { entries: [] } });
		if (sub === "/expired-grants") return route.fulfill({ json: { grants: [] } });
		return route.fulfill({ json: {} });
	});

	return nameAddressed;
}

/**
 * The rendered detail page for ROW — NOT the not-found branch, and with no
 * failed loader banner (a 404 from a name-addressed `/settings` surfaces as
 * "Failed to load settings (HTTP 404)").
 */
async function expectDetailRendered(page: Page, nameAddressed: string[]) {
	// Level 2 + exact: the tools list renders each tool name as a heading too.
	await expect(
		page.getByRole("heading", { level: 2, name: ROW.name, exact: true }),
	).toBeVisible({ timeout: 10_000 });
	await expect(page.getByText("Extension not found")).toHaveCount(0);
	await expect(page.getByTestId("extension-settings-section")).toBeVisible();
	await expect(page.getByText(/Failed to load settings/)).toHaveCount(0);
	expect(
		nameAddressed,
		`id-only endpoint(s) were called with the route REFERENCE instead of the resolved row id`,
	).toEqual([]);
}

test.describe("server-minted /extensions deep-links resolve to a rendered page", () => {
	test("@evidence post-install link /extensions/<name> renders the extension, and every action targets the resolved id", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], extensions: [ROW], routes: { "/api/auth/me": () => USER_ME } });
		const nameAddressed = await mockExtensionApi(page);

		await page.goto(POST_INSTALL_LINK);

		await expectDetailRendered(page, nameAddressed);
		// The friendly URL is the contract the tool result, the install card
		// and the README all document — resolving it must not rewrite it.
		expect(new URL(page.url()).pathname).toBe(POST_INSTALL_LINK);

		await captureEvidence(page, testInfo, "extension-detail-via-post-install-deep-link");
	});

	test("the extensions library's card link renders the detail page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [ROW], routes: { "/api/auth/me": () => USER_ME } });
		const nameAddressed = await mockExtensionApi(page);

		await page.goto("/extensions");
		// Read the href the library ACTUALLY renders rather than re-typing the
		// shape — that is the thing users click.
		const card = page.getByTestId("ext-card").filter({ hasText: ROW.name });
		await expect(card).toBeVisible({ timeout: 10_000 });
		const href = await card.getByRole("link").first().getAttribute("href");
		expect(href).toBe(`/extensions/${ROW.id}`);

		await page.goto(href!);
		await expectDetailRendered(page, nameAddressed);
	});

	test("the detail page's Audit link is built from the resolved id, not the route reference", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], extensions: [ROW], routes: { "/api/auth/me": () => USER_ME } });
		const nameAddressed = await mockExtensionApi(page);

		// Arrive by NAME — the worst case: every link the page mints from here
		// on must still carry the row id.
		await page.goto(POST_INSTALL_LINK);
		await expectDetailRendered(page, nameAddressed);

		await expect(page.getByTestId("extension-detail-audit-link")).toHaveAttribute(
			"href",
			`/extensions/${ROW.id}/audit`,
		);
	});
});
