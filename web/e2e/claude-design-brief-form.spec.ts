/** Browser contract for brief validation, answer submission, and streamed follow-up cards. */
import { test, expect } from "./fixtures/test-base.js";
import { sendComposerMessage } from "./fixtures/composer.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("claude-design — clarify-brief form-card flow", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Make me a marketing page.",
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Sure",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	const TOOL_CALL_ID = "tc-brief-1";

	test("renders form, blocks submit when required missing, POSTs answer body", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// Register this specific handler after the shared API mock.
		const captured: Array<{ url: string; body: unknown }> = [];
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.route(
			"**/api/extensions/claude-design/events/brief-answer",
			async (route) => {
				const reqBody = route.request().postDataJSON();
				captured.push({ url: route.request().url(), body: reqBody });
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: true }),
				});
			},
		);


		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes("/messages") && r.request().method() === "POST",
			),
			sendComposerMessage(page, "brief"),
		]);

		// Stream a `tool:start` for clarify-brief — this is a card whose
		// renderer reads `toolCall.input.fields` directly. Unlike dock
		// cards we do NOT need to wait for `tool:complete`; the form
		// renders immediately on start.
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__clarify-brief",
				input: {
					fields: [
						{
							key: "tone",
							label: "Tone",
							kind: "select",
							options: ["modern", "playful"],
							required: true,
						},
						{
							key: "audience",
							label: "Audience",
							kind: "text",
						},
					],
				},
				timestamp: Date.now(),
				cardType: "design-brief",
				invocationId: TOOL_CALL_ID,
			},
		});

		// Card mounts.
		await expect(page.getByTestId("design-brief-card")).toBeVisible({ timeout: 3000 });
		await expect(page.getByTestId("design-brief-form")).toBeVisible();

		// Per-kind input rendering.
		const toneSelect = page.getByTestId("design-brief-select-tone");
		const audienceText = page.getByTestId("design-brief-text-audience");
		await expect(toneSelect).toBeVisible();
		await expect(audienceText).toBeVisible();
		expect(await toneSelect.evaluate((el) => el.tagName)).toBe("SELECT");
		expect(await audienceText.evaluate((el) => el.tagName)).toBe("TEXTAREA");

		// Submit without required `tone` → form blocked, error shown,
		// no fetch fired.
		await page.getByTestId("design-brief-submit").click();
		await expect(page.getByTestId("design-brief-error")).toBeVisible();
		expect(captured.length).toBe(0);

		// Retry restores the editable form after its validation error.
		await page.getByTestId("design-brief-retry").click();
		await expect(page.getByTestId("design-brief-error")).toBeHidden();

		// Fill the required select and optional text, then submit.
		await toneSelect.selectOption("modern");
		await audienceText.fill("developers");
		await page.getByTestId("design-brief-submit").click();

		await expect.poll(() => captured.length, { timeout: 3000 }).toBeGreaterThan(0);
		const sent = captured[0]!;
		expect(sent.url).toContain(
			"/api/extensions/claude-design/events/brief-answer",
		);
		const body = sent.body as {
			toolCallId: string;
			conversationId: string;
			answer: { tone?: string; audience?: string };
		};
		expect(body.toolCallId).toBe(TOOL_CALL_ID);
		expect(body.conversationId).toBe("conv-1");
		expect(body.answer.tone).toBe("modern");
		expect(body.answer.audience).toBe("developers");
	});

	test("after answer submit, a follow-on generate-design tool-call card renders", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// The mock models the streamed follow-up after the answer POST.
		// This checks browser state; real gate execution is a runtime test.
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.route(
			"**/api/extensions/claude-design/events/brief-answer",
			async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: true }),
				});
			},
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Send a vague prompt to nudge the agent into clarify-brief
		// territory (mocked — no real agent runs in e2e).
		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes("/messages") && r.request().method() === "POST",
			),
			sendComposerMessage(page, "make me a page"),
		]);

		// Stream clarify-brief tool start.
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__clarify-brief",
				input: {
					fields: [{ key: "tone", label: "Tone", kind: "text" }],
				},
				timestamp: Date.now(),
				cardType: "design-brief",
				invocationId: TOOL_CALL_ID,
			},
		});
		await expect(page.getByTestId("design-brief-card")).toBeVisible({
			timeout: 3000,
		});

		// Fill + submit.
		await page
			.getByTestId("design-brief-text-tone")
			.fill("modern, refined-minimal");
		await Promise.all([
			page.waitForResponse(response => response.url().endsWith("/api/extensions/claude-design/events/brief-answer") && response.request().method() === "POST"),
			page.getByTestId("design-brief-submit").click(),
		]);

		// Simulate the runtime path: brief-answer resolves the gate, the
		// extension's clarify-brief tool returns, then the agent calls
		// generate-design.
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__clarify-brief",
				invocationId: TOOL_CALL_ID,
				output: {
					content: [
						{ type: "text", text: JSON.stringify({ tone: "modern" }) },
					],
				},
				timestamp: Date.now(),
			},
		});
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__generate-design",
				input: {
					prompt: "modern landing page",
					kind: "page",
					bodyMarkup: "<main>...</main>",
				},
				timestamp: Date.now(),
				invocationId: "tc-gen-1",
			},
		});

		// Pin: the brief card flips to the answered/summary surface, AND
		// the follow-on tool-call surface for generate-design appears.
		await expect(page.getByTestId("design-brief-summary")).toBeVisible({
			timeout: 3000,
		});
		// generate-design has no specific card type; it surfaces via the
		// generic tool-call list. Match by visible toolName text.
		await expect(
			page.getByText(/generate-design/i).first(),
		).toBeVisible({ timeout: 3000 });
	});
});
