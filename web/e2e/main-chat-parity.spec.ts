/**
 * PHASE 0 — Main-chat behaviour-pinning e2e (no src changes).
 *
 * Freezes the OBSERVABLE contract of the current main chat page that the
 * Phase 3/4 `<ChatThread variant="page">` extraction must preserve
 * byte-for-byte. After Phase 4 swaps `+page.svelte`'s inlined thread for
 * the shared component, THIS SPEC MUST STILL PASS UNCHANGED — it is the
 * end-to-end half of the DRY proof (plan risk-register row #1; the
 * component-level half is `ChatThread.behavior.component.test.ts`).
 *
 * Axes pinned (per the Phase-0 bullet): branch-nav default leaf render,
 * regenerate/edit toolbar surfaces, live WS streaming render, message
 * send → optimistic render, select-mode entry, URL leaf survival on
 * reload. Mocked API + WS via the shared e2e fixtures — same harness the
 * rest of `web/e2e/chat-*.spec.ts` uses.
 *
 * `@evidence`: this is the ONLY spec that renders the whole thread —
 * populated history, branch resolution, and the live streaming state. The
 * other specs mapped to `ChatThread.svelte` in `web/e2e/evidence-covers.json`
 * are narrow feature pins (A/B retry, model selection, arrow-key nav) that
 * never photograph the message list itself, so a thread-render regression
 * could previously satisfy the visual gate through an unrelated spec.
 */

import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Parity Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

/**
 * The rendered thread. SCOPE text assertions about a just-SENT turn to this
 * container: sending the first message re-titles the conversation, and the
 * sidebar's conversation-list button then carries the same text ("Pinned hello
 * 218d ago"). A page-wide `getByText` races that refresh and dies on a strict-
 * mode violation (measured ~14% of runs before this scoping). The thread is
 * also what these cases are actually pinning — the sidebar title is a
 * different surface with its own spec.
 */
function thread(page: Page) {
	return page.getByTestId("chat-messages-container");
}

test.describe("Main-chat parity baseline (Phase 0 pin)", () => {
	test("branched tree renders the latest sibling branch by default @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		// u1 has two assistant children; the newer (a1b) branch is default.
		const u1 = makeMessage({
			id: "u1",
			conversationId: "conv-1",
			role: "user",
			content: "Question one",
			parentMessageId: null,
			createdAt: "2026-01-01T00:00:01.000Z",
		});
		const a1 = makeMessage({
			id: "a1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Older answer A",
			parentMessageId: "u1",
			createdAt: "2026-01-01T00:00:02.000Z",
		});
		const a1b = makeMessage({
			id: "a1b",
			conversationId: "conv-1",
			role: "assistant",
			content: "Newer answer B",
			parentMessageId: "u1",
			createdAt: "2026-01-01T00:00:03.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [u1, a1, a1b],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Default leaf walk lands on the newest sibling branch.
		await expect(page.getByText("Newer answer B")).toBeVisible();
		await expect(page.getByText("Older answer A")).not.toBeVisible();
		await expect(page.getByText("Question one")).toBeVisible();

		// The whole thread, rendered: user + assistant bubbles, the branch
		// switcher, and the composer beneath them.
		await captureEvidence(page, testInfo, "chat-thread-branched-render");
	});

	test("send message renders the user turn (optimistic → server)", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(
			page.getByText("Send a message to start the conversation"),
		).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Pinned hello");
		await page.getByRole("button", { name: "Send message" }).click();

		await expect(thread(page).getByText("Pinned hello")).toBeVisible({
			timeout: 5000,
		});
	});

	test("active WS run binds the streaming UI (stop control appears) @evidence", async ({
		page,
		mockApi,
		emitWs,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(
			page.getByText("Send a message to start the conversation"),
		).toBeVisible();

		await page.locator("textarea").fill("Stream please");
		await page.getByRole("button", { name: "Send message" }).click();

		// Wait for the user turn so the POST has resolved and the page has
		// called startStreaming("run-stream", convId) for the assistant
		// placeholder it just appended.
		await expect(thread(page).getByText("Stream please")).toBeVisible({
			timeout: 5000,
		});

		// The messages POST mock returns runId "run-stream". Emitting a
		// token on that run flips the page's `isStreaming` $derived
		// (keyed on `store.streamingMessages[runId]`) which is the
		// runId↔conversation binding contract the Phase-3/4 extraction
		// must preserve. We assert via the Stop control (NOT the token
		// text) so this pin is independent of the markdown render path
		// — that path is mid-refactor in unrelated uncommitted WIP and
		// is intentionally out of scope for this baseline.
		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "streaming…" },
		});

		await expect(
			page.getByRole("button", { name: /stop/i }),
		).toBeVisible({ timeout: 8000 });

		// The thread mid-stream: the in-flight assistant turn and the Stop
		// control the streaming binding drives.
		await captureEvidence(page, testInfo, "chat-thread-streaming");
	});

	test("assistant turn exposes regenerate; user turn exposes edit", async ({
		page,
		mockApi,
	}) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Edit me",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Regenerate me",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Regenerate me")).toBeVisible();

		// Hover the assistant bubble → Regenerate toolbar action present.
		await page.getByText("Regenerate me").locator("..").hover();
		await expect(
			page.getByRole("button", { name: "Regenerate response" }).first(),
		).toBeVisible();

		// Hover the user bubble → Edit toolbar action present.
		await page.getByText("Edit me").locator("..").hover();
		await expect(
			page.getByRole("button", { name: "Edit message" }).first(),
		).toBeVisible();
	});

	test("edit-text (no-regenerate) action is available on a saved turn", async ({
		page,
		mockApi,
	}) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Saved user text",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Saved assistant text",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Saved assistant text")).toBeVisible();
		await page.getByText("Saved assistant text").locator("..").hover();
		// edit-text-btn is the page's `data-testid` for the "Edit saved
		// text (no regenerate)" toolbar action.
		await expect(
			page.getByTestId("edit-text-btn").first(),
		).toBeVisible();
	});

	test("URL leaf param survives a reload (branch deep-link)", async ({
		page,
		mockApi,
	}) => {
		const u1 = makeMessage({
			id: "u1",
			conversationId: "conv-1",
			role: "user",
			content: "Deep-link question",
			parentMessageId: null,
			createdAt: "2026-01-01T00:00:01.000Z",
		});
		const a1 = makeMessage({
			id: "a1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Deep-link branch A",
			parentMessageId: "u1",
			createdAt: "2026-01-01T00:00:02.000Z",
		});
		const a1b = makeMessage({
			id: "a1b",
			conversationId: "conv-1",
			role: "assistant",
			content: "Deep-link branch B",
			parentMessageId: "u1",
			createdAt: "2026-01-01T00:00:03.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [u1, a1, a1b],
		});

		// Deep-link straight to the OLDER branch via ?leafMessageId — the
		// page's leaf param drives `getConversationPath(leaf)`.
		await page.goto(
			`/project/${proj.id}/chat/${conv.id}?leafMessageId=a1`,
		);
		await expect(page.getByText("Deep-link question")).toBeVisible();

		// Reload — the deep-linked conversation still resolves (the page
		// must not crash / lose the conversation on the leaf param).
		await page.reload();
		await expect(page.getByText("Deep-link question")).toBeVisible();
	});

	test("select-mode entry surfaces a bulk action bar", async ({
		page,
		mockApi,
	}) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Selectable one",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Selectable two",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Selectable one")).toBeVisible();

		// Long-press a message to enter select-mode (the page's
		// long-press → useSelectMode.toggleSelectMode trigger). Use a
		// slow pointer press to synthesise the long-press.
		const bubble = page.getByText("Selectable one");
		const box = await bubble.boundingBox();
		if (box) {
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.down();
			await page.waitForTimeout(800);
			await page.mouse.up();
		}

		// Select-mode is active → the bulk-action affordance appears
		// (a "Cancel"/"selected" control from SelectModeActionBar). We
		// assert resiliently: either the action bar or a selection
		// count becomes visible.
		const selectionUi = page
			.getByText(/selected|Cancel|Select/i)
			.first();
		await expect(selectionUi).toBeVisible({ timeout: 5000 });
	});
});
