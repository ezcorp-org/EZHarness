import { expect, type Page } from "@playwright/test";
import type { Conversation, Project } from "../../src/lib/api.js";
import type { MockOverrides } from "./api-mocks.js";
import { emitSseEvent } from "./ws-mock.js";

/**
 * The single runtime-event stream the app opens (`web/src/lib/ws.ts`).
 * Everything client-facing rides this one SSE connection.
 */
const RUNTIME_EVENTS_URL = "/api/runtime-events";

/** Minimal shape the task panel needs; specs pass their own richer tasks. */
export interface TaskSnapshotSeed {
	conversationId: string;
	tasks: unknown[];
	activeTaskId?: string;
}

/**
 * Seed the chat page's task panel with a snapshot.
 *
 * The panel renders off `store.taskSnapshots[convId]`, and that record is
 * written ONLY by the `task:snapshot` handler in `web/src/lib/stores.svelte.ts`.
 * Nothing fetches `/api/conversations/:id/tasks` on page load, so mocking that
 * REST route seeds nothing — the snapshot has to arrive over the same
 * runtime-event stream the app really uses.
 *
 * Call AFTER `page.goto`. Resolves once the panel has rendered; an empty
 * snapshot renders nothing by design, so there is nothing to wait for.
 */
export async function seedTaskSnapshot(page: Page, snapshot: TaskSnapshotSeed): Promise<void> {
	// The store attaches its handler when it opens the stream. Emitting before
	// that lands drops the frame on the floor, so wait for a live consumer.
	await page.waitForFunction((url) => {
		const sources = (
			window as Window & {
				__fakeEventSources?: Array<{ url: string; instance?: { onmessage?: unknown } }>;
			}
		).__fakeEventSources;
		return !!sources?.some((es) => es.url.includes(url) && !!es.instance?.onmessage);
	}, RUNTIME_EVENTS_URL);

	await emitSseEvent(page, { type: "task:snapshot", data: snapshot }, RUNTIME_EVENTS_URL);

	if (snapshot.tasks.length > 0) {
		await expect(
			page.getByRole("button", { name: /Collapse task panel|Expand task panel/ }),
		).toBeVisible();
	}
}

/**
 * Mock the API, open a project conversation and seed its task panel — the
 * three steps every task-panel spec needs before it can assert anything.
 */
export async function openChatWithTasks(
	page: Page,
	mockApi: (overrides?: MockOverrides) => Promise<void>,
	opts: {
		project: Project;
		conversation: Conversation;
		snapshot: TaskSnapshotSeed;
	},
): Promise<void> {
	await mockApi({
		projects: [opts.project],
		conversations: [opts.conversation],
		messages: [],
	});

	await page.goto(`/project/${opts.project.id}/chat/${opts.conversation.id}`);

	await seedTaskSnapshot(page, opts.snapshot);
}
