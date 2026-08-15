import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { makeProject } from "./fixtures/data.js";

/**
 * Regression: opening the app trapped some users in an endless redirect loop.
 *
 * `/` resumes to `localStorage["ezcorp-last-path"]`, and the `(app)` layout's
 * `afterNavigate` deliberately never records `/`. So when a route bounced the
 * user home — the client admin guard on `/admin/dashboard`, or the server
 * `redirect(302, "/")` on `/admin/moderation` — the saved path still pointed at
 * that route, and `/` sent them straight back in. Measured before the fix:
 * 11 flips between `/` and `/admin/dashboard` in 5 seconds.
 *
 * It is a CLIENT-NAV loop, so there is exactly one navigation entry, no reload,
 * and no browser loop-breaker ever fires — the app just thrashes on launch. It
 * reaches any demoted admin, and any user whose `/api/auth/me` call fails on a
 * cold resume (the guard treats a bare `catch` as "not admin").
 *
 * The fix consumes the resume token, so a bounce can happen at most once.
 */

const proj = makeProject({ id: "proj-rb", name: "Resume Bounce" });

const LAST_PATH_KEY = "ezcorp-last-path";

/** Answer `/api/auth/me` with a non-admin identity, so admin guards bounce. */
async function asNonAdmin(page: Page) {
	await page.route("**/api/auth/me", (route) =>
		route.fulfill({
			json: { user: { id: "u1", name: "Regular", email: "u@example.com", role: "user" } },
		}),
	);
}

/** Sample the pathname over ~4s and report how often it changed. */
async function watchPath(page: Page): Promise<{ samples: string[]; flips: number }> {
	const samples: string[] = [];
	for (let i = 0; i < 20; i++) {
		samples.push(new URL(page.url()).pathname);
		await page.waitForTimeout(200);
	}
	let flips = 0;
	for (let i = 1; i < samples.length; i++) if (samples[i] !== samples[i - 1]) flips++;
	return { samples, flips };
}

/**
 * Seed the saved last-path, but only once the app's OWN save for the current
 * page has landed.
 *
 * `/` resumes on load and then records whatever route it resolved to, so a
 * write that lands before that save is silently clobbered and the next `/`
 * resumes to the app's value instead of ours. Waiting for the first save is the
 * deterministic ordering, not a sleep — same reasoning (and the same race) as
 * `seedLastPath` in `resume-last-path.spec.ts`.
 */
async function seedLastPath(page: Page, value: string) {
	await expect
		.poll(() => page.evaluate((k) => localStorage.getItem(k), LAST_PATH_KEY), { timeout: 7000 })
		.not.toBeNull();
	await page.evaluate(
		([k, v]) => localStorage.setItem(k, v),
		[LAST_PATH_KEY, value] as const,
	);
}

async function seedAndOpen(
	page: Page,
	mockApi: (o?: MockOverrides) => Promise<void>,
	lastPath: string,
) {
	await mockApi({ projects: [proj], conversations: [] });
	await asNonAdmin(page);
	await page.goto("/");
	await seedLastPath(page, lastPath);
	await page.goto("/");
}

test.describe("resuming into a route that bounces home", () => {
	test("does not ping-pong between / and the bouncing route", async ({ page, mockApi }) => {
		await seedAndOpen(page, mockApi, "/admin/dashboard");

		const { samples, flips } = await watchPath(page);
		// Before the fix this oscillated continuously (11 flips in 5s). The
		// resume is now one-shot, so the path must settle.
		expect(flips).toBeLessThanOrEqual(2);
		expect(samples[samples.length - 1]).not.toBe("/admin/dashboard");
	});

	test("settles on a usable route instead of the guarded one", async ({ page, mockApi }) => {
		await seedAndOpen(page, mockApi, "/admin/dashboard");
		await page.waitForTimeout(3000);

		// The user lands somewhere they can actually use, not on `/` and not
		// back inside the route that rejected them.
		const settled = new URL(page.url()).pathname;
		expect(settled).not.toBe("/admin/dashboard");
		expect(settled).toMatch(/^\/project\//);
	});

	test("the poisoned resume path is not left behind for the next open", async ({
		page,
		mockApi,
	}) => {
		await seedAndOpen(page, mockApi, "/admin/dashboard");
		await page.waitForTimeout(3000);

		const saved = await page.evaluate((k) => localStorage.getItem(k), LAST_PATH_KEY);
		expect(saved).not.toBe("/admin/dashboard");
	});

	test("the bounced user lands on a rendered, usable screen @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		// Evidence that the loop ends in a real UI, not a blank frame mid-bounce.
		await seedAndOpen(page, mockApi, "/admin/dashboard");
		await page.waitForURL(/\/project\//, { timeout: 7000 });
		await expect(page.locator("main")).toBeVisible();
		await captureEvidence(page, testInfo, "resume-bounce-settled");
	});

	test("a normal resume target is still honoured and re-recorded", async ({ page, mockApi }) => {
		// The fix must not cost anyone their resume. A route that renders is
		// recorded again by the (app) layout, so the NEXT open resumes to it.
		await mockApi({ projects: [proj], conversations: [] });
		await page.goto("/");
		await seedLastPath(page, `/project/${proj.id}/chat`);

		await page.goto("/");
		await page.waitForURL(`**/project/${proj.id}/chat`, { timeout: 7000 });

		// Re-recorded, so resume survives across opens.
		await expect
			.poll(() => page.evaluate((k) => localStorage.getItem(k), LAST_PATH_KEY), {
				timeout: 7000,
			})
			.toBe(`/project/${proj.id}/chat`);

		await page.goto("/");
		await page.waitForURL(`**/project/${proj.id}/chat`, { timeout: 7000 });
	});
});
