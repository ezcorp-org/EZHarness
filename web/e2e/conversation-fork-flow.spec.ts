import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Conversation fork flow → sidebar live update", () => {
	const proj = makeProject({ id: "proj-fork-1", name: "Fork Flow Project" });
	const conv = makeConversation({
		id: "conv-fork-src",
		projectId: "proj-fork-1",
		title: "Source Chat",
		updatedAt: "2026-04-01T00:10:00.000Z",
	});

	function seedTurns() {
		const m1 = makeMessage({
			id: "msg-fork-1",
			conversationId: "conv-fork-src",
			role: "user",
			content: "Where do birds go in winter?",
			createdAt: "2026-04-01T00:00:00.000Z",
		});
		const m2 = makeMessage({
			id: "msg-fork-2",
			conversationId: "conv-fork-src",
			role: "assistant",
			content: "Many migrate; some stay and adapt.",
			parentMessageId: "msg-fork-1",
			createdAt: "2026-04-01T00:01:00.000Z",
		});
		const m3 = makeMessage({
			id: "msg-fork-3",
			conversationId: "conv-fork-src",
			role: "user",
			content: "Tell me about hummingbirds.",
			parentMessageId: "msg-fork-2",
			createdAt: "2026-04-01T00:02:00.000Z",
		});
		return [m1, m2, m3];
	}

	test("Select Mode → New Chat: forks the conversation and the sidebar updates without reload", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: seedTurns(),
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Source chat renders. Anchor the assertion to the message body so we
		// don't trip over the conversation title showing in the chat header.
		await expect(page.getByText("Where do birds go in winter?")).toBeVisible();

		// Enter select mode via the Select toggle in the chat toolbar — same
		// data-testid used by chat-select-mode.spec.ts.
		await page.getByTestId("select-mode-toggle").click();
		await expect(page.getByTestId("select-action-bar")).toBeVisible();

		// Tick the first user/assistant pair (matches what a real fork would
		// usually contain — at least one user turn).
		await page.getByTestId("select-checkbox-msg-fork-1").click();
		await page.getByTestId("select-checkbox-msg-fork-2").click();
		await expect(page.getByTestId("selected-count")).toHaveText("2");

		// Trigger the fork.
		await page.getByTestId("new-chat-from-selection").click();

		// The mock returns id "cloned-conv" for clone-turns POSTs.
		await page.waitForURL(
			new RegExp(`/project/${proj.id}/chat/cloned-conv$`),
		);

		// ── Critical: the sidebar must reflect the new fork without a reload.
		// If `host.convList()?.refresh?.()` regresses, the new fork row won't
		// appear here and this whole block fails.
		const sidebar = page.locator("div.md\\:w-\\[280px\\]").first();
		await expect(sidebar).toBeVisible();

		// New fork row visible — title is "Forked: Source Chat" per the
		// clone-turns mock fallback.
		await expect(
			sidebar.getByText(/^Forked:/).first(),
		).toBeVisible();

		// Parent row is grouped — chevron is present, defaulting to expanded.
		await expect(
			sidebar.getByRole("button", { name: "Collapse forks" }),
		).toBeVisible();

		// Fork row steps in to pl-10 (past the parent's pl-7 chevron gutter).
		// The `↳` glyph lives next to the title inside the same button, so
		// target by row content.
		const forkBtn = sidebar
			.locator("button", { hasText: "Forked:" })
			.first();
		await expect(forkBtn).toHaveClass(/\bpl-10\b/);

		// And the connector glyph is rendered (aria-hidden span, hasText "↳").
		await expect(
			sidebar.locator("span[aria-hidden='true']", { hasText: "↳" }),
		).toHaveCount(1);

		// Parent row reserves the chevron gutter but is NOT extra-indented —
		// this catches a regression where the fork-grouping logic falls back
		// to flat rendering.
		const parentBtn = sidebar
			.locator("button", { hasText: "Source Chat" })
			.first();
		await expect(parentBtn).toHaveClass(/\bpl-7\b/);
		await expect(parentBtn).not.toHaveClass(/\bpl-10\b/);
	});
});
