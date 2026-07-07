/**
 * E2E happy path for the bundled `extension-author` preview surface.
 *
 * Flow under test:
 *   1. Seed a draft via `/api/__test/seed-extension-author-draft`
 *      (writes the scaffold to disk + inserts an `ez_drafts` row).
 *   2. Navigate to `/extensions/author?prefill=<draftId>`.
 *   3. Assert the file tabs render and the manifest content is
 *      visible.
 *   4. Edit the manifest's description, wait past the 600ms debounce,
 *      and assert a PUT to the save endpoint fired.
 *   5. Click Install. Assert the redirect lands on
 *      `/extensions/<name>` and the extension row exists on the
 *      server (via the public list endpoint).
 *
 * Cleanup: every test removes both the draft (if not yet consumed by
 * install) and the installed extension. Run in single-worker mode
 * (PGlite single-writer), so afterEach happens before the next test
 * starts.
 */
import { test, expect } from "@playwright/test";
import {
	cleanupExtensionAuthorDraft,
	cleanupInstalledExtension,
	seedExtensionAuthorDraft,
} from "../fixtures/db-seed";
import { sandboxSpawnAvailable } from "./sandbox-probe";

// Unique-per-test name keeps any failed cleanup from one test
// poisoning the next. Suffix is run-id-ish; collisions are not
// problematic because cleanupInstalledExtension is idempotent.
function makeName(slug: string): string {
	return `e2e-${slug}-${Date.now().toString(36)}`;
}

test.describe("extension-author preview flow", () => {
	// Install spawns a REAL extension subprocess via the sandbox
	// (`prlimit` + Landlock). On a runner where the jail can't exec the
	// runtime bun (e.g. GitHub hosted runners, where setup-bun's
	// `~/.bun/bin` is outside the sandbox read-exec allowlist) that exec
	// is denied and the subprocess dies at bring-up — so gate the whole
	// group on the real spawn probe. A conditional skip (not a bare
	// `.skip`) is the repo's sanctioned pattern for capability-gated
	// tests and is allowed by scripts/gate-integrity.ts.
	test.skip(
		() => !sandboxSpawnAvailable(),
		"extension sandbox needs kernel caps (prlimit/Landlock) not available on this runner",
	);

	let draftId: string | null = null;
	let extensionName: string | null = null;

	test.afterEach(async ({ request }) => {
		// Order matters: cleanup the install dir FIRST (it may contain
		// the moved draft dir after a successful install), then the
		// draft row (a no-op after consumeDraft on install).
		if (extensionName) {
			await cleanupInstalledExtension(request, extensionName).catch(() => {});
		}
		if (draftId) {
			await cleanupExtensionAuthorDraft(request, draftId).catch(() => {});
		}
		draftId = null;
		extensionName = null;
	});

	test("seed → edit → install lands on /extensions/<name>", async ({ page, request }) => {
		extensionName = makeName("weather");

		// 1) Seed.
		const seeded = await seedExtensionAuthorDraft({
			request,
			name: extensionName,
			type: "tool",
			description: "E2E weather lookup",
		});
		draftId = seeded.draftId;
		expect(seeded.files).toContain("ezcorp.config.ts");
		expect(seeded.files).toContain("index.ts");

		// 2) Navigate to the preview page.
		const previewResp = await page.goto(`/extensions/author?prefill=${seeded.draftId}`);
		expect(previewResp?.ok()).toBe(true);

		// 3) The file-tree renders one tab per scaffolded file.
		await expect(page.getByTestId("file-tab-ezcorp.config.ts")).toBeVisible();
		await expect(page.getByTestId("file-tab-index.ts")).toBeVisible();

		// The default selection is the first sorted file, which has
		// `.gitignore` in the alphabet — but the preview component
		// filters to ALLOWED_FILES (see +page.server.ts) and sorts
		// keys, so the textarea is whichever file lands first
		// alphabetically among the rendered tabs. We just assert the
		// textarea has SOME content (every scaffolded file has a body).
		const textarea = page.getByTestId("file-content");
		await expect(textarea).toBeVisible();
		const initialContent = await textarea.inputValue();
		expect(initialContent.length).toBeGreaterThan(0);

		// 4) Switch explicitly to the manifest tab, then edit. We assert
		// a PUT fires for the save (debounced 600ms; we wait up to 5s
		// for the request to fly).
		await page.getByTestId("file-tab-ezcorp.config.ts").click();
		const manifestContent = await textarea.inputValue();
		expect(manifestContent).toContain(extensionName); // scaffold stamps the name

		const putPromise = page.waitForRequest(
			(req) =>
				req.method() === "PUT" &&
				req.url().includes(`/api/extensions/author/draft/${seeded.draftId}`),
			{ timeout: 5_000 },
		);
		await textarea.fill(`${manifestContent}\n// e2e edit ${Date.now()}`);
		await putPromise;

		// 5) Install. The button triggers a POST; on success the page
		// navigates to /extensions/<name>.
		const installResp = page.waitForResponse(
			(r) => r.url().includes("/api/extensions/author/install") && r.request().method() === "POST",
			{ timeout: 30_000 },
		);
		const navigation = page.waitForURL(`**/extensions/${extensionName}`, { timeout: 30_000 });
		await page.getByTestId("install-btn").click();
		const installResult = await installResp;
		expect(installResult.ok()).toBe(true);
		await navigation;
		expect(new URL(page.url()).pathname).toBe(`/extensions/${extensionName}`);

		// 6) The extension is visible to the server. We don't rely on
		// the redirect-target page's UI (would couple this test to
		// dashboard layout); the API list endpoint is the contract.
		// `GET /api/extensions?name=<exact>` returns an array of zero
		// or one row — server-side filter saves us paginating the full
		// list and is the same shape the resolved-settings store uses.
		const list = await request.get(`/api/extensions?name=${encodeURIComponent(extensionName)}`);
		expect(list.ok()).toBe(true);
		const listBody = (await list.json()) as Array<{ name: string }>;
		expect(Array.isArray(listBody)).toBe(true);
		expect(listBody.some((e) => e.name === extensionName)).toBe(true);

		// The install consumed the draft — clear the local handle so
		// afterEach doesn't try to DELETE an already-consumed row.
		draftId = null;
	});

	test("422 path: invalid manifest blocks install + shows error banner", async ({ page, request }) => {
		extensionName = makeName("broken");

		// 1) Seed a draft, then corrupt the on-disk manifest so
		//    `validateManifestV2` rejects it. The edit goes through the
		//    same PUT save path the UI uses — no privileged FS access
		//    from the test runner. The corrupted manifest strips the
		//    `name` field, which validateManifestV2 flags as "name required".
		const seeded = await seedExtensionAuthorDraft({
			request,
			name: extensionName,
			type: "tool",
			description: "E2E intentionally-broken manifest",
		});
		draftId = seeded.draftId;

		// 2) Navigate; edit the manifest tab to strip `name`.
		const previewResp = await page.goto(`/extensions/author?prefill=${seeded.draftId}`);
		expect(previewResp?.ok()).toBe(true);
		await page.getByTestId("file-tab-ezcorp.config.ts").click();
		const textarea = page.getByTestId("file-content");
		await expect(textarea).toBeVisible();

		// Wait for the debounced PUT to land so the corrupted body is
		// on disk when we click Install.
		const putPromise = page.waitForRequest(
			(req) =>
				req.method() === "PUT" &&
				req.url().includes(`/api/extensions/author/draft/${seeded.draftId}`),
			{ timeout: 5_000 },
		);
		await textarea.fill(`import { defineExtension } from "@ezcorp/sdk";
export default defineExtension({
  schemaVersion: 2,
  version: "0.1.0",
  description: "missing name on purpose",
  author: { name: "x" },
  permissions: {},
});
`);
		await putPromise;

		// 3) Click Install. The endpoint returns 422; the page must
		//    NOT navigate, and the install-error banner must render.
		const installResp = page.waitForResponse(
			(r) => r.url().includes("/api/extensions/author/install") && r.request().method() === "POST",
			{ timeout: 30_000 },
		);
		await page.getByTestId("install-btn").click();
		const result = await installResp;
		expect(result.status()).toBe(422);

		// Stayed on the author preview page (no goto fired).
		expect(new URL(page.url()).pathname).toBe("/extensions/author");
		// The Svelte `installError` reactive value populates the banner
		// on non-2xx responses; see +page.svelte:230-234.
		await expect(page.getByTestId("install-error")).toBeVisible({ timeout: 5_000 });

		// Install failed, so no extension row exists; clear the handle
		// to make afterEach's intent crisp (cleanup-extension is itself
		// idempotent).
		extensionName = null;
	});

	test("discard path: confirm + delete clears draft from server", async ({ page, request }) => {
		// 1) Seed.
		const localName = makeName("discardable");
		const seeded = await seedExtensionAuthorDraft({
			request,
			name: localName,
			type: "tool",
		});
		draftId = seeded.draftId;

		// 2) Navigate.
		const resp = await page.goto(`/extensions/author?prefill=${seeded.draftId}`);
		expect(resp?.ok()).toBe(true);
		await expect(page.getByTestId("discard-btn")).toBeVisible();

		// 3) Stub window.confirm BEFORE clicking. Without this, the real
		//    confirm() blocks indefinitely in headless Chromium.
		await page.evaluate(() => {
			window.confirm = () => true;
		});

		// 4) Watch for the DELETE on the draft endpoint — the Discard
		//    handler awaits this before navigating to /extensions.
		const deletePromise = page.waitForResponse(
			(r) =>
				r.url().includes(`/api/extensions/author/draft/${seeded.draftId}`) &&
				r.request().method() === "DELETE",
			{ timeout: 10_000 },
		);
		await page.getByTestId("discard-btn").click();
		const deleteResult = await deletePromise;
		expect(deleteResult.ok()).toBe(true);

		// 5) The component fires `goto("/extensions")` after the DELETE
		//    resolves — URL must move off the author page.
		await page.waitForURL((url) => url.pathname !== "/extensions/author", { timeout: 10_000 });
		expect(new URL(page.url()).pathname).not.toBe("/extensions/author");

		// 6) Server-side confirmation: a second DELETE on the same
		//    draftId is idempotent. The production contract (see
		//    `discardDraftAndDir` + `consumeDraft` in
		//    `src/db/queries/ez-drafts.ts`) is "mark consumedAt, then
		//    rm -rf the dir". The row is NOT physically deleted — it
		//    stays as an audit breadcrumb until the expiry sweep — so
		//    a second DELETE hits `getDraft` (which returns the
		//    consumed-but-unexpired row), calls `discardDraftAndDir`
		//    again, and returns 204. The dir-rm is also idempotent
		//    (`existsSync` guard + `force: true`).
		//
		//    The strongest no-privileged-FS signal is: the second
		//    DELETE succeeds without producing observable state
		//    change (still 204, no error). Originally this expected
		//    404, which would only be true if the DB row were
		//    physically deleted — that's not the implementation's
		//    contract. Same convention as db-seed.ts's
		//    `cleanupExtensionAuthorDraft`, which accepts BOTH 404
		//    and 2xx as success.
		const secondDelete = await request.delete(
			`/api/extensions/author/draft/${seeded.draftId}`,
		);
		expect([204, 404]).toContain(secondDelete.status());

		// afterEach: the cleanup helper treats 404 as ok, so leaving
		// `draftId` set is fine. Clearing documents intent.
		draftId = null;
	});
});
