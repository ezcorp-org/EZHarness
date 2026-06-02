import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeAgent } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Mention Project" });
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

	// The WS mock's open event may race with app subscription.
	// Retry firing open events until connection is established.
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
	// Small settle time for Svelte reactivity after connection state change
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

/**
 * Type text into textarea character by character, triggering input events.
 * Uses page.keyboard.type which fires proper keydown/input/keyup events.
 */
async function typeIntoTextarea(page: any, textarea: any, text: string) {
	await textarea.focus();
	await textarea.pressSequentially(text, { delay: 50 });
	// Wait for debounce (200ms) + Svelte reactivity
	await page.waitForTimeout(350);
}

/** Wait for popover to appear after typing @ trigger */
async function waitForPopover(page: any) {
	await expect(page.locator("#mention-listbox")).toBeVisible({ timeout: 5000 });
}

test.describe("Mention System", () => {
	test("typing @ opens the mention popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!");

		await waitForPopover(page);
	});

	test("popover shows agent and extension results", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!");

		const listbox = page.locator("#mention-listbox");
		await waitForPopover(page);

		await expect(listbox.getByText("Agents")).toBeVisible();
		await expect(listbox.getByText("Extensions")).toBeVisible();
		await expect(listbox.getByText("Code Assistant")).toBeVisible();
		await expect(listbox.getByText("analyzer")).toBeVisible();
	});

	test("typing filters results", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!code");

		const listbox = page.locator("#mention-listbox");
		await waitForPopover(page);

		await expect(listbox.getByText("Code Assistant")).toBeVisible({ timeout: 3000 });
		await expect(listbox.getByText("Summarizer")).not.toBeVisible();
	});

	test("ArrowDown/ArrowUp navigates highlighted item", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!");

		await waitForPopover(page);

		// First item highlighted by default
		await expect(page.locator("#mention-item-0")).toHaveAttribute("aria-selected", "true");

		await page.keyboard.press("ArrowDown");
		await expect(page.locator("#mention-item-1")).toHaveAttribute("aria-selected", "true");
		await expect(page.locator("#mention-item-0")).toHaveAttribute("aria-selected", "false");

		await page.keyboard.press("ArrowUp");
		await expect(page.locator("#mention-item-0")).toHaveAttribute("aria-selected", "true");
	});

	test("Enter selects highlighted item and inserts mention token", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!code");

		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Code Assistant")).toBeVisible({ timeout: 3000 });

		await page.keyboard.press("Enter");

		// Popover should close
		await expect(page.locator("#mention-listbox")).not.toBeVisible();

		// Textarea should contain the mention token
		await expect(textarea).toHaveValue(/^!Code Assistant\s+$/);
	});

	test("Enter does NOT send message while popover is open", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!code");

		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Code Assistant")).toBeVisible({ timeout: 3000 });

		await page.keyboard.press("Enter");

		// Should NOT have sent — no user message bubble in chat
		await expect(page.locator('[data-role="user"]')).not.toBeVisible({ timeout: 1000 });

		// Textarea still has content
		const val = await textarea.inputValue();
		expect(val.length).toBeGreaterThan(0);
	});

	test("Escape dismisses the popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!");

		await waitForPopover(page);

		await page.keyboard.press("Escape");
		await expect(page.locator("#mention-listbox")).not.toBeVisible();
	});

	test("clicking an item selects it", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!");

		const listbox = page.locator("#mention-listbox");
		await waitForPopover(page);
		await expect(listbox.getByText("Code Assistant")).toBeVisible({ timeout: 3000 });

		await listbox.getByText("Code Assistant").click();

		await expect(listbox).not.toBeVisible();
		await expect(textarea).toHaveValue(/^!Code Assistant\s+$/);
	});

	test("mention chip renders in overlay after selection", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!code");

		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Code Assistant")).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");

		// The overlay should render a chip with the mention name
		const overlay = page.locator("[aria-hidden='true']").filter({ hasText: "!Code Assistant" });
		await expect(overlay).toBeVisible({ timeout: 3000 });
	});

	test("atomic backspace deletes entire mention token", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!code");

		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Code Assistant")).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");

		// Verify the chip is committed. The textarea lays out the COMPACT
		// label (`!Code Assistant `); the full `![agent:…]` token lives on the
		// wire and renders as a chip in the overlay.
		const valBefore = await textarea.inputValue();
		expect(valBefore).toMatch(/^!Code Assistant\s+$/);
		await expect(
			page.locator('.chat-textarea-overlay [data-mention-kind="agent"]'),
		).toBeVisible();

		// Cursor is after the trailing space. Move left to sit at the chip's
		// edge, then backspace deletes the whole chip atomically.
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("Backspace");

		const valAfter = await textarea.inputValue();
		expect(valAfter).not.toContain("Code Assistant");
		await expect(
			page.locator('.chat-textarea-overlay [data-mention-kind="agent"]'),
		).toHaveCount(0);
	});

	test("!ext: prefix filters to extensions only", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!ext:");

		const listbox = page.locator("#mention-listbox");
		await waitForPopover(page);

		await expect(listbox.getByText("analyzer")).toBeVisible({ timeout: 3000 });
		await expect(listbox.getByText("Code Assistant")).not.toBeVisible();
	});

	test("!agent: prefix filters to agents only", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!agent:");

		const listbox = page.locator("#mention-listbox");
		await waitForPopover(page);

		await expect(listbox.getByText("Code Assistant")).toBeVisible({ timeout: 3000 });
		await expect(listbox.getByText("analyzer")).not.toBeVisible();
	});

	test("re-trigger: @ opens popover again after dismiss", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);

		// Open and dismiss
		await typeIntoTextarea(page, textarea, "!");
		await waitForPopover(page);
		await page.keyboard.press("Escape");
		await expect(page.locator("#mention-listbox")).not.toBeVisible();

		// Type space then @ again
		await typeIntoTextarea(page, textarea, " @");
		await waitForPopover(page);
	});

	test("Enter sends message when popover is closed", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);

		// Use fill to set content without triggering mention
		await textarea.fill("Hello world");

		// No popover should be open
		await expect(page.locator("#mention-listbox")).not.toBeVisible();

		await page.keyboard.press("Enter");

		// Message sent — textarea empties
		await expect(textarea).toHaveValue("", { timeout: 3000 });
	});

	test("ARIA combobox attributes are set correctly", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);

		await expect(textarea).toHaveAttribute("role", "combobox");
		await expect(textarea).toHaveAttribute("aria-autocomplete", "list");
		await expect(textarea).toHaveAttribute("aria-controls", "mention-listbox");

		// When closed
		await expect(textarea).toHaveAttribute("aria-expanded", "false");

		// Open popover
		await typeIntoTextarea(page, textarea, "!");
		await waitForPopover(page);

		// Now expanded
		await expect(textarea).toHaveAttribute("aria-expanded", "true");
	});

	test("agent chip has blue styling", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!code");

		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Code Assistant")).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");

		const chip = page.locator(".chat-textarea-overlay [data-mention-kind=\"agent\"]");
		await expect(chip).toBeVisible({ timeout: 3000 });
		await expect(chip).toHaveClass(/blue/);
	});

	test("extension chip has purple styling", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!anal");

		const listbox = page.locator("#mention-listbox");
		await waitForPopover(page);
		await expect(listbox.getByText("analyzer")).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");

		const chip = page.locator(".chat-textarea-overlay [data-mention-kind=\"extension\"]");
		await expect(chip).toBeVisible({ timeout: 3000 });
		await expect(chip).toHaveClass(/purple/);
	});

	test("no matches shows empty state", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!zzzznonexistent");

		const listbox = page.locator("#mention-listbox");
		await waitForPopover(page);
		await expect(listbox.getByText("No matches found")).toBeVisible({ timeout: 3000 });
	});

	test("deleting extension mention chip closes the tool form", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);

		// Select an extension mention
		await typeIntoTextarea(page, textarea, "!ext:anal");
		const listbox = page.locator("#mention-listbox");
		await waitForPopover(page);
		await expect(listbox.getByText("analyzer")).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");

		// Tool form should auto-open (single tool → direct to form)
		const toolForm = page.locator("text=analyze").first();
		await expect(toolForm).toBeVisible({ timeout: 5000 });

		// Now delete the mention chip via atomic backspace
		// Cursor is after "![ext:analyzer] ", move left then backspace
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("Backspace");

		// Verify mention is gone from textarea
		const val = await textarea.inputValue();
		expect(val).not.toContain("![ext:analyzer]");

		// Tool form should be closed
		await expect(toolForm).not.toBeVisible({ timeout: 3000 });
	});

	test("deleting @ trigger closes the mention popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!");

		await waitForPopover(page);

		// Delete the @ character
		await page.keyboard.press("Backspace");

		await expect(page.locator("#mention-listbox")).not.toBeVisible({ timeout: 3000 });
	});
});
