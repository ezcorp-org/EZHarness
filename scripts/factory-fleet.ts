#!/usr/bin/env bun
/**
 * The operator's entry to one factory fleet: the self-hosted Compose profile.
 *
 *   bun scripts/factory-fleet.ts <fleet.json> platform            start the shared platform services
 *   bun scripts/factory-fleet.ts <fleet.json> provision <tenant>… [--through <step>]
 *   bun scripts/factory-fleet.ts <fleet.json> observe <tenant>…   record a completed human bootstrap
 *   bun scripts/factory-fleet.ts <fleet.json> rotate <tenant> <step>
 *   bun scripts/factory-fleet.ts <fleet.json> teardown <tenant> --reason <text>
 *   bun scripts/factory-fleet.ts <fleet.json> purge <tenant> --approved-by <ref> --reason <text>
 *   bun scripts/factory-fleet.ts <fleet.json> status [tenant]
 *
 * Every command prints one JSON document. No command prints a credential: the
 * status is the ledger's reference-only view.
 *
 * The container engine and the Compose client come from
 * `scripts/lib/container-engine.ts`, the repository's one engine rule.
 */
import { resolveComposeDockerHost, resolveEngine, hasCommandOnPath, isUnixSocket } from "./lib/container-engine";
import { composeFactoryProvisioner, loadFactoryFleetSettings } from "../src/factory/provisioning/fleet";
import { factoryIngressBootstrapObserver, factoryHttpsIngressProbe } from "../src/factory/provisioning/ingress";
import { startFactoryPlatform } from "../src/factory/provisioning/platform";
import { factorySpawnExecutor } from "../src/factory/provisioning/compose-profile";
import { factoryInstallationHostname } from "../src/factory/provisioning/fleet";
import { factoryDatabaseCensus } from "../src/factory/provisioning/census";
import { readFactoryPrivatePath } from "../src/factory/provisioning/secret-files";
import { FACTORY_PROVISIONING_STEP_NAMES, type FactoryProvisioningStepName } from "../src/factory/provisioning/steps";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

async function main(argv: string[]): Promise<unknown> {
  const [settingsPath, command, ...rest] = argv;
  if (!settingsPath || !command) throw new Error("usage: factory-fleet.ts <fleet.json> <platform|provision|observe|rotate|teardown|purge|status> ...");
  const settings = await loadFactoryFleetSettings(settingsPath);
  const engine = resolveEngine({ EZCORP_CONTAINER_ENGINE: process.env.EZCORP_CONTAINER_ENGINE, CI: process.env.CI }, hasCommandOnPath);
  const dockerHost = resolveComposeDockerHost(engine, { DOCKER_HOST: process.env.DOCKER_HOST }, process.getuid!(), isUnixSocket);
  const composeEnv: Record<string, string> = dockerHost ? { DOCKER_HOST: dockerHost } : {};
  const compose = { argv: ["docker", "compose"], env: composeEnv };
  const fleet = await composeFactoryProvisioner(settings, { compose, uid: process.getuid!(), gid: process.getgid!() });
  try {
    const args = [...rest];
    switch (command) {
      case "platform":
        await startFactoryPlatform({ fleetId: settings.fleetId, operatorRoot: settings.roots.operator, repositoryRoot: settings.release.directory, temporalPort: settings.temporal.port, ingressAddress: settings.ingress.address, ingressPort: settings.ingress.port }, fleet.platform, compose, factorySpawnExecutor);
        return { platform: "started", project: `ezcorp-factory-${settings.fleetId}-platform` };
      case "provision": {
        const through = option(args, "--through") as FactoryProvisioningStepName | undefined;
        if (through && !FACTORY_PROVISIONING_STEP_NAMES.includes(through)) throw new Error(`unknown step ${through}`);
        const results = [];
        for (const tenantId of args) {
          const hostname = factoryInstallationHostname(settings, tenantId);
          try {
            const installation = await fleet.provisioner.provision({ tenantId, hostname, administratorEmail: `admin@${hostname}` }, through ? { through } : {});
            results.push({ tenantId, phase: installation.phase, installationId: installation.installationId, steps: installation.steps.map((step) => ({ step: step.step, state: step.state, attempts: step.attempts })) });
          } catch (error) {
            results.push({ tenantId, error: error instanceof Error ? { name: error.name, code: (error as { code?: string }).code, message: error.message } : String(error) });
          }
        }
        return { provision: results };
      }
      case "observe": {
        const probe = factoryHttpsIngressProbe(settings.ingress.address, settings.ingress.port, `${new TextDecoder().decode(await readFactoryPrivatePath(fleet.platform.ingress.caCertificatePath)).trim()}\n`);
        const observer = factoryIngressBootstrapObserver(probe);
        const results = [];
        for (const tenantId of args) results.push({ tenantId, phase: (await fleet.provisioner.observeBootstrap(tenantId, observer)).phase });
        return { observe: results };
      }
      case "rotate": {
        const [tenantId, step] = args;
        const installation = await fleet.provisioner.rotate(tenantId!, step as "database");
        return { rotate: { tenantId, step, phase: installation.phase } };
      }
      case "teardown": {
        const reason = option(args, "--reason") ?? "operator teardown";
        const outcome = await fleet.provisioner.teardown(args[0]!, { reason });
        return { teardown: { tenantId: args[0], phase: outcome.installation.phase, residues: outcome.residues } };
      }
      case "purge": {
        const approvedBy = option(args, "--approved-by");
        const reason = option(args, "--reason") ?? "operator purge";
        if (!approvedBy) throw new Error("purge requires --approved-by <membership reference>");
        const adminUrl = new TextDecoder().decode(await readFactoryPrivatePath(settings.database.adminUrlPath)).trim();
        const installation = await fleet.provisioner.purge(args[0]!, { approvedBy, reason }, factoryDatabaseCensus(adminUrl));
        return { purge: { tenantId: args[0], phase: installation.phase } };
      }
      case "status": {
        if (args[0]) return { status: await fleet.provisioner.status(args[0]), events: await fleet.provisioner.ledger.events(args[0]) };
        return { directory: await fleet.provisioner.ledger.directory() };
      }
      default:
        throw new Error(`unknown command ${command}`);
    }
  } finally { await fleet.close(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? { name: error.name, code: (error as { code?: string }).code, message: error.message } : String(error) }));
    process.exitCode = 1;
  }
}
