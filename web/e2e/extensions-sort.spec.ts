/**
 * Sortable Extensions list — e2e for the `/extensions` page sort control.
 *
 * The `<select data-testid="ext-sort-select">` reorders the active-tab
 * extension cards purely client-side (no backend `ORDER BY`, no new API
 * surface). The ordering logic lives in `web/src/lib/extensions/extension-sort.ts`
 * and is unit-covered to 100%; this spec walks the user-visible behaviour:
 * load default A–Z, then each `selectOption` produces a verifiably different
 * card order.
 *
 * Mirrors `extensions-library-tabs.spec.ts` for mock setup: the page does an
 * SSR `load` + a client-side `loadExtensions()` on mount, and both share the
 * single `/api/extensions` mock from `mockApi`. The SSR loader soft-fails to
 * `[]` when the DB isn't available, so the client-fetch payload is the source
 * of truth in the e2e env. The seeded extensions are non-bundled so they show
 * on the default "Installed" tab.
 *
 * The `@evidence`-tagged test satisfies the Visual evidence CI gate (this is a
 * frontend-visual route change). `captureEvidence` is a hard no-op unless
 * `EZCORP_E2E_EVIDENCE=1`, so the normal `e2e-mock` run stays byte-identical.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeExtension } from "./fixtures/data.js";

// Seed three non-bundled extensions whose INSERTION order is not alphabetical
// and whose createdAt/updatedAt differ, so each sort mode yields a distinct,
// verifiable order:
//
//   name         createdAt     updatedAt
//   ----         ---------     ---------
//   zeta         2026-02-01    2026-02-15
//   alpha        2026-03-01    2026-03-10
//   mike         2026-01-01    2026-06-01
//
// Expected orders:
//   name-asc  (default) → alpha, mike, zeta
//   name-desc           → zeta,  mike, alpha
//   recent (updatedAt↓) → mike (06-01), alpha (03-10), zeta (02-15)
//   oldest (createdAt↑) → mike (01-01), zeta (02-01),  alpha (03-01)
function seededExtensions() {
	return [
		makeExtension({
			id: "ext-zeta",
			name: "zeta",
			isBundled: false,
			createdAt: "2026-02-01T00:00:00.000Z",
			updatedAt: "2026-02-15T00:00:00.000Z",
		}),
		makeExtension({
			id: "ext-alpha",
			name: "alpha",
			isBundled: false,
			createdAt: "2026-03-01T00:00:00.000Z",
			updatedAt: "2026-03-10T00:00:00.000Z",
		}),
		makeExtension({
			id: "ext-mike",
			name: "mike",
			isBundled: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
		}),
	];
}

/** Read the visible card order as the list of `<h3>` extension names. */
function cardNames(page: import("@playwright/test").Page) {
	// Each `[data-testid="ext-card"]` renders the name in its only <h3>.
	return page.getByTestId("ext-card").locator("h3");
}

test.describe("Extensions sort control", () => {
	const proj = makeProject({ id: "proj-1" });

	test("defaults to Name A–Z on load", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: seededExtensions() });

		await page.goto("/extensions");

		// Wait for the client refresh to land all three cards on the Installed tab.
		await expect(page.getByTestId("ext-card")).toHaveCount(3);
		// Default sort = name-asc (case-insensitive A–Z).
		await expect(cardNames(page)).toHaveText(["alpha", "mike", "zeta"]);
		// The select itself reflects the default value.
		await expect(page.getByTestId("ext-sort-select")).toHaveValue("name-asc");
	});

	test("Name (Z–A) reverses to zeta, mike, alpha", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: seededExtensions() });

		await page.goto("/extensions");
		await expect(page.getByTestId("ext-card")).toHaveCount(3);

		await page.getByTestId("ext-sort-select").selectOption("name-desc");

		await expect(cardNames(page)).toHaveText(["zeta", "mike", "alpha"]);
	});

	test("Recently updated orders by updatedAt descending", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: seededExtensions() });

		await page.goto("/extensions");
		await expect(page.getByTestId("ext-card")).toHaveCount(3);

		await page.getByTestId("ext-sort-select").selectOption("recent");

		// updatedAt desc: mike (06-01) > alpha (03-10) > zeta (02-15).
		await expect(cardNames(page)).toHaveText(["mike", "alpha", "zeta"]);
		// Cross-check via data-ext-id so the assertion isn't only name-based:
		// the first card must be the most-recently-updated extension.
		await expect(page.getByTestId("ext-card").first()).toHaveAttribute(
			"data-ext-id",
			"ext-mike",
		);
	});

	test("Oldest first orders by createdAt ascending", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: seededExtensions() });

		await page.goto("/extensions");
		await expect(page.getByTestId("ext-card")).toHaveCount(3);

		await page.getByTestId("ext-sort-select").selectOption("oldest");

		// createdAt asc: mike (01-01) < zeta (02-01) < alpha (03-01).
		await expect(cardNames(page)).toHaveText(["mike", "zeta", "alpha"]);
	});

	test("renders cards sorted and captures evidence @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], extensions: seededExtensions() });

		await page.goto("/extensions");

		// Capture the default A–Z state once cards have rendered.
		await expect(page.getByTestId("ext-card")).toHaveCount(3);
		await expect(cardNames(page)).toHaveText(["alpha", "mike", "zeta"]);
		await captureEvidence(page, testInfo, "extensions-sort");

		// Capture a second state after switching to "Recently updated" so the
		// evidence shows the reorder actually happened.
		await page.getByTestId("ext-sort-select").selectOption("recent");
		await expect(cardNames(page)).toHaveText(["mike", "alpha", "zeta"]);
		await captureEvidence(page, testInfo, "extensions-sort-recent");

		// Assert the capture contract both with and without the flag (mirrors
		// the sibling visual-evidence spec) so the test is meaningful in either
		// mode rather than a bare screenshot call.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "extensions-sort" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "extensions-sort")).toBe(false);
		}
	});
});
