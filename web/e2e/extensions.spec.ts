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

		await expect(page.getByRole("heading", { name: "Extensions" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Create your own")).toBeVisible();
	});

	test("shows Install Extension section with Local Path and GitHub tabs", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});
		await page.goto("/extensions");

		await expect(page.getByText("Install Extension")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Local Path" })).toBeVisible();
		await expect(page.getByRole("button", { name: "GitHub" })).toBeVisible();
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

	test("Uninstall button requires confirmation before removing", async ({ page, mockApi }) => {
		const ext = makeExtension({ id: "ext-1", name: "removable-ext" });

		await mockApi({
			projects: [proj],
			extensions: [ext],
		});
		await page.goto("/extensions");

		// Click uninstall — should show Confirm button
		await page.getByRole("button", { name: "Uninstall" }).click();
		await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible({ timeout: 3000 });
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

	test("switching to GitHub mode shows user/repo placeholder", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});
		await page.goto("/extensions");

		await page.getByRole("button", { name: "GitHub" }).click();

		await expect(page.getByPlaceholder("user/repo or user/repo@v1.0.0")).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("button", { name: "Install from GitHub" })).toBeVisible();
	});

	test("local path mode shows path input and Install button", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});
		await page.goto("/extensions");

		// Local Path is default mode
		await expect(page.getByPlaceholder("/path/to/extension")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Install" })).toBeVisible();
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

		// Dialog-based enable flow POSTs to /activate. Register this BEFORE
		// the PATCH route so the more specific path wins (Playwright picks
		// the most recently registered matching handler).
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

	test("disabled extension: click toggle → dialog → POST /activate → UI flips to on", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const ctrl = await installToggleMock(page, makeExtension({ id: "ext-1", name: "toggle-ext", enabled: false }));

		await page.goto("/extensions");
		await expect(page.locator("button[title='Enable']")).toBeVisible({ timeout: 5000 });

		await page.locator("button[title='Enable']").click();

		// Enable flow now intercepts via permission-review dialog; the
		// off→on PATCH path no longer fires. Confirm the dialog, then the
		// UI should flip after the POST /activate round-trip.
		await expect(page.getByText("Review permissions: toggle-ext")).toBeVisible({ timeout: 3000 });
		await page.getByRole("button", { name: "Enable with selected permissions" }).click();

		await expect(page.locator("button[title='Disable']")).toBeVisible({ timeout: 5000 });
		expect(ctrl.activateCalls).toHaveLength(1);
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

	test("re-enable blocked by security violation: 403 → error toast", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		await page.route("**/api/extensions", async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			await route.fulfill({
				json: [makeExtension({ id: "ext-1", name: "blocked-ext", enabled: false })],
			});
		});
		// Enable goes through the review dialog → POST /activate.
		// Server responds 403 with the "security violations" message.
		await page.route("**/api/extensions/ext-1/activate", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await route.fulfill({
				status: 403,
				json: { error: "Cannot re-enable extension with security violations. Clear violations first." },
			});
		});

		await page.goto("/extensions");
		await expect(page.locator("button[title='Enable']")).toBeVisible({ timeout: 5000 });

		await page.locator("button[title='Enable']").click();
		await expect(page.getByText("Review permissions: blocked-ext")).toBeVisible({ timeout: 3000 });
		await page.getByRole("button", { name: "Enable with selected permissions" }).click();

		// Toggle stays off and the 403's error text surfaces as a toast.
		await expect(page.locator("button[title='Enable']")).toBeVisible({ timeout: 3000 });
		await expect(page.locator("button[title='Disable']")).not.toBeVisible();
		await expect(page.getByText(/security violations/)).toBeVisible({ timeout: 3000 });
	});

	test("auto-disabled Re-enable banner button: routes through dialog then POST /activate", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const ctrl = await installToggleMock(
			page,
			makeExtension({ id: "ext-1", name: "flaky-ext", enabled: false, consecutiveFailures: 3 }),
		);

		await page.goto("/extensions");
		await expect(page.getByRole("button", { name: "Re-enable" })).toBeVisible({ timeout: 5000 });

		// The banner's Re-enable button shares the toggleEnabled path, which
		// now opens the review dialog rather than firing PATCH directly.
		await page.getByRole("button", { name: "Re-enable" }).click();
		await expect(page.getByText("Review permissions: flaky-ext")).toBeVisible({ timeout: 3000 });
		await page.getByRole("button", { name: "Enable with selected permissions" }).click();

		await expect(page.locator("button[title='Disable']")).toBeVisible({ timeout: 5000 });
		expect(ctrl.activateCalls).toHaveLength(1);
		expect(ctrl.patchCalls).toHaveLength(0);
	});
});

test.describe("Extension Detail Page", () => {
	const proj = makeProject({ id: "proj-1" });

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

	test("shows Permissions section", async ({ page, mockApi }) => {
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

		// "Permissions" is both a section heading and part of the "Save
		// Permissions" button label — pin to the heading explicitly.
		await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Network Access")).toBeVisible();
		await expect(page.getByText("Filesystem Access")).toBeVisible();
		await expect(page.getByText("Shell Access")).toBeVisible();
		await expect(page.getByText("Environment Variables")).toBeVisible();
	});

	test("shows network domains with checkboxes", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({
			id: "ext-1",
			permissions: {
				network: ["api.openai.com", "api.anthropic.com"],
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

		await expect(page.getByText("api.openai.com")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("api.anthropic.com")).toBeVisible();
	});

	test("shows shell Requested badge when extension requests shell", async ({ page, mockApi }) => {
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

		// "None requested" appears for the non-shell permission rows; use an
		// exact match so only the red "Requested" badge resolves.
		await expect(page.getByText("Requested", { exact: true })).toBeVisible({ timeout: 5000 });
	});

	test("shows 'None requested' when no network domains", async ({ page, mockApi }) => {
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

		// "None requested" appears multiple times (network, filesystem, env)
		const noneTexts = page.getByText("None requested");
		await expect(noneTexts.first()).toBeVisible({ timeout: 5000 });
	});

	test("shows Save Permissions button", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		await expect(page.getByRole("button", { name: "Save Permissions" })).toBeVisible({ timeout: 5000 });
	});

	test("shows Sensitive Operations section", async ({ page, mockApi }) => {
		const detail = makeExtensionDetail({ id: "ext-1" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/extensions/ext-1");

		// "Sensitive Operations" appears as the heading and again in the
		// section's description paragraph — pin to the heading.
		await expect(page.getByRole("heading", { name: "Sensitive Operations" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Always allow shell commands")).toBeVisible();
		await expect(page.getByText("Always allow filesystem writes")).toBeVisible();
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

	/**
	 * Install stateful handlers that model the full POST-install →
	 * GET-list → POST-activate → GET-list round-trip. Registered AFTER
	 * mockApi so they win route matching. Returns records the test can
	 * inspect to assert exact request bodies.
	 */
	async function installInstallFlowMock(
		page: import("@playwright/test").Page,
		opts: {
			installResponse?: ReturnType<typeof makeExtension>;
			installStatus?: number;
			installError?: string;
		} = {},
	) {
		const installCalls: Array<{ body: any }> = [];
		const activateCalls: Array<{ id: string; body: any }> = [];
		const patchCalls: Array<{ id: string; body: any }> = [];
		let state: ReturnType<typeof makeExtension> | null = null;

		await page.route("**/api/extensions", async (route) => {
			const method = route.request().method();
			if (method === "GET") {
				await route.fulfill({
					json: state ? [state] : [],
					headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=60" },
				});
				return;
			}
			if (method === "POST") {
				const body = route.request().postDataJSON();
				installCalls.push({ body });
				if (opts.installStatus && opts.installStatus >= 400) {
					await route.fulfill({
						status: opts.installStatus,
						json: { error: opts.installError ?? "Install failed" },
					});
					return;
				}
				state = opts.installResponse ?? makeExtension({ id: "ext-new", enabled: false });
				await route.fulfill({ status: 201, json: state });
				return;
			}
			return route.fallback();
		});

		// Activate + PATCH live on /api/extensions/<id>...
		await page.route(/\/api\/extensions\/[^/]+\/activate$/, async (route) => {
			const url = new URL(route.request().url());
			const parts = url.pathname.split("/");
			const id = parts[parts.length - 2]!;
			const body = route.request().postDataJSON();
			activateCalls.push({ id, body });
			if (state && state.id === id) {
				state = { ...state, enabled: true };
			}
			await route.fulfill({ json: state });
		});

		await page.route(/\/api\/extensions\/[^/]+$/, async (route) => {
			const method = route.request().method();
			if (method !== "PATCH") return route.fallback();
			const url = new URL(route.request().url());
			const id = url.pathname.split("/").pop()!;
			const body = route.request().postDataJSON();
			patchCalls.push({ id, body });
			if (state && state.id === id) {
				state = { ...state, enabled: body.enabled };
			}
			await route.fulfill({ json: state });
		});

		return {
			installCalls,
			activateCalls,
			patchCalls,
			currentState: () => state,
			setState: (s: ReturnType<typeof makeExtension> | null) => {
				state = s;
			},
		};
	}

	test("github install → Disabled badge → review dialog clamps shell → activate without shell", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const ctrl = await installInstallFlowMock(page, {
			installResponse: makeExtension({
				id: "ext-new",
				name: "gh-ext",
				enabled: false,
				manifest: {
					tools: [{ name: "scan", description: "scan code" }],
					permissions: { network: ["api.example.com"], shell: true },
				},
			}),
		});

		await page.goto("/extensions");

		// Scenario 1: switch to GitHub tab, enter repo, click Install
		await page.getByRole("button", { name: "GitHub" }).click();
		await page.getByPlaceholder("user/repo or user/repo@v1.0.0").fill("test-owner/test-repo@v1.0.0");
		await page.getByRole("button", { name: "Install from GitHub" }).click();

		// Card appears after refetch. Badge confirms the install landed disabled.
		await expect(page.getByText("gh-ext")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Disabled")).toBeVisible();
		expect(ctrl.installCalls).toHaveLength(1);
		expect(ctrl.installCalls[0]!.body.source).toBe("github");
		expect(ctrl.installCalls[0]!.body.repo).toBe("test-owner/test-repo@v1.0.0");

		// Scenario 2: click toggle — permission-review dialog opens with both
		// shell (red warning) and network entries visible.
		await page.locator("button[title='Enable']").click();
		await expect(page.getByText("Review permissions: gh-ext")).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("Shell access")).toBeVisible();
		await expect(page.getByText("api.example.com")).toBeVisible();

		// Scenario 3: uncheck shell (it starts checked), keep network, confirm.
		const shellCheckbox = page.locator("input[type='checkbox']").nth(0);
		// Shell checkbox is the first one rendered (when shell perm is present).
		// Verify it starts checked before unchecking.
		await expect(shellCheckbox).toBeChecked();
		await shellCheckbox.uncheck();

		await page.getByRole("button", { name: "Enable with selected permissions" }).click();

		// Activate call body must carry network ONLY — shell was unchecked.
		await expect.poll(() => ctrl.activateCalls.length).toBe(1);
		const activate = ctrl.activateCalls[0]!;
		expect(activate.id).toBe("ext-new");
		expect(activate.body.grantedPermissions.network).toEqual(["api.example.com"]);
		expect(activate.body.grantedPermissions.shell).toBeUndefined();

		// Scenario 4: badge flips. Disabled badge gone; Disable toggle visible.
		await expect(page.getByText("Disabled")).toBeHidden({ timeout: 5000 });
		await expect(page.locator("button[title='Disable']")).toBeVisible();
	});

	test("cancel path: dialog cancel makes NO activate call", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const ctrl = await installInstallFlowMock(page);
		ctrl.setState(makeExtension({
			id: "ext-cancel",
			name: "cancel-ext",
			enabled: true,
			manifest: {
				tools: [],
				permissions: { network: ["api.example.com"], shell: true },
			},
		}));

		await page.goto("/extensions");
		await expect(page.getByText("cancel-ext")).toBeVisible({ timeout: 5000 });

		// Disable first (toggle on enabled ext → PATCH enabled:false).
		await page.locator("button[title='Disable']").click();
		await expect.poll(() => ctrl.patchCalls.length).toBe(1);
		expect(ctrl.patchCalls[0]!.body).toEqual({ enabled: false });

		// Now click toggle again to start the enable flow, then Cancel.
		await page.locator("button[title='Enable']").click();
		await expect(page.getByText("Review permissions: cancel-ext")).toBeVisible({ timeout: 3000 });

		await page.getByRole("button", { name: "Cancel" }).click();

		// Dialog must be gone and /activate must never have fired.
		await expect(page.getByText("Review permissions: cancel-ext")).toBeHidden({ timeout: 3000 });
		expect(ctrl.activateCalls).toHaveLength(0);
		// Extension is still disabled.
		await expect(page.locator("button[title='Enable']")).toBeVisible();
	});

	test("non-admin install: server 403 → error toast, extension not added", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const ctrl = await installInstallFlowMock(page, {
			installStatus: 403,
			installError: "Insufficient permissions",
		});

		await page.goto("/extensions");

		await page.getByPlaceholder("/path/to/extension").fill("/tmp/some-ext");
		await page.getByRole("button", { name: "Install" }).click();

		// Error toast surfaces the 403. List stays empty (no card rendered).
		await expect(page.getByText(/Insufficient permissions|Install failed/)).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("No extensions installed")).toBeVisible();
		// Install was attempted but the server rejected it; no activate ever followed.
		expect(ctrl.installCalls).toHaveLength(1);
		expect(ctrl.activateCalls).toHaveLength(0);
	});

	test("git source tab: clones any branch and extension appears in list", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const ctrl = await installInstallFlowMock(page, {
			installResponse: makeExtension({
				id: "ext-git",
				name: "git-ext",
				enabled: false,
				source: "git",
				manifest: { tools: [], permissions: {} },
			}),
		});

		await page.goto("/extensions");

		await page.getByRole("button", { name: "Git URL" }).click();
		await page
			.getByPlaceholder("https://github.com/owner/repo.git or git@host:owner/repo.git")
			.fill("https://github.com/foo/bar.git");
		await page.getByRole("button", { name: "Install from Git" }).click();

		await expect(page.getByText("git-ext")).toBeVisible({ timeout: 5000 });
		expect(ctrl.installCalls).toHaveLength(1);
		expect(ctrl.installCalls[0]!.body.source).toBe("git");
		expect(ctrl.installCalls[0]!.body.url).toBe("https://github.com/foo/bar.git");
	});
});
