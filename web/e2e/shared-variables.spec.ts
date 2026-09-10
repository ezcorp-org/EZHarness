import type { Page } from "@playwright/test";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeAgent, makeExtension } from "./fixtures/data.js";
import { selectExtensionMention } from "./fixtures/composer.js";

const proj = makeProject({ id: "proj-sv", name: "Shared Vars Project" });
const conv = makeConversation({ id: "conv-sv", projectId: "proj-sv" });
const agents = [makeAgent({ name: "Assistant", description: "General assistant" })];
const EXT_NAME = "file-refactor";
const extensions = [makeExtension({ name: EXT_NAME, description: "Preview file renames", enabled: true })];
type MockApi = (overrides?: MockOverrides) => Promise<void>;
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

async function setupPage(page: Page, mockApi: MockApi) {
	await mockApi({ projects: [proj], conversations: [conv], messages: [], agents, extensions });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

	const textarea = page.locator("textarea");
	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await textarea.click();
	return textarea;
}

async function openToolForm(page: Page, mockApi: MockApi, toolsData: Tool[]) {
	await setupPage(page, mockApi);

	await page.route("**/api/extensions/*/tools", (route) => {
		return route.fulfill({ json: { tools: toolsData } });
	});

	// Click the native picker result. Enter leaves the typed sigil in the
	// composer on current ChatInput, while this helper verifies the committed
	// mention chip that exposes the form.
	const chip = await selectExtensionMention(page, EXT_NAME);
	await chip.click();
	await expect(page.locator('form button[type="submit"]')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("x-shared file-path field shows in form and is submittable", async ({ page, mockApi }) => {
	const tools = [{
		name: "rename-files",
		description: "Preview file renames",
		inputSchema: {
			type: "object",
			properties: {
				sourcePath: {
					type: "string",
					format: "file-path",
					description: "File or directory to analyze",
					"x-shared": "project.cwd",
				},
				convention: {
					type: "string",
					description: "Target naming convention",
				},
			},
			required: ["sourcePath", "convention"],
		},
	}];

	await openToolForm(page, mockApi, tools);

	const sourcePath = page.locator('label[for="field-sourcePath"]').locator('xpath=..').locator('input');
	const convention = page.locator('#field-convention');
	await expect(sourcePath).toHaveValue("/tmp/test-project");
	await convention.fill("kebab-case");

	let invoked: Record<string, unknown> | null = null;
	await page.route("**/api/tool-invoke", async (route) => {
		invoked = route.request().postDataJSON();
		await route.fulfill({ json: { success: true } });
	});
	await page.locator('form button[type="submit"]').click();
	await expect.poll(() => invoked).not.toBeNull();
	expect(invoked).toMatchObject({
		extensionName: EXT_NAME,
		toolName: "rename-files",
		input: { sourcePath: "/tmp/test-project", convention: "kebab-case" },
	});
});

test("form renders field with x-shared annotation alongside regular fields", async ({ page, mockApi }) => {
	const tools = [{
		name: "analyze",
		description: "Analyze project",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Project path",
					"x-shared": "project.cwd",
				},
				depth: {
					type: "number",
					description: "Analysis depth",
				},
			},
		},
	}];

	await openToolForm(page, mockApi, tools);

	await expect(page.locator('#field-path')).toHaveValue("/tmp/test-project");
	await expect(page.locator('#field-depth')).toHaveValue("");
	await expect(page.getByText("Project path")).toBeVisible();
	await expect(page.getByText("Analysis depth")).toBeVisible();
});

test("tool without x-shared fields renders normally", async ({ page, mockApi }) => {
	const tools = [{
		name: "format",
		description: "Format text",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "Text to format" },
			},
			required: ["text"],
		},
	}];

	await openToolForm(page, mockApi, tools);

	await expect(page.locator('label').filter({ hasText: "text" })).toBeVisible();
	// No x-shared behavior, just a normal text field
	const input = page.locator('input#field-text');
	await expect(input).toBeVisible();
});
