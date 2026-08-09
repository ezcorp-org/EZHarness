import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Locks the three artifacts that together keep the `tmpfs:` secret masks
 * closed on BOTH container runtimes.
 *
 * ## The bug this exists to prevent
 *
 * docker-compose.yml masks two directories out of the `.:/repo` bind:
 * `/repo/.ezcorp` (the prod stack's live PGlite DB + keys) and
 * `/repo/worktrees` (multi-GB agent scratch). Docker mounts an empty tmpfs
 * over each. Podman does NOT: its tmpfs default is `tmpcopyup`, which seeds
 * the tmpfs with the contents of the directory underneath — publishing into
 * the container exactly what the mask exists to hide, and copying it into
 * RAM while doing so.
 *
 * The fix cannot live in docker-compose.yml, because the Docker daemon
 * rejects `notmpcopyup` and the container then never starts. So it lives in
 * compose.podman.yml, layered on only when the stack runs under Podman.
 *
 * That split is the hazard. A mask is a BLACKLIST — when one silently stops
 * applying, everything still boots and nothing looks wrong. Three artifacts
 * now have to agree, and they are maintained independently:
 *
 *   1. the `tmpfs:` list in docker-compose.yml     (what to hide)
 *   2. the `tmpfs: !override` list in compose.podman.yml  (hide it on Podman)
 *   3. the boot-time guard in the app `command:`   (prove it actually hid)
 *
 * ## Why this is not a tautology
 *
 * None of these assertions restate a literal read from the file it is
 * checking. Each holds one artifact against another, so the suite fails on
 * DRIFT rather than on a value someone chose:
 *
 *   - the override's mask set is compared to the base file's mask set, so
 *     adding, renaming or dropping a mask on one side without the other
 *     fails here rather than in production;
 *   - every mount option on a base mask is required to survive into the
 *     override. `!override` REPLACES the list rather than merging it, so an
 *     option added to the base (the size= caps) is silently dropped under
 *     Podman unless it is repeated — a mask that then defaults to half of
 *     host RAM next to a 13 GB tree;
 *   - the guard's path list is parsed back out of the shell script in
 *     `command:` and compared to the mask targets, so a fourth mask added
 *     later without extending the guard is caught.
 */

const ROOT = join(import.meta.dir, "..", "..");

interface ComposeFile {
  services?: Record<string, { tmpfs?: string[]; command?: string[]; image?: string }>;
}

async function parse(relPath: string): Promise<ComposeFile> {
  return Bun.YAML.parse(await Bun.file(join(ROOT, relPath)).text()) as ComposeFile;
}

/**
 * A compose tmpfs entry is `<target>[:opt[,opt...]]`. Returns the container
 * path and the option set, so options can be compared irrespective of order.
 */
function parseMask(entry: string): { target: string; options: Set<string> } {
  const idx = entry.indexOf(":");
  if (idx === -1) return { target: entry, options: new Set() };
  return {
    target: entry.slice(0, idx),
    options: new Set(entry.slice(idx + 1).split(",").filter(Boolean)),
  };
}

function masksOf(compose: ComposeFile): Map<string, Set<string>> {
  const tmpfs = compose.services?.app?.tmpfs;
  expect(tmpfs).toBeDefined();
  const out = new Map<string, Set<string>>();
  for (const entry of tmpfs!) {
    const { target, options } = parseMask(entry);
    out.set(target, options);
  }
  return out;
}

/** The `sh -c` script the app service boots with. */
function appScript(compose: ComposeFile): string {
  const script = compose.services?.app?.command?.at(-1);
  if (typeof script !== "string") {
    throw new Error("docker-compose.yml: app service has no `sh -c` script in command:");
  }
  return script;
}

/**
 * The paths the boot guard actually iterates, recovered from the shell
 * source rather than duplicated here.
 */
function guardedPaths(script: string): string[] {
  const paths = script.match(/for\s+masked\s+in\s+([^;\n]+);/)?.[1];
  if (!paths) {
    throw new Error("docker-compose.yml: no mask guard loop found in the app command");
  }
  return paths.trim().split(/\s+/);
}

describe("tmpfs secret masks — base file (Docker)", () => {
  test("every tree the mask exists to hide is actually masked", async () => {
    const masks = masksOf(await parse("docker-compose.yml"));
    // These paths are the whole point of the feature: the prod DB/keys and
    // the agent-scratch trees must not be visible inside /repo.
    //
    // `/repo/.claude/worktrees` was missing for as long as this file has
    // existed. `worktrees` READS like it covers every worktree tree, but
    // these are literal mount targets — and the Agent tool's
    // `isolation: "worktree"` writes to `.claude/worktrees`, not `worktrees`.
    // Measured when it was found: 26 GB, 288 .env* files and 76 live .ezcorp
    // dirs (PGlite DB + keys) readable by the self-modification agent on
    // every `docker compose up`, while the boot guard below reported success
    // because it checked only the two paths that WERE masked.
    expect([...masks.keys()].sort()).toEqual([
      "/repo/.claude/worktrees",
      "/repo/.ezcorp",
      "/repo/worktrees",
    ]);
  });

  test("every worktree tree on disk is masked, not just the ones we remembered", async () => {
    // The assertion above is a literal, so it only ever knows what someone
    // thought to write down — which is exactly how the `.claude/worktrees`
    // gap survived. This one derives the expectation from the repo instead:
    // any directory named `worktrees` that a bind mount would expose under
    // /repo has to have a corresponding mask.
    //
    // Uses `git ls-files --others` so it sees IGNORED trees — the whole
    // hazard is that these are gitignored scratch dirs nobody looks at.
    const masks = masksOf(await parse("docker-compose.yml"));
    const { stdout } = Bun.spawnSync({
      cmd: ["git", "ls-files", "--others", "--directory", "--ignored", "--exclude-standard"],
      cwd: ROOT,
    });
    const worktreeDirs = stdout
      .toString()
      .split("\n")
      .map((l) => l.trim().replace(/\/$/, ""))
      .filter((l) => l === "worktrees" || l.endsWith("/worktrees"));

    for (const dir of worktreeDirs) {
      expect(
        masks.has(`/repo/${dir}`),
        `${dir}/ exists on disk and is exposed by the .:/repo bind, but has no tmpfs mask`,
      ).toBe(true);
    }
  });

  test("every mask is size-capped, so none can default to half of host RAM", async () => {
    const masks = masksOf(await parse("docker-compose.yml"));
    for (const [target, options] of masks) {
      const size = [...options].find((o) => o.startsWith("size="));
      expect(size, `${target} has no size= cap`).toBeDefined();
    }
  });

  test("the base file never carries notmpcopyup — the Docker daemon rejects it", async () => {
    // Not a style preference: `invalid tmpfs option [notmpcopyup]` is a
    // daemon-side hard error, so this leaking into the base file takes the
    // stack down for every Docker user.
    //
    // Asserted against the PARSED options rather than the raw text — the
    // file discusses notmpcopyup at length in comments, which the daemon
    // never sees, and a raw substring check would forbid documenting the
    // very hazard this suite exists for.
    const masks = masksOf(await parse("docker-compose.yml"));
    for (const [target, options] of masks) {
      expect(options.has("notmpcopyup"), `${target} carries a Docker-fatal option`).toBe(
        false,
      );
    }
  });
});

describe("tmpfs secret masks — Podman override", () => {
  test("the override covers exactly the base file's masks — no drift either way", async () => {
    const base = masksOf(await parse("docker-compose.yml"));
    const override = masksOf(await parse("compose.podman.yml"));

    // Held against each other, not against a literal: a mask added, renamed
    // or removed on one side alone fails here.
    expect([...override.keys()].sort()).toEqual([...base.keys()].sort());
  });

  test("every masked path disables tmpcopyup under Podman", async () => {
    const override = masksOf(await parse("compose.podman.yml"));
    for (const [target, options] of override) {
      expect(options.has("notmpcopyup"), `${target} would copy up under Podman`).toBe(
        true,
      );
    }
  });

  test("`!override` replaces the list, so base options must survive into it", async () => {
    const base = masksOf(await parse("docker-compose.yml"));
    const override = masksOf(await parse("compose.podman.yml"));

    // The subtle one. Compose does not merge these lists — the override IS
    // the list under Podman. Any option set on the base entry and not
    // repeated here is silently lost, which is how a size= cap would go
    // missing on exactly the runtime that most needs it.
    for (const [target, baseOptions] of base) {
      const overrideOptions = override.get(target);
      expect(overrideOptions).toBeDefined();
      for (const option of baseOptions) {
        expect(
          overrideOptions!.has(option),
          `${target}: base option '${option}' dropped by the override`,
        ).toBe(true);
      }
    }
  });
});

describe("boot-time guard — the masks are verified, not assumed", () => {
  test("the guard checks exactly the set of masked paths", async () => {
    const base = await parse("docker-compose.yml");
    const masks = masksOf(base);

    // Parsed back out of the shell source, so a mask added without
    // extending the guard fails here.
    expect(guardedPaths(appScript(base)).sort()).toEqual([...masks.keys()].sort());
  });

  test("the guard aborts the boot rather than warning", async () => {
    const script = appScript(await parse("docker-compose.yml"));
    // A warning would scroll past in compose logs and the stack would come
    // up with the host tree exposed.
    expect(script).toContain("exit 1");
  });

  test("the guard survives Compose interpolation", async () => {
    const script = appScript(await parse("docker-compose.yml"));
    // Compose substitutes single-dollar references before the shell sees
    // them, so a bare `$masked` becomes "" and the test collapses to
    // `[ -n "" ]` — passing unconditionally and masking the very failure it
    // was written to catch. The doubled form is what reaches sh.
    expect(script).toContain("$$masked");
    expect(script).not.toMatch(/[^$]\$masked/);
  });
});

describe("image references resolve without host registry configuration", () => {
  test("every image is fully qualified", async () => {
    // Unqualified names depend on the host's
    // containers/registries.conf unqualified-search-registries, which is not
    // guaranteed on a contributor box or a CI runner.
    for (const file of ["docker-compose.yml", "compose.podman.yml"]) {
      const compose = await parse(file);
      for (const [name, service] of Object.entries(compose.services ?? {})) {
        if (!service.image) continue;
        expect(service.image, `${file}: service '${name}' image is unqualified`).toMatch(
          /^[a-z0-9.-]+\.[a-z]{2,}\//,
        );
      }
    }
  });
});
