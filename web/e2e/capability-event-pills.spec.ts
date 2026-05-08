/**
 * Phase 52.5 — capability event pills in chat + settings page.
 *
 * Two surfaces:
 *   1. Settings page: "Audit & Visibility" section with three
 *      controls (built-in toggle, installed toggle, sample-N input).
 *   2. Chat: pill renders for built-in extension capability events
 *      by default; hides for installed-extension events; settings
 *      toggle reveals.
 *
 * Surface 2 is hard to drive end-to-end without a real capability
 * call (recordCapabilityCall is server-side); we instead seed a
 * synthetic `capability-event` message via the mocked /api/extensions
 * + the messages API and verify the pill component renders. The
 * unit + component tests cover the rendering logic comprehensively.
 */
import { test, expect } from "./fixtures/test-base.js";

test.describe("Audit & Visibility settings", () => {
	test("section renders with three controls (collapsed by default)", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [], extensions: [] });
		await page.goto("/settings");

		const section = page.getByTestId("settings-audit-visibility");
		await expect(section).toBeVisible();
		await expect(section).toContainText("Audit & Visibility");

		// Collapsed: toggles not visible.
		await expect(page.getByTestId("toggle-builtin-pills")).not.toBeVisible();

		// Expand.
		await section.getByRole("button", { name: /Audit & Visibility/ }).click();
		await expect(page.getByTestId("toggle-builtin-pills")).toBeVisible();
		await expect(page.getByTestId("toggle-installed-pills")).toBeVisible();
		await expect(page.getByTestId("input-event-audit-sample")).toBeVisible();
	});

	test("toggling built-in pills calls upsertSetting", async ({ page, mockApi }) => {
		await mockApi({ projects: [], extensions: [] });
		// Capture upsertSetting calls — the API is /api/settings (POST).
		const settingsCalls: Array<Record<string, unknown>> = [];
		await page.route("**/api/settings", async (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON();
				settingsCalls.push(body);
				await route.fulfill({ status: 200, json: { success: true } });
			} else {
				await route.continue();
			}
		});

		await page.goto("/settings");
		await page.getByTestId("settings-audit-visibility").getByRole("button", { name: /Audit & Visibility/ }).click();
		await page.getByTestId("toggle-builtin-pills").click();

		// Wait briefly for the network call.
		await expect.poll(() => settingsCalls.length).toBeGreaterThan(0);
		const found = settingsCalls.find(
			(c) => c.key === "global:showBuiltinCapabilityEvents",
		);
		expect(found).toBeTruthy();
	});

	test("event audit sample N input clamps out-of-range values", async ({ page, mockApi }) => {
		await mockApi({ projects: [], extensions: [] });
		await page.route("**/api/settings", async (route) => {
			if (route.request().method() === "POST") {
				await route.fulfill({ status: 200, json: { success: true } });
			} else {
				await route.continue();
			}
		});

		await page.goto("/settings");
		await page.getByTestId("settings-audit-visibility").getByRole("button", { name: /Audit & Visibility/ }).click();
		const input = page.getByTestId("input-event-audit-sample");
		await input.fill("999999");
		await input.blur();
		// Component clamps to 10000 client-side via saveEventAuditSampleN.
		await expect(input).toHaveValue("10000");

		await input.fill("-5");
		await input.blur();
		await expect(input).toHaveValue("1");
	});
});

/**
 * Phase 52.5.6 — server-side row insertion + client-side default
 * gating + reveal-on-toggle without a /messages re-fetch.
 *
 * Verifies the full vertical slice spec'd in the plan:
 *   1. Server inserts a `messages.role = "capability-event"` row for
 *      an installed (non-bundled) extension. We simulate this by
 *      seeding the row through the conversation-messages mock — the
 *      real `recordCapabilityCall` unit-tests already exercise the
 *      DB insert path; this spec covers the *UI consumption* end.
 *   2. With default settings (installed pills OFF), the pill is
 *      hidden in the chat stream.
 *   3. Toggling `global:showInstalledCapabilityEvents` to `true` via
 *      the settings page does NOT trigger an extra
 *      `/api/conversations/[id]/messages` fetch — the toggle drives
 *      a settings POST only. Returning to the chat page reveals the
 *      pill from the same already-rendered message row.
 */
test.describe("Capability event pills — installed-extension default-hidden + toggle reveal", () => {
	test("Phase 52.5.6: row hidden by default; toggle reveals; no /messages re-fetch on toggle", async ({
		page,
		mockApi,
	}) => {
		// An installed (non-bundled) extension — `isBundled: false`
		// puts pill visibility under `showInstalledCapabilityEvents`,
		// which defaults to OFF.
		const installedExt = {
			id: "ext-installed-1",
			name: "noisy-installed",
			version: "1.0.0",
			description: "installed pill source",
			enabled: true,
			source: "local",
			installPath: "/tmp/x",
			checksumVerified: true,
			consecutiveFailures: 0,
			isBundled: false,
			manifest: {
				author: "tester",
				entrypoint: "index.ts",
				persistent: false,
				tools: [],
				permissions: {},
			},
			grantedPermissions: { grantedAt: {} },
		};

		// Seed a synthetic capability-event message — same shape that
		// recordCapabilityCall.ts (write 3) would persist server-side.
		const capabilityEventContent = JSON.stringify({
			__ezcorp_capability_event: true,
			sdkCapabilityCallId: "sdk-call-1",
			capability: "llm",
			action: "complete",
			success: true,
			durationMs: 12,
			costUsd: 0.001,
			model: "gpt-4o-mini",
			provider: "openai",
			extensionName: installedExt.name,
		});

		await mockApi({
			projects: [{ id: "proj-1", name: "P", path: "/tmp/p" } as any],
			conversations: [
				{
					id: "conv-1",
					projectId: "proj-1",
					title: "test conv",
					createdAt: "2026-05-01T00:00:00.000Z",
					updatedAt: "2026-05-01T00:00:00.000Z",
				} as any,
			],
			messages: [
				{
					id: "m-pill-1",
					conversationId: "conv-1",
					role: "capability-event",
					content: capabilityEventContent,
					createdAt: "2026-05-01T10:00:00.000Z",
				} as any,
			],
			extensions: [installedExt as any],
		});

		// Mutable mock state for the per-key settings GETs the chat
		// page reads on mount via loadPillSettings().
		let installedToggle = false;
		await page.route("**/api/settings/global:showInstalledCapabilityEvents", async (route) => {
			if (route.request().method() === "GET") {
				await route.fulfill({ json: { value: installedToggle } });
			} else {
				await route.continue();
			}
		});
		await page.route("**/api/settings/global:showBuiltinCapabilityEvents", async (route) => {
			if (route.request().method() === "GET") {
				await route.fulfill({ json: { value: true } });
			} else {
				await route.continue();
			}
		});

		// Count /api/conversations/[id]/messages fetches across the
		// whole flow — the spec contract is: toggle reveal does NOT
		// require a re-fetch of the messages list.
		let messagesFetchCount = 0;
		page.on("request", (req) => {
			if (req.url().match(/\/api\/conversations\/conv-1\/messages(\?|$)/)) {
				messagesFetchCount++;
			}
		});

		// Capture POSTs to /api/settings so we can assert the toggle
		// fires exactly one upsertSetting + nothing else.
		const settingsPosts: Array<Record<string, unknown>> = [];
		await page.route("**/api/settings", async (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON();
				settingsPosts.push(body);
				if (body?.key === "global:showInstalledCapabilityEvents") {
					installedToggle = body.value === true;
				}
				await route.fulfill({ status: 200, json: { success: true } });
			} else {
				await route.continue();
			}
		});

		// 1. Open the chat with default settings — installed pill
		//    must be HIDDEN.
		await page.goto("/project/proj-1/chat/conv-1");
		await expect(page.getByTestId("chat-messages-container")).toBeVisible();
		// The pill row is gated client-side via shouldShowPill(); the
		// chat-capability-event marker only appears when the visibility
		// predicate returns true. With installedToggle=false, no marker.
		await expect(page.getByTestId("chat-capability-event")).toHaveCount(0);
		const messagesFetchCountAfterChat = messagesFetchCount;
		expect(messagesFetchCountAfterChat).toBeGreaterThanOrEqual(1);

		// 2. Navigate to /settings and toggle installed pills ON.
		await page.goto("/settings");
		await page
			.getByTestId("settings-audit-visibility")
			.getByRole("button", { name: /Audit & Visibility/ })
			.click();
		await page.getByTestId("toggle-installed-pills").click();

		// Spec contract: the toggle itself drives a settings POST
		// only — no /messages re-fetch is allowed during the toggle
		// click. Cross-route navigation (chat → settings) does not
		// fetch chat messages.
		await expect.poll(() => settingsPosts.length).toBeGreaterThan(0);
		const installedSet = settingsPosts.find(
			(p) => p.key === "global:showInstalledCapabilityEvents",
		);
		expect(installedSet?.value).toBe(true);
		// No additional /messages fetches happened during the toggle.
		expect(messagesFetchCount).toBe(messagesFetchCountAfterChat);

		// 3. Return to the chat — the same seeded message row now
		//    surfaces as a visible pill because the chat page's
		//    loadPillSettings() reads the updated value via the per-
		//    key GET we wired above.
		await page.goto("/project/proj-1/chat/conv-1");
		await expect(page.getByTestId("chat-capability-event")).toHaveCount(1);
		await expect(page.getByTestId("capability-pill")).toBeVisible();
	});
});
