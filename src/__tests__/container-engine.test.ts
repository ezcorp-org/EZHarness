import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Holds `scripts/lib/container-engine.sh` — the one rule for which engine a
 * script drives — and holds the scripts that depend on it against it.
 *
 * ## The bug this exists to prevent
 *
 * GitHub's Ubuntu runners ship BOTH podman and docker. release-image.yml
 * builds `ezcorp:verify` with Docker and then runs the verify scripts against
 * it. A resolver that simply preferred podman would, in CI, point those
 * scripts at an empty podman store and fail the release gate on an image
 * that exists — in the other engine. The CI branch of the rule is therefore
 * the load-bearing one, and it is the one a "make podman the default" change
 * is most tempted to drop.
 *
 * ## Why this is not a tautology
 *
 * The rule is exercised, not read: each case runs the real lib under
 * Bash with a $PATH containing only the stub engines that case needs,
 * and reads back which one it chose. The second suite reads the converted
 * scripts from disk and asserts the shape that makes the rule apply to them
 * at all — they source the lib, and no engine call bypasses "$ENGINE".
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LIB = join(REPO_ROOT, "scripts", "lib", "container-engine.sh");
const BASH = Bun.which("bash") ?? (() => {
  throw new Error("container-engine tests require bash on PATH");
})();
const SANDBOX = mkdtempSync(join(tmpdir(), "container-engine-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** A $PATH dir holding only the named engines plus deterministic shell utilities. */
function pathWith(...engines: string[]): string {
  const dir = mkdtempSync(join(SANDBOX, "bin-"));
  writeFileSync(join(dir, "id"), "#!/bin/sh\n[ \"$1\" = -u ] && printf '1000\\n'\n");
  writeFileSync(join(dir, "head"), "#!/bin/sh\nIFS= read -r line && printf '%s\\n' \"$line\"\n");
  chmodSync(join(dir, "id"), 0o755);
  chmodSync(join(dir, "head"), 0o755);
  for (const e of engines) {
    writeFileSync(join(dir, e), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, e), 0o755);
  }
  return dir;
}

function resolve(path: string, env: Record<string, string> = {}): { engine: string; exitCode: number; stderr: string } {
  // A clean environment: only what the case sets. `CI` in particular must not
  // leak in from the machine running this suite.
  const proc = Bun.spawnSync({
    cmd: [BASH, "-c", `source "${LIB}" && printf '%s' "$ENGINE"`],
    env: { PATH: path, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { engine: proc.stdout.toString(), exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

describe("container-engine.sh — the resolution rule", () => {
  test("developer machine with both: podman", () => {
    expect(resolve(pathWith("podman", "docker")).engine).toBe("podman");
  });

  test("developer machine with docker only: docker", () => {
    expect(resolve(pathWith("docker")).engine).toBe("docker");
  });

  test("CI with both: docker — the image CI just built lives there", () => {
    expect(resolve(pathWith("podman", "docker"), { CI: "true" }).engine).toBe("docker");
  });

  test("CI with podman only: podman", () => {
    expect(resolve(pathWith("podman"), { CI: "true" }).engine).toBe("podman");
  });

  test("an explicit EZCORP_CONTAINER_ENGINE wins over both rules", () => {
    expect(resolve(pathWith("podman", "docker"), { CI: "true", EZCORP_CONTAINER_ENGINE: "podman" }).engine).toBe("podman");
    expect(resolve(pathWith("podman", "docker"), { EZCORP_CONTAINER_ENGINE: "docker" }).engine).toBe("docker");
  });

  test("an explicit engine that is not installed is an error, not a silent fallback", () => {
    const r = resolve(pathWith("docker"), { EZCORP_CONTAINER_ENGINE: "podman" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("no such executable");
  });

  test("an explicit engine that is not a known name is rejected", () => {
    const r = resolve(pathWith("podman"), { EZCORP_CONTAINER_ENGINE: "containerd" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("must be 'podman' or 'docker'");
  });

  test("neither installed: names both and how to get one", () => {
    const r = resolve(pathWith());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("brew install podman");
    expect(r.stderr).toContain("EZCORP_CONTAINER_ENGINE");
  });
});

const CONVERTED = [
  "scripts/verify-docker-image.sh",
  "scripts/verify-dev-image-provenance.sh",
  "scripts/verify-docker-rollback.sh",
  "scripts/verify-docker-upgrade.sh",
  "scripts/lib/build-archived-image.sh",
  "scripts/verify-production-image-lifecycle.sh",
];
// scripts/test-linux.sh keeps its own inline rule on purpose: it builds and
// runs its OWN image in whichever engine it picks, so it has no cross-engine
// store hazard and the CI-prefers-Docker branch would be wrong for it. Its
// suite also copies it into a bare fixture and runs it standalone, which a
// `source` of this lib would break. It is still held to "$ENGINE" below.
const ENGINE_ONLY = ["scripts/test-linux.sh"];
// A `docker <subcommand>` in command position on a non-comment line. The
// negative lookbehind keeps prose like "the docker daemon", paths, and the
// fully-qualified `docker.io/...` image references out of it.
const BARE_DOCKER = /(?<![\w\-./`'"])docker (compose|rm|rmi|build|inspect|run|logs|exec|volume|restart|image|images|stop|start|container|info|ps|pull|tag|save|load)\b/;

/** An empty runtime folder: the Linux socket probe looks here instead of
 * /run/user/<uid>, so a developer host's own rootless Podman socket never
 * answers for a case (the `id` stub prints 1000, a real uid on most hosts). */
const NO_SOCKET_RUNTIME = mkdtempSync(join(SANDBOX, "runtime-"));

function resolveCompose(path: string, env: Record<string, string> = {}, strict = false): { compose: string; dockerHost: string; exitCode: number; stderr: string } {
  // strict: the caller runs under `set -euo pipefail` and calls resolve_compose
  // as a plain statement, as verify-production-image-lifecycle.sh does.
  const script = strict
    ? `set -euo pipefail; source "${LIB}"; resolve_compose; printf '%s\\n%s' "\${COMPOSE[*]}" "\${DOCKER_HOST:-}"`
    : `source "${LIB}" && resolve_compose && printf '%s\\n%s' "\${COMPOSE[*]}" "\${DOCKER_HOST:-}"`;
  const proc = Bun.spawnSync({
    cmd: [BASH, "-c", script],
    env: { PATH: path, EZCORP_PODMAN_RUNTIME_DIR: NO_SOCKET_RUNTIME, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [compose = "", dockerHost = ""] = proc.stdout.toString().split("\n");
  return { compose, dockerHost, exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

/** A $PATH dir with a `docker` whose `compose version` succeeds or fails. */
function pathWithDockerCompose(pluginWorks: boolean, ...others: string[]): string {
  const dir = pathWith(...others);
  writeFileSync(join(dir, "docker"), `#!/bin/sh\n[ "$1 $2" = "compose version" ] && exit ${pluginWorks ? 0 : 1}\nexit 0\n`);
  chmodSync(join(dir, "docker"), 0o755);
  return dir;
}

describe("container-engine.sh — resolve_compose", () => {
  test("uses the docker compose plugin when it works", () => {
    const r = resolveCompose(pathWithDockerCompose(true), { EZCORP_CONTAINER_ENGINE: "docker" });
    expect(r.exitCode).toBe(0);
    expect(r.compose).toBe("docker compose");
  });

  test("falls back to the standalone docker-compose binary", () => {
    // A Podman-only Mac after `brew install docker-compose`: no `docker` at all.
    const r = resolveCompose(pathWith("podman", "docker-compose"), { DOCKER_HOST: "unix:///preset.sock" });
    expect(r.exitCode).toBe(0);
    expect(r.compose).toBe("docker-compose");
  });

  test("under podman, honours an already-exported DOCKER_HOST untouched", () => {
    const r = resolveCompose(pathWith("podman", "docker-compose"), { DOCKER_HOST: "unix:///preset.sock" });
    expect(r.dockerHost).toBe("unix:///preset.sock");
  });

  test("under podman with no DOCKER_HOST, finds the machine socket via podman machine inspect", () => {
    const sock = join(SANDBOX, "machine.sock");
    const server = Bun.listen({ unix: sock, socket: { data() {} } });
    try {
      const dir = pathWith("docker-compose");
      writeFileSync(join(dir, "podman"), `#!/bin/sh\n[ "$1 $2" = "machine inspect" ] && echo "${sock}"\nexit 0\n`);
      chmodSync(join(dir, "podman"), 0o755);
      const r = resolveCompose(dir, { EZCORP_CONTAINER_ENGINE: "podman" });
      expect(r.exitCode).toBe(0);
      expect(r.dockerHost).toBe(`unix://${sock}`);
    } finally {
      server.stop(true);
    }
  });

  test("under podman with no DOCKER_HOST, uses the rootless socket in the runtime folder", () => {
    const runtime = mkdtempSync(join(SANDBOX, "runtime-"));
    mkdirSync(join(runtime, "podman"));
    const sock = join(runtime, "podman", "podman.sock");
    const server = Bun.listen({ unix: sock, socket: { data() {} } });
    try {
      const dir = pathWith("podman", "docker-compose");
      writeFileSync(join(dir, "id"), `#!/bin/sh\necho called > "${dir}/id.called"\nprintf '1000\\n'\n`);
      const r = resolveCompose(dir, { EZCORP_PODMAN_RUNTIME_DIR: runtime });
      expect(r.exitCode).toBe(0);
      expect(r.dockerHost).toBe(`unix://${sock}`);
      // The override replaces the uid lookup; it does not run beside it.
      expect(existsSync(join(dir, "id.called"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("without the runtime override, the socket is looked for under /run/user/<id -u>", () => {
    const dir = pathWith("podman", "docker-compose");
    writeFileSync(join(dir, "id"), `#!/bin/sh\n[ "$1" = -u ] && echo called > "${dir}/id.called"\nprintf '1000\\n'\n`);
    // Empty is unset for `${VAR:-default}`; the outcome then depends on the
    // host's real /run/user, so only the lookup itself is asserted.
    resolveCompose(dir, { EZCORP_PODMAN_RUNTIME_DIR: "" });
    expect(existsSync(join(dir, "id.called"))).toBe(true);
  });

  test("under podman with no socket anywhere: an error naming both fixes, not a Docker daemon", () => {
    const dir = pathWith("docker-compose");
    writeFileSync(join(dir, "podman"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "podman"), 0o755);
    const r = resolveCompose(dir, { EZCORP_CONTAINER_ENGINE: "podman" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("podman.socket");
    expect(r.stderr).toContain("podman machine start");
  });

  test("under a strict caller, a failing podman machine lookup still names both fixes", () => {
    // Native Linux Podman with no machine: `podman machine inspect` exits 125.
    const dir = pathWith("docker-compose");
    writeFileSync(join(dir, "podman"), "#!/bin/sh\nexit 125\n");
    chmodSync(join(dir, "podman"), 0o755);
    const r = resolveCompose(dir, { EZCORP_CONTAINER_ENGINE: "podman" }, true);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("podman.socket");
    expect(r.stderr).toContain("podman machine start");
  });

  test("under docker, never touches DOCKER_HOST", () => {
    const r = resolveCompose(pathWithDockerCompose(true), { EZCORP_CONTAINER_ENGINE: "docker" });
    expect(r.dockerHost).toBe("");
  });

  test("no Compose CLI at all: names both spellings", () => {
    const r = resolveCompose(pathWith("podman"), { EZCORP_CONTAINER_ENGINE: "podman", DOCKER_HOST: "unix:///x" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("brew install docker-compose");
  });
});

describe("the converted scripts", () => {
  for (const rel of CONVERTED) {
    test(`${rel} sources the shared resolver`, () => {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(text).toMatch(/source .*container-engine\.sh/);
    });
  }

  for (const rel of [...CONVERTED, ...ENGINE_ONLY]) {
    test(`${rel} makes every engine call through "$ENGINE"`, () => {
      const offenders = readFileSync(join(REPO_ROOT, rel), "utf8")
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => !line.trimStart().startsWith("#") && BARE_DOCKER.test(line));
      expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
    });
  }
});
