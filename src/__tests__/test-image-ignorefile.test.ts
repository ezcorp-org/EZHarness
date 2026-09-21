import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Holds `Dockerfile.test`'s build-time guard against the two ignore files that
 * decide whether this image contains anything to run.
 *
 * ## The bug this exists to prevent
 *
 * The root `.dockerignore` excludes `web/e2e`, `**\/*.test.ts`,
 * `**\/*.spec.ts` and `**\/__tests__` so the production image does not ship
 * tests. `Dockerfile.test.dockerignore` must retain all four surfaces for the
 * test image. If the companion file or build context changes, a test-less
 * image must fail while it is built, not later when the test command starts.
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
 *     the property that makes it a valid test-image build context;
 *   - the guard must run AFTER the `COPY . .` that brings the sources in and
 *     BEFORE the build steps that would otherwise fail first with a less
 *     legible error.
 */

const ROOT = join(import.meta.dir, "..", "..");

const TEST_PATHS = ["web/e2e", "**/*.test.ts", "**/*.spec.ts", "**/__tests__"];

async function lines(relPath: string): Promise<string[]> {
  const text = await Bun.file(join(ROOT, relPath)).text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function guardBlock(dockerfile: string): { end: number; start: number; text: string } {
  const rows = dockerfile.split("\n");
  const start = rows.findIndex(
    (line) => line.startsWith("RUN if ") && line.includes("src/__tests__/preload.ts"),
  );
  const end = start < 0 ? -1 : rows.findIndex((line, index) => index > start && line.trim() === "fi");
  return { start, end, text: start < 0 || end < 0 ? "" : rows.slice(start, end + 1).join("\n") };
}

describe("test image — the ignorefile hazard", () => {
  test("the root .dockerignore is what strips the tests", async () => {
    const root = await lines(".dockerignore");
    for (const path of TEST_PATHS) {
      expect(root, `${path} missing — prod image would ship tests`).toContain(path);
    }
  });

  test("the per-dockerfile ignore file keeps them", async () => {
    const testIgnore = await lines("Dockerfile.test.dockerignore");
    for (const path of TEST_PATHS) {
      expect(testIgnore, `${path} excluded — test image would omit tests`).not.toContain(path);
    }
  });

  test("Dockerfile.test fails the build when the sources did not land", async () => {
    const dockerfile = await Bun.file(join(ROOT, "Dockerfile.test")).text();

    // The guard checks a path each ignore file treats differently, so it
    // actually distinguishes the two build contexts.
    const guard = guardBlock(dockerfile);
    expect(guard.start).toBeGreaterThan(-1);
    expect(guard.end).toBeGreaterThan(guard.start);
    expect(guard.text).toContain("find web/e2e -type f -name '*.spec.ts'");
    expect(guard.text).toContain("exit 1");
    expect(guard.text).toContain("build from the repository root");
    expect(guard.text).toContain("keep Dockerfile.test.dockerignore");
  });

  test("the guard runs after the COPY and before the build steps", async () => {
    const dockerfile = await Bun.file(join(ROOT, "Dockerfile.test")).text();
    const rows = dockerfile.split("\n");

    const copyAll = rows.findIndex((l) => /^COPY \. \.\s*$/.test(l));
    const guard = guardBlock(dockerfile);
    const svelteSync = rows.findIndex((l) => l.includes("svelte-kit sync"));

    expect(copyAll).toBeGreaterThan(-1);
    expect(guard.start).toBeGreaterThan(-1);
    expect(svelteSync).toBeGreaterThan(-1);

    // Before the COPY there is nothing to check; after the build steps the
    // build has already failed on something less legible.
    expect(guard.start).toBeGreaterThan(copyAll);
    expect(guard.end).toBeLessThan(svelteSync);
  });
});
