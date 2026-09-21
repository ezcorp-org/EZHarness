#!/usr/bin/env bun
/**
 * Testable pieces of scripts/verify-factory-storage.ts's CLI surface: the
 * --restart-stores flag, its help text, the message printed when the flag is
 * omitted, and the compose commands for the restart-persistence leg. Kept
 * here (not inline in the script) so bun:test can exercise every branch
 * without spawning real S3/Compose processes or requiring
 * EZCORP_FACTORY_STORAGE_SECRETS_DIR — the script itself stays a thin runner
 * over these pure functions plus scripts/lib/container-engine.ts.
 */
import type { ContainerEngine } from "./container-engine.ts";

export const RESTART_STORES_FLAG = "--restart-stores";

export const HELP_TEXT = `Usage: bun scripts/verify-factory-storage.ts [${RESTART_STORES_FLAG}]

Verifies the local factory S3 conformance: ten tenant identities across the
ordinary and archive storage services, cross-tenant denials, conditional
writes, multipart uploads, and version reads. This part is read-only against
the shared stores.

  ${RESTART_STORES_FLAG}   Also run the restart-persistence leg, which proves an
                      object survives a service restart. This flag RESTARTS
                      BOTH shared SeaweedFS stores (factory-storage-ordinary
                      and factory-storage-archive) — coordinator-only on a
                      shared host, see docs/factory-local-storage.md. Without
                      this flag every other check still runs and the restart
                      leg is skipped.

  -h, --help          Print this message and exit.

Requires EZCORP_FACTORY_STORAGE_SECRETS_DIR (see
scripts/setup-factory-storage.sh).`;

export const RESTART_LEG_SKIPPED_MESSAGE =
  `Restart-persistence leg skipped (pass ${RESTART_STORES_FLAG} to run it; that flag RESTARTS BOTH shared SeaweedFS stores — coordinator-only on a shared host, see docs/factory-local-storage.md).`;

export interface VerifyFactoryStorageArgs {
  readonly restartStores: boolean;
  readonly help: boolean;
}

export class UnknownArgumentError extends Error {
  constructor(arg: string) {
    super(`Unknown argument: ${arg}\n\n${HELP_TEXT}`);
    this.name = "UnknownArgumentError";
  }
}

/** Parses argv (no binary/script path entries — pass `Bun.argv.slice(2)`). */
export function parseArgs(argv: readonly string[]): VerifyFactoryStorageArgs {
  let restartStores = false;
  let help = false;
  for (const arg of argv) {
    if (arg === RESTART_STORES_FLAG) restartStores = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new UnknownArgumentError(arg);
  }
  return { restartStores, help };
}

/** Both shared SeaweedFS services the restart-persistence leg restarts. */
export const RESTART_LEG_SERVICES = ["factory-storage-ordinary", "factory-storage-archive"] as const;

export interface ComposeInvocation {
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface RestartLegPlanInputs {
  readonly engine: ContainerEngine;
  readonly dockerHost: string | undefined;
  readonly projectName: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * Builds the two `docker compose` invocations (stop, then up -d --wait)
 * for the restart-persistence leg, against BOTH shared stores. Compose is
 * always the `docker compose` client — `engine` only affects whether
 * DOCKER_HOST is forwarded (set by the caller via resolveComposeDockerHost
 * when `engine` is `podman`); `projectName` must match
 * scripts/setup-factory-storage.sh's `ezcorp-factory-storage-${UID}` so the
 * two tools address the same Compose project regardless of which resolved
 * the engine.
 */
export function restartLegInvocations(inputs: RestartLegPlanInputs): readonly [ComposeInvocation, ComposeInvocation] {
  const composeArgs = ["compose", "-f", "compose.factory-storage.local.yml", "--profile", "factory-storage"];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs.baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  env.COMPOSE_PROJECT_NAME = inputs.projectName;
  if (inputs.dockerHost !== undefined) env.DOCKER_HOST = inputs.dockerHost;
  return [
    { cmd: ["docker", ...composeArgs, "stop", ...RESTART_LEG_SERVICES], env },
    { cmd: ["docker", ...composeArgs, "up", "-d", "--wait", ...RESTART_LEG_SERVICES], env },
  ];
}
