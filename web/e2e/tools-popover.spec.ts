import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });

const mockTools = {
	tools: [
		{ name: "scan", description: "Scan code", extension: "analyzer", extensionType: "extension", tokenEstimate: 25 },
		{ name: "lint", description: "Lint files", extension: "analyzer", extensionType: "extension", tokenEstimate: 22 },
		{ name: "summarize", description: "Summarize text", extension: "markdown-utils", extensionType: "mcp", tokenEstimate: 30 },
	],
	count: 3,
};

function toolButton(page: import("@playwright/test").Page) {
	return page.locator('button[aria-label^="Loaded tools"]');
}

function popover(page: import("@playwright/test").Page) {
	return page.getByTestId("tools-popover");
}

async function waitForHydration(page: import("@playwright/test").Page) {
	await page.waitForLoadState("networkidle");
}

async function openPopover(page: import("@playwright/test").Page) {
	await waitForHydration(page);
	await expect(toolButton(page)).toContainText("3", { timeout: 5000 });
	await toolButton(page).click();
	await expect(popover(page)).toBeVisible({ timeout: 3000 });
}

test("displays tool icon with correct count badge", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => mockTools },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	const btn = toolButton(page);
	await expect(btn).toBeVisible();
	await expect(btn).toContainText("3");
});

test("clicking tool icon opens popover with grouped tools", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => mockTools },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	await openPopover(page);

	await expect(popover(page).getByText("analyzer")).toBeVisible();
	await expect(popover(page).getByText("markdown-utils")).toBeVisible();
	await expect(popover(page).getByText("scan")).toBeVisible();
	await expect(popover(page).getByText("lint")).toBeVisible();
	await expect(popover(page).getByText("summarize")).toBeVisible();
});

test("clicking outside popover closes it", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => mockTools },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	await openPopover(page);

	await page.getByTestId("tools-backdrop").click({ force: true });
	await expect(popover(page)).not.toBeVisible();
});

test("clicking tool icon again toggles popover closed", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => mockTools },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	await openPopover(page);

	await toolButton(page).click({ force: true });
	await expect(popover(page)).not.toBeVisible();
});

test("shows empty state when no tools loaded", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => ({ tools: [], count: 0 }) },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	await waitForHydration(page);
	const btn = toolButton(page);
	await expect(btn).toContainText("0");

	await btn.click();
	await expect(page.getByText("No tools loaded")).toBeVisible();
});

test("tool icon shows active styling when popover is open", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => mockTools },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	const btn = toolButton(page);

	// Before click — class ends with transition-colors (no active suffix)
	await expect(btn).toHaveAttribute("class", /transition-colors\s*$/);

	await openPopover(page);

	// After click — class ends with "bg-gray-700 text-white"
	await expect(btn).toHaveAttribute("class", /bg-gray-700 text-white/);
});

test("tool descriptions appear as title attributes", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => mockTools },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	await openPopover(page);

	const scanEl = popover(page).locator('p[title="Scan code"]');
	await expect(scanEl).toBeVisible();
	await expect(scanEl).toContainText("scan");
});

test("handles API failure gracefully - shows 0 tools", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	const btn = toolButton(page);
	await expect(btn).toBeVisible();
	await expect(btn).toContainText("0");
});

test("displays token estimates per tool and per group", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => mockTools },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	await openPopover(page);

	// Per-tool token estimates (number followed by token icon SVG)
	await expect(popover(page).getByText("~25")).toBeVisible();
	await expect(popover(page).getByText("~22")).toBeVisible();
	await expect(popover(page).getByText("~30")).toBeVisible();

	// Group total for analyzer: 25+22=47
	const analyzerGroup = popover(page).locator('p.font-bold', { hasText: 'analyzer' }).first();
	await expect(analyzerGroup.getByText("47")).toBeVisible();
	// Group total for markdown-utils: 30
	const mdGroup = popover(page).locator('p.font-bold', { hasText: 'markdown-utils' });
	await expect(mdGroup.getByText("30")).toBeVisible();

	// Grand total: 25+22+30=77
	const totalRow = popover(page).locator('span.font-bold', { hasText: 'Total' });
	await expect(totalRow).toBeVisible();
	await expect(popover(page).locator('.border-t').getByText("77")).toBeVisible();
});

test("displays colored type badges per extension group", async ({ page, mockApi }) => {
	const typedTools = {
		tools: [
			{ name: "scan", description: "Scan code", extension: "analyzer", extensionType: "extension" },
			{ name: "chat", description: "Chat", extension: "my-agent", extensionType: "agent" },
			{ name: "query", description: "Query DB", extension: "db-server", extensionType: "mcp" },
		],
		count: 3,
	};
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => typedTools },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	await openPopover(page);

	const badges = popover(page).locator('[data-testid="type-badge"]');
	await expect(badges).toHaveCount(3);

	// Check badge text content
	const texts = await badges.allTextContents();
	expect(texts.sort()).toEqual(["agent", "extension", "mcp"]);

	// Check badge colors
	const agentBadge = popover(page).locator('[data-testid="type-badge"]', { hasText: "agent" });
	await expect(agentBadge).toHaveClass(/bg-purple-900/);

	const mcpBadge = popover(page).locator('[data-testid="type-badge"]', { hasText: "mcp" });
	await expect(mcpBadge).toHaveClass(/bg-blue-900/);

	const extBadge = popover(page).locator('[data-testid="type-badge"]', { hasText: "extension" });
	await expect(extBadge).toHaveClass(/bg-green-900/);
});
