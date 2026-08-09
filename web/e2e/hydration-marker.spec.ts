/**
 * The hydration marker — the app's one unambiguous "the client is alive"
 * signal (issue #145).
 *
 * Every route here is server-rendered, so the readiness gate almost every
 * spec used ("wait for this text to be visible, then type") is satisfied at
 * FIRST PAINT: the text, the `<textarea>` and the send button are all in the
 * raw HTML with zero JavaScript executed. On a starved runner the `fill()`
 * that follows lands on the pre-hydration node, hydration re-creates the
 * composer with `value = ""`, the typed text is discarded, and the send
 * button is permanently disabled — the click then burns its whole timeout.
 *
 * `app.html` now ships `data-hydrated="false"` and the root `+layout.svelte`
 * onMount flips it to `"true"`, so `fixtures/test-base.ts` can gate EVERY
 * `page.goto` on it automatically. These tests pin the three properties that
 * make that gate trustworthy:
 *
 *   1. the server really does send `false` (so the marker cannot false-pass
 *      the way a text assertion does),
 *   2. the client really does flip it to `true`, on an app route AND on the
 *      SvelteKit error page (which `app.html` also wraps),
 *   3. by the time a wrapped `goto` returns, the composer is live — a value
 *      typed immediately after it STICKS, which is the exact failure the
 *      pre-hydration DOM produced.
 *
 * `@evidence`: `web/src/routes/+layout.svelte` is the root layout every
 * screen mounts inside; this is the spec that renders it as itself rather
 * than as a backdrop, so a regression in the shared chrome is witnessed here.
 */

import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Hydration Project" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	title: "Hydration Test",
});

test.describe("hydration marker", () => {
	test("SSR sends data-hydrated=false — the raw HTML cannot false-pass", async ({
		page,
		request,
	}) => {
		// Raw HTTP, no browser, no JavaScript: exactly what the server emits.
		const res = await request.get(`/project/${proj.id}/chat/${conv.id}`);
		expect(res.status()).toBe(200);
		const html = await res.text();

		expect(html).toContain('data-hydrated="false"');
		expect(html).not.toContain('data-hydrated="true"');

		// The premise of the bug, pinned: the things specs used to gate on are
		// ALREADY in this pre-JavaScript HTML, so they prove nothing.
		expect(html).toContain("<textarea");
		expect(html).toContain("Send a message to start the conversation");

		// And the marker survives on the error page too — app.html wraps every
		// document the app serves, so "no marker" can only ever mean "not an
		// app document", never "an app page that hasn't hydrated yet".
		const missing = await request.get("/this-route-does-not-exist");
		expect(missing.status()).toBe(404);
		expect(await missing.text()).toContain('data-hydrated="false"');

		// Guard the escape hatch in waitForHydration(): a non-app document has
		// NO marker at all, which is why gating it would otherwise hang.
		const manifest = await request.get("/manifest.json");
		expect(manifest.status()).toBe(200);
		expect(await manifest.text()).not.toContain("data-hydrated");

		// `page` is unused for the request assertions above but the fixture is
		// what makes `request` share the app's baseURL; keep it honest.
		expect(page.url()).toBe("about:blank");
	});

	test("@evidence the client flips it to true, and the composer is live once goto returns", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });

		// The wrapped `goto` (fixtures/test-base.ts) already waits for this.
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");

		// The whole point: typing straight after the gate STICKS. Pre-fix this
		// raced hydration and the value was silently thrown away.
		const textarea = page.locator("textarea").first();
		await textarea.fill("hydrated input survives");
		await expect(textarea).toHaveValue("hydrated input survives");

		// …and the send button therefore leaves its permanently-disabled state.
		await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

		await captureEvidence(page, testInfo, "hydration-marker-chat-shell");
	});

	test("@evidence the SvelteKit error page hydrates too", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });

		await page.goto("/this-route-does-not-exist");
		await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");

		await captureEvidence(page, testInfo, "hydration-marker-error-page");
	});
});
