/**
 * Phase 52.1 — Library tabs: Built-ins vs Installed.
 *
 * Walks the user-visible tab UI: defaults to "Installed", click switches
 * the rendered card grid, localStorage round-trip preserves the tab on
 * reload, "Built-ins" empty state shows the Phase-53 placeholder copy.
 *
 * The page does an SSR load + a client-side `loadExtensions()` on
 * mount; mocks here only have to intercept `/api/extensions` (the
 * client refresh). The SSR loader soft-fails to [] when the DB
 * isn't available, so the assertions assume the client-fetch payload
 * is the source of truth in the e2e env.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

function makeExt(overrides: Record<string, unknown> = {}) {
	return {
		id: overrides.id ?? "ext-1",
		name: overrides.name ?? "my-extension",
		version: overrides.version ?? "1.0.0",
		description: overrides.description ?? "A handy extension for testing",
		enabled: overrides.enabled !== undefined ? overrides.enabled : true,
		source: overrides.source ?? "local",
		consecutiveFailures: overrides.consecutiveFailures ?? 0,
		isBundled: overrides.isBundled ?? false,
		manifest: {
			tools: [{ name: "analyze", description: "Analyze code" }],
			permissions: {},
			...(overrides.manifest as object ?? {}),
		},
		grantedPermissions: overrides.grantedPermissions ?? {},
		...overrides,
	};
}

test.describe("Extensions Library tabs", () => {
	const proj = makeProject({ id: "proj-1" });

	test("defaults to Installed tab and renders only non-bundled cards", async ({
		page,
		mockApi,
	}) => {
		const installed = makeExt({ id: "ext-installed", name: "user-ext", isBundled: false });
		// SSR + client fetch share the same /api/extensions mock.
		await mockApi({ projects: [proj], extensions: [installed] });

		await page.goto("/extensions");

		// Default tab indicator
		await expect(page.getByTestId("ext-tab-panel")).toHaveAttribute(
			"data-active-tab",
			"installed",
		);
		await expect(
			page.getByRole("tab", { name: /Installed/ }),
		).toHaveAttribute("aria-selected", "true");
		await expect(
			page.getByRole("tab", { name: /Built-ins/ }),
		).toHaveAttribute("aria-selected", "false");

		await expect(page.getByText("user-ext")).toBeVisible();
	});

	test("switching to Built-ins shows only bundled cards", async ({
		page,
		mockApi,
	}) => {
		const installed = makeExt({ id: "i-1", name: "user-ext", isBundled: false });
		const bundled = makeExt({ id: "b-1", name: "core-ext", isBundled: true });
		await mockApi({ projects: [proj], extensions: [installed, bundled] });

		await page.goto("/extensions");

		// Wait for the client refresh to complete so both cards are on
		// the page DOM (in different tab panels).
		await expect(page.getByText("user-ext")).toBeVisible();

		await page.getByTestId("ext-tab-builtins").click();

		await expect(page.getByTestId("ext-tab-panel")).toHaveAttribute(
			"data-active-tab",
			"builtins",
		);
		await expect(page.getByText("core-ext")).toBeVisible();
		await expect(page.getByText("user-ext")).not.toBeVisible();
	});

	test("Built-ins empty state copy when no bundled rows", async ({
		page,
		mockApi,
	}) => {
		const installed = makeExt({ id: "i-1", name: "user-ext", isBundled: false });
		await mockApi({ projects: [proj], extensions: [installed] });

		await page.goto("/extensions");
		await page.getByTestId("ext-tab-builtins").click();

		await expect(page.getByText("No built-in extensions yet")).toBeVisible();
		await expect(page.getByText(/Phase 53/)).toBeVisible();
	});

	test("active tab persists across reload via localStorage", async ({
		page,
		mockApi,
	}) => {
		const installed = makeExt({ id: "i-1", name: "user-ext", isBundled: false });
		const bundled = makeExt({ id: "b-1", name: "core-ext", isBundled: true });
		await mockApi({ projects: [proj], extensions: [installed, bundled] });

		await page.goto("/extensions");
		await page.getByTestId("ext-tab-builtins").click();
		await expect(page.getByTestId("ext-tab-panel")).toHaveAttribute(
			"data-active-tab",
			"builtins",
		);

		// localStorage assertion — proves the helper wrote the expected key.
		const persisted = await page.evaluate(() =>
			localStorage.getItem("ezcorp.extensions.activeTab"),
		);
		expect(persisted).toBe("builtins");

		await page.reload();
		await expect(page.getByTestId("ext-tab-panel")).toHaveAttribute(
			"data-active-tab",
			"builtins",
		);
		await expect(page.getByText("core-ext")).toBeVisible();
	});

	test("bundled cards hide the Uninstall button", async ({ page, mockApi }) => {
		const bundled = makeExt({ id: "b-1", name: "core-ext", isBundled: true });
		await mockApi({ projects: [proj], extensions: [bundled] });

		await page.goto("/extensions");
		await page.getByTestId("ext-tab-builtins").click();

		// Uninstall is replaced by a "Built-in" badge.
		const card = page.locator('[data-testid="ext-card"][data-ext-id="b-1"]');
		await expect(card).toBeVisible();
		await expect(card.getByTestId("ext-card-builtin-badge")).toBeVisible();
		await expect(card.getByText("Uninstall")).toHaveCount(0);
	});
});
