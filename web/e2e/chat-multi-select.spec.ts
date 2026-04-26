import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Multi-select shift+click + bulk actions (Copy, Exclude/Include).
 *
 * The chat page already supports a per-row checkbox via Select Mode
 * (covered in `chat-select-mode.spec.ts`). This spec layers in:
 *   - shift+click extends selection from the last anchor to the clicked row
 *   - reverse-direction shift+click (anchor after target)
 *   - bulk Copy concatenates each turn's `formatMessageForCopy` output
 *   - bulk Exclude PATCHes every selected row with `{excluded:true}` and
 *     re-running it after all rows are excluded sends `{excluded:false}`
 *   - selection clears when the user navigates to a different conversation
 */

test.describe("Chat multi-select — shift+click and bulk actions", () => {
	const proj = makeProject({ id: "proj-ms-1", name: "Multi Select Project" });
	const conv = makeConversation({ id: "conv-ms-1", projectId: "proj-ms-1", title: "Main" });
	const conv2 = makeConversation({ id: "conv-ms-2", projectId: "proj-ms-1", title: "Other" });

	function seedTurns() {
		return [
			makeMessage({ id: "m1", conversationId: "conv-ms-1", role: "user", content: "Q one", createdAt: "2026-04-01T00:00:00.000Z" }),
			makeMessage({ id: "m2", conversationId: "conv-ms-1", role: "assistant", content: "A one", parentMessageId: "m1", createdAt: "2026-04-01T00:01:00.000Z" }),
			makeMessage({ id: "m3", conversationId: "conv-ms-1", role: "user", content: "Q two", parentMessageId: "m2", createdAt: "2026-04-01T00:02:00.000Z" }),
			makeMessage({ id: "m4", conversationId: "conv-ms-1", role: "assistant", content: "A two", parentMessageId: "m3", createdAt: "2026-04-01T00:03:00.000Z" }),
			makeMessage({ id: "m5", conversationId: "conv-ms-1", role: "user", content: "Q three", parentMessageId: "m4", createdAt: "2026-04-01T00:04:00.000Z" }),
		];
	}

	test("shift+click on a message auto-enters select mode (no toolbar button needed)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Q one")).toBeVisible();

		// Action bar is NOT visible — user has not entered select mode.
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);

		// Shift+click on the row body directly (not the toolbar button).
		// `getByText` lands on the <p>; walk up to the `.group` row container.
		const row = page.getByText("Q one").locator("xpath=ancestor::div[contains(@class, 'group')][1]");
		await row.click({ modifiers: ["Shift"] });

		// Auto-entered select mode: action bar appears, count = 1, anchor set.
		await expect(page.getByTestId("select-action-bar")).toBeVisible();
		await expect(page.getByTestId("selected-count")).toHaveText("1");

		// Subsequent shift+click on a later row extends the range.
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("3");
	});

	test("shift+click extends selection forward from the anchor", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();

		// Click first turn → anchor = m1, count = 1.
		await page.getByTestId("select-checkbox-m1").click();
		await expect(page.getByTestId("selected-count")).toHaveText("1");

		// Shift+click third turn → range expands, count = 3.
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("3");
	});

	test("shift+click extends selection backward when anchor is after target", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();

		// Anchor on the 4th turn, then shift+click the 2nd → range covers m2..m4.
		await page.getByTestId("select-checkbox-m4").click();
		await page.getByTestId("select-checkbox-m2").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("3");
	});

	test("shift+click on an already-selected target deselects ONLY that row", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();

		// Anchor on m1, shift+click m4 → range m1..m4 selected (4 turns).
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m4").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("4");

		// Shift+click m3 (currently selected, in the middle of the range).
		// New semantics: only m3 gets deselected. m1, m2, m4 stay intact —
		// items "above" or "below" the click are NOT swept up.
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("3");
		// Visual check: m3's checkbox is empty, neighbours stay checked.
		await expect(page.getByTestId("select-checkbox-m1").locator("svg")).toBeVisible();
		await expect(page.getByTestId("select-checkbox-m2").locator("svg")).toBeVisible();
		await expect(page.getByTestId("select-checkbox-m3").locator("svg")).toHaveCount(0);
		await expect(page.getByTestId("select-checkbox-m4").locator("svg")).toBeVisible();
	});

	test("shift+click on a selected row when anchor is below the click does NOT drop rows below the click", async ({ page, mockApi }) => {
		// Specific regression for: anchor at m5, range m1..m5 selected, then
		// shift+clicking m3 used to remove m3..m5 (everything from click to
		// anchor). New behavior: only m3 gets removed.
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m5").click(); // anchor=m5
		await page.getByTestId("select-checkbox-m1").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("5");

		// Shift+click m3 — m3 is selected, anchor is m5 (below m3). Old logic
		// would have wiped out m3, m4, m5. New logic touches only m3.
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("4");
		await expect(page.getByTestId("select-checkbox-m3").locator("svg")).toHaveCount(0);
		await expect(page.getByTestId("select-checkbox-m4").locator("svg")).toBeVisible();
		await expect(page.getByTestId("select-checkbox-m5").locator("svg")).toBeVisible();
	});

	test("plain click after a range still toggles a single id", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("3");

		// Plain click on m5 ADDS it (toggle); count → 4.
		await page.getByTestId("select-checkbox-m5").click();
		await expect(page.getByTestId("selected-count")).toHaveText("4");

		// Plain click on m5 again removes it; count → 3.
		await page.getByTestId("select-checkbox-m5").click();
		await expect(page.getByTestId("selected-count")).toHaveText("3");
	});

	test("Bulk Copy writes each selected turn to the clipboard, separated by ---", async ({ page, mockApi, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		// Bulk toolbar reuses MessageToolbar; copy lives inside it.
		await page.getByTestId("bulk-toolbar").getByRole("button", { name: /Copy message/i }).click();

		await expect(page.getByTestId("bulk-status")).toContainText(/Copied 3/);

		// Verify clipboard contents: "Q one\n\n---\n\nA one\n\n---\n\nQ two".
		const clip = await page.evaluate(() => navigator.clipboard.readText());
		expect(clip).toContain("Q one");
		expect(clip).toContain("A one");
		expect(clip).toContain("Q two");
		expect(clip).toContain("---");
	});

	test("Bulk Exclude PATCHes every selected row and toggles to Include when all excluded", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Capture each PATCH payload so we can assert the bulk fan-out. Use
		// `route.fallback()` so the underlying mockApi handler (registered
		// first, so it fires last) still fulfills the request — `continue()`
		// would skip mockApi and hit the network.
		const patches: { id: string; excluded: boolean }[] = [];
		await page.route("**/api/conversations/*/messages/*", (route) => {
			if (route.request().method() === "PATCH") {
				const body = route.request().postDataJSON() as { excluded?: boolean };
				const segs = new URL(route.request().url()).pathname.split("/");
				const id = segs[segs.length - 1]!;
				if (typeof body.excluded === "boolean") patches.push({ id, excluded: body.excluded });
			}
			route.fallback();
		});

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });

		// Bulk Exclude lives inside the inline MessageToolbar; scope by testid.
		const bulkExclude = page.getByTestId("bulk-toolbar").getByTestId("exclude-context-btn");

		// First fan-out → all three rows get excluded:true. Select mode stays
		// open so the user sees the confirmation and can run another bulk op.
		await bulkExclude.click();
		await expect(page.getByTestId("bulk-status")).toContainText(/Excluded 3/);
		await expect(page.getByTestId("selected-count")).toHaveText("0");
		expect(patches.filter((p) => p.excluded === true).map((p) => p.id).sort()).toEqual(["m1", "m2", "m3"]);

		// Re-select the same three rows. Now the button's aria-label reads
		// "Include in LLM context" because all three are already excluded.
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		await expect(bulkExclude).toHaveAttribute("aria-label", /Include in LLM context/);

		await bulkExclude.click();
		await expect(page.getByTestId("bulk-status")).toContainText(/Included 3/);
		expect(patches.filter((p) => p.excluded === false).map((p) => p.id).sort()).toEqual(["m1", "m2", "m3"]);
	});

	test("Bulk Save Memory POSTs /api/memories once with all selected turns combined", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Capture every POST /api/memories — bulk save must fire EXACTLY one
		// request whose body contains all selected turns, role-labelled and
		// joined by the same `---` separator the bulk Copy uses.
		const saved: { content: string }[] = [];
		await page.route("**/api/memories", (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON() as { content: string };
				saved.push({ content: body.content });
				return route.fulfill({
					status: 201,
					json: { id: `mem-${saved.length}`, content: body.content },
				});
			}
			route.fallback();
		});

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });

		await page.getByTestId("bulk-toolbar").getByTestId("save-memory-btn").click();

		await expect(page.getByTestId("bulk-status")).toContainText(/Saved 3/);
		expect(saved.length).toBe(1);
		const body = saved[0]!.content;
		// Plain text only — no role labels, no `---` separators.
		expect(body).toContain("Q one");
		expect(body).toContain("A one");
		expect(body).toContain("Q two");
		expect(body).not.toContain("[user]");
		expect(body).not.toContain("[assistant]");
		expect(body).not.toContain("---");
		// Render order is preserved.
		expect(body.indexOf("Q one")).toBeLessThan(body.indexOf("A one"));
		expect(body.indexOf("A one")).toBeLessThan(body.indexOf("Q two"));
	});

test("Shift+click on an interactive descendant (link inside a message) does NOT auto-enter select mode", async ({ page, mockApi }) => {
		// `handleRowClick` skips clicks whose target is inside an interactive
		// descendant (anchor / button / input / etc.) so links and buttons
		// embedded in message content keep their normal behaviour. We dispatch
		// a synthetic shift+click on the link via JS rather than playwright's
		// .click() to avoid triggering real navigation, which is unrelated to
		// the assertion.
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-ms-1", role: "user", content: "Q link", createdAt: "2026-04-01T00:00:00.000Z" }),
				makeMessage({
					id: "m2",
					conversationId: "conv-ms-1",
					role: "assistant",
					content: "See [the docs](https://example.com/docs) for more.",
					parentMessageId: "m1",
					createdAt: "2026-04-01T00:01:00.000Z",
				}),
			],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByRole("link", { name: "the docs" })).toBeVisible();

		// Shift+click on the link via a synthetic event so navigation doesn't
		// kick in. The bubbled click reaches the row's onclick handler, which
		// must early-out because the target is an `<a>`.
		await page.evaluate(() => {
			const link = document.querySelector('a[href="https://example.com/docs"]') as HTMLElement;
			link.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
			);
		});

		// Action bar must NOT appear — handleRowClick correctly ignored the
		// click because the target was inside an interactive descendant.
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);
	});

	test("Bulk Copy includes tool call input and output for assistant turns", async ({ page, mockApi, context }) => {
		// `handleBulkCopy` resolves historical tool calls per assistant message
		// and feeds them through `formatMessageForCopy`. Without this test,
		// regressions that drop tool I/O from the bulk clipboard could ship.
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: seedTurns(),
			messageToolCalls: {
				m2: [
					{
						id: "tc-1",
						extensionId: "ext-test",
						toolName: "read_file_in_bulk_copy",
						input: { path: "README.md" },
						outputSummary: "ok",
						success: true,
						durationMs: 12,
						status: "success",
						messageId: "m2",
					},
				],
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		// Ensure tool calls are hydrated into the message DOM before copy.
		await expect(page.getByText("read_file_in_bulk_copy").first()).toBeVisible();

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m2").click({ modifiers: ["Shift"] });
		await page.getByTestId("bulk-toolbar").getByRole("button", { name: /Copy message/i }).click();
		await expect(page.getByTestId("bulk-status")).toContainText(/Copied 2/);

		const clip = await page.evaluate(() => navigator.clipboard.readText());
		expect(clip).toContain("Q one");
		expect(clip).toContain("A one");
		expect(clip).toContain("[Tool: read_file_in_bulk_copy]");
		expect(clip).toContain("README.md");
	});

	test("Bulk Save Memory shows error and preserves selection when POST fails", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Override the memories POST with a 500 — test the error path of the
		// bulk handler (status surfaced as alert, selection preserved so the
		// user can retry without re-selecting).
		await page.route("**/api/memories", (route) => {
			if (route.request().method() === "POST") {
				return route.fulfill({ status: 500, json: { error: "boom" } });
			}
			route.fallback();
		});

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("3");

		await page.getByTestId("bulk-toolbar").getByTestId("save-memory-btn").click();

		// Error surfaces in the action bar's alert region. Selection survives
		// so the user can retry.
		await expect(page.getByRole("alert")).toContainText(/500|fail|memories/i);
		await expect(page.getByTestId("selected-count")).toHaveText("3");
	});

	test("Pressing Enter on a selectable row toggles its selection (keyboard a11y)", async ({ page, mockApi }) => {
		// Each `.group` row carries `role="checkbox"` + `tabindex="0"` in select
		// mode and listens for Enter / Space — covers keyboard-only users.
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();

		// Focus the m1 row and hit Enter — selection toggles on.
		const row = page
			.getByText("Q one")
			.locator("xpath=ancestor::div[contains(@class, 'group')][1]");
		await row.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("selected-count")).toHaveText("1");
		await expect(page.getByTestId("select-checkbox-m1").locator("svg")).toBeVisible();

		// Hit Space — selection toggles off.
		await page.keyboard.press(" ");
		await expect(page.getByTestId("selected-count")).toHaveText("0");
	});

	test("New Chat button renders with the branch glyph (forked-from-selection affordance)", async ({ page, mockApi }) => {
		// Branch was removed from the bulk toolbar; New Chat now carries the
		// same icon to signal that the fork is anchored to the selection.
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m1").click();

		// New Chat button visible with an inline svg icon (the only one inside
		// it — labelled `aria-hidden`, so we count via locator directly).
		const btn = page.getByTestId("new-chat-from-selection");
		await expect(btn).toBeVisible();
		await expect(btn.locator("svg")).toHaveCount(1);

		// And the bulk toolbar must NOT have a Branch button anymore.
		await expect(
			page.getByTestId("bulk-toolbar").getByRole("button", { name: /Branch from here/i }),
		).toHaveCount(0);
	});

	test("Pressing Escape exits select mode and clears the selection (Cancel parity)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("3");

		// Esc — same effect as the Cancel button.
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);
		// Composer reappears in place of the action bar.
		await expect(page.locator("textarea").first()).toBeVisible();
	});

	test("Pressing Escape after auto-enter (shift+click) also exits", async ({ page, mockApi }) => {
		// Auto-enter path uses the same `selectMode` state, so Esc should
		// dismiss it identically.
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Q one")).toBeVisible();

		const row = page.getByText("Q one").locator("xpath=ancestor::div[contains(@class, 'group')][1]");
		await row.click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("select-action-bar")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);
	});

	test("Escape does nothing while NOT in select mode (doesn't intercept other handlers)", async ({ page, mockApi }) => {
		// We tear down the keydown listener when select mode is off, so global
		// Esc usage (closing modals, etc.) keeps working as expected. Sanity
		// check: pressing Esc on a fresh page does not flicker the action bar.
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Q one")).toBeVisible();

		await page.keyboard.press("Escape");
		// Action bar still absent — Esc was a no-op for select mode.
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);
		// Re-enter via toolbar; Esc must still work after a no-op press.
		await page.getByTestId("select-mode-toggle").click();
		await expect(page.getByTestId("select-action-bar")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);
	});

	test("Selection clears when navigating to a different conversation", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv, conv2],
			messages: [
				...seedTurns(),
				makeMessage({ id: "n1", conversationId: "conv-ms-2", role: "user", content: "Other Q" }),
			],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-m1").click();
		await page.getByTestId("select-checkbox-m3").click({ modifiers: ["Shift"] });
		await expect(page.getByTestId("selected-count")).toHaveText("3");

		// Navigate to the other conversation. The action bar must vanish — i.e.
		// select mode + selection were both cleared on the convId switch.
		await page.goto(`/project/${proj.id}/chat/${conv2.id}`);
		await expect(page.getByText("Other Q")).toBeVisible();
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);
	});
});
