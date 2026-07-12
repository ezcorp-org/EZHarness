import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeMode } from "./fixtures/data.js";

/**
 * EZ mode tool-list visibility.
 *
 * Three surfaces used to show the Ez mode's tool surface as empty:
 *   - the Modes settings row labeled the builtin allowlist mode "no tools";
 *   - the mode view modal said "No extensions attached." (it only rendered
 *     `extensionIds`-based scoping, never `allowedTools`);
 *   - the Ez panel had no tool surface at all.
 *
 * These specs pin the fixes: an "N tools" badge, a read-only allowlist
 * chip list in the view modal, and the panel's 🔧 tools chip + popover
 * (fed by /api/tools?conversationId=…, the same scope the runtime grants).
 *
 * Frontend-visual change → @evidence screenshots for the PR bot.
 */

const EZ_ALLOWED_TOOLS = [
	"propose_create_project",
	"propose_create_agent",
	"propose_install_extension",
	"summarize_conversation",
	"search_conversation",
	"find_agents",
	"fill_form",
	"navigate_to",
	"read_page",
	"extension-author__create_extension",
];

const ezMode = makeMode({
	id: "builtin-ez",
	name: "Ez",
	slug: "ez",
	icon: "🪄",
	description: "In-app concierge for managing your EZCorp setup.",
	toolRestriction: "allowlist",
	allowedTools: EZ_ALLOWED_TOOLS,
	builtin: true,
});

test.describe("EZ mode — tool list visibility", () => {
	const proj = makeProject({ id: "proj-1" });

	test("modes settings shows an 'N tools' badge and the view modal lists the allowlist @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], modes: [ezMode] });
		await page.goto("/settings/personalization");

		// Row badge: allowlist modes surface their tool count (was "no tools").
		const badge = page.getByText(`${EZ_ALLOWED_TOOLS.length} tools`, { exact: true });
		await expect(badge).toBeVisible();
		await captureEvidence(page, testInfo, "ez-mode-row-tools-badge");

		// View modal: the builtin allowlist renders as a read-only chip list
		// (was "No extensions attached.").
		await page.getByRole("button", { name: "View Ez mode" }).click();
		const allowlist = page.getByTestId("mode-allowlist-tools");
		await expect(allowlist).toBeVisible();
		await expect(allowlist).toContainText("read_page");
		await expect(allowlist).toContainText("propose_create_project");
		await expect(allowlist).toContainText("search_conversation");
		await expect(allowlist).toContainText("extension-author__create_extension");
		await expect(page.getByText("No extensions attached.")).toHaveCount(0);
		await captureEvidence(page, testInfo, "ez-mode-view-allowlist");
	});

	test("the Ez panel's tools chip lists the conversation's tool surface @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto(`/project/${proj.id}/chat`);
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		await page.getByTestId("ez-panel-tools").click();
		const popover = page.getByTestId("ez-panel-tools-popover");
		await expect(popover).toBeVisible();
		// The shared /api/tools mock returns 4 tools across 3 extensions.
		await expect(page.getByTestId("ez-panel-tool-row")).toHaveCount(4);
		await expect(page.getByTestId("ez-panel-tools-group")).toHaveCount(3);
		await expect(popover).toContainText("scan");
		// Chip count reflects the fetched list.
		await expect(page.getByTestId("ez-panel-tools")).toContainText("4");
		await captureEvidence(page, testInfo, "ez-panel-tools-popover");
	});
});
