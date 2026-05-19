import { test, expect } from "./fixtures/test-base.js";
import type { Page, Locator } from "@playwright/test";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Climb from the message-text node up to the `.group` row container that
 * holds the toolbar AND carries the `data-excluded` attribute (the
 * exclusion-state source of truth in the DOM). The chat layout is:
 *   <div class="group relative …" data-excluded="true|undef">  ← row
 *     <div class="…">U|provider-icon</div>
 *     <div class="min-w-0 flex-1">                              ← content wrapper
 *       <p class="excluded-prose …">{content}</p>               ← styled via CSS
 *     </div>
 *     <MessageToolbar />
 *   </div>
 * `getByText(content)` lands on the `<p>`; we walk up to the `.group` row
 * so we can both hover (toolbar reveal) and inspect `data-excluded`.
 */
function rowOf(page: Page, content: string): Locator {
	return page.getByText(content).locator("xpath=ancestor::div[contains(@class, 'group')][1]");
}

/**
 * End-to-end coverage for the strikethrough "exclude from LLM context"
 * affordance on chat messages. Renders a real conversation, hovers a row
 * to surface the toolbar, clicks the new icon, and asserts the full
 * round-trip:
 *
 *   1. The PATCH /api/conversations/:id/messages/:mid request body carries
 *      `{ excluded: true }` (the LLM-context filter on the server reads
 *      this exact field).
 *   2. The row picks up `data-excluded="true"` and the prose visually
 *      strikes through (computed style assertion — the CSS-class approach
 *      means there's no `.line-through` class to grep for; the strike-
 *      through is applied via a Svelte-scoped descendant rule so the
 *      class name doesn't bleed into the toolbar's "copy as rich HTML").
 *   3. Toggling again sends `{ excluded: false }` and removes the marker.
 *   4. State persists across a page refresh — i.e. the GET /messages
 *      response carrying `excluded: true` re-applies the strike-through
 *      without any further user interaction.
 *   5. The button works on assistant rows too (the feature is
 *      role-agnostic; both user + assistant turns can be excluded).
 *   6. Negative assertion: tool cards / chrome inside an excluded row
 *      stay full-opacity (they're side-effects worth keeping legible).
 *
 * Mocks: the PATCH handler in `api-mocks.ts` flips the in-memory message
 * row, so a subsequent GET reflects the new value just like the real
 * server would.
 */

/**
 * True when the located element renders with a strike-through visual.
 *
 * The strike-through is applied via a Svelte-scoped CSS rule on the
 * `.excluded-prose` wrapper, NOT inline on the element. Descendant text
 * (e.g. a `<p>` inside the assistant's MarkdownRenderer output) inherits
 * the visual effect but its OWN `getComputedStyle().textDecorationLine`
 * reports "none" because text-decoration isn't an inherited CSS property
 * — the line is painted by the ancestor. So walk up to the closest
 * `.excluded-prose` element (or fall back to self for the user `<p>` case
 * where the prose IS the styled element) and check its computed style.
 */
async function hasStrikeThrough(loc: Locator): Promise<boolean> {
	return loc.evaluate((el) => {
		const target = el.closest(".excluded-prose") ?? el;
		return getComputedStyle(target).textDecorationLine.includes("line-through");
	});
}

test.describe("Chat — exclude message from LLM context", () => {
	const proj = makeProject({ id: "proj-excl", name: "Exclude Project" });
	const conv = makeConversation({ id: "conv-excl", projectId: "proj-excl" });

	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-excl",
		role: "user",
		content: "Question one",
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-excl",
		role: "assistant",
		content: "Answer one",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	test("clicking the strikethrough button sends PATCH {excluded:true} and applies line-through styling", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		// Capture the PATCH request body so we can assert the wire payload —
		// the server's load-history filter keys off this exact field, and a
		// silent rename would break the LLM-context feature without breaking
		// the visible UI.
		const patchPromise = page.waitForRequest(
			(req) =>
				req.method() === "PATCH" &&
				req.url().includes(`/api/conversations/${conv.id}/messages/${userMsg.id}`),
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Question one")).toBeVisible();

		const userRow = rowOf(page, "Question one");
		await userRow.hover();

		const excludeBtn = userRow.locator('[data-testid="exclude-context-btn"]').first();
		await expect(excludeBtn).toBeVisible();
		await expect(excludeBtn).toHaveAttribute("aria-pressed", "false");
		await excludeBtn.click();

		const req = await patchPromise;
		expect(req.postDataJSON()).toEqual({ excluded: true });

		// Visual confirmation: the row picks up data-excluded and the prose
		// computes line-through. The CSS lives in a Svelte-scoped <style>
		// block on ChatMessage.svelte (rule: `[data-excluded="true"]
		// .excluded-prose`), so this assertion fires even though no element
		// carries `class="line-through"` literally.
		await expect(userRow).toHaveAttribute("data-excluded", "true");
		expect(await hasStrikeThrough(page.getByText("Question one"))).toBe(true);

		// And the toolbar button itself flips its aria-pressed state.
		await userRow.hover();
		await expect(excludeBtn).toHaveAttribute("aria-pressed", "true");
	});

	test("toggling off sends PATCH {excluded:false} and removes the line-through", async ({ page, mockApi }) => {
		// Start with the message already excluded so we exercise the
		// re-include path — the inverse of the previous test.
		const seededExcluded = { ...userMsg, excluded: true };

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [seededExcluded, assistantMsg],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Persistence check: the strike-through is on at load time without
		// any interaction — proves the GET /messages → render path honors
		// the `excluded` field.
		const userRow = rowOf(page, "Question one");
		await expect(userRow).toHaveAttribute("data-excluded", "true");
		expect(await hasStrikeThrough(page.getByText("Question one"))).toBe(true);

		const patchPromise = page.waitForRequest(
			(req) =>
				req.method() === "PATCH" &&
				req.url().includes(`/api/conversations/${conv.id}/messages/${userMsg.id}`),
		);

		await userRow.hover();
		const excludeBtn = userRow.locator('[data-testid="exclude-context-btn"]').first();
		await expect(excludeBtn).toHaveAttribute("aria-pressed", "true");
		await excludeBtn.click();

		const req = await patchPromise;
		expect(req.postDataJSON()).toEqual({ excluded: false });

		// Strike-through removed. The data-excluded attribute should now be
		// absent (we render `data-excluded={excluded ? 'true' : undefined}`,
		// so falsy collapses the attribute entirely).
		await expect(userRow).not.toHaveAttribute("data-excluded", "true");
		expect(await hasStrikeThrough(page.getByText("Question one"))).toBe(false);
	});

	test("excluded state survives a page refresh (GET /messages re-renders strike-through)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const userRow = rowOf(page, "Question one");
		await userRow.hover();
		await userRow.locator('[data-testid="exclude-context-btn"]').first().click();
		await expect(userRow).toHaveAttribute("data-excluded", "true");

		// The mock holds state across requests in-process, so a hard reload
		// re-runs the GET /messages handler against the now-mutated row and
		// the UI must re-derive the strike-through from `message.excluded`.
		await page.reload();
		const reloadedRow = rowOf(page, "Question one");
		await expect(reloadedRow).toHaveAttribute("data-excluded", "true");
		expect(await hasStrikeThrough(page.getByText("Question one"))).toBe(true);
		await reloadedRow.hover();
		await expect(
			reloadedRow.locator('[data-testid="exclude-context-btn"]').first(),
		).toHaveAttribute("aria-pressed", "true");
	});

	test("works on assistant rows too (feature is role-agnostic)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		const patchPromise = page.waitForRequest(
			(req) =>
				req.method() === "PATCH" &&
				req.url().includes(`/api/conversations/${conv.id}/messages/${assistantMsg.id}`),
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const assistantRow = rowOf(page, "Answer one");
		await assistantRow.hover();
		await assistantRow.locator('[data-testid="exclude-context-btn"]').first().click();

		const req = await patchPromise;
		expect(req.postDataJSON()).toEqual({ excluded: true });

		await expect(assistantRow).toHaveAttribute("data-excluded", "true");
		expect(await hasStrikeThrough(page.getByText("Answer one"))).toBe(true);
	});

	test("tool-call wrappers inside an excluded assistant row also strike through", async ({ page, mockApi }) => {
		// Tool cards live inside the assistant message row; before this fix
		// the strike-through CSS only matched `.excluded-prose` text wrappers,
		// so an excluded turn rendered with struck text but full-opacity tool
		// cards — visually inconsistent. The fix adds `excluded-prose` to the
		// tool-card wrappers in BOTH the contentBlocks branch and the flat
		// fallback branch, so the same descendant CSS rule reaches them.
		const seededExcluded = { ...assistantMsg, excluded: true };
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, seededExcluded],
			messageToolCalls: {
				[assistantMsg.id]: [
					{
						id: "tc-1",
						extensionId: "ext-1",
						toolName: "search",
						input: { query: "weather" },
						outputSummary: "weather in NYC",
						success: true,
						durationMs: 42,
						status: "success",
						messageId: assistantMsg.id,
						cardType: null,
					},
				],
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const assistantRow = rowOf(page, "Answer one");
		await expect(assistantRow).toHaveAttribute("data-excluded", "true");

		// The tool-card wrapper carries `id="tool-call-tc-1"` so the assertion
		// targets exactly the wrapper that owns the excluded-prose class —
		// not the inner ToolCallCard chrome (which is structured DOM that
		// would inherit unevenly).
		const toolWrapper = page.locator("#tool-call-tc-1");
		await expect(toolWrapper).toBeVisible();
		expect(await hasStrikeThrough(toolWrapper)).toBe(true);
	});

	test("memory + thinking cards inside an excluded assistant row also strike through", async ({ page, mockApi }) => {
		// Mirror of the tool-call test for the other renderable cards
		// inside an assistant turn — MemoriesCard, ThinkingCard, and the
		// agent-chip cluster. All three wrappers carry `excluded-prose` so
		// one CSS rule fades them in lockstep with the prose. The test
		// confirms the wrappers render AND inherit the strike-through.
		const seededExcluded = {
			...assistantMsg,
			excluded: true,
			thinkingContent: "scratch reasoning",
			memoriesUsed: [
				{ id: "mem-1", content: "remembered thing", category: "fact" },
			],
		};
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, seededExcluded],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const assistantRow = rowOf(page, "Answer one");
		await expect(assistantRow).toHaveAttribute("data-excluded", "true");

		// MemoriesCard renders the literal "Memories" label; walk up via
		// hasStrikeThrough's `.excluded-prose` resolver. Same for the
		// ThinkingCard (its trigger button starts with "Thinking" and is a
		// stable affordance — see ThinkingCard.svelte).
		expect(await hasStrikeThrough(page.getByText("Memories"))).toBe(true);
		expect(await hasStrikeThrough(page.getByText(/Thinking/i).first())).toBe(true);
	});

	test("toolbar button stays full-opacity inside an excluded row (negative assertion: chrome is not faded)", async ({ page, mockApi }) => {
		// Lock down the I1 contract: when a message is excluded, ONLY the
		// prose strikes through. Toolbar / chrome / sibling content stays
		// fully legible. A future refactor that reverts to the wrapper-
		// scoped strike-through (which faded everything inside the row)
		// would silently regress; this assertion catches it.
		const seededExcluded = { ...userMsg, excluded: true };
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [seededExcluded, assistantMsg],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const userRow = rowOf(page, "Question one");
		await expect(userRow).toHaveAttribute("data-excluded", "true");
		await userRow.hover();

		// Prose strikes through.
		expect(await hasStrikeThrough(page.getByText("Question one"))).toBe(true);

		// Toolbar exclude-button does NOT.
		const excludeBtn = userRow.locator('[data-testid="exclude-context-btn"]').first();
		expect(await hasStrikeThrough(excludeBtn)).toBe(false);

		// Avatar (the "U" badge) is also chrome and must stay legible. It
		// lives at the row level outside `.excluded-prose`, so the CSS rule
		// does not reach it. This pins the broader chrome contract beyond
		// just the toolbar.
		const avatar = userRow.locator("div").filter({ hasText: /^U$/ }).first();
		expect(await hasStrikeThrough(avatar)).toBe(false);
	});

	test("ambiguous payload {content, excluded} is rejected by the mock with 400 (mock parity with the real route)", async ({ page, mockApi }) => {
		// Defense-in-depth: the server-side XOR refine rejects payloads with
		// both fields (covered by `messages-patch-content.test.ts:223`). The
		// e2e mock at `api-mocks.ts:295` mirrors that rejection — without
		// this parity, an e2e test that accidentally produced an ambiguous
		// payload would pass against the mock and fail in production.
		// Drive a raw fetch from the page context so we exercise the mock's
		// router exactly the way real client traffic would.
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const result = await page.evaluate(
			async ({ convId, msgId }) => {
				const res = await fetch(`/api/conversations/${convId}/messages/${msgId}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ content: "x", excluded: true }),
				});
				return { status: res.status, body: await res.json().catch(() => null) };
			},
			{ convId: conv.id, msgId: userMsg.id },
		);
		expect(result.status).toBe(400);

		// And the empty payload — the same XOR refine catches both extremes.
		const empty = await page.evaluate(
			async ({ convId, msgId }) => {
				const res = await fetch(`/api/conversations/${convId}/messages/${msgId}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({}),
				});
				return res.status;
			},
			{ convId: conv.id, msgId: userMsg.id },
		);
		expect(empty).toBe(400);
	});

	test("PATCH 500 surfaces a user-visible error banner (no silent privacy regression)", async ({ page, mockApi }) => {
		// The optimistic flip stays applied on failure (we deliberately do
		// NOT roll back — see comment at handleToggleExclude). That means
		// the user could see the icon flip while the server still has the
		// turn included — a privacy-shaped silent failure if there's no
		// surface. Confirm the page-level `error` reactive variable
		// renders into a `role="alert"` banner with copy that mentions
		// the failed direction.
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		// Override the PATCH handler with a 500 — registered AFTER mockApi
		// so this route wins on overlap.
		await page.route(
			`**/api/conversations/${conv.id}/messages/${userMsg.id}`,
			(route) => {
				if (route.request().method() === "PATCH") {
					return route.fulfill({ status: 500, json: { error: "Internal" } });
				}
				return route.fallback();
			},
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Question one")).toBeVisible();

		const userRow = rowOf(page, "Question one");
		await userRow.hover();
		await userRow.locator('[data-testid="exclude-context-btn"]').first().click();

		// The error banner appears with copy that names the direction the
		// user attempted ("Couldn't exclude…" — they were toggling ON).
		const alert = page.getByRole("alert");
		await expect(alert).toBeVisible();
		await expect(alert).toContainText(/exclude/i);
	});

	test("rich-HTML clipboard copy of an excluded message does NOT carry a strikethrough class", async ({ page, mockApi }) => {
		// Privacy-shaped regression: an earlier fix put `class:line-through`
		// directly on the inner div that lives inside `mdContainer`. The
		// toolbar's shift-click "copy as rich HTML" reads
		// `mdContainer.innerHTML`, so the strikethrough was leaking into
		// the user's clipboard — pasting into the same app re-rendered
		// the strike-through under the destination's Tailwind. The fix
		// moved the styling to a Svelte-scoped CSS rule so the class on
		// the copied element is `excluded-prose svelte-<hash>`, neither
		// half of which fires a strike in any paste destination.
		const seededExcluded = { ...userMsg, excluded: true };
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [seededExcluded, assistantMsg],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const userRow = rowOf(page, "Question one");
		await expect(userRow).toHaveAttribute("data-excluded", "true");

		// Walk into the message-content wrapper and read the prose's
		// `class` attribute as it would appear in copied HTML. The class
		// should be inert (no `line-through`, no `text-decoration:`).
		const proseClass = await page
			.getByText("Question one")
			.evaluate((el) => el.getAttribute("class") ?? "");
		expect(proseClass).not.toContain("line-through");
		// Inline style attribute must also stay clean (no inline strike).
		const proseStyle = await page
			.getByText("Question one")
			.evaluate((el) => el.getAttribute("style") ?? "");
		expect(proseStyle).not.toContain("line-through");
	});
});
