/**
 * E2E — extension-author dependency-install ROUND TRIP (shared-search
 * residual #4).
 *
 * Phase-4 authoring lets an author pick an installed extension as a
 * dependency; the composition panel writes the managed
 * `// ezcorp:dependencies (managed)` block into the draft
 * `ezcorp.config.ts`, the draft is saved, and Install scaffolds the row.
 * That picker is covered by a COMPONENT test, but the full SSR-load
 * install round-trip (compose → save → install → detail page renders the
 * Uses chip + manifest.dependencies persisted) was not e2e-covered.
 *
 * This spec drives the REAL pages over HTTP (no chat stream / reverse-RPC),
 * so unlike the sibling chat specs it does NOT depend on the SSE/runtime
 * fake. It seeds via the `/api/__test/*` helpers (PI_E2E_REAL=1) and
 * authenticates through the Docker storageState (test@test.com / Test123!),
 * exactly mirroring the real-auth author-flow harness.
 *
 * Flow asserted:
 *   1. Ensure ≥1 installed extension exists to pick as a dependency
 *      (every real server boots the bundled set; we pick the first).
 *   2. Seed a draft (a `defineExtension` config with a `permissions:`
 *      field so the composition panel recognizes the scaffold shape).
 *   3. Load /extensions/author?prefill=<draftId> → composition panel
 *      mounts.
 *   4. Pick the dependency via ExtensionAttachPicker → the panel PUTs the
 *      draft with the managed dependencies block; assert the dep chip
 *      renders in the panel.
 *   5. Install → POST /api/extensions/author/install → navigate to
 *      /extensions/<name>.
 *   6. Assert UsesList renders the dependency chip and
 *      GET /api/extensions/[id] shows manifest.dependencies persisted.
 *
 * Single-worker (PGlite single-writer); afterEach cleans the install +
 * draft.
 *
 * ─────────────────────────────────────────────────────────────────────
 * SKIPPED — ENVIRONMENT INFRA BLOCKER (not a spec defect).
 *
 * This spec was RUN for real (`DOCKER_TEST=1 bunx playwright test
 * extension-author-install-round-trip`) against the live app on :3000.
 * Outcome: the Docker storageState auth WORKED and `GET /api/extensions`
 * returned the installed set — but `seedExtensionAuthorDraft` got a
 * **404 "Not found"** from `POST /api/__test/seed-extension-author-draft`.
 *
 * Root cause: the only running container is `ezcorp-prod-app-1`, a
 * PRODUCTION build with neither `PI_E2E_REAL` nor a non-production
 * `NODE_ENV` set. The seed/cleanup `/api/__test/*` endpoints are gated by
 * `isEnabled() === (process.env.PI_E2E_REAL === "1" && NODE_ENV !==
 * "production")` and deliberately serve 404 when off (see
 * `web/src/routes/api/__test/seed-extension-author-draft/+server.ts`).
 * So the seed harness cannot write a draft against the prod container.
 *
 * This is the SAME class of blocker as the sibling author specs
 * (`extension-author-provenance.spec.ts`), which skip because the
 * Docker/PI_E2E_REAL harness isn't reachable here.
 *
 * UN-BLOCKER CONDITION: bring up a dev/test app container with
 * `PI_E2E_REAL=1` and `NODE_ENV != production` on :3000 (the
 * `playwright.real.config.ts` harness or a docker-compose test profile),
 * then flip `test.describe.skip` → `test.describe`. The spec body below is
 * kept syntactically valid + was exercised end-to-end up to the seed call,
 * so the un-skip is a one-token change.
 * Verified-blocked-on: 2026-06-18 (prod container has no PI_E2E_REAL).
 * ─────────────────────────────────────────────────────────────────────
 */
import { test, expect } from "@playwright/test";
import {
	cleanupExtensionAuthorDraft,
	cleanupInstalledExtension,
	seedExtensionAuthorDraft,
} from "./fixtures/db-seed";

function makeName(slug: string): string {
	return `e2e-${slug}-${Date.now().toString(36)}`;
}

interface InstalledRow {
	id: string;
	name: string;
}

test.describe.skip("extension-author dependency-install round trip", () => {
	let draftId: string | null = null;
	let extensionName: string | null = null;

	test.afterEach(async ({ request }) => {
		if (extensionName) {
			await cleanupInstalledExtension(request, extensionName).catch(() => {});
		}
		if (draftId) {
			await cleanupExtensionAuthorDraft(request, draftId).catch(() => {});
		}
		draftId = null;
		extensionName = null;
	});

	test("compose a dependency → save → install → detail page shows the Uses chip + persisted manifest.dependencies", async ({
		page,
		request,
	}) => {
		extensionName = makeName("composed");

		// 1) Pick a dependency target — the first installed extension the
		//    public list returns (every real server boots the bundled set).
		const listRes = await request.get("/api/extensions");
		expect(listRes.ok()).toBe(true);
		const listJson = (await listRes.json()) as unknown;
		const installed: InstalledRow[] = (
			Array.isArray(listJson)
				? listJson
				: Array.isArray((listJson as { extensions?: unknown[] }).extensions)
					? (listJson as { extensions: unknown[] }).extensions
					: []
		).map((e) => {
			const r = e as Record<string, unknown>;
			return { id: String(r.id ?? ""), name: String(r.name ?? "") };
		});
		expect(installed.length).toBeGreaterThan(0);
		const dep = installed[0]!;

		// 2) Seed a draft (the scaffold carries a `permissions:` field, so
		//    the composition panel recognizes the shape and enables itself).
		const seeded = await seedExtensionAuthorDraft({
			request,
			name: extensionName,
			type: "tool",
			description: "E2E composed extension",
		});
		draftId = seeded.draftId;
		expect(seeded.files).toContain("ezcorp.config.ts");

		// 3) Load the author preview page → composition panel mounts.
		const previewResp = await page.goto(`/extensions/author?prefill=${seeded.draftId}`);
		expect(previewResp?.ok()).toBe(true);
		await expect(page.getByTestId("author-composition-panel")).toBeVisible();

		// 4) Open the picker, select the dependency, submit. The panel
		//    writes the managed dependencies block + PUTs the draft.
		const putPromise = page.waitForRequest(
			(req) =>
				req.method() === "PUT" &&
				req.url().includes(`/api/extensions/author/draft/${seeded.draftId}`),
			{ timeout: 10_000 },
		);
		await page.getByTestId("author-use-extensions-open").click();
		await expect(page.getByTestId("extension-attach-picker")).toBeVisible();
		// Toggle-select the chosen dependency's card, then submit.
		await page
			.locator(`[data-testid="extension-attach-picker-card"][data-ext-id="${dep.id}"] button`)
			.first()
			.click();
		await page.getByTestId("extension-attach-picker-submit").click();
		await putPromise;

		// The dependency chip is now in the composition panel.
		await expect(
			page.locator(`[data-testid="author-dep-chip"][data-dep-name="${dep.name}"]`),
		).toBeVisible({ timeout: 10_000 });

		// 5) Install → POST → navigate to /extensions/<name>.
		const installResp = page.waitForResponse(
			(r) =>
				r.url().includes("/api/extensions/author/install") &&
				r.request().method() === "POST",
			{ timeout: 30_000 },
		);
		const navigation = page.waitForURL(`**/extensions/${extensionName}`, { timeout: 30_000 });
		await page.getByTestId("install-btn").click();
		const installResult = await installResp;
		expect(installResult.ok()).toBe(true);
		await navigation;
		expect(new URL(page.url()).pathname).toBe(`/extensions/${extensionName}`);

		// 6a) The detail page's UsesList renders the dependency chip.
		await expect(
			page.locator(`[data-testid="extension-uses-chip"][data-dep-name="${dep.name}"]`),
		).toBeVisible({ timeout: 10_000 });

		// 6b) manifest.dependencies persisted server-side. Resolve the new
		//     extension's id from the public list, then read it back.
		const afterList = await request.get(
			`/api/extensions?name=${encodeURIComponent(extensionName)}`,
		);
		expect(afterList.ok()).toBe(true);
		const afterRows = (await afterList.json()) as Array<{ id: string; name: string }>;
		const row = afterRows.find((e) => e.name === extensionName);
		expect(row).toBeDefined();

		const detail = await request.get(`/api/extensions/${row!.id}`);
		expect(detail.ok()).toBe(true);
		const detailBody = (await detail.json()) as {
			manifest?: { dependencies?: Record<string, { source?: string; version?: string }> };
		};
		const persistedDeps = detailBody.manifest?.dependencies ?? {};
		expect(Object.keys(persistedDeps)).toContain(dep.name);

		// Install consumed the draft — clear the handle so afterEach doesn't
		// DELETE an already-consumed row.
		draftId = null;
	});
});
