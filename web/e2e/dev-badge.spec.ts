import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

/**
 * Dev-mode git badge — the bottom-right pill showing `<branch> · <commit>`.
 *
 * The server stamps `data-dev-indicator` / `data-dev-branch` / `data-dev-commit`
 * on `<html>` only when EZCORP_DEV_INDICATOR=1 (which e2e does not set), so we
 * seed the dataset via addInitScript before load and assert the DevBadge
 * component (in the root layout) reads it back and renders.
 *
 * Frontend-visual change → `@evidence`-tagged so the visual gate captures a
 * screenshot of the rendered badge.
 */

test("dev-mode git badge renders branch · commit bottom-right @evidence", async ({ page, mockApi }, testInfo) => {
	// Stamp the dataset the server would set with EZCORP_DEV_INDICATOR=1. At
	// addInitScript time `document.documentElement` may not exist yet, so apply
	// immediately when it does and re-apply on DOMContentLoaded (which fires
	// before the layout's onMount reads it).
	await page.addInitScript(() => {
		const apply = () => {
			document.documentElement.dataset.devIndicator = "1";
			document.documentElement.dataset.devBranch = "feat/demo";
			document.documentElement.dataset.devCommit = "a1b2c3d";
		};
		if (document.documentElement) apply();
		document.addEventListener("DOMContentLoaded", apply);
	});

	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	await mockApi({
		projects: [proj],
		routes: {
			"/api/auth/me": () => ({
				user: { id: "user-1", email: "user@test.local", name: "Test User", role: "member" },
			}),
			"/api/account": () => ({
				id: "user-1",
				email: "user@test.local",
				name: "Test User",
				role: "member" as const,
				createdAt: "2026-01-15T00:00:00.000Z",
			}),
		},
	});

	await page.goto("/account");
	// Wait for the layout + page to render before checking the badge.
	await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible({ timeout: 5000 });

	const badge = page.getByTestId("dev-badge");
	await expect(badge).toBeVisible();
	await expect(badge).toContainText("feat/demo");
	await expect(badge).toContainText("a1b2c3d");

	await captureEvidence(page, testInfo, "dev-badge");
});
