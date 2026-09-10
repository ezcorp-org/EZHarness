/**
 * Agent-picker preference journeys.
 *
 * The picker is rendered by the team builder, not the agents index. These
 * journeys keep its server persistence boundary explicit while exercising the
 * user-visible save, pin, reload, and stale-reference behavior.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeAgentConfig } from "./fixtures/data.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";

type PickerPrefs = {
	savedSearches: Array<{ query: string; createdAt: number }>;
	pinned: string[];
};

const alpha = makeAgentConfig({ id: "agent-alpha", name: "Alpha", description: "Plans work" });
const beta = makeAgentConfig({ id: "agent-beta", name: "Beta", description: "Reviews work" });

async function openTeamPicker(
	page: import("@playwright/test").Page,
	mockApi: (overrides?: MockOverrides) => Promise<void>,
	prefs: PickerPrefs,
) {
	await mockApi({ agentConfigs: [alpha, beta] });
	await page.route("**/api/user/agent-picker", async (route) => {
		if (route.request().method() === "GET") return route.fulfill({ json: prefs });
		if (route.request().method() === "PUT") {
			const update = route.request().postDataJSON() as Partial<PickerPrefs>;
			if (Array.isArray(update.savedSearches)) prefs.savedSearches = update.savedSearches;
			if (Array.isArray(update.pinned)) prefs.pinned = update.pinned;
			return route.fulfill({ json: prefs });
		}
		return route.fallback();
	});
	await page.goto("/agents/new?type=team");
	await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible();
	const picker = page.getByTestId("open-agent-picker");
	await picker.focus();
	await expect(page.getByRole("listbox", { name: "Available agents" })).toBeVisible();
	return picker;
}

test.describe("Agent picker saved searches and pinned agents", () => {
	test("saves a typed query and restores it after reload", async ({ page, mockApi }) => {
		const prefs: PickerPrefs = { savedSearches: [], pinned: [] };
		const picker = await openTeamPicker(page, mockApi, prefs);

		await picker.fill("Alpha");
		await page.getByTestId("save-search-button").click();
		await expect.poll(() => prefs.savedSearches.map((entry) => entry.query)).toEqual(["Alpha"]);

		await page.reload();
		await page.getByTestId("open-agent-picker").focus();
		await expect(page.getByTestId("saved-searches")).toContainText("Alpha");
	});

	test("pins a real agent and restores the pinned section after reload", async ({ page, mockApi }) => {
		const prefs: PickerPrefs = { savedSearches: [], pinned: [] };
		await openTeamPicker(page, mockApi, prefs);

		await page.getByTestId("pin-" + alpha.id).click();
		await expect.poll(() => prefs.pinned).toEqual([alpha.id]);

		await page.reload();
		await page.getByTestId("open-agent-picker").focus();
		await expect(page.getByTestId("pinned-agents")).toContainText(alpha.name);
	});

	test("does not render a stale pinned identifier returned by the server", async ({ page, mockApi }) => {
		// The route's read path removes stale ids (server coverage asserts that
		// mutation). The client has a second guard so an in-flight old response
		// cannot show a deleted agent as a selectable member.
		const prefs: PickerPrefs = { savedSearches: [], pinned: ["agent-doomed"] };
		await openTeamPicker(page, mockApi, prefs);

		await expect(page.getByTestId("pinned-agents")).toHaveCount(0);
		await expect(page.getByTestId("agent-row")).toHaveCount(2);
	});

	test("the extension picker does not expose agent-only save or pin controls", async ({ page, mockApi }) => {
		await mockApi({ agentConfigs: [alpha], extensions: [] });
		await page.goto("/agents/new");
		await page.getByRole("button", { name: "Configure" }).click();
		await page.getByTestId("extension-picker-combobox").locator("input[role='combobox']").click();

		await expect(page.getByTestId("save-search-button")).toHaveCount(0);
		await expect(page.getByTestId("pinned-agents")).toHaveCount(0);
	});
});
