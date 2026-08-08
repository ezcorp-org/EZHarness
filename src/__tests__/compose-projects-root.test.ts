import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import {
  appEnv,
  appVolumes,
  appVolumesOrEmpty,
  splitMount,
  targetOf,
  targetsOf,
} from "./helpers/compose-volumes";

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
    const allTargets = new Set(vols.map((v) => splitMount(v)[1] ?? ""));
    const covered = [...allTargets].some(
      (t) => t !== "" && (target === t || target.startsWith(t + "/")),
    );
    expect(covered).toBe(true);
  });
});

/**
 * Every stack that can serve a given database must agree on ONE container
 * path for project workspaces.
 *
 * `projects.path` stores an ABSOLUTE CONTAINER path. So the moment the dev
 * and prod stacks disagree, a database that moves between them points at
 * directories that do not exist on the other side — and the symptom names
 * nothing: the `shell` tool spawns with `cwd=<project path>`, so a missing
 * cwd surfaces as `posix_spawn '/bin/sh' — ENOENT` (reads like a broken
 * image), and the file tools reject it as "Path traversal detected".
 *
 * That disagreement is exactly what `compose.prod.localtest.yml` used to
 * paper over: it re-mounted a host tree at `/app/projects` for no reason
 * other than that dev-DB rows pointed there. Holding one path across the
 * stacks removes the need for that overlay mount entirely.
 */
describe("the projects bind is identical across every stack", () => {
  /** Compose files that define an `app` service (docker-compose.test.yml does not). */
  const APP_STACKS = [
    "docker-compose.yml",
    "compose.prod.yml",
    "compose.prod.devdb.yml",
    "compose.prod.localtest.yml",
    "compose.podman.yml",
    "compose.secrets-test.yml",
  ] as const;

  /**
   * The WORKDIR in effect for the image's FINAL stage — prod's cwd, and so
   * prod's fs-API sandbox root. Derived, never hardcoded: `FROM` resets
   * WORKDIR, so a new build stage appended to the Dockerfile moves this
   * expectation instead of silently invalidating it.
   */
  async function finalStageWorkdir(): Promise<string> {
    const df = await Bun.file(join(ROOT, "Dockerfile")).text();
    let workdir: string | undefined;
    for (const line of df.split("\n")) {
      if (/^FROM\s/.test(line)) workdir = undefined;
      const m = line.match(/^WORKDIR\s+(\S+)\s*$/);
      if (m) workdir = m[1];
    }
    expect(workdir).toBeDefined();
    return workdir!;
  }

  test("prod binds the same host source to the same container target as dev", async () => {
    const devTarget = projectsTarget(await appVolumes("docker-compose.yml"));
    const prodTarget = projectsTarget(await appVolumes("compose.prod.yml"));

    // The whole point: one path, so `projects.path` rows are portable.
    expect(prodTarget).toBe(devTarget);
  });

  test("the prod target is inside prod's fs-API sandbox root", async () => {
    const prodVols = await appVolumes("compose.prod.yml");
    const target = projectsTarget(prodVols);
    const env = await appEnv("compose.prod.yml");

    // Same fallback order the routes use. Prod sets no EZCORP_PROJECT_ROOT,
    // so the effective root is the image's final-stage WORKDIR.
    const sandboxRoot = env.get("EZCORP_PROJECT_ROOT") ?? (await finalStageWorkdir());
    expect(target.startsWith(sandboxRoot + "/")).toBe(true);
  });

  test("prod's cwd really is the jail: the entrypoint is a RELATIVE path", async () => {
    // If CMD were absolute, cwd would not be pinned by WORKDIR and the test
    // above would be asserting a root the process does not actually run in.
    const df = await Bun.file(join(ROOT, "Dockerfile")).text();
    const cmd = df.match(/^CMD\s+\[(.+)\]\s*$/m);
    expect(cmd).not.toBeNull();
    const argv = [...cmd![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const script = argv[argv.length - 1]!;
    expect(script.startsWith("/")).toBe(false);
  });

  test("no stack mounts anything at the abandoned /app/projects", async () => {
    // The pre-`.ezcorp` location. It sits outside the dev fs-API sandbox
    // root (/app/web) and outside Vite's `**/.ezcorp/**` ignore, so a
    // re-added bind here is a regression on both constraints at once.
    for (const file of APP_STACKS) {
      const vols = await appVolumesOrEmpty(file);
      const targets = vols.map((v) => splitMount(v)[1] ?? "");
      expect({ file, targets: targets.filter((t) => t === "/app/projects") }).toEqual({
        file,
        targets: [],
      });
    }
  });

  /**
   * The shared reader has to survive all three shapes compose allows,
   * because this repo uses all three. `appEnv` previously assumed the
   * sequence form and threw `TypeError: {} is not iterable` on the prod
   * file — so the "is the prod target inside prod's jail" test above could
   * not even ask its question until the reader was fixed.
   */
  /**
   * The mount reader has to survive an interpolated source. No compose file
   * in the repo has one today — the last was
   * `${EZCORP_TEST_PROJECTS_DIR:-./projects}:/app/projects`, which went away
   * with the `/app/projects` bind — and that is precisely the risk: a naive
   * `split(":")` is CORRECT for every current line, so the bug reappears
   * silently the next time someone adds a default. It does not throw; it
   * returns the source's tail as the target, and the assertion written
   * against it passes while testing nothing.
   */
  test("splitMount ignores colons inside a compose interpolation", () => {
    // Assembled rather than written literally: the content is COMPOSE
    // interpolation syntax, and a literal "${…}" inside a plain JS string
    // trips biome's noTemplateCurlyInString on every occurrence.
    const source = `$\{EZCORP_TEST_PROJECTS_DIR:-./projects}`;
    const mount = `${source}:/app/projects`;

    // The exact line this repo used to carry.
    expect(splitMount(mount)).toEqual([source, "/app/projects"]);

    // What the naive version produced, kept as the anti-regression witness.
    expect(mount.split(":")).not.toEqual(splitMount(mount));
    expect(mount.split(":")[1]).toBe("-./projects}");

    // Ordinary mounts are unaffected, including the :ro mode field.
    expect(splitMount("./src:/app/src")).toEqual(["./src", "/app/src"]);
    expect(splitMount("./bun.lock:/app/bun.lock:ro")).toEqual([
      "./bun.lock",
      "/app/bun.lock",
      "ro",
    ]);
    expect(splitMount("ext-data:/app/.ezcorp")).toEqual(["ext-data", "/app/.ezcorp"]);
  });

  test("appEnv reads sequence, mapping, and absent environments", async () => {
    // Sequence form (`- KEY=value`).
    expect((await appEnv("docker-compose.yml")).size).toBeGreaterThan(0);

    // Mapping form (`KEY: value`) — the shape that used to throw.
    const prod = await appEnv("compose.prod.yml");
    expect(prod.get("EZCORP_PORT")).toBe("3000");

    // Absent entirely: an empty map, NOT a throw and not a missing key that
    // a caller would misread as "the var is unset here".
    expect((await appEnv("compose.podman.yml")).size).toBe(0);
  });

  test("the localtest overlay carries no projects mount of its own", async () => {
    // It inherits compose.prod.yml's. A second, DIFFERENT source pointed at
    // the same target would silently shadow the base bind depending on -f
    // ordering, which is how the two stacks drifted apart originally.
    const vols = await appVolumesOrEmpty("compose.prod.localtest.yml");
    const devTarget = projectsTarget(await appVolumes("docker-compose.yml"));
    expect(vols.filter((v) => v.includes(devTarget))).toEqual([]);
  });
});
