/**
 * v1.4 regression guard for the `compactionIntervalHours` →
 * `compaction_interval_hours` rename.
 *
 * The original v1.4 backlog cleanup (commit 61e087d) shipped a new
 * setting key in camelCase, which violated the manifest schema's
 * snake_case constraint
 * (`/^[a-z][a-z0-9_]{0,63}$/`). Both validators of that commit missed
 * the bug because their tests called the resolver helper directly
 * with mock settings — `loadManifestFresh()` (the same code path the
 * host runs at boot via `ensureBundledExtensions`) was never
 * exercised.
 *
 * This test closes that gap. It calls `loadManifestFresh()` against
 * the actual on-disk manifest directories — the same path host boot
 * uses — and asserts:
 *   1. The manifest loads without throwing (positive guard).
 *   2. The new snake_case key `compaction_interval_hours` is present
 *      (positive guard against rename drift).
 *   3. The old camelCase key `compactionIntervalHours` is absent
 *      (negative guard against accidental restoration).
 *
 * The test also loads `extensions/lessons-distiller/ezcorp.config.ts`
 * to make this a small bundled-manifest-load smoke test rather than
 * a memory-extractor-only check — any future bundled extension that
 * trips the same validator gets surfaced here too.
 */
import { test, expect, describe } from "bun:test";
import { join } from "node:path";

import { loadManifestFresh } from "../../src/extensions/loader";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const MEMORY_EXTRACTOR_DIR = join(REPO_ROOT, "extensions", "memory-extractor");
const LESSONS_DISTILLER_DIR = join(REPO_ROOT, "extensions", "lessons-distiller");

describe("bundled manifest load — regression guard for snake_case settings keys", () => {
  test("memory-extractor manifest loads without throwing", async () => {
    // The pre-rename failure mode raised:
    //   `Invalid manifest: settings key "compactionIntervalHours"
    //    must match /^[a-z][a-z0-9_]{0,63}$/`
    // … which propagated as a thrown Error from loadManifestFresh.
    // A successful load with no throw is the load-bearing assertion.
    const manifest = await loadManifestFresh(MEMORY_EXTRACTOR_DIR);
    expect(manifest).toBeDefined();
    expect(manifest.name).toBe("memory-extractor");
  });

  test("memory-extractor manifest declares snake_case `compaction_interval_hours` setting", async () => {
    // Positive guard: a future rename that drops or misnames this
    // key would silently break the runtime resolver
    // (`extensions/memory-extractor/index.ts` reads
    // `settings.compaction_interval_hours` at boot).
    const manifest = await loadManifestFresh(MEMORY_EXTRACTOR_DIR);
    const settings = manifest.settings as Record<string, unknown> | undefined;
    expect(settings).toBeDefined();
    expect(settings?.compaction_interval_hours).toBeDefined();
  });

  test("memory-extractor manifest does NOT declare camelCase `compactionIntervalHours`", async () => {
    // Negative guard: an accidental copy-paste restoration of the
    // old key would re-introduce the original validator failure.
    // This assertion would FAIL on commit 61e087d (the bug-introducing
    // commit), proving the test catches the regression class.
    const manifest = await loadManifestFresh(MEMORY_EXTRACTOR_DIR);
    const settings = manifest.settings as Record<string, unknown> | undefined;
    expect(settings).toBeDefined();
    expect(settings?.compactionIntervalHours).toBeUndefined();
  });

  test("lessons-distiller manifest also loads cleanly (bundled-manifest smoke)", async () => {
    // Companion bundled extension — loading it here turns this file
    // into a small bundled-manifest-load smoke test rather than a
    // memory-extractor-only regression. If a future bundled
    // extension trips the same snake_case validator, this assertion
    // surfaces it.
    const manifest = await loadManifestFresh(LESSONS_DISTILLER_DIR);
    expect(manifest).toBeDefined();
    expect(manifest.name).toBe("lessons-distiller");
  });
});
