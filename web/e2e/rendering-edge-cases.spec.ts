import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Rendering Edge Cases", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });
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
		content: "Sure!",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	/** Navigate to chat, send a message, and emit run:token to set up streaming */
	async function setupStreaming(page: any, mockApi: any, emitWs: any) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea");
		await textarea.fill("Do something");
		await textarea.press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "Working..." },
		});
	}

	// --- Extension edge cases ---

	test("extension page loads with minimal manifest", async ({ page, mockApi }) => {
		await mockApi({
			routes: {
				"/api/extensions": () => [
					{
						id: "ext-1",
						name: "minimal-ext",
						version: "0.1.0",
						description: "Minimal extension",
						enabled: true,
						source: "local",
						consecutiveFailures: 0,
						manifest: { schemaVersion: 2 },
						grantedPermissions: {},
					},
				],
			},
		});

		await page.goto("/extensions");

		// Page renders without crash
		await expect(page.getByText("minimal-ext")).toBeVisible();
		// Shows "0 tools" since manifest has no tools field
		await expect(page.getByText("0 tools")).toBeVisible();
	});

	test("extension detail page loads with empty tools", async ({ page, mockApi }) => {
		await mockApi({
			routes: {
				"/api/extensions/ext-1": () => ({
					id: "ext-1",
					name: "empty-tools-ext",
					version: "1.0.0",
					description: "Extension with empty tools",
					enabled: true,
					source: "local",
					installPath: "/tmp/ext",
					checksumVerified: false,
					consecutiveFailures: 0,
					manifest: {
						entrypoint: "index.js",
						tools: [],
						permissions: {},
						schemaVersion: 2,
					},
					grantedPermissions: { grantedAt: {} },
					createdAt: "2026-01-01T00:00:00.000Z",
				}),
			},
		});

		await page.goto("/extensions/ext-1");

		// Page renders without crash
		await expect(page.getByText("empty-tools-ext")).toBeVisible();
		// Shows "No tools defined" message
		await expect(page.getByText("No tools defined")).toBeVisible();
	});

	test("extension page loads with missing permissions", async ({ page, mockApi }) => {
		await mockApi({
			routes: {
				"/api/extensions": () => [
					{
						id: "ext-2",
						name: "no-perms-ext",
						version: "1.0.0",
						description: "Extension without permissions",
						enabled: true,
						source: "local",
						consecutiveFailures: 0,
						manifest: {
							tools: [{ name: "analyze", description: "Analyze code" }],
							schemaVersion: 2,
						},
						grantedPermissions: {},
					},
				],
			},
		});

		await page.goto("/extensions");

		// Page renders without crash
		await expect(page.getByText("no-perms-ext")).toBeVisible();
		// Tool count shows correctly
		await expect(page.getByText("1 tool")).toBeVisible();
		// No permission badges (network, filesystem, shell, env) should show
		await expect(page.locator("span[title='network']")).not.toBeVisible();
		await expect(page.locator("span[title='filesystem']")).not.toBeVisible();
		await expect(page.locator("span[title='shell']")).not.toBeVisible();
		await expect(page.locator("span[title='env']")).not.toBeVisible();
	});

	// --- Tool call rendering edge cases ---

	test("multiple tool calls with same name don't crash", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		// Emit two tool:start events for the same tool name with different implicit IDs
		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "shell",
				input: { command: "echo first" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "shell",
				input: { command: "echo second" },
				timestamp: Date.now() + 1,
				cardType: "terminal",
			},
		});

		// Both tool calls render without duplicate key errors
		await expect(page.getByText("echo first")).toBeVisible();
		await expect(page.getByText("echo second")).toBeVisible();
	});

	test("tool:permission_request after tool:start for same tool", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		// Emit tool:start first
		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "shell",
				input: { command: "rm -rf /tmp/test" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		// Then emit permission_request for the same tool
		await emitWs({
			type: "tool:permission_request",
			data: {
				conversationId: "conv-1",
				toolCallId: "tc-perm-1",
				toolName: "shell",
				input: { command: "rm -rf /tmp/test" },
				cardType: "terminal",
				category: "execute",
			},
		});

		// Permission gate should show without crash
		await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
	});

	test("tool calls with undefined id render correctly", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		// Emit tool:start without an id field (the store creates entries without id)
		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "Bash",
				input: { command: "echo no-id" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		// Emit tool:complete for the same tool
		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "no-id",
				duration: 50,
				success: true,
				cardType: "terminal",
			},
		});

		// Card renders with the command and output
		await expect(page.getByText("echo no-id")).toBeVisible();
		await expect(page.getByText("no-id")).toBeVisible();
	});
});
