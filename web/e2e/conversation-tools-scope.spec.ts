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

test("first paint inherits the conversation's mode → popover shows the inherited tools without picking a mode", async ({ page, mockApi }) => {
	// The conversation already carries `modeId`; the user has NOT touched the
	// Mode selector this session. The composer Tools popover must still render
	// the inherited extension/tools (not the empty "no mode" state) at first
	// paint — that is the Issue-1 regression this guards.
	const seededConv = makeConversation({
		id: "conv-1",
		projectId: "proj-1",
		title: "Scoped Chat",
		modeId: "mode-scoped",
	});

	await mockApi({
		projects: [proj],
		conversations: [seededConv],
		modes: [mode],
		extensions: [extension],
	});
	await page.goto("/project/proj-1/chat/conv-1");
	await page.waitForLoadState("networkidle");

	// Open the Tools popover WITHOUT first selecting the mode.
	await toolsTrigger(page).click();
	const popover = page.getByTestId("conversation-tools-popover");
	await expect(popover).toBeVisible();

	// Inherited baseline is shown: not the empty state, both tools present.
	await expect(page.getByTestId("conversation-tools-empty")).toHaveCount(0);
	await expect(page.getByTestId("conversation-tools-state")).toContainText("Inherited");
	await expect(page.getByTestId("conv-tool-ext-tools-alpha")).toBeChecked();
	await expect(page.getByTestId("conv-tool-ext-tools-beta")).toBeChecked();
});

test("no mode: dropdown lists installed extensions' tools; toggling narrows + refreshes the header badge", async ({ page, mockApi }) => {
	// The real /api/tools recomputes the listing from conv.extensionTools;
	// the mock mirrors that by flipping to the narrowed set once the
	// narrowing PUT lands.
	let narrowed = false;
	const fullListing = {
		tools: [
			{ name: "alpha", description: "Alpha", extension: "Toolbox", extensionType: "extension" },
			{ name: "beta", description: "Beta", extension: "Toolbox", extensionType: "extension" },
		],
		count: 2,
	};
	const narrowedListing = { tools: [fullListing.tools[0]], count: 1 };

	await mockApi({
		projects: [proj],
		conversations: [conv],
		modes: [mode],
		extensions: [extension],
		routes: { "/api/tools": () => (narrowed ? narrowedListing : fullListing) },
	});
	await page.route("**/api/conversations/conv-1", async (route) => {
		if (route.request().method() === "PUT") narrowed = true;
		await route.fallback();
	});
	await page.goto("/project/proj-1/chat/conv-1");
	await page.waitForLoadState("networkidle");

	// No mode picked — the header badge shows the full surface.
	const headerBadge = page.locator('button[aria-label^="Loaded tools"]');
	await expect(headerBadge).toContainText("2");

	// The dropdown is NOT the old empty state: it lists the installed
	// extension's tools with the all-extensions baseline.
	await toolsTrigger(page).click();
	await expect(page.getByTestId("conversation-tools-popover")).toBeVisible();
	await expect(page.getByTestId("conversation-tools-empty")).toHaveCount(0);
	await expect(page.getByTestId("conversation-tools-state")).toContainText("All extensions");
	const beta = page.getByTestId("conv-tool-ext-tools-beta");
	await expect(beta).toBeChecked();

	// Uncheck beta → persists per-conversation; the header badge refetches
	// the (server-narrowed) listing and drops to 1.
	await beta.uncheck();
	await expect(page.getByTestId("conversation-tools-state")).toContainText("Customized");
	await expect(headerBadge).toContainText("1", { timeout: 5000 });
});

test("master toggle: switching an extension OFF persists {ext: []} and the header badge drops its tools", async ({ page, mockApi }) => {
	// Stateful /api/tools mock mirroring the real endpoint: while the
	// extension is toggled off (conv.extensionTools = {ext-tools: []}) its
	// tools vanish from the listing.
	let extOff = false;
	const fullListing = {
		tools: [
			{ name: "alpha", description: "Alpha", extension: "Toolbox", extensionType: "extension" },
			{ name: "beta", description: "Beta", extension: "Toolbox", extensionType: "extension" },
		],
		count: 2,
	};
	let lastPutBody: Record<string, unknown> | null = null;

	await mockApi({
		projects: [proj],
		conversations: [conv],
		modes: [mode],
		extensions: [extension],
		routes: { "/api/tools": () => (extOff ? { tools: [], count: 0 } : fullListing) },
	});
	await page.route("**/api/conversations/conv-1", async (route) => {
		if (route.request().method() === "PUT") {
			lastPutBody = route.request().postDataJSON() as Record<string, unknown>;
			const map = (lastPutBody as { extensionTools?: Record<string, string[]> | null }).extensionTools;
			extOff = !!map && Array.isArray(map["ext-tools"]) && map["ext-tools"].length === 0;
		}
		await route.fallback();
	});
	await page.goto("/project/proj-1/chat/conv-1");
	await page.waitForLoadState("networkidle");

	const headerBadge = page.locator('button[aria-label^="Loaded tools"]');
	await expect(headerBadge).toContainText("2");

	// Flip the extension's master toggle off (no mode active).
	await toolsTrigger(page).click();
	const master = page.getByTestId("conv-ext-toggle-ext-tools");
	await expect(master).toBeChecked();
	await master.uncheck();

	// Persisted as the explicit OFF marker, both tool rows uncheck, and the
	// header badge refetches down to 0.
	await expect.poll(() => lastPutBody).not.toBeNull();
	expect(lastPutBody!.extensionTools).toEqual({ "ext-tools": [] });
	await expect(page.getByTestId("conv-tool-ext-tools-alpha")).not.toBeChecked();
	await expect(page.getByTestId("conv-tool-ext-tools-beta")).not.toBeChecked();
	await expect(headerBadge).toContainText("0", { timeout: 5000 });

	// Toggle back on → key removed (inherit) and the badge recovers.
	await master.check();
	await expect.poll(() => lastPutBody?.extensionTools).toEqual({});
	await expect(headerBadge).toContainText("2", { timeout: 5000 });
});

test("ask-user (orchestration) is listed and toggleable under a mode that doesn't attach it", async ({ page, mockApi }) => {
	// The Research mode attaches only ext-tools, yet ask-user rides through
	// the allowlist (ORCHESTRATION_TOOLS) — so it must appear in the badge
	// AND in the dropdown, and the explicit conversation toggle must remove
	// it. The stateful /api/tools mock mirrors the real endpoint.
	const askUserExt = {
		id: "ext-askuser",
		name: "ask-user",
		description: "Human in the loop",
		manifest: { tools: [{ name: "ask_user_question" }] },
	};
	let askUserOff = false;
	const listing = () => ({
		tools: [
			{ name: "alpha", description: "Alpha", extension: "Toolbox", extensionType: "extension" },
			{ name: "beta", description: "Beta", extension: "Toolbox", extensionType: "extension" },
			...(askUserOff
				? []
				: [{ name: "ask_user_question", description: "Ask the user", extension: "ask-user", extensionType: "extension" }]),
		],
		count: askUserOff ? 2 : 3,
		orchestrationTools: ["ask-user__ask_user_question"],
	});
	let lastPutBody: Record<string, unknown> | null = null;

	const seededConv = makeConversation({
		id: "conv-1",
		projectId: "proj-1",
		title: "Orch Chat",
		modeId: "mode-scoped",
	});
	await mockApi({
		projects: [proj],
		conversations: [seededConv],
		modes: [mode],
		extensions: [extension, askUserExt],
		routes: { "/api/tools": listing },
	});
	await page.route("**/api/conversations/conv-1", async (route) => {
		if (route.request().method() === "PUT") {
			lastPutBody = route.request().postDataJSON() as Record<string, unknown>;
			const map = (lastPutBody as { extensionTools?: Record<string, string[]> | null }).extensionTools;
			askUserOff = !!map && Array.isArray(map["ext-askuser"]) && map["ext-askuser"].length === 0;
		}
		await route.fallback();
	});
	await page.goto("/project/proj-1/chat/conv-1");
	await page.waitForLoadState("networkidle");

	const headerBadge = page.locator('button[aria-label^="Loaded tools"]');
	await expect(headerBadge).toContainText("3");

	// The dropdown lists BOTH the mode's extension and ask-user.
	await toolsTrigger(page).click();
	await expect(page.getByTestId("conv-tool-ext-tools-alpha")).toBeChecked();
	const askUserMaster = page.getByTestId("conv-ext-toggle-ext-askuser");
	await expect(askUserMaster).toBeChecked();
	await expect(page.getByTestId("conv-tool-ext-askuser-ask_user_question")).toBeChecked();

	// Toggle ask-user off → persisted as {ext-askuser: []}, badge drops to 2.
	await askUserMaster.uncheck();
	await expect.poll(() => lastPutBody?.extensionTools).toEqual({ "ext-askuser": [] });
	await expect(headerBadge).toContainText("2", { timeout: 5000 });

	// And back on — badge recovers.
	await askUserMaster.check();
	await expect.poll(() => lastPutBody?.extensionTools).toEqual({});
	await expect(headerBadge).toContainText("3", { timeout: 5000 });
});

test("a DISABLED orchestration extension (scratchpad) is not listed; enabled ask-user still is", async ({ page, mockApi }) => {
	// Regression guard: a disabled scratchpad extension used to show a checked
	// toggle under a mode because the client appended any extension whose name
	// looked orchestration-ish. Now (a) disabled extensions are excluded and
	// (b) orchestration extensions only ride through when their namespaced
	// tool names appear in /api/tools' orchestrationTools (which the server
	// intersects with actually-registered tools).
	const askUserExt = {
		id: "ext-askuser",
		name: "ask-user",
		description: "Human in the loop",
		manifest: { tools: [{ name: "ask_user_question" }] },
	};
	const scratchpadExt = {
		id: "ext-scratchpad",
		name: "scratchpad",
		description: "Scratch",
		enabled: false,
		manifest: { tools: [{ name: "scratchpad_write" }] },
	};
	// The server never registered scratchpad's tools, so the listing carries
	// neither its tools nor its namespaced orchestration names.
	const listing = {
		tools: [
			{ name: "alpha", description: "Alpha", extension: "Toolbox", extensionType: "extension" },
			{ name: "beta", description: "Beta", extension: "Toolbox", extensionType: "extension" },
			{ name: "ask_user_question", description: "Ask the user", extension: "ask-user", extensionType: "extension" },
		],
		count: 3,
		orchestrationTools: ["ask-user__ask_user_question"],
	};

	const seededConv = makeConversation({
		id: "conv-1",
		projectId: "proj-1",
		title: "Orch Chat",
		modeId: "mode-scoped",
	});
	await mockApi({
		projects: [proj],
		conversations: [seededConv],
		modes: [mode],
		extensions: [extension, askUserExt, scratchpadExt],
		routes: { "/api/tools": () => listing },
	});
	await page.goto("/project/proj-1/chat/conv-1");
	await page.waitForLoadState("networkidle");

	await toolsTrigger(page).click();
	await expect(page.getByTestId("conversation-tools-popover")).toBeVisible();

	// Enabled ask-user rides through the orchestration allowlist.
	const askUserMaster = page.getByTestId("conv-ext-toggle-ext-askuser");
	await expect(askUserMaster).toBeVisible();
	await expect(askUserMaster).toBeChecked();

	// Disabled scratchpad is absent entirely — no master toggle, no tool row.
	await expect(page.getByTestId("conv-ext-toggle-ext-scratchpad")).toHaveCount(0);
	await expect(page.getByTestId("conv-tool-ext-scratchpad-scratchpad_write")).toHaveCount(0);
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
