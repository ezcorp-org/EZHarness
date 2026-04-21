import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Permission Mode", () => {
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
		content: "Hi there!",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	test("permission mode indicator shows on chat page", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const indicator = page.getByTitle(/Permission mode/);
		await expect(indicator).toBeVisible();
		await expect(indicator).toContainText("Ask");
		await expect(indicator.locator("span.rounded-full.bg-red-500")).toBeVisible();
	});

	test("mode dropdown opens and shows all 3 options", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTitle(/Permission mode/).click();

		// Verify all three options are visible with their descriptions
		await expect(page.getByText("Ask", { exact: true }).last()).toBeVisible();
		await expect(page.getByText("Ask before running dangerous tools")).toBeVisible();

		await expect(page.getByText("Auto-edit", { exact: true })).toBeVisible();
		await expect(page.getByText("Auto-approve edits, ask for shell commands")).toBeVisible();

		await expect(page.getByText("YOLO", { exact: true })).toBeVisible();
		await expect(page.getByText("Auto-approve everything")).toBeVisible();

		// Verify color dots exist in the dropdown
		const dropdown = page.locator(".absolute.right-0");
		await expect(dropdown.locator("span.bg-red-500")).toBeVisible();
		await expect(dropdown.locator("span.bg-yellow-500")).toBeVisible();
		await expect(dropdown.locator("span.bg-green-500")).toBeVisible();
	});

	test("switching mode updates indicator", async ({ page, mockApi }) => {
		let capturedBody: Record<string, unknown> | null = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"tool-permission-mode": (url) => {
					return { mode: "ask" };
				},
			},
		});

		// Intercept the PUT request to capture the body
		await page.route("**/api/projects/*/tool-permission-mode", async (route) => {
			if (route.request().method() === "PUT") {
				capturedBody = route.request().postDataJSON();
				await route.fulfill({ json: { ok: true } });
			} else {
				await route.fallback();
			}
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const indicator = page.getByTitle(/Permission mode/);
		await indicator.click();
		await page.getByText("YOLO", { exact: true }).click();

		// Verify the indicator updated
		await expect(indicator).toContainText("YOLO");
		await expect(indicator.locator("span.rounded-full.bg-green-500")).toBeVisible();

		// Verify the PUT request was sent with the correct mode
		expect(capturedBody).toEqual({ mode: "yolo" });
	});

	test("permission mode persists on refresh", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"tool-permission-mode": () => ({ mode: "auto-edit" }),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const indicator = page.getByTitle(/Permission mode/);
		await expect(indicator).toContainText("Auto-edit");
		await expect(indicator.locator("span.rounded-full.bg-yellow-500")).toBeVisible();
	});

	test("permission gate shows on tool:permission_request WS event", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Send a message to trigger streaming (sets up streamingRunToConversation)
		const textarea = page.locator("textarea");
		await textarea.fill("Do something");
		await textarea.press("Enter");

		// Wait for the message POST to complete, which returns runId "run-stream"
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		// Emit run:start to set up the streaming run-to-conversation mapping
		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "thinking..." },
		});

		// Emit permission request
		await emitWs({
			type: "tool:permission_request",
			data: {
				conversationId: "conv-1",
				toolCallId: "tc-1",
				toolName: "Bash",
				input: { command: "rm -rf /" },
				cardType: "terminal",
				category: "shell",
			},
		});

		// Verify the PermissionGate card appears
		await expect(page.getByText("Bash")).toBeVisible();
		await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
	});

	test("allow button sends approval", async ({ page, mockApi, emitWs }) => {
		let capturedApproval: Record<string, unknown> | null = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		await page.route("**/api/tool-calls/*/permission", async (route) => {
			if (route.request().method() === "POST") {
				capturedApproval = route.request().postDataJSON();
				await route.fulfill({ json: { ok: true } });
			} else {
				await route.fallback();
			}
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Trigger streaming
		const textarea = page.locator("textarea");
		await textarea.fill("Do something");
		await textarea.press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "thinking..." },
		});

		await emitWs({
			type: "tool:permission_request",
			data: {
				conversationId: "conv-1",
				toolCallId: "tc-1",
				toolName: "Bash",
				input: { command: "echo hello" },
				category: "shell",
			},
		});

		await page.getByRole("button", { name: "Allow" }).click();

		expect(capturedApproval).toEqual({ approved: true });
	});

	test("permission gate restores after page refresh", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({
					runId: "run-pending",
					status: "running",
					partialResponse: null,
					pendingPermissions: [{
						conversationId: "conv-1",
						toolCallId: "tc-refresh-1",
						toolName: "shell",
						input: { command: "ls -la" },
						cardType: "terminal",
						category: "execute",
					}],
				}),
				"tool-permission-mode": () => ({ mode: "ask" }),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Verify the PermissionGate card appears from restored pending permissions
		await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
	});

	test("switching mode during active run sends conversationId", async ({ page, mockApi }) => {
		let capturedBody: Record<string, unknown> | null = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({
					runId: "run-active",
					status: "running",
					partialResponse: null,
					pendingPermissions: [],
				}),
				"tool-permission-mode": () => ({ mode: "ask" }),
			},
		});

		// Intercept the PUT request to capture the body
		await page.route("**/api/projects/*/tool-permission-mode", async (route) => {
			if (route.request().method() === "PUT") {
				capturedBody = route.request().postDataJSON();
				await route.fulfill({ json: { ok: true } });
			} else {
				await route.fallback();
			}
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const indicator = page.getByTitle(/Permission mode/);
		await indicator.click();
		await page.getByText("YOLO", { exact: true }).click();

		// Verify the PUT body includes the conversationId
		expect(capturedBody).toMatchObject({ conversationId: "conv-1" });
	});

	test("allow on restored permission gate sends correct toolCallId", async ({ page, mockApi }) => {
		let capturedApproval: Record<string, unknown> | null = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({
					runId: "run-pending",
					status: "running",
					partialResponse: null,
					pendingPermissions: [{
						conversationId: "conv-1",
						toolCallId: "tc-refresh-1",
						toolName: "shell",
						input: { command: "ls -la" },
						cardType: "terminal",
						category: "execute",
					}],
				}),
				"tool-permission-mode": () => ({ mode: "ask" }),
			},
		});

		await page.route("**/api/tool-calls/tc-refresh-1/permission", async (route) => {
			if (route.request().method() === "POST") {
				capturedApproval = route.request().postDataJSON();
				await route.fulfill({ json: { ok: true } });
			} else {
				await route.fallback();
			}
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByRole("button", { name: "Allow" }).click();

		expect(capturedApproval).toEqual({ approved: true });
	});

	test("deny button sends denial", async ({ page, mockApi, emitWs }) => {
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

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Trigger streaming
		const textarea = page.locator("textarea");
		await textarea.fill("Do something");
		await textarea.press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "thinking..." },
		});

		await emitWs({
			type: "tool:permission_request",
			data: {
				conversationId: "conv-1",
				toolCallId: "tc-1",
				toolName: "Bash",
				input: { command: "echo hello" },
				category: "shell",
			},
		});

		await page.getByRole("button", { name: "Deny" }).click();

		expect(capturedDenial).toEqual({ approved: false });
	});
});
