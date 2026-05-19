import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * Chat-popover round-trip for user-DB slash commands.
 *
 * Closes Verification steps 2-3 from
 * `tasks/user-slash-command-authoring-ui.md`:
 *
 *   2. Open any chat, type `/myr`, confirm `/myreview` appears in
 *      popover with "Saved" source badge.
 *   3. Send `/myreview the auth middleware`. Confirm the LLM
 *      receives `Review: the auth middleware` (visible in the
 *      message log / runtime events).
 *
 * Discovery notes — for future maintainers:
 *
 * 1. **Popover surface.** `/api/mentions/search?type=cmd` is the
 *    single source the composer reads from. The real server
 *    (`web/src/routes/api/mentions/search/+server.ts`) calls
 *    `getCommandRegistry().listCommands()`, which merges filesystem
 *    sources AND `user_commands` DB rows under
 *    `source: "user:db"`. The e2e mock now mirrors that merge
 *    (`web/e2e/fixtures/api-mocks.ts`) — without it, user-DB
 *    commands would never reach the popover regardless of how the
 *    spec drives the composer.
 *
 * 2. **"Saved" badge.** `commandSourceLabel("user:db")` returns
 *    `{ scope: "Global", folder: "Saved", display: "Global · Saved" }`
 *    (`web/src/lib/command-source-label.ts`). Asserting on
 *    `data-source="user:db"` on the popover row + the text
 *    `"Saved"` matches what an end-user sees.
 *
 * 3. **LLM-facing expansion.** `applyCommandExpansion` lives in
 *    `src/runtime/mention-wiring.ts` and is unit-tested at
 *    `web/src/__tests__/expand-command-mentions.test.ts` — the
 *    full `Review: $ARGUMENTS` → `Review: the auth middleware`
 *    transform is covered there. The Playwright mock layer is a
 *    pure HTTP stub that does NOT exercise the runtime
 *    `applyCommandExpansion` path (the mock messages POST handler
 *    echoes content back verbatim — see api-mocks.ts ~line 623).
 *    The cleanest e2e signal that the user-DB row is reachable by
 *    the registry the runtime uses is the chip's hover popover:
 *    `MentionChip` calls `fetchCommandBody(name, projectId)` which
 *    re-issues `searchMentions(name, "cmd")` and surfaces the raw
 *    template body — the same row the registry would hand to
 *    `applyCommandExpansion` on the server. So:
 *
 *      - Popover renders user-DB command with "Saved" badge
 *        → step 2 ✓
 *      - Send path posts the raw `/[cmd:name] args` token
 *        → server-side expansion is contractually proven by the
 *          unit test on `applyCommandExpansion`
 *      - Chip hover popover shows the raw body
 *        `Review: $ARGUMENTS` → proves the user-DB row reaches the
 *        same registry surface the expansion adapter consumes,
 *        which is the strongest in-process signal Playwright
 *        can give without faking the runtime.
 */

const proj = makeProject({ id: "proj-cmds", name: "Commands Project" });
const conv = makeConversation({ id: "conv-cmds", projectId: "proj-cmds" });

async function setupAndFocus(page: any, mockApi: any, userCommands: any[]) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [],
		agents: [],
		extensions: [],
		// Seed the user-DB row that should surface in the popover.
		userCommands,
	});
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(
		page.getByText("Send a message to start the conversation"),
	).toBeVisible();

	const textarea = page.locator("textarea");

	// Wait for WS + textarea enabled — mirrors slash-commands.spec.ts.
	await page.waitForFunction(
		() => {
			const listeners = (window as any).__fakeWsListeners;
			if (listeners?.open) {
				for (const fn of listeners.open) {
					try {
						fn(new Event("open"));
					} catch {}
				}
			}
			const ta = document.querySelector("textarea");
			return ta && !ta.disabled;
		},
		{ timeout: 5000 },
	);

	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

async function typeInto(page: any, textarea: any, text: string) {
	await textarea.focus();
	await textarea.pressSequentially(text, { delay: 50 });
	await page.waitForTimeout(350); // debounce (200) + reactivity
}

async function waitForPopover(page: any) {
	await expect(page.locator("#mention-listbox")).toBeVisible({
		timeout: 5000,
	});
}

test.describe("User-DB commands · chat popover round-trip", () => {
	test("typing `/myc` surfaces the user-DB command with the Saved badge", async ({
		page,
		mockApi,
	}) => {
		const textarea = await setupAndFocus(page, mockApi, [
			{
				name: "mycmd-e2e",
				body: "Review: $ARGUMENTS",
				description: "Review staged changes",
			},
		]);

		await typeInto(page, textarea, "/myc");
		await waitForPopover(page);

		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toContainText("Slash commands");
		await expect(listbox).toContainText("/mycmd-e2e");

		// `data-source="user:db"` is the production-shape marker the
		// MentionPopover sets on each command row; the CommandCard on
		// /commands asserts the SAME attribute (user-commands.spec.ts).
		const row = listbox
			.locator("[data-source='user:db']")
			.filter({ hasText: "mycmd-e2e" })
			.first();
		await expect(row).toBeVisible();
		// commandSourceLabel("user:db") renders "Global · Saved".
		await expect(row).toContainText("Global");
		await expect(row).toContainText("Saved");
	});

	test("selecting the command and submitting posts the raw `/[cmd:…]` token + args", async ({
		page,
		mockApi,
	}) => {
		const textarea = await setupAndFocus(page, mockApi, [
			{
				name: "mycmd-e2e",
				body: "Review: $ARGUMENTS",
				description: "Review staged changes",
			},
		]);

		const requestPromise = page.waitForRequest(
			(req: any) =>
				req.url().includes(`/api/conversations/${conv.id}/messages`) &&
				req.method() === "POST",
		);

		await typeInto(page, textarea, "/myc");
		await waitForPopover(page);
		// Enter selects the highlighted (first) match → inserts
		// `/[cmd:mycmd-e2e] `.
		await page.keyboard.press("Enter");
		await page.waitForTimeout(100);
		await expect(textarea).toHaveValue("/[cmd:mycmd-e2e] ");

		// Type the arg payload and submit.
		await textarea.pressSequentially("the auth middleware", { delay: 30 });
		await page.waitForTimeout(150);
		await page.keyboard.press("Enter");

		const req = await requestPromise;
		const body = req.postDataJSON() as { content: string };
		// Server-side `applyCommandExpansion`
		// (src/runtime/mention-wiring.ts) substitutes `$ARGUMENTS` →
		// `the auth middleware` at stream time; the wire format the
		// client posts is intentionally the raw token. The full
		// expansion (`Review: the auth middleware`) is unit-tested at
		// web/src/__tests__/expand-command-mentions.test.ts; here we
		// assert the contract the runtime depends on.
		expect(body.content).toBe("/[cmd:mycmd-e2e] the auth middleware");
	});

	test("chip in chat history hovers to reveal the user-DB command body", async ({
		page,
		mockApi,
	}) => {
		// This is the strongest in-process e2e signal that the
		// user-DB row reaches the same registry surface
		// `applyCommandExpansion` consumes on the server: the chip
		// hover popover calls `fetchCommandBody`, which goes through
		// `/api/mentions/search?type=cmd` — the exact path the
		// registry feeds. If the row weren't routed through the
		// registry, the chip's lazy popover would render
		// "(body not available)" instead of the template.
		const textarea = await setupAndFocus(page, mockApi, [
			{
				name: "mycmd-e2e",
				body: "Review: $ARGUMENTS",
				description: "Review staged changes",
			},
		]);

		await typeInto(page, textarea, "/myc");
		await waitForPopover(page);
		await page.keyboard.press("Enter"); // insert token
		await page.waitForTimeout(100);
		await textarea.pressSequentially("the auth middleware", { delay: 30 });
		await page.waitForTimeout(150);
		await page.keyboard.press("Enter"); // submit
		await page.waitForTimeout(400);

		// After submit the composer resets; the chip we want is the
		// `/mycmd-e2e` token rendered inside the chat-history bubble.
		const chip = page
			.locator(
				"[data-mention-kind='command'][data-mention-name='mycmd-e2e']",
			)
			.first();
		await expect(chip).toBeVisible({ timeout: 5000 });

		await chip.hover();
		const popover = page.locator("[data-command-popover='mycmd-e2e']");
		await expect(popover).toBeVisible({ timeout: 3000 });
		// The chip shows the raw body template (pre-substitution) so
		// readers can see what shape the LLM saw. The runtime
		// substitution itself is covered by the applyCommandExpansion
		// unit tests — this assertion is the e2e proof that the
		// user-DB body actually reaches the chip's resolver.
		await expect(popover).toContainText("Review: $ARGUMENTS");
		await expect(popover).toContainText("Prompt sent for /mycmd-e2e");
	});

	test("fuzzy filter narrows the popover to the user-DB command alone", async ({
		page,
		mockApi,
	}) => {
		// Seed two user-DB rows + ensure the fuzzy filter on `mycmd`
		// excludes the unrelated one. Mirrors the existing
		// slash-commands.spec.ts "type-ahead filters results fuzzily"
		// case, but for the DB-backed source.
		const textarea = await setupAndFocus(page, mockApi, [
			{ name: "mycmd-e2e", body: "Review: $ARGUMENTS" },
			{ name: "audit-trail", body: "Audit: $ARGUMENTS" },
		]);

		await typeInto(page, textarea, "/myc");
		await waitForPopover(page);

		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toContainText("/mycmd-e2e");
		await expect(listbox).not.toContainText("/audit-trail");
	});
});
