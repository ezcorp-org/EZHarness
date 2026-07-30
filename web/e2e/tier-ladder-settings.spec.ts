/**
 * @evidence — Settings → Models: the tier model ladder (`provider:tierModels`).
 *
 * The ladder is what makes "Auto" routing predictable: for each quality tier
 * it names, in order, the models a routed turn may be served by. This spec
 * drives the editor the way an operator does — see the default you are
 * overriding, add a rung, reorder it — and captures the screen at each state.
 *
 * Mock tier: `/api/settings` + `/api/models` come from the shared api-mocks
 * fixture, so no provider key and no LLM are involved.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

/** Mirrors the fixture's /api/models payload: the only `fast`-tier model is
 *  google's, so an unconfigured fast tier defaults to it alone. */
const FAST_DEFAULT = "google/gemini-2.0-flash";

const baseSettings = {
	"provider:defaultTier": "balanced",
	"provider:preferenceOrder": ["anthropic", "openai", "google"],
};

test.describe("@evidence tier model ladder", () => {
	test("an unconfigured tier shows the default it would fall through to", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], settings: baseSettings });
		await page.goto("/settings/models");

		const section = page.locator("#tier-ladder");
		await expect(section).toBeVisible();
		await expect(section.getByRole("heading", { name: "Tier Model Ladder" })).toBeVisible();

		// No rungs configured anywhere…
		await expect(page.getByTestId("tier-ladder-rung")).toHaveCount(0);
		// …so each tier advertises the heuristic pick it is overriding.
		await expect(page.getByTestId("tier-ladder-default-fast")).toHaveText(
			`Default (no override): ${FAST_DEFAULT}`,
		);
		await expect(page.getByTestId("tier-ladder-default-powerful")).toContainText(
			"anthropic/claude-opus-4-20250514",
		);

		// The section sits below the fold on this page — bring it into the
		// viewport so the captured evidence shows the control under test.
		await section.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "tier-ladder-unconfigured");
	});

	test("a configured ladder renders in order and reorders on click", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			settings: {
				...baseSettings,
				"provider:tierModels": {
					fast: [
						{ provider: "google", model: "gemini-2.0-flash" },
						{ provider: "openai", model: "gpt-4o" },
					],
					balanced: [{ provider: "anthropic", model: "claude-sonnet-4-20250514" }],
					powerful: [{ provider: "anthropic", model: "claude-opus-4-20250514" }],
				},
			},
		});
		await page.goto("/settings/models");

		const fast = page.getByTestId("tier-ladder-fast");
		await expect(fast.getByTestId("tier-ladder-rung")).toHaveCount(2);
		await expect(fast.getByTestId("tier-ladder-rung").first()).toContainText("gemini-2.0-flash");
		await expect(fast.getByTestId("tier-ladder-rung").last()).toContainText("gpt-4o");
		// A configured tier still names what it falls back to.
		await expect(page.getByTestId("tier-ladder-default-fast")).toContainText("Falls back to:");

		await page.locator("#tier-ladder").scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "tier-ladder-configured");

		// Promote the second rung: the list is a PREFERENCE order, so this is the
		// whole point of the control.
		await fast.getByTestId("tier-ladder-rung").last().getByLabel("Move gpt-4o up").click();
		await expect(fast.getByTestId("tier-ladder-rung").first()).toContainText("gpt-4o");
		await expect(page.getByTestId("save-indicator-saved")).toBeVisible();

		await page.locator("#tier-ladder").scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "tier-ladder-reordered");
	});

	test("adding a model appends exactly one rung to that tier", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], settings: baseSettings });
		await page.goto("/settings/models");

		const powerful = page.getByTestId("tier-ladder-powerful");
		await powerful
			.getByTestId("tier-ladder-pick-powerful")
			.selectOption("anthropic|claude-opus-4-20250514");
		await powerful.getByTestId("tier-ladder-add-powerful").click();

		await expect(powerful.getByTestId("tier-ladder-rung")).toHaveCount(1);
		await expect(powerful.getByTestId("tier-ladder-rung")).toContainText(
			"claude-opus-4-20250514",
		);
		// Other tiers are untouched — the ladder is written whole but edited per tier.
		await expect(page.getByTestId("tier-ladder-fast").getByTestId("tier-ladder-rung")).toHaveCount(
			0,
		);
	});
});
