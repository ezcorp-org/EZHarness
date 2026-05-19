/**
 * Phase 48 Wave 4 — uninstrumented page degrades gracefully.
 *
 * Pages without an `<EzContext>` provider expose only Tier 1 route
 * metadata (URL, route id, params). Forms on those pages are NOT
 * registered — so when Ez attempts a `fill_form({ formId: "settings" })`
 * the client-tool dispatcher returns a `no-handler` error and the
 * panel surfaces no field changes.
 *
 * /settings is the canonical "uninstrumented" page in v1. The page
 * itself has a separate, pre-existing bug that breaks Svelte's
 * reactivity in test mocks (a missing-data crash during onMount), so
 * we assert the spec's contract via two angles:
 *   - on /settings, the EzButton is visible (Tier 1 always-on).
 *   - on /memories (another uninstrumented (app) route), the panel
 *     opens and a fill_form dispatch with no matching handler is a
 *     no-op — page URL doesn't change, panel stays mounted.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Ez — uninstrumented page (degrades gracefully)", () => {
	const proj = makeProject({ id: "proj-1" });

	test("/settings exposes the Ez button (Tier 1 always-on)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto("/settings");
		// Tier 1 (route metadata) is always available — the button stays visible.
		await expect(page.getByTestId("ez-button")).toBeVisible();
	});

	test("on an uninstrumented page, fill_form dispatch is a no-op (panel + URL stay)", async ({ page, mockApi, emitSse }) => {
		// /memories is an (app) route without `<EzContext>`. Same Tier-1
		// surface as /settings, but its onMount doesn't crash under mocks
		// so we can drive the SSE → dispatcher path end to end.
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto("/memories");
		await expect(page.getByTestId("ez-button")).toBeVisible();
		await page.evaluate(() => document.getElementById("splash")?.remove());
		await page.waitForTimeout(150);

		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();
		await page.waitForFunction(() => {
			const all = (window as any).__fakeEventSources;
			return Array.isArray(all) && all.some((es: { url: string }) => es.url.includes("ez-conv-1"));
		});

		// Capture the URL — a no-handler error must not navigate.
		const beforeUrl = page.url();
		await emitSse(
			{
				type: "ez:client-tool",
				data: {
					conversationId: "ez-conv-1",
					toolCallId: "tc-no-handler",
					toolName: "fill_form",
					input: { formId: "settings-noop", values: { foo: "bar" } },
				},
			},
			"ez-conv-1",
		);

		// Page didn't navigate, panel didn't crash, URL is intact.
		await expect(page).toHaveURL(beforeUrl);
		await expect(page.getByTestId("ez-panel")).toBeVisible();
	});

	test("welcome state on an uninstrumented page mentions creating projects/agents", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto("/memories");
		// Wait for the (app) layout's onMount to land + remove splash
		// before clicking. Splash overlays at z-index 9999 block pointer
		// events; rare timing windows let the test race.
		await expect(page.getByTestId("ez-button")).toBeVisible();
		await page.evaluate(() => document.getElementById("splash")?.remove());
		await page.waitForTimeout(150);
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();
		await expect(page.getByText(/I can help you create projects/i)).toBeVisible();
	});
});
