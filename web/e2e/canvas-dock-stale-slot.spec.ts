/**
 * A delayed authoritative tool-history response may remove a live dock call.
 * The dock must then clear its slot so the app layout also releases its
 * desktop right padding; a user dismissal is not involved in this path.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { sendComposerMessage } from "./fixtures/composer.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const project = makeProject({ id: "proj-1", name: "Test Project" });
const conversation = makeConversation({ id: "conv-1", projectId: project.id, title: "Test" });
const userMessage = makeMessage({ id: "m1", conversationId: conversation.id, role: "user", content: "Hello" });
const assistantMessage = makeMessage({
	id: "m2",
	conversationId: conversation.id,
	role: "assistant",
	content: "Sure",
	parentMessageId: userMessage.id,
	createdAt: "2026-01-01T00:01:00.000Z",
});

test.describe("Canvas dock — stale authoritative removal", () => {
	test("an absent dock call clears the dock slot and releases desktop padding @evidence", async ({ page, mockApi, emitSse, isMobile }, testInfo) => {
		await mockApi({
			projects: [project],
			conversations: [conversation],
			messages: [userMessage, assistantMessage],
		});

		const initialHydration = page.waitForResponse((response) =>
			response.url().includes("/api/conversations/conv-1/messages?withToolCalls=true"),
		);
		await page.goto(`/project/${project.id}/chat/${conversation.id}`);
		await initialHydration;
		await sendComposerMessage(page, "Open the planning canvas");

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: conversation.id,
				extensionId: "claude-design",
				toolName: "claude-design__open-canvas",
				input: { draftId: "d-1" },
				timestamp: Date.now(),
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-stale-dock",
			},
		});
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: conversation.id,
				extensionId: "claude-design",
				toolName: "claude-design__open-canvas",
				output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/preview.html" }) }] },
				duration: 50,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-stale-dock",
			},
		});

		await expect(page.getByTestId("dock-host")).toBeVisible();
		await expect(page.getByRole("main")).toHaveCSS("padding-right", isMobile ? "0px" : "640px");

		let resolveAuthoritativeHydration: (() => void) | undefined;
		const authoritativeHydration = new Promise<void>((resolve) => { resolveAuthoritativeHydration = resolve; });
		await page.route("**/api/conversations/conv-1/messages?withToolCalls=true", async (route) => {
			await route.fulfill({
				json: {
					messages: [userMessage, assistantMessage],
					orphanedToolCalls: [{
						id: "stale-removal-sentinel",
						extensionId: "builtin",
						toolName: "stale-removal-sentinel",
						input: {},
						outputSummary: "hydrated",
						success: true,
						durationMs: 1,
						status: "success",
					}],
					},
			});
			resolveAuthoritativeHydration?.();
		});
		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("ez:agent_complete", {
				detail: { parentConversationId: "conv-1" },
			}));
		});
		await authoritativeHydration;
		await expect(page.getByRole("button", { name: /stale-removal-sentinel/ })).toBeVisible();
		await expect(page.getByTestId("dock-host")).toHaveCount(0);
		await expect(page.getByRole("main")).toHaveCSS("padding-right", "0px");
		await captureEvidence(page, testInfo, "canvas-dock-stale-slot-cleared");
	});
});
