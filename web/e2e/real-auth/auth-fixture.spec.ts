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
import { test, expect } from "../fixtures/hydration.js";
import type { Page } from "@playwright/test";
import { TEST_USER } from "../real-auth-setup";

async function invalidateBrowserCookie(page: Page) {
	const session = (await page.context().cookies()).find((cookie) => cookie.name === "ezcorp_session");
	expect(session, "the real-auth setup must supply a session cookie").toBeDefined();
	await page.context().addCookies([{ ...session!, value: "invalid-session-for-e2e" }]);
}

test.describe("Real-auth harness", () => {
	test("an invalid session cookie redirects to login and shows the expiry warning", async ({ page }) => {
		await invalidateBrowserCookie(page);
		const response = await page.goto("/settings");
		expect(response?.status()).toBe(200);
		await expect(page).toHaveURL((url) => url.pathname === "/login"
			&& url.searchParams.get("reason") === "session_expired"
			&& url.searchParams.get("returnTo") === "/settings");
		await expect(page.getByText("Your session has expired. Please log in again.", { exact: true })).toBeVisible();
		expect((await page.context().cookies()).filter((cookie) => cookie.name === "ezcorp_session")).toEqual([]);
	});

	test("an invalid session cookie returns a real API 401 and is cleared", async ({ page }) => {
		await invalidateBrowserCookie(page);
		const response = await page.request.get("/api/projects");
		expect(response.status()).toBe(401);
		expect(await response.json()).toEqual({ error: "Session expired" });
		expect((await page.context().cookies()).filter((cookie) => cookie.name === "ezcorp_session")).toEqual([]);
	});

	test("a logged-out session cannot be replayed and clears both cookie names", async ({ page }) => {
		// A separate login keeps the shared setup session valid for other tests.
		const login = await page.request.post("/api/auth/login", { data: { email: TEST_USER.email, password: TEST_USER.password } });
		expect(login.status()).toBe(200);
		const session = (await page.context().cookies()).find((cookie) => cookie.name === "ezcorp_session");
		expect(session).toBeDefined();
		const logout = await page.request.post("/api/auth/logout");
		expect(logout.status()).toBe(200);
		await page.context().addCookies([session!, { ...session!, name: "pi_session" }]);
		const response = await page.request.get("/api/projects");
		expect(response.status()).toBe(401);
		expect(await response.json()).toEqual({ error: "Session revoked" });
		expect((await page.context().cookies()).filter((cookie) => ["ezcorp_session", "pi_session"].includes(cookie.name))).toEqual([]);
	});

	test("/api/auth/me returns the bootstrapped admin", async ({ request }) => {
		const res = await request.get("/api/auth/me");
		expect(res.ok()).toBe(true);
		const body = (await res.json()) as { user?: { email?: string; role?: string } };
		expect(body.user?.email).toBe(TEST_USER.email);
		expect(body.user?.role).toBe("admin");
	});

	test("GET / lands an authenticated user in chat (no login redirect)", async ({ page }) => {
		// Complementary to the `/api/auth/me` request-context test above:
		// this navigates via the browser so we also exercise the
		// page-level cookie path. `hooks.server.ts` lists `/login` and
		// `/setup` as public; everything else redirects unauthenticated
		// users to `/login`. So if the storageState cookie replay broke,
		// `/` would 302 → /login and we'd land on `/login` — exactly the
		// failure this sanity test catches.
		//
		// `routes/+page.svelte` is an authenticated-only redirect shim: on
		// mount it picks the active project (default `global`) and
		// `goto`s `/project/<id>/chat`. So the deterministic, auth-gated
		// signal is the final URL settling under `/project/.../chat`
		// rather than `/login` or `/setup`. We wait for that client-side
		// navigation with an auto-retrying `waitForURL` (no bare sleep) —
		// if auth had failed, the hooks redirect would have sent us to
		// `/login` and this wait would time out instead.
		const resp = await page.goto("/");
		expect(resp?.ok() || resp?.status() === 304).toBe(true);
		await page.waitForURL(/\/project\/[^/]+\/chat/, { timeout: 10_000 });
		const finalUrl = new URL(page.url());
		expect(finalUrl.pathname).not.toBe("/login");
		expect(finalUrl.pathname).not.toBe("/setup");
		expect(finalUrl.pathname).toMatch(/^\/project\/[^/]+\/chat/);

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
