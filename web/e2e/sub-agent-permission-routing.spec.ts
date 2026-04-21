import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

/**
 * E2E coverage for the sub-agent permission routing bug fix.
 *
 * Bug: when a sub-agent (child agent invoked from a parent conversation)
 * triggers a tool that requires permission, the approval prompt used to be
 * lost because the UI only tracked root conversations in
 * `streamingRunToConversation`. The fix
 * (web/src/lib/sub-agent-routing.ts + stores.svelte.ts) maintains a map from
 * sub-conversation IDs back to the root runId so sub-agent tool events
 * surface in the parent conversation's UI.
 *
 * These E2E tests verify the DOM-level outcome: a `tool:permission_request`
 * addressed to a SUB-conversation id flips a tool call in the parent chat
 * into a PermissionGate with working Allow/Deny buttons.
 *
 * Exhaustive coverage of the routing logic itself (empty state, nested
 * sub-agents at depth 2/3, cleanup on agent:complete, warning fallbacks,
 * concurrent siblings, update-in-place vs. create-new branches) lives in
 * `web/src/__tests__/permission-routing-integration.test.ts`.
 *
 * Note on the event sequence: we fire `tool:start` against the parent
 * conversation to get a `tool_ref` block into the parent's content-block
 * stream (so a ToolCallCard renders in the DOM), then fire
 * `tool:permission_request` against the sub-conversation id. The routing
 * layer resolves the sub id back to the parent run, the handler finds the
 * existing running call with the matching tool name, and flips it to
 * `permissionPending: true` — at which point ToolCardRouter re-derives the
 * component to PermissionGate. Before the fix, the permission lookup
 * silently dropped the event with a "Could not resolve root run" warning.
 */

test.describe("Sub-Agent Permission Routing", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Parent Chat" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Hello",
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Hi there!",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	/**
	 * Shared setup: navigate to the parent conversation, send a user message
	 * (which drives `startStreaming("run-stream", "conv-1")` client-side),
	 * spawn a sub-agent, then kick off a tool on the parent run so a
	 * ToolCallCard is actually mounted in the DOM.
	 *
	 * After this helper returns:
	 *   - streamingRunToConversation: { "run-stream": "conv-1" }
	 *   - sub-agent routing map:      { "sub-1": "run-stream" }
	 *   - streamingToolCalls["run-stream"] has a running "Bash" call
	 *   - a ToolCallCard for that call is rendered in the parent chat UI
	 */
	async function setupParentChatWithSubAgent(
		page: Page,
		emitWs: (event: { type: string; data: unknown }) => Promise<void>,
		opts: { toolName?: string } = {},
	) {
		const toolName = opts.toolName ?? "Bash";
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Send a user message. The mocked POST /messages endpoint returns
		// runId "run-stream", which causes the frontend to call startStreaming
		// and register { "run-stream": "conv-1" } in streamingRunToConversation.
		// Clicking the Send button is more reliable than press("Enter") across
		// parallel workers — matches the pattern used in multi-agent.spec.ts.
		const textarea = page.locator("textarea");
		await textarea.fill("Delegate to a sub-agent");
		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes("/messages") && r.request().method() === "POST",
			),
			page.getByRole("button", { name: "Send message" }).click(),
		]);
		await expect(page.getByText("Delegate to a sub-agent")).toBeVisible({ timeout: 5000 });

		// A token so the content-block builder has some text and the assistant
		// bubble exists in the DOM.
		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "Delegating..." },
		});

		// Spawn a sub-agent. This registers sub-1 → run-stream in the
		// sub-agent routing map via registerSpawn().
		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "Research something",
				agentRunId: "agent-run-1",
			},
		});

		// Sanity: the agent chip must appear — this proves the spawn event
		// was handled AND the routing map is populated.
		await expect(page.locator(".agent-chip")).toBeVisible({ timeout: 5000 });

		// Start a tool on the parent run. This pushes a tool_ref into the
		// parent's content blocks so a ToolCallCard is mounted in the DOM.
		// Without this step the permission update would only touch store
		// state — there'd be no DOM to assert against.
		//
		// We pass a cardType so ToolCallCard delegates to ToolCardRouter
		// (the DefaultCard inline template in ToolCallCard.svelte has no
		// notion of `permissionPending` — only ToolCardRouter flips to
		// PermissionGate when that flag is set). "terminal" is a valid
		// cardType and lets the `$` prompt render as a recognisable anchor.
		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName,
				input: { command: "echo setup" },
				timestamp: Date.now(),
				category: "shell",
				cardType: "terminal",
			},
		});

		// Wait for the terminal card to render before firing the permission
		// event. The terminal card shows the `$ echo setup` prompt line.
		await expect(page.getByText("echo setup")).toBeVisible({ timeout: 5000 });
	}

	test("permission request addressed to sub-conversation flips tool card to PermissionGate", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		// Capture console warnings so we can assert the handler did NOT emit
		// the orphan-routing warning that signals the bug regressed.
		const warnings: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "warning") warnings.push(msg.text());
		});

		await setupParentChatWithSubAgent(page, emitWs);

		// Before the permission event, there should be no Allow/Deny buttons.
		await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);

		// Fire the permission request with conversationId = "sub-1" (the
		// SUB-conversation, not "conv-1"). Before the fix this was silently
		// dropped. After the fix, sub-agent-routing.ts walks sub-1 → run-stream
		// and the handler flips the existing running Bash call in place.
		await emitWs({
			type: "tool:permission_request",
			data: {
				conversationId: "sub-1",
				toolCallId: "tc-sub-1",
				toolName: "Bash",
				input: { command: "echo setup" },
				category: "shell",
				cardType: "terminal",
			},
		});

		// The ToolCallCard should now re-derive to PermissionGate.
		await expect(page.getByRole("button", { name: "Allow" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();

		// The handler should NOT have emitted the routing-failure warning. We
		// look for the specific "Could not resolve root run" string so
		// unrelated warnings don't cause flakes.
		const routingFailures = warnings.filter((w) => w.includes("Could not resolve root run"));
		expect(routingFailures).toEqual([]);
	});

	test("Allow on sub-agent permission gate sends approval with correct toolCallId", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		let capturedUrl: string | null = null;
		let capturedApproval: Record<string, unknown> | null = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		await page.route("**/api/tool-calls/*/permission", async (route) => {
			if (route.request().method() === "POST") {
				capturedUrl = route.request().url();
				capturedApproval = route.request().postDataJSON();
				await route.fulfill({ json: { ok: true } });
			} else {
				await route.fallback();
			}
		});

		await setupParentChatWithSubAgent(page, emitWs);

		await emitWs({
			type: "tool:permission_request",
			data: {
				conversationId: "sub-1",
				toolCallId: "tc-sub-allow",
				toolName: "Bash",
				input: { command: "echo setup" },
				category: "shell",
				cardType: "terminal",
			},
		});

		await page.getByRole("button", { name: "Allow" }).click();

		expect(capturedApproval).toEqual({ approved: true });
		// The POST must target the toolCallId carried in the permission-request
		// payload — proving the card rendered was the one wired by the routing
		// path (not some stale or re-keyed one).
		expect(capturedUrl).toContain("/api/tool-calls/tc-sub-allow/permission");
	});

	test("Deny on sub-agent permission gate sends denial", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		let capturedDenial: Record<string, unknown> | null = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		await page.route("**/api/tool-calls/*/permission", async (route) => {
			if (route.request().method() === "POST") {
				capturedDenial = route.request().postDataJSON();
				await route.fulfill({ json: { ok: true } });
			} else {
				await route.fallback();
			}
		});

		await setupParentChatWithSubAgent(page, emitWs);

		await emitWs({
			type: "tool:permission_request",
			data: {
				conversationId: "sub-1",
				toolCallId: "tc-sub-deny",
				toolName: "Bash",
				input: { command: "echo setup" },
				category: "shell",
				cardType: "terminal",
			},
		});

		await page.getByRole("button", { name: "Deny" }).click();

		expect(capturedDenial).toEqual({ approved: false });
	});
});
