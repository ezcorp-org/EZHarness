import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { resolveProjectRoot } from "../extensions/bundled";
import { appVolumes, targetOf, targets, targetsOf } from "./helpers/compose-volumes";

/**
 * Locks the compose bind targets for extension state to the root that
 * `getProjectRoot()` actually resolves.
 *
 * This is the test that would have caught the original bug. The dev stack
 * bound host ./.ezcorp/extensions at /app/web/.ezcorp/extensions — the
 * vite-SSR dev server's `process.cwd()` — while every reader/writer of
 * extension state anchors to `getProjectRoot()`
 * (src/extensions/bundled.ts), which returns the directory that HOLDS
 * `src/`, i.e. /app. Nothing failed loudly: /app/.ezcorp existed in the
 * container's throwaway overlay, so installs "worked" until the next
 * container recreate silently wiped them, and the bind sat unwritten.
 *
 * ## Why this is not a tautology
 *
 * A compose test that re-asserts a literal it just read from the same
 * compose file proves nothing. The bug was a MISMATCH between two
 * independently-maintained artifacts — the compose bind target and the
 * root the code computes — so the test has to hold one against the other.
 *
 * `projectRoot` is therefore not asserted to equal a string, and not
 * merely derived by a rule restated in a comment. The container's own
 * declared layout is fed to the REAL resolver:
 *
 *   `./src:<srcTarget>`  →  resolveProjectRoot({ importMetaDir:
 *                             join(srcTarget, "extensions") })
 *
 * That is exactly the input `bundled.ts` sees at runtime (its
 * `import.meta.dir` is `<root>/src/extensions`), so the root under test
 * is produced by the shipped resolution logic, not by this file's idea of
 * it. Change how `getProjectRoot()` resolves without moving the bind and
 * this suite fails — which is the coupling that was missing.
 *
 * `webCwd` is derived from the `./web/src` bind (the dev server runs
 * `cd web && bun run dev`), and nothing may target extension state under
 * it. The `ext-data` named volume is asserted to STAY at <webCwd>/.ezcorp:
 * it backs the genuinely cwd-anchored generated-image store, .ezcorp/data,
 * and the daemon .pid lockfiles. The dual-root situation is real and
 * deliberate — this test pins which subtree belongs to which root rather
 * than collapsing them.
 */

/**
 * The project root the SHIPPED resolver derives from the container layout
 * the compose file declares.
 *
 * `env: {}` keeps a stray `EZCORP_PROJECT_ROOT` in the test environment
 * from short-circuiting step 1, so the answer comes from the import-meta
 * branch — the one that runs in the container, where no such env var is
 * set.
 */
function resolvedProjectRoot(volumes: readonly string[]): string {
  const srcTarget = targetOf(volumes, "./src");
  expect(srcTarget).toBeDefined();
  const { root, source } = resolveProjectRoot({
    env: {},
    importMetaDir: join(srcTarget!, "extensions"),
  });
  // A fallback would mean the root is no longer a function of the layout,
  // and every assertion built on it would be vacuous.
  expect(source).toBe("import-meta");
  return root;
}

describe("docker-compose.yml — extension state is anchored to getProjectRoot()", () => {
  test("the real resolver maps the container's src/ mount to the project root", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const srcTarget = targetOf(vols, "./src")!;

    // The claim the whole suite rests on, driven through the shipped
    // resolution order rather than restated as a comment.
    expect(resolvedProjectRoot(vols)).toBe(dirname(srcTarget));
  });

  test("the two roots are distinct: the dev-server cwd is BELOW the project root", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const webSrcTarget = targetOf(vols, "./web/src");
    expect(webSrcTarget).toBeDefined();
    // `cd web && bun run dev` — if this ever stops holding, the rest of
    // this suite is meaningless.
    expect(dirname(webSrcTarget!)).toBe(join(resolvedProjectRoot(vols), "web"));
  });

  test("extensions/ + extension-data/ bind under the project root", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const projectRoot = resolvedProjectRoot(vols);

    expect(targetsOf(vols, "./.ezcorp/extensions")).toEqual([
      join(projectRoot, ".ezcorp/extensions"),
    ]);
    expect(targetsOf(vols, "./.ezcorp/extension-data")).toContain(
      join(projectRoot, ".ezcorp/extension-data"),
    );
  });

  test("nothing installs extensions under the dev-server cwd (the original bug)", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const webCwd = dirname(targetOf(vols, "./web/src")!);

    // `extensions/` is the install root recorded in extensions.install_path.
    // It must exist at exactly one place, and not under the cwd.
    expect(targets(vols)).not.toContain(join(webCwd, ".ezcorp/extensions"));
  });

  /**
   * extension-data IS bound twice on purpose — see the compose comment.
   * The consumers behind /api/ext-files and /api/extensions/<n>/data still
   * resolve it from process.cwd(). What must never happen is the two
   * targets diverging onto DIFFERENT host trees, which would split an
   * extension's state in half depending on which reader touched it.
   */
  test("both extension-data targets are the SAME host tree", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const projectRoot = resolvedProjectRoot(vols);
    const webCwd = dirname(targetOf(vols, "./web/src")!);
    const all = targets(vols);

    const cwdTarget = join(webCwd, ".ezcorp/extension-data");
    // Every bind landing on either target must come from one host source.
    for (const target of [join(projectRoot, ".ezcorp/extension-data"), cwdTarget]) {
      const sources = vols
        .filter((v) => v.split(":")[1] === target)
        .map((v) => v.split(":")[0]);
      expect(sources).toEqual(["./.ezcorp/extension-data"]);
    }
    // And the cwd-side one is present at all — dropping it strands every
    // already-generated tool-card image behind an empty volume stub.
    expect(all).toContain(cwdTarget);
  });

  test("the ext-data volume STAYS on the cwd-anchored root (image store + .ezcorp/data)", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const webCwd = dirname(targetOf(vols, "./web/src")!);

    expect(targetOf(vols, "ext-data")).toBe(join(webCwd, ".ezcorp"));
  });
});

describe("compose.prod.yml — same extension-state contract", () => {
  /**
   * Prod has no `./src` bind to derive from (it runs a built image), but
   * it does not need one: prod's WORKDIR IS the project root, so its
   * `ext-data` volume already sits at <projectRoot>/.ezcorp. Holding the
   * extension binds against that volume couples the two prod facts to
   * each other — move one without the other and this fails.
   */
  test("prod binds extension state under the same root as its ext-data volume", async () => {
    const vols = await appVolumes("compose.prod.yml");
    const prodRoot = dirname(targetOf(vols, "ext-data")!);

    expect(targetOf(vols, "./.ezcorp/extensions")).toBe(
      join(prodRoot, ".ezcorp/extensions"),
    );
    expect(targetOf(vols, "./.ezcorp/extension-data")).toBe(
      join(prodRoot, ".ezcorp/extension-data"),
    );
  });

  test("dev and prod agree on the extension-state targets (no cross-stack drift)", async () => {
    const dev = await appVolumes("docker-compose.yml");
    const prod = await appVolumes("compose.prod.yml");

    for (const source of ["./.ezcorp/extensions", "./.ezcorp/extension-data"]) {
      expect(targetOf(dev, source)).toBe(targetOf(prod, source)!);
    }
  });
});
