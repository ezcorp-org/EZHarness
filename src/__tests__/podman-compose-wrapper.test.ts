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
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const WRAPPER_SOURCE = join(REPO_ROOT, "scripts/podman-compose.sh");
const RESOLVER = join(REPO_ROOT, "scripts/resolve-runner-group.sh");
const BASH = Bun.which("bash") ?? "/usr/bin/env bash";

const SANDBOX = mkdtempSync(join(tmpdir(), "podman-wrapper-"));
const BIN = join(SANDBOX, "bin");
const BIN_STANDALONE = join(SANDBOX, "bin-standalone");
const BIN_GIT_UNAVAILABLE = join(SANDBOX, "bin-git-unavailable");
const BIN_REAL_COMPOSE = join(SANDBOX, "bin-real-compose");
// PATH for the "docker CLI is missing" case. `dirname` is the one external
// the script runs BEFORE the docker check, so it has to stay reachable —
// otherwise that test would pass for the wrong reason.
const BIN_NO_DOCKER = join(SANDBOX, "bin-no-docker");
const SOCKET = join(SANDBOX, "podman.sock");
const RUNNER_SOCKET = join(SANDBOX, "runner.sock");
const WRAPPER = join(SANDBOX, "scripts/podman-compose.sh");
const TRACKED_SOURCE = join(SANDBOX, "image-backed-source.txt");
const UNTRACKED_BUILD_SOURCE = join(SANDBOX, "build-relevant-untracked.conf");
const PROVENANCE_WARNING = join(REPO_ROOT, "scripts/warn-dev-image-provenance.sh");

mkdirSync(BIN);
mkdirSync(BIN_STANDALONE);
mkdirSync(BIN_GIT_UNAVAILABLE);
mkdirSync(BIN_REAL_COMPOSE);
mkdirSync(BIN_NO_DOCKER);
mkdirSync(join(SANDBOX, "scripts"));
symlinkSync(WRAPPER_SOURCE, WRAPPER);
symlinkSync(RESOLVER, join(SANDBOX, "scripts/resolve-runner-group.sh"));
symlinkSync(Bun.which("dirname") ?? "/usr/bin/dirname", join(BIN_NO_DOCKER, "dirname"));
writeFileSync(TRACKED_SOURCE, "clean source\n");
copyFileSync(join(REPO_ROOT, ".dockerignore"), join(SANDBOX, ".dockerignore"));
writeFileSync(
  join(SANDBOX, "docker-compose.yml"),
  `services:
  probe:
    image: docker.io/library/alpine:latest
    build:
      context: .
      args:
        EZCORP_BUILD_COMMIT: \${EZCORP_BUILD_COMMIT:-\${EZCORP_BUILD_COMMIT_DEFAULT:-unknown}}
        EZCORP_BUILD_SOURCE_STATE: \${EZCORP_BUILD_SOURCE_STATE:-\${EZCORP_BUILD_SOURCE_STATE_DEFAULT:-unknown}}
`,
);
writeFileSync(join(SANDBOX, "compose.podman.yml"), "services: {}\n");

// Records what the wrapper handed to Compose, then exits 0 — the wrapper
// `exec`s it, so this is the last word on what the invocation actually was.
const composeRecorder = [
  "#!/usr/bin/env bash",
  // Braceless shell expansions on purpose: biome reads a `${...}` inside a
  // JS string as a mistyped template literal. The wrapper exports both
  // variables before it execs, so there is no default to fall back to.
  'printf "COMPOSE_FILE=%s\\n" "$COMPOSE_FILE"',
  'printf "DOCKER_HOST=%s\\n" "$DOCKER_HOST"',
  'printf "EZCORP_BUILD_COMMIT=%s\\n" "$EZCORP_BUILD_COMMIT"',
  'printf "EZCORP_BUILD_SOURCE_STATE=%s\\n" "$EZCORP_BUILD_SOURCE_STATE"',
  'printf "EZCORP_BUILD_COMMIT_DEFAULT=%s\\n" "$EZCORP_BUILD_COMMIT_DEFAULT"',
  'printf "EZCORP_BUILD_SOURCE_STATE_DEFAULT=%s\\n" "$EZCORP_BUILD_SOURCE_STATE_DEFAULT"',
  'printf "EZ_RUNNER_GROUP=%s\\n" "$EZ_RUNNER_GROUP"',
  'if test -v EZ_RUNNER_GROUP; then printf "EZ_RUNNER_GROUP_SET=1\\n"; else printf "EZ_RUNNER_GROUP_SET=0\\n"; fi',
  'printf "ARGV=%s\\n" "$*"',
  "",
].join("\n");
await Bun.write(join(BIN, "docker"), composeRecorder);
chmodSync(join(BIN, "docker"), 0o755);
await Bun.write(join(BIN_STANDALONE, "docker"), "#!/usr/bin/env bash\nexit 1\n");
await Bun.write(join(BIN_STANDALONE, "docker-compose"), composeRecorder);
chmodSync(join(BIN_STANDALONE, "docker"), 0o755);
chmodSync(join(BIN_STANDALONE, "docker-compose"), 0o755);
await Bun.write(join(BIN_GIT_UNAVAILABLE, "git"), "#!/usr/bin/env bash\nexit 127\n");
chmodSync(join(BIN_GIT_UNAVAILABLE, "git"), 0o755);
const realCompose = Bun.which("docker") ?? Bun.which("docker-compose");
if (!realCompose) throw new Error("Docker Compose is required for wrapper interpolation tests");
symlinkSync(realCompose, join(BIN_REAL_COMPOSE, realCompose.endsWith("docker-compose") ? "docker-compose" : "docker"));

const socketServer = Bun.listen({ unix: SOCKET, socket: { data() {} } });
const runnerSocketServer = Bun.listen({ unix: RUNNER_SOCKET, socket: { data() {} } });
const RUNNER_HOST_GID = statSync(RUNNER_SOCKET).gid;
const DEFAULT_GID_MAP = `0 ${RUNNER_HOST_GID} 1`;

await Bun.write(
  join(BIN, "podman"),
  ["#!/usr/bin/env bash", 'printf "%s\\n" "$PODMAN_GID_MAP"', ""].join("\n"),
);
chmodSync(join(BIN, "podman"), 0o755);

const sandboxGitEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith("GIT_")) sandboxGitEnv[key] = value;
}

function sandboxGit(...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", "-C", SANDBOX, ...args], env: sandboxGitEnv, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

sandboxGit("init", "-q");
writeFileSync(
  join(SANDBOX, ".git/info/exclude"),
  ["bin*", "*.sock", "env.prod", "caller-*.env", "ignored-generated/", ""].join("\n"),
);
sandboxGit("add", "image-backed-source.txt", ".dockerignore", "docker-compose.yml", "compose.podman.yml", "scripts");
sandboxGit("-c", "user.name=Wrapper test", "-c", "user.email=wrapper@example.invalid", "commit", "-qm", "fixture");
const DEFAULT_BUILD_COMMIT = sandboxGit("rev-parse", "--verify", "HEAD");

afterAll(() => {
  socketServer.stop(true);
  runnerSocketServer.stop(true);
  rmSync(SANDBOX, { recursive: true, force: true });
});

// COMPOSE_FILE and DOCKER_HOST are stripped from the inherited environment:
// a developer who exports either one would otherwise silently change what
// these tests measure.
const baseEnv: Record<string, string> = { ...sandboxGitEnv };
delete baseEnv.COMPOSE_FILE;
delete baseEnv.DOCKER_HOST;
delete baseEnv.EZCORP_BUILD_COMMIT;
delete baseEnv.EZCORP_BUILD_COMMIT_DEFAULT;
delete baseEnv.EZCORP_BUILD_SOURCE_STATE;
delete baseEnv.EZCORP_BUILD_SOURCE_STATE_DEFAULT;
delete baseEnv.EZ_RUNNER_GROUP;

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** What the stub Compose CLI was exec'd with, or null when it never ran. */
  invocation: {
    composeFile: string;
    dockerHost: string;
    buildCommit: string;
    buildCommitDefault: string;
    buildSourceState: string;
    buildSourceStateDefault: string;
    runnerGroup: string;
    runnerGroupSet: string;
    argv: string;
  } | null;
}

function run(args: string[], env: Record<string, string> = {}, dotenv?: string): Run {
  const envFile = join(SANDBOX, ".env");
  rmSync(envFile, { force: true });
  if (dotenv !== undefined) writeFileSync(envFile, dotenv);
  const proc = Bun.spawnSync({
    cmd: [BASH, WRAPPER, ...args],
    cwd: SANDBOX,
    env: {
      ...baseEnv,
      PATH: `${BIN}:${baseEnv.PATH}`,
      PODMAN_SOCKET: SOCKET,
      PODMAN_GID_MAP: DEFAULT_GID_MAP,
      EZ_RUNNER_SOCKET_DIR: SANDBOX,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  rmSync(envFile, { force: true });
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
          buildCommit: read("EZCORP_BUILD_COMMIT"),
          buildCommitDefault: read("EZCORP_BUILD_COMMIT_DEFAULT"),
          buildSourceState: read("EZCORP_BUILD_SOURCE_STATE"),
          buildSourceStateDefault: read("EZCORP_BUILD_SOURCE_STATE_DEFAULT"),
          runnerGroup: read("EZ_RUNNER_GROUP"),
          runnerGroupSet: read("EZ_RUNNER_GROUP_SET"),
          argv: read("ARGV"),
        }
      : null,
  };
}

function runWithRealCompose(
  args: string[],
  env: Record<string, string> = {},
  dotenv?: string,
): { exitCode: number; stderr: string; stdout: string } {
  const envFile = join(SANDBOX, ".env");
  rmSync(envFile, { force: true });
  if (dotenv !== undefined) writeFileSync(envFile, dotenv);
  const proc = Bun.spawnSync({
    cmd: [BASH, WRAPPER, ...args],
    cwd: SANDBOX,
    env: {
      ...baseEnv,
      PATH: `${BIN_REAL_COMPOSE}:${baseEnv.PATH}`,
      PODMAN_SOCKET: SOCKET,
      EZ_RUNNER_GROUP: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  rmSync(envFile, { force: true });
  return {
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString(),
    stdout: proc.stdout.toString(),
  };
}

function renderedBuildArgs(result: { exitCode: number; stderr: string; stdout: string }): Record<string, string> {
  expect(result.exitCode, result.stderr).toBe(0);
  const config = JSON.parse(result.stdout) as {
    services: { probe: { build: { args: Record<string, string> } } };
  };
  return config.services.probe.build.args;
}

function resolveRunnerGroup(mode: "--docker" | "--podman", env: Record<string, string> = {}): Run {
  const proc = Bun.spawnSync({
    cmd: [BASH, RESOLVER, mode],
    cwd: SANDBOX,
    env: {
      ...baseEnv,
      PATH: `${BIN}:${baseEnv.PATH}`,
      PODMAN_GID_MAP: DEFAULT_GID_MAP,
      EZ_RUNNER_SOCKET_DIR: SANDBOX,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    invocation: null,
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

  test("derives the mapped runner group when the fresh environment leaves it unset", () => {
    const result = run(["config", "--services"]);
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.runnerGroup).toBe("0");
  });

  test("uses the runner socket host GID for direct Docker", () => {
    const result = resolveRunnerGroup("--docker");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(String(RUNNER_HOST_GID));
  });

  test("maps a socket GID through the matching subordinate range", () => {
    const containerStart = 7;
    const result = resolveRunnerGroup("--podman", {
      PODMAN_GID_MAP: `0 ${RUNNER_HOST_GID + 1} 1\n${containerStart} 0 ${RUNNER_HOST_GID + 1}`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(String(containerStart + RUNNER_HOST_GID));
  });

  test("rejects a socket GID outside the rootless Podman map", () => {
    const result = resolveRunnerGroup("--podman", {
      PODMAN_GID_MAP: `0 ${RUNNER_HOST_GID + 1} 1`,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`runner socket host GID ${RUNNER_HOST_GID} is not mapped`);
  });

  test("names a configured runner socket that does not exist", () => {
    const missingDirectory = join(SANDBOX, "missing-runner");
    const result = resolveRunnerGroup("--docker", { EZ_RUNNER_SOCKET_DIR: missingDirectory });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`no extension-runner socket at ${missingDirectory}/runner.sock`);
  });

  test("the fresh environment example leaves the group unset for the wrapper", async () => {
    const example = await Bun.file(join(REPO_ROOT, ".env.example")).text();
    expect(example).not.toContain("\nEZ_RUNNER_GROUP=");
  });

  test("rejects an explicit empty runner group before Compose can interpolate it", () => {
    const result = run(["config", "--services"], { EZ_RUNNER_GROUP: "" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("explicitly set but is empty");
    expect(result.invocation).toBeNull();
  });

  test("rejects an explicit non-numeric runner group", () => {
    const result = run(["config", "--services"], { EZ_RUNNER_GROUP: "runner" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be a numeric");
    expect(result.invocation).toBeNull();
  });

  test("leaves a runner-group declaration in Compose's .env file to Compose", () => {
    const result = run(["config", "--services"], {}, "EZ_RUNNER_GROUP=\n");
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.runnerGroupSet).toBe("0");
  });

  test("does not parse non-numeric runner groups in Compose's .env file", () => {
    const result = run(["config", "--services"], {}, "EZ_RUNNER_GROUP=runner\n");
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.runnerGroupSet).toBe("0");
  });

  test("does not guess at quoted or duplicate Compose dotenv assignments", () => {
    const result = run(["config", "--services"], {}, 'EZ_RUNNER_GROUP="7"\r\nEZ_RUNNER_GROUP=8\n');
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.runnerGroupSet).toBe("0");
  });

  test("uses a numeric shell runner group without reading Compose's .env file", () => {
    const explicit = run(["config", "--services"], { EZ_RUNNER_GROUP: "7" });
    expect(explicit.exitCode).toBe(0);
    expect(explicit.invocation?.runnerGroup).toBe("7");
  });

  test("leaves a global --env-file runner group to Compose", () => {
    const result = run(["--env-file", "custom.env", "config", "--services"]);
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.runnerGroupSet).toBe("0");
    expect(result.invocation?.argv).toBe("compose --env-file custom.env config --services");
  });

  test("leaves the global --env-file=value spelling to Compose too", () => {
    const result = run(["--env-file=custom.env", "config", "--services"]);
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.runnerGroupSet).toBe("0");
    expect(result.invocation?.argv).toBe("compose --env-file=custom.env config --services");
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

  test("provides checkout defaults without replacing explicit shell provenance", () => {
    const defaultBuild = run(["up", "-d"]).invocation;
    expect(defaultBuild?.buildCommit).toBe("");
    expect(defaultBuild?.buildCommitDefault).toBe(DEFAULT_BUILD_COMMIT);
    expect(defaultBuild?.buildSourceState).toBe("");
    expect(defaultBuild?.buildSourceStateDefault).toBe("clean");

    const explicit = run(["up", "-d"], {
      EZCORP_BUILD_COMMIT: "f".repeat(40),
      EZCORP_BUILD_SOURCE_STATE: "dirty",
    }).invocation;
    expect(explicit?.buildCommit).toBe("f".repeat(40));
    expect(explicit?.buildSourceState).toBe("dirty");
    expect(explicit?.buildCommitDefault).toBe(DEFAULT_BUILD_COMMIT);
    expect(explicit?.buildSourceStateDefault).toBe("clean");
  });

  test("records tracked source changes in the Docker-context default", () => {
    writeFileSync(TRACKED_SOURCE, "dirty source\n");
    try {
      expect(run(["up", "-d", "--build"]).invocation?.buildSourceStateDefault).toBe(
        "dirty",
      );
    } finally {
      writeFileSync(TRACKED_SOURCE, "clean source\n");
    }
    expect(run(["config"]).invocation?.buildSourceStateDefault).toBe("clean");
  });

  test("records an untracked Docker input and retains its warning after cleanup", () => {
    writeFileSync(UNTRACKED_BUILD_SOURCE, "affects the image\n");
    let imageSourceState = "";
    try {
      imageSourceState =
        run(["up", "-d", "--build"]).invocation?.buildSourceStateDefault ?? "";
      expect(imageSourceState).toBe("dirty");
    } finally {
      rmSync(UNTRACKED_BUILD_SOURCE, { force: true });
    }

    expect(run(["config"]).invocation?.buildSourceStateDefault).toBe("clean");
    const warning = Bun.spawnSync({
      cmd: ["sh", PROVENANCE_WARNING],
      env: {
        ...baseEnv,
        EZCORP_IMAGE_BUILD_COMMIT: DEFAULT_BUILD_COMMIT,
        EZCORP_IMAGE_BUILD_SOURCE_STATE: imageSourceState,
        EZCORP_REPO_DIR: SANDBOX,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(warning.exitCode).toBe(0);
    expect(warning.stderr.toString()).toContain(
      "image was built from uncommitted source changes",
    );
  });

  test("ignores untracked generated and Docker-excluded files", () => {
    mkdirSync(join(SANDBOX, "ignored-generated"));
    writeFileSync(join(SANDBOX, "ignored-generated/cache.txt"), "generated\n");
    writeFileSync(join(SANDBOX, "excluded.test.ts"), "not copied by Docker\n");
    try {
      expect(run(["config"]).invocation?.buildSourceStateDefault).toBe("clean");
    } finally {
      rmSync(join(SANDBOX, "ignored-generated"), { recursive: true, force: true });
      rmSync(join(SANDBOX, "excluded.test.ts"), { force: true });
    }
  });

  test("non-build commands reach Compose with recoverable provenance when Git metadata is unavailable", () => {
    const noGit = { PATH: `${BIN_GIT_UNAVAILABLE}:${BIN}:${baseEnv.PATH}` };
    for (const args of [["logs", "app"], ["down"], ["ps"], ["config"]]) {
      const result = run(args, noGit);
      expect(result.exitCode, args.join(" ")).toBe(0);
      expect(result.invocation?.buildCommitDefault).toBe("unknown");
      expect(result.invocation?.buildSourceStateDefault).toBe("unknown");
    }
  });

  test("an explicit revision survives when Git metadata is unavailable", () => {
    const revision = "f".repeat(40);
    const result = run(["config"], {
      PATH: `${BIN_GIT_UNAVAILABLE}:${BIN}:${baseEnv.PATH}`,
      EZCORP_BUILD_COMMIT: revision,
    });
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.buildCommit).toBe(revision);
    expect(result.invocation?.buildCommitDefault).toBe("unknown");
    expect(result.invocation?.buildSourceStateDefault).toBe("unknown");
  });

  test("Compose preserves quoted duplicate values from .env above derived defaults", () => {
    const args = renderedBuildArgs(
      runWithRealCompose(
        ["config", "--format", "json"],
        {},
        [
          "EZCORP_BUILD_COMMIT='first value'",
          'EZCORP_BUILD_COMMIT="second # value"',
          "EZCORP_BUILD_SOURCE_STATE=dirty",
          "",
        ].join("\n"),
      ),
    );
    expect(args.EZCORP_BUILD_COMMIT).toBe("second # value");
    expect(args.EZCORP_BUILD_SOURCE_STATE).toBe("dirty");
  });

  test("caller env-file spellings preserve explicit no-Git provenance", () => {
    const callerEnv = join(SANDBOX, "caller-provenance.env");
    writeFileSync(
      callerEnv,
      [
        "EZCORP_BUILD_COMMIT='first archive value'",
        'EZCORP_BUILD_COMMIT="archive # final"',
        "EZCORP_BUILD_SOURCE_STATE=dirty",
        "",
      ].join("\n"),
    );
    try {
      for (const spelling of [
        ["--env-file", callerEnv],
        [`--env-file=${callerEnv}`],
      ]) {
        const args = renderedBuildArgs(
          runWithRealCompose(
            [...spelling, "config", "--format", "json"],
            { PATH: `${BIN_GIT_UNAVAILABLE}:${BIN_REAL_COMPOSE}:${baseEnv.PATH}` },
          ),
        );
        expect(args.EZCORP_BUILD_COMMIT).toBe("archive # final");
        expect(args.EZCORP_BUILD_SOURCE_STATE).toBe("dirty");
      }
    } finally {
      rmSync(callerEnv, { force: true });
    }
  });

  test("preserves the revision stamp with the standalone Compose client", () => {
    const result = run(["up", "-d"], {
      PATH: `${BIN_STANDALONE}:${baseEnv.PATH}`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.argv).toBe("up -d");
    expect(result.invocation?.buildCommitDefault).toBe(DEFAULT_BUILD_COMMIT);
  });
});

describe("podman wrapper — the prod stack (`--prod`)", () => {
  // .env.prod is gitignored and absent in CI, so the wrapper's env-file
  // branch is pointed at a temp file instead of the real one.
  const ENV_FILE = join(SANDBOX, "env.prod");
  writeFileSync(ENV_FILE, "EZCORP_PUBLIC_URL=http://localhost:4000\n");

  test("swaps the file list for the prod stack and its override", () => {
    const result = run(["--prod", "up", "-d"], { EZ_COMPOSE_ENV_FILE: ENV_FILE });
    expect(result.exitCode).toBe(0);
    expect(result.invocation?.composeFile).toBe(
      "compose.prod.yml:compose.podman-prod.yml",
    );
    expect(result.invocation?.buildCommitDefault).toBe(DEFAULT_BUILD_COMMIT);
  });

  test("prod non-build commands reach Compose without Git metadata", () => {
    const noGit = {
      PATH: `${BIN_GIT_UNAVAILABLE}:${BIN}:${baseEnv.PATH}`,
      EZ_COMPOSE_ENV_FILE: ENV_FILE,
    };
    for (const command of ["logs", "down", "ps", "config"]) {
      const result = run(["--prod", command], noGit);
      expect(result.exitCode, command).toBe(0);
      expect(result.invocation?.buildCommitDefault).toBe("unknown");
      expect(result.invocation?.buildSourceStateDefault).toBe("unknown");
    }
  });

  test("injects --env-file, because Compose ignores COMPOSE_ENV_FILE", () => {
    // Measured on Compose 5.5.1: with only COMPOSE_ENV_FILE set, every
    // `${VAR:?}` in compose.prod.yml reads as unset and the deploy aborts.
    // The flag has to be on the command line, ahead of the subcommand.
    const result = run(["--prod", "up", "-d"], { EZ_COMPOSE_ENV_FILE: ENV_FILE });
    expect(result.invocation?.argv).toBe(`compose --env-file ${ENV_FILE} up -d`);
    expect(result.invocation?.runnerGroupSet).toBe("0");
  });

  test("does not add a second --env-file when the caller passed one", () => {
    const argv = run(["--prod", "--env-file", "custom.env", "config"], {
      EZ_COMPOSE_ENV_FILE: ENV_FILE,
    }).invocation?.argv;
    expect(argv).toBe("compose --env-file custom.env config");
  });

  test("refuses to run when the env file is missing, naming the fix", () => {
    const result = run(["--prod", "up", "-d"], {
      EZ_COMPOSE_ENV_FILE: join(SANDBOX, "does-not-exist.env"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.invocation).toBeNull();
    expect(result.stderr).toContain("cp .env.prod.example .env.prod");
  });

  test("every prod file it layers exists in the repo", async () => {
    const layered =
      run(["--prod", "up", "-d"], { EZ_COMPOSE_ENV_FILE: ENV_FILE }).invocation?.composeFile.split(
        ":",
      ) ?? [];
    expect(layered.length).toBeGreaterThan(0);
    for (const file of layered) {
      expect(await Bun.file(join(REPO_ROOT, file)).exists(), `${file} is missing`).toBe(true);
    }
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

  test("names BOTH Compose spellings when neither is on PATH", () => {
    // The wrapper accepts `docker compose` or the standalone `docker-compose`.
    // A Podman-only Mac (`brew install docker-compose`) has no `docker`
    // executable at all, so an error naming only that one is a dead end.
    const result = run(["up", "-d"], { PATH: BIN_NO_DOCKER });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Docker Compose CLI");
    expect(result.stderr).toContain("brew install docker-compose");
    expect(result.invocation).toBeNull();
  });
});
