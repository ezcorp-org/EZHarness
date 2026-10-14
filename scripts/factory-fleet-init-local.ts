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
import { fileURLToPath } from "node:url";
import { referenceImageV1 } from "@ezcorp/factory-sdk";
import { FACTORY_INSTALLATION_S3_RELEASE_DESTINATION } from "../src/factory/provisioning/deployment";
import { writeFactoryLocalFleet, type FactoryLocalFleetOptions } from "../src/factory/provisioning/fleet-cli";

/** The runner this local fleet declares: the W09b guest the full-stack proof built and pinned. */
export const LOCAL_RUNNER_PROFILES: FactoryLocalFleetOptions["runnerProfiles"] = Object.freeze({
  brokerAudience: "factory-gateway",
  profiles: [{
    runner: { package: "@ezcorp/w09b-guest", manifestName: "w09b-guest", version: "1.0.0", digest: "sha256:c429b84ec4dbed709188115598db538a06f07887d9b900bd8cdc7c188c531121", export: "run" },
    resourceClass: "cpu",
    allocation: { resources: { cpu: 1 }, memoryBytes: 1_073_741_824, budget: { costMicros: "1000000", tokens: 1_000, computeMs: 600_000 } },
    allowedCapabilities: [],
  }],
});

type ReleaseAdapter = NonNullable<FactoryLocalFleetOptions["release"]>["profiles"][number]["adapter"];

/**
 * The reference definitions' adapter digests are synthetic: one hex character repeated (factory-sdk
 * references.ts `runner()`). No published package has such a digest, so a profile naming one could
 * never install its adapter.
 */
const PLACEHOLDER_DIGEST = /^sha256:([0-9a-f])\1{63}$/;

/**
 * The release profile a local fleet declares for each S3 publication adapter the reference definitions
 * name, publishing to each installation's own store; an adapter whose digest is the definition's
 * placeholder is refused by name instead (W4H-27 N3), so no fleet declares a profile nothing can install.
 */
export function localFleetRelease(adapters: readonly ReleaseAdapter[]): { readonly release?: NonNullable<FactoryLocalFleetOptions["release"]>; readonly refused: readonly string[] } {
  const usable = adapters.filter((adapter) => !PLACEHOLDER_DIGEST.test(adapter.digest));
  const refused = adapters.filter((adapter) => PLACEHOLDER_DIGEST.test(adapter.digest)).map((adapter) => `factory_release_adapter_unpublished: ${adapter.package}@${adapter.version}:${adapter.export} names the reference definition's placeholder digest; no published package has it, so no release profile is declared for it`);
  if (usable.length === 0) return { refused };
  return { release: { profiles: usable.map((adapter) => ({ adapter, action: "factory.release.publish", destination: FACTORY_INSTALLATION_S3_RELEASE_DESTINATION, estimatedSpendMicros: 1_000 })) }, refused };
}

/** reference.image.v1's S3 publication adapter: the five fields a release profile's adapter reference has (the node also carries its configuration digest). */
export const LOCAL_RELEASE = localFleetRelease(referenceImageV1.graph.nodes.flatMap((node) => node.kind === "release"
  ? [{ package: node.adapter.package, manifestName: node.adapter.manifestName, version: node.adapter.version, digest: node.adapter.digest, export: node.adapter.export }]
  : []));

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
    releaseDirectory: resolve(import.meta.dir, ".."), bun, runnerProfiles: LOCAL_RUNNER_PROFILES, ...(LOCAL_RELEASE.release === undefined ? {} : { release: LOCAL_RELEASE.release }),
  };
}

export async function startFactoryFleetInit(argv: readonly string[], moduleUrl: string, write: typeof writeFactoryLocalFleet = writeFactoryLocalFleet): Promise<string | undefined> {
  if (!argv[1] || resolve(argv[1]) !== fileURLToPath(moduleUrl)) return undefined;
  const { settingsPath } = await write(factoryFleetInitOptions(argv, process.env, process.execPath));
  return settingsPath;
}

void startFactoryFleetInit(process.argv, import.meta.url).then((path) => { if (path) console.log(JSON.stringify({ settings: path, releaseRefused: LOCAL_RELEASE.refused })); });
