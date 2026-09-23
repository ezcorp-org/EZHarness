/**
 * The operator commands for one fleet, independent of how the process starts.
 *
 * `scripts/factory-fleet.ts` resolves the container engine and calls
 * `runFactoryFleetMain`; everything an operator can do is dispatched here, so
 * it is testable without a shell, and every command answers with one JSON
 * document that holds references and states only — never a credential.
 */
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { SQL } from "bun";
import { factoryDatabaseCensus } from "./census";
import type { FactoryComposeCommand } from "./compose-profile";
import { factorySpawnExecutor } from "./compose-profile";
import { composeFactoryProvisioner, factoryFleetDefaultBuild, factoryInstallationHostname, loadFactoryFleetSettings, parseFactoryFleetSettings, type FactoryComposedFleet, type FactoryFleetSettings } from "./fleet";
import type { FactoryBuild } from "./fleet-upgrade";
import { factoryHttpsIngressProbe, factoryIngressBootstrapObserver } from "./ingress";
import type { FactoryBootstrapObserver, FactoryOperationActor, FactoryPurgeChecks } from "./local";
import { startFactoryPlatform } from "./platform";
import { factoryDatabasePurgeApprovals } from "./purge-approval";
import { factoryScramVerifier } from "./scram";
import { ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivatePath, readFactoryPrivateText, replaceFactoryPrivateFile } from "./secret-files";
import { FACTORY_PROVISIONING_STEP_NAMES, FactoryProvisioningError, type FactoryProvisioningStepName } from "./steps";

export interface FactoryFleetCommandContext {
  readonly settings: FactoryFleetSettings;
  readonly fleet: FactoryComposedFleet;
  readonly purgeChecks: () => Promise<FactoryPurgeChecks>;
  /** Who runs the command, recorded on the ledger with every mutation. */
  readonly actor: string;
  readonly observer: () => Promise<FactoryBootstrapObserver>;
  readonly startPlatform: () => Promise<void>;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function errorView(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof Error ? { name: error.name, code: (error as { code?: string }).code, message: error.message } : { message: String(error) };
}

/** Dispatch one command. Throws on a usage error; per-tenant failures are reported in the result. */
export async function runFactoryFleetCommand(command: string, rest: readonly string[], context: FactoryFleetCommandContext): Promise<unknown> {
  const args = [...rest];
  const { fleet, settings } = context;
  const who: FactoryOperationActor = { actor: context.actor };
  switch (command) {
    case "platform":
      await context.startPlatform();
      return { platform: "started", project: `ezcorp-factory-${settings.fleetId}-platform` };
    case "provision": {
      const through = option(args, "--through");
      const administratorEmail = option(args, "--admin-email");
      if (administratorEmail !== undefined && args.length !== 1) throw new FactoryProvisioningError("cli_usage", "--admin-email names the administrator of exactly one tenant");
      if (through !== undefined && !FACTORY_PROVISIONING_STEP_NAMES.includes(through as FactoryProvisioningStepName)) throw new FactoryProvisioningError("cli_usage", `unknown step ${through}`);
      const results = [];
      for (const tenantId of args) {
        const hostname = factoryInstallationHostname(settings, tenantId);
        try {
          const installation = await fleet.provisioner.provision({ tenantId, hostname, administratorEmail: administratorEmail ?? `admin@${hostname}` }, { ...who, ...(through ? { through: through as FactoryProvisioningStepName } : {}) });
          await fleet.upgrades.adopt(tenantId, factoryFleetDefaultBuild(settings).buildId);
          results.push({ tenantId, phase: installation.phase, installationId: installation.installationId, steps: installation.steps.map((step) => ({ step: step.step, state: step.state, attempts: step.attempts })) });
        } catch (error) { results.push({ tenantId, error: errorView(error) }); }
      }
      return { provision: results };
    }
    case "observe": {
      const observer = await context.observer();
      const results = [];
      for (const tenantId of args) {
        try { results.push({ tenantId, phase: (await fleet.provisioner.observeBootstrap(tenantId, observer, who)).phase }); }
        catch (error) { results.push({ tenantId, error: errorView(error) }); }
      }
      return { observe: results };
    }
    case "rotate": {
      const [tenantId, step] = args;
      if (!tenantId || !step || !["database", "storage", "temporal", "secrets", "deployment", "invitation"].includes(step)) throw new FactoryProvisioningError("cli_usage", "rotate <tenant> <database|storage|temporal|secrets|deployment|invitation>");
      return { rotate: { tenantId, step, phase: (await fleet.provisioner.rotate(tenantId, step as "database", who)).phase } };
    }
    case "teardown": {
      const reason = option(args, "--reason") ?? "operator teardown";
      if (!args[0]) throw new FactoryProvisioningError("cli_usage", "teardown <tenant> --reason <text>");
      const outcome = await fleet.provisioner.teardown(args[0], { reason, ...who });
      return { teardown: { tenantId: args[0], phase: outcome.installation.phase, residues: outcome.residues } };
    }
    case "purge": {
      const approvalId = option(args, "--approval");
      const reason = option(args, "--reason") ?? "operator purge";
      if (!args[0] || !approvalId) throw new FactoryProvisioningError("cli_usage", "purge <tenant> --approval <approval ID an administrator issued> --reason <text>");
      return { purge: { tenantId: args[0], phase: (await fleet.provisioner.purge(args[0], { approvalId, reason, ...who }, await context.purgeChecks())).phase } };
    }
    case "upgrade": {
      const [action, ...more] = args;
      if (action === "register") {
        const [buildId, image, revision, releaseDirectory] = more;
        if (!buildId || !image || !revision || !releaseDirectory) throw new FactoryProvisioningError("cli_usage", "upgrade register <build> <image@sha256:...> <revision> <release directory>");
        const build: FactoryBuild = { buildId, image, revision, releaseDirectory: resolve(releaseDirectory) };
        await fleet.upgrades.register(build);
        return { registered: build };
      }
      if (action === "wave") {
        const canary = option(more, "--canary");
        const [buildId, ...tenants] = more;
        if (!buildId || !canary || tenants.length === 0) throw new FactoryProvisioningError("cli_usage", "upgrade wave <build> --canary <tenant> <tenant>...");
        return { wave: await fleet.upgrades.wave({ buildId, canary, tenants }) };
      }
      if (action === "abandon") {
        if (!more[0]) throw new FactoryProvisioningError("cli_usage", "upgrade abandon <wave>");
        await fleet.upgrades.abandon(more[0]);
        return { abandoned: more[0] };
      }
      if (action === "retire") return { retired: await fleet.upgrades.retire((await context.purgeChecks()).census) };
      throw new FactoryProvisioningError("cli_usage", "upgrade <register|wave|abandon|retire> ...");
    }
    case "host": {
      if (args[0] === "status") return { host: { poolId: fleet.host.identity.poolId, hostId: fleet.host.identity.hostId, admitted: (await fleet.host.admitted()).map((entry) => entry.tenantId) } };
      if (args[0] === "decommission") { await fleet.host.decommission(); return { host: { decommissioned: fleet.host.identity.hostId } }; }
      throw new FactoryProvisioningError("cli_usage", "host <status|decommission>");
    }
    case "status": {
      if (args[0]) return { status: await fleet.provisioner.status(args[0]), events: await fleet.provisioner.ledger.events(args[0]), builds: await fleet.upgrades.builds(args[0]) ?? null };
      return { directory: await fleet.provisioner.ledger.directory() };
    }
    default:
      throw new FactoryProvisioningError("cli_usage", `unknown command ${command}`);
  }
}

export interface FactoryFleetMainIo {
  readonly print: (value: unknown) => void;
  readonly fail: (value: unknown) => void;
}

const defaultIo: FactoryFleetMainIo = {
  print: (value) => console.log(JSON.stringify(value, null, 2)),
  fail: (value) => { console.error(JSON.stringify(value)); process.exitCode = 1; },
};

/** `<fleet.json> <command> [...]`: load, compose, dispatch, print, close. */
export async function runFactoryFleetMain(argv: readonly string[], compose: FactoryComposeCommand, io: FactoryFleetMainIo = defaultIo): Promise<void> {
  const [settingsPath, command, ...rest] = argv;
  let fleet: FactoryComposedFleet | undefined;
  try {
    if (!settingsPath || !command) throw new FactoryProvisioningError("cli_usage", "usage: factory-fleet.ts <fleet.json> <platform|provision|observe|rotate|teardown|purge|upgrade|host|status> ...");
    const settings = await loadFactoryFleetSettings(settingsPath);
    fleet = await composeFactoryProvisioner(settings, { compose, uid: process.getuid!(), gid: process.getgid!() });
    const composed = fleet;
    io.print(await runFactoryFleetCommand(command, rest, {
      settings, fleet: composed,
      actor: `cli:${userInfo().username}`,
      purgeChecks: async () => {
        const adminUrl = new TextDecoder().decode(await readFactoryPrivatePath(settings.database.adminUrlPath)).trim();
        return { census: factoryDatabaseCensus(adminUrl), approvals: factoryDatabasePurgeApprovals(adminUrl) };
      },
      observer: async () => factoryIngressBootstrapObserver(factoryHttpsIngressProbe(settings.ingress.address, settings.ingress.port, `${new TextDecoder().decode(await readFactoryPrivatePath(composed.platform.ingress.caCertificatePath)).trim()}\n`)),
      startPlatform: () => startFactoryPlatform({ fleetId: settings.fleetId, operatorRoot: settings.roots.operator, repositoryRoot: settings.release.directory, temporalPort: settings.temporal.port, ingressAddress: settings.ingress.address, ingressPort: settings.ingress.port }, composed.platform, compose, factorySpawnExecutor, () => composed.platformServes()),
    }));
  } catch (error) { io.fail({ error: errorView(error) }); }
  finally { await fleet?.close(); }
}

export interface FactoryLocalFleetOptions {
  readonly fleetId: string;
  readonly root: string;
  readonly image: string;
  readonly revision: string;
  readonly portBase: number;
  readonly adminUrl: string;
  readonly storageSecretsDirectory: string;
  readonly releaseDirectory: string;
  readonly bun: string;
  readonly runnerProfiles: FactoryFleetSettings["installations"]["runnerProfiles"];
}

/**
 * Write a local fleet's settings for this host and create its control database.
 *
 * Only references go into the settings document. The two URLs that carry a
 * credential are private files beside it, named by path. The control database
 * gets its own login role, so the control plane never connects as the cluster
 * administrator. The shared stores' server identity files are read later by
 * the storage step, never written.
 */
export async function writeFactoryLocalFleet(options: FactoryLocalFleetOptions): Promise<{ readonly settingsPath: string; readonly settings: FactoryFleetSettings }> {
  const operator = resolve(options.root, "operator");
  const directory = await openFactoryPrivateDirectory(operator);
  const controlDatabase = `factory_control_${options.fleetId.replaceAll("-", "_")}`;
  const controlRole = `${controlDatabase}_role`;
  try {
    await replaceFactoryPrivateFile(factoryPrivatePath(operator, "product-admin-url"), `${options.adminUrl}\n`);
    await ensureFactoryPrivateFile(directory, "control-password", () => `${randomBytes(32).toString("base64url")}\n`);
    const controlPassword = (await readFactoryPrivateText(directory, "control-password")).trim();
    const admin = new SQL(options.adminUrl, { max: 1 });
    try {
      const exists = (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${controlRole}`)[0];
      const statement = (await admin`SELECT format(${exists ? "ALTER ROLE %I LOGIN PASSWORD %L" : "CREATE ROLE %I LOGIN PASSWORD %L"}, ${controlRole}::text, ${factoryScramVerifier(controlPassword)}::text) AS statement`)[0] as { statement: string };
      await admin.unsafe(statement.statement);
      if (!(await admin`SELECT 1 FROM pg_database WHERE datname = ${controlDatabase}`)[0]) await admin.unsafe(`CREATE DATABASE "${controlDatabase}" OWNER "${controlRole}"`);
      await admin.unsafe(`REVOKE ALL ON DATABASE "${controlDatabase}" FROM PUBLIC`);
    } finally { await admin.close(); }
    const controlUrl = new URL(options.adminUrl); controlUrl.pathname = `/${controlDatabase}`; controlUrl.username = controlRole; controlUrl.password = controlPassword;
    await replaceFactoryPrivateFile(factoryPrivatePath(operator, "control-database-url"), `${controlUrl.toString()}\n`);
  } finally { await directory.close(); }
  const database = new URL(options.adminUrl);
  const settings = parseFactoryFleetSettings({
    schemaVersion: "factory.fleet.v1", fleetId: options.fleetId, profile: "compose",
    roots: { operator, secrets: resolve(options.root, "installations"), runtime: resolve(options.root, "runtime") },
    control: { databaseUrlPath: factoryPrivatePath(operator, "control-database-url") },
    database: { adminUrlPath: factoryPrivatePath(operator, "product-admin-url"), serviceHost: database.hostname, servicePort: Number(database.port) },
    storage: {
      ordinary: { endpoint: "http://127.0.0.1:18333", prefix: "ordinary", issuer: { kind: "seeded", serverIdentityPath: resolve(options.storageSecretsDirectory, "ordinary.json") } },
      archive: { endpoint: "http://127.0.0.1:18334", prefix: "archive", issuer: { kind: "seeded", serverIdentityPath: resolve(options.storageSecretsDirectory, "archive.json") } },
      failureDomain: "same-host-not-independent",
    },
    temporal: { port: options.portBase + 1_001, serverName: "temporal.local" },
    ingress: { address: "127.0.0.1", port: options.portBase + 1_005, domain: `${options.fleetId}.factory.test` },
    installations: { portBase: options.portBase, cpuCapacity: 2, interpreterCompatibility: "factory-kernel.v1", runnerProfiles: options.runnerProfiles },
    image: { reference: options.image, revision: options.revision },
    release: { directory: options.releaseDirectory, bun: options.bun, path: `${resolve(options.bun, "..")}:/run/current-system/sw/bin:/usr/bin:/bin` },
  });
  const settingsPath = resolve(options.root, "fleet.json");
  await Bun.write(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { settingsPath, settings };
}
