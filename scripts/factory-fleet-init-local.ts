#!/usr/bin/env bun
/**
 * Write a local fleet's settings for this host, and create its control database.
 *
 *   FACTORY_TEST_POSTGRES_URL=... EZCORP_FACTORY_STORAGE_SECRETS_DIR=... \
 *     bun scripts/factory-fleet-init-local.ts --fleet w16 --root $HOME/.ezcorp-factory-w16 \
 *       --image localhost/ezcorp-factory@sha256:... --revision <40-hex> [--port-base 31000]
 *
 * The work is `writeFactoryLocalFleet` in src/factory/provisioning/fleet-cli.ts.
 * The shared stores are used as they are: nothing here starts, stops, or
 * reconfigures them.
 */
import { resolve } from "node:path";
import { referenceCodeV1 } from "@ezcorp/factory-sdk";
import { fileURLToPath } from "node:url";
import { writeFactoryLocalFleet, type FactoryLocalFleetOptions } from "../src/factory/provisioning/fleet-cli";

/**
 * The runners this local fleet declares, all in the one `cpu` class, so they share one allocation (the
 * startup parser refuses a class whose profiles disagree). The budget is sized for the reference-code
 * slugify task (W4H-26): the W09b guest the full-stack proof built and pinned, and the two
 * reference.code.v1 task runners a guest executes today, named exactly as the definition names them.
 */
const CPU_ALLOCATION = { resources: { cpu: 1 }, memoryBytes: 1_073_741_824, budget: { costMicros: "1000000", tokens: 50_000, computeMs: 600_000 } };
/** The reference.code.v1 task runners a guest executes today (W4H-26 D7); the others wait for the later package. */
const REFERENCE_GUEST_EXPORTS: readonly string[] = ["snapshotRepository", "freezeGitTree"];
const referenceRunners = referenceCodeV1.graph.nodes.flatMap((node) => node.kind === "task" && REFERENCE_GUEST_EXPORTS.includes(node.runner.export) ? [{ ...node.runner }] : []);
export const LOCAL_RUNNER_PROFILES: FactoryLocalFleetOptions["runnerProfiles"] = Object.freeze({
  brokerAudience: "factory-gateway",
  profiles: [
    { package: "@ezcorp/w09b-guest", manifestName: "w09b-guest", version: "1.0.0", digest: "sha256:c429b84ec4dbed709188115598db538a06f07887d9b900bd8cdc7c188c531121", export: "run" },
    ...referenceRunners,
  ].map((runner) => ({ runner, resourceClass: "cpu", allocation: CPU_ALLOCATION, allowedCapabilities: [] })),
});

export function factoryFleetInitOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, bun: string): FactoryLocalFleetOptions {
  const flag = (name: string, fallback?: string): string => {
    const index = argv.indexOf(name);
    const value = index === -1 ? fallback : argv[index + 1];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  if (!env.FACTORY_TEST_POSTGRES_URL || !env.EZCORP_FACTORY_STORAGE_SECRETS_DIR) throw new Error("FACTORY_TEST_POSTGRES_URL and EZCORP_FACTORY_STORAGE_SECRETS_DIR are required");
  return {
    fleetId: flag("--fleet"), root: resolve(flag("--root")), image: flag("--image"), revision: flag("--revision"), portBase: Number(flag("--port-base", "31000")),
    adminUrl: env.FACTORY_TEST_POSTGRES_URL, storageSecretsDirectory: env.EZCORP_FACTORY_STORAGE_SECRETS_DIR,
    releaseDirectory: resolve(import.meta.dir, ".."), bun, runnerProfiles: LOCAL_RUNNER_PROFILES,
  };
}

export async function startFactoryFleetInit(argv: readonly string[], moduleUrl: string, write: typeof writeFactoryLocalFleet = writeFactoryLocalFleet): Promise<string | undefined> {
  if (!argv[1] || resolve(argv[1]) !== fileURLToPath(moduleUrl)) return undefined;
  const { settingsPath } = await write(factoryFleetInitOptions(argv, process.env, process.execPath));
  return settingsPath;
}

void startFactoryFleetInit(process.argv, import.meta.url).then((path) => { if (path) console.log(JSON.stringify({ settings: path })); });
