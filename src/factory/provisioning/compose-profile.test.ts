import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  factoryRejection,
  makeFactoryPrivateRoot,
  makeFactoryTestDeploymentSettings,
  makeFactoryTestInstallation,
  removeFactoryPrivateRoot,
  writeFactoryTestDatabaseCredentials,
  writeModeFile,
} from "../../__tests__/helpers/factory-private-root";
import {
  FACTORY_COMPOSE_UPGRADE_SERVICES,
  FactoryComposeHostTarget,
  FactoryComposeTarget,
  FactoryComposeUpgradeTarget,
  factoryCommandCheck,
  factoryComposeEnvironment,
  factoryComposeHostProject,
  factoryComposeProject,
  factoryPastaNetwork,
  factorySpawnExecutor,
  factorySupervisorUnit,
  factorySupervisorUnitArguments,
  parseComposePs,
  type FactoryCommandExecutor,
  type FactoryCommandResult,
  type FactoryComposeHostTargetOptions,
  type FactoryComposeTargetOptions,
} from "./compose-profile";
import { factoryDeploymentHandle, renderFactoryInstallationBundle, type FactoryInstallationBundle } from "./deployment";
import type { FactoryInstallationBuilds } from "./fleet-upgrade";
import { factoryFleetHostIdentity, factoryFleetHostPaths, type FactoryFleetHostBuild, type FactoryFleetHostBundle } from "./host";
import type { FactoryInstallationContext } from "./installation";
import { openFactoryPrivateDirectory } from "./secret-files";

const REPOSITORY = resolve(import.meta.dir, "../../..");
const TEMPLATE = join(REPOSITORY, "deploy/factory/compose/installation.yml");
const HOST_TEMPLATE = join(REPOSITORY, "deploy/factory/compose/host.yml");
const SUPERVISOR_UNIT_FILE = join(REPOSITORY, "deploy/factory/systemd/ezcorp-factory-supervisor@.service");
const SETTINGS = { bun: "/opt/bun/bin/bun", releaseDirectory: "/srv/release/current", path: "/usr/bin:/bin" };
const PORTS = { databasePort: 55432, storagePorts: [59001, 59000, 59000], temporalPort: 57233, temporalHttpPort: 57244, uid: 1001, gid: 1001 };
const OK: FactoryCommandResult = { code: 0, stdout: "", stderr: "" };
const HEALTHY = ["gateway", "harness", "orchestrator"].map((service) => JSON.stringify({ Service: service, State: "running", Health: "healthy", ExitCode: 0 })).join("\n");
const HOST_BUILD: FactoryFleetHostBuild = { image: `registry.test/ezcorp@sha256:${"d".repeat(64)}`, revision: "e".repeat(40), release: "/srv/release/host" };

type Responder = (command: readonly string[]) => FactoryCommandResult | undefined;

/** A recording executor: every command it saw, and a responder deciding each answer. */
function fakeExecutor(responder: Responder = () => undefined): FactoryCommandExecutor & { readonly calls: { command: readonly string[]; env?: Readonly<Record<string, string>> }[] } {
  const calls: { command: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
  const execute = (async (command, options) => {
    calls.push({ command, ...(options?.env ? { env: options.env } : {}) });
    return responder(command) ?? OK;
  }) as FactoryCommandExecutor & { readonly calls: typeof calls };
  Object.defineProperty(execute, "calls", { value: calls });
  return execute;
}

/** The command after the compose prefix (`docker compose --project-name P --file F --env-file E`). */
const composeArgs = (command: readonly string[]) => command.slice(8);
const isCompose = (command: readonly string[], sub: string) => command[0] === "docker" && composeArgs(command)[0] === sub;
const COMPOSE = { argv: ["docker", "compose"], env: { DOCKER_HOST: "unix:///run/user/1001/podman/podman.sock" } };

function target(execute: FactoryCommandExecutor, overrides: Partial<FactoryComposeTargetOptions> = {}): FactoryComposeTarget {
  return new FactoryComposeTarget({ compose: COMPOSE, templatePath: TEMPLATE, execute, ...PORTS, ...overrides });
}

function hostTarget(execute: FactoryCommandExecutor, overrides: Partial<FactoryComposeHostTargetOptions> = {}): FactoryComposeHostTarget {
  return new FactoryComposeHostTarget({ compose: COMPOSE, templatePath: HOST_TEMPLATE, execute, supervisor: SETTINGS, databasePort: 55432, uid: 1001, gid: 1001, ...overrides });
}

/** A virtual clock: `sleep` advances it, so a deadline is reached without waiting. */
function virtualClock(start = 0): { now: () => number; sleep: (milliseconds: number) => Promise<void>; readonly slept: number[] } {
  let time = start;
  const slept: number[] = [];
  return { now: () => time, sleep: async (milliseconds) => { slept.push(milliseconds); time += milliseconds; }, slept };
}

let root: string;
let installation: FactoryInstallationContext;
let bundle: FactoryInstallationBundle;
let hostBundle: FactoryFleetHostBundle;

beforeAll(async () => {
  root = await makeFactoryPrivateRoot();
  installation = makeFactoryTestInstallation(root);
  await writeFactoryTestDatabaseCredentials(installation);
  bundle = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime")));
  const paths = factoryFleetHostPaths("fleet-a", { secretsRoot: join(root, "host-secrets"), operatorRoot: join(root, "host-operator"), runtimeRoot: join(root, "runtime") });
  for (const directory of [join(root, "runtime"), paths.runtimeDirectory]) await (await openFactoryPrivateDirectory(directory)).close();
  hostBundle = { identity: factoryFleetHostIdentity("fleet-a", 40_000), paths, admitted: [], build: HOST_BUILD, pool: {}, supervisor: {}, deliveries: { pool: {}, supervisor: {} } };
});
afterAll(async () => { await removeFactoryPrivateRoot(root); });

describe("names", () => {
  test("the installation project is scoped by fleet and tenant; the host project and the one supervisor unit by fleet", () => {
    expect(factoryComposeProject({ fleetId: "fleet-a", tenantId: "tenant-01" })).toBe("ezcorp-factory-fleet-a-tenant-01");
    expect(factoryComposeProject({ fleetId: "fleet-b", tenantId: "tenant-01" })).not.toBe(factoryComposeProject({ fleetId: "fleet-a", tenantId: "tenant-01" }));
    expect(factoryComposeHostProject("fleet-a")).toBe("ezcorp-factory-fleet-a-host");
    expect(factorySupervisorUnit("fleet-a")).toBe("ezcorp-factory-supervisor-fleet-a.service");
  });
});

describe("factoryCommandCheck", () => {
  test("returns an allowed result and names a refused one with the last three stderr lines, bounded", async () => {
    expect(await factoryCommandCheck(Promise.resolve({ code: 5, stdout: "x", stderr: "" }), [0, 5], "c", "w")).toEqual({ code: 5, stdout: "x", stderr: "" });
    const error = await factoryRejection(factoryCommandCheck(Promise.resolve({ code: 2, stdout: "", stderr: "a\nb\nc\nd\n" }), [0], "some_failure", "do it"));
    expect([error.code, error.message]).toEqual(["some_failure", "do it failed (2): b | c | d"]);
    const long = await factoryRejection(factoryCommandCheck(Promise.resolve({ code: 1, stdout: "", stderr: "z".repeat(1_000) }), [0], "c", "w"));
    expect(long.message.length).toBe("w failed (1): ".length + 400);
  });
});

describe("factoryPastaNetwork", () => {
  test("no port means no forwarding at all", () => {
    expect(factoryPastaNetwork([])).toBe("pasta");
  });

  test("forwards each port once, in ascending order", () => {
    expect(factoryPastaNetwork([5432, 80, 5432, 1])).toBe("pasta:-T,1,-T,80,-T,5432");
    expect(factoryPastaNetwork([65_535])).toBe("pasta:-T,65535");
  });

  test("refuses a port outside 1..65535 or a non-integer", () => {
    for (const ports of [[0], [65_536], [80, 1.5], [Number.NaN], [-1]]) {
      let code: string | undefined;
      try { factoryPastaNetwork(ports); } catch (error) { code = (error as { code?: string }).code; }
      expect(code).toBe("deployment_ports_invalid");
    }
  });
});

/** Every `${NAME` a template interpolates. */
async function interpolated(path: string): Promise<string[]> {
  return [...new Set([...(await readFile(path, "utf8")).matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((match) => match[1]!))].sort();
}

describe("factoryComposeEnvironment", () => {
  const envFiles = { gateway: "/r/gateway.env", harness: "/r/harness.env", orchestrator: "/r/orchestrator.env" };

  test("defines exactly the variables the pinned installation template interpolates, no more and no fewer", async () => {
    const referenced = await interpolated(TEMPLATE);
    expect(referenced.length).toBeGreaterThan(20);
    expect(Object.keys(factoryComposeEnvironment(bundle, PORTS, envFiles)).sort()).toEqual(referenced);
  });

  test("carries references only: identities, ports, paths, images, each service's network allowance, and the host's readiness directories", () => {
    const environment = factoryComposeEnvironment(bundle, PORTS, envFiles);
    // The product's daemons write `.ezcorp` under /app; the harness gets its own writable copy from its data directory.
    expect(environment.EZCORP_FACTORY_HARNESS_APP_STATE).toBe(join(bundle.dataDirectory, "app-state"));
    expect(environment).toMatchObject({
      EZCORP_FACTORY_PROJECT: "ezcorp-factory-fleet-a-tenant-01",
      EZCORP_FACTORY_HARNESS_IMAGE: bundle.images.harness,
      EZCORP_FACTORY_UID: "1001",
      EZCORP_FACTORY_TENANT: "tenant-01",
      EZCORP_FACTORY_HARNESS_PORT: "40010",
      // W01g's guest-broker route, published on loopback for the fleet host's supervisor.
      EZCORP_FACTORY_GUEST_BROKER_PORT: "40013",
      EZCORP_FACTORY_GATEWAY_NETWORK: "pasta:-T,55432",
      // The harness reaches its gateway, the database, both stores, the fleet host's shared pool and supervisor, and the gateway's read-only Temporal HTTP route.
      EZCORP_FACTORY_HARNESS_NETWORK: "pasta:-T,40012,-T,41002,-T,41003,-T,55432,-T,57244,-T,59000,-T,59001",
      EZCORP_FACTORY_ORCHESTRATOR_NETWORK: "pasta:-T,40011,-T,57233",
      EZCORP_FACTORY_READINESS_ORCHESTRATION: join(bundle.readinessDirectory, "orchestration"),
      EZCORP_FACTORY_HOST_READINESS_POOL: bundle.host.poolReadinessDirectory,
      EZCORP_FACTORY_HOST_READINESS_SUPERVISOR: bundle.host.supervisorReadinessDirectory,
      EZCORP_FACTORY_DELIVER_HARNESS: bundle.deliveries.harness.directory,
      EZCORP_FACTORY_HARNESS_ENV: "/r/harness.env",
    });
    expect(Object.isFrozen(environment)).toBe(true);
  });
});

describe("factorySupervisorUnitArguments", () => {
  const MIRRORED = ["Restart", "RestartSec", "KillMode", "Delegate", "UMask", "TimeoutStopSec", "MemoryMax", "TasksMax"];

  test("mirrors every service property of the installed systemd unit", async () => {
    const unit = await readFile(SUPERVISOR_UNIT_FILE, "utf8");
    const installed = Object.fromEntries(unit.split("\n").map((line) => /^([A-Za-z]+)=(.*)$/.exec(line)).filter((match) => match !== null).map((match) => [match![1]!, match![2]!]));
    const transient = Object.fromEntries(factorySupervisorUnitArguments(hostBundle, SETTINGS, HOST_BUILD.release).filter((arg) => arg.startsWith("--property=")).map((arg) => arg.slice("--property=".length).split("=") as [string, string]));
    for (const property of MIRRORED) {
      expect(installed[property]).toBeDefined();
      expect(transient[property]).toBe(installed[property]);
    }
  });

  test("runs the fleet's one supervisor on the host's delivered config, in the named release", () => {
    const args = factorySupervisorUnitArguments(hostBundle, SETTINGS, "/srv/release/next");
    expect(args.slice(0, 4)).toEqual(["systemd-run", "--user", "--collect", "--unit=ezcorp-factory-supervisor-fleet-a.service"]);
    expect(args).toContain("--working-directory=/srv/release/next");
    expect(args).toContain("--setenv=PATH=/usr/bin:/bin");
    expect(args.slice(-3)).toEqual(["/opt/bun/bin/bun", "src/factory/runner/supervisor-process.ts", join(hostBundle.paths.supervisorDelivery, "supervisor.json")]);
  });
});

describe("parseComposePs", () => {
  test("empty output lists no service", () => {
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("  \n ")).toEqual([]);
  });

  test("accepts one JSON array", () => {
    expect(parseComposePs('[{"Service":"pool","State":"running","Health":"healthy","ExitCode":0},{"Service":"harness","State":"exited","Health":"","ExitCode":2}]')).toEqual([
      { service: "pool", state: "running", health: "healthy", exitCode: 0 },
      { service: "harness", state: "exited", health: "", exitCode: 2 },
    ]);
  });

  test("accepts JSON lines, skipping blank ones, and defaults absent fields", () => {
    expect(parseComposePs('{"Service":"pool","State":"running","Health":"starting"}\n\n{}\n')).toEqual([
      { service: "pool", state: "running", health: "starting", exitCode: 0 },
      { service: "", state: "", health: "", exitCode: 0 },
    ]);
  });

  test("malformed output is a parse error, not an empty list", () => {
    expect(() => parseComposePs("{not json")).toThrow(SyntaxError);
  });
});

describe("FactoryComposeTarget.apply", () => {
  test("writes private env files, brings the project up, and returns references; no supervisor is started", async () => {
    const execute = fakeExecutor();
    const resources = await target(execute).apply(bundle);
    expect(resources).toEqual({ composeProject: "ezcorp-factory-fleet-a-tenant-01", template: TEMPLATE });
    expect(execute.calls.map((call) => call.command)).toEqual([["docker", "compose", "--project-name", "ezcorp-factory-fleet-a-tenant-01", "--file", TEMPLATE, "--env-file", join(bundle.runtimeDirectory, "compose.env"), "up", "--detach", "--no-build", "--remove-orphans"]]);
    expect(execute.calls[0]!.env).toEqual({ DOCKER_HOST: "unix:///run/user/1001/podman/podman.sock" });
    for (const name of ["compose.env", "gateway.env", "harness.env", "orchestrator.env"]) expect((await stat(join(bundle.runtimeDirectory, name))).mode & 0o777).toBe(0o600);
    const composeEnv = await readFile(join(bundle.runtimeDirectory, "compose.env"), "utf8");
    expect(composeEnv).toContain("EZCORP_FACTORY_PROJECT=ezcorp-factory-fleet-a-tenant-01\n");
    expect(composeEnv).toContain(`EZCORP_FACTORY_HARNESS_ENV=${join(bundle.runtimeDirectory, "harness.env")}\n`);
    expect(await readFile(join(bundle.runtimeDirectory, "harness.env"), "utf8")).toContain("EZCORP_FACTORY_ENABLED=1\n");
  });

  test("a compose failure names the step and the tail of its stderr", async () => {
    const stderr = "line 1\nline 2\nline 3\nimage not found\n";
    const execute = fakeExecutor((command) => isCompose(command, "up") ? { code: 125, stdout: "", stderr } : undefined);
    const error = await factoryRejection(target(execute).apply(bundle));
    expect(error.code).toBe("deployment_compose_failed");
    expect(error.message).toBe("compose up failed (125): line 2 | line 3 | image not found");
  });

  test("an environment value holding a newline is refused before Compose runs", async () => {
    const execute = fakeExecutor();
    const injected = { ...bundle, environment: { ...bundle.environment, gateway: { HOME: "/tmp\nEVIL=1" } } };
    expect((await factoryRejection(target(execute).apply(injected))).code).toBe("deployment_environment_invalid");
    const lowercase = { ...bundle, environment: { ...bundle.environment, gateway: { home: "/tmp" } } };
    expect((await factoryRejection(target(execute).apply(lowercase))).code).toBe("deployment_environment_invalid");
    expect(execute.calls).toEqual([]);
  });

  test("recreate rewrites the env and recreates only the named services", async () => {
    const execute = fakeExecutor();
    await target(execute).recreate(bundle, ["gateway", "harness"]);
    expect(execute.calls.map((call) => composeArgs(call.command))).toEqual([["up", "--detach", "--no-build", "--no-deps", "gateway", "harness"]]);
    const failing = fakeExecutor(() => ({ code: 1, stdout: "", stderr: "boom" }));
    const error = await factoryRejection(target(failing).recreate(bundle, ["orchestrator"]));
    expect(error.code).toBe("deployment_compose_failed");
    expect(error.message).toContain("compose up orchestrator");
  });
});

describe("FactoryComposeTarget.ready", () => {
  const harness = (status: number) => ({ fetchStatus: async (url: string) => { expect(url).toBe("http://127.0.0.1:40010/api/ready"); return status; } });

  test("resolves once every container is healthy and the harness answers 200", async () => {
    const clock = virtualClock();
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined);
    await target(execute, { ...clock, ...harness(200) }).ready(bundle);
    expect(clock.slept).toEqual([]);
    expect(composeArgs(execute.calls[0]!.command)).toEqual(["ps", "--all", "--format", "json"]);
  });

  test("polls until ready", async () => {
    const clock = virtualClock();
    let polls = 0;
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: ++polls < 3 ? "" : HEALTHY, stderr: "" } : undefined);
    await target(execute, { ...clock, pollMs: 7, ...harness(200) }).ready(bundle);
    expect(clock.slept).toEqual([7, 7]);
  });

  test("a deadline names the first unhealthy container, then the harness", async () => {
    const clock = virtualClock();
    const stdout = HEALTHY.replace('"Service":"gateway","State":"running","Health":"healthy"', '"Service":"gateway","State":"running","Health":"starting"');
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout, stderr: "" } : undefined);
    const error = await factoryRejection(target(execute, { ...clock, readyTimeoutMs: 10, pollMs: 3, ...harness(200) }).ready(bundle));
    expect(error.code).toBe("deployment_not_ready");
    expect(error.message).toBe("Installation tenant-01 did not become ready; still waiting on gateway.");
    expect(clock.slept).toEqual([3, 3, 3, 3]);
    const healthy = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined);
    expect((await factoryRejection(target(healthy, { ...virtualClock(), readyTimeoutMs: 1, ...harness(503) }).ready(bundle))).message).toContain("still waiting on harness.");
  });

  test("the default deadline is ten minutes: an upgraded harness migrates before it answers", async () => {
    const clock = virtualClock();
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined);
    const error = await factoryRejection(target(execute, { ...clock, pollMs: 60_000, ...harness(503) }).ready(bundle));
    expect(error.code).toBe("deployment_not_ready");
    expect(clock.slept).toHaveLength(10);
  });

  test("a zero timeout never probes and names the harness", async () => {
    const execute = fakeExecutor();
    const error = await factoryRejection(target(execute, { ...virtualClock(), readyTimeoutMs: 0 }).ready(bundle));
    expect(error.message).toContain("still waiting on harness.");
    expect(execute.calls).toEqual([]);
  });

  test("a failed ps counts every container as not ready", async () => {
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 1, stdout: HEALTHY, stderr: "no such project" } : undefined);
    const error = await factoryRejection(target(execute, { ...virtualClock(), readyTimeoutMs: 1, ...harness(200) }).ready(bundle));
    expect(error.message).toContain("still waiting on gateway.");
  });

  test("a container that exited non-zero fails at once; an exited orchestrator does not", async () => {
    const exited = HEALTHY + "\n" + JSON.stringify({ Service: "gateway", State: "exited", Health: "", ExitCode: 3 });
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: exited, stderr: "" } : undefined);
    const error = await factoryRejection(target(execute, { ...virtualClock(), ...harness(200) }).ready(bundle));
    expect(error.code).toBe("deployment_service_exited");
    expect(error.message).toBe("Service gateway exited with 3.");

    const orchestrator = HEALTHY + "\n" + JSON.stringify({ Service: "orchestrator", State: "exited", Health: "", ExitCode: 1 }) + "\n" + JSON.stringify({ Service: "migrate", State: "exited", Health: "", ExitCode: 0 });
    const tolerant = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: orchestrator, stderr: "" } : undefined);
    await target(tolerant, { ...virtualClock(), ...harness(200) }).ready(bundle);
    expect(tolerant.calls.length).toBe(1);
  });

  test("the default probe fetches the real harness, and a refused harness is not ready", async () => {
    const seen: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { seen.push(new URL(request.url).pathname); return new Response("ok"); } });
    const healthy = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined);
    try {
      await target(healthy).ready({ ...bundle, ports: { ...bundle.ports, harness: server.port! } });
      expect(seen).toEqual(["/api/ready"]);
    } finally { await server.stop(true); }
    const error = await factoryRejection(target(healthy, { readyTimeoutMs: 30, pollMs: 1 }).ready({ ...bundle, ports: { ...bundle.ports, harness: server.port! } }));
    expect(error.message).toContain("still waiting on harness.");
  });
});

describe("FactoryComposeTarget.remove and purge", () => {
  const line = (call: { command: readonly string[] }) => call.command[0] === "docker" ? composeArgs(call.command).join(" ") : call.command.join(" ");
  const applied = async () => { await target(fakeExecutor()).writeEnvironment(bundle); return factoryDeploymentHandle(installation, join(root, "runtime")); };

  test("remove brings the project down, keeping data, and touches no systemd unit", async () => {
    const handle = await applied();
    const execute = fakeExecutor();
    await target(execute).remove(handle);
    expect(execute.calls.map(line)).toEqual(["down --remove-orphans --timeout 20"]);
    expect(execute.calls[0]!.command).toContain(join(handle.runtimeDirectory, "compose.env"));
  });

  test("an installation never applied has no env file, so nothing runs", async () => {
    const empty = await makeFactoryPrivateRoot();
    try {
      const execute = fakeExecutor();
      await target(execute).remove(factoryDeploymentHandle(installation, join(empty, "runtime")));
      expect(execute.calls).toEqual([]);
    } finally { await removeFactoryPrivateRoot(empty); }
  });

  test("a failed compose down is reported", async () => {
    const handle = await applied();
    const execute = fakeExecutor((command) => isCompose(command, "down") ? { code: 1, stdout: "", stderr: "cannot connect" } : undefined);
    const error = await factoryRejection(target(execute).remove(handle));
    expect(error.code).toBe("deployment_compose_failed");
    expect(error.message).toContain("compose down failed (1): cannot connect");
  });

  test("purge needs no rendered bundle: it stops everything and removes the runtime directory inside the user namespace", async () => {
    const purgeRoot = await makeFactoryPrivateRoot();
    try {
      // No database credential exists for this installation, so no bundle can render.
      const other = makeFactoryTestInstallation(purgeRoot, { tenantId: "tenant-05" });
      const handle = factoryDeploymentHandle(other, join(purgeRoot, "runtime"));
      await (await openFactoryPrivateDirectory(join(purgeRoot, "runtime"))).close();
      await (await openFactoryPrivateDirectory(handle.runtimeDirectory)).close();
      await writeModeFile(join(handle.runtimeDirectory, "compose.env"), "EZCORP_FACTORY_PROJECT=x\n");
      const execute = fakeExecutor();
      await target(execute).purge(handle);
      const commands = execute.calls.map((call) => call.command);
      expect(commands.filter((command) => command[0] === "docker").map((command) => composeArgs(command).join(" "))).toEqual(["down --remove-orphans --timeout 20"]);
      expect(commands.at(-1)).toEqual(["podman", "unshare", "rm", "-rf", "--", handle.runtimeDirectory]);
      expect(await access(handle.runtimeDirectory).then(() => true, () => false)).toBe(false);
      // Idempotent: a purge of an already purged installation still succeeds, and skips Compose.
      const again = fakeExecutor();
      await target(again).purge(handle);
      expect(again.calls.some((call) => call.command[0] === "docker")).toBe(false);
    } finally { await removeFactoryPrivateRoot(purgeRoot); }
  });

  test("a failed runtime removal stops the purge and keeps the runtime directory", async () => {
    const handle = await applied();
    const execute = fakeExecutor((command) => command[0] === "podman" ? { code: 1, stdout: "", stderr: "rm: cannot remove" } : undefined);
    const error = await factoryRejection(target(execute).purge(handle));
    expect(error.code).toBe("deployment_purge_failed");
    expect(error.message).toBe("remove the runtime directory failed (1): rm: cannot remove");
    expect(await access(handle.runtimeDirectory).then(() => true, () => false)).toBe(true);
  });
});

describe("FactoryComposeHostTarget", () => {
  const line = (call: { command: readonly string[] }) => call.command[0] === "docker" ? composeArgs(call.command).join(" ") : call.command[0] === "systemd-run" ? "run" : call.command.slice(0, 3).join(" ");
  const UNIT = "ezcorp-factory-supervisor-fleet-a.service";
  const readinessPath = (writer: string) => join(hostBundle.paths.readinessDirectory, writer, `${writer}.json`);

  test("apply writes the host env files privately, recreates the pool, and restarts the one supervisor on the host's build", async () => {
    const execute = fakeExecutor();
    await hostTarget(execute).apply(hostBundle);
    expect(execute.calls.map(line)).toEqual(["up --detach --no-build --force-recreate --remove-orphans", "systemctl --user stop", "systemctl --user reset-failed", "run"]);
    expect(execute.calls[0]!.command.slice(0, 8)).toEqual(["docker", "compose", "--project-name", "ezcorp-factory-fleet-a-host", "--file", HOST_TEMPLATE, "--env-file", join(hostBundle.paths.runtimeDirectory, "compose.env")]);
    expect(execute.calls[1]!.command).toEqual(["systemctl", "--user", "stop", UNIT]);
    expect(execute.calls[3]!.command).toEqual(factorySupervisorUnitArguments(hostBundle, SETTINGS, HOST_BUILD.release));
    for (const name of ["compose.env", "pool.env"]) expect((await stat(join(hostBundle.paths.runtimeDirectory, name))).mode & 0o777).toBe(0o600);
    const env = Object.fromEntries((await readFile(join(hostBundle.paths.runtimeDirectory, "compose.env"), "utf8")).trim().split("\n").map((entry) => entry.split("=", 2) as [string, string]));
    expect(env).toEqual({
      EZCORP_FACTORY_PROJECT: "ezcorp-factory-fleet-a-host", EZCORP_FACTORY_POOL_IMAGE: HOST_BUILD.image, EZCORP_FACTORY_REVISION: HOST_BUILD.revision,
      EZCORP_FACTORY_UID: "1001", EZCORP_FACTORY_GID: "1001", EZCORP_FACTORY_FLEET: "fleet-a", EZCORP_FACTORY_POOL_PORT: "41002",
      EZCORP_FACTORY_POOL_NETWORK: "pasta:-T,55432", EZCORP_FACTORY_DELIVER_POOL: hostBundle.paths.poolDelivery,
      EZCORP_FACTORY_READINESS_POOL: join(hostBundle.paths.readinessDirectory, "pool"), EZCORP_FACTORY_POOL_ENV: join(hostBundle.paths.runtimeDirectory, "pool.env"),
    });
    // Exactly the variables the host template interpolates.
    expect(Object.keys(env).sort()).toEqual(await interpolated(HOST_TEMPLATE));
    expect(await readFile(join(hostBundle.paths.runtimeDirectory, "pool.env"), "utf8")).toBe("HOME=/tmp\n");
  });

  test("a unit that is not loaded, or has nothing failed, counts as stopped", async () => {
    for (const [stop, reset] of [[5, 5], [0, 1], [5, 1]] as const) {
      const execute = fakeExecutor((command) => command[2] === "stop" ? { code: stop, stdout: "", stderr: "" } : command[2] === "reset-failed" ? { code: reset, stdout: "", stderr: "" } : undefined);
      await hostTarget(execute).apply(hostBundle);
      expect(execute.calls.map(line).at(-1)).toBe("run");
    }
  });

  test("a failed compose up, unit stop, or supervisor start is a named failure", async () => {
    const up = fakeExecutor((command) => isCompose(command, "up") ? { code: 125, stdout: "", stderr: "no image" } : undefined);
    const upError = await factoryRejection(hostTarget(up).apply(hostBundle));
    expect([upError.code, upError.message]).toEqual(["host_compose_failed", "host compose up failed (125): no image"]);
    expect(up.calls.some((call) => call.command[0] === "systemctl")).toBe(false);
    const stop = fakeExecutor((command) => command[2] === "stop" ? { code: 1, stdout: "", stderr: "Access denied" } : undefined);
    expect((await factoryRejection(hostTarget(stop).apply(hostBundle))).message).toBe(`stop ${UNIT} failed (1): Access denied`);
    const reset = fakeExecutor((command) => command[2] === "reset-failed" ? { code: 4, stdout: "", stderr: "denied" } : undefined);
    expect((await factoryRejection(hostTarget(reset).apply(hostBundle))).code).toBe("host_supervisor_failed");
    const run = fakeExecutor((command) => command[0] === "systemd-run" ? { code: 1, stdout: "", stderr: "Unit already exists" } : undefined);
    const runError = await factoryRejection(hostTarget(run).apply(hostBundle));
    expect([runError.code, runError.message]).toEqual(["host_supervisor_failed", "start the host supervisor failed (1): Unit already exists"]);
  });

  test("an env value holding a newline is refused before Compose runs", async () => {
    const execute = fakeExecutor();
    const injected: FactoryFleetHostBundle = { ...hostBundle, build: { ...HOST_BUILD, image: "a\nEVIL=1" } };
    expect((await factoryRejection(hostTarget(execute).apply(injected))).code).toBe("deployment_environment_invalid");
    expect(execute.calls).toEqual([]);
  });

  test("ready resolves once both records are fresh and written after the wait began", async () => {
    const records = new Map([["pool", JSON.stringify({ lifecycle: "ready", observedAtMs: 0 })], ["supervisor", JSON.stringify({ lifecycle: "ready", observedAtMs: 0 })]]);
    const clock = virtualClock();
    await hostTarget(fakeExecutor(), { ...clock, readReadiness: async (path) => records.get(path.endsWith("pool.json") ? "pool" : "supervisor") }).ready(hostBundle);
    expect(clock.slept).toEqual([]);
  });

  test("a deadline names the pool first, then the supervisor; a record from before the wait does not count", async () => {
    const fresh = JSON.stringify({ lifecycle: "ready", observedAtMs: 10 });
    const old = JSON.stringify({ lifecycle: "ready", observedAtMs: 5 });
    const run = async (pool: string | undefined, supervisor: string | undefined) => factoryRejection(hostTarget(fakeExecutor(), { ...virtualClock(10), readyTimeoutMs: 4, pollMs: 2, readReadiness: async (path) => {
      expect([readinessPath("pool"), readinessPath("supervisor")]).toContain(path);
      return path.endsWith("pool.json") ? pool : supervisor;
    } }).ready(hostBundle));
    const missing = await run(undefined, fresh);
    expect([missing.code, missing.message]).toEqual(["host_not_ready", "The fleet host did not become ready; still waiting on pool."]);
    expect((await run(fresh, '{"lifecycle":"starting","observedAtMs":10}')).message).toContain("still waiting on supervisor.");
    expect((await run(old, fresh)).message).toContain("still waiting on pool.");
    const zero = await factoryRejection(hostTarget(fakeExecutor(), { ...virtualClock(), readyTimeoutMs: 0 }).ready(hostBundle));
    expect(zero.message).toContain("still waiting on pool.");
  });

  test("the default reader reads the real record files; a missing one is not ready", async () => {
    for (const writer of ["pool", "supervisor"]) {
      await (await openFactoryPrivateDirectory(join(hostBundle.paths.readinessDirectory))).close();
      await (await openFactoryPrivateDirectory(join(hostBundle.paths.readinessDirectory, writer))).close();
    }
    await writeModeFile(readinessPath("pool"), JSON.stringify({ lifecycle: "ready", observedAtMs: Date.now() + 1_000 }));
    const missing = await factoryRejection(hostTarget(fakeExecutor(), { readyTimeoutMs: 20, pollMs: 1 }).ready(hostBundle));
    expect(missing.message).toContain("still waiting on supervisor.");
    await writeModeFile(readinessPath("supervisor"), JSON.stringify({ lifecycle: "ready", observedAtMs: Date.now() + 1_000 }));
    await hostTarget(fakeExecutor(), { pollMs: 1 }).ready(hostBundle);
  });

  test("remove stops the unit and brings the host project down; a host never applied only checks its unit", async () => {
    const execute = fakeExecutor();
    await hostTarget(execute).remove(hostBundle.paths);
    expect(execute.calls.map(line)).toEqual(["systemctl --user stop", "systemctl --user reset-failed", "down --remove-orphans --timeout 20"]);
    const never = factoryFleetHostPaths("fleet-a", { secretsRoot: join(root, "none"), operatorRoot: join(root, "none"), runtimeRoot: join(root, "none-runtime") });
    const bare = fakeExecutor();
    await hostTarget(bare).remove(never);
    expect(bare.calls.map(line)).toEqual(["systemctl --user stop", "systemctl --user reset-failed"]);
    const down = fakeExecutor((command) => isCompose(command, "down") ? { code: 1, stdout: "", stderr: "gone" } : undefined);
    expect((await factoryRejection(hostTarget(down).remove(hostBundle.paths))).message).toBe("host compose down failed (1): gone");
  });

  test("purge removes the host's runtime directory inside the user namespace, and names a failure", async () => {
    const execute = fakeExecutor();
    await hostTarget(execute).purge(hostBundle.paths);
    expect(execute.calls.at(-1)!.command).toEqual(["podman", "unshare", "rm", "-rf", "--", hostBundle.paths.runtimeDirectory]);
    const failing = fakeExecutor((command) => command[0] === "podman" ? { code: 1, stdout: "", stderr: "busy" } : undefined);
    const error = await factoryRejection(hostTarget(failing).purge(hostBundle.paths));
    expect([error.code, error.message]).toEqual(["host_purge_failed", "remove the host runtime directory failed (1): busy"]);
  });
});

describe("FactoryComposeUpgradeTarget", () => {
  const build = (component: string) => ({ buildId: `${component}-2`, image: `registry.test/${component}@sha256:${"f".repeat(64)}`, revision: "a".repeat(40), releaseDirectory: `/srv/releases/${component}` });
  const BUILDS: FactoryInstallationBuilds = { host: build("host"), orchestrator: build("orchestrator"), harness: build("harness") };
  const healthy = (command: readonly string[]) => isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined;
  const summary = (execute: ReturnType<typeof fakeExecutor>) => execute.calls.map((call) => composeArgs(call.command).filter((arg) => !arg.startsWith("--")).join(" "));
  const upgrade = (execute: FactoryCommandExecutor, rendered: string[], used: FactoryFleetHostBuild[]) => new FactoryComposeUpgradeTarget(async (value) => { rendered.push(value.tenantId); return bundle; }, target(execute, { ...virtualClock(), fetchStatus: async () => 200 }), { async useBuild(value) { used.push(value); } });

  test("the host component moves the fleet host onto the build and touches no installation service", async () => {
    const execute = fakeExecutor(healthy);
    const rendered: string[] = [];
    const used: FactoryFleetHostBuild[] = [];
    await upgrade(execute, rendered, used).apply(installation, "host", BUILDS);
    expect(used).toEqual([{ image: BUILDS.host.image, revision: BUILDS.host.revision, release: "/srv/releases/host" }]);
    expect(rendered).toEqual([]);
    expect(execute.calls).toEqual([]);
  });

  test("the orchestrator and harness components recreate only their own services", async () => {
    for (const [component, services] of [["orchestrator", "up orchestrator"], ["harness", "up gateway harness"]] as const) {
      const execute = fakeExecutor(healthy);
      const used: FactoryFleetHostBuild[] = [];
      await upgrade(execute, [], used).apply(installation, component, BUILDS);
      expect(summary(execute)).toEqual([services]);
      expect(FACTORY_COMPOSE_UPGRADE_SERVICES[component].join(" ")).toBe(services.slice(3));
      expect(used).toEqual([]);
    }
  });

  test("ready re-renders and proves the installation ready", async () => {
    const execute = fakeExecutor(healthy);
    const rendered: string[] = [];
    await upgrade(execute, rendered, []).ready(installation);
    expect(rendered).toEqual(["tenant-01"]);
    expect(summary(execute)).toEqual(["ps json"]);
  });
});

describe("factorySpawnExecutor", () => {
  test("a zero exit is code 0", async () => {
    expect(await factorySpawnExecutor(["true"])).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("a non-zero exit is returned, never thrown", async () => {
    expect((await factorySpawnExecutor(["false"])).code).toBe(1);
  });

  test("captures stdout and stderr separately with the exit code", async () => {
    expect(await factorySpawnExecutor(["sh", "-c", "echo out; echo err >&2; exit 3"])).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });

  test("passes the extra environment and working directory", async () => {
    const result = await factorySpawnExecutor(["sh", "-c", "printf '%s|' \"$FACTORY_TEST_VALUE\"; pwd"], { env: { FACTORY_TEST_VALUE: "scoped" }, cwd: root });
    expect(result).toEqual({ code: 0, stdout: `scoped|${root}\n`, stderr: "" });
  });
});

describe("the Compose templates parse and hold the hardening", () => {
  const parse = async (name: string) => Bun.YAML.parse(await Bun.file(join(REPOSITORY, "deploy/factory/compose", name)).text()) as { services: Record<string, Record<string, unknown>> };

  test("the harness has a writable /app/.ezcorp from its own app-state directory; nothing else writes under /app", async () => {
    const { services } = await parse("installation.yml");
    const appMounts = (name: string) => (services[name]!.volumes as { source: string; target: string; read_only?: boolean }[]).filter((volume) => volume.target.startsWith("/app"));
    expect(appMounts("harness")).toEqual([{ type: "bind", source: `\${EZCORP_FACTORY_HARNESS_APP_STATE:?}`, target: "/app/.ezcorp", bind: { create_host_path: false } } as never]);
    expect([...appMounts("gateway"), ...appMounts("orchestrator")]).toEqual([]);
  });
  const hardened = (name: string, service: Record<string, unknown>) => {
    expect({ name, readOnly: service.read_only, capDrop: service.cap_drop, privileged: service.privileged, devices: service.devices }).toEqual({ name, readOnly: true, capDrop: ["ALL"], privileged: undefined, devices: undefined });
    expect(service.healthcheck).toBeDefined();
    for (const limit of ["mem_limit", "cpus", "pids_limit"]) expect(service[limit]).toBeDefined();
    expect(JSON.stringify(service.volumes)).not.toMatch(/\.sock/);
    expect(service.env_file).toEqual([expect.stringMatching(/^\$\{EZCORP_FACTORY_[A-Z]+_ENV:\?\}$/)]);
  };

  test("every installation service is read-only, drops all capabilities, is bounded, has a health check, and holds no device or runtime socket; the pool is not an installation's", async () => {
    const { services } = await parse("installation.yml");
    expect(Object.keys(services).sort()).toEqual(["gateway", "harness", "orchestrator"]);
    for (const [name, service] of Object.entries(services)) hardened(name, service);
  });

  test("the harness's stop grace outlasts its own shutdown hard timeout, so a slow drain is never cut by SIGKILL", async () => {
    const { HARD_TIMEOUT_MS } = await import("../../../web/src/lib/server/shutdown");
    const { services } = await parse("installation.yml");
    const seconds = (value: unknown) => Number(/^(\d+)s$/.exec(String(value))?.[1] ?? Number.NaN);
    expect(seconds(services.harness!.stop_grace_period) * 1_000).toBeGreaterThan(HARD_TIMEOUT_MS);
  });

  test("the host template runs the one shared pool, hardened the same way", async () => {
    const { services } = await parse("host.yml");
    expect(Object.keys(services)).toEqual(["pool"]);
    hardened("pool", services.pool!);
    expect(services.pool!.userns_mode).toBe("keep-id");
  });

  test("the orchestrator writes only its own readiness directory; the harness reads its own and the host's three, read-only; the pool writes only its own", async () => {
    const readiness = (services: Record<string, Record<string, unknown>>, name: string) => (services[name]!.volumes as { target: string; read_only?: boolean }[]).filter((volume) => volume.target.startsWith("/run/ezcorp/readiness")).map((volume) => [volume.target, volume.read_only ?? false]);
    const { services } = await parse("installation.yml");
    expect(readiness(services, "orchestrator")).toEqual([["/run/ezcorp/readiness/orchestration", false]]);
    expect(readiness(services, "harness")).toEqual([["/run/ezcorp/readiness/orchestration", true], ["/run/ezcorp/readiness/pool", true], ["/run/ezcorp/readiness/supervisor", true]]);
    expect(readiness((await parse("host.yml")).services, "pool")).toEqual([["/run/ezcorp/readiness/pool", false]]);
  });

  test("the platform template parses", async () => {
    const { services } = await parse("platform.yml");
    expect(Object.keys(services).length).toBeGreaterThan(0);
  });
});
