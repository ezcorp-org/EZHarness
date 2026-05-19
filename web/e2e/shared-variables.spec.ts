import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeAgent } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-sv", name: "Shared Vars Project" });
const conv = makeConversation({ id: "conv-sv", projectId: "proj-sv" });
const agents = [makeAgent({ name: "Assistant", description: "General assistant" })];
const EXT_NAME = "file-refactor";
const extensions = [{ name: EXT_NAME, description: "Preview file renames", enabled: true }];

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

async function openToolForm(page: any, mockApi: any, toolsData: any[]) {
	const textarea = await setupPage(page, mockApi);

	await page.route("**/api/extensions/*/tools", (route: any) => {
		route.fulfill({ json: { tools: toolsData } });
	});

	await textarea.focus();
	await textarea.pressSequentially(`@ext:${EXT_NAME}`, { delay: 50 });
	await page.waitForTimeout(350);

	const listbox = page.locator("#mention-listbox");
	await expect(listbox).toBeVisible({ timeout: 5000 });
	await expect(listbox.getByText(EXT_NAME, { exact: true })).toBeVisible({ timeout: 3000 });

	await page.keyboard.press("Enter");
	await expect(listbox).not.toBeVisible({ timeout: 3000 });

	const chip = page.locator(`span[role="button"]`).filter({ hasText: `@${EXT_NAME}` });
	await expect(chip).toBeVisible({ timeout: 3000 });
	await chip.click();

	await expect(page.locator('form button[type="submit"]')).toBeVisible({ timeout: 5000 });
	return textarea;
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

	// The form should have labels for both fields
	await expect(page.locator('label').filter({ hasText: "sourcePath" })).toBeVisible();
	await expect(page.locator('label').filter({ hasText: "convention" })).toBeVisible();

	// The form should be visible and have a submit button
	const submitBtn = page.locator('form button[type="submit"]');
	await expect(submitBtn).toBeVisible();
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

	// Both fields should be rendered
	await expect(page.locator('label').filter({ hasText: "path" })).toBeVisible();
	await expect(page.locator('label').filter({ hasText: "depth" })).toBeVisible();

	// The descriptions should show
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
