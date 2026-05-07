/**
 * E2E for the `!EZ:distill` action — full flow from popover →
 * submit → inline card render → ref-link navigation.
 *
 * Coverage targets (per plan §5.1):
 *   1. Popover (composer): typing `!EZ:` shows the EZ-actions
 *      group with `distill` listed.
 *   2. Inserting `![EZ:distill]` produces a token in the composer.
 *   3. Submitting an action-only message renders the success
 *      card inline AND no assistant turn appears (no streaming
 *      placeholder DOM).
 *   4. The success-card ref-link navigates to /memories with
 *      ?tab=lessons&lesson=<slug>.
 *   5. Persisted-history rendering: a conversation that already
 *      contains an `ez-action-result` message renders the card
 *      directly on page load (no submit needed).
 *   6. Decline result (info variant) renders without a ref-link.
 *
 * Test patterns mirror `feature-mention-injection.spec.ts` —
 * `pressSequentially` for input events, click on the popover row
 * to commit, etc.
 */
import { test, expect } from "./fixtures/test-base.js";
import {
	makeProject,
	makeConversation,
	makeMessage,
} from "./fixtures/data.js";

const PROJECT_ID = "proj-ez-actions";
const CONV_ID = "conv-ez-actions";

const project = makeProject({ id: PROJECT_ID, name: "EZ Actions Project" });
const conv = makeConversation({
	id: CONV_ID,
	projectId: PROJECT_ID,
	title: "EZ actions chat",
});

async function gotoEmptyChat(page: any, mockApi: any) {
	await mockApi({
		projects: [project],
		conversations: [conv],
		messages: [],
	});
	await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 5000 });
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
			return ta && !(ta as HTMLTextAreaElement).disabled;
		},
		{ timeout: 5000 },
	);
	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

test.describe("!EZ:distill — composer popover + chip", () => {
	test("typing `!EZ:` opens popover with `distill` action listed", async ({
		page,
		mockApi,
	}) => {
		const textarea = await gotoEmptyChat(page, mockApi);

		await textarea.focus();
		await textarea.pressSequentially("!EZ:", { delay: 50 });
		await page.waitForTimeout(350);

		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toBeVisible({ timeout: 5000 });
		await expect(listbox).toContainText("EZ actions");
		await expect(listbox).toContainText("!EZ:distill");
	});

	test("clicking distill row inserts the `![EZ:distill]` token", async ({
		page,
		mockApi,
	}) => {
		const textarea = await gotoEmptyChat(page, mockApi);

		await textarea.focus();
		await textarea.pressSequentially("!EZ:dist", { delay: 50 });
		await page.waitForTimeout(350);

		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toBeVisible({ timeout: 5000 });

		// Click the distill row.
		await listbox.getByText("!EZ:distill").click();

		// Token inserted into the textarea verbatim, with trailing space.
		await expect(textarea).toHaveValue(/!\[EZ:distill\]\s$/);

		// Popover closes after selection.
		await expect(listbox).not.toBeVisible({ timeout: 2000 });
	});
});

test.describe("!EZ:distill — submit + result card", () => {
	test("action-only submission renders success card inline AND skips assistant turn", async ({
		page,
		mockApi,
	}) => {
		const textarea = await gotoEmptyChat(page, mockApi);

		// Build the token via the composer flow so the trigger logic
		// (popover → click) is the same path the user takes.
		await textarea.focus();
		await textarea.pressSequentially("!EZ:dist", { delay: 50 });
		await page.waitForTimeout(350);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toBeVisible({ timeout: 5000 });
		await listbox.getByText("!EZ:distill").click();

		// Textarea now ends with `![EZ:distill] ` (trailing space) —
		// strip the space-only tail before submit so the message is
		// truly action-only (the strip on the server treats the
		// trailing space as whitespace-only).
		await expect(textarea).toHaveValue(/!\[EZ:distill\]\s$/);

		// Submit. Enter on a non-shifted textarea triggers send.
		await textarea.press("Enter");

		// Result card appears inline.
		const card = page.locator("[data-testid='ez-action-card']").first();
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card).toHaveAttribute("data-variant", "success");
		await expect(card).toHaveAttribute("data-kind", "success");
		await expect(card).toContainText("Lesson captured");

		// No assistant turn was started — runId came back null, so the
		// `streaming-${runId}` placeholder was never created.
		const streamingPlaceholder = page.locator(
			'[data-message-id^="streaming-"]',
		);
		await expect(streamingPlaceholder).toHaveCount(0);
	});

	test("success card carries a clickable ref-link to /memories Lessons tab", async ({
		page,
		mockApi,
	}) => {
		const textarea = await gotoEmptyChat(page, mockApi);

		await textarea.focus();
		await textarea.pressSequentially("!EZ:dist", { delay: 50 });
		await page.waitForTimeout(350);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toBeVisible({ timeout: 5000 });
		await listbox.getByText("!EZ:distill").click();
		await textarea.press("Enter");

		const link = page
			.locator("[data-testid='ez-action-card-ref-link']")
			.first();
		await expect(link).toBeVisible({ timeout: 5000 });
		await expect(link).toHaveAttribute("data-ref-kind", "lesson");
		await expect(link).toHaveAttribute("data-ref-slug", "e2e-mock-slug");

		const href = await link.getAttribute("href");
		expect(href).toBeTruthy();
		expect(href).toContain("/memories");
		expect(href).toContain("tab=lessons");
		expect(href).toContain("lesson=e2e-mock-slug");
	});
});

test.describe("!EZ:distill — persisted history rendering", () => {
	test("ez-action-result message in conversation history renders as card on page load", async ({
		page,
		mockApi,
	}) => {
		const userMsg = makeMessage({
			id: "msg-user-history",
			conversationId: CONV_ID,
			role: "user",
			content: "![EZ:distill]",
		});
		const resultMsg = makeMessage({
			id: "msg-ez-result",
			conversationId: CONV_ID,
			role: "ez-action-result",
			// Parent the result on the user message — the chat page
			// walks from `activeLeafId` to root via parentMessageId,
			// so a disconnected result row would be excluded from the
			// rendered path. Mirrors how the real server persists
			// these (with `parentMessageId: userMessage.id`).
			parentMessageId: "msg-user-history",
			content: JSON.stringify({
				kind: "success",
				card: {
					title: "Lesson captured",
					body: "from history",
					variant: "success",
				},
				ref: { kind: "lesson", slug: "history-slug" },
			}),
		});
		await mockApi({
			projects: [project],
			conversations: [conv],
			messages: [userMsg, resultMsg],
		});
		await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);

		const card = page.locator("[data-testid='ez-action-card']").first();
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card).toContainText("Lesson captured");
		await expect(card).toContainText("from history");
		const link = page.locator(
			"[data-testid='ez-action-card-ref-link'][data-ref-slug='history-slug']",
		);
		await expect(link).toBeVisible();
	});
});

test.describe("!EZ:distill — negative paths", () => {
	test("decline result (info variant) renders without a ref-link", async ({
		page,
		mockApi,
	}) => {
		const declinePayload = {
			userMessage: makeMessage({
				id: "msg-decline-user",
				conversationId: CONV_ID,
				role: "user",
				content: "![EZ:distill]",
			}),
			runId: null,
			attachments: [],
			ezActionResults: [
				{
					id: "ez-decline-1",
					role: "ez-action-result",
					content: JSON.stringify({
						kind: "decline",
						card: {
							title: "Distiller declined",
							body: "no reusable insight",
							variant: "info",
						},
					}),
				},
			],
		};
		const textarea = await gotoEmptyChat(page, mockApi);
		// Override the messages POST mock to return the decline
		// payload. Register AFTER mockApi so this handler shadows the
		// default messages-POST mock (Playwright matches in
		// registration order; later-registered routes win).
		await page.route(
			`**/api/conversations/${CONV_ID}/messages`,
			async (route) => {
				if (route.request().method() === "POST") {
					return route.fulfill({ json: declinePayload });
				}
				return route.continue();
			},
		);

		await textarea.focus();
		await textarea.pressSequentially("!EZ:dist", { delay: 50 });
		await page.waitForTimeout(350);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toBeVisible({ timeout: 5000 });
		await listbox.getByText("!EZ:distill").click();
		await textarea.press("Enter");

		const card = page.locator("[data-testid='ez-action-card']").first();
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card).toHaveAttribute("data-variant", "info");
		await expect(card).toHaveAttribute("data-kind", "decline");
		await expect(card).toContainText("Distiller declined");

		// Decline cards MUST NOT carry a ref-link.
		const link = page.locator("[data-testid='ez-action-card-ref-link']");
		await expect(link).toHaveCount(0);
	});
});
