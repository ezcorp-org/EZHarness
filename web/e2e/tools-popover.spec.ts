import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMode } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });

const mockTools = {
	tools: [
		{ name: "scan", description: "Scan code", extension: "analyzer", extensionType: "extension", extensionDescription: "Static analysis helpers", tokenEstimate: 25 },
		{ name: "lint", description: "Lint files", extension: "analyzer", extensionType: "extension", extensionDescription: "Static analysis helpers", tokenEstimate: 22 },
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

	// After click — active styling suffix (CSS-var theme tokens)
	await expect(btn).toHaveAttribute(
		"class",
		/bg-\[var\(--color-surface-tertiary\)\] text-\[var\(--color-text-primary\)\]/,
	);
});

test("hovering a tool row shows a popover with the tool name + description", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		routes: { "/api/tools": () => mockTools },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	await openPopover(page);

	const scanRow = popover(page).getByTestId("tool-row").filter({ hasText: "scan" }).first();
	await expect(scanRow).toBeVisible();
	await scanRow.hover();

	// Styled hover card (300ms delay): bold tool name + description text.
	// Scope by content — the header badge's own button tooltip may also be
	// open (the mouse passed over it when opening the popover).
	const tip = page.getByRole("tooltip").filter({ hasText: "Scan code" });
	await expect(tip).toBeVisible({ timeout: 3000 });
	await expect(tip).toContainText("scan");

	// Hovering the extension GROUP header shows the extension's description.
	const groupHeader = popover(page).getByTestId("ext-group-header").filter({ hasText: "analyzer" });
	await groupHeader.hover();
	const extTip = page.getByRole("tooltip").filter({ hasText: "Static analysis helpers" });
	await expect(extTip).toBeVisible({ timeout: 3000 });
	await expect(extTip).toContainText("analyzer");
});

test("handles API failure gracefully - shows 0 tools", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
	});
	// Registered after mockApi so it wins: a real 500 (mockApi route
	// overrides can only fulfill 200s).
	await page.route("**/api/tools*", (route) => route.fulfill({ status: 500, body: "boom" }));
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

// ── Mode-scoped listing ───────────────────────────────────────────────
// The header badge must mirror the runtime's mode tool surface: when a
// mode is active the listing request carries modeId/conversationId and
// the server returns ONLY the mode's tools. The mock mirrors the real
// endpoint's fallback order (explicit modeId > conversation's persisted
// modeId) — `analyzer` is the mode's attached extension, so a scoped
// request must drop `markdown-utils` entirely.
const scopedMode = makeMode({
	id: "mode-scoped",
	name: "Research",
	slug: "research",
	extensionIds: ["ext-analyzer"],
	extensionTools: null,
});

const analyzerOnly = {
	tools: mockTools.tools.filter((t) => t.extension === "analyzer"),
	count: 2,
};

function modeAwareToolsRoute(url: URL) {
	const scoped =
		url.searchParams.get("modeId") === "mode-scoped" ||
		url.searchParams.get("conversationId") === "conv-scoped";
	return scoped ? analyzerOnly : mockTools;
}

async function pickMode(page: import("@playwright/test").Page, name: RegExp) {
	await page.getByTestId("mode-selector").locator("button").first().click();
	await page.getByRole("option", { name }).click();
}

test("a conversation with a mode shows ONLY the mode's tools at first paint", async ({ page, mockApi }) => {
	const scopedConv = makeConversation({
		id: "conv-scoped",
		projectId: "proj-1",
		title: "Scoped Chat",
		modeId: "mode-scoped",
	});
	await mockApi({
		projects: [proj],
		conversations: [scopedConv],
		modes: [scopedMode],
		routes: { "/api/tools": modeAwareToolsRoute },
	});
	await page.goto(`/project/proj-1/chat/conv-scoped`);

	await waitForHydration(page);
	// Badge reflects the mode surface (2), not the full registry (3).
	await expect(toolButton(page)).toContainText("2", { timeout: 5000 });
	await toolButton(page).click();
	await expect(popover(page)).toBeVisible({ timeout: 3000 });

	// Exactly the mode's tools — and nothing else.
	await expect(popover(page).getByText("scan")).toBeVisible();
	await expect(popover(page).getByText("lint")).toBeVisible();
	await expect(popover(page).getByText("summarize")).not.toBeVisible();
	await expect(popover(page).getByText("markdown-utils")).not.toBeVisible();
	await expect(popover(page).getByTestId("tool-row")).toHaveCount(2);
});

test("picking a mode mid-session refetches and narrows the badge to the mode's tools", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		modes: [scopedMode],
		routes: { "/api/tools": modeAwareToolsRoute },
	});
	await page.goto(`/project/proj-1/chat/conv-1`);

	// Unscoped first paint: all 3 registered tools.
	await waitForHydration(page);
	await expect(toolButton(page)).toContainText("3", { timeout: 5000 });

	// Pick the Research mode from the composer — the badge must drop to the
	// mode's 2 tools without adding anything new.
	await pickMode(page, /Research/);
	await expect(toolButton(page)).toContainText("2", { timeout: 5000 });

	await toolButton(page).click();
	await expect(popover(page)).toBeVisible({ timeout: 3000 });
	await expect(popover(page).getByText("summarize")).not.toBeVisible();
	await expect(popover(page).getByTestId("tool-row")).toHaveCount(2);
	await page.getByTestId("tools-backdrop").click({ force: true });

	// Clearing back to Default restores the full listing (the client sends
	// an explicit empty modeId, so the stale persisted modeId can't win).
	await pickMode(page, /Default/);
	await expect(toolButton(page)).toContainText("3", { timeout: 5000 });
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
