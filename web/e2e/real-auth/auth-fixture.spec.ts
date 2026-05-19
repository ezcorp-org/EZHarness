/**
 * Sanity test for the real-auth Playwright harness itself.
 *
 * If this spec passes, the harness is wired correctly:
 *  - `globalSetup` bootstrapped an admin via POST /api/auth/setup
 *  - login succeeded and the session cookie was persisted to
 *    `.real-auth.json`
 *  - `use.storageState` is replaying the cookie into every test
 *  - hooks.server.ts is letting the cookie through end-to-end
 *
 * Every later real-auth spec depends on this contract — if this one
 * goes red, fix the harness BEFORE chasing failures in feature specs.
 */
import { test, expect } from "@playwright/test";
import { TEST_USER } from "../real-auth-setup";

test.describe("Real-auth harness", () => {
	test("/api/auth/me returns the bootstrapped admin", async ({ request }) => {
		const res = await request.get("/api/auth/me");
		expect(res.ok()).toBe(true);
		const body = (await res.json()) as { user?: { email?: string; role?: string } };
		expect(body.user?.email).toBe(TEST_USER.email);
		expect(body.user?.role).toBe("admin");
	});

	test("GET / renders the authenticated landing page (no redirect)", async ({ page }) => {
		// Complementary to the `/api/auth/me` request-context test above:
		// this navigates via the browser so we also exercise the
		// page-level cookie path. `hooks.server.ts:289` lists `/login`
		// and `/setup` as public; everything else redirects unauthenticated
		// users to `/login`. So if the storageState cookie replay broke,
		// the GET / response would 302 → /login and `finalUrl.pathname`
		// would be `/login` — exactly the failure we want this sanity
		// test to catch.
		//
		// We assert on a SERVER-rendered marker (`data-testid="landing-controls"`
		// in `routes/+page.svelte:111`) rather than a client-fetched
		// element. The previous `.user-menu-container` selector lived
		// inside `(app)/+layout.svelte` and was only injected AFTER an
		// onMount `fetch('/api/auth/me')` resolved — a JS-hydration race
		// the harness couldn't reliably win. The server-rendered testid
		// is deterministic: either auth let us through and the controls
		// render, or we got redirected and the locator times out.
		const resp = await page.goto("/");
		expect(resp?.ok() || resp?.status() === 304).toBe(true);
		const finalUrl = new URL(page.url());
		expect(finalUrl.pathname).not.toBe("/login");
		expect(finalUrl.pathname).not.toBe("/setup");
		await expect(page.getByTestId("landing-controls")).toBeVisible({ timeout: 10_000 });

		// Page-context proof: cookie travels with the browser too.
		// Using `page.request` (NOT the top-level `request` fixture)
		// shares the page's storage state — a distinct path from the
		// line-18 test.
		const meRes = await page.request.get("/api/auth/me");
		expect(meRes.ok()).toBe(true);
		const meBody = (await meRes.json()) as { user?: { email?: string } };
		expect(meBody.user?.email).toBe(TEST_USER.email);
	});
});
