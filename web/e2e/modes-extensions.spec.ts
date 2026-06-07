/**
 * Phase modes.extensionIds — settings flow with the ExtensionSearchPicker.
 *
 * Covers:
 *   1. Create flow on /settings#modes — Tools & Extensions picker visible
 *      (legacy Tool Restriction <select> gone), attach extensions, save,
 *      new card surfaces the "{n} extensions" badge.
 *   2. View mode (custom) — chip strip shows the attached extensions
 *      read-only, header Edit button is enabled.
 *   3. Edit mode — flip to edit, modify selection, save; PUT body
 *      reflects the new extensionIds.
 *   4. View mode (builtin) — Edit button disabled and wrapped in a
 *      Tooltip that surfaces "Built-in modes cannot be edited." on hover.
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeMode, type ModeData } from "./fixtures/data.js";

const PROJECT = makeProject({ id: "proj-modes-ext", name: "Modes Ext Project" });

const SEEDED_BUILTIN = makeMode({
	id: "builtin-plan",
	name: "Plan",
	slug: "plan",
	icon: "\u{1F4CB}",
	description: "Plan without coding",
	systemPromptInstruction: "You are in planning mode.",
	toolRestriction: "read-only",
	extensionIds: null,
	builtin: true,
});

const SEEDED_CUSTOM = makeMode({
	id: "custom-with-exts",
	name: "Custom Attached",
	slug: "custom-attached",
	icon: "\u{1F517}",
	description: "Mode with two attached extensions",
	systemPromptInstruction: "Use only the attached tools.",
	toolRestriction: "all",
	extensionIds: ["ext-a", "ext-b"],
	builtin: false,
});

const EXTENSIONS_FIXTURE = [
	{ id: "ext-a", name: "Extension A", description: "Provides analysis tools" },
	{ id: "ext-b", name: "Extension B", description: "Provides formatting tools" },
	{ id: "ext-c", name: "Extension C", description: "Provides code-search tools" },
];

test.describe("Modes settings — Tools & Extensions picker flow", () => {
	test("create flow: picker visible (no legacy select), attach extension, save → card shows extensions badge", async ({ page, mockApi }) => {
		// Mutable list so the post-save GET reflects the create.
		const dynamicModes: ModeData[] = [SEEDED_BUILTIN];

		await mockApi({
			projects: [PROJECT],
			modes: dynamicModes,
			extensions: EXTENSIONS_FIXTURE,
		});

		// Override AFTER mockApi so our handler wins on /api/modes —
		// the fixture's POST handler echoes the body but never mutates
		// the modes array, so a subsequent GET would still return the
		// original list. We need the new mode to surface in the card list.
		await page.route("**/api/modes", async (route) => {
			const method = route.request().method();
			if (method === "POST") {
				const body = route.request().postDataJSON() as Record<string, unknown>;
				const created = makeMode({
					id: "new-mode-1",
					name: body.name as string,
					slug: body.slug as string,
					icon: (body.icon as string) ?? null,
					description: (body.description as string) ?? "",
					systemPromptInstruction: body.systemPromptInstruction as string,
					instructionPosition: (body.instructionPosition as ModeData["instructionPosition"]) ?? "prepend",
					extensionIds: (body.extensionIds as string[]) ?? null,
					toolRestriction: "all",
					builtin: false,
				});
				dynamicModes.push(created);
				return route.fulfill({ status: 201, json: created });
			}
			if (method === "GET") {
				return route.fulfill({ json: dynamicModes });
			}
			return route.fallback();
		});

		await page.goto("/settings#modes");

		// Modes section visible.
		await expect(page.locator("#modes")).toBeVisible({ timeout: 5000 });

		// Open create modal.
		await page.locator("#modes").getByRole("button", { name: "Create Mode" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });

		// New label visible, legacy label gone (regression guard for
		// the swap from <select> Tool Restriction → ExtensionSearchPicker).
		await expect(dialog.getByText("Tools & Extensions")).toBeVisible();
		await expect(dialog.getByText("Tool Restriction")).toHaveCount(0);

		// Picker chrome present.
		const combobox = dialog.getByTestId("extension-picker-combobox");
		await expect(combobox).toBeVisible();

		// Fill the required text fields. `oninput` on the name field
		// auto-populates the slug for create mode.
		await dialog.locator("#mode-form-name").fill("My Custom Mode");
		await dialog.locator("#mode-form-system-prompt").fill("Be a focused tester.");

		// Open the picker and toggle Extension A on.
		await combobox.locator("input[role='combobox']").click();
		// The dropdown listbox is portaled (position:fixed) but still in
		// the DOM as a sibling — query by its id for stability.
		const listbox = page.locator("#extension-picker-listbox");
		await expect(listbox).toBeVisible({ timeout: 2000 });
		await listbox.getByRole("button").filter({ hasText: "Extension A" }).click();

		// Pill appears in the combobox chrome.
		await expect(combobox.getByTestId("selected-pill")).toHaveCount(1);
		await expect(combobox).toContainText("Extension A");

		// Submit. The POST body must include extensionIds:["ext-a"]; we
		// also assert it via a request-spy below.
		let postBody: Record<string, unknown> | null = null;
		page.on("request", (req) => {
			if (req.method() === "POST" && req.url().endsWith("/api/modes")) {
				postBody = req.postDataJSON() as Record<string, unknown>;
			}
		});

		await dialog.getByRole("button", { name: "Create Mode" }).last().click();
		await expect(dialog).not.toBeVisible({ timeout: 3000 });

		// New card visible with the "{n} extensions" badge.
		const newCard = page
			.locator("#modes")
			.locator("button", { hasText: "My Custom Mode" })
			.first();
		await expect(newCard).toBeVisible({ timeout: 5000 });
		await expect(newCard.getByText(/1 extension/)).toBeVisible();

		// POST body assertions: extensionIds present, legacy field absent.
		expect(postBody).not.toBeNull();
		expect((postBody as any).extensionIds).toEqual(["ext-a"]);
		expect((postBody as any).toolRestriction).toBeUndefined();
	});

	test("view mode (custom): chip strip surfaces attached extensions, Edit enabled, no Save Changes", async ({ page, mockApi }) => {
		await mockApi({
			projects: [PROJECT],
			modes: [SEEDED_BUILTIN, SEEDED_CUSTOM],
			extensions: EXTENSIONS_FIXTURE,
		});

		await page.goto("/settings#modes");
		// Click the custom card to open VIEW mode (the card itself is the
		// view trigger; the Edit button is the modal header action).
		await page.locator(`button[aria-label="View ${SEEDED_CUSTOM.name} mode"]`).click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await expect(dialog.locator("h2")).toHaveText("View Mode");

		// Read-only chip strip with one chip per attached extensionId.
		const chips = dialog.getByTestId("mode-readonly-extension-chips");
		await expect(chips).toBeVisible();
		await expect(chips.locator("> *")).toHaveCount(2);
		// Names resolve via the picker's onMount fetch — chips show the
		// human name, not the raw id.
		await expect(chips).toContainText("Extension A");
		await expect(chips).toContainText("Extension B");

		// Interactive picker MUST NOT mount in readonly view.
		await expect(dialog.getByTestId("extension-picker-combobox")).toHaveCount(0);

		// Footer: Close-only action (no Save Changes / Cancel). Two
		// elements have the "Close" label — the X icon button in the
		// header AND the footer text button. Pin the footer one explicitly
		// to avoid strict-mode ambiguity.
		await expect(dialog.getByText("Close", { exact: true })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Save Changes" })).toHaveCount(0);

		// Header Edit button is enabled (custom, not builtin).
		const editBtn = dialog.locator('button[aria-label="Edit mode"]');
		await expect(editBtn).toBeVisible();
		await expect(editBtn).toBeEnabled();
	});

	test("edit flow: flip to edit, modify selection, save → PUT body carries new extensionIds", async ({ page, mockApi }) => {
		const dynamicModes: ModeData[] = [SEEDED_BUILTIN, { ...SEEDED_CUSTOM }];

		await mockApi({
			projects: [PROJECT],
			modes: dynamicModes,
			extensions: EXTENSIONS_FIXTURE,
		});

		// Maintain the modes array across the PUT round-trip.
		let putBody: Record<string, unknown> | null = null;
		await page.route("**/api/modes/*", async (route) => {
			const method = route.request().method();
			const url = new URL(route.request().url());
			const id = url.pathname.split("/").pop()!;
			if (method === "PUT") {
				putBody = route.request().postDataJSON() as Record<string, unknown>;
				const idx = dynamicModes.findIndex((m) => m.id === id);
				if (idx >= 0) {
					dynamicModes[idx] = { ...dynamicModes[idx]!, ...putBody } as ModeData;
					return route.fulfill({ json: dynamicModes[idx] });
				}
				return route.fulfill({ status: 404, json: { error: "Not found" } });
			}
			if (method === "GET") {
				const mode = dynamicModes.find((m) => m.id === id);
				return route.fulfill(mode ? { json: mode } : { status: 404, json: { error: "Not found" } });
			}
			return route.fallback();
		});
		await page.route("**/api/modes", async (route) => {
			if (route.request().method() === "GET") {
				return route.fulfill({ json: dynamicModes });
			}
			return route.fallback();
		});

		await page.goto("/settings#modes");
		await page.locator(`button[aria-label="View ${SEEDED_CUSTOM.name} mode"]`).click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });

		// Click header Edit → flip into edit mode (interactive picker mounts).
		await dialog.locator('button[aria-label="Edit mode"]').click();
		await expect(dialog.locator("h2")).toHaveText("Edit Mode");

		const combobox = dialog.getByTestId("extension-picker-combobox");
		await expect(combobox).toBeVisible();
		// Existing selection rendered as pills.
		await expect(combobox.getByTestId("selected-pill")).toHaveCount(2);

		// Remove Extension A via its pill ×. The remove handler fires on
		// `mousedown` (SelectedPill.handleMouseDown); a full `.click()` also
		// triggers svelte-dnd-action's pointer-drag init on the chip row,
		// which re-syncs the items and swallows the removal. Dispatching
		// mousedown directly matches the handler without starting a drag.
		const aPill = combobox.getByTestId("selected-pill").filter({ hasText: "Extension A" });
		await aPill.getByRole("button", { name: /remove extension a/i }).dispatchEvent("mousedown");
		await expect(combobox.getByTestId("selected-pill")).toHaveCount(1);

		// Add Extension C from the dropdown.
		await combobox.locator("input[role='combobox']").click();
		const listbox = page.locator("#extension-picker-listbox");
		await expect(listbox).toBeVisible({ timeout: 2000 });
		await listbox.getByRole("button").filter({ hasText: "Extension C" }).click();
		await expect(combobox.getByTestId("selected-pill")).toHaveCount(2);

		// Save Changes.
		await dialog.getByRole("button", { name: "Save Changes" }).click();
		await expect(dialog).not.toBeVisible({ timeout: 3000 });

		// PUT body assertions.
		expect(putBody).not.toBeNull();
		const sent = (putBody as any).extensionIds as string[];
		expect(Array.isArray(sent)).toBe(true);
		expect(sent.sort()).toEqual(["ext-b", "ext-c"]);

		// Re-open the same card and verify the chip strip reflects the
		// persisted change. (The PUT route mutated dynamicModes, the
		// next GET returns the new state.)
		await page.locator(`button[aria-label="View ${SEEDED_CUSTOM.name} mode"]`).click();
		const reopenedChips = page.getByRole("dialog").getByTestId("mode-readonly-extension-chips");
		await expect(reopenedChips).toBeVisible();
		await expect(reopenedChips).toContainText("Extension B");
		await expect(reopenedChips).toContainText("Extension C");
		await expect(reopenedChips).not.toContainText("Extension A");
	});

	test("edit flow: deselect a tool → PUT body carries extensionTools subset, persists on reopen", async ({ page, mockApi }) => {
		// Extension exposing two tools so we can narrow to one. The mock
		// returns this array verbatim at GET /api/extensions, so the
		// per-tool selector reads manifest.tools from it.
		const EXTENSIONS_WITH_TOOLS = [
			{
				id: "ext-tools",
				name: "Toolbox",
				description: "Two tools",
				manifest: { tools: [{ name: "alpha", description: "first" }, { name: "beta", description: "second" }] },
			},
		];
		const SEEDED_TOOLS_MODE = makeMode({
			id: "mode-tools",
			name: "Tool Subset Mode",
			slug: "tool-subset-mode",
			description: "Narrowable tools",
			systemPromptInstruction: "Only some tools.",
			toolRestriction: "all",
			extensionIds: ["ext-tools"],
			extensionTools: null, // starts as "all tools"
			builtin: false,
		});

		const dynamicModes: ModeData[] = [SEEDED_BUILTIN, { ...SEEDED_TOOLS_MODE }];

		await mockApi({
			projects: [PROJECT],
			modes: dynamicModes,
			extensions: EXTENSIONS_WITH_TOOLS,
		});

		let putBody: Record<string, unknown> | null = null;
		await page.route("**/api/modes/*", async (route) => {
			const method = route.request().method();
			const url = new URL(route.request().url());
			const id = url.pathname.split("/").pop()!;
			if (method === "PUT") {
				putBody = route.request().postDataJSON() as Record<string, unknown>;
				const idx = dynamicModes.findIndex((m) => m.id === id);
				if (idx >= 0) {
					dynamicModes[idx] = { ...dynamicModes[idx]!, ...putBody } as ModeData;
					return route.fulfill({ json: dynamicModes[idx] });
				}
				return route.fulfill({ status: 404, json: { error: "Not found" } });
			}
			if (method === "GET") {
				const mode = dynamicModes.find((m) => m.id === id);
				return route.fulfill(mode ? { json: mode } : { status: 404, json: { error: "Not found" } });
			}
			return route.fallback();
		});
		await page.route("**/api/modes", async (route) => {
			if (route.request().method() === "GET") return route.fulfill({ json: dynamicModes });
			return route.fallback();
		});

		await page.goto("/settings#modes");
		await page.locator(`button[aria-label="View ${SEEDED_TOOLS_MODE.name} mode"]`).click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await dialog.locator('button[aria-label="Edit mode"]').click();
		await expect(dialog.locator("h2")).toHaveText("Edit Mode");

		// Both tools start checked (extensionTools null = all tools).
		const alpha = dialog.getByTestId("tool-ext-tools-alpha");
		const beta = dialog.getByTestId("tool-ext-tools-beta");
		await expect(alpha).toBeChecked();
		await expect(beta).toBeChecked();

		// Deselect beta → narrows to [alpha].
		await beta.uncheck();
		await expect(beta).not.toBeChecked();

		await dialog.getByRole("button", { name: "Save Changes" }).click();
		await expect(dialog).not.toBeVisible({ timeout: 3000 });

		// PUT body carries the subset.
		expect(putBody).not.toBeNull();
		expect((putBody as any).extensionTools).toEqual({ "ext-tools": ["alpha"] });

		// Reopen → edit: alpha checked, beta unchecked (persisted).
		await page.locator(`button[aria-label="View ${SEEDED_TOOLS_MODE.name} mode"]`).click();
		const dialog2 = page.getByRole("dialog");
		await dialog2.locator('button[aria-label="Edit mode"]').click();
		await expect(dialog2.getByTestId("tool-ext-tools-alpha")).toBeChecked();
		await expect(dialog2.getByTestId("tool-ext-tools-beta")).not.toBeChecked();
	});

	test("view mode (builtin): Edit button disabled, Tooltip surfaces 'Built-in modes cannot be edited.'", async ({ page, mockApi }) => {
		await mockApi({
			projects: [PROJECT],
			modes: [SEEDED_BUILTIN],
			extensions: EXTENSIONS_FIXTURE,
		});

		await page.goto("/settings#modes");
		await page.locator(`button[aria-label="View ${SEEDED_BUILTIN.name} mode"]`).click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await expect(dialog.locator("h2")).toHaveText("View Mode");

		// Disabled-edit button uses a distinct aria-label so the disabled
		// state is machine-readable and the test pins on intent.
		const editBtn = dialog.locator('button[aria-label="Edit (disabled — built-in mode)"]');
		await expect(editBtn).toBeVisible();
		await expect(editBtn).toBeDisabled();

		// Hover the disabled button — Tooltip wrapper triggers on
		// mouseenter (300 ms delay) and renders a fixed-positioned div
		// with role="tooltip" containing the explanation copy.
		await editBtn.hover();
		const tooltip = page.getByRole("tooltip", { name: /Built-in modes cannot be edited/ });
		await expect(tooltip).toBeVisible({ timeout: 2000 });

		// Clicking the disabled button must not flip into edit mode —
		// "Save Changes" stays absent.
		await editBtn.click({ force: true }).catch(() => { /* disabled buttons may reject click; that's fine */ });
		await expect(dialog.getByRole("button", { name: "Save Changes" })).toHaveCount(0);
		await expect(dialog.locator("h2")).toHaveText("View Mode");
	});
});
