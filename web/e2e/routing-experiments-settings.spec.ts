/**
 * @evidence — Settings → Models: the routing experiments
 * (`provider:explorationRate`, `provider:routingShadow`).
 *
 * These two knobs are the only place the admin UI can spend something on
 * behalf of users, so this spec drives them the way an operator does and
 * captures the screen at each state — off, the acknowledgement exploration
 * demands before it will turn on, and shadow mode refusing an inverted pair
 * in the form instead of via a 400.
 *
 * Mock tier: `/api/settings` comes from the shared api-mocks fixture, so no
 * provider key and no LLM are involved.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

const baseSettings = {
	"provider:defaultTier": "balanced",
	"provider:preferenceOrder": ["anthropic", "openai", "google"],
};

test.describe("@evidence routing experiments", () => {
	test("both experiments are off, and exploration names its cost first", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], settings: baseSettings });
		await page.goto("/settings/models");

		const section = page.locator("#routing-experiments");
		await expect(section).toBeVisible();
		await expect(section.getByRole("heading", { name: "Routing Experiments" })).toBeVisible();

		// Off is the shipped state for both, and each says so rather than
		// showing a bare zero.
		await expect(page.getByTestId("exploration-current")).toContainText("exploration is off");
		await expect(page.getByTestId("exploration-impact")).toContainText(
			"every routed turn is served the tier the classifier picked",
		);
		await expect(page.getByTestId("shadow-current")).toContainText("shadow mode is off");

		// The quality cost is stated above the control, not behind it.
		await expect(section).toContainText("This trades answer quality for data.");
		await expect(section).toContainText("% of routed turns");

		await section.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "routing-experiments-off");
	});

	test("exploration will not turn on until its cost is acknowledged", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], settings: baseSettings });
		await page.goto("/settings/models");
		const section = page.locator("#routing-experiments");
		await section.scrollIntoViewIfNeeded();

		// The box is a PERCENTAGE — 5 here is five turns in a hundred, and the
		// impact line says so in turns rather than in probabilities.
		await page.getByTestId("exploration-rate-input").fill("5");
		await expect(page.getByTestId("exploration-impact")).toContainText(
			"About 1 in 20 routed turns",
		);
		await expect(page.getByTestId("exploration-save")).toBeDisabled();

		await captureEvidence(page, testInfo, "routing-exploration-acknowledgement");

		await page.getByTestId("exploration-ack").check();
		await expect(page.getByTestId("exploration-save")).toBeEnabled();
		await page.getByTestId("exploration-save").click();

		await expect(page.getByTestId("exploration-current")).toContainText(
			"exploring 5% of routed turns",
		);
		await expect(page.getByTestId("save-indicator-saved")).toBeVisible();
		// Turning it back off is one click and no ceremony.
		await expect(page.getByTestId("exploration-off")).toBeVisible();

		await section.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "routing-exploration-enabled");
	});

	test("an inverted shadow pair is refused by the form, not by a 400", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], settings: baseSettings });
		await page.goto("/settings/models");
		const section = page.locator("#routing-experiments");
		await section.scrollIntoViewIfNeeded();

		// The workflow the numbers come from is on screen with them.
		await expect(page.getByTestId("shadow-workflow")).toContainText(
			"bun run scripts/routing-sweep.ts",
		);
		await expect(page.getByTestId("shadow-workflow")).toContainText("Shadow Agreement");

		await page.getByTestId("shadow-fast-input").fill("5000");
		await page.getByTestId("shadow-powerful-input").fill("400");
		await expect(page.getByTestId("shadow-error")).toContainText(
			"must be BELOW powerfulMinTokens",
		);
		await expect(page.getByTestId("shadow-save")).toBeDisabled();

		await section.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "routing-shadow-inverted");

		// Corrected, the same pair saves.
		await page.getByTestId("shadow-fast-input").fill("250");
		await page.getByTestId("shadow-powerful-input").fill("4000");
		await expect(page.getByTestId("shadow-error")).toHaveCount(0);
		await page.getByTestId("shadow-save").click();

		await expect(page.getByTestId("shadow-current")).toContainText(
			"shadowing 250 / 4000 tokens",
		);
		await section.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "routing-shadow-configured");
	});

	test("a configured candidate can be cleared back to off", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			settings: {
				...baseSettings,
				"provider:routingShadow": { fastMaxTokens: 250, powerfulMinTokens: 4000 },
				"provider:explorationRate": 0.05,
			},
		});
		await page.goto("/settings/models");

		// A stored candidate loads into the boxes it was saved from.
		await expect(page.getByTestId("shadow-fast-input")).toHaveValue("250");
		await expect(page.getByTestId("shadow-powerful-input")).toHaveValue("4000");
		await expect(page.getByTestId("exploration-rate-input")).toHaveValue("5");

		// Shadow mode is off by ABSENCE, so clearing it deletes the row.
		const deleted = page.waitForRequest(
			(req) =>
				req.method() === "DELETE" && decodeURIComponent(req.url()).includes("provider:routingShadow"),
		);
		await page.getByTestId("shadow-off").click();
		await deleted;
		await expect(page.getByTestId("shadow-current")).toContainText("shadow mode is off");
		await expect(page.getByTestId("shadow-fast-input")).toHaveValue("");
	});
});
