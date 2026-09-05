import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

// Factory for a full extension record (as returned by GET /api/extensions)
function makeExtension(overrides: Record<string, unknown> = {}) {
	return {
		id: overrides.id ?? "ext-1",
		name: overrides.name ?? "my-extension",
		version: overrides.version ?? "1.0.0",
		description: overrides.description ?? "A handy extension for testing",
		enabled: overrides.enabled !== undefined ? overrides.enabled : true,
		source: overrides.source ?? "local",
		consecutiveFailures: overrides.consecutiveFailures ?? 0,
		manifest: {
			tools: overrides.tools ?? [
				{ name: "analyze", description: "Analyze code" },
			],
			permissions: overrides.permissions ?? {},
			...(overrides.manifest as object ?? {}),
		},
		grantedPermissions: overrides.grantedPermissions ?? {},
		...overrides,
	};
}

// Factory for extension detail page response (GET /api/extensions/:id)
function makeExtensionDetail(overrides: Record<string, unknown> = {}) {
	return {
		id: overrides.id ?? "ext-1",
		name: overrides.name ?? "my-extension",
		version: overrides.version ?? "1.0.0",
		description: overrides.description ?? "A handy extension for testing",
		enabled: overrides.enabled !== undefined ? overrides.enabled : true,
		source: overrides.source ?? "local",
		installPath: overrides.installPath ?? "/home/user/.extensions/my-extension",
		checksumVerified: overrides.checksumVerified !== undefined ? overrides.checksumVerified : true,
		consecutiveFailures: overrides.consecutiveFailures ?? 0,
		manifest: {
			author: overrides.author ?? "Test Author",
			entrypoint: overrides.entrypoint ?? "index.ts",
			persistent: overrides.persistent ?? false,
			tools: overrides.tools ?? [
				{
					name: "analyze",
					description: "Analyze code for issues",
					inputSchema: { type: "object", properties: { file: { type: "string", description: "File path" } } },
				},
			],
			permissions: {
				network: overrides.network ?? [],
				filesystem: overrides.filesystem ?? [],
				shell: overrides.shell ?? false,
				env: overrides.env ?? [],
				...(overrides.permissions as object ?? {}),
			},
		},
		grantedPermissions: {
			network: [],
			filesystem: [],
			shell: false,
			env: [],
			grantedAt: {},
			...(overrides.grantedPermissions as object ?? {}),
		},
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

test.describe("Extensions List Page", () => {
	const proj = makeProject({ id: "proj-1" });

	test("shows Extensions heading and Create your own link", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});
		await page.goto("/extensions");

		// `exact` is required: this test seeds no extensions, so the empty
		// state's "No extensions installed" heading also matches the default
		// substring lookup and the locator resolves to two elements.
		await expect(page.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Create your own")).toBeVisible();
	});

	test("shows source review and MCP installation choices", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});
		await page.goto("/extensions");

		await expect(page.getByText("Install Extension")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Extension source", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "MCP Server", exact: true })).toBeVisible();
		await expect(page.getByRole("link", { name: "Choose source", exact: true })).toHaveAttribute("href", "/extensions/import-source");
	});

	test("shows empty state when no extensions installed", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});
		await page.goto("/extensions");

		await expect(page.getByText("No extensions installed")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Browse Marketplace")).toBeVisible();
		await expect(page.getByRole("link", { name: "Browse Marketplace" })).toHaveAttribute("href", "/marketplace");
	});

	test("lists installed extensions with name and version", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-1", name: "code-linter", version: "2.3.1" });

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		await expect(page.getByText("code-linter")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("v2.3.1")).toBeVisible();
	});

	test("shows extension description", async ({ page, mockApi }) => {
		const ext = makeExtension({
			id: "ext-1",
			description: "Lints code automatically on save",
		});

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		await expect(page.getByText("Lints code automatically on save")).toBeVisible({ timeout: 5000 });
	});

	test("shows tool count badge on extension card", async ({ page, mockApi }) => {
		const ext = makeExtension({
			id: "ext-1",
			manifest: {
				tools: [
					{ name: "lint", description: "Run linter" },
					{ name: "format", description: "Format code" },
					{ name: "check", description: "Check types" },
				],
				permissions: {},
			},
		});

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		await expect(page.getByText("3 tools")).toBeVisible({ timeout: 5000 });
	});

	test("shows singular 'tool' badge when only one tool", async ({ page, mockApi }) => {
		const ext = makeExtension({
			id: "ext-1",
			manifest: {
				tools: [{ name: "analyze", description: "Analyze code" }],
				permissions: {},
			},
		});

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		await expect(page.getByText("1 tool")).toBeVisible({ timeout: 5000 });
	});

	test("shows permission badges for network, filesystem, shell, env", async ({ page, mockApi }) => {
		const ext = makeExtension({
			id: "ext-1",
			manifest: {
				tools: [],
				permissions: {
					network: ["api.example.com"],
					filesystem: ["/tmp"],
					shell: true,
					env: ["API_KEY"],
				},
			},
		});

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		await expect(page.getByText("network")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("filesystem")).toBeVisible();
		await expect(page.getByText("shell")).toBeVisible();
		await expect(page.getByText("env")).toBeVisible();
	});

	test("shell permission badge has red styling", async ({ page, mockApi }) => {
		const ext = makeExtension({
			id: "ext-1",
			manifest: {
				tools: [],
				permissions: { shell: true },
			},
		});

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		const shellBadge = page.getByText("shell");
		await expect(shellBadge).toBeVisible({ timeout: 5000 });
		await expect(shellBadge).toHaveClass(/text-red-300/);
	});

	test("disabled extension shows enable toggle in off state", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-1", enabled: false });

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		// The toggle button for disabled extension has the off-state background
		const toggle = page.locator("button[title='Enable']");
		await expect(toggle).toBeVisible({ timeout: 5000 });
	});

	test("enabled extension shows disable toggle", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-1", enabled: true });

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		const toggle = page.locator("button[title='Disable']");
		await expect(toggle).toBeVisible({ timeout: 5000 });
	});

	test("shows Uninstall button on extension card", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-1" });

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		await expect(page.getByRole("button", { name: "Uninstall" })).toBeVisible({ timeout: 5000 });
	});

	test("Uninstall explains retained data and requires confirmation", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-1", name: "removable-ext" });

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		await page.getByTestId("ext-card-uninstall").click();

		const dialog = page.getByTestId("uninstall-dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await expect(dialog).toContainText("release history, settings, secrets, stored data and files are kept");
		await expect(dialog).toContainText("Data deletion requires a separate review");
		await expect(page.getByTestId("uninstall-confirm")).toBeEnabled();
		await expect(page.getByTestId("uninstall-delete-data")).toHaveCount(0);
	});

	test("uninstall keeping data sends no purgeData flag", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-1", name: "removable-ext" });

		await mockApi({ projects: [proj], extensions: [ext] });
		// AFTER mockApi: Playwright runs the most recently registered handler
		// first, so registering before the fixture's catch-all never fires.
		const deleteUrls: string[] = [];
		await page.route("**/api/extensions/ext-1*", async (route) => {
			if (route.request().method() !== "DELETE") return route.fallback();
			deleteUrls.push(route.request().url());
			return route.fulfill({ status: 204, body: "" });
		});
		await page.goto("/extensions");

		await page.getByTestId("ext-card-uninstall").click();
		await page.getByTestId("uninstall-confirm").click();

		await expect.poll(() => deleteUrls.length).toBe(1);
		expect(deleteUrls[0]).not.toContain("purgeData");

		await expect(page.getByTestId("uninstall-dialog")).toHaveCount(0);
		await expect(page.getByText("removable-ext uninstalled — its data was kept", { exact: true })).toBeVisible();
	});

	test("cancelling uninstall sends no deletion and keeps the installation", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-1", name: "removable-ext" });

		await mockApi({ projects: [proj], extensions: [ext] });
		const deleteUrls: string[] = [];
		await page.route("**/api/extensions/ext-1*", async (route) => {
			if (route.request().method() !== "DELETE") return route.fallback();
			deleteUrls.push(route.request().url());
			return route.fulfill({ status: 204, body: "" });
		});
		await page.goto("/extensions");

		await page.getByTestId("ext-card-uninstall").click();
		await expect(page.getByTestId("uninstall-delete-data")).toHaveCount(0);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(page.getByTestId("uninstall-dialog")).toHaveCount(0);
		expect(deleteUrls).toEqual([]);
		await expect(page.getByTestId("ext-card").filter({ hasText: "removable-ext" })).toBeVisible();
	});

	test("a failed uninstall keeps the dialog open and says why", async ({ page, mockApi }) => {
		// The failure path had no coverage on either surface: a 500 must not
		// look like a success, and closing the dialog over an extension that
		// is still installed is exactly that.
		const ext = makeExtension({ id: "ext-1", name: "removable-ext" });

		await mockApi({ projects: [proj], extensions: [ext] });
		await page.route("**/api/extensions/ext-1*", async (route) => {
			if (route.request().method() !== "DELETE") return route.fallback();
			return route.fulfill({ status: 500, json: { error: "disk is on fire" } });
		});
		await page.goto("/extensions");

		await page.getByTestId("ext-card-uninstall").click();
		await page.getByTestId("uninstall-confirm").click();

		await expect(page.getByText("disk is on fire")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("uninstall-dialog")).toBeVisible();
		// And it is usable again, not stuck mid-request.
		await expect(page.getByTestId("uninstall-confirm")).toBeEnabled();
	});

	test("a built-in offers disable, never uninstall", async ({ page, mockApi }) => {
		// Deleting a built-in's row is undone by the next boot, so the card
		// shows the provenance badge instead of a button that lies.
		const ext = makeExtension({ id: "ext-1", name: "scratchpad", isBundled: true });

		await mockApi({ projects: [proj], extensions: [ext] });
		await page.goto("/extensions");
		await page.getByTestId("ext-tab-builtins").click();

		const card = page.getByTestId("ext-card").filter({ hasText: "scratchpad" });
		await expect(card.getByTestId("ext-card-builtin-badge")).toBeVisible({ timeout: 5000 });
		await expect(card.getByTestId("ext-card-uninstall")).toHaveCount(0);
		// The toggle IS the off switch, so it must still be there.
		await expect(card.locator("button[title='Disable']")).toBeVisible();
	});

	test("disabling a critical built-in asks first and says what is lost", async ({ page, mockApi }) => {
		const ext = makeExtension({
			id: "ext-1",
			name: "ask-user",
			isBundled: true,
			isCritical: true,
			criticalConsequence:
				"Agents use this to ask you a question when they are blocked. With it off, a blocked agent stops instead of asking.",
		});

		await mockApi({ projects: [proj], extensions: [ext] });
		const patched: string[] = [];
		await page.route("**/api/extensions/ext-1", async (route) => {
			if (route.request().method() !== "PATCH") return route.fallback();
			patched.push(route.request().url());
			return route.fulfill({ json: { success: true } });
		});
		await page.goto("/extensions");
		await page.getByTestId("ext-tab-builtins").click();

		await page.locator("button[title='Disable']").click();

		// The toggle does NOT fire until the user confirms — a missing
		// `ask-user` presents as an agent that loops instead of asking, and
		// nothing else would connect the two.
		const dialog = page.getByTestId("disable-critical-dialog");
		await expect(dialog).toBeVisible({ timeout: 3000 });
		await expect(page.getByTestId("disable-critical-consequence")).toContainText(
			"ask you a question",
		);
		expect(patched).toHaveLength(0);

		await page.getByTestId("disable-critical-confirm").click();
		await expect.poll(() => patched.length).toBe(1);
	});

	test("auto-disabled extension shows warning banner with Re-enable button", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-1", name: "flaky-ext", enabled: false, consecutiveFailures: 3 });

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		// Name appears in both the banner ("flaky-ext was disabled...") and the
		// card heading, so scope the presence check to the banner text.
		await expect(page.getByText(/flaky-ext was disabled after 3 failures/)).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Re-enable" })).toBeVisible();
	});

	test("extension name links to detail page", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-abc", name: "navigable-ext" });

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		const link = page.getByRole("link", { name: /navigable-ext/ });
		await expect(link).toBeVisible({ timeout: 5000 });
		await expect(link).toHaveAttribute("href", "/extensions/ext-abc");
	});

	test("switching from MCP to source mode restores the review entry point", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});
		await page.goto("/extensions");

		await page.getByRole("button", { name: "MCP Server", exact: true }).click();
		await expect(page.getByRole("link", { name: "Choose source", exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "Extension source", exact: true }).click();
		await expect(page.getByRole("link", { name: "Choose source", exact: true })).toBeVisible();
		await expect(page.getByText("Nothing is activated before approval.", { exact: false })).toBeVisible();
	});

	test("source mode offers reviewed imports rather than retired direct installs", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});
		await page.goto("/extensions");

		await expect(page.getByRole("link", { name: "Choose source", exact: true })).toHaveAttribute("href", "/extensions/import-source");
		await expect(page.getByPlaceholder("/path/to/extension")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Git URL", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
	});

	test("multiple extensions all render", async ({ page, mockApi }) => {
		const extensions = [
			makeExtension({ id: "ext-1", name: "alpha-ext" }),
			makeExtension({ id: "ext-2", name: "beta-ext" }),
			makeExtension({ id: "ext-3", name: "gamma-ext" }),
		];

		await mockApi({
			projects: [proj],
			extensions,
		});
		await page.goto("/extensions");

		await expect(page.getByText("alpha-ext")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("beta-ext")).toBeVisible();
		await expect(page.getByText("gamma-ext")).toBeVisible();
	});
});

// Regression: the toggle button used to appear broken because the
// `/api/extensions` GET response had `Cache-Control: private, max-age=60`
// and `loadExtensions()` refetched without `cache: "no-store"` — so after
// a PATCH, the browser served the stale list from HTTP cache and the
// UI never reflected the new `enabled` state. These tests drive a
// stateful mock that echoes the PATCH body back and assert the UI
// actually flips, which requires both the PATCH to send AND the refetch
// to bypass cache.
test.describe("Extensions Toggle Round-Trip", () => {
	const proj = makeProject({ id: "proj-1" });

	/**
	 * Install stateful GET/PATCH handlers on top of mockApi. These are
	 * registered AFTER mockApi so Playwright picks them first (most
	 * recent handler wins). The GET returns the same cache headers the
	 * real endpoint sends, so we're actually testing the cache-busting
	 * behavior — not just the mock.
	 */
	async function installToggleMock(
		page: import("@playwright/test").Page,
		initial: ReturnType<typeof makeExtension>,
	) {
		let state = { ...initial };
		const patchCalls: Array<{ body: any; method: string }> = [];
		const activateCalls: Array<{ body: any }> = [];
		const getCalls: number[] = [];

		await page.route("**/api/extensions", async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			getCalls.push(Date.now());
			await route.fulfill({
				json: [state],
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "private, max-age=60",
					"ETag": `"${state.enabled ? "on" : "off"}"`,
				},
			});
		});

		await page.route("**/api/extensions/ext-1/activate", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			const body = route.request().postDataJSON();
			activateCalls.push({ body });
			state = { ...state, enabled: true };
			await route.fulfill({ json: state });
		});

		await page.route(/\/api\/extensions\/ext-1$/, async (route) => {
			const method = route.request().method();
			if (method !== "PATCH") return route.fallback();
			const body = route.request().postDataJSON();
			patchCalls.push({ body, method });
			state = { ...state, enabled: body.enabled };
			await route.fulfill({ json: state });
		});

		return {
			patchCalls,
			activateCalls,
			getCalls,
			currentState: () => state,
		};
	}

	test("enabled extension: click toggle → PATCH enabled:false → UI flips to off", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const ctrl = await installToggleMock(page, makeExtension({ id: "ext-1", name: "toggle-ext", enabled: true }));

		await page.goto("/extensions");
		await expect(page.locator("button[title='Disable']")).toBeVisible({ timeout: 5000 });

		await page.locator("button[title='Disable']").click();

		// UI must flip to the off-state — this is the behavior that broke
		// when the cached GET was served instead of a fresh one.
		await expect(page.locator("button[title='Enable']")).toBeVisible({ timeout: 5000 });
		expect(ctrl.patchCalls).toHaveLength(1);
		expect(ctrl.patchCalls[0]!.body).toEqual({ enabled: false });
		// Initial GET + refetch after PATCH = at least 2 GETs. If the
		// refetch were served from cache, this would be 1.
		expect(ctrl.getCalls.length).toBeGreaterThanOrEqual(2);
	});

	test("disabled extension: click toggle opens exact installation review without activation", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const ctrl = await installToggleMock(page, makeExtension({ id: "ext-1", name: "toggle-ext", enabled: false }));

		await page.goto("/extensions");
		await expect(page.locator("button[title='Enable']")).toBeVisible({ timeout: 5000 });

		await page.locator("button[title='Enable']").click();

		await expect(page).toHaveURL(/\/extensions\/author\?installation=ext-1$/);
		expect(ctrl.currentState().enabled).toBe(false);
		expect(ctrl.activateCalls).toHaveLength(0);
		expect(ctrl.patchCalls).toHaveLength(0);
	});

	test("loadExtensions sends cache: no-store — regression for 91722bc", async ({ page, mockApi }) => {
		// Capture the actual fetch options the page uses. If `cache` is not
		// "no-store", the browser may serve the post-PATCH refetch from cache
		// and the UI won't update. We assert on the option directly by
		// monkey-patching fetch in the page context.
		await mockApi({ projects: [proj], extensions: [] });
		await installToggleMock(page, makeExtension({ id: "ext-1", name: "toggle-ext", enabled: true }));

		await page.addInitScript(() => {
			(window as any).__fetchCalls = [];
			const realFetch = window.fetch.bind(window);
			window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url);
				if (url.includes("/api/extensions") && !url.match(/\/api\/extensions\/[^/]+/)) {
					(window as any).__fetchCalls.push({ url, cache: init?.cache ?? null });
				}
				return realFetch(input, init);
			}) as typeof window.fetch;
		});

		await page.goto("/extensions");
		await expect(page.locator("button[title='Disable']")).toBeVisible({ timeout: 5000 });

		const calls = await page.evaluate(() => (window as any).__fetchCalls as Array<{ url: string; cache: string | null }>);
		expect(calls.length).toBeGreaterThanOrEqual(1);
		// Every /api/extensions list fetch must bypass HTTP cache.
		for (const c of calls) {
			expect(c.cache).toBe("no-store");
		}
	});

	test("PATCH failure: UI stays at original state and shows error toast", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		// Override: GET returns enabled=true, PATCH returns 500.
		await page.route("**/api/extensions", async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			await route.fulfill({
				json: [makeExtension({ id: "ext-1", name: "toggle-ext", enabled: true })],
				headers: { "Cache-Control": "private, max-age=60" },
			});
		});
		await page.route("**/api/extensions/ext-1", async (route) => {
			if (route.request().method() !== "PATCH") return route.fallback();
			await route.fulfill({ status: 500, json: { error: "Boom" } });
		});

		await page.goto("/extensions");
		await expect(page.locator("button[title='Disable']")).toBeVisible({ timeout: 5000 });

		await page.locator("button[title='Disable']").click();

		// Toggle remains enabled; no flip.
		await expect(page.locator("button[title='Disable']")).toBeVisible({ timeout: 3000 });
		await expect(page.locator("button[title='Enable']")).not.toBeVisible();
		// Error toast surfaces the failure. The mock returns `{error:"Boom"}`
		// and the client bubbles `data.error` verbatim into the toast.
		await expect(page.getByText(/Boom|Update failed|Failed to update/)).toBeVisible({ timeout: 3000 });
	});

	test("opening review cannot bypass a blocked installation through the retired activate endpoint", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		await page.route("**/api/extensions", async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			await route.fulfill({
				json: [makeExtension({ id: "ext-1", name: "blocked-ext", enabled: false })],
			});
		});
		const activateCalls: string[] = [];
		await page.route("**/api/extensions/ext-1/activate", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			activateCalls.push(route.request().url());
			await route.fulfill({
				status: 403,
				json: { error: "Cannot re-enable extension with security violations. Clear violations first." },
			});
		});

		await page.goto("/extensions");
		await expect(page.locator("button[title='Enable']")).toBeVisible({ timeout: 5000 });

		await page.locator("button[title='Enable']").click();
		await expect(page).toHaveURL(/\/extensions\/author\?installation=ext-1$/);
		expect(activateCalls).toEqual([]);
		await page.goto("/extensions");
		await expect(page.locator("button[title='Enable']")).toBeVisible();
		await expect(page.locator("button[title='Disable']")).not.toBeVisible();
	});

	test("auto-disabled Re-enable banner opens review without changing failure state", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const ctrl = await installToggleMock(
			page,
			makeExtension({ id: "ext-1", name: "flaky-ext", enabled: false, consecutiveFailures: 3 }),
		);

		await page.goto("/extensions");
		await expect(page.getByRole("button", { name: "Re-enable" })).toBeVisible({ timeout: 5000 });

		await page.getByRole("button", { name: "Re-enable" }).click();
		await expect(page).toHaveURL(/\/extensions\/author\?installation=ext-1$/);
		expect(ctrl.currentState()).toMatchObject({ enabled: false, consecutiveFailures: 3 });
		expect(ctrl.activateCalls).toHaveLength(0);
		expect(ctrl.patchCalls).toHaveLength(0);
	});
});

test.describe("Extension Detail Page", () => {
	const proj = makeProject({ id: "proj-1" });

	async function readPermissions(page: import("@playwright/test").Page) {
		const section = page.getByRole("region", { name: "Release permissions", exact: true });
		await expect(section).toBeVisible();
		const records = section.locator("pre code");
		await expect(records).toHaveCount(2);
		return {
			section,
			declared: JSON.parse(await records.nth(0).innerText()),
			granted: JSON.parse(await records.nth(1).innerText()),
		};
	}

	test("shows extension name, version, and description", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({
			id: "ext-1",
			name: "super-linter",
			version: "3.0.0",
			description: "The best linter around",
		});

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByRole("heading", { name: "super-linter" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("v3.0.0")).toBeVisible();
		await expect(page.getByText("The best linter around")).toBeVisible();
	});

	test("shows back link to extensions list", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		const backLink = page.getByText(/Back to Extensions/);
		await expect(backLink).toBeVisible({ timeout: 5000 });
		await expect(backLink).toHaveAttribute("href", "/extensions");
	});

	test("shows Verified badge when checksumVerified is true", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1", checksumVerified: true });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByText("Verified")).toBeVisible({ timeout: 5000 });
	});

	test("shows Unsigned badge when checksumVerified is false", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1", checksumVerified: false });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByText("Unsigned")).toBeVisible({ timeout: 5000 });
	});

	test("shows Enabled status badge when extension is enabled", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1", enabled: true });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByText("Enabled")).toBeVisible({ timeout: 5000 });
	});

	test("shows Disabled status badge when extension is disabled", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1", enabled: false });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByText("Disabled")).toBeVisible({ timeout: 5000 });
	});

	test("shows Details section with source, entrypoint, persistent, install path", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({
			id: "ext-1",
			source: "github",
			entrypoint: "src/main.ts",
			persistent: true,
			installPath: "/home/user/.ext/my-ext",
		});

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByText("Details")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("github")).toBeVisible();
		await expect(page.getByText("src/main.ts")).toBeVisible();
		await expect(page.getByText("Yes")).toBeVisible();
		await expect(page.getByText("/home/user/.ext/my-ext")).toBeVisible();
	});

	test("shows Tools section with tool names and descriptions", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({
			id: "ext-1",
			tools: [
				{
					name: "run_tests",
					description: "Execute the test suite",
					inputSchema: { type: "object", properties: {} },
				},
				{
					name: "format_code",
					description: "Apply code formatting",
					inputSchema: { type: "object", properties: {} },
				},
			],
		});

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByText(/Tools \(2\)/)).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("run_tests")).toBeVisible();
		await expect(page.getByText("Execute the test suite")).toBeVisible();
		await expect(page.getByText("format_code")).toBeVisible();
		await expect(page.getByText("Apply code formatting")).toBeVisible();
	});

	test("shows 'No tools defined' when extension has no tools", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1", tools: [] });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByText("No tools defined")).toBeVisible({ timeout: 5000 });
	});

	test("shows exact declared permissions separately from current grants", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({
			id: "ext-1",
			permissions: {
				network: ["api.openai.com"],
				filesystem: [],
				shell: false,
				env: [],
			},
		});

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		const { section, declared, granted } = await readPermissions(page);
		await expect(section.getByRole("heading", { name: "Declared permissions", exact: true })).toBeVisible();
		await expect(section.getByRole("heading", { name: "Current grants", exact: true })).toBeVisible();
		expect(declared).toEqual(detail.manifest.permissions);
		expect(granted).toEqual(detail.grantedPermissions);
		await expect(section.locator("input, select, textarea, [contenteditable=true]")).toHaveCount(0);
	});

	test("shows declared and approved network domains without editable checkboxes", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({
			id: "ext-1",
			permissions: {
				network: ["api.openai.com", "api.anthropic.com"],
				filesystem: [],
				shell: false,
				env: [],
			},
			grantedPermissions: { network: ["api.openai.com"], grantedAt: {} },
		});

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		const { section, declared, granted } = await readPermissions(page);
		expect(declared.network).toEqual(["api.openai.com", "api.anthropic.com"]);
		expect(granted.network).toEqual(["api.openai.com"]);
		await expect(section.getByRole("checkbox")).toHaveCount(0);
	});

	test("distinguishes a declared shell capability from an unapproved grant", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({
			id: "ext-1",
			permissions: {
				network: [],
				filesystem: [],
				shell: true,
				env: [],
			},
		});

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		const { section, declared, granted } = await readPermissions(page);
		expect(declared.shell).toBe(true);
		expect(granted.shell).toBe(false);
		await expect(section.getByRole("checkbox")).toHaveCount(0);
	});

	test("shows empty capability declarations and grants without implying access", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({
			id: "ext-1",
			permissions: { network: [], filesystem: [], shell: false, env: [] },
		});

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		const { declared, granted } = await readPermissions(page);
		expect(declared).toEqual({ network: [], filesystem: [], shell: false, env: [] });
		expect(granted).toEqual({ network: [], filesystem: [], shell: false, env: [], grantedAt: {} });
	});

	test("offers release review instead of direct permission mutation", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		const { section } = await readPermissions(page);
		await expect(section.getByRole("button", { name: "Review release and permissions", exact: true })).toBeVisible();
		await expect(section.getByRole("button", { name: "Review release and permissions", exact: true })).toBeEnabled();
		await expect(page.getByRole("button", { name: "Save Permissions", exact: true })).toHaveCount(0);
		await expect(section.getByText("Permissions belong to an exact built release. Changes require a new review and human approval. Disable the extension to stop access.", { exact: true })).toBeVisible();
	});

	test("does not expose independent always-allow controls for sensitive operations", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		const { section, declared, granted } = await readPermissions(page);
		expect(declared.shell).toBe(false);
		expect(granted.filesystem).toEqual([]);
		await expect(page.getByRole("heading", { name: "Sensitive Operations", exact: true })).toHaveCount(0);
		await expect(page.getByText("Always allow shell commands", { exact: true })).toHaveCount(0);
		await expect(page.getByText("Always allow filesystem writes", { exact: true })).toHaveCount(0);
		await expect(section.getByRole("button", { name: "Review release and permissions", exact: true })).toBeVisible();
	});

	test("shows 'Extension not found' when extension does not exist", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => ({ user: null }),
			},
		});

		await page.route("**/api/extensions/nonexistent", (route) =>
			route.fulfill({ status: 404, json: { error: "Not found" } }),
		);

		await page.goto("/extensions/nonexistent");

		await expect(page.getByText("Extension not found")).toBeVisible({ timeout: 5000 });
	});

	test("shows author in version line when manifest has author", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1", version: "1.2.3", author: "Alice" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByText(/v1\.2\.3 by Alice/)).toBeVisible({ timeout: 5000 });
	});
});

// Install → permission-review → activate is the admin-only path that
// landed with sec-C3/sec-C4. These e2e tests drive the UI flow end-to-end:
// the install form (GitHub + Git URL tabs), the review dialog that clamps
// shell:true away when the admin unchecks it, and the cancel/non-admin
// paths that must NOT reach /activate.
test.describe("Extensions Install + Activate Flow", () => {
	const proj = makeProject({ id: "proj-1" });

	async function installReviewFlow(page: import("@playwright/test").Page, options: { status?: number; message?: string } = {}) {
		const { setupSourceImportMock } = await import("./fixtures/extension-source-import.js");
		const installationId = "imported-installation";
		const workspaceId = "candidate-workspace";
		const releaseId = "verified-release";
		const createdAt = "2026-01-01T00:00:00.000Z";
		const releaseDigest = "a".repeat(64);
		const grants = [JSON.stringify(["network", ["api.example.com"]])];
		const workspace = { id: workspaceId, installationId, revision: 1, sourceDigest: "b".repeat(64), createdAt };
		const state: import("../../src/extensions/v4/types").InstallationState = {
			installation: { id: installationId, ownerId: "test-user", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 },
			workspaces: { [workspaceId]: workspace },
			revisions: {},
			releases: { [releaseId]: {
				id: releaseId, installationId, workspaceId, workspaceRevision: 1,
				releaseDigest, sourceDigest: workspace.sourceDigest, artifactDigest: "c".repeat(64), imageDigest: "d".repeat(64),
				runnerProfile: "isolated-test", policyDigest: "e".repeat(64), createdAt,
				manifest: { schemaVersion: 4, name: "gh-ext", version: "1.0.0", description: "Candidate source", author: { name: "Test" }, tools: [], permissions: { network: ["api.example.com"] } },
				evidence: { protocolVersion: 4, validatorVersion: "test", discoveryDigest: "f".repeat(64), tests: [{ name: "candidate feature test", passed: true }] },
			} },
			approvals: {},
			operations: {},
		};
		const actions: Array<{ tool: string; input: Record<string, unknown> }> = [];
		const decisions: Array<{ approvalId: string; decision: boolean }> = [];
		const fixture = await setupSourceImportMock(page, {
			...options, installationId, workspaceId,
			reviewData: () => ({ installations: [state.installation], state, workspace, files: { "index.ts": "export const candidate = true;" }, canApprove: true, canBindProject: false, projects: [], projectBinding: null }),
		});
		await page.route("**/api/extensions/control", async route => {
			const request = route.request().postDataJSON();
			if (request.tool === "extensions_inspect") return route.fulfill({ json: state });
			actions.push(request);
			expect(request.tool).toBe("extensions_release");
			expect(request.input.installationId).toBe(installationId);
			if (request.input.action === "requestApproval") {
				expect(request.input).toEqual({ installationId, action: "requestApproval", releaseId, expectedActiveReleaseId: null });
				state.approvals["pending-review"] = { id: "pending-review", installationId, releaseId, releaseDigest, principalId: state.installation.ownerId, scope: "global", grants, runnerProfile: "isolated-test", expectedActiveReleaseId: null, expectedGeneration: 0, status: "pending", createdAt };
			} else {
				expect(request.input.action).toBe("activate");
				expect(request.input.approvalId).toBe("pending-review");
				expect(request.input.idempotencyKey).toEqual(expect.any(String));
				expect(state.approvals["pending-review"]?.status).toBe("approved");
				state.approvals["pending-review"]!.status = "consumed";
				Object.assign(state.installation, { enabled: true, activeReleaseId: releaseId, generation: 1, status: "active", grants });
			}
			return route.fulfill({ json: state });
		});
		await page.route(`**/api/extensions/releases/${installationId}/approve`, async route => {
			const decision = route.request().postDataJSON();
			decisions.push(decision);
			expect(decision.approvalId).toBe("pending-review");
			state.approvals["pending-review"]!.status = decision.decision ? "approved" : "rejected";
			return route.fulfill({ json: state.approvals["pending-review"] });
		});
		return { ...fixture, state, actions, decisions, releaseDigest };
	}

	async function importGithub(page: import("@playwright/test").Page, fixture: Awaited<ReturnType<typeof installReviewFlow>>, repository = "test-owner/test-repo") {
		await fixture.open();
		await page.getByLabel("GitHub repository", { exact: true }).fill(repository);
		await page.getByRole("button", { name: "Import and build candidate", exact: true }).click();
	}

	test("GitHub candidate requires exact review and separate activation", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const fixture = await installReviewFlow(page);
		await importGithub(page, fixture);
		await fixture.expectReview();
		await expect(page.getByRole("heading", { name: "Extension workspace", exact: true })).toBeVisible();
		expect(fixture.submitted).toEqual([{ kind: "github", repository: "test-owner/test-repo" }]);
		await page.getByText("Permissions and test evidence", { exact: true }).click();
		await expect(page.getByText("candidate feature test", { exact: false })).toBeVisible();
		await expect(page.getByText("api.example.com", { exact: false })).toBeVisible();
		expect(fixture.state.installation).toMatchObject({ enabled: false, activeReleaseId: null, grants: [] });
		await expect(page.getByRole("button", { name: "Activate approved release", exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "Request approval", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Human approval required", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Approve exact release", exact: true })).toBeDisabled();
		await expect(page.locator(".approval code")).toHaveText(fixture.releaseDigest);
		await page.getByLabel("I reviewed this release and its permissions.", { exact: true }).check();
		await page.getByRole("button", { name: "Approve exact release", exact: true }).click();
		await expect(page.getByRole("button", { name: "Activate approved release", exact: true })).toBeVisible();
		expect(fixture.decisions).toEqual([{ approvalId: "pending-review", decision: true }]);
		expect(fixture.state.approvals["pending-review"]?.grants).toEqual([JSON.stringify(["network", ["api.example.com"]])]);
		expect(fixture.state.installation.enabled).toBe(false);
		expect(fixture.actions.map(action => action.input.action)).toEqual(["requestApproval"]);
		await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
		await expect(page.locator(".state-badge")).toHaveText("active · generation 1");
		expect(fixture.actions.map(action => action.input.action)).toEqual(["requestApproval", "activate"]);
		expect(fixture.state.installation.activeReleaseId).toBe("verified-release");
		expect(fixture.unexpectedMutations).toEqual([]);
		await fixture.close();
	});

	test("cancel path: leaving pending review makes no approval or activation call", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const fixture = await installReviewFlow(page);
		await importGithub(page, fixture);
		await page.getByRole("button", { name: "Request approval", exact: true }).click();
		const reviewed = page.getByLabel("I reviewed this release and its permissions.", { exact: true });
		await reviewed.check();
		await expect(page.getByRole("button", { name: "Approve exact release", exact: true })).toBeEnabled();
		await reviewed.uncheck();
		await expect(page.getByRole("button", { name: "Approve exact release", exact: true })).toBeDisabled();
		await page.goto("/extensions");
		await expect(page.getByRole("link", { name: "Choose source", exact: true })).toBeVisible();
		expect(fixture.decisions).toEqual([]);
		expect(fixture.actions.map(action => action.input.action)).toEqual(["requestApproval"]);
		expect(fixture.state.installation).toMatchObject({ enabled: false, activeReleaseId: null, grants: [] });
		expect(fixture.unexpectedMutations).toEqual([]);
		await fixture.close();
	});

	test("source import denial is visible and adds no active extension", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const fixture = await installReviewFlow(page, { status: 403, message: "Administrator session required for new imports" });
		await importGithub(page, fixture);
		await expect(page.getByRole("alert")).toHaveText("Administrator session required for new imports");
		await expect(page).toHaveURL(/\/extensions\/import-source$/);
		await expect(page.getByLabel("GitHub repository", { exact: true })).toHaveValue("test-owner/test-repo");
		await expect(page.getByRole("button", { name: "Import and build candidate", exact: true })).toBeEnabled();
		expect(fixture.submitted).toHaveLength(1);
		expect(fixture.decisions).toEqual([]);
		expect(fixture.actions).toEqual([]);
		await page.getByRole("link", { name: "← Extensions", exact: true }).click();
		await expect(page.getByText("gh-ext", { exact: true })).toHaveCount(0);
		expect(fixture.state.installation.enabled).toBe(false);
		expect(fixture.unexpectedMutations).toEqual([]);
		await fixture.close();
	});

	test("GitHub branch and subdirectory import prepares source without activation", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const fixture = await installReviewFlow(page);
		await fixture.open();
		await expect(page.getByRole("option", { name: "Git URL", exact: true })).toHaveCount(0);
		await page.getByLabel("GitHub repository", { exact: true }).fill("foo/bar");
		await page.getByLabel("Branch, tag, or commit", { exact: false }).fill("feature/review");
		await page.getByLabel("Subdirectory", { exact: false }).fill("extensions/nested");
		await page.getByRole("button", { name: "Import and build candidate", exact: true }).click();
		await fixture.expectReview();
		await expect(page.getByRole("heading", { name: "Extension workspace", exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Source: index.ts", exact: true })).toHaveValue("export const candidate = true;");
		expect(fixture.submitted).toEqual([{ kind: "github", repository: "foo/bar", ref: "feature/review", directory: "extensions/nested" }]);
		expect(fixture.state.installation).toMatchObject({ enabled: false, activeReleaseId: null, grants: [] });
		expect(fixture.actions).toEqual([]);
		expect(fixture.decisions).toEqual([]);
		expect(fixture.unexpectedMutations).toEqual([]);
		await fixture.close();
	});
});
