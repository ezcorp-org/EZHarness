import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMode } from "./fixtures/data.js";

test.describe("Modes", () => {
	const proj = makeProject({ id: "proj-1", name: "Mode Project" });
	const planMode = makeMode({
		id: "builtin-plan",
		name: "Plan",
		slug: "plan",
		icon: "\u{1F4CB}",
		description: "Plan without coding",
		systemPromptInstruction: "You are in planning mode.",
		toolRestriction: "read-only",
		builtin: true,
	});
	const reviewMode = makeMode({
		id: "builtin-code-review",
		name: "Code Review",
		slug: "code-review",
		icon: "\u{1F50D}",
		description: "Review code for issues",
		systemPromptInstruction: "You are in code review mode.",
		toolRestriction: "read-only",
		builtin: true,
	});
	const customMode = makeMode({
		id: "custom-debug",
		name: "Debug",
		slug: "debug",
		icon: "\u{1F41B}",
		description: "Systematic debugging",
		systemPromptInstruction: "Debug systematically.",
		toolRestriction: "all",
		builtin: false,
	});

	const modes = [planMode, reviewMode, customMode];

	test("mode selector shows Default when no mode selected", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Mode selector should show "Default" text
		const modeBtn = page.locator(".mode-selector button").first();
		await expect(modeBtn).toBeVisible({ timeout: 5000 });
		await expect(modeBtn).toContainText("Default");
	});

	test("mode selector opens dropdown with all modes", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Click to open dropdown
		const modeBtn = page.locator(".mode-selector button").first();
		await modeBtn.click();

		// Should show all modes plus Default option. `getByText` defaults
		// to substring matching, so "Plan" would also match the description
		// "Plan without coding". Use exact-match to pin to the option title.
		await expect(page.getByText("Plan", { exact: true })).toBeVisible();
		await expect(page.getByText("Code Review", { exact: true })).toBeVisible();
		await expect(page.getByText("Debug", { exact: true })).toBeVisible();
	});

	test("mode selector shows tool restriction badges", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open dropdown
		await page.locator(".mode-selector button").first().click();

		// Read-only badge should appear for Plan and Code Review
		const badges = page.locator(".mode-selector").getByText("read-only");
		await expect(badges.first()).toBeVisible();
	});

	test("selecting a mode updates the button text", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open and select Plan mode
		await page.locator(".mode-selector button").first().click();

		// Click the Plan option (find the button containing "Plan" in the dropdown)
		const planOption = page.locator(".mode-selector").getByText("Plan").first();
		await planOption.click();

		// Button should now show Plan
		const modeBtn = page.locator(".mode-selector button").first();
		await expect(modeBtn).toContainText("Plan");
	});

	test("selecting Default clears mode", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1", modeId: "builtin-plan" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Should show Plan initially (restored from conversation)
		const modeBtn = page.locator(".mode-selector button").first();
		await expect(modeBtn).toContainText("Plan", { timeout: 5000 });

		// Open and select Default
		await modeBtn.click();
		const defaultBtn = page.locator(".mode-selector").getByText("Default").first();
		await defaultBtn.click();

		// Should revert to Default
		await expect(modeBtn).toContainText("Default");
	});

	test("mode persists across page reload via conversation modeId", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1", modeId: "builtin-plan" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Should show Plan mode (restored from conversation.modeId)
		const modeBtn = page.locator(".mode-selector button").first();
		await expect(modeBtn).toContainText("Plan", { timeout: 5000 });
	});

	test("mode dropdown closes on click outside", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open dropdown
		await page.locator(".mode-selector button").first().click();
		// "Plan" appears as both an option title and inside the description
		// "Plan without coding" — pin to the exact title with { exact: true }.
		await expect(page.getByText("Plan", { exact: true })).toBeVisible();

		// Click outside
		await page.locator("body").click({ position: { x: 10, y: 10 } });

		// Dropdown should close — the Plan option in the dropdown should not be visible
		// (Note: "Plan" text may still exist in the button, so check dropdown container)
		const dropdown = page.locator(".mode-selector > div:nth-child(2)");
		await expect(dropdown).not.toBeVisible({ timeout: 2000 });
	});

	test("mode selector visible even with no modes (has New mode button)", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes: [],
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Mode selector should still be visible (it has the New mode + Manage links)
		const modeSelector = page.locator(".mode-selector");
		await expect(modeSelector).toBeVisible({ timeout: 5000 });
	});

	test("dropdown shows New mode button and Manage link", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open dropdown
		await page.locator(".mode-selector button").first().click();

		// Should show footer with New mode and Manage
		await expect(page.locator(".mode-selector").getByText("New mode")).toBeVisible();
		await expect(page.locator(".mode-selector").getByText("Manage")).toBeVisible();
	});

	test("Manage link points to settings modes section", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open dropdown
		await page.locator(".mode-selector button").first().click();

		// Verify the Manage link href
		const manageLink = page.locator(".mode-selector").getByText("Manage");
		await expect(manageLink).toHaveAttribute("href", "/settings#modes");
	});

	test("New mode button opens create mode modal", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open dropdown and click New mode
		await page.locator(".mode-selector button").first().click();
		await page.locator(".mode-selector").getByText("New mode").click();

		// Modal should appear with the create form. "Create Mode" appears
		// twice in the dialog (h2 title + submit button); pin to the heading
		// to avoid strict-mode ambiguity.
		await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("dialog").getByRole("heading", { name: "Create Mode" })).toBeVisible();
		await expect(page.getByText("System Prompt Instruction")).toBeVisible();
	});

	test("create mode modal closes on Cancel", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open modal
		await page.locator(".mode-selector button").first().click();
		await page.locator(".mode-selector").getByText("New mode").click();
		await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3000 });

		// Cancel
		await page.getByRole("dialog").getByText("Cancel").click();
		await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 2000 });
	});

	test("create mode modal closes on backdrop click", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open modal
		await page.locator(".mode-selector button").first().click();
		await page.locator(".mode-selector").getByText("New mode").click();
		await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3000 });

		// Click backdrop (the outer dialog container)
		await page.getByRole("dialog").click({ position: { x: 5, y: 5 } });
		await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 2000 });
	});

	test("create mode modal closes on X button", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open modal
		await page.locator(".mode-selector button").first().click();
		await page.locator(".mode-selector").getByText("New mode").click();
		await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3000 });

		// Click X button (the close SVG button in the header)
		const closeBtn = page.getByRole("dialog").locator("button").first();
		await closeBtn.click();
		await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 2000 });
	});

	test("create mode modal shows all form fields", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open modal
		await page.locator(".mode-selector button").first().click();
		await page.locator(".mode-selector").getByText("New mode").click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await expect(dialog.getByText("Name")).toBeVisible();
		await expect(dialog.getByText("Slug")).toBeVisible();
		await expect(dialog.getByText("Icon (emoji)")).toBeVisible();
		// Phase modes.extensionIds: the legacy "Tool Restriction" <select> was
		// replaced with the shared "Tools & Extensions" picker.
		await expect(dialog.getByText("Tools & Extensions")).toBeVisible();
		await expect(dialog.getByText("Tool Restriction")).toHaveCount(0);
		await expect(dialog.getByText("Description")).toBeVisible();
		await expect(dialog.getByText("System Prompt Instruction")).toBeVisible();
		await expect(dialog.getByText("Instruction Position")).toBeVisible();
	});

	test("create mode modal submit button disabled when fields empty", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open modal
		await page.locator(".mode-selector button").first().click();
		await page.locator(".mode-selector").getByText("New mode").click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });

		// Create Mode button should be disabled when form is empty
		const submitBtn = dialog.getByText("Create Mode").last();
		await expect(submitBtn).toBeDisabled();
	});

	test("create mode modal submits and adds mode to selector", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
		});

		// Intercept POST /api/modes to return a new mode
		await page.route("**/api/modes", async (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON();
				await route.fulfill({
					json: {
						id: "new-mode-id",
						name: body.name,
						slug: body.slug,
						icon: body.icon || null,
						description: body.description || "",
						systemPromptInstruction: body.systemPromptInstruction,
						instructionPosition: body.instructionPosition || "prepend",
						preferredModel: null,
						preferredProvider: null,
						preferredThinkingLevel: null,
						temperature: null,
						toolRestriction: body.toolRestriction || "all",
						builtin: false,
					},
				});
			} else {
				await route.fulfill({ json: modes });
			}
		});

		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open modal
		await page.locator(".mode-selector button").first().click();
		await page.locator(".mode-selector").getByText("New mode").click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });

		// Fill in the form
		await dialog.locator("input").first().fill("My Test Mode");
		await dialog.locator("textarea").fill("Be awesome and test things.");

		// Submit
		await dialog.getByText("Create Mode").last().click();

		// Modal should close
		await expect(dialog).not.toBeVisible({ timeout: 3000 });

		// Mode selector should now show the new mode
		const modeBtn = page.locator(".mode-selector button").first();
		await expect(modeBtn).toContainText("My Test Mode");
	});

	test("mode change triggers conversation update API call", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		let updateBody: any = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			modes,
			routes: {
				"/api/conversations/conv-1": () => {
					// This captures PUT requests to update the conversation
					return { ...conv, modeId: "builtin-plan" };
				},
			},
		});

		// Intercept the PUT request to capture the body
		await page.route("**/api/conversations/conv-1", async (route) => {
			if (route.request().method() === "PUT") {
				updateBody = route.request().postDataJSON();
				await route.fulfill({ json: { ...conv, ...updateBody } });
			} else {
				await route.fulfill({ json: conv });
			}
		});

		await page.goto(`/project/proj-1/chat/conv-1`);

		// Select Plan mode
		await page.locator(".mode-selector button").first().click();
		await page.locator(".mode-selector").getByText("Plan").first().click();

		// Wait for the API call
		await page.waitForTimeout(500);

		// Verify the conversation was updated with the modeId
		expect(updateBody).not.toBeNull();
		expect(updateBody.modeId).toBe("builtin-plan");
	});
});

test.describe("Modes on Settings Page", () => {
	test("settings page shows modes section", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-1" });
		const modes = [
			makeMode({ id: "builtin-plan", name: "Plan", slug: "plan", builtin: true, toolRestriction: "read-only" }),
			makeMode({ id: "custom-1", name: "My Custom Mode", slug: "custom", builtin: false }),
		];

		await mockApi({
			projects: [proj],
			modes,
		});
		await page.goto("/settings");

		await expect(page.getByText("Custom Modes")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Create Mode")).toBeVisible();
	});

	test("settings shows built-in badge on built-in modes", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-1" });
		const modes = [
			makeMode({ id: "builtin-plan", name: "Plan", slug: "plan", builtin: true, toolRestriction: "read-only" }),
		];

		await mockApi({
			projects: [proj],
			modes,
		});
		await page.goto("/settings");

		await expect(page.getByText("built-in")).toBeVisible({ timeout: 5000 });
	});

	test("settings shows delete button only for custom modes; edit lives behind the view modal", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-1" });
		const modes = [
			makeMode({ id: "builtin-plan", name: "Plan", slug: "plan", builtin: true }),
			makeMode({ id: "custom-1", name: "My Mode", slug: "my-mode", builtin: false }),
		];

		await mockApi({
			projects: [proj],
			modes,
		});
		await page.goto("/settings");

		// Phase modes.extensionIds: the inline Edit button was removed —
		// clicking the card now opens the view modal where Edit is the
		// header action. Custom modes still have an inline Delete button.
		await expect(page.getByText("Delete")).toBeVisible({ timeout: 5000 });

		// View card opens a dialog whose header has "Edit mode" aria-label.
		await page.locator('button[aria-label="View My Mode mode"]').click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await expect(page.locator('button[aria-label="Edit mode"]')).toBeVisible();
	});

	test("create mode form opens on button click", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-1" });

		await mockApi({
			projects: [proj],
			modes: [makeMode({ id: "builtin-plan", name: "Plan", slug: "plan", builtin: true })],
		});
		await page.goto("/settings");

		await page.getByText("Create Mode").click();

		// Form should be visible. Phase modes.extensionIds: the legacy
		// "Tool Restriction" <select> was replaced with the "Tools &
		// Extensions" picker.
		await expect(page.getByText("System Prompt Instruction")).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("Tools & Extensions")).toBeVisible();
		await expect(page.getByText("Tool Restriction")).toHaveCount(0);
		await expect(page.getByText("Instruction Position")).toBeVisible();
	});

	test("modes section has anchor id for hash navigation", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-1" });

		await mockApi({
			projects: [proj],
			modes: [makeMode({ id: "builtin-plan", name: "Plan", slug: "plan", builtin: true })],
		});
		await page.goto("/settings#modes");

		// The modes section should exist with id="modes"
		const modesSection = page.locator("#modes");
		await expect(modesSection).toBeVisible({ timeout: 5000 });
		await expect(modesSection).toContainText("Custom Modes");
	});
});

test.describe("Marketplace Modes Category", () => {
	test("marketplace shows Modes category in category grid", async ({ page, mockApi }) => {
		await mockApi({
			projects: [makeProject({ id: "proj-1" })],
		});
		await page.goto("/marketplace");

		// The Modes category button should be visible
		await expect(page.getByText("Modes")).toBeVisible({ timeout: 5000 });
	});
});

test.describe("Keyboard navigation in mode selector", () => {
	const proj = makeProject({ id: "proj-1", name: "KB Nav Project" });
	const modes = [
		makeMode({ id: "m1", name: "Plan", slug: "plan", builtin: true, toolRestriction: "read-only" }),
		makeMode({ id: "m2", name: "Debug", slug: "debug", builtin: false, toolRestriction: "all" }),
		makeMode({ id: "m3", name: "Review", slug: "review", builtin: false, toolRestriction: "read-only" }),
	];

	test("ArrowDown highlights next option", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		await mockApi({ projects: [proj], conversations: [conv], modes });
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Open mode selector
		await page.locator(".mode-selector button").first().click();

		// Search input should be focused
		const input = page.locator(".mode-selector input[role='combobox']");
		await expect(input).toBeFocused({ timeout: 3000 });

		// Press ArrowDown — should highlight second item (first mode after Default)
		await input.press("ArrowDown");

		// The second option (index 1) should be highlighted
		const option1 = page.locator("#mode-option-1");
		await expect(option1).toHaveClass(/bg-\[var\(--color-surface-tertiary\)\]/, { timeout: 2000 });
	});

	test("ArrowUp highlights previous option", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		await mockApi({ projects: [proj], conversations: [conv], modes });
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".mode-selector button").first().click();
		const input = page.locator(".mode-selector input[role='combobox']");

		// Press ArrowUp — should wrap to last item
		await input.press("ArrowUp");

		// Last option should be highlighted (index 3 = 3rd mode)
		const lastOption = page.locator("#mode-option-3");
		await expect(lastOption).toHaveClass(/bg-\[var\(--color-surface-tertiary\)\]/, { timeout: 2000 });
	});

	test("Enter selects the highlighted option", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		await mockApi({ projects: [proj], conversations: [conv], modes });
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".mode-selector button").first().click();
		const input = page.locator(".mode-selector input[role='combobox']");

		// ArrowDown twice to highlight "Plan" (index 1, after Default at 0)
		await input.press("ArrowDown");

		// Enter to select
		await input.press("Enter");

		// Dropdown should close and button should show "Plan"
		const modeBtn = page.locator(".mode-selector button").first();
		await expect(modeBtn).toContainText("Plan");
	});

	test("Escape closes the dropdown", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		await mockApi({ projects: [proj], conversations: [conv], modes });
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".mode-selector button").first().click();
		const input = page.locator(".mode-selector input[role='combobox']");
		await expect(input).toBeVisible();

		await input.press("Escape");

		// Dropdown should close
		await expect(input).not.toBeVisible({ timeout: 2000 });
	});

	test("typing filters options and resets highlight", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		await mockApi({ projects: [proj], conversations: [conv], modes });
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".mode-selector button").first().click();
		const input = page.locator(".mode-selector input[role='combobox']");

		// Type "deb" to filter to Debug
		await input.fill("deb");

		// Only Debug should be visible
		await expect(page.locator(".mode-selector").getByText("Debug")).toBeVisible();
		// Check that the mode list only has 1 visible option button
		const visibleOptions = page.locator(".mode-selector [role='option']");
		await expect(visibleOptions).toHaveCount(1);

		// Enter selects Debug
		await input.press("Enter");
		const modeBtn = page.locator(".mode-selector button").first();
		await expect(modeBtn).toContainText("Debug");
	});

	test("mouse hover updates highlight index", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		await mockApi({ projects: [proj], conversations: [conv], modes });
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".mode-selector button").first().click();

		// Hover over the last mode option
		const lastOption = page.locator("#mode-option-3");
		await lastOption.hover();

		await expect(lastOption).toHaveClass(/bg-\[var\(--color-surface-tertiary\)\]/, { timeout: 2000 });

		// Now press Enter — should select the hovered item
		const input = page.locator(".mode-selector input[role='combobox']");
		await input.press("Enter");

		const modeBtn = page.locator(".mode-selector button").first();
		await expect(modeBtn).toContainText("Review");
	});
});
