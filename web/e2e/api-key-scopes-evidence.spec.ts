/**
 * API-key scope selector — visual evidence.
 *
 * A frontend-visual change (`ApiKeyManager.svelte`), so the feature contract
 * requires an `@evidence`-tagged spec that calls `captureEvidence`.
 *
 * What a reviewer needs to eyeball here is COPY, not layout. This component is
 * where the false promise was made: the scope list rendered five bare words
 * with no descriptions and defaulted to `read`, while `read` was the scope that
 * authorized `DELETE /api/memories/:id`. An operator picked the default and got
 * a key they believed was read-only. See
 * docs/audit/2026-08-read-scope-mutation-inventory.md.
 *
 * So the assertions are about the words:
 *   1. `write` exists and its description says DELETE out loud.
 *   2. `read` says it never modifies — the claim that used to be false.
 *   3. The flatness note is present, because "chat includes read" was one of
 *      the three things the old operator doc got wrong.
 *   4. The default selection is still `read` alone — now an honest default,
 *      since a read-only key can no longer mutate anything.
 *
 * Every test asserts before it captures: a screenshot of a broken render is
 * worse than no screenshot.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-keys", name: "Key Scopes" });
const memberMe = {
	user: { id: "member-1", email: "member@test.local", name: "Member", role: "member" },
};

/** The developer settings page reads the caller's own key list on mount. */
const routes = {
	"/api/auth/me": () => memberMe,
	"/api/settings/developer/api-keys": () => ({
		keys: [
			{ keyId: "k-legacy", name: "CI Pipeline", scopes: ["read", "write"], createdAt: 1754000000000 },
			{ keyId: "k-ro", name: "Dashboard (read-only)", scopes: ["read"], createdAt: 1754100000000 },
		],
	}),
};

test.describe("@evidence API-key scope selector", () => {
	test("every scope carries a description, and write names DELETE", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], routes });
		await page.goto("/settings/developer");

		const panel = page.locator("#api-keys");
		await expect(panel).toBeVisible();

		// The scope that did not exist before this change.
		const writeToggle = panel.getByRole("button", { name: /^write/ });
		await expect(writeToggle).toBeVisible();
		// The description has to say the quiet part: this scope destroys data.
		await expect(writeToggle).toContainText(/DELETE/);

		// The claim that used to be false in the operator docs is now true here.
		await expect(panel.getByRole("button", { name: /^read/ })).toContainText(/[Nn]ever modifies/);

		// Flatness, stated where the choice is made — "chat includes read" was
		// one of the three false claims this change corrects.
		await expect(panel.getByText(/none includes another/i)).toBeVisible();

		await captureEvidence(page, testInfo, "api-key-scope-selector");
	});

	test("the default selection is read alone, and write is a deliberate click", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], routes });
		await page.goto("/settings/developer");

		const panel = page.locator("#api-keys");
		await expect(panel).toBeVisible();

		const read = panel.getByRole("button", { name: /^read/ });
		const write = panel.getByRole("button", { name: /^write/ });

		// Default: read selected, write NOT. A key minted without touching this
		// control can no longer mutate anything — which is the whole point.
		await expect(read).toHaveAttribute("aria-pressed", "true");
		await expect(write).toHaveAttribute("aria-pressed", "false");

		// Granting mutation takes an explicit action.
		await write.click();
		await expect(write).toHaveAttribute("aria-pressed", "true");
		await expect(read).toHaveAttribute("aria-pressed", "true");

		await captureEvidence(page, testInfo, "api-key-scope-write-selected");
	});
});
