import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeAgent } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "UI Components Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
const agents = [makeAgent({ name: "Assistant", description: "General assistant" })];

const EXT_NAME = "analyzer";
const extensions = [{ name: EXT_NAME, description: "Code analysis tool", enabled: true }];

/** Set up base API mocks, navigate to chat page, and return a focused textarea. */
async function setupPage(page: any, mockApi: any) {
	await mockApi({ projects: [proj], conversations: [conv], messages: [], agents, extensions });
await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

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

	const textarea = page.locator("textarea");
	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

/**
 * Open the InlineToolForm for an extension tool by going through the mention flow.
 * The tools route must be registered AFTER mockApi (LIFO: last registered = highest priority).
 */
async function openToolForm(page: any, mockApi: any, toolsData: any[]) {
	// Set up base mocks first (registers generic **/api/** handler)
	const textarea = await setupPage(page, mockApi);

	// Register tools route AFTER mockApi so it takes precedence (LIFO ordering)
	await page.route("**/api/extensions/*/tools", (route: any) => {
		route.fulfill({ json: { tools: toolsData } });
	});

	// Type @ext:analyzer to open mention popover
	await textarea.focus();
	await textarea.pressSequentially(`@ext:${EXT_NAME}`, { delay: 50 });
	await page.waitForTimeout(350);

	const listbox = page.locator("#mention-listbox");
	await expect(listbox).toBeVisible({ timeout: 5000 });
	await expect(listbox.getByText(EXT_NAME, { exact: true })).toBeVisible({ timeout: 3000 });

	// Use Enter to select the highlighted extension (like mention-system tests do)
	await page.keyboard.press("Enter");
	await expect(listbox).not.toBeVisible({ timeout: 3000 });

	// Wait for the @analyzer chip to appear in the overlay.
	// The chip is inside aria-hidden="true", so use CSS selector (not getByRole).
	const chip = page.locator(`span[role="button"]`).filter({ hasText: `@${EXT_NAME}` });
	await expect(chip).toBeVisible({ timeout: 3000 });

	// Click the chip to trigger handleChipClick (the tools fetch)
	await chip.click();

	// Wait for the form to open
	await expect(page.locator('form button[type="submit"]')).toBeVisible({ timeout: 5000 });

	return textarea;
}

/** Build a single-tool schema with one field. */
function makeTool(fieldName: string, fieldSchema: Record<string, unknown>, required = true) {
	return [{
		name: "run",
		description: "Run the tool",
		inputSchema: {
			type: "object",
			properties: { [fieldName]: fieldSchema },
			required: required ? [fieldName] : [],
		},
	}];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("SharedFilePicker (format: file-path)", () => {
	test("renders text input and browse button", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, makeTool("filePath", {
			type: "string", format: "file-path", description: "Path to the file",
		}));

		const fileInput = page.locator('input[type="text"]').first();
		await expect(fileInput).toBeVisible();
		await expect(page.getByTitle("Browse")).toBeVisible();
	});

	test("browse button opens file list from /api/fs/list", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, makeTool("filePath", {
			type: "string", format: "file-path", description: "Path to the file",
		}));

		// Override fs/list AFTER openToolForm (mockApi already ran, so this takes LIFO precedence)
		await page.route("**/api/fs/list**", (route: any) => {
			route.fulfill({ json: [
				{ name: "src", isDir: true },
				{ name: "README.md", isDir: false },
			] });
		});

		await page.getByTitle("Browse").click();
		await expect(page.getByText("README.md")).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("src")).toBeVisible();
	});
});

test.describe("SearchBox (format: search)", () => {
	test("renders search input with search icon", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, makeTool("query", {
			type: "string", format: "search", description: "Search query",
		}));

		// SearchBox renders an input
		const searchInput = page.locator('input[type="text"]').first();
		await expect(searchInput).toBeVisible();
	});

	test("clear button appears after typing, clears input on click", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, makeTool("query", {
			type: "string", format: "search", description: "Search query",
		}));

		const searchInput = page.locator('input[type="text"]').first();
		await searchInput.fill("hello");
		await page.waitForTimeout(50);

		const clearBtn = page.getByTitle("Clear");
		await expect(clearBtn).toBeVisible({ timeout: 2000 });

		await clearBtn.click();
		await expect(searchInput).toHaveValue("");
		await expect(clearBtn).not.toBeVisible();
	});
});

test.describe("ComboBox (format: combo-box)", () => {
	const comboTool = makeTool("language", {
		type: "string",
		format: "combo-box",
		description: "Programming language",
		"x-options": { options: ["TypeScript", "Python", "Rust"] },
	});

	test("renders input field", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, comboTool);

		const comboInput = page.locator('input[type="text"]').first();
		await expect(comboInput).toBeVisible();
	});

	test("opens dropdown with options on focus", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, comboTool);

		const comboInput = page.locator('input[type="text"]').first();
		await comboInput.click();
		await page.waitForTimeout(100);

		await expect(page.getByText("TypeScript")).toBeVisible({ timeout: 2000 });
		await expect(page.getByText("Python")).toBeVisible();
		await expect(page.getByText("Rust")).toBeVisible();
	});

	test("clicking an option selects it", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, comboTool);

		const comboInput = page.locator('input[type="text"]').first();
		await comboInput.click();
		await page.waitForTimeout(100);

		await page.getByText("Python").click();
		await expect(comboInput).toHaveValue("Python");
	});
});

test.describe("TagInput (format: tag-input)", () => {
	const tagTool = makeTool("tags", {
		type: "array", format: "tag-input", description: "Tags",
	}, false);

	test("renders tag input", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, tagTool);

		const tagInput = page.locator('input[placeholder="Tags"]');
		await expect(tagInput).toBeVisible();
	});

	test("Enter adds a tag chip", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, tagTool);

		const tagInput = page.locator('input[placeholder="Tags"]');
		await tagInput.click();
		await tagInput.pressSequentially("mytag");
		await page.keyboard.press("Enter");
		await page.waitForTimeout(100);

		await expect(page.getByText("mytag")).toBeVisible({ timeout: 2000 });
		await expect(tagInput).toHaveValue("");
	});

	test("x button removes a tag", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, tagTool);

		const tagInput = page.locator('input[placeholder="Tags"]');
		await tagInput.click();
		await tagInput.pressSequentially("first");
		await page.keyboard.press("Enter");
		await page.waitForTimeout(100);

		const chip = page.locator('.inline-flex').filter({ hasText: "first" });
		await expect(chip).toBeVisible();

		// Click the x button on the chip to remove the tag
		await chip.locator('button').click();
		await page.waitForTimeout(100);
		await expect(chip).not.toBeVisible();
	});
});

test.describe("DatePicker (format: date)", () => {
	test("renders a date input", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, makeTool("dueDate", {
			type: "string", format: "date", description: "Due date",
		}, false));

		const dateInput = page.locator('input[type="date"]');
		await expect(dateInput).toBeVisible();
	});

	test("accepts a date value", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, makeTool("dueDate", {
			type: "string", format: "date", description: "Due date",
		}, false));

		const dateInput = page.locator('input[type="date"]');
		await dateInput.fill("2026-06-15");
		await expect(dateInput).toHaveValue("2026-06-15");
	});
});

test.describe("Unrecognized format", () => {
	test("shows unrecognized format error text", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, makeTool("weirdField", {
			type: "string", format: "some-future-format", description: "Unknown format field",
		}));

		await expect(page.getByText('Unrecognized format: "some-future-format"')).toBeVisible();
	});
});

test.describe("Mixed format form", () => {
	test("renders all format components in one form", async ({ page, mockApi }) => {
		const mixedTool = [{
			name: "process",
			description: "Process with multiple inputs",
			inputSchema: {
				type: "object",
				properties: {
					filePath: { type: "string", format: "file-path", description: "Input file" },
					query: { type: "string", format: "search", description: "Search query" },
					language: {
						type: "string",
						format: "combo-box",
						description: "Language",
						"x-options": { options: ["JS", "TS"] },
					},
					tags: { type: "array", format: "tag-input", description: "Tags" },
				},
				required: [],
			},
		}];

		await openToolForm(page, mockApi, mixedTool);

		// Browse button = SharedFilePicker is present
		await expect(page.getByTitle("Browse")).toBeVisible();
		// TagInput placeholder
		await expect(page.locator('input[placeholder="Tags"]')).toBeVisible();
		// Multiple text inputs for file-path, search, combo-box
		const textInputs = page.locator('input[type="text"]');
		expect(await textInputs.count()).toBeGreaterThanOrEqual(3);
	});
});

test.describe("InlineToolForm Cancel / Add buttons", () => {
	async function openSimpleForm(page: any, mockApi: any) {
		return openToolForm(page, mockApi, makeTool("query", {
			type: "string", format: "search", description: "Query",
		}));
	}

	test("Cancel button closes the form", async ({ page, mockApi }) => {
		await openSimpleForm(page, mockApi);

		await page.getByRole("button", { name: "Cancel" }).click();
		await expect(page.locator('form button[type="submit"]')).not.toBeVisible({ timeout: 2000 });
	});

	test("Escape key closes the form", async ({ page, mockApi }) => {
		await openSimpleForm(page, mockApi);

		// Focus an element inside the form so the keydown reaches it
		await page.locator('form input').first().focus();
		await page.keyboard.press("Escape");
		await expect(page.locator('form button[type="submit"]')).not.toBeVisible({ timeout: 2000 });
	});

	test("shows extension name and tool name in header", async ({ page, mockApi }) => {
		await openSimpleForm(page, mockApi);

		const form = page.locator('form');
		await expect(form.getByText(EXT_NAME)).toBeVisible();
		await expect(form.getByText("run")).toBeVisible();
	});
});

test.describe("ToolPicker (multiple tools)", () => {
	const multiTools = [
		{
			name: "scan",
			description: "Scan files",
			inputSchema: { type: "object", properties: {}, required: [] },
		},
		{
			name: "fix",
			description: "Fix issues",
			inputSchema: { type: "object", properties: {}, required: [] },
		},
	];

	test("shows tool picker when extension has multiple tools", async ({ page, mockApi }) => {
		const textarea = await setupPage(page, mockApi);
		// Register after mockApi so it takes precedence (LIFO)
		await page.route("**/api/extensions/*/tools", (route: any) => {
			route.fulfill({ json: { tools: multiTools } });
		});

		await textarea.focus();
		await textarea.pressSequentially(`@ext:${EXT_NAME}`, { delay: 50 });
		await page.waitForTimeout(350);

		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toBeVisible({ timeout: 5000 });
		await page.keyboard.press("Enter");
		await expect(listbox).not.toBeVisible({ timeout: 3000 });

		const chip = page.locator(`span[role="button"]`).filter({ hasText: `@${EXT_NAME}` });
		await expect(chip).toBeVisible({ timeout: 3000 });
		await chip.click();

		// ToolPicker shows both tools (use role=option for the tool items)
		await expect(page.getByRole("option", { name: /scan/ })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("option", { name: /fix/ })).toBeVisible();
	});

	test("selecting a tool from picker shows the form", async ({ page, mockApi }) => {
		const textarea = await setupPage(page, mockApi);
		await page.route("**/api/extensions/*/tools", (route: any) => {
			route.fulfill({ json: { tools: multiTools } });
		});

		await textarea.focus();
		await textarea.pressSequentially(`@ext:${EXT_NAME}`, { delay: 50 });
		await page.waitForTimeout(350);

		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toBeVisible({ timeout: 5000 });
		await page.keyboard.press("Enter");
		await expect(listbox).not.toBeVisible({ timeout: 3000 });

		const chip = page.locator(`span[role="button"]`).filter({ hasText: `@${EXT_NAME}` });
		await expect(chip).toBeVisible({ timeout: 3000 });
		await chip.click();

		// Wait for tool picker
		await expect(page.getByRole("option", { name: /scan/ })).toBeVisible({ timeout: 3000 });

		// Select the "scan" tool
		await page.getByRole("option", { name: /scan/ }).click();

		// Form should appear for the selected tool
		await expect(page.locator('form button[type="submit"]')).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("scan")).toBeVisible();
	});
});
