/**
 * Behaviour tests for `scripts/podman-compose.sh` — the `bun run podman`
 * wrapper.
 *
 * ## Why this file exists
 *
 * The wrapper's job is to layer `compose.podman.yml` onto every invocation.
 * Without that override Podman's `tmpcopyup` default seeds each `tmpfs:`
 * secret mask with the tree it exists to hide, and on a real dev box the
 * consequence is not a readable error. Measured 2026-08-15 (Podman 5.8.2,
 * Compose 5.1.3) against this checkout's 17 GB `worktrees/`:
 *
 *   Error response from daemon: crun: write: No space left on device: OCI runtime error
 *
 * The copy-up runs while the OCI runtime builds the mount namespace, so the
 * container never leaves `Created` and the boot-time mask guard in the app
 * `command:` — the mechanism that WOULD name the cause — never executes. That
 * guard only speaks when every mask is small enough to fit its tmpfs.
 *
 * So the wrapper is the last place the cause still has a name, and the tests
 * below pin the two ways a caller can defeat it from the outside:
 *
 *   1. a global `-f`/`--file`, which REPLACES the compose file list rather
 *      than adding to it, so it drops the override;
 *   2. an inherited `COMPOSE_FILE`, which the wrapper's own export silently
 *      discards.
 *
 * ## Strategy
 *
 * Each case drives the REAL script — no re-implementation of its logic here,
 * which would only pin a copy. A stub `docker` on PATH records the environment
 * and argv it was `exec`d with, and a real unix socket satisfies the script's
 * `[ -S ]` probe, so nothing needs Podman, Docker, or a container.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const WRAPPER = join(REPO_ROOT, "scripts/podman-compose.sh");
const BASH = Bun.which("bash") ?? "/usr/bin/env bash";

const SANDBOX = mkdtempSync(join(tmpdir(), "podman-wrapper-"));
const BIN = join(SANDBOX, "bin");
// PATH for the "docker CLI is missing" case. `dirname` is the one external
// the script runs BEFORE the docker check, so it has to stay reachable —
// otherwise that test would pass for the wrong reason.
const BIN_NO_DOCKER = join(SANDBOX, "bin-no-docker");
const SOCKET = join(SANDBOX, "podman.sock");

mkdirSync(BIN);
mkdirSync(BIN_NO_DOCKER);
symlinkSync(Bun.which("dirname") ?? "/usr/bin/dirname", join(BIN_NO_DOCKER, "dirname"));

// Records what the wrapper handed to Compose, then exits 0 — the wrapper
// `exec`s it, so this is the last word on what the invocation actually was.
await Bun.write(
  join(BIN, "docker"),
  [
    "#!/usr/bin/env bash",
    // Braceless shell expansions on purpose: biome reads a `${...}` inside a
    // JS string as a mistyped template literal. The wrapper exports both
    // variables before it execs, so there is no default to fall back to.
    'printf "COMPOSE_FILE=%s\\n" "$COMPOSE_FILE"',
    'printf "DOCKER_HOST=%s\\n" "$DOCKER_HOST"',
    'printf "ARGV=%s\\n" "$*"',
    "",
  ].join("\n"),
);
chmodSync(join(BIN, "docker"), 0o755);

const socketServer = Bun.listen({ unix: SOCKET, socket: { data() {} } });

afterAll(() => {
  socketServer.stop(true);
  rmSync(SANDBOX, { recursive: true, force: true });
});

// COMPOSE_FILE and DOCKER_HOST are stripped from the inherited environment:
// a developer who exports either one would otherwise silently change what
// these tests measure.
const baseEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) baseEnv[key] = value;
}
delete baseEnv.COMPOSE_FILE;
delete baseEnv.DOCKER_HOST;

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** What the stub Compose CLI was exec'd with, or null when it never ran. */
  invocation: { composeFile: string; dockerHost: string; argv: string } | null;
}

function run(args: string[], env: Record<string, string> = {}): Run {
  const proc = Bun.spawnSync({
    cmd: [BASH, WRAPPER, ...args],
    cwd: SANDBOX,
    env: { ...baseEnv, PATH: `${BIN}:${baseEnv.PATH}`, PODMAN_SOCKET: SOCKET, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const read = (key: string) => stdout.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";
  return {
    exitCode: proc.exitCode,
    stdout,
    stderr: proc.stderr.toString(),
    invocation: stdout.includes("ARGV=")
      ? {
          composeFile: read("COMPOSE_FILE"),
          dockerHost: read("DOCKER_HOST"),
          argv: read("ARGV"),
        }
      : null,
  };
}

describe("podman wrapper — the invocation it guarantees", () => {
  test("layers the Podman override and points Compose at the Podman socket", () => {
    const result = run(["up", "-d"]);
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.composeFile).toBe(
      "docker-compose.yml:compose.podman.yml",
    );
    expect(result.invocation?.dockerHost).toBe(`unix://${SOCKET}`);
    expect(result.invocation?.argv).toBe("compose up -d");
  });

  test("every compose file it layers exists in the repo", async () => {
    // Held against the filesystem rather than against a literal: renaming
    // compose.podman.yml would otherwise leave the wrapper exporting a name
    // that resolves to nothing, and Compose reports that as a missing file
    // with no hint that the secret masks just lost their override.
    const layered = run(["up", "-d"]).invocation?.composeFile.split(":") ?? [];
    expect(layered.length).toBeGreaterThan(0);
    for (const file of layered) {
      expect(await Bun.file(join(REPO_ROOT, file)).exists(), `${file} is missing`).toBe(
        true,
      );
    }
  });

  test("`bun run podman` is this script", async () => {
    // Every doc and comment that says `bun run podman` depends on this.
    const pkg = await Bun.file(join(REPO_ROOT, "package.json")).json();
    expect(pkg.scripts.podman).toContain("scripts/podman-compose.sh");
  });

  test("passes its arguments through untouched", () => {
    // The opt-in sidecar profile is the documented case for this.
    expect(run(["--profile", "ollama", "up", "-d"]).invocation?.argv).toBe(
      "compose --profile ollama up -d",
    );
  });
});

describe("podman wrapper — a `-f` cannot silently drop the override", () => {
  // Compose's -f REPLACES COMPOSE_FILE rather than adding to it. Measured
  // against Compose 5.1.3: `COMPOSE_FILE=base.yml:extra.yml docker compose
  // -f base.yml config --services` lists base.yml's services only. So a -f
  // through this wrapper defeats the one thing the wrapper is for.
  test("refuses a global -f whose files omit the override", () => {
    const result = run(["-f", "docker-compose.yml", "up", "-d"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("compose.podman.yml");
    // The wrapper must fail BEFORE handing anything to Compose — an
    // unmasked `up` is exactly the outcome being prevented.
    expect(result.invocation).toBeNull();
  });

  test("refuses the --file=value spelling too", () => {
    const result = run(["--file=docker-compose.yml", "up", "-d"]);
    expect(result.exitCode).toBe(1);
    expect(result.invocation).toBeNull();
  });

  test("a value-taking global flag does not hide a later -f", () => {
    // `-p proj` consumes its own value. A scanner that did not know that
    // would read `proj` as the subcommand, stop there, and never see the -f.
    const result = run(["-p", "proj", "-f", "docker-compose.yml", "up", "-d"]);
    expect(result.exitCode).toBe(1);
    expect(result.invocation).toBeNull();
  });

  test("accepts a -f list that names the override explicitly", () => {
    // Layering your own file is legitimate; dropping the override is not.
    const result = run([
      "-f",
      "docker-compose.yml",
      "-f",
      "compose.podman.yml",
      "up",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.argv).toBe(
      "compose -f docker-compose.yml -f compose.podman.yml up",
    );
  });

  test("`logs -f app` is --follow, and must not be mistaken for --file", () => {
    // THE false-positive that matters: this exact line is in the wrapper's
    // own header and in docs/deployment.md. A flag AFTER the subcommand
    // belongs to the subcommand, so only the flags before it are Compose's.
    const result = run(["logs", "-f", "app"]);
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.argv).toBe("compose logs -f app");
    expect(result.invocation?.composeFile).toContain("compose.podman.yml");
  });
});

describe("podman wrapper — an inherited COMPOSE_FILE", () => {
  test("refuses one that omits the override instead of discarding it", () => {
    // The wrapper's own export wins over an inherited value, so without this
    // check the caller's list vanishes with no message at all.
    const result = run(["up", "-d"], {
      COMPOSE_FILE: "docker-compose.yml:compose.prod.yml",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("compose.prod.yml");
    expect(result.invocation).toBeNull();
  });

  test("honours one that already layers the override, verbatim", () => {
    // A Podman-only host may set COMPOSE_FILE instead of using the wrapper
    // (docs/deployment.md), and extra files layered on top must survive.
    const inherited = "docker-compose.yml:compose.podman.yml:compose.extra.yml";
    const result = run(["up", "-d"], { COMPOSE_FILE: inherited });
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.composeFile).toBe(inherited);
  });
});

describe("podman wrapper — host preconditions", () => {
  test("names the socket, and how to start it, when there is none", () => {
    const result = run(["up", "-d"], { PODMAN_SOCKET: join(SANDBOX, "absent.sock") });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("systemctl --user enable --now podman.socket");
    expect(result.invocation).toBeNull();
  });

  test("says the docker CLI is required when it is not on PATH", () => {
    const result = run(["up", "-d"], { PATH: BIN_NO_DOCKER });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("'docker' CLI");
  });
});
