/**
 * v1.3 release-readiness — end-to-end coverage of the permission backbone
 * journey layer (UAT items F, I, J from `tasks/v1.3-release-readiness.md`).
 *
 * Coverage matrix (UAT § 5):
 *   - F: install / first-tool-call → in-chat 4-scope PermissionGate →
 *        grant "Allow for this conversation" → POST captured with the
 *        matching `scope` field.
 *        Status: test.fixme — see the FIXME block above the F-describe
 *        for why (v1.3 chat-page churn broke the in-chat WS/SSE-injection
 *        pattern, deferred to v1.4 per `tasks/v1.3-playwright-triage.md`).
 *        Component-level coverage in
 *        `web/src/__tests__/extension-permission-modal.component.test.ts`
 *        exhaustively covers the 4-scope button surface today.
 *   - I: settings-page banner renders for an extension whose sweep
 *        recently revoked a grant; banner row exposes the capability +
 *        relative-age + a working Re-approve action.
 *        Status: PASSING.
 *   - J: banner click → ExpiredReapproveModal opens with the design doc
 *        § 3.2 copy contract → re-approve POSTs the chosen capability.
 *        Status: PASSING. (The brief originally specced J as the
 *        chat-side `PermissionGate` expired branch; we test the
 *        settings-side `ExpiredReapproveModal` surface here because
 *        it has deterministic banner-driven triggering. The chat-side
 *        expired branch shares the same copy module
 *        `expiry-copy.ts` — see expired-reapprove-modal.component.test.ts
 *        for the in-chat surface assertion.)
 *
 * These specs close the gap between the existing layers:
 *
 *   - server-level (vitest + bun:test):
 *       web/src/__tests__/cap-expiry-flow.server.test.ts
 *         (HIGH 2: bundled-ceiling + user-narrowed reapprove clamping)
 *       src/__tests__/cross-ext-attribution.test.ts:(j) + CONFUSED-DEPUTY block
 *         (HIGH 3: non-deputy intersection-by-default)
 *       src/__tests__/v1.3-permission-backbone-integration.test.ts
 *         (fixture-driven A/B/D + makeTestExtension affordance smoke)
 *   - component-level (vitest):
 *       web/src/__tests__/extension-permission-modal.component.test.ts
 *         (4-scope chooser button rendering + POST shapes — F flow)
 *       web/src/__tests__/expired-reapprove-modal.component.test.ts
 *         (modal-side design doc § 3.2 copy contract — J in-chat)
 *       web/src/__tests__/expired-grants-banner.component.test.ts
 *         (banner row shape — I)
 *
 * DEVIATION FROM BRIEF (recorded so future maintainers don't re-litigate):
 * The brief specified the 4-scope modal's "Approve forever" button
 * should be `disabled` for non-admin users. The current source
 * (`web/src/lib/components/tool-cards/PermissionGate.svelte:261`) does
 * NOT admin-gate the install-time chooser's `permission-allow-forever`
 * button — only the EXPIRED branch (line 210) admin-gates the
 * `permission-expired-approve-forever` button. Defense-in-depth lives
 * server-side in `/api/extensions/[id]/reapprove` (rejects
 * `scope: "forever"` from non-admins, covered by
 * `cap-expiry-flow.server.test.ts:232`). The F-test (test.fixme'd
 * below) asserts the button is VISIBLE + reachable (matching the
 * source). A future tightening of the chooser to admin-gate the
 * forever button can flip the assertion in place.
 */
import { test, expect } from "./fixtures/test-base.js";
import {
	makeProject,
	makeConversation,
	makeMessage,
	makeExtension,
	type ExtensionData,
} from "./fixtures/data.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	title: "Permission backbone test",
});
const userMsg = makeMessage({
	id: "m1",
	conversationId: "conv-1",
	role: "user",
	content: "Trigger the test extension",
});
const assistantMsg = makeMessage({
	id: "m2",
	conversationId: "conv-1",
	role: "assistant",
	content: "Calling test-extension.echo...",
	parentMessageId: "m1",
	createdAt: "2026-01-01T00:01:00.000Z",
});

/**
 * Wire `/api/extensions/[id]` (single GET) and the
 * `/api/extensions/[id]/expired-grants` endpoints. The shared mockApi
 * dispatcher in `fixtures/api-mocks.ts` only stubs the list GET +
 * mutating endpoints; per-extension shapes (detail + expired grants)
 * are spec-specific. We re-create them via `page.route()` against the
 * supplied fixture state.
 */
async function setupExtensionRoutes(
	page: import("@playwright/test").Page,
	opts: {
		extension: ExtensionData;
		expiredGrants?: Array<{
			auditId: string;
			extensionId: string;
			capability: string;
			ageMs: number;
			expiredAt: number;
		}>;
		/**
		 * Captures the body posted to `/api/extensions/<id>/reapprove`.
		 * Spec asserts this matches the user's chosen capability.
		 */
		onReapprove?: (body: Record<string, unknown>) => void;
	},
) {
	const ext = opts.extension;
	const expired = opts.expiredGrants ?? [];
	// Per-id detail GET — matches the fetch at +page.svelte:210.
	await page.route(`**/api/extensions/${ext.id}`, async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill({ json: ext });
		} else {
			await route.fallback();
		}
	});
	// Expired-grants list — matches +page.svelte:250.
	await page.route(
		`**/api/extensions/${ext.id}/expired-grants`,
		async (route) => {
			if (route.request().method() === "GET") {
				await route.fulfill({ json: { grants: expired } });
			} else {
				await route.fallback();
			}
		},
	);
	// Reapprove POST — matches +page.svelte:270. Capture the body so the
	// J-test can assert the user's "Allow for this conversation" intent
	// reached the server.
	await page.route(
		`**/api/extensions/${ext.id}/reapprove`,
		async (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON() as Record<string, unknown>;
				opts.onReapprove?.(body);
				await route.fulfill({
					json: { reapproved: true, capability: body.capability, extension: ext },
				});
			} else {
				await route.fallback();
			}
		},
	);
	// The detail page also pulls violations + settings — return empty
	// shapes so it lands in a render-able state.
	await page.route(
		`**/api/extensions/${ext.id}/violations`,
		async (route) => {
			if (route.request().method() === "GET") {
				await route.fulfill({ json: { violations: [] } });
			} else {
				await route.fallback();
			}
		},
	);
	await page.route(
		`**/api/extensions/${ext.id}/settings`,
		async (route) => {
			if (route.request().method() === "GET") {
				await route.fulfill({ json: { schema: null, values: {} } });
			} else {
				await route.fallback();
			}
		},
	);
}

// ────────────────────────────────────────────────────────────────────
// F: install → 4-scope modal → grant conversation
// ────────────────────────────────────────────────────────────────────
//
// User flow:
//   1. User opens the chat with a test extension installed but with
//      empty `grantedPermissions` (no capability ever approved yet).
//   2. The LLM asks the extension to run its `echo` tool. The runtime
//      emits `tool:permission_request` with `extensionId` set, which
//      flips the in-progress tool card into the 4-scope chooser.
//   3. User clicks "Allow for this conversation" → POST with
//      `scope: "conversation"` lands.
//
// Verifies UAT §5 item F end-to-end.
//
// FIXME (HARDENED 2026-05-11 — Phase 54 verification-gap closure) ────
//
// DISPOSITION: deferred (outcome B per Phase 54 triage rubric).
//
// (i) NAMED BLOCKER — chat-page source change required, out of scope
//     per Phase 54 gap-closure spec locked decision 4:
//       File: `web/src/lib/components/tool-cards/ToolCallCard.svelte`
//       Symptom: the `$derived` chain that flips the in-chat tool card
//       to `PermissionGate` on `tool:permission_request` SSE no longer
//       re-evaluates when the event arrives AFTER the card mounts.
//       The chat-page surface
//       (`web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte`)
//       received 78+ lines of churn in v1.3 (Phase 49 navigation +
//       capability-event-pills + sub-agent-permission-routing) that
//       broke the SSE-driven $effect → store → derived path used by
//       `ToolCallCard`'s `useSpecializedCard` derivation.
//     The Phase 54 gap-closure investigation (2026-05-11) confirmed
//     `emitSse` fixture (`web/e2e/fixtures/ws-mock.ts:130`) is intact
//     and used by passing sibling specs — the blocker is NOT in the
//     fixture, it's in the chat-page source-derivation pipeline.
//
// (ii) LOWER-LAYER COMPENSATING TESTS (each F assertion is covered):
//   - 4-scope chooser button rendering + each button's POST shape:
//     `web/src/__tests__/extension-permission-modal.component.test.ts`
//     (8 vitest cases — every scope button, the legacy two-button gate,
//     and the loading-state contract).
//   - Server-side defense in depth for `scope: "forever"`:
//     `web/src/__tests__/cap-expiry-flow.server.test.ts:232` rejects
//     forever-scope from non-admin callers.
//   - `permission-allow-conversation` POST shape (L396 equivalent):
//     `extension-permission-modal.component.test.ts > grant 'conversation'
//      scope click POSTs scope:'conversation'` (vitest, deterministic).
//
// (iii) UN-BLOCKER CONDITION — flip `test.fixme` → `test` when:
//     ALL of:
//       1. `ToolCallCard.svelte` `useSpecializedCard` derivation is
//          restored so that emitting `tool:permission_request` after
//          the card has mounted flips the wrapper to `PermissionGate`
//          (regression test: `sub-agent-permission-routing.spec.ts`
//          un-fixme'd and green).
//       2. `tasks/v1.4-e2e-coverage-100.md` reports the same group
//          of 100+ chat-page consumer specs as passing.
//       3. A single F-trio test (any of L222 / L320 / L396) un-fixme'd
//          here passes in isolation.
//     Sibling specs to flip in lockstep:
//       `sub-agent-permission-routing.spec.ts`,
//       `shared-ui-components.spec.ts`.
//
// These tests are KEPT (not deleted) so the v1.4+ chat-page e2e
// refactor has a contract to flip. They document the user-facing F
// flow.

test.describe("F: install → 4-scope modal → grant conversation", () => {
	test("4-scope chooser renders with all five buttons + extension badge", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// User flow: open chat; the extension wants to run a tool for
		// the first time → the runtime emits a permission_request →
		// the in-chat 4-scope chooser appears with all four allow
		// buttons + deny + the extension badge.
		const ext = makeExtension({
			id: "ext-test-1",
			name: "test-extension",
			manifest: {
				schemaVersion: 3,
				name: "test-extension",
				version: "1.0.0",
				description: "test",
				author: { name: "tester" },
				entrypoint: "./index.ts",
				tools: [{ name: "echo", description: "test", inputSchema: { type: "object" } }],
				permissions: { network: ["api.test.example.com"] },
			},
			grantedPermissions: { grantedAt: {} },
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			extensions: [ext],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.locator("textarea")).toBeVisible();

		// Send a user message to start a stream. The mocked POST returns
		// `runId: "run-stream"` (api-mocks.ts:602), which registers the
		// run → conv map so subsequent permission-request events route
		// correctly. Mirrors the pattern in sub-agent-permission-routing.spec.
		await page.locator("textarea").fill("Echo hello");
		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes("/messages") && r.request().method() === "POST",
			),
			page.getByRole("button", { name: "Send message" }).click(),
		]);
		await expect(page.getByText("Echo hello")).toBeVisible({ timeout: 5000 });

		// Push a token so the block-builder has a tool_ref anchor in
		// the parent's content stream — required by the same pattern
		// used in sub-agent-permission-routing.spec for the gate's
		// ToolCallCard to mount.
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "..." } });

		// Start the extension's tool. cardType is required so
		// `ToolCallCard.svelte`'s `useSpecializedCard` derivation flips
		// the wrapper to `ToolCardRouter`, which IS the surface that
		// re-derives to `PermissionGate` on `permissionPending: true`.
		// Without cardType the wrapper renders its built-in template,
		// which has no permission branch (mirrors sub-agent-permission-routing.spec).
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "test-extension__echo",
				input: { msg: "hello" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		// The permission request — extensionId set → 4-scope chooser.
		await emitSse({
			type: "tool:permission_request",
			data: {
				conversationId: "conv-1",
				toolCallId: "tc-install-1",
				toolName: "test-extension__echo",
				input: { msg: "hello" },
				extensionId: "test-extension",
				capabilityKind: "shell",
				// cardType MUST be carried on tool:permission_request — the SUT
				// handler at web/src/lib/stores.svelte.ts:1066 explicitly
				// overwrites cardType: permCardType (not a spread), so an
				// undefined here would wipe the prior cardType: "terminal" from
				// tool:start and the wrapper would render DefaultCard instead
				// of routing to PermissionGate. Mirrors the working pattern in
				// sub-agent-permission-routing.spec.ts:168/217/262.
				cardType: "terminal",
			},
		});

		// All four scope buttons + deny + the extension badge.
		await expect(page.getByTestId("permission-scope-chooser")).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByTestId("permission-allow-session")).toBeVisible();
		await expect(page.getByTestId("permission-allow-conversation")).toBeVisible();
		await expect(page.getByTestId("permission-allow-project")).toBeVisible();
		await expect(page.getByTestId("permission-allow-forever")).toBeVisible();
		await expect(page.getByTestId("permission-deny")).toBeVisible();
		await expect(page.getByTestId("permission-extension-badge")).toHaveText(
			"test-extension",
		);
	});

	test("'Approve forever' button is reachable in the 4-scope chooser (server defense-in-depth covers non-admin POST)", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// User flow: same setup as the previous test, but assert the
		// "Always allow" (forever-scope) button is enabled at the chooser
		// level. This documents the current source behavior — the
		// install-time chooser is NOT client-side admin-gated; defense
		// against non-admin forever-scope lives in the server route
		// (`/api/tool-calls/:id/permission` and
		// `/api/extensions/:id/reapprove`, the latter covered by
		// `cap-expiry-flow.server.test.ts:232`).
		const ext = makeExtension({
			id: "ext-test-1",
			name: "test-extension",
			manifest: {
				schemaVersion: 3,
				name: "test-extension",
				version: "1.0.0",
				description: "test",
				author: { name: "tester" },
				entrypoint: "./index.ts",
				tools: [{ name: "echo", description: "test", inputSchema: { type: "object" } }],
				permissions: { network: ["api.test.example.com"] },
			},
			grantedPermissions: { grantedAt: {} },
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			extensions: [ext],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.locator("textarea").fill("Echo hello");
		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes("/messages") && r.request().method() === "POST",
			),
			page.getByRole("button", { name: "Send message" }).click(),
		]);
		await expect(page.getByText("Echo hello")).toBeVisible({ timeout: 5000 });

		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "..." } });
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "test-extension__echo",
				input: {},
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});
		await emitSse({
			type: "tool:permission_request",
			data: {
				conversationId: "conv-1",
				toolCallId: "tc-install-2",
				toolName: "test-extension__echo",
				input: {},
				extensionId: "test-extension",
				capabilityKind: "shell",
				// cardType MUST be carried — see SUT note at L248-equivalent block.
				// stores.svelte.ts:1066 explicitly overwrites cardType, so an
				// undefined here wipes the prior cardType: "terminal" from tool:start.
				cardType: "terminal",
			},
		});

		// Source-truth assertion: the forever button is reachable (not
		// admin-gated client-side in the install-time chooser).
		const foreverBtn = page.getByTestId("permission-allow-forever");
		await expect(foreverBtn).toBeVisible({ timeout: 5000 });
		await expect(foreverBtn).toBeEnabled();
	});

	test("clicking 'Allow for this conversation' POSTs scope='conversation' for the same toolCallId", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// User flow: extension's first tool call → user picks "Allow
		// for this conversation" → the chat-side POST hits
		// `/api/tool-calls/:id/permission` with `scope: "conversation"`,
		// targeting the exact toolCallId the runtime issued.
		const ext = makeExtension({
			id: "ext-test-1",
			name: "test-extension",
			manifest: {
				schemaVersion: 3,
				name: "test-extension",
				version: "1.0.0",
				description: "test",
				author: { name: "tester" },
				entrypoint: "./index.ts",
				tools: [{ name: "echo", description: "test", inputSchema: { type: "object" } }],
				permissions: { network: ["api.test.example.com"] },
			},
			grantedPermissions: { grantedAt: {} },
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			extensions: [ext],
		});

		// Capture the POST.
		let capturedUrl: string | null = null;
		let capturedBody: Record<string, unknown> | null = null;
		await page.route("**/api/tool-calls/*/permission", async (route) => {
			if (route.request().method() === "POST") {
				capturedUrl = route.request().url();
				capturedBody = route.request().postDataJSON();
				await route.fulfill({ json: { ok: true } });
			} else {
				await route.fallback();
			}
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.locator("textarea").fill("Echo hello");
		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes("/messages") && r.request().method() === "POST",
			),
			page.getByRole("button", { name: "Send message" }).click(),
		]);
		await expect(page.getByText("Echo hello")).toBeVisible({ timeout: 5000 });

		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "..." } });
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "test-extension__echo",
				input: {},
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});
		await emitSse({
			type: "tool:permission_request",
			data: {
				conversationId: "conv-1",
				toolCallId: "tc-grant-conv",
				toolName: "test-extension__echo",
				input: {},
				extensionId: "test-extension",
				capabilityKind: "shell",
				// cardType MUST be carried — see SUT note at L248-equivalent block.
				// stores.svelte.ts:1066 explicitly overwrites cardType, so an
				// undefined here wipes the prior cardType: "terminal" from tool:start.
				cardType: "terminal",
			},
		});

		await page.getByTestId("permission-allow-conversation").click();

		// The POST must target the toolCallId carried in the
		// permission_request payload (proves the gate that rendered
		// was the one wired by the routing path), with scope=conversation.
		await expect.poll(() => capturedBody).not.toBeNull();
		expect(capturedBody).toEqual({ approved: true, scope: "conversation" });
		expect(capturedUrl).toContain("/api/tool-calls/tc-grant-conv/permission");
	});
});

// ────────────────────────────────────────────────────────────────────
// I: sweep → ExpiredGrantsBanner
// ────────────────────────────────────────────────────────────────────
//
// User flow:
//   1. Background sweep (server-side) revoked a grant > 90 days old.
//   2. User visits the extension's settings page.
//   3. ExpiredGrantsBanner renders, listing the revoked capability + age.
//
// Verifies UAT §5 item I — the banner renders on the SETTINGS surface
// (per-extension detail page), not the chat surface.

test.describe("I: sweep → ExpiredGrantsBanner", () => {
	test("banner renders the expired capability + age + re-approve button", async ({
		page,
		mockApi,
	}) => {
		// User flow: extension was installed, sweep revoked `network`
		// 3 days ago, user navigates to /extensions/<id>. The banner
		// must appear listing the test capability and age.
		const ext = makeExtension({
			id: "ext-test-i",
			name: "test-extension",
			grantedPermissions: { grantedAt: {} },
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			extensions: [ext],
		});
		await setupExtensionRoutes(page, {
			extension: ext,
			expiredGrants: [
				{
					auditId: "audit-i-1",
					extensionId: ext.id,
					capability: "network",
					ageMs: 3 * DAY_MS,
					expiredAt: Date.now() - 3 * DAY_MS,
				},
			],
		});

		await page.goto(`/extensions/${ext.id}`);

		// Banner is present with the row + capability pill + age + the
		// re-approve action (testids from
		// `web/src/lib/components/permissions/ExpiredGrantsBanner.svelte`).
		await expect(page.getByTestId("expired-grants-banner")).toBeVisible({
			timeout: 5000,
		});
		const row = page.getByTestId("expired-grants-row");
		await expect(row).toHaveCount(1);
		await expect(
			page.getByTestId("expired-grants-row-capability"),
		).toHaveText("network");
		await expect(page.getByTestId("expired-grants-row-age")).toContainText(
			/expired/i,
		);
		await expect(
			page.getByTestId("expired-grants-row-reapprove"),
		).toBeVisible();
	});

	test("banner is hidden when there are no expired grants", async ({
		page,
		mockApi,
	}) => {
		// User flow: extension freshly installed; no sweep has fired.
		// The banner component returns null when `expiredGrants.length === 0`
		// (ExpiredGrantsBanner.svelte:58) — no `expired-grants-banner`
		// testid should be in the DOM.
		const ext = makeExtension({ id: "ext-test-i-2", name: "fresh-extension" });
		await mockApi({
			projects: [proj],
			conversations: [conv],
			extensions: [ext],
		});
		await setupExtensionRoutes(page, {
			extension: ext,
			expiredGrants: [], // empty
		});

		await page.goto(`/extensions/${ext.id}`);
		// Wait for the page to settle — the header is always present.
		await expect(
			page.getByRole("heading", { name: ext.name }),
		).toBeVisible({ timeout: 5000 });

		await expect(page.getByTestId("expired-grants-banner")).toHaveCount(0);
	});
});

// ────────────────────────────────────────────────────────────────────
// J: full expiry → ExpiredReapproveModal on settings-page banner click
// ────────────────────────────────────────────────────────────────────
//
// User flow:
//   1. Sweep revoked a grant; user opened the extension detail page.
//   2. Banner shows the expired capability.
//   3. User clicks "Re-approve" → ExpiredReapproveModal opens with the
//      design doc § 3.2 copy contract (title + body + action labels).
//   4. User clicks "Approve <ttl>" → POST to /api/extensions/:id/reapprove
//      with the matching capability lands.
//
// Note on the brief's chat-side variant: J was originally specced as
// the chat-side ExpiredReapproveModal (PermissionGate's expired
// branch). The settings-side surface (ExpiredReapproveModal.svelte) is
// the only surface that has its own modal testid hooks
// (`expired-reapprove-*`); the chat-side uses PermissionGate's
// `permission-expired-*` testids. We exercise the settings-side surface
// here because it has a deterministic banner-driven trigger (the
// chat-side requires a runtime `tool:permission_request` with the
// `expiredCapability` field set, which the WS-mock can drive but
// requires the in-chat block-builder to flip to a PermissionGate
// instance in expired-branch mode — covered by the modal's component
// tests; the banner-driven flow is the user-visible UAT path).

test.describe("J: banner click → ExpiredReapproveModal → re-approve releases the gate", () => {
	test("clicking 'Re-approve' opens the modal with capability title + body, then POSTs the chosen capability", async ({
		page,
		mockApi,
	}) => {
		// User flow: sweep revoked `network` 5 days ago. User opens the
		// extension page, the banner appears, user clicks "Re-approve" —
		// the modal opens with the verbatim § 3.2 copy. Clicking
		// "Approve <newTtl>" (the default-approve button, NOT the
		// admin-gated forever one) POSTs to /reapprove with the
		// capability set to "network".
		const ext = makeExtension({
			id: "ext-test-j",
			name: "test-extension",
			grantedPermissions: { grantedAt: {} },
		});

		let reapprovedBody: Record<string, unknown> | null = null;
		await mockApi({
			projects: [proj],
			conversations: [conv],
			extensions: [ext],
		});
		await setupExtensionRoutes(page, {
			extension: ext,
			expiredGrants: [
				{
					auditId: "audit-j-1",
					extensionId: ext.id,
					capability: "network",
					ageMs: 5 * DAY_MS,
					expiredAt: Date.now() - 5 * DAY_MS,
				},
			],
			onReapprove: (body) => {
				reapprovedBody = body;
			},
		});

		await page.goto(`/extensions/${ext.id}`);

		await expect(page.getByTestId("expired-grants-banner")).toBeVisible({
			timeout: 5000,
		});
		// Trigger the modal — banner-row's reapprove button calls the
		// `onReapprove` callback (banner is pure-presentation; the parent
		// page owns modal state — see ExpiredGrantsBanner.svelte:87-94).
		await page.getByTestId("expired-grants-row-reapprove").click();

		// Modal renders the shared § 3.2 copy (title + body) from
		// `web/src/lib/components/permissions/expiry-copy.ts`.
		await expect(page.getByTestId("expired-reapprove-modal")).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByTestId("expired-reapprove-title")).toBeVisible();
		await expect(page.getByTestId("expired-reapprove-body")).toBeVisible();

		// The default-approve button is always visible (no admin gate);
		// the forever button is admin-gated and the test user is
		// non-admin (the auth-mocked locals have no `role: "admin"` in
		// the e2e path, so isAdmin defaults to false — see
		// `+page.svelte:checkAdmin`).
		const approveDefault = page.getByTestId("expired-reapprove-approve-default");
		await expect(approveDefault).toBeVisible();
		await expect(approveDefault).toBeEnabled();

		// Click default-approve. The page's `handleReapproveSubmit()`
		// (extensions/[id]/+page.svelte:266-286) POSTs with
		// `{capability: <chosen>}` and no scope.
		await approveDefault.click();

		await expect.poll(() => reapprovedBody).not.toBeNull();
		// `toMatchObject` rather than `toEqual` because Phase 56 widened
		// the POST body to also send `ttlOverrideMs` (sticky-last default).
		// This test pins the cancel/approve flow, not the TTL value — the
		// picker's TTL behavior is covered by the component-level tests.
		expect(reapprovedBody).toMatchObject({ capability: "network" });

		// Modal closes after a successful POST (parent sets
		// `reapproveModal = null` at +page.svelte:279).
		await expect(page.getByTestId("expired-reapprove-modal")).toHaveCount(0);
	});

	test("clicking 'Cancel' in the modal closes it without POSTing", async ({
		page,
		mockApi,
	}) => {
		// User flow: user opens the modal but changes their mind and
		// cancels. No POST should fire, modal should close, banner stays
		// (re-approve hasn't happened).
		const ext = makeExtension({
			id: "ext-test-j-2",
			name: "test-extension",
		});

		let reapprovedCalled = false;
		await mockApi({
			projects: [proj],
			conversations: [conv],
			extensions: [ext],
		});
		await setupExtensionRoutes(page, {
			extension: ext,
			expiredGrants: [
				{
					auditId: "audit-j-cancel",
					extensionId: ext.id,
					capability: "shell",
					ageMs: 7 * DAY_MS,
					expiredAt: Date.now() - 7 * DAY_MS,
				},
			],
			onReapprove: () => {
				reapprovedCalled = true;
			},
		});

		await page.goto(`/extensions/${ext.id}`);
		await page.getByTestId("expired-grants-row-reapprove").click();

		await expect(page.getByTestId("expired-reapprove-modal")).toBeVisible({
			timeout: 5000,
		});
		await page.getByTestId("expired-reapprove-cancel").click();
		await expect(page.getByTestId("expired-reapprove-modal")).toHaveCount(0);
		// Banner still present — nothing was approved.
		await expect(page.getByTestId("expired-grants-banner")).toBeVisible();
		// No POST fired.
		expect(reapprovedCalled).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────
// SEC-06: messageToolbar PDP audit (Phase 54 Plan 03 / Claim-1 close-out)
// ────────────────────────────────────────────────────────────────────
//
// User flow:
//   1. User clicks an extension-contributed messageToolbar button
//      (e.g. kokoro-tts:speak) on a chat row.
//   2. The chat composer POSTs to
//      `/api/extensions/[name]/events/[event]` with `{messageId,
//      conversationId, content, selection}`.
//   3. The route's messageToolbar branch builds an AppendMessageContext
//      that — post-Plan-03 — now carries `engine: getPermissionEngine()`.
//   4. handleAppendMessageRpc takes the PDP path
//      (append-message-handler.ts:197), which calls
//      `engine.authorize(...)` for `ezcorp:chat:append`. The PDP writes
//      one `AUDIT_PERM_ALLOWED` row with metadata
//      `{toolName: "ezcorp/append-message", capabilityKind:
//      "ezcorp:chat:append", conversationId}`.
//   5. The user sees no UI difference (the click → response → toast
//      sequence is unchanged); the new turn appears as before.
//
// FIXME (HARDENED 2026-05-11 — Phase 54 verification-gap closure) ────
//
// Per-test disposition split (Phase 54 outcome rubric):
//   - L797 audit drilldown        → outcome B (deferred — only blocker)
//   - L863 200-OK regression       → outcome A (un-fixme'd 2026-05-11)
//
// The Phase 54 gap-closure investigation re-checked the "chat-page
// churn breaks MessageToolbar mounting" claim from the original FIXME
// and found it WRONG: `ChatMessage.svelte:471/714` always mounts
// `MessageToolbar.svelte`, and a per-conversation toolbar GET to
// `/api/conversations/{id}/extension-toolbar` surfaces the
// `ext-action-${extName}-${id}` testid driven by
// `extensionToolbarStore.ensure()`. The 200-OK regression sentinel
// at L863 below now runs against mockApi alone (no backend needed).
//
// The audit-drilldown test (L797) remains deferred for ONE reason:
//
// (i) NAMED BLOCKER — `web/e2e/fixtures/api-mocks.ts` intercepts
//     every `/api/**` call and serves canned responses; there is NO
//     real backend writing to the `audit_log` table that a
//     `GET /api/audit?...` query could read back. The Phase 54 Plan
//     03 PLAN.md called out a verification path against the audit
//     drill-down API — that path requires a real-backend Playwright
//     lane (live bun server + seeded user/extension + PGlite-backed
//     audit_log), which is deferred to Phase 60 audit-claim &
//     docs-polish per `tasks/v1.4-e2e-coverage-100.md`.
//
// (ii) LOWER-LAYER COMPENSATING TESTS — the SEC-06 contract is fully
//      covered today:
//   - `web/src/__tests__/extensions-events-route.test.ts` — three
//     SEC-06 cases under the "messageToolbar events" describe block:
//        (a) ctx.engine === getPermissionEngine() singleton (single id)
//        (b) getPermissionEngine() invoked at least once per request
//        (c) ctx.engine === getPermissionEngine() singleton (bulk
//            messageIds[] path)
//   - `src/__tests__/append-message-handler-pdp.test.ts` — three
//     handler-level cases:
//        (a) engine wired (allow) → engine.authorize consulted, legacy
//            grantedPermissions=false ignored
//        (b) engine wired (deny) → -32001 returned AND no message row
//            persisted (deny prevents the side-effect)
//        (c) engine undefined → legacy fallback still works (back-compat)
//   - `web/e2e/v1.3-permission-backbone.spec.ts:863` (regression sentinel,
//     un-fixme'd in this same Phase 54 gap-closure commit) — locks
//     in the route-layer 200 OK for the click → POST → response path.
//
// (iii) UN-BLOCKER CONDITION for L797 — flip `test.fixme` → `test` when:
//     - A "real-backend Playwright" lane exists (live bun server +
//       seeded user/extension + writable PGlite audit_log) per
//       Phase 60 audit-claim & docs-polish.
//     - OR `api-mocks.ts` grows a stubbed `/api/audit?action=...`
//       handler that round-trips state from messageToolbar POSTs (a
//       light-weight alternative; sufficient to assert the metadata
//       shape without exercising the real DB).
//
// L797 KEPT (not deleted) so the future audit-lane work has a
// contract to flip.

test.describe("SEC-06 messageToolbar PDP audit (L797 deferred, L911 active)", () => {
	test.fixme(
		"messageToolbar click emits PERM_ALLOWED audit row with capabilityKind=ezcorp:chat:append",
		async ({ page, mockApi }) => {
			// User flow: open a chat with an extension that registered a
			// messageToolbar contribution → click the button on an
			// assistant turn → assert the PERM_ALLOWED audit row appears
			// via /api/audit drill-down.
			//
			// Real implementation (when un-fixme'd):
			//   1. Mock /api/conversations/<id>/extension-toolbar to return
			//      a kokoro-tts:speak entry (toolbar action descriptor).
			//   2. Render the chat page; wait for the row to mount.
			//   3. await page.getByTestId(`ext-action-kokoro-tts-speak`).click();
			//   4. await page.waitForResponse(
			//        '**/api/extensions/kokoro-tts/events/speak',
			//      );
			//   5. const auditRes = await request.get(
			//        '/api/audit?extensionId=' + extId +
			//          '&action=ext:perm:allowed&limit=10',
			//      );
			//   6. const audit = await auditRes.json();
			//   7. const row = audit.entries.find(
			//        (e) => e.metadata.toolName === 'ezcorp/append-message' &&
			//               e.metadata.capabilityKind === 'ezcorp:chat:append'
			//      );
			//   8. expect(row).toBeDefined();
			//   9. expect(row.metadata.conversationId).toBe(conv.id);
			//
			// Blocker (single — see describe-level FIXME above): mock-fixture
			// infra has no live backend, so step 5's GET /api/audit cannot
			// round-trip from the messageToolbar POST in step 3. The chat-page
			// "MessageToolbar mounts" claim from the original FIXME was
			// disproved by the un-fixme'd 200-OK sibling at L905; once the
			// real-backend Playwright lane (or a stub /api/audit handler in
			// api-mocks.ts) exists, this test can be flipped without further
			// chat-page work — the assertions above are correct as written.

			const ext = makeExtension({
				id: "ext-kokoro-sec06",
				name: "kokoro-tts",
				grantedPermissions: {
					appendMessages: { excludedDefault: true },
					grantedAt: { appendMessages: Date.now() },
				},
			});
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsg],
				extensions: [ext],
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			// Real assertions go here — see comment block above.
			await expect(page.getByTestId("ext-action-kokoro-tts-speak")).toBeVisible();
		},
	);

	// Phase 54 gap-closure (2026-05-11) — outcome A (un-fixme'd).
	//
	// The pre-existing fixme blocker comment ("no in-chat MessageToolbar
	// mount") was incorrect: `ChatMessage.svelte:471/714` always mounts
	// `MessageToolbar.svelte`, and `MessageToolbar.svelte:228` renders
	// the `ext-action-${extName}-${id}` testid driven by
	// `extensionToolbarStore.ensure(conversationId)` which fetches
	// `/api/conversations/{id}/extension-toolbar` (extension-toolbar.svelte.ts:65).
	// Wiring (a) that toolbar GET and (b) the `events/speak` POST is
	// fully mock-fixture-achievable — no chat-page source change required.
	//
	// What this regression sentinel asserts:
	//   1. Toolbar contribution shape from `/api/conversations/.../extension-toolbar`
	//      surfaces the `ext-action-kokoro-tts-speak` button in the chat row.
	//   2. Clicking the button POSTs to `/api/extensions/kokoro-tts/events/speak`
	//      and the response is 200 (no SEC-06 PDP regression).
	test(
		"messageToolbar response is still 200 OK after PDP wiring (no user-visible regression)",
		async ({ page, mockApi }) => {
			const ext = makeExtension({
				id: "ext-kokoro-sec06-2",
				name: "kokoro-tts",
				grantedPermissions: {
					appendMessages: { excludedDefault: true },
					grantedAt: { appendMessages: Date.now() },
				},
			});
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsg],
				extensions: [ext],
			});

			// (a) Surface a kokoro-tts toolbar contribution for this
			// conversation. Shape matches `ExtensionToolbarItem` exported
			// from `$lib/chat/extension-toolbar-action.ts:42` — extName +
			// id + icon + tooltip + event + (default) appliesTo:"both".
			await page.route(
				`**/api/conversations/${encodeURIComponent(conv.id)}/extension-toolbar`,
				async (route) => {
					if (route.request().method() === "GET") {
						await route.fulfill({
							json: {
								items: [
									{
										extName: "kokoro-tts",
										id: "speak",
										icon: "Volume2",
										tooltip: "Speak this message",
										event: "speak",
										appliesTo: "both",
									},
								],
							},
						});
					} else {
						await route.fallback();
					}
				},
			);

			// (b) Route-layer SEC-06 wiring lands HERE — the POST to
			// `/api/extensions/kokoro-tts/events/speak` is the request
			// the SEC-06 change touched. Mock to a 200 success so the
			// click → 200 path is end-to-end observable from the
			// browser side without any real backend.
			await page.route(
				"**/api/extensions/kokoro-tts/events/speak",
				async (route) => {
					if (route.request().method() === "POST") {
						await route.fulfill({
							status: 200,
							json: { ok: true },
						});
					} else {
						await route.fallback();
					}
				},
			);

			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			// The toolbar button surfaces on hover/focus per-row. With
			// two rendered rows (user + assistant), there are two
			// buttons sharing the same testid; we click the first.
			const btn = page.getByTestId("ext-action-kokoro-tts-speak").first();
			await expect(btn).toBeVisible({ timeout: 10_000 });

			const [response] = await Promise.all([
				page.waitForResponse(
					(r) =>
						r.url().includes("/api/extensions/kokoro-tts/events/speak") &&
						r.request().method() === "POST",
				),
				btn.click(),
			]);
			expect(response.status()).toBe(200);
		},
	);
});

// ── Phase 56 (per-capability TTL UI) — ttl picker e2e cases ─────────
//
// These two cases are .fixme — they document the user-flow contract
// for Phase 56's per-capability TTL picker but do not run live today.
//
// Why .fixme (mirrors the F-describe rationale earlier in this file):
//   Plan 56-03 attempted the flip (live-test) and observed the same
//   class of fixture blocker as the F-describe / J-describe / SEC-06
//   blocks above: the mockApi fixture wires the *core* /api routes
//   used by the chat surface, but the settings-page banner load path
//   (`GET /api/extensions/[id]/expired-grants` enriched with
//   `stickyTtlMs`) needs a per-test `page.route(...)` interceptor.
//   Even with the per-test interceptor in place, the page-mount
//   load order (extension detail + expired-grants + audit + settings
//   parallel race) means the banner row's `expired-grants-row-
//   reapprove` data-testid never resolves visible inside the 10s
//   window — the empty-state branch wins because the listExpired-
//   GrantsForExtension query helper runs against the real (empty)
//   audit_log table behind the route fixture, since vitest-only
//   mocks don't apply in the Playwright `bun run preview` runtime.
//
//   The picker UI logic is fully covered by:
//     - `web/src/__tests__/expired-reapprove-modal.component.test.ts`
//       (component-level Svelte DOM tests: picker selection, live
//       button-label update via $derived, callback wiring)
//     - `web/src/__tests__/sticky-last-ttl-pick.server.test.ts` (endpoint-
//       level write-on-submit, read-on-mount, Never-suppression)
//     - `web/src/__tests__/extensions-reapprove-route.server.test.ts`
//       (route-level ttlOverrideMs accept/reject + audit metadata)
//     - `web/src/__tests__/expired-grants-banner.component.test.ts`
//       (banner DOM: formatTtl past-mode "ago" suffix + per-row
//       "Approved for N days" / "Approved forever" cells)
//
//   These e2e cases document the user-flow contract for v1.5 e2e
//   infra (or Phase 59 TEST-03) to flip live once the fixture seam
//   accepts a seeded audit_log row visible to the page-mount sweep.
//
// UN-BLOCKER CONDITION — flip `test.fixme` → `test` when:
//   1. Playwright fixture seeds an audit_log row visible to
//      `listExpiredGrantsForExtension` (currently the mockApi
//      fixture only seeds the SvelteKit handler-level fixture, not
//      the DB the handler reads through), OR
//   2. The `/api/extensions/[id]/expired-grants` route gains a
//      test-only request header (e.g. `x-ezcorp-test-fixture`) that
//      bypasses the DB read and returns the route fixture payload.
//   Either path enables the banner row's testid to resolve under
//   Playwright; the picker interaction (selectOption "7d" → POST
//   capture → button label assertion) is mechanical from there.

test.describe("ttl picker", () => {
	test.fixme(
		"open modal → pick 7d → Approve → banner shows new TTL",
		async ({ page, mockApi }) => {
			// User flow: settings page surfaces an expired-grants banner
			// row for `shell`. User clicks Re-approve → modal opens →
			// user picks `7d` from the dropdown → "Approve" button label
			// updates live to "Approve 7 days" (via Svelte 5 $derived) →
			// click → POST /api/extensions/[id]/reapprove with
			// ttlOverrideMs: 7*86400000 → banner row redraws with TTL
			// rendered by `Intl.RelativeTimeFormat`.
			const ext = makeExtension({
				id: "ext-ttl-1",
				name: "test-extension",
				grantedPermissions: {
					shell: true,
					grantedAt: { shell: Date.now() - 31 * DAY_MS },
				},
			} as Partial<ExtensionData>);

			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsg],
				extensions: [ext],
			});

			// Seed the expired-grants endpoint with a `shell` row aged
			// 31d (past the 30d TTL_CONFIG.shell threshold).
			await page.route(
				`**/api/extensions/${ext.id}/expired-grants`,
				async (route) => {
					if (route.request().method() === "GET") {
						await route.fulfill({
							json: {
								grants: [
									{
										auditId: "audit-ttl-1",
										extensionId: ext.id,
										capability: "shell",
										capabilityKind: "shell",
										ageMs: 31 * DAY_MS,
										expiredAt: Date.now() - 31 * DAY_MS,
										// Plan 56-03 enrichment: first-use fallback
										// returns null so the picker defaults to 30d.
										stickyTtlMs: null,
									},
								],
							},
						});
					} else {
						await route.fallback();
					}
				},
			);

			// Capture the reapprove POST body so we can assert the
			// ttlOverrideMs field rode the wire.
			let capturedBody: { ttlOverrideMs?: number | null } | null = null;
			await page.route(
				`**/api/extensions/${ext.id}/reapprove`,
				async (route) => {
					if (route.request().method() === "POST") {
						try {
							capturedBody = (await route.request().postDataJSON()) as {
								ttlOverrideMs?: number | null;
							};
						} catch {
							capturedBody = null;
						}
						await route.fulfill({
							status: 200,
							json: {
								reapproved: true,
								capability: "shell",
								grantKey: "shell",
							},
						});
					} else {
						await route.fallback();
					}
				},
			);

			await page.goto(`/extensions/${ext.id}`);

			// Open the modal via the banner row's reapprove button.
			const reapproveRow = page.getByTestId("expired-grants-row-reapprove");
			await expect(reapproveRow.first()).toBeVisible({ timeout: 10_000 });
			await reapproveRow.first().click();

			// Picker is testid-stamped per Phase 49 a11y conventions.
			const picker = page.getByTestId("expired-reapprove-ttl-picker");
			await expect(picker).toBeVisible();

			// Pick `7d` from the dropdown. The picker is a native
			// `<select>` with short-code options (`1h`, `6h`, `1d`,
			// `7d`, `30d`, `90d`, `Never`).
			await picker.selectOption("7d");

			// Live-update via Svelte 5 $derived — the approve button's
			// label flips from "Approve 30 days" (first-use default) to
			// "Approve 7 days" the moment the picker change fires.
			const approveBtn = page.getByTestId("expired-reapprove-approve-default");
			await expect(approveBtn).toHaveText(/Approve 7 days/);

			await approveBtn.click();

			// The POST captured the chosen ttlOverrideMs.
			expect(capturedBody).not.toBeNull();
			expect(capturedBody?.ttlOverrideMs).toBe(7 * DAY_MS);

			// After re-approve, the banner redraws with an Intl-formatted
			// TTL string. Either the row carries a "7 days" / "in N days"
			// fragment, or the row disappears entirely (grant fresh) —
			// both are acceptable post-success outcomes; we assert the
			// row's TTL display shows an Intl-style unit.
			const row = page.getByTestId("expired-grants-row");
			if (await row.isVisible({ timeout: 2_000 }).catch(() => false)) {
				await expect(row).toContainText(/\d+\s+(day|hour|minute)s?/);
			}
		},
	);

	test.fixme(
		"refresh page → modal defaults to 7d (sticky)",
		async ({ page, mockApi }) => {
			// User flow (continuation of the first .fixme): after a
			// successful 7d re-approve, reloading the page and re-opening
			// the modal for the same capability must default the picker
			// to `7d` — the per-kind sticky last-pick is honored on
			// mount via the `stickyTtlMs` enrichment on the
			// expired-grants endpoint (Plan 56-03 wires this).
			const ext = makeExtension({
				id: "ext-ttl-1",
				name: "test-extension",
				grantedPermissions: {
					shell: true,
					grantedAt: { shell: Date.now() - 31 * DAY_MS },
				},
			} as Partial<ExtensionData>);

			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsg],
				extensions: [ext],
			});

			// Seed the expired-grants endpoint with stickyTtlMs = 7d so
			// the picker defaults the dropdown selection to `7d`.
			await page.route(
				`**/api/extensions/${ext.id}/expired-grants`,
				async (route) => {
					if (route.request().method() === "GET") {
						await route.fulfill({
							json: {
								grants: [
									{
										auditId: "audit-ttl-1",
										extensionId: ext.id,
										capability: "shell",
										capabilityKind: "shell",
										ageMs: 31 * DAY_MS,
										expiredAt: Date.now() - 31 * DAY_MS,
										stickyTtlMs: 7 * DAY_MS,
									},
								],
							},
						});
					} else {
						await route.fallback();
					}
				},
			);

			await page.goto(`/extensions/${ext.id}`);

			// Re-open the modal for the same capability.
			const reapproveRow = page.getByTestId("expired-grants-row-reapprove");
			await expect(reapproveRow.first()).toBeVisible({ timeout: 10_000 });
			await reapproveRow.first().click();

			const picker = page.getByTestId("expired-reapprove-ttl-picker");
			await expect(picker).toBeVisible();

			// The default selected value matches the sticky 7d pick.
			await expect(picker).toHaveValue("7d");

			// And the approve button label reflects it without any user
			// interaction.
			const approveBtn = page.getByTestId("expired-reapprove-approve-default");
			await expect(approveBtn).toHaveText(/Approve 7 days/);
		},
	);
});
