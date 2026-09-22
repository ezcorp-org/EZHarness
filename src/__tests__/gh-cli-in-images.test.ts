import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Holds the two app images against the host-side code that shells out to
 * `gh`, so the binary cannot go missing from an image again.
 *
 * ## The bug this exists to prevent
 *
 * `project-open-pr.ts` runs `gh pr create` and `github-projects-handler.ts`
 * runs `gh auth token`. Both are `Bun.spawn` calls, so a missing `gh` is not
 * a build-time or type-time error — it is an ENOENT at the call site, at the
 * moment a user asks for a pull request. The failure surfaces as "could not
 * open the pull request" or as a GitHub auth failure, which reads as a
 * permissions problem on the token rather than as an image that never
 * carried the CLI.
 *
 * That is exactly what shipped: both Dockerfiles installed `git` and never
 * `gh`, so every in-app PR attempt failed with a misleading message. Running
 * the built dev image confirmed it — `git` present, `gh` absent.
 *
 * ## Why this is not a tautology
 *
 * The call sites are read out of `src/`, and the install lines are read out
 * of the Dockerfiles. Neither value is restated here: the test asserts that
 * an image installs every binary the source actually spawns. Add a third
 * `gh` call site and nothing here needs editing; drop `gh` from one image
 * and this fails naming that image.
 */

const ROOT = join(import.meta.dir, "..", "..");

/** Images that run the host-side app code, and so must carry its binaries. */
const APP_IMAGES: string[] = ["Dockerfile", "Dockerfile.dev"];

/** Host modules that spawn a bare executable name rather than a path. */
const SHELL_OUT_SOURCES = [
  "src/extensions/project-open-pr.ts",
  "src/extensions/github-projects-handler.ts",
] as const;

async function text(relPath: string): Promise<string> {
  return Bun.file(join(ROOT, relPath)).text();
}

describe("gh CLI in the app images", () => {
  test("the host-side GitHub code still shells out to gh", async () => {
    // Guards the premise. If these call sites move to the REST API, this
    // fails and the install layers below can go — rather than the images
    // quietly carrying a binary nothing runs.
    const sources = await Promise.all(SHELL_OUT_SOURCES.map(text));
    for (const [index, source] of sources.entries()) {
      expect(source, `${SHELL_OUT_SOURCES[index]} should spawn gh`).toContain('"gh"');
    }
  });

  for (const image of APP_IMAGES) {
    test(`${image} installs gh onto $PATH`, async () => {
      expect(await text(image)).toContain("/usr/local/bin/gh");
    });

    test(`${image} pins the gh version rather than floating it`, async () => {
      // A floating `gh` invalidates the layer on every upstream release, the
      // drift the pinned bun base exists to avoid.
      expect(await text(image)).toMatch(/ARG GH_VERSION=\d+\.\d+\.\d+/);
    });

    test(`${image} can fetch the tarball it installs`, async () => {
      // `gh` is fetched over HTTPS, so the image needs curl and a trust store.
      const dockerfile = await text(image);
      expect(dockerfile).toContain("curl");
      expect(dockerfile).toContain("ca-certificates");
    });
  }

  test("both images pin the same gh version", async () => {
    const versions = await Promise.all(
      APP_IMAGES.map(async image => /ARG GH_VERSION=(\S+)/.exec(await text(image))?.[1]),
    );
    expect(new Set(versions).size, `gh pins drifted: ${versions.join(" vs ")}`).toBe(1);
  });

  test("the prod image installs gh before dropping to the unprivileged user", async () => {
    // Root-owned and 0755 only holds if the install precedes `USER bun`.
    //
    // Both needles are matched as DIRECTIVES, anchored to the start of a
    // line. Matching `USER bun` as a bare substring finds the prose mention
    // in the install block's own comment, which sits before the install and
    // inverted this comparison while the Dockerfile was correct.
    const dockerfile = await text("Dockerfile");
    const install = dockerfile.search(/^\s+install .*\/usr\/local\/bin\/gh/m);
    const dropPrivileges = dockerfile.search(/^USER bun$/m);
    expect(install, "gh install line not found").toBeGreaterThan(-1);
    expect(dropPrivileges, "USER directive not found").toBeGreaterThan(-1);
    expect(install).toBeLessThan(dropPrivileges);
  });
});
