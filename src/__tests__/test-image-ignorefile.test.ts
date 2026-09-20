import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Holds `Dockerfile.test`'s build-time guard against the two ignore files that
 * decide whether this image contains anything to run.
 *
 * ## The bug this exists to prevent
 *
 * The root `.dockerignore` excludes `**\/*.test.ts`, `**\/*.spec.ts` and
 * `**\/__tests__` so the PROD image does not ship tests.
 * `Dockerfile.test.dockerignore` exists to NOT exclude them for the test
 * image — but `<dockerfile>.dockerignore` is a BuildKit-only lookup. Podman
 * and Buildah apply the root file instead, so the test image builds green
 * with every test stripped and the failure surfaces much later as
 * `preload not found` once per file, naming neither cause nor fix.
 *
 * ## Why this is not a tautology
 *
 * The assertions hold three independently-maintained artifacts against each
 * other rather than restating any one of them:
 *
 *   - the guard is required to exist only BECAUSE the root ignore file
 *     excludes the test globs — the first test reads that exclusion out of
 *     the root file rather than assuming it, so dropping the exclusion (and
 *     with it the hazard) is not reported as a missing guard;
 *   - the per-dockerfile ignore file must NOT re-add those excludes, which is
 *     the property that makes `--ignorefile` a real fix rather than a
 *     no-op;
 *   - the guard must run AFTER the `COPY . .` that brings the sources in and
 *     BEFORE the build steps that would otherwise fail first with a less
 *     legible error.
 */

const ROOT = join(import.meta.dir, "..", "..");

const TEST_GLOBS = ["**/*.test.ts", "**/__tests__"];

async function lines(relPath: string): Promise<string[]> {
  const text = await Bun.file(join(ROOT, relPath)).text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

describe("test image — the ignorefile hazard", () => {
  test("the root .dockerignore is what strips the tests", async () => {
    const root = await lines(".dockerignore");
    for (const glob of TEST_GLOBS) {
      expect(root, `${glob} missing — prod image would ship tests`).toContain(glob);
    }
  });

  test("the per-dockerfile ignore file keeps them", async () => {
    const testIgnore = await lines("Dockerfile.test.dockerignore");
    for (const glob of TEST_GLOBS) {
      expect(testIgnore, `${glob} excluded — --ignorefile would not help`).not.toContain(glob);
    }
  });

  test("Dockerfile.test fails the build when the sources did not land", async () => {
    const dockerfile = await Bun.file(join(ROOT, "Dockerfile.test")).text();

    // The guard checks a path each ignore file treats differently, so it
    // actually distinguishes the two build contexts.
    expect(dockerfile).toContain("src/__tests__/preload.ts");
    expect(dockerfile).toMatch(/exit 1/);
    // …and names the flag that fixes it, since the engine will not.
    expect(dockerfile).toContain("--ignorefile");
  });

  test("the guard runs after the COPY and before the build steps", async () => {
    const dockerfile = await Bun.file(join(ROOT, "Dockerfile.test")).text();
    const rows = dockerfile.split("\n");

    const copyAll = rows.findIndex((l) => /^COPY \. \.\s*$/.test(l));
    const guard = rows.findIndex((l) => l.includes("src/__tests__/preload.ts"));
    const svelteSync = rows.findIndex((l) => l.includes("svelte-kit sync"));

    expect(copyAll).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(svelteSync).toBeGreaterThan(-1);

    // Before the COPY there is nothing to check; after the build steps the
    // build has already failed on something less legible.
    expect(guard).toBeGreaterThan(copyAll);
    expect(guard).toBeLessThan(svelteSync);
  });
});
