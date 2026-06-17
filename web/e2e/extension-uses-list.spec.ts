/**
 * Extension detail "Uses" chip list (Phase 4 §5.3) — e2e render path.
 *
 * The detail page renders read-only "Uses" chips from
 * `manifest.dependencies`. An extension with declared deps shows the
 * chips (name+version); one without declares nothing.
 *
 * The author-flow pick + capability-toggle integration is covered by
 * `AuthorCompositionPanel.component.test.ts` (it drives the REAL
 * ExtensionAttachPicker + the real config-edit logic); the author draft
 * page itself loads a real on-disk draft via SSR, which needs the Docker
 * harness — out of this render-path leg.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const USER_ME = { user: { id: "user-1", email: "user@test.local", name: "U", role: "user" } };

function makeDetail(dependencies?: Record<string, { source: string; version: string }>): Record<string, unknown> {
	return {
		id: "ext-composed",
		name: "composed-ext",
		version: "1.0.0",
		description: "Composes other extensions.",
		enabled: true,
		source: "local",
		installPath: "/tmp/composed-ext",
		checksumVerified: true,
		consecutiveFailures: 0,
		manifest: {
			author: "Test",
			entrypoint: "./index.ts",
			persistent: false,
			tools: [],
			permissions: {},
			...(dependencies ? { dependencies } : {}),
		},
		grantedPermissions: { network: [], filesystem: [], shell: false, env: [], grantedAt: {} },
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

test.describe("extension detail — Uses list", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	test("renders Uses chips from manifest.dependencies (name + version)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-composed": () =>
					makeDetail({
						"ai-kit": { source: "bundled", version: "^0.1.0" },
						"web-search": { source: "bundled", version: "^1.0.0" },
					}),
				"/api/auth/me": () => USER_ME,
			},
		});
		await page.goto("/extensions/ext-composed");

		const uses = page.getByTestId("extension-uses-list");
		await expect(uses).toBeVisible({ timeout: 5000 });
		const chips = page.getByTestId("extension-uses-chip");
		await expect(chips).toHaveCount(2);
		// Name-sorted: ai-kit first.
		await expect(chips.first()).toContainText("ai-kit");
		await expect(chips.first()).toContainText("^0.1.0");
		await expect(uses).toContainText("web-search");
	});

	test("no dependencies → no Uses section", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-composed": () => makeDetail(),
				"/api/auth/me": () => USER_ME,
			},
		});
		await page.goto("/extensions/ext-composed");

		// The detail page loaded (name heading visible), but no Uses list.
		await expect(page.getByRole("heading", { name: "composed-ext" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("extension-uses-list")).toHaveCount(0);
	});
});
