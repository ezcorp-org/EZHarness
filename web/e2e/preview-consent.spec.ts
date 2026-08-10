/**
 * Playwright e2e — requester-scoped expose-consent card, viewed from the
 * chat UI (Secure User-Site Preview / Port Exposure, Phase 2 — §3.3).
 *
 * What this proves end-to-end through the user-facing surface:
 *   1. The port watcher's `preview:detected` event is surfaced into the
 *      ORIGINATING conversation as a tool-result card with
 *      `cardType: "ez-preview-consent"`. `getCardComponentName` routes it
 *      to PreviewConsentCard.svelte, which renders the three affordances
 *      ([Expose] [Ignore] [Always expose in this conversation]) exactly
 *      once (no double-render).
 *   2. [Expose] POSTs {action:"expose"} to /api/preview/consent (mocked)
 *      and surfaces the Open-preview handoff link — auto-detect ≠
 *      auto-serve: nothing serves until this click.
 *   3. [Always expose] POSTs {action:"always-expose"} (D3 preference +
 *      immediate expose).
 *   4. [Ignore] is a non-action: shows "Ignored", no preview link.
 *
 * Transport note (project gotcha): runtime events flow over SSE on
 * `/api/runtime-events`; we drive the tool card via `emitSse`, NOT
 * `emitWs` (mirrors substack-review-card.spec.ts). The real watcher
 * daemon + the seeded DB roundtrip (a live preview_sessions row +
 * one-time-code handoff) require the Docker harness and are gated below,
 * mirroring preview-static.spec.ts's plain/Docker split. The consent
 * endpoint is mocked at the browser fetch boundary — exactly the surface
 * the card calls; its server logic is covered by the vitest handler suite
 * (api-preview-consent.server.test.ts) + the consent-service PGlite suite.
 */

import { test, expect } from "./fixtures/test-base.js";
import { sendComposerMessage } from "./fixtures/composer.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-prev", name: "Preview Project" });
const conv = makeConversation({
	id: "conv-prev",
	projectId: "proj-prev",
	model: "claude-sonnet-4-6",
	provider: "anthropic",
});

const userMsg = makeMessage({
	id: "m1",
	conversationId: conv.id,
	role: "user",
	content: "start the dev server",
});
const assistantMsg = makeMessage({
	id: "m2",
	conversationId: conv.id,
	role: "assistant",
	content: "Starting it now.",
	parentMessageId: "m1",
	createdAt: "2026-01-01T00:01:00.000Z",
});

function consentPayload(port: number) {
	return JSON.stringify({
		conversationId: conv.id,
		port,
		title: `A site started on port ${port}`,
		summary: "Expose it to your browser? Nothing is served until you choose.",
	});
}

interface ConsentMockOpts {
	fail?: boolean;
}

// Register the /api/preview/consent mock + recorder. MUST run AFTER
// `mockApi` so it wins Playwright's last-registered-first route resolution
// against the broad `**/api/**` catch-all (mirrors substack-review-card).
async function installConsentMock(
	page: import("@playwright/test").Page,
	opts: ConsentMockOpts = {},
) {
	const calls: Array<{ action: string; conversationId: string; port?: number }> = [];
	await page.route("**/api/preview/consent", async (route) => {
		const body = route.request().postDataJSON() as {
			action: string;
			conversationId: string;
			port?: number;
		};
		calls.push(body);
		if (opts.fail) {
			return route.fulfill({ status: 500, json: { error: "expose failed" } });
		}
		if (body.action === "ignore") {
			return route.fulfill({ status: 200, json: { ok: true, action: "ignore" } });
		}
		return route.fulfill({
			status: 200,
			json: { ok: true, action: body.action, previewId: "pid26label", code: "code123", subdomainLabel: "pid26label" },
		});
	});
	return { calls };
}

async function navigateAndSurfaceCard(
	page: import("@playwright/test").Page,
	mockApi: (overrides?: MockOverrides) => Promise<void>,
	emitSse: (e: { type: string; data: unknown }) => Promise<void>,
	port: number,
	opts: ConsentMockOpts = {},
) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [userMsg, assistantMsg],
	});
	const { calls } = await installConsentMock(page, opts);

	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	await Promise.all([
		page.waitForResponse(
			(r) => r.url().includes("/messages") && r.request().method() === "POST",
		),
		sendComposerMessage(page, "start the dev server"),
	]);

	const invocationId = "inv-preview-detected";
	await emitSse({
		type: "tool:start",
		data: {
			conversationId: conv.id,
			toolName: "preview_detected",
			extensionId: "",
			invocationId,
			input: {},
			cardType: "ez-preview-consent",
			timestamp: Date.now(),
		},
	});
	await emitSse({
		type: "tool:complete",
		data: {
			conversationId: conv.id,
			toolName: "preview_detected",
			extensionId: "",
			invocationId,
			output: consentPayload(port),
			cardType: "ez-preview-consent",
			duration: 0,
			success: true,
		},
	});

	return { calls };
}

test.describe("secure preview — expose-consent card", () => {
	test("renders the three affordances exactly once (no double-render)", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await navigateAndSurfaceCard(page, mockApi, emitSse, 5173);

		const cards = page.getByTestId("preview-consent-card");
		await expect(cards).toHaveCount(1, { timeout: 8000 });
		await expect(page.getByTestId("preview-consent-expose")).toBeVisible();
		await expect(page.getByTestId("preview-consent-ignore")).toBeVisible();
		await expect(page.getByTestId("preview-consent-always")).toBeVisible();
	});

	test("Expose POSTs action=expose then surfaces the Open-preview link", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		const { calls } = await navigateAndSurfaceCard(page, mockApi, emitSse, 5173);

		await expect(page.getByTestId("preview-consent-card")).toBeVisible({ timeout: 8000 });
		await page.getByTestId("preview-consent-expose").click();

		const open = page.getByTestId("preview-consent-open");
		await expect(open).toBeVisible({ timeout: 8000 });
		const href = (await open.getAttribute("href")) ?? "";
		expect(href).toContain("pid26label.preview.");
		expect(href).toContain("/__open?c=code123");

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ action: "expose", conversationId: conv.id, port: 5173 });
	});

	test("Always expose POSTs action=always-expose (D3)", async ({ page, mockApi, emitSse }) => {
		const { calls } = await navigateAndSurfaceCard(page, mockApi, emitSse, 3000);

		await expect(page.getByTestId("preview-consent-card")).toBeVisible({ timeout: 8000 });
		await page.getByTestId("preview-consent-always").click();

		await expect(page.getByTestId("preview-consent-open")).toBeVisible({ timeout: 8000 });
		expect(calls[0]).toMatchObject({ action: "always-expose", conversationId: conv.id, port: 3000 });
	});

	test("Ignore is a non-action: shows Ignored, no preview link", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		const { calls } = await navigateAndSurfaceCard(page, mockApi, emitSse, 8080);

		await expect(page.getByTestId("preview-consent-card")).toBeVisible({ timeout: 8000 });
		await page.getByTestId("preview-consent-ignore").click();

		await expect(page.getByTestId("preview-consent-ignored")).toBeVisible({ timeout: 8000 });
		await expect(page.getByTestId("preview-consent-open")).toHaveCount(0);
		expect(calls[0]?.action).toBe("ignore");
	});

	test("a failed expose surfaces the error banner", async ({ page, mockApi, emitSse }) => {
		await navigateAndSurfaceCard(page, mockApi, emitSse, 5173, { fail: true });

		await expect(page.getByTestId("preview-consent-card")).toBeVisible({ timeout: 8000 });
		await page.getByTestId("preview-consent-expose").click();
		await expect(page.getByTestId("preview-consent-error")).toContainText("expose failed", {
			timeout: 8000,
		});
	});
});

test.describe("secure preview — seeded auto-expose roundtrip (Docker-gated)", () => {
	// The full path — the REAL port watcher emitting preview:detected, the
	// consent endpoint creating a live preview_sessions row, the
	// always-expose preference auto-exposing without a click, and the
	// one-time-code handoff redeemed at /__open — needs the Docker harness
	// (DOCKER_TEST=1 + a seeded conversation/user). In plain preview there
	// is no DB so the endpoint can't create a row. Skipped, not deleted, so
	// the Docker job picks it up. Mirrors preview-static.spec.ts.
	test.skip(!process.env.DOCKER_TEST, "requires Docker harness + seeded conversation/user");

	test("always-expose preference auto-exposes a subsequently detected port", async ({ request }) => {
		// In the Docker harness: POST /api/preview/consent {action:
		// "always-expose"} once (authed app origin) → preference set + first
		// port exposed; then a later preview:detected for the same
		// conversation auto-exposes WITHOUT a card. Assert a second active
		// preview_sessions row appears for the requester and the handoff code
		// redeems at /__open. The seed fixture provisions the conversation +
		// user session cookie.
		const convId = process.env.PREVIEW_SEED_CONV_ID ?? conv.id;
		const res = await request.post("/api/preview/consent", {
			data: { conversationId: convId, port: 5173, action: "always-expose" },
		});
		expect(res.ok()).toBeTruthy();
		const body = await res.json();
		expect(body.previewId).toBeTruthy();
		expect(body.code).toBeTruthy();
	});
});
