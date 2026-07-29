import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { emitSseEvent, setupWsMock } from "./fixtures/ws-mock.js";

/**
 * Task-panel cold start.
 *
 * The panel renders off `store.taskSnapshots[convId]`. Before this spec
 * existed that record was written ONLY by the `task:snapshot` runtime event,
 * so any surface that had missed the live event rendered nothing:
 *
 *   - a refresh (F5) wiped the store and the panel vanished
 *   - opening the same chat in a second tab never showed the panel at all
 *   - an SSE drop silently lost every task event in the gap
 *
 * The fix is a cold-start hydrate against `GET /api/conversations/:id/tasks`
 * (the route already existed and was documented as the cold-start loader —
 * it just had no caller) that also re-runs on conversation switch and on SSE
 * reconnect. These tests pin all four surfaces.
 */

const RUNTIME_EVENTS_URL = "/api/runtime-events";

const proj = makeProject({ id: "proj-1", name: "Task Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Task Convo" });
const other = makeConversation({ id: "conv-2", projectId: "proj-1", title: "Other Convo" });

function persistedTask(id: string, title: string, status: string, priority: number) {
	return {
		id,
		title,
		description: "",
		status,
		priority,
		assignments: [],
		subtasks: [],
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

/** The two tasks the server has persisted for `conv-1`. */
const PERSISTED = [
	persistedTask("t1", "Set up repo", "completed", 0),
	persistedTask("t2", "Write tests", "active", 1),
];

/** Wait until the store's SSE handler is attached (mirrors `task-seed.ts`). */
async function waitForLiveStream(page: Page): Promise<void> {
	await page.waitForFunction((url: string) => {
		const sources = (
			window as Window & {
				__fakeEventSources?: Array<{ url: string; instance?: { onmessage?: unknown } }>;
			}
		).__fakeEventSources;
		return !!sources?.some((es) => es.url.includes(url) && !!es.instance?.onmessage);
	}, RUNTIME_EVENTS_URL);
}

test.describe("Task Panel — cold start", () => {
	test("@evidence renders persisted tasks on first load with no live event", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			taskSnapshots: { "conv-1": { tasks: PERSISTED, activeTaskId: "t2" } },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// No `task:snapshot` event is ever emitted in this test — everything
		// below comes from the cold-start fetch alone.
		await expect(page.getByRole("button", { name: "Collapse task panel" })).toBeVisible();
		await expect(page.getByText("1/2", { exact: true })).toBeVisible();
		await expect(page.getByText("Set up repo")).toBeVisible();
		await expect(page.getByText("Write tests")).toBeVisible();

		await captureEvidence(page, testInfo, "task-panel-cold-start");
	});

	test("survives a page reload", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			taskSnapshots: { "conv-1": { tasks: PERSISTED, activeTaskId: "t2" } },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Write tests")).toBeVisible();

		await page.reload();

		await expect(page.getByRole("button", { name: "Collapse task panel" })).toBeVisible();
		await expect(page.getByText("Write tests")).toBeVisible();
	});

	test("shows up in a second tab on the same conversation", async ({ page, mockApi, context }) => {
		const mocks = {
			projects: [proj],
			conversations: [conv],
			messages: [],
			taskSnapshots: { "conv-1": { tasks: PERSISTED, activeTaskId: "t2" } },
		};
		await mockApi(mocks);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Write tests")).toBeVisible();

		// A second tab on the same conversation. Route mocks are page-scoped
		// so the new tab needs its own, but the point of the repro is the
		// fresh client store — the second tab never sees the `task:snapshot`
		// event the first one consumed.
		const tab2 = await context.newPage();
		await setupWsMock(tab2);
		await setupApiMocks(tab2, mocks);
		await tab2.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(tab2.getByRole("button", { name: "Collapse task panel" })).toBeVisible();
		await expect(tab2.getByText("Write tests")).toBeVisible();
		await tab2.close();
	});

	test("re-hydrates when the event stream reconnects", async ({ page, mockApi }) => {
		// Server starts with a single task…
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			taskSnapshots: { "conv-1": { tasks: [PERSISTED[0]!] } },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Set up repo")).toBeVisible();
		await waitForLiveStream(page);

		// …then a second task lands while the client is disconnected, so the
		// `task:snapshot` event for it is never delivered.
		await page.route("**/api/conversations/conv-1/tasks", (route) =>
			route.fulfill({ json: { conversationId: "conv-1", tasks: PERSISTED, activeTaskId: "t2" } }),
		);

		// A reconnect re-opens the stream; the hydrate rides that signal.
		await emitSseEvent(page, { type: "ws:connected", data: {} }, RUNTIME_EVENTS_URL);

		await expect(page.getByText("Write tests")).toBeVisible();
		await expect(page.getByText("1/2", { exact: true })).toBeVisible();
	});

	test("a failing snapshot load leaves the rendered panel alone", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			taskSnapshots: { "conv-1": { tasks: PERSISTED, activeTaskId: "t2" } },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Write tests")).toBeVisible();
		await waitForLiveStream(page);

		// The server can no longer read the snapshot. It answers 503 rather
		// than an empty list, precisely so a transient failure can't wipe what
		// the user is looking at.
		await page.route("**/api/conversations/conv-1/tasks", (route) =>
			route.fulfill({ status: 503, json: { error: "Task snapshot temporarily unavailable" } }),
		);

		// Force a re-hydrate through the reconnect path.
		await emitSseEvent(page, { type: "ws:connected", data: {} }, RUNTIME_EVENTS_URL);

		// Panel still shows what it had; it does NOT go blank.
		await expect(page.getByText("Set up repo")).toBeVisible();
		await expect(page.getByText("Write tests")).toBeVisible();
		await expect(page.getByText("1/2", { exact: true })).toBeVisible();
	});

	test("swaps snapshots when switching conversations", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv, other],
			messages: [],
			taskSnapshots: {
				"conv-1": { tasks: PERSISTED, activeTaskId: "t2" },
				"conv-2": { tasks: [persistedTask("t9", "Ship the release", "pending", 0)] },
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Write tests")).toBeVisible();

		await page.goto(`/project/${proj.id}/chat/${other.id}`);

		await expect(page.getByText("Ship the release")).toBeVisible();
		await expect(page.getByText("Write tests")).not.toBeVisible();
	});
});
