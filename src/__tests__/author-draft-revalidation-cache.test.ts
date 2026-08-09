/**
 * Regression: the author edit→revalidate loop must re-read the manifest
 * from DISK, not from Bun's module cache.
 *
 * Every existing verify/install test mints a FRESH temp dir per case, so
 * none of them can catch the real-world failure: the author path
 * validates draft `d`, `write_draft_file` rewrites `d/ezcorp.config.ts`,
 * and validate runs again on the SAME path. With the path-cached
 * `loadManifest` the second read returns the FIRST import — so a broken
 * draft keeps reporting the identical failure no matter what the author
 * fixes, and (worse) a fixed-then-broken draft keeps reporting PASS and
 * installs bytes nobody verified.
 *
 * These tests exercise the REAL loader against ONE directory whose bytes
 * change between calls.
 */

import { test, expect, describe, afterAll, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// subprocess.ts (transitively imported by verify) pulls in
// db/queries/extensions — stub so no real DB is touched. The LOADER is
// deliberately NOT mocked: it is the subject under test.
mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

const { verifyExtension } = await import("../extensions/sdk/verify");
const { loadManifest, loadManifestFresh } = await import("../extensions/loader");

/** A skill-only manifest — no tools, so verify needs no subprocess and
 *  the whole round trip stays hermetic and fast. */
function skillManifest(name: string): string {
  return `export default ${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    description: "revalidation fixture",
    author: { name: "t" },
    skills: [{ name: "s", description: "d", content: "c" }],
    permissions: {},
  })} as const;\n`;
}

/** Structurally invalid: `name` is required by validateManifestV2, so
 *  the loader throws and verify reports a load-manifest FAIL. */
const BROKEN_MANIFEST = `export default ${JSON.stringify({
  schemaVersion: 2,
  version: "1.0.0",
  description: "no name — fails validateManifestV2",
  author: { name: "t" },
  permissions: {},
})} as const;\n`;

function makeDraftDir(initial: string): {
  dir: string;
  write: (src: string) => void;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "revalidate-"));
  const cfg = join(dir, "ezcorp.config.ts");
  writeFileSync(cfg, initial);
  return {
    dir,
    write: (src: string) => writeFileSync(cfg, src),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("verifyExtension — same draft dir, edited between runs", () => {
  test("PASS → edit to a broken manifest → the SAME draftId now FAILS", async () => {
    const fx = makeDraftDir(skillManifest("revalidate-a"));
    try {
      const first = await verifyExtension({ extDir: fx.dir });
      expect(first.pass).toBe(true);

      // The author "breaks" the draft — exactly what write_draft_file
      // does to the same path.
      fx.write(BROKEN_MANIFEST);

      const second = await verifyExtension({ extDir: fx.dir });
      // The whole point: the second verdict must reflect the NEW bytes.
      expect(second.pass).toBe(false);
      expect(second.pass).not.toBe(first.pass);
      const load = second.steps.find((s) => s.name === "load-manifest");
      expect(load?.ok).toBe(false);
      expect(load?.detail).toContain("Failed to load manifest");
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  test("FAIL → author fixes the manifest → the SAME draftId now PASSES", async () => {
    const fx = makeDraftDir(BROKEN_MANIFEST);
    try {
      const first = await verifyExtension({ extDir: fx.dir });
      expect(first.pass).toBe(false);

      fx.write(skillManifest("revalidate-b"));

      const second = await verifyExtension({ extDir: fx.dir });
      expect(second.pass).toBe(true);
      // Fresh read — the reported identity comes from the NEW bytes.
      const load = second.steps.find((s) => s.name === "load-manifest");
      expect(load?.ok).toBe(true);
      expect(load?.detail).toContain("revalidate-b");
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  test("renaming in place is reflected on the next verify (no stale identity)", async () => {
    const fx = makeDraftDir(skillManifest("revalidate-old"));
    try {
      const first = await verifyExtension({ extDir: fx.dir });
      expect(first.steps.find((s) => s.name === "load-manifest")?.detail).toContain(
        "revalidate-old",
      );

      fx.write(skillManifest("revalidate-new"));

      const second = await verifyExtension({ extDir: fx.dir });
      const detail = second.steps.find((s) => s.name === "load-manifest")?.detail;
      expect(detail).toContain("revalidate-new");
      expect(detail).not.toContain("revalidate-old");
    } finally {
      fx.cleanup();
    }
  }, 20_000);
});

describe("loader — the cache the author path must not use", () => {
  test("loadManifest is path-cached (stale) while loadManifestFresh is not", async () => {
    const fx = makeDraftDir(skillManifest("cache-probe-one"));
    try {
      // Prime Bun's module cache for this path.
      const cachedFirst = await loadManifest(fx.dir);
      expect(cachedFirst.name).toBe("cache-probe-one");

      fx.write(skillManifest("cache-probe-two"));

      // This is the documented hazard the author path must avoid: the
      // cached reader still answers with the pre-edit manifest.
      const cachedSecond = await loadManifest(fx.dir);
      expect(cachedSecond.name).toBe("cache-probe-one");

      // …and the cache-busting reader sees the edit.
      const fresh = await loadManifestFresh(fx.dir);
      expect(fresh.name).toBe("cache-probe-two");
    } finally {
      fx.cleanup();
    }
  }, 20_000);
});
