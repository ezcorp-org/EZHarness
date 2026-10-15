import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContainerEngineNotFoundError,
  hasCommandOnPath,
  InvalidContainerEngineError,
  isUnixSocket,
  NoContainerEngineError,
  PodmanSocketNotFoundError,
  resolveComposeDockerHost,
  resolveEngine,
} from "./container-engine.ts";

/**
 * Parity harness: this file's resolveEngine() must agree with
 * scripts/lib/container-engine.sh on every branch of the shared rule. Each
 * case builds a $PATH directory with only the stub engines it needs (a real
 * executable that exits 0), asks bash to source the shell lib against it, and
 * asks resolveEngine() the identical question via an injected hasCommand that
 * reads the same directory — so a change to one rule that the other missed
 * shows up as a mismatch, not as two suites that each pass in isolation.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHELL_LIB = join(REPO_ROOT, "scripts", "lib", "container-engine.sh");
const BASH = Bun.which("bash") ?? (() => {
  throw new Error("container-engine parity test requires bash on PATH");
})();

const SANDBOX = mkdtempSync(join(tmpdir(), "container-engine-ts-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

function pathWith(...engines: string[]): string {
  const dir = mkdtempSync(join(SANDBOX, "bin-"));
  for (const engine of engines) {
    const target = join(dir, engine);
    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    chmodSync(target, 0o755);
  }
  return dir;
}

function hasCommandIn(dir: string): (name: string) => boolean {
  return (name) => existsSync(join(dir, name));
}

function shellResolve(path: string, env: Record<string, string>): { engine: string; exitCode: number; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [BASH, "-c", `source "${SHELL_LIB}" && printf '%s' "$ENGINE"`],
    env: { PATH: path, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { engine: proc.stdout.toString(), exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

describe("resolveEngine — agrees with scripts/lib/container-engine.sh on every branch", () => {
  const cases: Array<{ name: string; engines: string[]; env: Record<string, string> }> = [
    { name: "developer machine with both installed resolves to podman", engines: ["podman", "docker"], env: {} },
    { name: "developer machine with docker only resolves to docker", engines: ["docker"], env: {} },
    { name: "CI with both installed resolves to docker", engines: ["podman", "docker"], env: { CI: "true" } },
    { name: "CI with podman only resolves to podman", engines: ["podman"], env: { CI: "true" } },
    { name: "explicit EZCORP_CONTAINER_ENGINE=podman wins over CI+both", engines: ["podman", "docker"], env: { CI: "true", EZCORP_CONTAINER_ENGINE: "podman" } },
    { name: "explicit EZCORP_CONTAINER_ENGINE=docker wins over the developer default", engines: ["podman", "docker"], env: { EZCORP_CONTAINER_ENGINE: "docker" } },
  ];

  for (const { name, engines, env } of cases) {
    test(name, () => {
      const dir = pathWith(...engines);
      const shellResult = shellResolve(dir, env);
      expect(shellResult.exitCode).toBe(0);
      expect(resolveEngine(env, hasCommandIn(dir))).toBe(shellResult.engine as "podman" | "docker");
    });
  }

  test("an explicit engine that is not installed is an error in both, not a silent fallback", () => {
    const dir = pathWith("docker");
    const env = { EZCORP_CONTAINER_ENGINE: "podman" };
    const shellResult = shellResolve(dir, env);
    expect(shellResult.exitCode).toBe(2);
    expect(shellResult.stderr).toContain("no such executable");
    expect(() => resolveEngine(env, hasCommandIn(dir))).toThrow(ContainerEngineNotFoundError);
    expect(() => resolveEngine(env, hasCommandIn(dir))).toThrow("EZCORP_CONTAINER_ENGINE=podman but no such executable on $PATH");
  });

  test("an explicit engine that is not a known name is rejected by both", () => {
    const dir = pathWith("podman");
    const env = { EZCORP_CONTAINER_ENGINE: "containerd" };
    const shellResult = shellResolve(dir, env);
    expect(shellResult.exitCode).toBe(2);
    expect(shellResult.stderr).toContain("must be 'podman' or 'docker'");
    expect(() => resolveEngine(env, hasCommandIn(dir))).toThrow(InvalidContainerEngineError);
    expect(() => resolveEngine(env, hasCommandIn(dir))).toThrow("EZCORP_CONTAINER_ENGINE must be 'podman' or 'docker' (got 'containerd')");
  });

  test("neither engine installed is an error in both, naming how to get one", () => {
    const dir = pathWith();
    const shellResult = shellResolve(dir, {});
    expect(shellResult.exitCode).toBe(2);
    expect(shellResult.stderr).toContain("neither podman nor docker");
    expect(() => resolveEngine({}, hasCommandIn(dir))).toThrow(NoContainerEngineError);
    expect(() => resolveEngine({}, hasCommandIn(dir))).toThrow("EZCORP_CONTAINER_ENGINE=podman|docker");
  });

  test("an empty-string EZCORP_CONTAINER_ENGINE is treated as unset, like the shell's -n test", () => {
    const dir = pathWith("docker");
    expect(resolveEngine({ EZCORP_CONTAINER_ENGINE: "" }, hasCommandIn(dir))).toBe("docker");
  });

  test("an empty-string CI is treated as unset, like the shell's -n test", () => {
    const dir = pathWith("podman", "docker");
    expect(resolveEngine({ CI: "" }, hasCommandIn(dir))).toBe("podman");
  });
});

describe("resolveComposeDockerHost", () => {
  test("docker: an unset DOCKER_HOST stays unset", () => {
    expect(resolveComposeDockerHost("docker", {}, 1000, () => true)).toBeUndefined();
  });

  test("docker: an already-exported DOCKER_HOST passes through untouched", () => {
    expect(resolveComposeDockerHost("docker", { DOCKER_HOST: "unix:///already.sock" }, 1000, () => {
      throw new Error("must not probe a socket when DOCKER_HOST is already set");
    })).toBe("unix:///already.sock");
  });

  test("podman: an already-exported DOCKER_HOST is honoured untouched, without probing a socket", () => {
    const socketExists = () => { throw new Error("must not probe when DOCKER_HOST is already set"); };
    expect(resolveComposeDockerHost("podman", { DOCKER_HOST: "unix:///preset.sock" }, 1000, socketExists)).toBe("unix:///preset.sock");
  });

  test("podman: no DOCKER_HOST, rootless socket present, builds the uid-scoped path", () => {
    let probed: string | undefined;
    const socketExists = (path: string) => { probed = path; return true; };
    expect(resolveComposeDockerHost("podman", {}, 1001, socketExists)).toBe("unix:///run/user/1001/podman/podman.sock");
    expect(probed).toBe("/run/user/1001/podman/podman.sock");
  });

  test("podman: no DOCKER_HOST, no socket, reports a named error rather than guessing", () => {
    expect(() => resolveComposeDockerHost("podman", {}, 1001, () => false)).toThrow(PodmanSocketNotFoundError);
    try {
      resolveComposeDockerHost("podman", {}, 1001, () => false);
      throw new Error("expected resolveComposeDockerHost to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PodmanSocketNotFoundError);
      expect((error as Error).message).toContain("/run/user/1001/podman/podman.sock");
      expect((error as Error).message).toContain("systemctl --user enable --now podman.socket");
      expect((error as Error).message).toContain("DOCKER_HOST=unix:///path/to/podman.sock");
    }
  });

  test("podman: an empty-string DOCKER_HOST is treated as unset", () => {
    expect(resolveComposeDockerHost("podman", { DOCKER_HOST: "" }, 1001, () => true)).toBe("unix:///run/user/1001/podman/podman.sock");
  });
});

describe("production adapters", () => {
  test("hasCommandOnPath finds a real executable and rejects a nonexistent one", () => {
    expect(hasCommandOnPath("bash")).toBe(true);
    expect(hasCommandOnPath("ezcorp-nonexistent-container-engine-probe")).toBe(false);
  });

  test("isUnixSocket is true for a real listening socket, false for a regular file and a missing path", () => {
    const dir = mkdtempSync(join(SANDBOX, "socket-"));
    const socketPath = join(dir, "probe.sock");
    const server = Bun.listen({ unix: socketPath, socket: { data() {} } });
    try {
      expect(isUnixSocket(socketPath)).toBe(true);
    } finally {
      server.stop(true);
    }

    const regularFile = join(dir, "not-a-socket");
    writeFileSync(regularFile, "plain file");
    expect(isUnixSocket(regularFile)).toBe(false);

    expect(isUnixSocket(join(dir, "missing"))).toBe(false);
  });
});
