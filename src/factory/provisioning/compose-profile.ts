/**
 * The self-hosted deployment target: the Compose profile on rootless Podman,
 * plus the host supervisor as a systemd unit.
 *
 * `deploy/factory/compose/installation.yml` is the pinned template. This module
 * renders the installation's non-secret environment — ports, paths, the image
 * digest, each service's network allowance — runs Compose against it, starts
 * the supervisor unit, and waits until every service says it is ready.
 *
 * The Compose CLI and its DOCKER_HOST are INJECTED (`FactoryComposeCommand`):
 * the operator entry resolves them through `scripts/lib/container-engine.ts`,
 * the repository's one engine rule, so this module never guesses an engine.
 */
import { resolve } from "node:path";
import type { FactoryDeploymentHandle, FactoryDeploymentTarget, FactoryInstallationBundle } from "./deployment";
import type { FactoryInstallationContext, FactoryStepResources } from "./installation";
import { factoryPrivatePath, removeFactoryPrivateDirectory, replaceFactoryPrivateFile } from "./secret-files";
import { factoryReadinessFresh } from "./readiness-check";
import { FactoryProvisioningError } from "./steps";
import type { FactoryUpgradeComponent, FactoryUpgradeTarget } from "./fleet-upgrade";

export interface FactoryCommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }
export type FactoryCommandExecutor = (command: readonly string[], options?: { readonly env?: Readonly<Record<string, string>>; readonly cwd?: string }) => Promise<FactoryCommandResult>;

export interface FactoryComposeCommand {
  /** e.g. `["docker", "compose"]`. */
  readonly argv: readonly string[];
  /** The environment the Compose client needs, e.g. `DOCKER_HOST` for the Podman socket. */
  readonly env: Readonly<Record<string, string>>;
}

export interface FactorySupervisorUnitSettings {
  /** Absolute path of the bun binary the unit runs. */
  readonly bun: string;
  /** The host checkout at the image's revision; the unit's working directory. */
  readonly releaseDirectory: string;
  /** PATH for the unit; user units do not inherit a login shell's. */
  readonly path: string;
}

export interface FactoryComposeTargetOptions {
  readonly compose: FactoryComposeCommand;
  readonly templatePath: string;
  readonly execute: FactoryCommandExecutor;
  readonly supervisor: FactorySupervisorUnitSettings;
  readonly databasePort: number;
  readonly storagePorts: readonly number[];
  readonly temporalPort: number;
  readonly uid: number;
  readonly gid: number;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly fetchStatus?: (url: string) => Promise<number>;
  readonly readReadiness?: (path: string) => Promise<string | undefined>;
}

export function factoryComposeProject(installation: Pick<FactoryInstallationContext, "fleetId" | "tenantId">): string {
  return `ezcorp-factory-${installation.fleetId}-${installation.tenantId}`;
}

export function factorySupervisorUnit(installation: Pick<FactoryInstallationContext, "fleetId" | "tenantId">): string {
  return `ezcorp-factory-supervisor-${installation.fleetId}-${installation.tenantId}.service`;
}

/** `pasta:-T,<port>,...`: the only host loopback ports this service may reach. */
export function factoryPastaNetwork(ports: readonly number[]): string {
  if (ports.length === 0) return "pasta";
  if (ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)) throw new FactoryProvisioningError("deployment_ports_invalid", "A forwarded port is invalid.");
  return `pasta:${[...new Set(ports)].sort((a, b) => a - b).map((port) => `-T,${port}`).join(",")}`;
}

function envFile(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new FactoryProvisioningError("deployment_environment_invalid", `Environment entry ${key} is invalid.`);
    return `${key}=${value}`;
  }).join("\n")}\n`;
}

/** The Compose interpolation file: every `${...}` the template names, references only. */
export function factoryComposeEnvironment(bundle: FactoryInstallationBundle, options: Pick<FactoryComposeTargetOptions, "databasePort" | "storagePorts" | "temporalPort" | "uid" | "gid">, envFiles: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const { installation, ports, deliveries } = bundle;
  return Object.freeze({
    EZCORP_FACTORY_PROJECT: factoryComposeProject(installation),
    EZCORP_FACTORY_IMAGE: bundle.image.reference,
    EZCORP_FACTORY_POOL_IMAGE: bundle.images.pool,
    EZCORP_FACTORY_GATEWAY_IMAGE: bundle.images.gateway,
    EZCORP_FACTORY_HARNESS_IMAGE: bundle.images.harness,
    EZCORP_FACTORY_ORCHESTRATOR_IMAGE: bundle.images.orchestrator,
    EZCORP_FACTORY_REVISION: bundle.image.revision,
    EZCORP_FACTORY_UID: String(options.uid),
    EZCORP_FACTORY_GID: String(options.gid),
    EZCORP_FACTORY_FLEET: installation.fleetId,
    EZCORP_FACTORY_TENANT: installation.tenantId,
    EZCORP_FACTORY_INSTALLATION: installation.installationId,
    EZCORP_FACTORY_READINESS: bundle.readinessDirectory,
    EZCORP_FACTORY_READINESS_POOL: resolve(bundle.readinessDirectory, "pool"),
    EZCORP_FACTORY_READINESS_ORCHESTRATION: resolve(bundle.readinessDirectory, "orchestration"),
    EZCORP_FACTORY_HARNESS_DATA: bundle.dataDirectory,
    EZCORP_FACTORY_POOL_PORT: String(ports.pool),
    EZCORP_FACTORY_GATEWAY_PORT: String(ports.gateway),
    EZCORP_FACTORY_HARNESS_PORT: String(ports.harness),
    EZCORP_FACTORY_PRIVATE_SERVICE_PORT: String(ports.privateService),
    EZCORP_FACTORY_POOL_NETWORK: factoryPastaNetwork([options.databasePort]),
    EZCORP_FACTORY_GATEWAY_NETWORK: factoryPastaNetwork([options.databasePort]),
    EZCORP_FACTORY_HARNESS_NETWORK: factoryPastaNetwork([options.databasePort, ...options.storagePorts, ports.pool, ports.gateway, ports.supervisor]),
    EZCORP_FACTORY_ORCHESTRATOR_NETWORK: factoryPastaNetwork([options.temporalPort, ports.privateService]),
    EZCORP_FACTORY_DELIVER_POOL: deliveries.pool.directory,
    EZCORP_FACTORY_DELIVER_GATEWAY: deliveries.gateway.directory,
    EZCORP_FACTORY_DELIVER_HARNESS: deliveries.harness.directory,
    EZCORP_FACTORY_DELIVER_ORCHESTRATOR: deliveries.orchestrator.directory,
    EZCORP_FACTORY_POOL_ENV: envFiles.pool!,
    EZCORP_FACTORY_GATEWAY_ENV: envFiles.gateway!,
    EZCORP_FACTORY_HARNESS_ENV: envFiles.harness!,
    EZCORP_FACTORY_ORCHESTRATOR_ENV: envFiles.orchestrator!,
  });
}

/**
 * The supervisor's systemd unit, as `systemd-run --user` arguments.
 *
 * The properties mirror `deploy/factory/systemd/ezcorp-factory-supervisor@.service`
 * so the transient unit the local profile starts and the installed unit an
 * operator enables are the same unit.
 */
export function factorySupervisorUnitArguments(bundle: FactoryInstallationBundle, settings: FactorySupervisorUnitSettings): readonly string[] {
  const config = factoryPrivatePath(bundle.deliveries.supervisor.directory, "supervisor.json");
  return [
    "systemd-run", "--user", "--collect", `--unit=${factorySupervisorUnit(bundle.installation)}`,
    `--working-directory=${bundle.images.supervisorRelease ?? settings.releaseDirectory}`,
    "--property=Restart=on-failure", "--property=RestartSec=2", "--property=KillMode=control-group", "--property=Delegate=yes",
    "--property=UMask=0077", "--property=TimeoutStopSec=20", "--property=MemoryMax=2G", "--property=TasksMax=1024",
    `--setenv=PATH=${settings.path}`, "--setenv=BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    settings.bun, "src/factory/runner/supervisor-process.ts", config,
  ];
}

export class FactoryComposeTarget implements FactoryDeploymentTarget {
  readonly profile = "compose" as const;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  constructor(private readonly options: FactoryComposeTargetOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((settle) => setTimeout(settle, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  private async compose(bundle: Pick<FactoryInstallationBundle, "runtimeDirectory" | "installation">, args: readonly string[]): Promise<FactoryCommandResult> {
    return this.options.execute([...this.options.compose.argv, "--project-name", factoryComposeProject(bundle.installation), "--file", this.options.templatePath, "--env-file", resolve(bundle.runtimeDirectory, "compose.env"), ...args], { env: this.options.compose.env });
  }

  private async must(result: Promise<FactoryCommandResult>, code: string, what: string): Promise<FactoryCommandResult> {
    const settled = await result;
    if (settled.code !== 0) throw new FactoryProvisioningError(code, `${what} failed (${settled.code}): ${settled.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    return settled;
  }

  /** Render the installation's env files: the Compose interpolation file and one per service. */
  async writeEnvironment(bundle: FactoryInstallationBundle): Promise<void> {
    const envFiles: Record<string, string> = {};
    for (const [service, values] of Object.entries(bundle.environment)) {
      const path = resolve(bundle.runtimeDirectory, `${service}.env`);
      await replaceFactoryPrivateFile(path, envFile(values));
      envFiles[service] = path;
    }
    await replaceFactoryPrivateFile(resolve(bundle.runtimeDirectory, "compose.env"), envFile(factoryComposeEnvironment(bundle, this.options, envFiles)));
  }

  /** Start the supervisor unit; `restart` replaces a running one (a host upgrade moves its release). */
  async startSupervisor(bundle: FactoryInstallationBundle, restart = false): Promise<void> {
    const unit = factorySupervisorUnit(bundle.installation);
    const active = await this.options.execute(["systemctl", "--user", "is-active", unit]);
    if (active.stdout.trim() === "active" && !restart) return;
    if (active.stdout.trim() === "active") await this.options.execute(["systemctl", "--user", "stop", unit]);
    await this.options.execute(["systemctl", "--user", "reset-failed", unit]);
    await this.must(this.options.execute(factorySupervisorUnitArguments(bundle, this.options.supervisor)), "deployment_supervisor_failed", `start ${unit}`);
  }

  /** Recreate only the named services onto the images the env file now names. */
  async recreate(bundle: FactoryInstallationBundle, services: readonly string[]): Promise<void> {
    await this.writeEnvironment(bundle);
    await this.must(this.compose(bundle, ["up", "--detach", "--no-build", "--no-deps", ...services]), "deployment_compose_failed", `compose up ${services.join(" ")}`);
  }

  async apply(bundle: FactoryInstallationBundle): Promise<FactoryStepResources> {
    await this.writeEnvironment(bundle);
    await this.must(this.compose(bundle, ["up", "--detach", "--no-build", "--remove-orphans"]), "deployment_compose_failed", "compose up");
    await this.startSupervisor(bundle);
    return Object.freeze({ composeProject: factoryComposeProject(bundle.installation), supervisorUnit: factorySupervisorUnit(bundle.installation), template: this.options.templatePath });
  }

  /**
   * Ready means ready by each service's own statement, and the product's.
   *
   * Every container healthy, the supervisor's readiness record `ready`, and the
   * harness answering `/api/ready` 200 — which it does only when its own probes
   * of every dependency pass. A deadline turns "never ready" into a named
   * failure naming the first service still not ready.
   */
  async ready(bundle: FactoryInstallationBundle): Promise<void> {
    const deadline = this.now() + (this.options.readyTimeoutMs ?? 360_000);
    const fetchStatus = this.options.fetchStatus ?? (async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).status; } catch { return 0; } });
    const readReadiness = this.options.readReadiness ?? (async (path: string) => { try { return await Bun.file(path).text(); } catch { return undefined; } });
    let waiting = "harness";
    while (this.now() < deadline) {
      const listed = await this.compose(bundle, ["ps", "--all", "--format", "json"]);
      const services = listed.code === 0 ? parseComposePs(listed.stdout) : [];
      const unhealthy = ["pool", "gateway", "harness", "orchestrator"].find((service) => services.find((entry) => entry.service === service)?.health !== "healthy");
      const exited = services.find((entry) => entry.state === "exited" && entry.exitCode !== 0 && entry.service !== "orchestrator");
      if (exited) throw new FactoryProvisioningError("deployment_service_exited", `Service ${exited.service} exited with ${exited.exitCode}.`);
      const supervisor = await readReadiness(resolve(bundle.readinessDirectory, "supervisor", "supervisor.json"));
      const supervisorReady = supervisor !== undefined && factoryReadinessFresh(supervisor, this.now());
      const harness = await fetchStatus(`http://127.0.0.1:${bundle.ports.harness}/api/ready`);
      if (!unhealthy && supervisorReady && harness === 200) return;
      waiting = unhealthy ?? (supervisorReady ? "harness" : "supervisor");
      await this.sleep(this.options.pollMs ?? 3_000);
    }
    throw new FactoryProvisioningError("deployment_not_ready", `Installation ${bundle.installation.tenantId} did not become ready; still waiting on ${waiting}.`);
  }

  /** Accept only the exit codes named; anything else is a failure with its stderr tail. */
  private async allow(result: Promise<FactoryCommandResult>, codes: readonly number[], code: string, what: string): Promise<void> {
    const settled = await result;
    if (!codes.includes(settled.code)) throw new FactoryProvisioningError(code, `${what} failed (${settled.code}): ${settled.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  }

  /**
   * Stop the supervisor unit and every container. Needs no credential: the
   * project and unit names derive from the installation, and the env file the
   * last apply wrote is enough for Compose. An installation that was never
   * applied has no env file and no containers, and only its unit is checked.
   */
  async remove(handle: FactoryDeploymentHandle): Promise<void> {
    const unit = factorySupervisorUnit(handle.installation);
    // 0 stopped, 5 not loaded: both mean nothing of this unit is running.
    await this.allow(this.options.execute(["systemctl", "--user", "stop", unit]), [0, 5], "deployment_supervisor_failed", `stop ${unit}`);
    // 0 cleared, 1 nothing failed, 5 not loaded.
    await this.allow(this.options.execute(["systemctl", "--user", "reset-failed", unit]), [0, 1, 5], "deployment_supervisor_failed", `reset-failed ${unit}`);
    if (await Bun.file(resolve(handle.runtimeDirectory, "compose.env")).exists()) await this.must(this.compose(handle, ["down", "--remove-orphans", "--timeout", "20"]), "deployment_compose_failed", "compose down");
  }

  /**
   * Remove the installation's containers, runner root, and runtime data. A
   * runner root holds guest-owned files under a mapped subuid, so it is removed
   * inside the rootless user namespace; an ordinary recursive remove fails.
   */
  async purge(handle: FactoryDeploymentHandle): Promise<void> {
    await this.remove(handle);
    await this.must(this.options.execute(["podman", "unshare", "rm", "-rf", "--", handle.runnerRoot]), "deployment_purge_failed", "remove the runner root");
    await removeFactoryPrivateDirectory(handle.runtimeDirectory);
  }
}

interface ComposePsEntry { readonly service: string; readonly state: string; readonly health: string; readonly exitCode: number }

/** `compose ps --format json` prints one object per line (Compose v2) or one array; accept both. */
export function parseComposePs(stdout: string): readonly ComposePsEntry[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed: unknown[] = text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return parsed.map((entry) => {
    const record = entry as { Service?: unknown; State?: unknown; Health?: unknown; ExitCode?: unknown };
    return { service: String(record.Service ?? ""), state: String(record.State ?? ""), health: String(record.Health ?? ""), exitCode: Number(record.ExitCode ?? 0) };
  });
}

/** The real executor: spawn, capture, never throw on a non-zero exit. */
export const factorySpawnExecutor: FactoryCommandExecutor = async (command, options = {}) => {
  const child = Bun.spawn([...command], { env: { ...process.env, ...options.env }, cwd: options.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};

/** The Compose services, and whether the supervisor unit moves, for each upgrade component. */
export const FACTORY_COMPOSE_UPGRADE_SERVICES: Readonly<Record<FactoryUpgradeComponent, { readonly services: readonly string[]; readonly supervisor: boolean }>> = Object.freeze({
  host: { services: ["pool"], supervisor: true },
  orchestrator: { services: ["orchestrator"], supervisor: false },
  harness: { services: ["gateway", "harness"], supervisor: false },
});

/**
 * Fleet upgrades on the Compose profile. The ledger already names the new
 * builds when `apply` runs, so the re-rendered bundle carries them; only the
 * component's own services are recreated, and the supervisor unit is restarted
 * onto its new release only for the host component.
 */
export class FactoryComposeUpgradeTarget implements FactoryUpgradeTarget {
  constructor(private readonly bundle: (installation: FactoryInstallationContext) => Promise<FactoryInstallationBundle>, private readonly target: FactoryComposeTarget) {}

  async apply(installation: FactoryInstallationContext, component: FactoryUpgradeComponent): Promise<void> {
    const bundle = await this.bundle(installation);
    const plan = FACTORY_COMPOSE_UPGRADE_SERVICES[component];
    await this.target.recreate(bundle, plan.services);
    if (plan.supervisor) await this.target.startSupervisor(bundle, true);
  }

  async ready(installation: FactoryInstallationContext): Promise<void> {
    await this.target.ready(await this.bundle(installation));
  }
}
