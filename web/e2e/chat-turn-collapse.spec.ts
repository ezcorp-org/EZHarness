import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import { captureEvidence } from "./fixtures/evidence.js";

/**
 * Folding a chat TURN while walking back with the arrow keys.
 *
 * ArrowLeft steps to the previous prompt and folds the turn it left behind, so
 * a long run collapses down to the prompts you actually typed; the folded turn
 * keeps its prompt bubble and leaves one muted "N replies" row (the same idiom
 * as the thinking / tool cards). ArrowRight pops the most recent fold open
 * again, and clicking the row does the same by hand.
 *
 * Backed by web/src/lib/chat-turn-collapse.ts (decisions) and
 * ChatThread.svelte (render filter + key wiring).
 *
 * WHICH turn a single press folds depends on where the fold line falls in the
 * live layout, so nothing here hardcodes an id — the assertions are the
 * invariants: how many turns are folded, that every prompt survives, and that
 * a folded turn shows its prompt with none of its replies.
 */

const proj = makeProject({ id: "proj-1", name: "Turn Collapse Project" });
const conv = makeConversation({
	id: "conv-turns",
	projectId: "proj-1",
	title: "Turns",
	updatedAt: "2026-01-01T00:02:00.000Z",
});

// Five turns of one prompt + two replies each — exactly 15 rows, the thread's
// opening render window, so the whole conversation is on screen and a fold is
// unambiguous. Five turns also leaves room to walk back twice without running
// into the first prompt (where ArrowLeft correctly stops and folds nothing).
const TURNS = [1, 2, 3, 4, 5];
const REPLIES = [1, 2];
const PROMPT_IDS = TURNS.map((t) => `u${t}`);
const IDS: string[] = [];
for (const t of TURNS) {
	IDS.push(`u${t}`);
	for (const r of REPLIES) IDS.push(`a${t}-${r}`);
}
const messages = IDS.map((id, i) =>
	makeMessage({
		id,
		conversationId: conv.id,
		role: id.startsWith("u") ? "user" : "assistant",
		content: id.startsWith("u")
			? `Prompt ${id} — the question I typed`
			: `Reply ${id} — padding text so the turn is tall enough to see it fold away.`,
		parentMessageId: i === 0 ? null : IDS[i - 1]!,
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	}),
);

const rowIds = (page: Page): Promise<string[]> =>
	page.evaluate(() =>
		Array.from(
			document.querySelectorAll(
				'[data-testid="chat-messages-container"] [data-message-id]',
			),
		).map((n) => n.getAttribute("data-message-id") ?? ""),
	);

const summaryCount = (page: Page): Promise<number> =>
	page.locator('[data-testid="turn-collapsed-summary"]').count();

/** Turn numbers that are folded right now: prompt on screen, no replies. */
async function foldedTurns(page: Page): Promise<number[]> {
	const rendered = new Set(await rowIds(page));
	return TURNS.filter(
		(t) =>
			rendered.has(`u${t}`) && REPLIES.every((r) => !rendered.has(`a${t}-${r}`)),
	);
}

async function openThread(page: Page): Promise<void> {
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText(/Reply a5-2/)).toBeVisible({ timeout: 8000 });
	await page.waitForTimeout(200);
	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

const setup = {
	projects: [proj],
	conversations: [conv],
	messages,
	routes: { "active-run": () => ({ runId: null }) },
};

test.describe("chat turn collapse", () => {
	test("@evidence ArrowLeft folds the turn it leaves, keeping the prompt on screen", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi(setup);
		await openThread(page);

		expect(await rowIds(page), "everything starts expanded").toEqual(IDS);
		expect(await summaryCount(page)).toBe(0);

		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(400);

		expect(await foldedTurns(page), "one turn folded").toHaveLength(1);
		expect(await summaryCount(page)).toBe(1);
		// Every prompt is still on screen — folding only ever hides answers.
		const after = await rowIds(page);
		for (const id of PROMPT_IDS) expect(after).toContain(id);

		const summary = page.locator('[data-testid="turn-collapsed-summary"]');
		await expect(summary).toBeVisible();
		await expect(summary, "the row reports what it is hiding").toContainText(
			"2 replies",
		);

		await captureEvidence(page, testInfo, "turn-collapsed-after-arrow-left");
	});

	test("ArrowRight pops the last fold open — the exact inverse of ArrowLeft", async ({
		page,
		mockApi,
	}) => {
		await mockApi(setup);
		await openThread(page);

		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(350);
		const firstFold = await foldedTurns(page);
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(350);
		expect(await foldedTurns(page)).toHaveLength(2);
		expect(await summaryCount(page)).toBe(2);

		// The most recent fold unfolds first, leaving the one from press 1.
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(350);
		expect(await foldedTurns(page)).toEqual(firstFold);
		expect(await summaryCount(page)).toBe(1);

		// And again → the thread we started with, row for row.
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(350);
		expect(await summaryCount(page)).toBe(0);
		expect(await rowIds(page), "back to the thread we started with").toEqual(IDS);
	});

	test("clicking the summary row unfolds that turn", async ({ page, mockApi }) => {
		await mockApi(setup);
		await openThread(page);

		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(350);
		await expect(
			page.locator('[data-testid="turn-collapsed-summary"]'),
		).toBeVisible();

		await page.locator('[data-testid="turn-collapsed-summary"]').click();
		await page.waitForTimeout(300);

		expect(await summaryCount(page)).toBe(0);
		expect(await rowIds(page)).toEqual(IDS);
	});

	test("folds accumulate as you keep walking back", async ({ page, mockApi }) => {
		await mockApi(setup);
		await openThread(page);

		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(350);
		expect(await foldedTurns(page)).toHaveLength(1);

		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(350);
		expect(
			await foldedTurns(page),
			"both turns walked past are folded",
		).toHaveLength(2);

		// Every prompt survives, so the thread reads as the list of questions
		// asked plus the one turn still open.
		const after = await rowIds(page);
		for (const id of PROMPT_IDS) expect(after).toContain(id);
		expect(await summaryCount(page)).toBe(2);
	});
});

// ── Streaming guard ──────────────────────────────────────────────────
// Its own conversation: TWO turns, where the newest has a long answer. That
// length is what makes the newest turn reachable — a prompt in the final
// screenful cannot be parked at the fold, so a short last turn can never be
// "stepped away from" and the guard would never be exercised at all.
const convStream = makeConversation({
	id: "conv-stream",
	projectId: "proj-1",
	title: "Streaming turn",
	updatedAt: "2026-01-01T00:02:00.000Z",
});
const STREAM_IDS = [
	"s-u1",
	"s-a1-1",
	"s-a1-2",
	"s-u2",
	...Array.from({ length: 10 }, (_, i) => `s-a2-${i + 1}`),
];
const streamMessages = STREAM_IDS.map((id, i) =>
	makeMessage({
		id,
		conversationId: convStream.id,
		role: id.includes("-u") ? "user" : "assistant",
		content: id.includes("-u")
			? `Prompt ${id} — the question I typed`
			: `Reply ${id} — padding text so the turn is tall enough to see it fold away.`,
		parentMessageId: i === 0 ? null : STREAM_IDS[i - 1]!,
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	}),
);

/** Is the newest turn (s-u2) folded — prompt on screen, no replies? */
async function newestTurnFolded(page: Page): Promise<boolean> {
	const rendered = new Set(await rowIds(page));
	return (
		rendered.has("s-u2") &&
		!rendered.has("s-a2-1") &&
		!rendered.has("s-a2-10")
	);
}

async function openStreamThread(page: Page): Promise<void> {
	await page.goto(`/project/${proj.id}/chat/${convStream.id}`);
	await expect(page.getByText(/Reply s-a2-10/)).toBeVisible({ timeout: 8000 });
	await page.waitForTimeout(200);
	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

test.describe("chat turn collapse while a run streams", () => {
	test("the turn being written is never folded (and would be, were it idle)", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		// CONTROL arm: with no run in flight, ArrowLeft folds the newest turn.
		// This is what gives the streaming arm its teeth — without it, "not
		// folded" could just mean the nav never tried.
		await mockApi({
			projects: [proj],
			conversations: [convStream],
			messages: streamMessages,
			routes: { "active-run": () => ({ runId: null }) },
		});
		await openStreamThread(page);
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(400);
		expect(
			await newestTurnFolded(page),
			"idle: ArrowLeft folds the newest turn",
		).toBe(true);

		// STREAMING arm: same gesture, but a run is writing into that turn.
		// Folding it would hide the answer the user is watching arrive.
		await mockApi({
			projects: [proj],
			conversations: [convStream],
			messages: streamMessages,
			routes: { "active-run": () => ({ runId: "run-live" }) },
		});
		await openStreamThread(page);
		await emitWs({
			type: "run:token",
			data: {
				runId: "run-live",
				conversationId: convStream.id,
				token: "writing…",
			},
		});
		await page.waitForTimeout(400);
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(400);
		expect(
			await newestTurnFolded(page),
			"streaming: the live turn is left alone",
		).toBe(false);
	});
});
