import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

// E2E for the substack-pipeline human turn. The pipeline itself is
// server-side (covered by unit + integration); the layer ONLY a browser
// can prove is: the LLM-called `ask_user_question` renders its inline
// card in running state for this flow, a click POSTs the answer, and
// the run resumes to `finalize_substack_post`.
//
// Runtime events stream over SSE (`ws.ts` EventSource →
// `stores.svelte.ts` createWSClient), so events are injected with
// `emitSse` (NOT the deprecated `emitWs` WebSocket transport).

test.describe("substack-pipeline — ask-user card render → click → resume", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Substack Chat" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Turn https://example.com/post into a Substack post",
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "On it.",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	async function setupAndSend(page: any, mockApi: any) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea = page.locator("textarea");
		await textarea.fill("Turn https://example.com/post into a post");
		await textarea.press("Enter");
		await page.waitForResponse(
			(r: any) => r.url().includes("/messages") && r.request().method() === "POST",
		);
	}

	async function streamAsk(
		emitSse: any,
		input: { question: string; options?: string[] },
		invocationId: string,
	) {
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Working…" } });
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-ask-user",
				toolName: "ask_user_question",
				input,
				timestamp: Date.now(),
				invocationId,
				cardType: "ask-user-question",
			},
		});
	}

	test("ask_user_question card (running) → Approve → POST → resume to finalize", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await setupAndSend(page, mockApi);
		await streamAsk(
			emitSse,
			{ question: "Approve this draft, or request changes?", options: ["Approve", "Request changes"] },
			"tc-ask-1",
		);

		const card = page.locator('[data-testid="ask-user-question-card"]');
		await expect(card).toBeVisible({ timeout: 8000 });
		await expect(card).toContainText("Approve this draft, or request changes?");
		const approveBtn = card.getByRole("button", { name: "Approve", exact: true });
		await expect(approveBtn).toBeVisible();
		await expect(card.getByRole("button", { name: "Request changes" })).toBeVisible();

		let answerBody: any = null;
		await page.route("**/api/ask-user/answer", async (route: any) => {
			answerBody = route.request().postDataJSON();
			await route.fulfill({ json: { ok: true } });
		});
		await approveBtn.click();
		await expect.poll(() => answerBody).toBeTruthy();
		expect(answerBody.toolCallId).toBe("tc-ask-1");
		expect(answerBody.answer).toBe("Approve");

		// tool:complete flips the card to answered (run resumed).
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-ask-user",
				toolName: "ask_user_question",
				output: { content: [{ type: "text", text: "Approve" }] },
				duration: 5,
				success: true,
				invocationId: "tc-ask-1",
				cardType: "ask-user-question",
			},
		});
		await expect(page.locator('[data-testid="ask-user-answered-text"]')).toContainText(
			"Approve",
		);

		// Pipeline resumes to finalize, returning article + cover image.
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-substack-pipeline",
				toolName: "finalize_substack_post",
				input: {},
				timestamp: Date.now(),
				invocationId: "tc-final-1",
			},
		});
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-substack-pipeline",
				toolName: "finalize_substack_post",
				output: {
					content: [
						{
							type: "text",
							text: "![cover](/api/ext-files/openai-image-gen-2/g/x.png)\n\n# My Post\n\nFinal body.",
						},
					],
				},
				duration: 40,
				success: true,
				invocationId: "tc-final-1",
			},
		});
		await expect(page.getByText("finalize_substack_post")).toBeVisible({ timeout: 8000 });
	});

	test("Request changes surfaces a free-text follow-up card", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await setupAndSend(page, mockApi);
		await streamAsk(
			emitSse,
			{ question: "Approve this draft, or request changes?", options: ["Approve", "Request changes"] },
			"tc-ask-2",
		);

		let body: any = null;
		await page.route("**/api/ask-user/answer", async (route: any) => {
			body = route.request().postDataJSON();
			await route.fulfill({ json: { ok: true } });
		});
		const card = page.locator('[data-testid="ask-user-question-card"]');
		await expect(card).toBeVisible({ timeout: 8000 });
		await card.getByRole("button", { name: "Request changes" }).click();
		await expect.poll(() => body).toBeTruthy();
		expect(body.answer).toBe("Request changes");

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-ask-user",
				toolName: "ask_user_question",
				output: { content: [{ type: "text", text: "Request changes" }] },
				duration: 5,
				success: true,
				invocationId: "tc-ask-2",
				cardType: "ask-user-question",
			},
		});

		// Second ask-user with no options → free-text form.
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-ask-user",
				toolName: "ask_user_question",
				input: { question: "What should change?" },
				timestamp: Date.now(),
				invocationId: "tc-ask-3",
				cardType: "ask-user-question",
			},
		});
		await expect(page.locator('[data-testid="ask-user-text-form"]')).toBeVisible({ timeout: 8000 });
		await expect(page.getByText("What should change?")).toBeVisible();
	});
});
