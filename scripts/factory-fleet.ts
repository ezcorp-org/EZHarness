#!/usr/bin/env bun
/**
 * The operator's entry to one factory fleet on the self-hosted Compose profile.
 *
 *   bun scripts/factory-fleet.ts <fleet.json> platform
 *   bun scripts/factory-fleet.ts <fleet.json> provision <tenant>... [--through <step>] [--admin-email <email>]
 *   bun scripts/factory-fleet.ts <fleet.json> observe <tenant>...
 *   bun scripts/factory-fleet.ts <fleet.json> rotate <tenant> <step>
 *   bun scripts/factory-fleet.ts <fleet.json> teardown <tenant> --reason <text>
 *   bun scripts/factory-fleet.ts <fleet.json> purge <tenant> --approval <approval ID> --reason <text>
 *   bun scripts/factory-fleet.ts <fleet.json> upgrade register|wave|abandon|retire ...
 *   bun scripts/factory-fleet.ts <fleet.json> status [tenant]
 *
 * The commands live in src/factory/provisioning/fleet-cli.ts. This file only
 * resolves the container engine and the Compose client through
 * scripts/lib/container-engine.ts, the repository's one engine rule.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasCommandOnPath, isUnixSocket, resolveComposeDockerHost, resolveEngine } from "./lib/container-engine";
import { runFactoryFleetMain } from "../src/factory/provisioning/fleet-cli";
import type { FactoryComposeCommand } from "../src/factory/provisioning/compose-profile";

export function factoryFleetComposeCommand(env: Readonly<Record<string, string | undefined>>, uid: number, hasCommand: (name: string) => boolean = hasCommandOnPath, socketExists: (path: string) => boolean = isUnixSocket): FactoryComposeCommand {
  const engine = resolveEngine({ EZCORP_CONTAINER_ENGINE: env.EZCORP_CONTAINER_ENGINE, CI: env.CI }, hasCommand);
  const dockerHost = resolveComposeDockerHost(engine, { DOCKER_HOST: env.DOCKER_HOST }, uid, socketExists);
  return { argv: ["docker", "compose"], env: dockerHost ? { DOCKER_HOST: dockerHost } : {} };
}

export function startFactoryFleetCli(argv: readonly string[], moduleUrl: string, run: typeof runFactoryFleetMain = runFactoryFleetMain): Promise<void> | undefined {
  if (!argv[1] || resolve(argv[1]) !== fileURLToPath(moduleUrl)) return undefined;
  return run(argv.slice(2), factoryFleetComposeCommand(process.env, process.getuid!()));
}

void startFactoryFleetCli(process.argv, import.meta.url);
