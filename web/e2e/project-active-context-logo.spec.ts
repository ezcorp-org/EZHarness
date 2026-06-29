/**
 * E2E coverage for the project logo in the command-column "active-context line"
 * (the second-level nav header at the top of the desktop sidebar that shows the
 * active project's name + identity).
 *
 * Regression: this header previously ALWAYS rendered the first-letter fallback
 * avatar, ignoring the project's `icon` — so a project with a custom logo still
 * showed the default colored initial here, unlike the ProjectRail and command
 * palette which both render the image. The fix brings it to parity: render the
 * `<img>` when `activeProject.icon` is set, else the colored initial.
 *
 * The desktop sidebar (`desktop-sidebar`) only renders at ≥lg (1024px+), so the
 * suite pins a desktop viewport. We land on a chat-detail URL — the chat-focused
 * section the user reported — so the active-context line resolves to that project.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

// A small, visible inline SVG (red square + white dot) — a valid image URL the
// <img> loads deterministically, and a recognizable logo in the @evidence shot.
const ICON_DATA_URI =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23e11d48'/%3E%3Ccircle cx='20' cy='20' r='9' fill='white'/%3E%3C/svg%3E";

const CONV_ID = "conv-1";

test.describe("Active-context project logo @ desktop", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("renders the project icon image when the project has a logo @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [makeProject({ id: "proj-logo", name: "Logoed", icon: ICON_DATA_URI })],
			conversations: [makeConversation({ id: CONV_ID, projectId: "proj-logo", title: "Hello" })],
		});
		await page.goto(`/project/proj-logo/chat/${CONV_ID}`);

		const avatar = page.getByTestId("active-context-avatar");
		await expect(avatar).toBeVisible();

		// The fix: an <img> carrying the project icon, not a first-letter fallback.
		const img = avatar.locator("img");
		await expect(img).toBeVisible();
		await expect(img).toHaveAttribute("src", ICON_DATA_URI);
		// The colored-initial fallback background must NOT be applied when an icon is set.
		await expect(avatar).not.toContainText("L");

		await captureEvidence(page, testInfo, "active-context-logo");
	});

	test("falls back to the colored first-letter avatar when no icon is set", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [makeProject({ id: "proj-plain", name: "Plain", icon: null })],
			conversations: [makeConversation({ id: CONV_ID, projectId: "proj-plain", title: "Hello" })],
		});
		await page.goto(`/project/proj-plain/chat/${CONV_ID}`);

		const avatar = page.getByTestId("active-context-avatar");
		await expect(avatar).toBeVisible();
		// No image — the first letter of the project name stands in for the logo.
		await expect(avatar.locator("img")).toHaveCount(0);
		await expect(avatar).toHaveText("P");
	});
});
