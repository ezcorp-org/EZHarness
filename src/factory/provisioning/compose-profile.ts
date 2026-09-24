/**
 * The self-hosted deployment target: the Compose profile on rootless Podman,
 * plus the host supervisor as a systemd unit.
 *
 * `deploy/factory/compose/installation.yml` is the pinned template for one
 * installation, and `host.yml` for the fleet host's shared pool. This module
 * renders each one's non-secret environment — ports, paths, the image digest,
 * each service's network allowance — runs Compose against it, runs the host
 * supervisor as a systemd unit, and waits until every service says it is ready.
 *
 * The Compose CLI and its DOCKER_HOST are INJECTED (`FactoryComposeCommand`):
 * the operator entry resolves them through `scripts/lib/container-engine.ts`,
 * the repository's one engine rule, so this module never guesses an engine.
 */
import { resolve } from "node:path";
import type { FactoryDeploymentHandle, FactoryDeploymentTarget, FactoryInstallationBundle } from "./deployment";
import type { FactoryFleetHostBundle, FactoryFleetHostPaths, FactoryFleetHostRuntime } from "./host";
import type { FactoryInstallationContext, FactoryStepResources } from "./installation";
import { factoryPrivatePath, removeFactoryPrivateDirectory, replaceFactoryPrivateFile } from "./secret-files";
import { factoryReadinessFresh } from "./readiness-check";
import { FactoryProvisioningError } from "./steps";
import type { FactoryInstallationBuilds, FactoryUpgradeComponent, FactoryUpgradeTarget } from "./fleet-upgrade";

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
  readonly databasePort: number;
  readonly storagePorts: readonly number[];
  readonly temporalPort: number;
  /** The gateway's read-only Temporal HTTP route, which each harness reads positions through. */
  readonly temporalHttpPort: number;
  readonly uid: number;
  readonly gid: number;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly fetchStatus?: (url: string) => Promise<number>;
}

export function factoryComposeProject(installation: Pick<FactoryInstallationContext, "fleetId" | "tenantId">): string {
  return `ezcorp-factory-${installation.fleetId}-${installation.tenantId}`;
}

/** The fleet host's one supervisor unit. */
export function factorySupervisorUnit(fleetId: string): string {
  return `ezcorp-factory-supervisor-${fleetId}.service`;
}

/** `pasta:-T,<port>,...`: the only host loopback ports this service may reach. */
export function factoryPastaNetwork(ports: readonly number[]): string {
  if (ports.length === 0) return "pasta";
  if (ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)) throw new FactoryProvisioningError("deployment_ports_invalid", "A forwarded port is invalid.");
  return `pasta:${[...new Set(ports)].sort((a, b) => a - b).map((port) => `-T,${port}`).join(",")}`;
}

/** Accept only the exit codes named; anything else is a named failure carrying its stderr tail. */
export async function factoryCommandCheck(result: Promise<FactoryCommandResult>, codes: readonly number[], code: string, what: string): Promise<FactoryCommandResult> {
  const settled = await result;
  if (!codes.includes(settled.code)) throw new FactoryProvisioningError(code, `${what} failed (${settled.code}): ${settled.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  return settled;
}

function envFile(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new FactoryProvisioningError("deployment_environment_invalid", `Environment entry ${key} is invalid.`);
    return `${key}=${value}`;
  }).join("\n")}\n`;
}

/** The Compose interpolation file: every `${...}` the template names, references only. */
export function factoryComposeEnvironment(bundle: FactoryInstallationBundle, options: Pick<FactoryComposeTargetOptions, "databasePort" | "storagePorts" | "temporalPort" | "temporalHttpPort" | "uid" | "gid">, envFiles: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const { installation, ports, deliveries, host } = bundle;
  return Object.freeze({
    EZCORP_FACTORY_PROJECT: factoryComposeProject(installation),
    EZCORP_FACTORY_GATEWAY_IMAGE: bundle.images.gateway,
    EZCORP_FACTORY_HARNESS_IMAGE: bundle.images.harness,
    EZCORP_FACTORY_ORCHESTRATOR_IMAGE: bundle.images.orchestrator,
    EZCORP_FACTORY_REVISION: bundle.image.revision,
    EZCORP_FACTORY_UID: String(options.uid),
    EZCORP_FACTORY_GID: String(options.gid),
    EZCORP_FACTORY_FLEET: installation.fleetId,
    EZCORP_FACTORY_TENANT: installation.tenantId,
    EZCORP_FACTORY_INSTALLATION: installation.installationId,
    EZCORP_FACTORY_READINESS_ORCHESTRATION: resolve(bundle.readinessDirectory, "orchestration"),
    EZCORP_FACTORY_HOST_READINESS_POOL: host.poolReadinessDirectory,
    EZCORP_FACTORY_HOST_READINESS_SUPERVISOR: host.supervisorReadinessDirectory,
    EZCORP_FACTORY_HARNESS_DATA: bundle.dataDirectory,
    EZCORP_FACTORY_HARNESS_APP_STATE: resolve(bundle.dataDirectory, "app-state"),
    EZCORP_FACTORY_GATEWAY_PORT: String(ports.gateway),
    EZCORP_FACTORY_HARNESS_PORT: String(ports.harness),
    EZCORP_FACTORY_PRIVATE_SERVICE_PORT: String(ports.privateService),
    EZCORP_FACTORY_GATEWAY_NETWORK: factoryPastaNetwork([options.databasePort]),
    EZCORP_FACTORY_HARNESS_NETWORK: factoryPastaNetwork([options.databasePort, ...options.storagePorts, host.ports.pool, ports.gateway, host.ports.supervisor, options.temporalHttpPort]),
    EZCORP_FACTORY_ORCHESTRATOR_NETWORK: factoryPastaNetwork([options.temporalPort, ports.privateService]),
    EZCORP_FACTORY_DELIVER_GATEWAY: deliveries.gateway.directory,
    EZCORP_FACTORY_DELIVER_HARNESS: deliveries.harness.directory,
    EZCORP_FACTORY_DELIVER_ORCHESTRATOR: deliveries.orchestrator.directory,
    EZCORP_FACTORY_GATEWAY_ENV: envFiles.gateway!,
    EZCORP_FACTORY_HARNESS_ENV: envFiles.harness!,
    EZCORP_FACTORY_ORCHESTRATOR_ENV: envFiles.orchestrator!,
  });
}

/**
 * The host supervisor's systemd unit, as `systemd-run --user` arguments.
 *
 * The properties mirror `deploy/factory/systemd/ezcorp-factory-supervisor@.service`
 * so the transient unit the local profile starts and the installed unit an
 * operator enables are the same unit.
 */
export function factorySupervisorUnitArguments(bundle: FactoryFleetHostBundle, settings: FactorySupervisorUnitSettings, release: string): readonly string[] {
  const config = factoryPrivatePath(bundle.paths.supervisorDelivery, "supervisor.json");
  return [
    "systemd-run", "--user", "--collect", `--unit=${factorySupervisorUnit(bundle.paths.context.fleetId)}`,
    `--working-directory=${release}`,
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

  private must(result: Promise<FactoryCommandResult>, code: string, what: string): Promise<FactoryCommandResult> {
    return factoryCommandCheck(result, [0], code, what);
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

  /** Recreate only the named services onto the images the env file now names. */
  async recreate(bundle: FactoryInstallationBundle, services: readonly string[]): Promise<void> {
    await this.writeEnvironment(bundle);
    await this.must(this.compose(bundle, ["up", "--detach", "--no-build", "--no-deps", ...services]), "deployment_compose_failed", `compose up ${services.join(" ")}`);
  }

  async apply(bundle: FactoryInstallationBundle): Promise<FactoryStepResources> {
    await this.writeEnvironment(bundle);
    await this.must(this.compose(bundle, ["up", "--detach", "--no-build", "--remove-orphans"]), "deployment_compose_failed", "compose up");
    return Object.freeze({ composeProject: factoryComposeProject(bundle.installation), template: this.options.templatePath });
  }

  /**
   * Ready means ready by each service's own statement, and the product's.
   *
   * Every container healthy and the harness answering `/api/ready` 200 — which
   * it does only when its own probes of every dependency pass, the fleet host's
   * shared pool and supervisor included. A deadline turns "never ready" into a
   * named failure naming the first service still not ready.
   */
  async ready(bundle: FactoryInstallationBundle): Promise<void> {
    // Ten minutes: an upgraded harness migrates before it answers, on a host shared by every installation.
    const deadline = this.now() + (this.options.readyTimeoutMs ?? 600_000);
    const fetchStatus = this.options.fetchStatus ?? (async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).status; } catch { return 0; } });
    let waiting = "harness";
    while (this.now() < deadline) {
      const listed = await this.compose(bundle, ["ps", "--all", "--format", "json"]);
      const services = listed.code === 0 ? parseComposePs(listed.stdout) : [];
      const unhealthy = ["gateway", "harness", "orchestrator"].find((service) => services.find((entry) => entry.service === service)?.health !== "healthy");
      const exited = services.find((entry) => entry.state === "exited" && entry.exitCode !== 0 && entry.service !== "orchestrator");
      if (exited) throw new FactoryProvisioningError("deployment_service_exited", `Service ${exited.service} exited with ${exited.exitCode}.`);
      const harness = await fetchStatus(`http://127.0.0.1:${bundle.ports.harness}/api/ready`);
      if (!unhealthy && harness === 200) return;
      waiting = unhealthy ?? "harness";
      await this.sleep(this.options.pollMs ?? 3_000);
    }
    throw new FactoryProvisioningError("deployment_not_ready", `Installation ${bundle.installation.tenantId} did not become ready; still waiting on ${waiting}.`);
  }

  /**
   * Stop every container. Needs no credential: the project name derives from
   * the installation, and the env file the last apply wrote is enough for
   * Compose. An installation that was never applied has no env file and no
   * containers.
   */
  async remove(handle: FactoryDeploymentHandle): Promise<void> {
    if (await Bun.file(resolve(handle.runtimeDirectory, "compose.env")).exists()) await this.must(this.compose(handle, ["down", "--remove-orphans", "--timeout", "20"]), "deployment_compose_failed", "compose down");
  }

  /**
   * Remove the installation's containers and runtime data. The data directory
   * may hold files a container wrote under a mapped subuid, so it is removed
   * inside the rootless user namespace; an ordinary recursive remove fails.
   */
  async purge(handle: FactoryDeploymentHandle): Promise<void> {
    await this.remove(handle);
    await this.must(this.options.execute(["podman", "unshare", "rm", "-rf", "--", handle.runtimeDirectory]), "deployment_purge_failed", "remove the runtime directory");
    await removeFactoryPrivateDirectory(handle.runtimeDirectory);
  }
}

export interface FactoryComposeHostTargetOptions {
  readonly compose: FactoryComposeCommand;
  readonly templatePath: string;
  readonly execute: FactoryCommandExecutor;
  readonly supervisor: FactorySupervisorUnitSettings;
  readonly databasePort: number;
  readonly uid: number;
  readonly gid: number;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly readReadiness?: (path: string) => Promise<string | undefined>;
}

export function factoryComposeHostProject(fleetId: string): string {
  return `ezcorp-factory-${fleetId}-host`;
}

/**
 * The fleet host on the Compose profile: the shared pool as a Compose project,
 * the shared supervisor as a host systemd unit. Both restart onto every new
 * trust set, because each reads its configuration once at start.
 */
export class FactoryComposeHostTarget implements FactoryFleetHostRuntime {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  constructor(private readonly options: FactoryComposeHostTargetOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((settle) => setTimeout(settle, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  private compose(paths: FactoryFleetHostPaths, args: readonly string[]): Promise<FactoryCommandResult> {
    return this.options.execute([...this.options.compose.argv, "--project-name", factoryComposeHostProject(paths.context.fleetId), "--file", this.options.templatePath, "--env-file", resolve(paths.runtimeDirectory, "compose.env"), ...args], { env: this.options.compose.env });
  }

  private async check(result: Promise<FactoryCommandResult>, codes: readonly number[], code: string, what: string): Promise<void> {
    await factoryCommandCheck(result, codes, code, what);
  }

  async apply(bundle: FactoryFleetHostBundle): Promise<void> {
    const { paths } = bundle;
    const poolEnv = resolve(paths.runtimeDirectory, "pool.env");
    await replaceFactoryPrivateFile(poolEnv, envFile({ HOME: "/tmp" }));
    await replaceFactoryPrivateFile(resolve(paths.runtimeDirectory, "compose.env"), envFile({
      EZCORP_FACTORY_PROJECT: factoryComposeHostProject(paths.context.fleetId),
      EZCORP_FACTORY_POOL_IMAGE: bundle.build.image,
      EZCORP_FACTORY_REVISION: bundle.build.revision,
      EZCORP_FACTORY_UID: String(this.options.uid), EZCORP_FACTORY_GID: String(this.options.gid),
      EZCORP_FACTORY_FLEET: paths.context.fleetId,
      EZCORP_FACTORY_POOL_PORT: String(bundle.identity.ports.pool),
      EZCORP_FACTORY_POOL_NETWORK: factoryPastaNetwork([this.options.databasePort]),
      EZCORP_FACTORY_DELIVER_POOL: paths.poolDelivery,
      EZCORP_FACTORY_READINESS_POOL: resolve(paths.readinessDirectory, "pool"),
      EZCORP_FACTORY_POOL_ENV: poolEnv,
    }));
    // Recreated every time: the pool reads its trust and identities once, at start.
    await this.check(this.compose(paths, ["up", "--detach", "--no-build", "--force-recreate", "--remove-orphans"]), [0], "host_compose_failed", "host compose up");
    await this.stopUnit(paths);
    await this.check(this.options.execute(factorySupervisorUnitArguments(bundle, this.options.supervisor, bundle.build.release)), [0], "host_supervisor_failed", "start the host supervisor");
  }

  private async stopUnit(paths: FactoryFleetHostPaths): Promise<void> {
    const unit = factorySupervisorUnit(paths.context.fleetId);
    // 0 stopped, 5 not loaded: both mean nothing of this unit is running.
    await this.check(this.options.execute(["systemctl", "--user", "stop", unit]), [0, 5], "host_supervisor_failed", `stop ${unit}`);
    // 0 cleared, 1 nothing failed, 5 not loaded.
    await this.check(this.options.execute(["systemctl", "--user", "reset-failed", unit]), [0, 1, 5], "host_supervisor_failed", `reset-failed ${unit}`);
  }

  /** Both shared services publish a fresh `ready` record, written after this apply. */
  async ready(bundle: FactoryFleetHostBundle): Promise<void> {
    const started = this.now();
    const deadline = started + (this.options.readyTimeoutMs ?? 180_000);
    const readReadiness = this.options.readReadiness ?? (async (path: string) => { try { return await Bun.file(path).text(); } catch { return undefined; } });
    const fresh = async (writer: "pool" | "supervisor") => {
      const text = await readReadiness(resolve(bundle.paths.readinessDirectory, writer, `${writer}.json`));
      return text !== undefined && factoryReadinessFresh(text, this.now()) && (JSON.parse(text) as { observedAtMs: number }).observedAtMs >= started;
    };
    let waiting: "pool" | "supervisor" = "pool";
    while (this.now() < deadline) {
      const pool = await fresh("pool");
      const supervisor = await fresh("supervisor");
      if (pool && supervisor) return;
      waiting = pool ? "supervisor" : "pool";
      await this.sleep(this.options.pollMs ?? 2_000);
    }
    throw new FactoryProvisioningError("host_not_ready", `The fleet host did not become ready; still waiting on ${waiting}.`);
  }

  /** Stop both shared services. Idempotent; a host never applied has no env file. */
  async remove(paths: FactoryFleetHostPaths): Promise<void> {
    await this.stopUnit(paths);
    if (await Bun.file(resolve(paths.runtimeDirectory, "compose.env")).exists()) await this.check(this.compose(paths, ["down", "--remove-orphans", "--timeout", "20"]), [0], "host_compose_failed", "host compose down");
  }

  /** Stop both services and remove the runtime directory, the runner root's guest-owned files included. */
  async purge(paths: FactoryFleetHostPaths): Promise<void> {
    await this.remove(paths);
    await this.check(this.options.execute(["podman", "unshare", "rm", "-rf", "--", paths.runtimeDirectory]), [0], "host_purge_failed", "remove the host runtime directory");
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

/** The installation's Compose services each upgrade component moves. The host component is the fleet host's. */
export const FACTORY_COMPOSE_UPGRADE_SERVICES: Readonly<Record<Exclude<FactoryUpgradeComponent, "host">, readonly string[]>> = Object.freeze({
  orchestrator: ["orchestrator"],
  harness: ["gateway", "harness"],
});

/**
 * Fleet upgrades on the Compose profile. The ledger already names the new
 * builds when `apply` runs, so the re-rendered bundle carries them; only the
 * component's own services are recreated. The host component moves the fleet
 * host's shared pool and supervisor onto the build, once for the whole fleet:
 * a later installation in the same wave finds it already there.
 */
export class FactoryComposeUpgradeTarget implements FactoryUpgradeTarget {
  constructor(
    private readonly bundle: (installation: FactoryInstallationContext) => Promise<FactoryInstallationBundle>,
    private readonly target: FactoryComposeTarget,
    private readonly host: { useBuild(build: { readonly image: string; readonly revision: string; readonly release: string }): Promise<void> },
  ) {}

  async apply(installation: FactoryInstallationContext, component: FactoryUpgradeComponent, builds: FactoryInstallationBuilds): Promise<void> {
    if (component === "host") { await this.host.useBuild({ image: builds.host.image, revision: builds.host.revision, release: builds.host.releaseDirectory }); return; }
    await this.target.recreate(await this.bundle(installation), FACTORY_COMPOSE_UPGRADE_SERVICES[component]);
  }

  async ready(installation: FactoryInstallationContext): Promise<void> {
    await this.target.ready(await this.bundle(installation));
  }
}
