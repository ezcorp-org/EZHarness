import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeMemory } from "./fixtures/data.js";

// E2E coverage for the MemoriesCard block in chat + its deep-link to the Memories page.
// The backend already stores memoriesUsed inside runs.result.output — here we mock the
// API so message responses include the new memoriesUsed field on assistant messages.

test.describe("Memories Block", () => {
	const proj = makeProject({ id: "proj-mem", name: "Memory Block Project" });
	const conv = makeConversation({
		id: "conv-mem",
		projectId: "proj-mem",
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
	});

	const userMsg = makeMessage({
		id: "m-mem-user",
		conversationId: "conv-mem",
		role: "user",
		content: "What are my preferences?",
	});

	const memoriesUsed = [
		{ id: "mem-1", content: "User prefers dark mode", category: "preferences" },
		{ id: "mem-2", content: "Uses TypeScript with strict mode", category: "technical" },
	];

	// Assistant message with attached memoriesUsed (set by the server in attachMemoriesUsed).
	const assistantMsgWithMemories = {
		...makeMessage({
			id: "m-mem-assistant",
			conversationId: "conv-mem",
			role: "assistant",
			content: "Based on your preferences, here is the answer.",
			parentMessageId: "m-mem-user",
			createdAt: "2026-01-01T00:01:00.000Z",
		}),
		memoriesUsed,
	};

	const assistantMsgNoMemories = makeMessage({
		id: "m-mem-assistant-none",
		conversationId: "conv-mem",
		role: "assistant",
		content: "Plain response with no memory context.",
		parentMessageId: "m-mem-user",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	function messagesRoute(msgs: unknown[]) {
		return {
			[`/api/conversations/conv-mem/messages`]: (url: URL) => {
				if (url.searchParams.get("withToolCalls") === "true") {
					return {
						messages: (msgs as Array<Record<string, unknown>>).map((m) => ({ ...m, toolCalls: [] })),
						subConversations: [],
					};
				}
				return msgs;
			},
			"active-run": () => ({ runId: null }),
		};
	}

	test.describe("Render gating", () => {
		test("assistant message with memoriesUsed renders a collapsible Memories card", async ({
			page,
			mockApi,
		}) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsgWithMemories] as ReturnType<typeof makeMessage>[],
				routes: messagesRoute([userMsg, assistantMsgWithMemories]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			const memoriesButton = page.locator("button").filter({ hasText: "Memories" });
			await expect(memoriesButton).toBeVisible({ timeout: 5000 });
			// Collapsed count label
			await expect(page.getByText("2 memories")).toBeVisible();
			// Preview text from the first memory
			await expect(memoriesButton).toContainText("User prefers dark mode");
			// Assistant response still visible
			await expect(page.getByText("Based on your preferences, here is the answer.")).toBeVisible();
		});

		test("assistant message without memoriesUsed does NOT render a Memories card", async ({
			page,
			mockApi,
		}) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsgNoMemories],
				routes: messagesRoute([userMsg, assistantMsgNoMemories]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			// Response should render
			await expect(page.getByText("Plain response with no memory context.")).toBeVisible();
			// No Memories card anywhere
			await expect(page.locator("button").filter({ hasText: "Memories" })).not.toBeVisible();
		});

		test("assistant message with empty memoriesUsed array does NOT render the card", async ({
			page,
			mockApi,
		}) => {
			const empty = {
				...makeMessage({
					id: "m-mem-empty",
					conversationId: "conv-mem",
					role: "assistant",
					content: "Response with empty memories list.",
					parentMessageId: "m-mem-user",
				}),
				memoriesUsed: [] as typeof memoriesUsed,
			};
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, empty] as ReturnType<typeof makeMessage>[],
				routes: messagesRoute([userMsg, empty]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			await expect(page.getByText("Response with empty memories list.")).toBeVisible();
			await expect(page.locator("button").filter({ hasText: "Memories" })).not.toBeVisible();
		});
	});

	test.describe("Expand / collapse", () => {
		test("clicking Memories expands to show category-tagged list", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsgWithMemories] as ReturnType<typeof makeMessage>[],
				routes: messagesRoute([userMsg, assistantMsgWithMemories]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			const memoriesButton = page.locator("button").filter({ hasText: "Memories" });
			await expect(memoriesButton).toBeVisible({ timeout: 5000 });
			await memoriesButton.click();

			// Both memories with their categories should be visible in the expanded list.
			await expect(page.getByText("[preferences]").first()).toBeVisible();
			await expect(page.getByText("[technical]").first()).toBeVisible();
			await expect(page.getByText("User prefers dark mode").first()).toBeVisible();
			await expect(page.getByText("Uses TypeScript with strict mode")).toBeVisible();
		});

		test("Memories card renders above the response text (DOM order)", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsgWithMemories] as ReturnType<typeof makeMessage>[],
				routes: messagesRoute([userMsg, assistantMsgWithMemories]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			const memoriesBox = await page.locator("button").filter({ hasText: "Memories" }).boundingBox();
			const textBox = await page
				.getByText("Based on your preferences, here is the answer.")
				.boundingBox();
			expect(memoriesBox).toBeTruthy();
			expect(textBox).toBeTruthy();
			expect(memoriesBox!.y).toBeLessThan(textBox!.y);
		});
	});

	test.describe("Deep link to Memories page", () => {
		// The expanded list items are <a href="/memories?focus=<id>"> links. Clicking one
		// should navigate to the memories page and auto-expand that memory.
		const dbMemory = makeMemory({
			id: "mem-1",
			content: "User prefers dark mode",
			category: "preferences",
			projectId: "proj-mem",
		});
		const otherMemory = makeMemory({
			id: "mem-other",
			content: "Some other memory that should not be expanded",
			category: "technical",
			projectId: "proj-mem",
		});

		test("clicking a memory link navigates to /memories?focus=<id>", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsgWithMemories] as ReturnType<typeof makeMessage>[],
				memories: [dbMemory, otherMemory],
				routes: messagesRoute([userMsg, assistantMsgWithMemories]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			const memoriesButton = page.locator("button").filter({ hasText: "Memories" });
			await expect(memoriesButton).toBeVisible({ timeout: 5000 });
			await memoriesButton.click();

			// Click the first memory's link
			const link = page.getByRole("link", { name: /User prefers dark mode/ }).first();
			await expect(link).toHaveAttribute("href", "/memories?focus=mem-1");
			await link.click();

			await expect(page).toHaveURL(/\/memories\?focus=mem-1/);
		});

		test("focused memory auto-expands on the memories page", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				memories: [dbMemory, otherMemory],
			});
			// Navigate directly with the focus param — simulates clicking the link.
			await page.goto("/memories?focus=mem-1");

			// Preview text appears in both collapsed span + expanded <p> for the focused row,
			// so allow multiple matches. Use expansion-only markers to confirm auto-expand.
			await expect(page.getByText("User prefers dark mode").first()).toBeVisible({ timeout: 5000 });
			// Provenance section and Edit button only render when a row is expanded.
			await expect(page.getByText("Provenance")).toBeVisible({ timeout: 5000 });
			await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
		});

		test("non-focused memories stay collapsed on the memories page", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				memories: [dbMemory, otherMemory],
			});
			await page.goto("/memories?focus=mem-1");

			// Preview of the non-focused memory is visible (it's in the list)
			await expect(page.getByText("Some other memory that should not be expanded")).toBeVisible();
			// But only ONE Edit button should be present (for the auto-expanded mem-1)
			await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(1);
		});

		test("archived focused memory is still shown (bypasses default hide-archived filter)", async ({
			page,
			mockApi,
		}) => {
			const archived = makeMemory({
				id: "mem-archived",
				content: "Archived but focused memory",
				status: "archived",
				projectId: "proj-mem",
			});
			await mockApi({ projects: [proj], memories: [archived] });
			await page.goto("/memories?focus=mem-archived");

			// Normally "All" status + showArchived=false hides archived rows, but focused
			// memory must appear so the deep-link never lands on an empty page. The focused
			// row auto-expands, so the content text is present in both the collapsed span
			// and the expanded <p> — allow multiple matches.
			await expect(page.getByText("Archived but focused memory").first()).toBeVisible({ timeout: 5000 });
			await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
		});

		test("memories page with no focus param expands nothing automatically", async ({
			page,
			mockApi,
		}) => {
			await mockApi({ projects: [proj], memories: [dbMemory, otherMemory] });
			await page.goto("/memories");

			await expect(page.getByText("User prefers dark mode")).toBeVisible();
			// No Edit buttons (nothing expanded)
			await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
		});
	});

	test.describe("Streaming behavior", () => {
		test("Memories card does not appear during a streaming response", async ({
			page,
			mockApi,
			emitWs,
		}) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [],
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

			// Kick off a streaming turn
			const textarea = page.locator("textarea");
			await textarea.fill("Streaming turn");
			await Promise.all([
				page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST"),
				page.getByRole("button", { name: "Send message" }).click(),
			]);

			await emitWs({
				type: "run:token",
				data: { runId: "run-stream", token: "streaming...", kind: "text" },
			});
			await expect(page.getByText("streaming...")).toBeVisible({ timeout: 5000 });

			// Memories card is gated on `hasMemories && !isStreaming` — should be absent here.
			await expect(page.locator("button").filter({ hasText: "Memories" })).not.toBeVisible();
		});
	});
});
