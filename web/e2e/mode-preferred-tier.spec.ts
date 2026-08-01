import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeMode } from "./fixtures/data.js";

/**
 * @evidence — WS3b: the mode → routing-tier task binding in the mode form.
 *
 * `modes` are EZCorp's "task type" concept, and `modes.preferred_model` has
 * existed as DEAD config since modes shipped — nothing read it. WS3b wires the
 * binding server-side at the routing seam and gives the form the knob that
 * makes it reachable: a **Model Tier** selector.
 *
 * It offers a tier, not a model id, deliberately — a mode is long-lived config
 * while the model catalog turns over, so "code review wants a powerful model"
 * keeps meaning that as the tier ladder changes underneath it. The empty
 * option is the wire-level `null` ("no preference" → the turn falls through to
 * the heuristic classifier), and the help text states the precedence the
 * server enforces: the tier applies when a chat BEGINS, and a model the user
 * picks always wins.
 *
 * Pure UI spec — no LLM, no real DB. The mode list is served by `mockApi` and
 * the create POST is intercepted so the submitted payload is assertable.
 */

const proj = makeProject({ id: "proj-tier", name: "Tier Project" });

const carefulMode = makeMode({
	id: "mode-careful",
	name: "Careful Review",
	slug: "careful-review",
	icon: "\u{1F50D}",
	description: "Reviews code on a powerful model",
	systemPromptInstruction: "Review carefully.",
	preferredTier: "powerful",
	builtin: false,
});

test.describe("@evidence mode Model Tier binding", () => {
	test("the create form offers every tier, defaults to Auto, and submits the chosen one", async ({
		page,
		mockApi,
	}, testInfo) => {
		let postedBody: Record<string, unknown> | null = null;

		await mockApi({ projects: [proj], modes: [carefulMode] });
		await page.route("**/api/modes", async (route) => {
			if (route.request().method() === "POST") {
				postedBody = route.request().postDataJSON();
				await route.fulfill({
					json: { ...makeMode({ id: "created" }), ...postedBody, builtin: false },
				});
				return;
			}
			await route.fulfill({ json: [carefulMode] });
		});

		await page.goto("/settings/personalization");
		await page.getByText("Create Mode").click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });

		// The selector renders with the Auto (no-preference) default and the
		// three routing tiers — the same vocabulary the router uses.
		const tierSelect = dialog.getByTestId("mode-form-preferred-tier");
		await expect(dialog.getByText("Model Tier")).toBeVisible();
		await expect(tierSelect).toBeVisible();
		await expect(tierSelect).toHaveValue("");
		await expect(tierSelect.locator("option")).toHaveText([
			"Auto (route per turn)",
			"Fast — cheapest model that fits",
			"Balanced",
			"Powerful — most capable model",
		]);

		// Fill the required fields and bind this task type to the powerful tier.
		await dialog.locator("#mode-form-name").fill("Careful Review");
		await dialog.locator("#mode-form-system-prompt").fill("Review carefully.");
		await tierSelect.selectOption("powerful");
		await expect(tierSelect).toHaveValue("powerful");

		await captureEvidence(page, testInfo, "mode-form-model-tier-selector");

		await dialog.getByText("Create Mode").last().click();
		await expect(dialog).not.toBeVisible({ timeout: 3000 });

		// The chosen tier reaches the API as the column value, not as a label.
		expect(postedBody).not.toBeNull();
		expect(postedBody!.preferredTier).toBe("powerful");
	});

	test("Auto submits null, so an unset mode keeps routing per turn", async ({ page, mockApi }) => {
		let postedBody: Record<string, unknown> | null = null;

		await mockApi({ projects: [proj], modes: [] });
		await page.route("**/api/modes", async (route) => {
			if (route.request().method() === "POST") {
				postedBody = route.request().postDataJSON();
				await route.fulfill({ json: { ...makeMode({ id: "created" }), ...postedBody } });
				return;
			}
			await route.fulfill({ json: [] });
		});

		await page.goto("/settings/personalization");
		await page.getByText("Create Mode").click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await dialog.locator("#mode-form-name").fill("No Preference");
		await dialog.locator("#mode-form-system-prompt").fill("Do the thing.");
		await dialog.getByText("Create Mode").last().click();
		await expect(dialog).not.toBeVisible({ timeout: 3000 });

		// Explicit null — the column is nullable and "" is not a valid tier.
		expect(postedBody).not.toBeNull();
		expect(postedBody!.preferredTier).toBeNull();
	});

	test("the view modal shows a stored tier read-only", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], modes: [carefulMode] });
		await page.goto("/settings/personalization");

		await page.locator('button[aria-label="View Careful Review mode"]').click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });

		// Hydrated from the row and locked until the user clicks Edit.
		const tierSelect = dialog.getByTestId("mode-form-preferred-tier");
		await expect(tierSelect).toHaveValue("powerful");
		await expect(tierSelect).toBeDisabled();

		await captureEvidence(page, testInfo, "mode-view-model-tier-readonly");
	});
});
