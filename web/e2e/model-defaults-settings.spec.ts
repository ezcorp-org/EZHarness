/**
 * @evidence — Settings → Models: the two instance defaults an operator reaches
 * for when routing costs or behaves differently than they wanted.
 *
 * 1. **New Chat Model Default** (`provider:defaultSelection`) — the no-deploy
 *    REVERT for routed-by-default traffic. This spec drives it the way an
 *    operator does: read what each choice does, pick the other one, see it
 *    confirmed saved.
 * 2. **Older Tool Result Cap** (`compaction:toolResultCap`) — how much of an
 *    older tool result is replayed on each agentic step. Saved on commit, and
 *    a value the settings API would reject is refused inline instead.
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

/** Record every settings PUT the page issues, so "did not save" is provable. */
function recordSettingsPuts(page: import("@playwright/test").Page) {
	const puts: { key: string; value: unknown }[] = [];
	page.on("request", (req) => {
		const url = new URL(req.url());
		if (req.method() !== "PUT" || !url.pathname.startsWith("/api/settings/")) return;
		const key = decodeURIComponent(url.pathname.slice("/api/settings/".length));
		puts.push({ key, value: (req.postDataJSON() as { value: unknown } | null)?.value });
	});
	return puts;
}

test.describe("@evidence model defaults", () => {
	test("an unconfigured instance shows the shipped defaults and what they mean", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], settings: baseSettings });
		await page.goto("/settings/models");

		const selection = page.locator("#default-selection");
		await expect(selection.getByRole("heading", { name: "New Chat Model Default" })).toBeVisible();
		// Auto is the shipped default, and the card says what that DOES — the
		// point of the control is that a revert is an informed decision.
		await expect(page.getByTestId("default-selection-auto")).toHaveAttribute("aria-checked", "true");
		await expect(page.getByTestId("default-selection-auto")).toContainText(
			"picks the tier for the first turn",
		);
		await expect(page.getByTestId("default-selection-first")).toContainText(
			"before routing existed",
		);

		await selection.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "default-selection-auto");

		const cap = page.locator("#tool-result-cap");
		await expect(cap.getByRole("heading", { name: "Older Tool Result Cap" })).toBeVisible();
		await expect(page.getByTestId("tool-result-cap-input")).toHaveValue("32000");
		await expect(page.getByTestId("tool-result-cap-effect")).toContainText("About 8,000 tokens");

		await cap.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "tool-result-cap-default");
	});

	test("the operator reverts routed-by-default traffic without a deploy", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], settings: baseSettings });
		const puts = recordSettingsPuts(page);
		await page.goto("/settings/models");

		await page.getByTestId("default-selection-first").click();

		await expect(page.getByTestId("default-selection-first")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(page.getByTestId("save-indicator-saved").first()).toBeVisible();
		expect(puts).toContainEqual({ key: "provider:defaultSelection", value: "first" });

		await page.locator("#default-selection").scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "default-selection-reverted");
	});

	test("a stored revert hydrates as the checked choice", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			settings: { ...baseSettings, "provider:defaultSelection": "first" },
		});
		await page.goto("/settings/models");

		await expect(page.getByTestId("default-selection-first")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(page.getByTestId("default-selection-auto")).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	test("lowering the tool-result cap saves on commit and restates the effect", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			settings: { ...baseSettings, "compaction:toolResultCap": 32000 },
		});
		const puts = recordSettingsPuts(page);
		await page.goto("/settings/models");

		const input = page.getByTestId("tool-result-cap-input");
		await input.fill("8000");
		// Typing is not a save — the commit is leaving the field.
		expect(puts).toHaveLength(0);
		await input.blur();

		await expect(page.getByTestId("tool-result-cap-effect")).toContainText("About 2,000 tokens");
		expect(puts).toContainEqual({ key: "compaction:toolResultCap", value: 8000 });

		await page.locator("#tool-result-cap").scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "tool-result-cap-lowered");
	});

	test("a cap the settings API would reject is refused inline, never sent", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], settings: baseSettings });
		const puts = recordSettingsPuts(page);
		await page.goto("/settings/models");

		const input = page.getByTestId("tool-result-cap-input");
		await input.fill("-1");
		await input.blur();

		await expect(page.getByTestId("tool-result-cap-refusal")).toContainText("use 0 to disable");
		expect(puts).toHaveLength(0);
		// The stored cap is untouched, so the effect line still describes it.
		await expect(page.getByTestId("tool-result-cap-effect")).toContainText("About 8,000 tokens");

		await page.locator("#tool-result-cap").scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "tool-result-cap-refused");
	});
});
