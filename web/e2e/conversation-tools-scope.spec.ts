/**
 * Phase 4 (D) — per-conversation tool scoping from the chat composer.
 *
 * Picks a mode with an attached extension, opens the 🔧 Tools popover,
 * deselects a tool (→ PUT /api/conversations/[id] with the narrowed map),
 * and asserts the narrowed map persists (the in-memory mock now mutates the
 * conversation so a reload's GET reflects it). Reset clears the override
 * (→ PUT extensionTools:null).
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMode } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Scoped Chat" });

// A mode that attaches one extension exposing two tools.
const mode = makeMode({
	id: "mode-scoped",
	name: "Research",
	slug: "research",
	extensionIds: ["ext-tools"],
	extensionTools: null,
});

const extension = {
	id: "ext-tools",
	name: "Toolbox",
	description: "Two tools",
	manifest: { tools: [{ name: "alpha" }, { name: "beta" }] },
};

function toolsTrigger(page: import("@playwright/test").Page) {
	return page.getByTestId("conversation-tools-trigger");
}

async function pickMode(page: import("@playwright/test").Page) {
	// Open the Mode selector and choose the Research mode so `selectedMode`
	// populates the Tools popover's inherited baseline.
	await page.getByTestId("mode-selector").locator("button").first().click();
	await page.getByRole("option", { name: /Research/ }).click();
}

test("deselect a tool narrows the conversation; PUT carries the map; Reset clears it", async ({ page, mockApi }) => {
	let lastPutBody: Record<string, unknown> | null = null;
	page.on("request", (req) => {
		if (req.method() === "PUT" && /\/api\/conversations\/conv-1$/.test(req.url())) {
			lastPutBody = req.postDataJSON() as Record<string, unknown>;
		}
	});

	await mockApi({
		projects: [proj],
		conversations: [conv],
		modes: [mode],
		extensions: [extension],
	});
	await page.goto("/project/proj-1/chat/conv-1");
	await page.waitForLoadState("networkidle");

	await pickMode(page);

	// Open the Tools popover; both tools checked by default (inherited).
	await toolsTrigger(page).click();
	const popover = page.getByTestId("conversation-tools-popover");
	await expect(popover).toBeVisible();
	const beta = page.getByTestId("conv-tool-ext-tools-beta");
	await expect(beta).toBeChecked();
	await expect(page.getByTestId("conversation-tools-state")).toContainText("Inherited");

	// Deselect beta → narrows to [alpha], persisted via PUT.
	await beta.uncheck();
	await expect.poll(() => lastPutBody).not.toBeNull();
	expect((lastPutBody as any).extensionTools).toEqual({ "ext-tools": ["alpha"] });
	await expect(page.getByTestId("conversation-tools-state")).toContainText("Customized");

	// Reset → clears the override (null).
	lastPutBody = null;
	await page.getByTestId("conversation-tools-reset").click();
	await expect.poll(() => lastPutBody).not.toBeNull();
	expect((lastPutBody as any).extensionTools).toBeNull();
});

test("narrowed selection survives a reload (conversation GET reflects it)", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		modes: [mode],
		extensions: [extension],
	});
	await page.goto("/project/proj-1/chat/conv-1");
	await page.waitForLoadState("networkidle");

	await pickMode(page);
	await toolsTrigger(page).click();
	await page.getByTestId("conv-tool-ext-tools-beta").uncheck();
	// Confirm the narrowed map was customized in this session.
	await expect(page.getByTestId("conversation-tools-state")).toContainText("Customized");

	// Reload: re-pick the mode and re-open — the conversation GET now carries
	// the persisted override, so beta stays unchecked.
	await page.reload();
	await page.waitForLoadState("networkidle");
	await pickMode(page);
	await toolsTrigger(page).click();
	await expect(page.getByTestId("conv-tool-ext-tools-alpha")).toBeChecked();
	await expect(page.getByTestId("conv-tool-ext-tools-beta")).not.toBeChecked();
	await expect(page.getByTestId("conversation-tools-state")).toContainText("Customized");
});
