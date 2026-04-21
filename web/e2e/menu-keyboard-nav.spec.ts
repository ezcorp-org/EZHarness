import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeAgent } from "./fixtures/data.js";

/**
 * E2E tests for keyboard navigation (including Tab) in
 * MentionPopover and ToolPicker menus.
 */

const proj = makeProject({ id: "proj-1", name: "KB Nav Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

const agents = [
	makeAgent({ name: "Code Assistant", description: "Helps write code" }),
	makeAgent({ name: "Summarizer", description: "Summarizes text" }),
];

const extensions = [
	{ name: "analyzer", description: "Code analysis tool", enabled: true },
	{ name: "formatter", description: "Code formatter", enabled: true },
];

async function setupAndFocus(page: any, mockApi: any) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [],
		agents,
		extensions,
	});
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

	const textarea = page.locator("textarea");

	await page.waitForFunction(() => {
		const listeners = (window as any).__fakeWsListeners;
		if (listeners?.open) {
			for (const fn of listeners.open) {
				try { fn(new Event("open")); } catch {}
			}
		}
		const ta = document.querySelector("textarea");
		return ta && !ta.disabled;
	}, { timeout: 5000 });

	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

async function typeIntoTextarea(page: any, textarea: any, text: string) {
	await textarea.focus();
	await textarea.pressSequentially(text, { delay: 50 });
	await page.waitForTimeout(350);
}

async function waitForPopover(page: any) {
	await expect(page.locator("#mention-listbox")).toBeVisible({ timeout: 5000 });
}

test.describe("MentionPopover Tab key selection", () => {
	test("Tab selects the first highlighted mention item", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@");

		await waitForPopover(page);
		await expect(page.locator("#mention-item-0")).toHaveAttribute("aria-selected", "true");

		await page.keyboard.press("Tab");

		// Popover should close
		await expect(page.locator("#mention-listbox")).not.toBeVisible();

		// Mention token should be inserted
		const val = await textarea.inputValue();
		expect(val).toMatch(/@\[(agent|ext):/);
	});

	test("Tab selects navigated item (ArrowDown then Tab)", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@");

		await waitForPopover(page);

		// Navigate down to second item
		await page.keyboard.press("ArrowDown");
		await expect(page.locator("#mention-item-1")).toHaveAttribute("aria-selected", "true");

		await page.keyboard.press("Tab");

		// Popover should close
		await expect(page.locator("#mention-listbox")).not.toBeVisible();

		// Should have inserted a mention
		const val = await textarea.inputValue();
		expect(val).toMatch(/@\[(agent|ext):/);
	});

	test("Tab does NOT send message while popover is open", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@code");

		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Code Assistant")).toBeVisible({ timeout: 3000 });

		await page.keyboard.press("Tab");

		// Should NOT have sent — no user message bubble
		await expect(page.locator('[data-role="user"]')).not.toBeVisible({ timeout: 1000 });

		// Textarea still has content
		const val = await textarea.inputValue();
		expect(val.length).toBeGreaterThan(0);
	});

	test("Tab selects extension mention from popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@ext:anal");

		const listbox = page.locator("#mention-listbox");
		await waitForPopover(page);
		await expect(listbox.getByText("analyzer")).toBeVisible({ timeout: 3000 });

		await page.keyboard.press("Tab");

		await expect(listbox).not.toBeVisible();
		await expect(textarea).toHaveValue(/@\[ext:analyzer\] /);
	});

	test("Tab and Enter produce same result in popover", async ({ page, mockApi }) => {
		// Test with Tab
		const textarea1 = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea1, "@code");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Code Assistant")).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Tab");
		const tabVal = await textarea1.inputValue();

		// Navigate to a new page for Enter test
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea2 = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea2, "@code");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Code Assistant")).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");
		const enterVal = await textarea2.inputValue();

		expect(tabVal).toBe(enterVal);
	});
});

test.describe("ToolPicker Tab key selection", () => {
	test("Tab selects highlighted tool from picker", async ({ page, mockApi }) => {
		// Mock extension with multiple tools so ToolPicker appears
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			agents,
			extensions,
			routes: {
				"extensions/analyzer/tools": () => ({
					tools: [
						{ name: "lint", description: "Lint code", inputSchema: { type: "object", properties: {} } },
						{ name: "format", description: "Format code", inputSchema: { type: "object", properties: {} } },
						{ name: "check", description: "Type check", inputSchema: { type: "object", properties: {} } },
					],
				}),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await page.waitForFunction(() => {
			const listeners = (window as any).__fakeWsListeners;
			if (listeners?.open) {
				for (const fn of listeners.open) {
					try { fn(new Event("open")); } catch {}
				}
			}
			const ta = document.querySelector("textarea");
			return ta && !ta.disabled;
		}, { timeout: 5000 });
		await expect(textarea).toBeEnabled({ timeout: 5000 });
		await page.waitForTimeout(100);
		await textarea.click();

		// Select the extension via mention
		await textarea.pressSequentially("@ext:anal", { delay: 50 });
		await page.waitForTimeout(350);
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("analyzer")).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");

		// Wait for ToolPicker to appear (multi-tool extension)
		const toolPicker = page.locator('[role="listbox"][aria-label="Tools for analyzer"]');
		await expect(toolPicker).toBeVisible({ timeout: 5000 });

		// First tool highlighted by default
		await expect(page.locator("#tool-item-0")).toHaveAttribute("aria-selected", "true");

		// Navigate down then Tab to select
		await page.keyboard.press("ArrowDown");
		await expect(page.locator("#tool-item-1")).toHaveAttribute("aria-selected", "true");

		await page.keyboard.press("Tab");

		// ToolPicker should close, tool form should open
		await expect(toolPicker).not.toBeVisible({ timeout: 3000 });

		// The tool form header should show the selected tool name
		await expect(page.getByText("format")).toBeVisible({ timeout: 3000 });
	});

	test("ArrowDown/ArrowUp navigate ToolPicker via keyboard delegation", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			agents,
			extensions,
			routes: {
				"extensions/analyzer/tools": () => ({
					tools: [
						{ name: "lint", description: "Lint code", inputSchema: { type: "object", properties: {} } },
						{ name: "format", description: "Format code", inputSchema: { type: "object", properties: {} } },
						{ name: "check", description: "Type check", inputSchema: { type: "object", properties: {} } },
					],
				}),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea = page.locator("textarea");
		await page.waitForFunction(() => {
			const listeners = (window as any).__fakeWsListeners;
			if (listeners?.open) {
				for (const fn of listeners.open) {
					try { fn(new Event("open")); } catch {}
				}
			}
			const ta = document.querySelector("textarea");
			return ta && !ta.disabled;
		}, { timeout: 5000 });
		await expect(textarea).toBeEnabled({ timeout: 5000 });
		await page.waitForTimeout(100);
		await textarea.click();

		// Open mention and select multi-tool extension
		await textarea.pressSequentially("@ext:anal", { delay: 50 });
		await page.waitForTimeout(350);
		await waitForPopover(page);
		await page.keyboard.press("Enter");

		const toolPicker = page.locator('[role="listbox"][aria-label="Tools for analyzer"]');
		await expect(toolPicker).toBeVisible({ timeout: 5000 });

		// Navigate: 0 → 1 → 2 → 0 (wrap)
		await expect(page.locator("#tool-item-0")).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("ArrowDown");
		await expect(page.locator("#tool-item-1")).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("ArrowDown");
		await expect(page.locator("#tool-item-2")).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("ArrowDown");
		await expect(page.locator("#tool-item-0")).toHaveAttribute("aria-selected", "true");

		// ArrowUp wraps to last
		await page.keyboard.press("ArrowUp");
		await expect(page.locator("#tool-item-2")).toHaveAttribute("aria-selected", "true");
	});

	test("Escape closes ToolPicker via keyboard delegation", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			agents,
			extensions,
			routes: {
				"extensions/analyzer/tools": () => ({
					tools: [
						{ name: "lint", description: "Lint code", inputSchema: { type: "object", properties: {} } },
						{ name: "format", description: "Format code", inputSchema: { type: "object", properties: {} } },
					],
				}),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea = page.locator("textarea");
		await page.waitForFunction(() => {
			const listeners = (window as any).__fakeWsListeners;
			if (listeners?.open) {
				for (const fn of listeners.open) {
					try { fn(new Event("open")); } catch {}
				}
			}
			const ta = document.querySelector("textarea");
			return ta && !ta.disabled;
		}, { timeout: 5000 });
		await expect(textarea).toBeEnabled({ timeout: 5000 });
		await page.waitForTimeout(100);
		await textarea.click();

		await textarea.pressSequentially("@ext:anal", { delay: 50 });
		await page.waitForTimeout(350);
		await waitForPopover(page);
		await page.keyboard.press("Enter");

		const toolPicker = page.locator('[role="listbox"][aria-label="Tools for analyzer"]');
		await expect(toolPicker).toBeVisible({ timeout: 5000 });

		await page.keyboard.press("Escape");
		await expect(toolPicker).not.toBeVisible({ timeout: 3000 });
	});

	test("Enter selects tool from ToolPicker via keyboard delegation", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			agents,
			extensions,
			routes: {
				"extensions/analyzer/tools": () => ({
					tools: [
						{ name: "lint", description: "Lint code", inputSchema: { type: "object", properties: {} } },
						{ name: "format", description: "Format code", inputSchema: { type: "object", properties: {} } },
					],
				}),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea = page.locator("textarea");
		await page.waitForFunction(() => {
			const listeners = (window as any).__fakeWsListeners;
			if (listeners?.open) {
				for (const fn of listeners.open) {
					try { fn(new Event("open")); } catch {}
				}
			}
			const ta = document.querySelector("textarea");
			return ta && !ta.disabled;
		}, { timeout: 5000 });
		await expect(textarea).toBeEnabled({ timeout: 5000 });
		await page.waitForTimeout(100);
		await textarea.click();

		await textarea.pressSequentially("@ext:anal", { delay: 50 });
		await page.waitForTimeout(350);
		await waitForPopover(page);
		await page.keyboard.press("Enter");

		const toolPicker = page.locator('[role="listbox"][aria-label="Tools for analyzer"]');
		await expect(toolPicker).toBeVisible({ timeout: 5000 });

		// Select first tool with Enter
		await page.keyboard.press("Enter");
		await expect(toolPicker).not.toBeVisible({ timeout: 3000 });

		// Tool form should open for "lint"
		await expect(page.getByText("lint")).toBeVisible({ timeout: 3000 });
	});
});
