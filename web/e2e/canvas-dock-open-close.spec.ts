/** Canvas dock browser coverage for live SSE and persisted hydration. */
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Hello" });
const assistantMsg = makeMessage({
	id: "m2",
	conversationId: "conv-1",
	role: "assistant",
	content: "Sure",
	parentMessageId: "m1",
	createdAt: "2026-01-01T00:01:00.000Z",
});
const payload = {
	draftId: "d-1",
	iframeSrc: "/api/extensions/claude-design/data/preview.html",
	knobsTitle: "Design controls",
	knobs: [
		{ key: "primaryColor", label: "Primary color", kind: "color", current: "#4f46e5" },
		{ key: "secondaryColor", label: "Secondary color", kind: "color", current: "#0ea5e9" },
		{ key: "spacingScale", label: "Spacing scale", kind: "range", behavior: "scale-spacing", min: -25, max: 50, step: 5, unit: "%", current: "0" },
		{ key: "borderRadius", label: "Border radius", kind: "range", min: 0, max: 24, step: 2, unit: "px", current: "12" },
		{ key: "density", label: "Density", kind: "select", options: ["compact", "cozy", "spacious"], current: "cozy" },
	],
	knobValues: { primaryColor: "#4f46e5", secondaryColor: "#0ea5e9", spacingScale: "+0%", borderRadius: "12px", density: "cozy" },
};

async function routePreview(page: Page): Promise<void> {
	await page.route("**/api/extensions/claude-design/data/preview.html", (route) => route.fulfill({
		contentType: "text/html",
		body: `<!doctype html><html><body style="margin:0;background:#f8fafc;font:16px system-ui;color:#172033"><main style="padding:48px"><p style="color:#6366f1;font-weight:700">CLAUDE DESIGN</p><h1>Quarterly planning canvas</h1><p>Move the controls to refine spacing, color, and density.</p></main></body></html>`,
	}));
}

async function assertDock(page: Page): Promise<void> {
	await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 3000 });
	await expect(page.getByTestId("dock-open-pill").first()).toBeVisible();
	await expect(page.getByTestId("knob-primaryColor")).toHaveValue("#4f46e5");
	await expect(page.getByTestId("knob-density")).toHaveValue("cozy");
	await expect(page.getByLabel("modified")).toHaveCount(0);
}

async function assertCanvasThemeTokens(page: Page): Promise<void> {
	const colors = await page.getByRole("complementary", { name: "Preview controls" }).evaluate((sidebar) => {
		const probe = document.createElement("div");
		probe.style.background = "var(--color-surface-secondary)";
		probe.style.color = "var(--color-text-primary)";
		document.body.append(probe);
		const expected = getComputedStyle(probe);
		const actualHeader = getComputedStyle(sidebar.querySelector("header")!);
		const result = {
			background: getComputedStyle(sidebar).backgroundColor,
			expectedBackground: expected.backgroundColor,
			header: actualHeader.color,
			expectedHeader: expected.color,
		};
		probe.remove();
		return result;
	});
	expect(colors.background).toBe(colors.expectedBackground);
	expect(colors.header).toBe(colors.expectedHeader);
}

test.describe("Canvas Dock — live open and persisted restore", () => {
	test("live SSE tool completion opens the dock and renders its opaque iframe @evidence", async ({ page, mockApi, emitSse }, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		let releaseInitialToolHydration: (() => void) | undefined;
		let initialToolHydrationStarted: (() => void) | undefined;
		let releaseLaterToolHydrations: (() => void) | undefined;
		let toolHydrationCount = 0;
		const initialToolHydration = new Promise<void>((resolve) => {
			initialToolHydrationStarted = resolve;
		});
		const releaseInitialToolHydrationPromise = new Promise<void>((resolve) => {
			releaseInitialToolHydration = resolve;
		});
		const releaseLaterToolHydrationsPromise = new Promise<void>((resolve) => {
			releaseLaterToolHydrations = resolve;
		});
		await page.route("**/api/conversations/conv-1/messages?withToolCalls=true", async (route) => {
			toolHydrationCount++;
			if (toolHydrationCount === 1) {
				initialToolHydrationStarted?.();
				await releaseInitialToolHydrationPromise;
			} else {
				await releaseLaterToolHydrationsPromise;
			}
			const completedToolCall = toolHydrationCount === 1 ? [] : [{
				id: "tc-dock-live",
				extensionId: "claude-design",
				toolName: "claude-design__open-canvas",
				input: { draftId: "d-1" },
				outputSummary: "Canvas ready",
				fullOutput: JSON.stringify(payload),
				success: true,
				durationMs: 50,
				status: "success",
				cardType: "design-canvas",
				cardLayout: "dock",
			}];
			const hydrationSentinel = {
				id: toolHydrationCount === 1
					? "hydration-sentinel-initial"
					: "hydration-sentinel-persisted",
				extensionId: "builtin",
				toolName: toolHydrationCount === 1
					? "hydration-sentinel-initial"
					: "hydration-sentinel-persisted",
				input: {},
				outputSummary: "hydrated",
				success: true,
				durationMs: 1,
				status: "success",
			};
			await route.fulfill({
				json: {
					messages: [userMsg, assistantMsg],
					orphanedToolCalls: [...completedToolCall, hydrationSentinel],
				},
			});
		});
		await routePreview(page);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeEnabled({ timeout: 15_000 });
		await initialToolHydration;
		await textarea.pressSequentially("Open the planning canvas");
		const sent = page.waitForResponse((response) => response.url().includes("/messages") && response.request().method() === "POST");
		await textarea.press("Enter");
		await sent;
		await emitSse({ type: "run:token", data: { runId: "run-canvas", token: "Opening canvas…" } });
		await emitSse({
			type: "tool:start",
			data: { conversationId: "conv-1", extensionId: "claude-design", toolName: "claude-design__open-canvas", input: { draftId: "d-1" }, timestamp: Date.now(), cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-dock-live" },
		});
		await expect(page.getByTestId("dock-host")).toHaveCount(0);
		await emitSse({
			type: "tool:complete",
			data: { conversationId: "conv-1", extensionId: "claude-design", toolName: "claude-design__open-canvas", output: { content: [{ type: "text", text: JSON.stringify(payload) }] }, duration: 50, success: true, cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-dock-live" },
		});
		await assertDock(page);
		releaseInitialToolHydration?.();
		// Later refreshes stay blocked until this empty pre-event snapshot reaches
		// the store, so they cannot mask a lost live call in this assertion.
		await expect(page.getByRole("button", { name: /hydration-sentinel-initial/ })).toBeVisible();
		await expect(page.getByRole("complementary", { name: "Preview controls" })).toBeVisible();
		await expect(page.getByRole("main")).toHaveCSS("padding-right", "640px");
		// Evidence capture waits for network idle, so unblock subsequent refreshes
		// only after the fault-sensitive initial assertion is complete.
		releaseLaterToolHydrations?.();
		await assertCanvasThemeTokens(page);
		await captureEvidence(page, testInfo, "extension-iframe-live-dock-light");
		await page.evaluate(() => {
			localStorage.setItem("ezcorp-theme", "dark");
			document.documentElement.classList.add("dark");
		});
		await assertCanvasThemeTokens(page);
		await captureEvidence(page, testInfo, "extension-iframe-live-dock-dark");
		await page.setViewportSize({ width: 393, height: 851 });
		await expect(page.getByTestId("dock-host")).toBeVisible();
		await captureEvidence(page, testInfo, "extension-iframe-live-dock-mobile-dark");
		await page.setViewportSize({ width: 1280, height: 720 });
		const persistedRefresh = page.waitForResponse((response) =>
			response.url().includes("/api/conversations/conv-1/messages?withToolCalls=true") &&
			response.request().method() === "GET",
		);
		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("ez:agent_complete", {
				detail: { parentConversationId: "conv-1" },
			}));
		});
		await persistedRefresh;
		// Every post-initial response contains the matching persisted row. A stable
		// marker keeps this assertion independent of unrelated background refreshes.
		await expect(page.getByRole("button", { name: /hydration-sentinel-persisted/ })).toBeVisible();
		await expect(page.getByTestId("dock-host")).toBeVisible();
		await expect(page.getByRole("main")).toHaveCSS("padding-right", "640px");
		await page.getByTestId("dock-close").click();
		await expect(page.getByTestId("dock-host")).toHaveCount(0);
	});

	test("persisted dock call restores after a fresh page load @evidence", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg],
			messageToolCalls: { m2: [{ id: "tc-dock-saved", extensionId: "claude-design", toolName: "claude-design__open-canvas", input: { draftId: "d-1" }, outputSummary: "Canvas ready", fullOutput: JSON.stringify(payload), success: true, durationMs: 50, status: "success", messageId: "m2", cardType: "design-canvas", cardLayout: "dock" }] },
		});
		await routePreview(page);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await assertDock(page);
		await page.getByTestId("dock-close").click();
		await expect(page.getByTestId("dock-host")).toHaveCount(0);
	});
});
