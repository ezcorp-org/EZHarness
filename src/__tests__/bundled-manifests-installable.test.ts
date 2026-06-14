/**
 * Regression guard for the bundled-boot-errors D1 defect: two bundled
 * agent-kind extensions (`research-agent`, `multi-agent-orchestrator`)
 * failed install on EVERY boot with "Cannot install extension without
 * entrypoint" because the install path demanded an entrypoint that the
 * manifest validator (correctly) treats as optional for non-tool kinds.
 *
 * This test loads EVERY entry in the resolved BUNDLED_EXTENSIONS list
 * from disk and asserts the install-time invariants that
 * `installFromLocal` enforces:
 *
 *   1. The on-disk `ezcorp.config.ts` loads + validates (no malformed
 *      bundle ships).
 *   2. If the manifest declares tools, it MUST declare an entrypoint and
 *      that entrypoint file MUST exist (the install path would checksum
 *      it).
 *   3. If the manifest declares NO entrypoint, it MUST be a legitimately
 *      entrypoint-less kind (no tools) — install must NOT fail-closed on
 *      a missing entrypoint for these.
 *
 * Filesystem-real but DB-free: no mocks, no `ensureBundledExtensions`.
 * A future maintainer who adds a tools-bearing bundled extension without
 * an entrypoint (or whose manifest stops validating) fails CI here,
 * not at runtime boot.
 */
import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  resolveBundledExtensions,
  getProjectRoot,
} from "../extensions/bundled";
import { loadManifest } from "../extensions/loader";

const projectRoot = getProjectRoot();

describe("bundled extension manifests are installable", () => {
  // `resolveBundledExtensions({})` returns every declared entry with no
  // opt-out flags applied — the same source the boot install loop reads.
  const entries = resolveBundledExtensions({});

  test("the bundled list is non-empty", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const entry of entries) {
    describe(entry.name, () => {
      const dir = join(projectRoot, entry.path);

      test("on-disk manifest loads + validates", async () => {
        // `loadManifest` throws on a missing file or a manifest that
        // fails `validateManifestV2` — either is a broken bundle.
        const manifest = await loadManifest(dir);
        expect(manifest.name).toBe(entry.name);
      });

      test("entrypoint invariant matches the install path", async () => {
        const manifest = await loadManifest(dir);
        const hasTools = (manifest.tools?.length ?? 0) > 0;

        if (manifest.entrypoint) {
          // Tools or not, a declared entrypoint must exist on disk — the
          // install path checksums it.
          const epPath = join(dir, manifest.entrypoint.replace(/^\.\//, ""));
          expect(existsSync(epPath)).toBe(true);
        } else {
          // No entrypoint is ONLY legitimate for non-tool (agent-/skill-)
          // kinds. A tools-bearing manifest without an entrypoint would
          // fail `validateManifestV2` ("entrypoint is required when tools
          // are declared") — guard it here so a future broken bundle
          // fails CI rather than boot.
          expect(hasTools).toBe(false);
        }
      });
    });
  }
});
