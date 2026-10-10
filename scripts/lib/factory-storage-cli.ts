#!/usr/bin/env bun
/**
 * Shared CLI/compose pieces for the factory-storage verify scripts
 * (scripts/verify-factory-storage.ts, scripts/verify-factory-archive-writer.ts).
 * Both scripts gate a leg that mutates the shared SeaweedFS containers behind
 * the same --restart-stores flag and the same safe default (every other
 * check still runs; the gated leg prints one skip line and is not run; exit
 * 0). That parsing, and the `docker compose` stop/up-d---wait invocation
 * shape, is identical between them — kept here once so the two scripts
 * cannot drift on the flag name or the compose-invocation shape. Each
 * script's own scripts/lib/*-cli.ts module keeps its help text, skip-line
 * wording, and which services it restarts (both stores vs. one), since those
 * differ per script.
 */
export const RESTART_STORES_FLAG = "--restart-stores";

export interface RestartFlagArgs {
  readonly restartStores: boolean;
  readonly help: boolean;
}

export class UnknownArgumentError extends Error {
  constructor(arg: string, helpText: string) {
    super(`Unknown argument: ${arg}\n\n${helpText}`);
    this.name = "UnknownArgumentError";
  }
}

/**
 * Parses argv (no binary/script path entries — pass `Bun.argv.slice(2)`).
 * `helpText` is only used to build the unknown-argument error message, so
 * each caller's own help text is what a typo actually sees.
 */
export function parseRestartFlagArgs(argv: readonly string[], helpText: string): RestartFlagArgs {
  let restartStores = false;
  let help = false;
  for (const arg of argv) {
    if (arg === RESTART_STORES_FLAG) restartStores = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new UnknownArgumentError(arg, helpText);
  }
  return { restartStores, help };
}

export interface ComposeInvocation {
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface ComposeEnvInputs {
  /** Already-resolved DOCKER_HOST (e.g. via resolveComposeDockerHost), or undefined to forward none. */
  readonly dockerHost: string | undefined;
  readonly projectName: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * Builds the env for a `docker compose` invocation against the local
 * factory-storage project: copies over `baseEnv` (dropping undefined-valued
 * entries), sets COMPOSE_PROJECT_NAME, and forwards DOCKER_HOST only when
 * the caller resolved one (the Podman case).
 */
export function composeEnv({ dockerHost, projectName, baseEnv }: ComposeEnvInputs): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  env.COMPOSE_PROJECT_NAME = projectName;
  if (dockerHost !== undefined) env.DOCKER_HOST = dockerHost;
  return env;
}

const COMPOSE_BASE_ARGS = ["compose", "-f", "compose.factory-storage.local.yml", "--profile", "factory-storage"] as const;

/**
 * Builds a stop-then-`up -d --wait` pair of `docker compose` invocations
 * against exactly the named services. Compose is always the `docker compose`
 * client — the resolved engine only affects `envInputs.dockerHost` (set by
 * the caller via resolveComposeDockerHost when driving Podman).
 */
export function stopThenUpInvocations(services: readonly string[], envInputs: ComposeEnvInputs): readonly [ComposeInvocation, ComposeInvocation] {
  const env = composeEnv(envInputs);
  return [
    { cmd: ["docker", ...COMPOSE_BASE_ARGS, "stop", ...services], env },
    { cmd: ["docker", ...COMPOSE_BASE_ARGS, "up", "-d", "--wait", ...services], env },
  ];
}
