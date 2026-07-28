/**
 * Extension detail page — route-REFERENCE handling (mock tier) — @evidence.
 *
 * ─── WHAT THIS FILE PROVES, AND WHAT IT DOES NOT ─────────────────────────
 *
 * It does NOT prove that the server resolves `/extensions/<manifest-name>`.
 * It CANNOT: this is the mock tier, the backend is fetch-stubbed, and
 * `GET /api/extensions/<ref>` returns whatever the stub below says it does.
 * Reverting `getExtensionByRef` to the id-only lookup leaves this file GREEN.
 * That half of the fix is guarded by:
 *   - `src/__tests__/extension-deep-link-resolution.test.ts` — real PGlite,
 *     the real `installAuthoredDraft`, deep-links read off the producer; and
 *   - `web/e2e/real-auth/extension-author-flow.spec.ts` — a live server, a
 *     real install, a real browser on the real `redirectUrl`.
 * Both redden when the resolver is reverted. This file is not a substitute
 * for either, and an earlier draft of it overclaimed exactly that in its
 * title.
 *
 * What it DOES prove is the other half of the same bug, which neither of
 * those two isolates: the PAGE's behaviour, given a server contract. The
 * production contract the stub reproduces is a SPLIT —
 *
 *   GET /api/extensions/<ref>        resolves id OR manifest name
 *   every other extension endpoint   id ONLY — 404 on a name
 *                                    (settings / permissions / violations /
 *                                     audit / expired-grants / reopen …)
 *
 * — so the page must resolve the reference ONCE and then address every
 * downstream call by the RESOLVED row id. It did not: `extId` was the raw
 * route param and `onMount` raced the loaders against the resolving fetch,
 * so on a name-addressed arrival all eight id-only endpoints 404'd. Revert
 * either half of that and the tests below go red.
 *
 * The `renders` vs `not-found` assertions are kept honest by driving BOTH
 * server contracts: the negative control uses the pre-fix id-only resolution
 * and asserts the not-found branch, so those locators are demonstrably
 * reachable rather than decorative.
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

/** The deep-link shape the server mints post-install (`installAuthoredDraft`). */
const POST_INSTALL_LINK = `/extensions/${ROW.name}`;

const USER_ME = {
	user: { id: "user-1", email: "user@test.local", name: "Test User", role: "admin" },
};

/**
 * Install the backend stand-in described in the header.
 *
 * `detailReadResolves` selects WHICH server contract the page is driven
 * against. It is the test's PREMISE — never something this file can verify:
 *   "reference" → today's server (`getExtensionByRef`: id OR name)
 *   "idOnly"    → the pre-fix server (`getExtension`: id equality)
 *
 * Returns the sub-resource requests that were addressed by NAME instead of
 * by the row id. On the fixed page that stays empty; before the fix it held
 * every loader the detail page fires.
 */
async function mockExtensionApi(
	page: Page,
	detailReadResolves: "reference" | "idOnly",
): Promise<string[]> {
	const nameAddressed: string[] = [];

	await page.route(/\/api\/extensions\/.+/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const m = /^\/api\/extensions\/([^/]+)(\/.*)?$/.exec(path);
		if (!m) return route.fallback();
		const ref = decodeURIComponent(m[1]!);
		const sub = m[2] ?? "";

		// The detail read — the ONE reference-addressed endpoint in production.
		if (sub === "") {
			const found =
				ref === ROW.id || (detailReadResolves === "reference" && ref === ROW.name);
			return found
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
 * The rendered detail page for ROW — NOT the not-found branch, no failed
 * loader banner (a 404 from a name-addressed `/settings` surfaces as
 * "Failed to load settings (HTTP 404)"), and no id-only endpoint called with
 * the raw route reference.
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

test.describe("extension detail page — resolving the route reference, canonicalising on the row id", () => {
	test("@evidence given a server that resolves the reference, arriving by name renders and every action targets the resolved id", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], extensions: [ROW], routes: { "/api/auth/me": () => USER_ME } });
		const nameAddressed = await mockExtensionApi(page, "reference");

		await page.goto(POST_INSTALL_LINK);

		await expectDetailRendered(page, nameAddressed);
		// The friendly URL is the contract the tool result, the install card
		// and the README all document — resolving it must not rewrite it.
		expect(new URL(page.url()).pathname).toBe(POST_INSTALL_LINK);

		await captureEvidence(page, testInfo, "extension-detail-via-post-install-deep-link");
	});

	// NEGATIVE CONTROL. Drives the stub with the PRE-FIX server contract
	// (id-equality only) and asserts the page falls into its not-found branch
	// — what the user actually saw after every authored install. It does not
	// prove the server was fixed; it proves the "Extension not found" locator
	// matches something real and that BOTH branches of this page are reachable
	// from this harness, so the assertions above are load-bearing rather than
	// decorative.
	test("given the pre-fix id-only server, the same URL renders the not-found branch", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], extensions: [ROW], routes: { "/api/auth/me": () => USER_ME } });
		await mockExtensionApi(page, "idOnly");

		await page.goto(POST_INSTALL_LINK);

		await expect(page.getByText("Extension not found")).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByRole("heading", { level: 2, name: ROW.name, exact: true }),
		).toHaveCount(0);
	});

	test("the library's card link shape resolves to a rendered detail page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [ROW], routes: { "/api/auth/me": () => USER_ME } });
		const nameAddressed = await mockExtensionApi(page, "reference");

		await page.goto("/extensions");
		// Read the href the library ACTUALLY renders rather than re-typing the
		// shape — that is the thing users click. Fails if the card's link shape
		// drifts to something the detail route cannot resolve.
		const card = page.getByTestId("ext-card").filter({ hasText: ROW.name });
		await expect(card).toBeVisible({ timeout: 10_000 });
		const href = await card.getByRole("link").first().getAttribute("href");
		expect(href).toBe(`/extensions/${ROW.id}`);

		await page.goto(href!);
		await expectDetailRendered(page, nameAddressed);
	});

	test("links the detail page mints carry the resolved id, not the route reference", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], extensions: [ROW], routes: { "/api/auth/me": () => USER_ME } });
		const nameAddressed = await mockExtensionApi(page, "reference");

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
