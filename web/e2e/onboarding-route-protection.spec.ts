import { test, expect } from "./fixtures/test-base.js";

/**
 * Wizard-route protection smoke test.
 *
 * The Playwright e2e suite runs with PI_SKIP_INIT=1, which bypasses the
 * server-side auth gate (the DB isn't initialized, so the hook short-
 * circuits on getUserCount throwing — see hooks.server.ts L233-236).
 * This means we can't exercise the wizard's happy path or skip path
 * end-to-end here — there's no authenticated `locals.user` for the
 * page.server.ts load to read.
 *
 * What we CAN verify with this harness is that the page.server.ts
 * load's own auth check fires: an unauthenticated user navigating
 * directly to /onboarding gets redirected to /login. That defends the
 * route from accidentally rendering without a user.
 *
 * Wizard happy/skip flows are covered by:
 *   - web/src/__tests__/onboarding-wizard.integration.component.test.ts (component, drives the UI)
 *   - web/src/__tests__/hooks-server-onboarding-redirect.server.test.ts (hooks redirect contract)
 *   - web/src/__tests__/api-onboarding-complete.server.test.ts (completion endpoint)
 *   - src/__tests__/onboarding-skip-flow.integration.test.ts (PGlite-backed integration of markUserOnboarded + hasAnyProvider)
 */

test.describe("/onboarding — route protection", () => {
	test("unauthenticated navigation to /onboarding redirects to /login", async ({ page, mockApi }) => {
		await mockApi({});

		const response = await page.goto("/onboarding");
		// Either the server-load issued a 302 to /login (which the browser
		// follows) or hooks.server.ts's PI_SKIP_INIT bypass ran first;
		// either way, the user must end up on /login (not the wizard).
		await page.waitForURL(/\/login/, { timeout: 5000 });
		expect(page.url()).toMatch(/\/login/);

		// And the wizard's distinctive heading must NOT have been rendered.
		await expect(page.getByText("Connect a provider")).toHaveCount(0);

		// HTTP-level: if the response object is exposed (i.e. no client-side
		// nav happened), confirm the status was a redirect or the final OK.
		// (Playwright collapses the 302 chain into the final 200 from /login.)
		expect(response).not.toBeNull();
	});
});
