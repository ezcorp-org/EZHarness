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
 * WHICH HARNESS THIS RUNS UNDER (it is NOT a mock-tier spec).
 *
 * Everything here needs a REAL server: the author preview page is
 * SSR-loaded from `ez_drafts` + the on-disk draft dir (see
 * `routes/(app)/extensions/author/+page.server.ts`), and the seed helper
 * writes through `POST /api/__test/seed-extension-author-draft`, which
 * `isTestSurfaceEnabled()` fail-closes to 404 unless ALL of
 * `EZCORP_ALLOW_TEST_SURFACE=1`, `PI_E2E_REAL=1` and a non-production
 * `NODE_ENV` hold. Playwright `page.route` cannot mock either — the draft
 * read happens inside the SSR load, not over the wire.
 *
 * So this is the DOCKER lane (`DOCKER_TEST=1`, an app on :3000 booted
 * with the test surface enabled, storageState from
 * `e2e/docker-auth-setup.ts`) — `scripts/docker-test-all.sh`. It is NOT
 * in the mock `E2E (mock, no Docker)` gate, because that harness boots
 * the preview server with `PI_SKIP_INIT=1` and no test surface, where
 * every step below 404s.
 *
 * The blocking-CI twin of this coverage is
 * `web/e2e/real-auth/extension-release-gate.spec.ts`, which runs the
 * install → load → invoke → upgrade gate under `playwright.real.config.ts`
 * in the `e2e-real-auth` job. This spec is the dependency-composition
 * slice of the same authoring surface.
 *
 * ── THE DEFECT THIS SPEC WAS WRITTEN AGAINST (now fixed) ─────────────
 *
 * Steps 1-4 always passed; step 5 — Install — failed with a real product
 * defect:
 *
 *   Install failed (422): Invalid manifest:
 *   dependencies.<dep>.source is invalid: Unrecognized source format:
 *   "bundled". Expected github:user/repo, gitlab:org/project,
 *   https://host/repo.git, or git@host:user/repo.git
 *
 * `AuthorCompositionPanel` wrote the picked row's source verbatim, but
 * `validateDependencies` ran EVERY source through `parseSource`, which
 * only accepts git-cloneable refs. Every extension the picker can offer
 * is already installed, so no composed dependency could ever install.
 *
 * The fix gives `bundled`/`local` an explicit meaning — "this extension
 * must ALREADY be installed; never clone it" — as a closed set
 * (`src/extensions/dependency-source.ts`), resolved by name at install
 * time and hard-failing when unresolvable. The picker also no longer
 * offers the VIRTUAL `builtin` row (native tools; not a real extension),
 * which is what this spec used to pick first.
 *
 * The structural guard against a repeat is
 * `src/__tests__/dependency-source-parity.test.ts`: every source form
 * the picker can emit must be accepted by `validateDependencies`.
 * ─────────────────────────────────────────────────────────────────────
 */
import { test, expect } from "./fixtures/hydration.js";
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
  source: string;
}

/**
 * The VIRTUAL extension row `src/db/migrate.ts` seeds so native tool
 * calls (`editFile`, `readFile`, …) have an `extension_id`. It is not a
 * real extension and is not offerable as a dependency — mirrors
 * `isPickableDependency` in `web/src/lib/ezcorp-config-edit.ts`.
 */
const VIRTUAL_BUILTIN_EXTENSION_ID = "builtin";

function isPickable(row: InstalledRow): boolean {
  return row.id !== VIRTUAL_BUILTIN_EXTENSION_ID && row.source !== VIRTUAL_BUILTIN_EXTENSION_ID;
}

// DOCKER_TEST is the harness selector for this suite (see the header):
// the lane manifest (`web/e2e/lanes.json`) files it under `docker`, and
// `src/__tests__/e2e-lanes.test.ts` requires every docker-lane member to
// name it.
test.describe("extension-author dependency-install round trip", () => {
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

    // 1) Pick a dependency target — the first REAL installed extension
    //    the public list returns (every real server boots the bundled
    //    set). The virtual `builtin` row is excluded: it is a seeded
    //    placeholder for native tool calls, not a dependable
    //    extension, and the picker does not offer it.
    const listRes = await request.get("/api/extensions");
    expect(listRes.ok()).toBe(true);
    const listJson = (await listRes.json()) as unknown;
    const allRows: InstalledRow[] = (
      Array.isArray(listJson)
        ? listJson
        : Array.isArray((listJson as { extensions?: unknown[] }).extensions)
          ? (listJson as { extensions: unknown[] }).extensions
          : []
    ).map((e) => {
      const r = e as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        source: String(r.source ?? ""),
      };
    });
    const installed = allRows.filter(isPickable);
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
    // The virtual `builtin` row is never offered — it used to be the
    // FIRST card in this grid, which is how a composed dependency on a
    // non-extension ("Built-in Tools") got written in the first place.
    await expect(
      page.locator(
        `[data-testid="extension-attach-picker-card"][data-ext-id="${VIRTUAL_BUILTIN_EXTENSION_ID}"]`,
      ),
    ).toHaveCount(0);
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
      (r) => r.url().includes("/api/extensions/author/install") && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    const navigation = page.waitForURL(`**/extensions/${extensionName}`, { timeout: 30_000 });
    await page.getByTestId("install-btn").click();
    const installResult = await installResp;
    expect(installResult.ok()).toBe(true);
    await navigation;
    expect(new URL(page.url()).pathname).toBe(`/extensions/${extensionName}`);

    // 6) Resolve the new extension's row id from the public list. The
    //    install redirect above lands on `/extensions/<name>`, but the
    //    detail ROUTE resolves its param with `getExtension(id)` — a UUID
    //    lookup with no name fallback — so the id is what actually renders
    //    that page (the Extensions library links `/extensions/{ext.id}`
    //    for the same reason). Asserting the rendered detail page
    //    therefore navigates by id.
    const afterList = await request.get(
      `/api/extensions?name=${encodeURIComponent(extensionName)}`,
    );
    expect(afterList.ok()).toBe(true);
    const afterRows = (await afterList.json()) as Array<{ id: string; name: string }>;
    const row = afterRows.find((e) => e.name === extensionName);
    expect(row).toBeDefined();

    // 6a) The detail page's UsesList renders the dependency chip.
    await page.goto(`/extensions/${row!.id}`);
    await expect(
      page.locator(`[data-testid="extension-uses-chip"][data-dep-name="${dep.name}"]`),
    ).toBeVisible({ timeout: 10_000 });

    // 6b) manifest.dependencies persisted server-side.
    const detail = await request.get(`/api/extensions/${row!.id}`);
    expect(detail.ok()).toBe(true);
    const detailBody = (await detail.json()) as {
      manifest?: { dependencies?: Record<string, { source?: string; version?: string }> };
    };
    const persistedDeps = detailBody.manifest?.dependencies ?? {};
    expect(Object.keys(persistedDeps)).toContain(dep.name);
    // The persisted source is one of the PREINSTALLED forms — the only
    // thing the picker can honestly declare, since it exclusively
    // offers extensions that are already installed. This is the exact
    // value that used to 422 the install.
    expect(["bundled", "local"]).toContain(persistedDeps[dep.name]?.source);

    // Install consumed the draft — clear the handle so afterEach doesn't
    // DELETE an already-consumed row.
    draftId = null;
  });
});
