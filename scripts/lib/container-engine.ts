#!/usr/bin/env bun
/**
 * TypeScript port of scripts/lib/container-engine.sh's engine-resolution
 * rule, for Bun scripts that spawn a container/Compose client directly
 * instead of sourcing bash (scripts/verify-factory-storage.ts is the first
 * consumer). Keep the rule text below byte-for-byte in step with the comment
 * at the top of scripts/lib/container-engine.sh — src/__tests__/container-engine.test.ts
 * holds the shell rule; scripts/lib/container-engine.test.ts proves this file
 * agrees with it on every branch.
 *
 * Exports resolveEngine() as `podman` or `docker`. The rule, in order:
 *
 *   1. EZCORP_CONTAINER_ENGINE, when set, wins — the operator said so.
 *   2. Under CI, Docker when it is present. GitHub's Ubuntu runners ship BOTH
 *      engines, and release-image.yml builds `ezcorp:verify` with Docker
 *      (build-push-action, load: true) before running the verify scripts
 *      against it. A "prefer Podman" rule there would point those scripts at
 *      an empty Podman store and fail the release gate on an image that
 *      exists — in the other engine.
 *   3. Otherwise Podman when it is present: it is the engine this project
 *      targets, and on a developer machine it is the one the deployment docs
 *      and `bun run podman` already assume.
 *   4. Otherwise Docker.
 *
 * Also exports resolveComposeDockerHost(): the DOCKER_HOST a `docker compose`
 * client needs to reach Podman's rootless socket. Compose is always a Docker
 * CLI client — under Podman it is pointed at the Podman socket through
 * DOCKER_HOST, and no Docker daemon is involved. An already-exported
 * DOCKER_HOST is honoured untouched. This is narrower than the shell
 * resolver's `resolve_compose`: it has no macOS `podman machine inspect`
 * fallback, because it exists for the Linux hosts this repository's Bun
 * tooling runs on. When the rootless socket is absent it reports a named
 * error (PodmanSocketNotFoundError) rather than guessing another path.
 */
import { statSync } from "node:fs";

export type ContainerEngine = "podman" | "docker";

export class InvalidContainerEngineError extends Error {
  constructor(value: string) {
    super(`EZCORP_CONTAINER_ENGINE must be 'podman' or 'docker' (got '${value}')`);
    this.name = "InvalidContainerEngineError";
  }
}

export class ContainerEngineNotFoundError extends Error {
  constructor(engine: string) {
    super(`EZCORP_CONTAINER_ENGINE=${engine} but no such executable on $PATH`);
    this.name = "ContainerEngineNotFoundError";
  }
}

export class NoContainerEngineError extends Error {
  constructor() {
    super(
      [
        "neither podman nor docker is on $PATH.",
        "  macOS:  brew install podman && podman machine init && podman machine start",
        "  Linux:  install podman (or docker) from your distro",
        "  or name one explicitly: EZCORP_CONTAINER_ENGINE=podman|docker",
      ].join("\n"),
    );
    this.name = "NoContainerEngineError";
  }
}

export class PodmanSocketNotFoundError extends Error {
  constructor(socketPath: string) {
    super(
      [
        `no Podman socket was found for Compose to use (looked for ${socketPath}).`,
        "  Linux:  systemctl --user enable --now podman.socket",
        "  or export DOCKER_HOST=unix:///path/to/podman.sock",
      ].join("\n"),
    );
    this.name = "PodmanSocketNotFoundError";
  }
}

export interface EngineEnv {
  readonly EZCORP_CONTAINER_ENGINE?: string | undefined;
  readonly CI?: string | undefined;
}

/**
 * Resolves which container engine to drive — the same rule as
 * scripts/lib/container-engine.sh. `hasCommand` is injected so tests never
 * depend on the real machine's installed engines.
 */
export function resolveEngine(env: EngineEnv, hasCommand: (name: string) => boolean): ContainerEngine {
  const explicit = env.EZCORP_CONTAINER_ENGINE;
  if (explicit !== undefined && explicit !== "") {
    if (explicit !== "podman" && explicit !== "docker") throw new InvalidContainerEngineError(explicit);
    if (!hasCommand(explicit)) throw new ContainerEngineNotFoundError(explicit);
    return explicit;
  }
  if (env.CI !== undefined && env.CI !== "" && hasCommand("docker")) return "docker";
  if (hasCommand("podman")) return "podman";
  if (hasCommand("docker")) return "docker";
  throw new NoContainerEngineError();
}

export interface DockerHostEnv {
  readonly DOCKER_HOST?: string | undefined;
}

/**
 * DOCKER_HOST for a `docker compose` client under the resolved engine.
 * Docker needs none — Compose already talks to the Docker daemon directly, so
 * this returns whatever (if anything) the caller already exported. Under
 * Podman: an already-exported DOCKER_HOST is honoured untouched; otherwise
 * the rootless user socket at /run/user/<uid>/podman/podman.sock. When that
 * socket does not exist this throws PodmanSocketNotFoundError instead of
 * guessing another location. `socketExists` is injected so tests never touch
 * the real filesystem.
 */
export function resolveComposeDockerHost(
  engine: ContainerEngine,
  env: DockerHostEnv,
  uid: number,
  socketExists: (path: string) => boolean,
): string | undefined {
  if (env.DOCKER_HOST !== undefined && env.DOCKER_HOST !== "") return env.DOCKER_HOST;
  if (engine === "docker") return undefined;
  const socketPath = `/run/user/${uid}/podman/podman.sock`;
  if (!socketExists(socketPath)) throw new PodmanSocketNotFoundError(socketPath);
  return `unix://${socketPath}`;
}

/** Production `hasCommand`: a real $PATH lookup via Bun.which. */
export function hasCommandOnPath(name: string): boolean {
  return Bun.which(name) !== null;
}

/** Production `socketExists`: true only for an actual Unix socket file. */
export function isUnixSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}
