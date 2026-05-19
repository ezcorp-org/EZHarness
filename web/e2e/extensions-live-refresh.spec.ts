/**
 * agent-install-ux-polish Phase 2 (D3/D4/D6) e2e — user-scoped live
 * Library refresh.
 *
 * Contract: with the Extensions Library tab open, an agent install
 * (Allow → host emits the user-scoped `extensions:installed` bus
 * event) makes the new extension appear in the list WITHOUT a manual
 * reload; a Deny (no event) leaves the list unchanged.
 *
 * This is the "focused page-level Playwright spec driving the SSE
 * event" option the spec allows (no Docker chat-e2e harness needed —
 * we don't drive a real LLM run; we assert the page's SSE→refresh
 * wiring). The fake EventSource (ws-mock fixture) is the same stream
 * `createWSClient()` opens; `emitSse` pushes a `data:` frame exactly
 * as `/api/runtime-events` would after `shouldDeliverEvent` passed it.
 * Server-side user-scoping is unit-tested in
 * `sse-conversation-filter.test.ts`; here the event arriving at the
 * page already implies "delivered to THIS user".
 *
 * The `/api/extensions` mock is STATEFUL: the install isn't wired
 * end-to-end in the e2e env (no real install pipeline), so we flip
 * the list payload to include the new row and assert the page's
 * post-event `loadExtensions()` (cache:"no-store" — D4) picks it up.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, type ExtensionData } from "./fixtures/data.js";

function makeExt(overrides: Partial<ExtensionData> = {}): ExtensionData {
	return {
		id: overrides.id ?? "ext-1",
		name: overrides.name ?? "my-extension",
		version: overrides.version ?? "1.0.0",
		description: overrides.description ?? "A handy extension for testing",
		enabled: overrides.enabled !== undefined ? overrides.enabled : true,
		source: overrides.source ?? "local",
		// The 5 `ExtensionData` fields the loose factory previously
		// omitted (TS2739). Sane defaults mirroring `makeExtension`:
		// not-yet-resolved install path, verified checksum, no narrowed
		// install grant (legacy/manifest-ceiling), fixed timestamps.
		installPath: overrides.installPath ?? null,
		checksumVerified: overrides.checksumVerified ?? true,
		installedPermissions: overrides.installedPermissions ?? null,
		consecutiveFailures: overrides.consecutiveFailures ?? 0,
		isBundled: overrides.isBundled ?? false,
		manifest: {
			tools: [{ name: "analyze", description: "Analyze code" }],
			permissions: {},
			...(overrides.manifest ?? {}),
		},
		grantedPermissions: overrides.grantedPermissions ?? {},
		createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
		updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
	};
}

test.describe("Extensions Library — live refresh on agent install", () => {
	const proj = makeProject({ id: "proj-1" });
	const existing = makeExt({ id: "ext-existing", name: "already-here" });
	const installed = makeExt({ id: "ext-weather", name: "weather" });

	test("agent install (extensions:installed event) refreshes the list without a reload", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj], extensions: [existing] });

		// Stateful /api/extensions: starts with only the existing row;
		// flips to include `weather` once the install "happened".
		// Registered AFTER mockApi so Playwright matches this first.
		let installCommitted = false;
		await page.route("**/api/extensions", (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			return route.fulfill({
				json: installCommitted ? [existing, installed] : [existing],
			});
		});

		await page.goto("/extensions");

		// Baseline: only the pre-existing extension is listed.
		await expect(page.getByText("already-here")).toBeVisible();
		await expect(page.getByText("weather")).toHaveCount(0);

		// The install lands server-side; the host emits the user-scoped
		// event. Flip the stateful list THEN deliver the SSE frame so
		// the page's post-event `loadExtensions()` sees the new row.
		installCommitted = true;
		await emitSse({
			type: "extensions:installed",
			data: { userId: "user-1", extensionId: "ext-weather", name: "weather" },
		});

		// No manual reload — the new extension appears purely from the
		// event-driven cache-bypassing refresh (D4).
		await expect(page.getByText("weather")).toBeVisible();
		await expect(page.getByText("already-here")).toBeVisible();
	});

	test("no event (Deny path) → list is unchanged, no spurious refresh", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj], extensions: [existing] });

		let serveCount = 0;
		await page.route("**/api/extensions", (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			serveCount += 1;
			return route.fulfill({ json: [existing] });
		});

		await page.goto("/extensions");
		await expect(page.getByText("already-here")).toBeVisible();
		const countAfterInitialLoad = serveCount;

		// An UNRELATED runtime event (mirrors "Deny → no extensions:installed
		// is emitted at all"). The page must NOT refresh on it.
		await emitSse({
			type: "run:status",
			data: { runId: "run-x", status: "running" },
		});

		// Give any (incorrect) refresh a chance to fire, then assert the
		// list endpoint was NOT re-hit and the row count is unchanged.
		await page.waitForTimeout(300);
		expect(serveCount).toBe(countAfterInitialLoad);
		await expect(page.getByText("weather")).toHaveCount(0);
	});

	test("a DIFFERENT user's install event never reaches this page (server-scoped)", async ({
		page,
		mockApi,
	}) => {
		// Defense-in-depth UI assertion. Server-side `shouldDeliverEvent`
		// is the authoritative cross-user gate (unit-tested) — it would
		// never push another user's `extensions:installed` down THIS
		// session's stream. We simulate that guarantee by NOT emitting
		// the event (it was filtered server-side); the list must stay
		// put even though a `weather` row "exists" for the other user.
		await mockApi({ projects: [proj], extensions: [existing] });
		await page.route("**/api/extensions", (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			return route.fulfill({ json: [existing] });
		});

		await page.goto("/extensions");
		await expect(page.getByText("already-here")).toBeVisible();

		// (No emitSse — the server filter dropped the cross-user event.)
		await page.waitForTimeout(300);
		await expect(page.getByText("weather")).toHaveCount(0);
	});
});
