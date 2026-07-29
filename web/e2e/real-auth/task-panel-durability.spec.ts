/**
 * Real-auth + real-DB e2e: the task panel is DURABLE and never stale.
 *
 * The mock-tier spec (`task-panel-cold-start.spec.ts`) proves the client
 * behaviour against stubbed routes. This one proves the same thing against
 * the real stack — real PGlite, the real `extension_storage` row, the real
 * task-tracking extension subprocess, the real SSE stream — because both
 * bugs this feature fixes live in the seams BETWEEN those pieces:
 *
 *   1. Cold start: the panel is rendered from a real persisted snapshot on a
 *      brand-new page load, with no live event ever delivered. That is the
 *      "vanishes on refresh / in a second tab" report.
 *   2. Lost updates: concurrent tool calls each do a read-modify-write over
 *      ONE storage row through the SDK's fire-and-forget channel. Before the
 *      lock, an interleaved pair silently dropped one write. Only a REAL
 *      subprocess exercises that channel — an in-process fake can't.
 *
 * Gated on the sandbox probe like the other extension-spawn specs: without
 * kernel caps the extension subprocess can't start at all.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { sandboxSpawnAvailable } from "./sandbox-probe";

test.describe.configure({ mode: "serial" });

interface TrackedTask {
	id: string;
	title: string;
	status: string;
	assignments: unknown[];
}

/** Read the persisted snapshot through the cold-start route. */
async function readSnapshot(
	request: APIRequestContext,
	conversationId: string,
): Promise<{ tasks: TrackedTask[]; activeTaskId?: string }> {
	const res = await request.get(`/api/conversations/${conversationId}/tasks`);
	expect(res.status(), await res.text()).toBe(200);
	return (await res.json()) as { tasks: TrackedTask[]; activeTaskId?: string };
}

/** Invoke a task-tracking tool against the real extension subprocess. */
let invocationSeq = 0;
async function invokeTaskTool(
	request: APIRequestContext,
	conversationId: string,
	toolName: string,
	input: Record<string, unknown>,
) {
	return request.post("/api/tool-invoke", {
		data: {
			extensionName: "task-tracking",
			toolName,
			input,
			conversationId,
			// Required by the route; unique per call so concurrent invokes in
			// the burst below are distinct tool calls, not one deduped call.
			invocationId: `e2e-task-${++invocationSeq}-${process.pid}`,
		},
	});
}

test.describe("task panel — real persistence + concurrent writes", () => {
	test.skip(
		() => !sandboxSpawnAvailable(),
		"extension sandbox needs kernel caps (prlimit/Landlock) not available on this runner",
	);

	let conversationId = "";

	test.beforeEach(async ({ request }) => {
		const seed = await request.post("/api/__test/seed", { data: { title: "e2e-task-durability" } });
		expect(seed.status(), await seed.text()).toBe(201);
		conversationId = ((await seed.json()) as { conversationId: string }).conversationId;
	});

	test("tasks planned through the real extension survive a fresh page load", async ({
		page,
		request,
	}) => {
		const planned = await invokeTaskTool(request, conversationId, "task_plan", {
			tasks: [{ title: "Design the schema" }, { title: "Write the migration" }],
		});
		expect(planned.status(), await planned.text()).toBe(200);

		// The extension persisted to its real storage row — read it back
		// through the very route the panel hydrates from.
		const snapshot = await readSnapshot(request, conversationId);
		expect(snapshot.tasks.map((t) => t.title).sort()).toEqual([
			"Design the schema",
			"Write the migration",
		]);

		// A BRAND-NEW page load. No `task:snapshot` event is ever delivered for
		// these tasks — they were created before this page existed, which is
		// exactly the refresh / second-tab case that used to render nothing.
		await page.goto(`/project/global/chat/${conversationId}`);

		await expect(page.getByRole("button", { name: /task panel/i })).toBeVisible();
		await expect(page.getByText("Design the schema")).toBeVisible();
		await expect(page.getByText("Write the migration")).toBeVisible();

		// And again after a hard reload — the panel must not be a one-shot.
		await page.reload();
		await expect(page.getByText("Design the schema")).toBeVisible();
		await expect(page.getByText("Write the migration")).toBeVisible();
	});

	test("concurrent task_add calls all survive — no lost updates", async ({ request }) => {
		// Seed one task so the snapshot row exists before the burst.
		const seeded = await invokeTaskTool(request, conversationId, "task_plan", {
			tasks: [{ title: "seed" }],
		});
		expect(seeded.status(), await seeded.text()).toBe(200);

		// Fire N adds with NO await between them. Each is a separate
		// `tools/call` frame; the SDK channel dispatches them fire-and-forget,
		// so before the lock their load→mutate→save cycles interleaved and the
		// last writer clobbered the rest.
		const titles = ["alpha", "bravo", "charlie", "delta", "echo"];
		const responses = await Promise.all(
			titles.map((title) => invokeTaskTool(request, conversationId, "task_add", { title })),
		);
		for (const res of responses) {
			expect(res.status(), await res.text()).toBe(200);
		}

		// Every single add must be present. Any missing title IS the lost
		// update this feature fixes. Verified as a real assertion by a negative
		// control: with the extension's `withLock` removed, this run persisted
		// only ["seed", "alpha", "echo"] — three adds silently clobbered.
		const snapshot = await readSnapshot(request, conversationId);
		const got = snapshot.tasks.map((t) => t.title);
		for (const title of titles) {
			expect(got, `"${title}" was lost — a concurrent write clobbered it`).toContain(title);
		}
		expect(snapshot.tasks).toHaveLength(titles.length + 1); // + the seed
	});

	test("a live tool call updates an already-open panel, and the update is durable", async ({
		page,
		request,
	}) => {
		const planned = await invokeTaskTool(request, conversationId, "task_plan", {
			tasks: [{ title: "First task" }],
		});
		expect(planned.status(), await planned.text()).toBe(200);

		await page.goto(`/project/global/chat/${conversationId}`);
		await expect(page.getByText("First task")).toBeVisible();

		// Mutate while the page is open — the panel picks it up over the live
		// SSE stream, with no reload.
		const added = await invokeTaskTool(request, conversationId, "task_add", {
			title: "Added while watching",
		});
		expect(added.status(), await added.text()).toBe(200);

		await expect(page.getByText("Added while watching")).toBeVisible({ timeout: 15_000 });

		// The live update is backed by real persistence, not just client state:
		// a reload re-reads it from the DB.
		await page.reload();
		await expect(page.getByText("First task")).toBeVisible();
		await expect(page.getByText("Added while watching")).toBeVisible();
	});
});
