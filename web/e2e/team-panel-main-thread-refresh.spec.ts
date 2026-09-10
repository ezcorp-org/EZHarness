import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * E2E regression test for: "When chatting privately with a team sub-agent
 * via the team panel, the main chat thread doesn't refresh until you
 * reload the page."
 *
 * Root cause was three-fold (see agent-chat/+server.ts and stores.svelte.ts):
 *   1. Server only emitted agent:spawn, never agent:complete
 *   2. agent:complete used the immediate parent's id, but team members
 *      are GRANDCHILDREN of the main conv (main → orchestrator → member)
 *      so the chat page listener (filtered by main convId) ignored it
 *   3. Even when the listener fired, the fetch-policy throttle suppressed
 *      the refetch within 5s of page load
 *
 * This e2e proves the fix end-to-end: a SSE `agent:complete` event with
 * the correct ROOT parentConversationId triggers the chat page to issue
 * fresh `/messages?all=true` and `/messages?withToolCalls=true` requests
 * WITHOUT a page refresh.
 */

const proj = makeProject({ id: "p1", name: "Team Refresh Project" });
const mainConv = makeConversation({ id: "main-conv", projectId: "p1", title: "Main chat" });

const userMsg = makeMessage({
	id: "msg-user-1",
	conversationId: "main-conv",
	role: "user",
	content: "Build me a thing",
	parentMessageId: null,
});
const asstMsg = makeMessage({
	id: "msg-asst-1",
	conversationId: "main-conv",
	role: "assistant",
	content: "Delegating to the team.",
	parentMessageId: "msg-user-1",
	createdAt: "2026-01-01T00:01:00.000Z",
});

test.describe("team panel chat → main thread auto-refresh", () => {
	test("agent:complete with parentConversationId=main triggers main-thread refetch", async ({ page, mockApi, emitSse }) => {

		// Track every messages-related GET so we can assert refetches happen.
		const messagesGets: string[] = [];
		page.on("request", (req) => {
			if (req.method() !== "GET") return;
			const u = req.url();
			if (u.includes("/api/conversations/main-conv/messages")) {
				messagesGets.push(u.replace(/^https?:\/\/[^/]+/, ""));
			}
		});

		await mockApi({
			projects: [proj],
			conversations: [mainConv],
			messages: [userMsg, asstMsg],
			subConversations: [{
				id: "orch-conv",
				agentName: "Team Orchestrator",
				agentConfigId: "team-cfg",
				parentMessageId: "msg-asst-1",
				parentConversationId: "main-conv",
			}],
			routes: {
				"active-run": () => ({ runId: null, status: null }),
				"/tasks": () => ({ conversationId: "main-conv", tasks: [] }),
			},
		});

		await page.goto(`/project/p1/chat/main-conv`, { waitUntil: "networkidle" });

		// Wait for initial messages to render so we know the listener has been
		// attached (it's set up in onMount) and the fetch-policy keys are
		// already populated by the initial load.
		await expect(page.getByText("Build me a thing")).toBeVisible({ timeout: 5000 });

		const beforeCount = messagesGets.length;

		// Simulate the user chatting with a TEAM MEMBER via the team panel.
		// In production this round-trips through agent-chat, which (post-fix)
		// emits agent:complete with parentConversationId = ROOT (main-conv)
		// even though the sub-conv's direct parent is the orchestrator.
		await emitSse({
			type: "agent:complete",
			data: {
				runId: "run-private-1",
				agentRunId: "run-private-1",
				subConversationId: "member-conv",
				agentName: "MemberAgent",
				agentConfigId: "member-cfg",
				success: true,
				resultPreview: "Member finished the task",
				parentConversationId: "main-conv", // <-- the critical field
			},
		});

		// Within a short window, the chat page listener must have invalidated
		// the fetch-policy throttle and triggered fresh GETs for both
		// /messages?all=true and /messages?withToolCalls=true.
		await expect.poll(
			() => {
				const fresh = messagesGets.slice(beforeCount);
				const hasAll = fresh.some(u => u.includes("messages") && u.includes("all=true"));
				const hasTools = fresh.some(u => u.includes("messages") && u.includes("withToolCalls=true"));
				return hasAll && hasTools;
			},
			{ timeout: 3000, message: "main thread did not refetch after agent:complete" },
		).toBe(true);
	});

	test("agent:complete for a DIFFERENT conversation does NOT refetch the current chat", async ({ page, mockApi, emitSse }) => {

		const messagesGets: string[] = [];
		page.on("request", (req) => {
			if (req.method() !== "GET") return;
			if (req.url().includes("/api/conversations/main-conv/messages")) {
				messagesGets.push(req.url());
			}
		});

		await mockApi({
			projects: [proj],
			conversations: [mainConv],
			messages: [userMsg, asstMsg],
			routes: {
				"active-run": () => ({ runId: null, status: null }),
				"/tasks": () => ({ conversationId: "main-conv", tasks: [] }),
			},
		});

		await page.goto(`/project/p1/chat/main-conv`, { waitUntil: "networkidle" });
		await expect(page.getByText("Build me a thing")).toBeVisible({ timeout: 5000 });
		const beforeCount = messagesGets.length;

		// Emit agent:complete pointing at a DIFFERENT conv. The current
		// chat page must IGNORE it — otherwise we'd refresh every chat
		// page in the app whenever any sub-agent anywhere completed.
		await emitSse({
			type: "agent:complete",
			data: {
				runId: "run-other-1",
				subConversationId: "other-sub",
				agentName: "OtherAgent",
				agentConfigId: "other-cfg",
				success: true,
				resultPreview: "ok",
				parentConversationId: "different-main-conv", // not us!
			},
		});

		// Give the listener time to react. Then assert NO new fetches.
		await page.waitForTimeout(500);
		const after = messagesGets.slice(beforeCount);
		expect(
			after,
			`expected zero fetches for unrelated conv, got: ${after.join(", ")}`,
		).toHaveLength(0);
	});

	test("agent:complete with success=false ALSO refreshes (failed runs need to update UI too)", async ({ page, mockApi, emitSse }) => {

		const messagesGets: string[] = [];
		page.on("request", (req) => {
			if (req.method() !== "GET") return;
			if (req.url().includes("/api/conversations/main-conv/messages")) {
				messagesGets.push(req.url());
			}
		});

		await mockApi({
			projects: [proj],
			conversations: [mainConv],
			messages: [userMsg, asstMsg],
			routes: {
				"active-run": () => ({ runId: null, status: null }),
				"/tasks": () => ({ conversationId: "main-conv", tasks: [] }),
			},
		});

		await page.goto(`/project/p1/chat/main-conv`, { waitUntil: "networkidle" });
		await expect(page.getByText("Build me a thing")).toBeVisible({ timeout: 5000 });
		const beforeCount = messagesGets.length;

		await emitSse({
			type: "agent:complete",
			data: {
				runId: "run-failed-1",
				subConversationId: "member-conv",
				agentName: "MemberAgent",
				agentConfigId: "member-cfg",
				success: false,
				resultPreview: "model timeout",
				parentConversationId: "main-conv",
			},
		});

		await expect.poll(
			() => messagesGets.slice(beforeCount).length > 0,
			{ timeout: 3000 },
		).toBe(true);
	});

	test("multiple back-to-back agent:complete events all trigger refresh (not throttled)", async ({ page, mockApi, emitSse }) => {

		const messagesGets: string[] = [];
		page.on("request", (req) => {
			if (req.method() !== "GET") return;
			const u = req.url();
			if (u.includes("/api/conversations/main-conv/messages") && u.includes("all=true")) {
				messagesGets.push(u);
			}
		});

		await mockApi({
			projects: [proj],
			conversations: [mainConv],
			messages: [userMsg, asstMsg],
			routes: {
				"active-run": () => ({ runId: null, status: null }),
				"/tasks": () => ({ conversationId: "main-conv", tasks: [] }),
			},
		});

		await page.goto(`/project/p1/chat/main-conv`, { waitUntil: "networkidle" });
		await expect(page.getByText("Build me a thing")).toBeVisible({ timeout: 5000 });
		const beforeCount = messagesGets.length;

		// Emit two completes back-to-back. Both should trigger refresh —
		// the listener must invalidate the throttle EACH time.
		for (let i = 0; i < 2; i++) {
			await emitSse({
				type: "agent:complete",
				data: {
					runId: `run-${i}`,
					subConversationId: `member-${i}`,
					agentName: "MemberAgent",
					agentConfigId: "member-cfg",
					success: true,
					resultPreview: `done ${i}`,
					parentConversationId: "main-conv",
				},
			});
			await page.waitForTimeout(100);
		}

		await expect.poll(
			() => messagesGets.slice(beforeCount).length,
			{ timeout: 3000, message: "expected at least 2 refreshes for 2 completes" },
		).toBeGreaterThanOrEqual(2);
	});
});
