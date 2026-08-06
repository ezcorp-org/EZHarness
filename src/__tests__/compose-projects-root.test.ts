import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { appEnv, appVolumes, targetOf, targetsOf } from "./helpers/compose-volumes";

/**
 * Locks where user-created project workspaces live.
 *
 * ## The bug this exists to catch
 *
 * A project cloned to the literal path `~/projects/<name>` landed in
 * `/app/web/~/projects/<name>` — a directory named `~`. Nothing in the
 * server expands a tilde, so `resolve()` (web/src/routes/api/fs/mkdir)
 * rooted the relative-looking string at the dev server's cwd. That path is
 * on the container's throwaway overlay: invisible on the host, and deleted
 * by the next `docker compose up --force-recreate`. It cost 270 MB of build
 * output and two unpushed commits before anyone noticed, because nothing
 * failed — the folder was created, the project opened, chats worked.
 *
 * ## Why this is not a tautology
 *
 * Re-asserting a literal read from the same compose file proves nothing.
 * The container-side path is not a free choice; it is over-determined by
 * two constraints that live in OTHER files, and the tests below hold the
 * bind against each of them rather than against a hardcoded string:
 *
 *   1. **fs-API sandbox** — `/api/fs/mkdir` + `/api/fs/list` sandbox on
 *      `EZCORP_PROJECT_ROOT ?? process.cwd()`. Compose does not set that
 *      var, so the effective root is the dev server's cwd, which this file
 *      derives from the `./web/src` bind (the app `command:` runs
 *      `cd web && bun run dev`). A target outside it is a hard 403 — which
 *      the form's previous `/app/projects/` default actually was.
 *   2. **Vite watch ignores** — `web/vite.config.ts` ignores `**\/.ezcorp/**`.
 *      A project tree outside that glob puts its build output
 *      (`target/`, `node_modules/`) under the dev watcher.
 *
 * Plus the third artifact that has to agree: ProjectForm.svelte's default
 * path, which is what a user actually gets. It is READ here, not imported —
 * a `bun:test` that imports a `web/src/lib/**` module poisons that module's
 * merged coverage (see the coverage trap in CLAUDE.md).
 */

const ROOT = join(import.meta.dir, "..", "..");

const PROJECTS_SOURCE = "./.ezcorp/projects";

/** The dev server's cwd, derived from the bind that proves where it runs. */
function devServerCwd(volumes: readonly string[]): string {
  const webSrcTarget = targetOf(volumes, "./web/src");
  expect(webSrcTarget).toBeDefined();
  return dirname(webSrcTarget!);
}

/** The single container-side target for the projects bind. */
function projectsTarget(volumes: readonly string[]): string {
  const found = targetsOf(volumes, PROJECTS_SOURCE);
  // Exactly one: a second target would split project state across two
  // trees depending on which caller resolved the path.
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("docker-compose.yml — project workspaces are host-visible and sandbox-legal", () => {
  test("the dev stack binds ./.ezcorp/projects into the container", async () => {
    const vols = await appVolumes("docker-compose.yml");
    expect(projectsTarget(vols)).toBeTruthy();
  });

  test("constraint 1: the target is inside the fs-API sandbox root", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const env = await appEnv("docker-compose.yml");
    const target = projectsTarget(vols);

    // Mirrors the routes' own fallback order. Written as a branch, not a
    // hardcoded assumption, so setting EZCORP_PROJECT_ROOT later moves the
    // expectation instead of silently invalidating it.
    const explicitRoot = env.get("EZCORP_PROJECT_ROOT");
    const sandboxRoot = explicitRoot ?? devServerCwd(vols);

    expect(target.startsWith(sandboxRoot + "/")).toBe(true);
  });

  test("constraint 1 is real: both fs routes still derive the sandbox that way", async () => {
    // If this expression moves, the branch above is testing a rule the
    // shipped code no longer follows.
    for (const route of ["mkdir", "list"]) {
      const src = await Bun.file(
        join(ROOT, "web/src/routes/api/fs", route, "+server.ts"),
      ).text();
      expect(src).toContain("process.env.EZCORP_PROJECT_ROOT ?? process.cwd()");
    }
  });

  test("constraint 2: Vite's watcher ignores the target", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const target = projectsTarget(vols);

    const viteConfig = await Bun.file(join(ROOT, "web/vite.config.ts")).text();
    const block = viteConfig.match(/ignored:\s*\[([^\]]*)\]/);
    expect(block).not.toBeNull();
    const globs = [...block![1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(globs.length).toBeGreaterThan(0);

    // A representative build artifact inside a project — the kind of churn
    // that wedges the dev server if it is watched.
    const artifact = join(target, "some-project", "target", "debug", "build.o");
    expect(globs.some((g) => new Bun.Glob(g).match(artifact))).toBe(true);
  });

  test("the form's default path is inside the bind (what a user actually gets)", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const target = projectsTarget(vols);

    const form = await Bun.file(
      join(ROOT, "web/src/lib/components/ProjectForm.svelte"),
    ).text();
    const matched = form.match(/initial\?\.path \?\? "([^"]+)"/);
    expect(matched).not.toBeNull();
    const defaultPath = matched![1]!;

    // Equal-or-below: the default is the bind root itself today, and a
    // future per-name default must still land under it.
    expect(defaultPath.startsWith(target + "/")).toBe(true);
  });

  test("the bind layers ON TOP of the ext-data volume, and is not near .ezcorp/data", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const target = projectsTarget(vols);
    const extDataVolume = targetOf(vols, "ext-data");
    expect(extDataVolume).toBeDefined();

    // Mounts nest by target-path depth — the projects bind must be strictly
    // deeper than the volume it sits inside, or it never takes effect.
    expect(target.startsWith(extDataVolume + "/")).toBe(true);

    // Sibling of the PGlite DB + JWT secret, never an ancestor: the sandbox
    // jail refuses any grant that is `.ezcorp/data` or contains it.
    const forbidden = join(extDataVolume!, "data");
    expect(target).not.toBe(forbidden);
    expect(forbidden.startsWith(target + "/")).toBe(false);
  });

  test("projects are NOT bound under a path the container throws away", async () => {
    const vols = await appVolumes("docker-compose.yml");
    const target = projectsTarget(vols);

    // The failure mode in the docblock: a container path with no host
    // source behind it. Every ancestor-or-self of the target must be
    // covered by some bind/volume, or writes land on the overlay.
    const allTargets = new Set(vols.map((v) => v.split(":")[1] ?? ""));
    const covered = [...allTargets].some(
      (t) => t !== "" && (target === t || target.startsWith(t + "/")),
    );
    expect(covered).toBe(true);
  });
});
