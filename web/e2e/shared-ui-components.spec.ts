import type { Page } from "@playwright/test";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeAgent, makeExtension } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "UI Components Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
const agents = [makeAgent({ name: "Assistant", description: "General assistant" })];

const EXT_NAME = "analyzer";
const extensions = [makeExtension({ name: EXT_NAME, description: "Code analysis tool", enabled: true })];

type MockApi = (overrides?: MockOverrides) => Promise<void>;
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** Select a current extension mention; the composer opens its tools. */
async function openTools(page: Page, mockApi: MockApi, tools: Tool[]) {
	await mockApi({ projects: [proj], conversations: [conv], messages: [], agents, extensions });
	await page.route("**/api/extensions/*/tools", route => route.fulfill({ json: { tools } }));
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	const textarea = page.getByRole("group", { name: "Chat input with file drop zone" }).locator("textarea");
	await expect(textarea).toBeEnabled();
	await textarea.fill(`!ext:${EXT_NAME}`);
	const listbox = page.locator("#mention-listbox");
	await expect(listbox.getByText(EXT_NAME, { exact: true })).toBeVisible();
	await textarea.press("Enter");
	await expect(listbox).toBeHidden();
	await expect(page.locator('.chat-textarea-overlay [data-mention-kind="extension"]')).toContainText(EXT_NAME);
}

async function openToolForm(page: Page, mockApi: MockApi, tools: Tool[]) {
	await openTools(page, mockApi, tools);
	await expect(page.locator('form button[type="submit"]')).toBeVisible();
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

		const fileInput = page.locator('form input[type="text"]').first();
		await expect(fileInput).toBeVisible();
		await expect(page.getByTitle("Browse")).toBeVisible();
	});

	test("browse button opens file list from /api/fs/list", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, makeTool("filePath", {
			type: "string", format: "file-path", description: "Path to the file",
		}));

		// Override fs/list AFTER openToolForm (mockApi already ran, so this takes LIFO precedence)
		await page.route("**/api/fs/list**", (route) => {
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
		const searchInput = page.locator('form input[type="text"]').first();
		await expect(searchInput).toBeVisible();
	});

	test("clear button appears after typing, clears input on click", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, makeTool("query", {
			type: "string", format: "search", description: "Search query",
		}));

		const searchInput = page.locator('form input[type="text"]').first();
		await searchInput.fill("hello");


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

		const comboInput = page.locator('form input[type="text"]').first();
		await expect(comboInput).toBeVisible();
	});

	test("opens dropdown with options on focus", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, comboTool);

		const comboInput = page.locator('form input[type="text"]').first();
		await comboInput.click();


		await expect(page.getByText("TypeScript")).toBeVisible({ timeout: 2000 });
		await expect(page.getByText("Python")).toBeVisible();
		await expect(page.getByText("Rust")).toBeVisible();
	});

	test("clicking an option selects it", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, comboTool);

		const comboInput = page.locator('form input[type="text"]').first();
		await comboInput.click();


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


		await expect(page.getByText("mytag")).toBeVisible({ timeout: 2000 });
		await expect(tagInput).toHaveValue("");
	});

	test("x button removes a tag", async ({ page, mockApi }) => {
		await openToolForm(page, mockApi, tagTool);

		const tagInput = page.locator('input[placeholder="Tags"]');
		await tagInput.click();
		await tagInput.pressSequentially("first");
		await page.keyboard.press("Enter");


		const chip = page.locator('form span.inline-flex').filter({ hasText: 'first' });
		await expect(chip).toBeVisible();

		// Click the x button on the chip to remove the tag
		await chip.locator('button').click();

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
		const textInputs = page.locator('form input[type="text"]');
		expect(await textInputs.count()).toBeGreaterThanOrEqual(3);
	});
});

test.describe("InlineToolForm Cancel / Add buttons", () => {
	async function openSimpleForm(page: Page, mockApi: MockApi) {
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
		await openTools(page, mockApi, multiTools);

		// ToolPicker shows both tools (use role=option for the tool items)
		await expect(page.getByRole("option", { name: /scan/ })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("option", { name: /fix/ })).toBeVisible();
	});

	test("selecting a tool from picker shows the form", async ({ page, mockApi }) => {
		await openTools(page, mockApi, multiTools);

		// Wait for tool picker
		await expect(page.getByRole("option", { name: /scan/ })).toBeVisible({ timeout: 3000 });

		// Select the "scan" tool
		await page.getByRole("option", { name: /scan/ }).click();

		// Form should appear for the selected tool
		await expect(page.locator('form button[type="submit"]')).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("scan")).toBeVisible();
	});
});
