import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

/**
 * Verifies the chat empty-state "Connect a provider" banner — the
 * safety net for users who skipped the provider step in the onboarding
 * wizard. The banner reads /api/quickstart's provider field and is
 * intentionally non-dismissable: nagging stops only when an actual
 * provider is configured.
 *
 * The chat page itself is exercised here (rather than the banner in
 * isolation, which the component tests cover) to lock in the wiring
 * inside +page.svelte's empty state.
 */

test.describe("Chat empty-state — no-provider banner", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	test("shows banner when /api/quickstart reports provider:false", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [],
			routes: {
				"/api/quickstart": () => ({
					steps: { provider: false, chat: false, extension: false, agent: false },
				}),
			},
		});

		await page.goto("/project/proj-1/chat");

		const banner = page.getByTestId("no-provider-banner");
		await expect(banner).toBeVisible({ timeout: 5000 });
		await expect(banner).toContainText("Connect a provider to start chatting");

		const cta = page.getByTestId("no-provider-banner-cta");
		await expect(cta).toHaveAttribute("href", "/settings/models#providers");
	});

	test("hides banner when /api/quickstart reports provider:true", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [],
			routes: {
				"/api/quickstart": () => ({
					steps: { provider: true, chat: false, extension: false, agent: false },
				}),
			},
		});

		await page.goto("/project/proj-1/chat");

		// Banner must NOT appear. Wait briefly to give the empty-state
		// time to render with provider state, then assert absence.
		await page.waitForLoadState("networkidle");
		await expect(page.getByTestId("no-provider-banner")).toHaveCount(0);
	});

	test("banner has no dismiss control — only a CTA link out", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [],
			routes: {
				"/api/quickstart": () => ({
					steps: { provider: false, chat: false, extension: false, agent: false },
				}),
			},
		});

		await page.goto("/project/proj-1/chat");

		const banner = page.getByTestId("no-provider-banner");
		await expect(banner).toBeVisible({ timeout: 5000 });

		// No buttons inside the banner — only the CTA anchor.
		await expect(banner.locator("button")).toHaveCount(0);
		// No close/dismiss controls of any kind.
		await expect(banner.locator('[aria-label*="dismiss" i]')).toHaveCount(0);
		await expect(banner.locator('[aria-label*="close" i]')).toHaveCount(0);
	});
});
