/**
 * Composer suggestions — debounced tool chips + prompt-enhancement popover.
 *
 * RENDER-tier spec (mockApi; no real backend): drives the ChatInput wiring
 * against the mocked POST /api/composer/suggest and asserts the UX contract
 * the feature review flagged as make-or-break:
 *   - suggestions appear only after a typing pause on a long-enough draft
 *   - every chip is labelled extension-first ({extension} · {name})
 *   - the popover never fights the mention popover
 *   - clicking a chip wires the extension AND opens the inline-tool UI
 *     preselected to the clicked tool: the form opens directly (skipping the
 *     ToolPicker even when the extension exposes several tools), falling back
 *     to the picker only when the clicked tool is missing; Add invokes it
 *   - Apply/Undo round-trips the rewrite; Esc dismisses without re-nagging on
 *     the same draft, and closing the sub-tool form never re-nags either
 *   - sidecar-absent deployments get chips but no enhancement row
 *   - the request body always carries the authoritative modeId
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Suggest Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

const SUGGEST_TOOLS = [
	{ name: "scan", extension: "analyzer", extensionType: "extension", description: "Scan code for issues", score: 0.91 },
	{ name: "search", extension: "web-tools", extensionType: "extension", description: "Search the web", score: 0.62 },
	{ name: "task_create", extension: "ez", extensionType: "built-in", description: "Create a task", score: 0.5 },
];
const ENHANCEMENT = {
	enhanced: "Review the analyzer output and list the top three bugs with suggested fixes.",
	reason: "More specific and actionable",
};

const DRAFT = "please review my code for bugs";

// Bespoke tool sets returned by the per-spec `**/api/extensions/*/tools`
// override (see openSuggestionSubTool). The default fixture hands back a single
// `analyze` tool for every extension, so the preselect/picker branches MUST use
// these overrides or they silently exercise the wrong decision.
const SCAN_WITH_PARAM = [
	{
		name: "scan",
		description: "Scan a target for issues",
		inputSchema: {
			type: "object",
			properties: { target: { type: "string", description: "What to scan" } },
			required: ["target"],
		},
	},
	{ name: "lint", description: "Lint the codebase", inputSchema: { type: "object", properties: {} } },
];
const TOOLS_WITHOUT_SCAN = [
	{ name: "lint", description: "Lint the codebase", inputSchema: { type: "object", properties: {} } },
	{ name: "format", description: "Format the codebase", inputSchema: { type: "object", properties: {} } },
];
const SCAN_PARAMETERLESS = [
	{ name: "scan", description: "Scan the whole workspace", inputSchema: { type: "object", properties: {} } },
];

// A whole-extension suggestion (🧩 chip): accepting it wires the extension via
// `![ext:name]` and opens its inline-tool UI with NO preselect. file-organizer
// exposes MORE than one tool below so the no-preselect accept flow lands on the
// ToolPicker listbox — the default single-`analyze` mock would silently open the
// form instead, exercising the wrong branch (the plan's default-mock trap).
const SUGGEST_EXTENSION = { name: "file-organizer", description: "Keeps project folders tidy", score: 0.7 };
const FILE_ORGANIZER_TOOLS = [
	{ name: "organize", description: "Sort files into folders", inputSchema: { type: "object", properties: {} } },
	{ name: "archive", description: "Archive stale files", inputSchema: { type: "object", properties: {} } },
];

async function setupAndFocus(page: any, mockApi: any, composerSuggest: Record<string, unknown>) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [],
		composerSuggest,
	});
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

	const textarea = page.locator("textarea");
	// The WS mock's open event may race with app subscription — retry open
	// events until the composer enables (same idiom as mention-system.spec).
	await page.waitForFunction(() => {
		const listeners = (window as any).__fakeWsListeners;
		if (listeners?.open) {
			for (const fn of listeners.open) {
				// One throwing listener must not block the rest; the error
				// itself is irrelevant to the readiness poll.
				try { fn(new Event("open")); } catch (err) { void err; }
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

const popover = (page: any) => page.getByTestId("suggestion-popover");

// Pop the tool chips, then click the `scan` chip to enter the inline-tool flow.
// A per-spec `**/api/extensions/*/tools` override — registered AFTER mockApi so
// the last route wins (the shared-variables.spec idiom) — decides which tool set
// the clicked extension returns, so each test can drive a specific
// chooseInlineToolAction branch (preselect-hit form, preselect-miss picker,
// parameterless confirm).
async function openSuggestionSubTool(
	page: any,
	mockApi: any,
	extensionTools: Array<Record<string, unknown>>,
) {
	const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS });
	await page.route("**/api/extensions/*/tools", (route: any) => {
		route.fulfill({ json: { tools: extensionTools } });
	});
	await textarea.pressSequentially(DRAFT, { delay: 25 });
	await expect(popover(page)).toBeVisible({ timeout: 4000 });
	await page.locator('button[data-testid="suggestion-tool-chip"][data-tool="scan"]').click();
	return textarea;
}

test.describe("Composer suggestions", () => {
	test("typing pause pops ranked tool chips + enhancement @evidence", async ({ page, mockApi }, testInfo) => {
		const textarea = await setupAndFocus(page, mockApi, {
			tools: SUGGEST_TOOLS,
			enhancement: ENHANCEMENT,
		});
		await textarea.pressSequentially(DRAFT, { delay: 25 });

		// 600ms debounce + fetch + render — poll via toBeVisible.
		await expect(popover(page)).toBeVisible({ timeout: 4000 });
		const chips = page.getByTestId("suggestion-tool-chip");
		await expect(chips).toHaveCount(3);
		// Extension-first label ({extension} · {name}), 🔧 on the actionable chip.
		await expect(chips.nth(0)).toContainText("analyzer · scan");
		// Built-in chip renders informational (span, no button role).
		await expect(page.locator('span[data-testid="suggestion-tool-chip"][data-tool="task_create"]')).toBeVisible();
		// Enhancement row with Apply.
		await expect(page.getByTestId("suggestion-enhance-row")).toContainText(ENHANCEMENT.enhanced);
		await expect(page.getByTestId("suggestion-apply")).toBeVisible();

		await captureEvidence(page, testInfo, "composer-suggestions-popover");
	});

	test("short drafts never trigger the popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS });
		await textarea.pressSequentially("hi", { delay: 25 });
		await page.waitForTimeout(1000);
		await expect(popover(page)).not.toBeVisible();
	});

	test("suggestion chip opens the preselected sub-tool form, skipping the picker @evidence", async ({ page, mockApi }, testInfo) => {
		const textarea = await openSuggestionSubTool(page, mockApi, SCAN_WITH_PARAM);

		// The popover closes the moment the chip is chosen.
		await expect(popover(page)).not.toBeVisible();
		// The clicked extension is wired — assert the rendered overlay PILL, not
		// just the textarea projection (the pill IS the visible "wired" state).
		await expect(page.locator('[data-mention-kind="extension"][data-mention-name="analyzer"]')).toBeVisible();
		await expect(textarea).toHaveValue(/!analyzer/);
		// The extension exposes TWO tools, yet no picker appears: the chip
		// preselected `scan`, so chooseInlineToolAction jumped straight to the
		// form. (Both listbox surfaces — mention + ToolPicker — are absent.)
		await expect(page.locator('[role="listbox"]')).toHaveCount(0);
		// The form opens directly on the preselected tool, with its parameter.
		const form = page.locator("form");
		await expect(form).toContainText("analyzer");
		await expect(form).toContainText("scan");
		await expect(form.locator("#field-target")).toBeVisible();

		await captureEvidence(page, testInfo, "composer-suggestion-chip-param-form");
	});

	test("chip whose tool is missing from the extension falls back to the tool picker", async ({ page, mockApi }) => {
		await openSuggestionSubTool(page, mockApi, TOOLS_WITHOUT_SCAN);

		// Preselect name `scan` matches nothing in the returned set, so
		// chooseInlineToolAction falls through to the >1-tool picker.
		await expect(page.getByRole("listbox", { name: "Tools for analyzer" })).toBeVisible();
		// No tool was preselected, so the form must NOT have opened.
		await expect(page.locator('form button[type="submit"]')).not.toBeVisible();
	});

	test("parameterless suggested tool opens a confirm form and Add invokes it", async ({ page, mockApi }) => {
		await openSuggestionSubTool(page, mockApi, SCAN_PARAMETERLESS);

		let invokeBody: any = null;
		// No default mock for POST /api/tool-invoke — capture then 200 it.
		await page.route("**/api/tool-invoke", async (route: any) => {
			invokeBody = route.request().postDataJSON();
			await route.fulfill({ json: { ok: true } });
		});

		// An empty schema still surfaces as an explicit confirm step (per-tool-call
		// consent) — never fired straight off a speculative suggestion click.
		await expect(page.getByText("No parameters required — Add runs the tool.")).toBeVisible();
		await page.locator('form button[type="submit"]').click();

		await expect.poll(() => invokeBody, { timeout: 5000 }).not.toBeNull();
		expect(invokeBody.extensionName).toBe("analyzer");
		expect(invokeBody.toolName).toBe("scan");
		expect(invokeBody.input).toEqual({});
		// The fresh-conversation edge: the current conversation anchors the call.
		expect(typeof invokeBody.conversationId).toBe("string");
		expect(invokeBody.conversationId.length).toBeGreaterThan(0);
	});

	test("Escape closes the sub-tool form; the pill and draft survive without re-nagging", async ({ page, mockApi }) => {
		const textarea = await openSuggestionSubTool(page, mockApi, SCAN_WITH_PARAM);

		// Focus a form field so Escape reaches the form's own keydown handler —
		// the textarea's Escape only ever dismisses the suggestion popover.
		const field = page.locator("#field-target");
		await expect(field).toBeVisible();
		await field.focus();
		await field.press("Escape");

		// The form closes...
		await expect(page.locator('form button[type="submit"]')).not.toBeVisible();
		// ...but the wired extension pill and the drafted prose both survive.
		await expect(page.locator('[data-mention-kind="extension"][data-mention-name="analyzer"]')).toBeVisible();
		await expect(textarea).toHaveValue(/please review my code for bugs.*!analyzer/);

		// The chip-click path wired the draft programmatically (no input event),
		// so no fresh suggest cycle is scheduled — the popover stays closed.
		await page.waitForTimeout(900);
		await expect(popover(page)).not.toBeVisible();
	});

	test("Apply swaps the draft for the rewrite; Undo restores the original", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, {
			tools: SUGGEST_TOOLS,
			enhancement: ENHANCEMENT,
		});
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(page.getByTestId("suggestion-apply")).toBeVisible({ timeout: 4000 });

		await page.getByTestId("suggestion-apply").click();
		await expect(textarea).toHaveValue(ENHANCEMENT.enhanced);
		// Applied state offers Undo (visible mutation — reversible by design).
		await expect(page.getByTestId("suggestion-undo")).toBeVisible();
		await page.getByTestId("suggestion-undo").click();
		await expect(textarea).toHaveValue(DRAFT);
	});

	test("Escape dismisses and the same draft does not re-nag", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS });
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		await textarea.press("Escape");
		await expect(popover(page)).not.toBeVisible();
		// No re-appearance without a draft change.
		await page.waitForTimeout(900);
		await expect(popover(page)).not.toBeVisible();
	});

	test("mention popover always wins over suggestions", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS });
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		await textarea.pressSequentially(" !", { delay: 25 });
		await expect(page.locator("#mention-listbox")).toBeVisible({ timeout: 4000 });
		await expect(popover(page)).not.toBeVisible();
	});

	test("every suggestion chip is labelled extension-first @evidence", async ({ page, mockApi }, testInfo) => {
		const clash = (extension: string) => ({
			name: "weather-now",
			extension,
			extensionType: "extension",
			description: `Weather via ${extension}`,
			score: 0.5,
		});
		const textarea = await setupAndFocus(page, mockApi, {
			tools: [clash("open-meteo"), clash("weather-api"), SUGGEST_TOOLS[0], SUGGEST_TOOLS[2]],
		});
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		const chips = page.getByTestId("suggestion-tool-chip");
		await expect(chips).toHaveCount(4);
		// Actionable extension chips: 🔧 + extension-first label, even when two
		// share the short name `weather-now` (extension prefix disambiguates).
		await expect(chips.nth(0)).toHaveText(/^🔧 open-meteo · weather-now$/);
		await expect(chips.nth(1)).toHaveText(/^🔧 weather-api · weather-now$/);
		await expect(chips.nth(2)).toHaveText(/^🔧 analyzer · scan$/);
		await expect(chips.nth(2)).toHaveAttribute("data-extension", "analyzer");
		// Built-in chip: informational span (no 🔧, no button role), extension-first.
		const builtin = page.locator('span[data-testid="suggestion-tool-chip"][data-tool="task_create"]');
		await expect(builtin).toHaveText(/^ez · task_create$/);
		await expect(builtin).toHaveAttribute("data-extension", "ez");

		await captureEvidence(page, testInfo, "composer-suggestions-chip-ext-prefix");
	});

	test("sidecar absent: chips render, enhancement row does not", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, {
			tools: SUGGEST_TOOLS,
			enhancement: null,
			llmAvailable: false,
		});
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });
		await expect(page.getByTestId("suggestion-enhance-row")).not.toBeVisible();
		await expect(page.getByTestId("suggestion-apply")).not.toBeVisible();
	});

	test("suggest requests carry the authoritative modeId and split includes", async ({ page, mockApi }) => {
		const bodies: Array<Record<string, unknown>> = [];
		const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS, enhancement: ENHANCEMENT });
		// Registered AFTER mockApi → takes precedence; record then fall through.
		await page.route("**/api/composer/suggest", async (route: any) => {
			bodies.push(route.request().postDataJSON());
			await route.fallback();
		});

		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		expect(bodies.length).toBeGreaterThanOrEqual(2);
		const includes = bodies.map((b) => (b.include as string[]).join(",")).sort();
		// The fast half now bundles tool chips AND whole-extension chips in a
		// single round-trip (include:["tools","extensions"]); the enhance rewrite
		// stays its own slower call (include:["enhance"]).
		expect(includes).toContain("tools,extensions");
		expect(includes).toContain("enhance");
		for (const body of bodies) {
			expect(body).toHaveProperty("modeId", null); // no mode selected → explicit null
			expect(body.conversationId).toBe(conv.id);
			// Per-project toggle fallback rides along (server prefers the
			// conversation's own project when it resolves).
			expect(body.projectId).toBe(proj.id);
			expect(body.draft).toBe(DRAFT);
		}
	});

	test("draft suggests a whole extension; accepting wires it and opens its tool UI @evidence", async ({ page, mockApi }, testInfo) => {
		const textarea = await setupAndFocus(page, mockApi, {
			tools: SUGGEST_TOOLS,
			extensions: [SUGGEST_EXTENSION],
		});
		// file-organizer exposes TWO tools → the no-preselect accept flow must land
		// on the ToolPicker, not a form. Registered AFTER mockApi so the last route
		// wins (overriding the default single-`analyze` mock).
		await page.route("**/api/extensions/*/tools", (route: any) => {
			route.fulfill({ json: { tools: FILE_ORGANIZER_TOOLS } });
		});
		// Capture every feedback event so we can assert the `accepted` telemetry.
		const feedback: Array<Record<string, unknown>> = [];
		await page.route("**/api/composer/suggest/feedback", async (route: any) => {
			feedback.push(route.request().postDataJSON());
			await route.fulfill({ status: 201, json: { ok: true } });
		});

		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		// The 🧩 extension chip renders ALONGSIDE the 🔧 tool chips — a distinct
		// testid, `🧩 {name}` label, and a title carrying the description.
		const extChip = page.locator('button[data-testid="suggestion-extension-chip"][data-extension="file-organizer"]');
		await expect(extChip).toHaveText("🧩 file-organizer");
		await expect(extChip).toHaveAttribute("title", /Keeps project folders tidy/);
		// Tool chips are still present — the extension chip is additive.
		await expect(page.getByTestId("suggestion-tool-chip")).toHaveCount(3);

		await extChip.click();

		// The popover closes the moment the extension is accepted.
		await expect(popover(page)).not.toBeVisible();
		// The extension is wired — assert the rendered overlay PILL (the pill IS
		// the visible "wired" state), and the `![ext:…]` token in the draft.
		await expect(page.locator('[data-mention-kind="extension"][data-mention-name="file-organizer"]')).toBeVisible();
		await expect(textarea).toHaveValue(/!file-organizer/);
		// A whole-extension chip names no specific tool, so with >1 tool the picker
		// opens (no preselect) rather than jumping straight to a form.
		await expect(page.getByRole("listbox", { name: "Tools for file-organizer" })).toBeVisible();
		// The accept telemetry is extension-kinded and carries the extension name.
		await expect
			.poll(() => feedback.find((f) => f.kind === "extension" && f.action === "accepted"), { timeout: 5000 })
			.toMatchObject({ kind: "extension", action: "accepted", toolName: "file-organizer" });

		await captureEvidence(page, testInfo, "composer-suggestion-extension-chip");
	});

	test("extensions-only response still opens the popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, {
			tools: [],
			extensions: [SUGGEST_EXTENSION],
		});
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		// Only the 🧩 extension chip — an all-empty tool list must not suppress the
		// popover when a whole-extension match remains.
		await expect(page.getByTestId("suggestion-extension-chip")).toHaveCount(1);
		await expect(page.getByTestId("suggestion-tool-chip")).toHaveCount(0);
	});

	test("Escape with extension chips posts extension dismissed without re-nagging", async ({ page, mockApi }) => {
		const feedback: Array<Record<string, unknown>> = [];
		const textarea = await setupAndFocus(page, mockApi, {
			tools: SUGGEST_TOOLS,
			extensions: [SUGGEST_EXTENSION],
		});
		await page.route("**/api/composer/suggest/feedback", async (route: any) => {
			feedback.push(route.request().postDataJSON());
			await route.fulfill({ status: 201, json: { ok: true } });
		});

		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		await textarea.press("Escape");
		await expect(popover(page)).not.toBeVisible();
		// Dismiss emits an extension-scoped `dismissed` event — fired under the same
		// guard as the tool `dismissed`, because the response carried 🧩 chips.
		await expect
			.poll(() => feedback.find((f) => f.kind === "extension" && f.action === "dismissed"), { timeout: 5000 })
			.toMatchObject({ kind: "extension", action: "dismissed" });
		// Same draft, no change → no re-nag (existing 900ms idiom).
		await page.waitForTimeout(900);
		await expect(popover(page)).not.toBeVisible();
	});
});
