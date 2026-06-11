/**
 * Daily Briefing Phase 2 e2e — live sidebar delivery (spec §5.3 + the
 * Phase 2 exit criterion: configure in UI, Run now, watch the briefing
 * conversation appear live with an unread dot).
 *
 * Pure client-wiring spec (mockApi + emitSse, no Docker): the fake
 * EventSource is the same `/api/runtime-events` stream
 * `createWSClient()` opens; `emitSse` pushes a `data:` frame exactly as
 * the server would after `shouldDeliverEvent` passed its fail-closed
 * per-user filter (unit-tested server-side in Phase 1). The
 * `/api/conversations` mock is STATEFUL: the run-now "delivery" flips
 * the list payload to include the briefing conversation, and we assert
 * the sidebar's event-driven refetch picks it up WITHOUT navigation or
 * a manual reload.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const projA = makeProject({ id: "proj-a", name: "Alpha" });
const projB = makeProject({ id: "proj-b", name: "Beta" });
const existing = makeConversation({ id: "conv-existing", projectId: "proj-a", title: "Existing chat" });
const briefingConv = makeConversation({
	id: "conv-briefing",
	projectId: "proj-a",
	title: "Daily Briefing — Thursday, Jun 11",
});

const BRIEFING_CONFIG = {
	userId: "user-1",
	enabled: true,
	cron: "0 7 * * *",
	timezone: "UTC",
	projectId: "proj-a",
	instructions: "",
	watchlist: [],
	model: null,
	provider: null,
	lastFireAt: null,
	lastFireStatus: null,
	consecutiveErrors: 0,
	nextFireAt: "2026-06-12T07:00:00.000Z",
	createdAt: "2026-06-01T00:00:00.000Z",
	updatedAt: "2026-06-01T00:00:00.000Z",
};

/** Stateful GET /api/conversations: list flips to include the briefing
 *  conversation once `state.delivered` is true. Registered AFTER mockApi
 *  so Playwright matches it first; everything else falls back. */
async function routeConversations(
	page: import("@playwright/test").Page,
	state: { delivered: boolean; listFetches: number },
) {
	await page.route("**/api/conversations**", (route) => {
		const url = new URL(route.request().url());
		if (url.pathname !== "/api/conversations" || route.request().method() !== "GET") {
			return route.fallback();
		}
		state.listFetches += 1;
		const list = state.delivered ? [briefingConv, existing] : [existing];
		const projectId = url.searchParams.get("projectId");
		return route.fulfill({ json: list.filter((c) => c.projectId === projectId) });
	});
}

test.describe("Daily Briefing — live sidebar delivery", () => {
	test("exit flow: Run now from settings → conversation appears live in the sidebar with an unread dot", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [projA, projB], conversations: [existing] });
		const state = { delivered: false, listFetches: 0 };
		await routeConversations(page, state);
		await page.route("**/api/briefing/config", (route) =>
			route.fulfill({ json: BRIEFING_CONFIG }),
		);
		await page.route("**/api/briefing/run-now", (route) =>
			route.fulfill({ status: 202, json: { started: true } }),
		);

		// Configure → Run now (202: the run is fire-and-forget server-side).
		await page.goto("/settings/briefing");
		await expect(page.getByTestId("briefing-enable-toggle")).toBeChecked();
		await page.getByTestId("briefing-run-now").click();
		await expect(page.getByTestId("briefing-run-now-message")).toContainText("Briefing started");

		// Open the project chat — baseline sidebar has only the existing chat.
		await page.goto("/project/proj-a/chat/conv-existing");
		// Scoped to the sidebar ROW button — bare getByText also matches the
		// chat header's title once the conversation finishes loading (strict
		// mode violation, timing-dependent).
		await expect(page.getByRole("button", { name: /Existing chat/ })).toBeVisible();
		await expect(page.getByText("Daily Briefing — Thursday, Jun 11")).toHaveCount(0);

		// The briefing run completes server-side: the conversation now exists
		// and the user-scoped `conversation:created` event reaches this
		// session's SSE stream.
		state.delivered = true;
		await emitSse({
			type: "conversation:created",
			data: {
				conversationId: "conv-briefing",
				projectId: "proj-a",
				userId: "user-1",
				source: "briefing",
			},
		});

		// No navigation, no reload — the sidebar refetches and shows the
		// briefing conversation with the unread dot.
		await expect(page.getByText("Daily Briefing — Thursday, Jun 11")).toBeVisible();
		const briefingRow = page
			.locator("div.group", { hasText: "Daily Briefing — Thursday, Jun 11" })
			.first();
		await expect(briefingRow.locator('span[title="New activity"]')).toBeVisible();

		// Active project badge also reflects the unread conversation.
		await expect(
			page.locator('[data-testid="project-unread-badge"][data-project-id="proj-a"]'),
		).toHaveText("1");
	});

	test("delivery to an INACTIVE project bumps its rail badge without refetching the open list", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [projA, projB], conversations: [existing] });
		const state = { delivered: false, listFetches: 0 };
		await routeConversations(page, state);

		await page.goto("/project/proj-a/chat/conv-existing");
		// Scoped to the sidebar ROW button — bare getByText also matches the
		// chat header's title once the conversation finishes loading (strict
		// mode violation, timing-dependent).
		await expect(page.getByRole("button", { name: /Existing chat/ })).toBeVisible();
		const fetchesAfterLoad = state.listFetches;

		// Briefing lands in proj-b while the user is looking at proj-a.
		await emitSse({
			type: "conversation:created",
			data: {
				conversationId: "conv-briefing-b",
				projectId: "proj-b",
				userId: "user-1",
				source: "briefing",
			},
		});

		// Project rail badge for proj-b lights up...
		await expect(
			page.locator('[data-testid="project-unread-badge"][data-project-id="proj-b"]'),
		).toHaveText("1");
		// ...but the proj-a list was NOT refetched (event targeted proj-b).
		await page.waitForTimeout(300);
		expect(state.listFetches).toBe(fetchesAfterLoad);
		await expect(
			page.locator('[data-testid="project-unread-badge"][data-project-id="proj-a"]'),
		).toHaveCount(0);
	});

	test("unrelated runtime events do not trigger a sidebar refetch", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [projA], conversations: [existing] });
		const state = { delivered: false, listFetches: 0 };
		await routeConversations(page, state);

		await page.goto("/project/proj-a/chat/conv-existing");
		// Scoped to the sidebar ROW button — bare getByText also matches the
		// chat header's title once the conversation finishes loading (strict
		// mode violation, timing-dependent).
		await expect(page.getByRole("button", { name: /Existing chat/ })).toBeVisible();
		const fetchesAfterLoad = state.listFetches;

		await emitSse({ type: "run:status", data: { runId: "run-x", status: "running" } });

		await page.waitForTimeout(300);
		expect(state.listFetches).toBe(fetchesAfterLoad);
	});

	test("a malformed event without conversationId is a no-op", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [projA], conversations: [existing] });
		const state = { delivered: false, listFetches: 0 };
		await routeConversations(page, state);

		await page.goto("/project/proj-a/chat/conv-existing");
		// Scoped to the sidebar ROW button — bare getByText also matches the
		// chat header's title once the conversation finishes loading (strict
		// mode violation, timing-dependent).
		await expect(page.getByRole("button", { name: /Existing chat/ })).toBeVisible();

		await emitSse({
			type: "conversation:created",
			data: { projectId: "proj-a", userId: "user-1", source: "briefing" },
		});

		await page.waitForTimeout(300);
		await expect(page.locator('[data-testid="project-unread-badge"]')).toHaveCount(0);
	});
});
