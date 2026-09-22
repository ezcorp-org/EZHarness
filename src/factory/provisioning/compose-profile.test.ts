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
  FactoryComposeTarget,
  FactoryComposeUpgradeTarget,
  factoryComposeEnvironment,
  factoryComposeProject,
  factoryPastaNetwork,
  factorySpawnExecutor,
  factorySupervisorUnit,
  factorySupervisorUnitArguments,
  parseComposePs,
  type FactoryCommandExecutor,
  type FactoryCommandResult,
  type FactoryComposeTargetOptions,
} from "./compose-profile";
import { factoryDeploymentHandle, renderFactoryInstallationBundle, type FactoryInstallationBundle } from "./deployment";
import type { FactoryInstallationContext } from "./installation";
import { openFactoryPrivateDirectory } from "./secret-files";

const REPOSITORY = resolve(import.meta.dir, "../../..");
const TEMPLATE = join(REPOSITORY, "deploy/factory/compose/installation.yml");
const SUPERVISOR_UNIT_FILE = join(REPOSITORY, "deploy/factory/systemd/ezcorp-factory-supervisor@.service");
const SETTINGS = { bun: "/opt/bun/bin/bun", releaseDirectory: "/srv/release/current", path: "/usr/bin:/bin" };
const PORTS = { databasePort: 55432, storagePorts: [59001, 59000, 59000], temporalPort: 57233, uid: 1001, gid: 1001 };
const OK: FactoryCommandResult = { code: 0, stdout: "", stderr: "" };
const HEALTHY = ["pool", "gateway", "harness", "orchestrator"].map((service) => JSON.stringify({ Service: service, State: "running", Health: "healthy", ExitCode: 0 })).join("\n");
/** Written at virtual time 0, so it is fresh for every virtual clock below. */
const SUPERVISOR_READY = JSON.stringify({ lifecycle: "ready", observedAtMs: 0 });

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

function target(execute: FactoryCommandExecutor, overrides: Partial<FactoryComposeTargetOptions> = {}): FactoryComposeTarget {
  return new FactoryComposeTarget({
    compose: { argv: ["docker", "compose"], env: { DOCKER_HOST: "unix:///run/user/1001/podman/podman.sock" } },
    templatePath: TEMPLATE, execute, supervisor: SETTINGS, ...PORTS, ...overrides,
  });
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

beforeAll(async () => {
  root = await makeFactoryPrivateRoot();
  installation = makeFactoryTestInstallation(root);
  await writeFactoryTestDatabaseCredentials(installation);
  bundle = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime")));
});
afterAll(async () => { await removeFactoryPrivateRoot(root); });

describe("names", () => {
  test("the Compose project and supervisor unit are scoped by fleet and tenant", () => {
    expect(factoryComposeProject({ fleetId: "fleet-a", tenantId: "tenant-01" })).toBe("ezcorp-factory-fleet-a-tenant-01");
    expect(factorySupervisorUnit({ fleetId: "fleet-a", tenantId: "tenant-01" })).toBe("ezcorp-factory-supervisor-fleet-a-tenant-01.service");
    expect(factoryComposeProject({ fleetId: "fleet-b", tenantId: "tenant-01" })).not.toBe(factoryComposeProject({ fleetId: "fleet-a", tenantId: "tenant-01" }));
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

describe("factoryComposeEnvironment", () => {
  const envFiles = { pool: "/r/pool.env", gateway: "/r/gateway.env", harness: "/r/harness.env", orchestrator: "/r/orchestrator.env" };

  test("defines every variable the pinned Compose template interpolates", async () => {
    const template = await readFile(TEMPLATE, "utf8");
    const referenced = [...new Set([...template.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((match) => match[1]!))].sort();
    expect(referenced.length).toBeGreaterThan(20);
    const environment = factoryComposeEnvironment(bundle, PORTS, envFiles);
    expect(referenced.filter((name) => !(name in environment))).toEqual([]);
  });

  test("carries references only: identities, ports, paths, images, and each service's network allowance", () => {
    const environment = factoryComposeEnvironment(bundle, PORTS, envFiles);
    expect(environment).toMatchObject({
      EZCORP_FACTORY_PROJECT: "ezcorp-factory-fleet-a-tenant-01",
      EZCORP_FACTORY_IMAGE: bundle.image.reference,
      EZCORP_FACTORY_UID: "1001",
      EZCORP_FACTORY_TENANT: "tenant-01",
      EZCORP_FACTORY_HARNESS_PORT: "40010",
      EZCORP_FACTORY_POOL_NETWORK: "pasta:-T,55432",
      EZCORP_FACTORY_GATEWAY_NETWORK: "pasta:-T,55432",
      EZCORP_FACTORY_HARNESS_NETWORK: "pasta:-T,40012,-T,40013,-T,40014,-T,55432,-T,59000,-T,59001",
      EZCORP_FACTORY_ORCHESTRATOR_NETWORK: "pasta:-T,40011,-T,57233",
      EZCORP_FACTORY_DELIVER_HARNESS: bundle.deliveries.harness.directory,
      EZCORP_FACTORY_HARNESS_ENV: "/r/harness.env",
    });
    expect(Object.isFrozen(environment)).toBe(true);
    // The supervisor's delivery is never handed to a container.
    expect(Object.values(environment)).not.toContain(bundle.deliveries.supervisor.directory);
  });
});

describe("factorySupervisorUnitArguments", () => {
  const MIRRORED = ["Restart", "RestartSec", "KillMode", "Delegate", "UMask", "TimeoutStopSec", "MemoryMax", "TasksMax"];

  test("mirrors every service property of the installed systemd unit", async () => {
    const unit = await readFile(SUPERVISOR_UNIT_FILE, "utf8");
    const installed = Object.fromEntries(unit.split("\n").map((line) => /^([A-Za-z]+)=(.*)$/.exec(line)).filter((match) => match !== null).map((match) => [match![1]!, match![2]!]));
    const transient = Object.fromEntries(factorySupervisorUnitArguments(bundle, SETTINGS).filter((arg) => arg.startsWith("--property=")).map((arg) => arg.slice("--property=".length).split("=") as [string, string]));
    for (const property of MIRRORED) {
      expect(installed[property]).toBeDefined();
      expect(transient[property]).toBe(installed[property]);
    }
  });

  test("runs the supervisor process on its own delivered config in the fleet release", () => {
    const args = factorySupervisorUnitArguments(bundle, SETTINGS);
    expect(args.slice(0, 4)).toEqual(["systemd-run", "--user", "--collect", "--unit=ezcorp-factory-supervisor-fleet-a-tenant-01.service"]);
    expect(args).toContain("--working-directory=/srv/release/current");
    expect(args).toContain("--setenv=PATH=/usr/bin:/bin");
    expect(args.slice(-3)).toEqual(["/opt/bun/bin/bun", "src/factory/runner/supervisor-process.ts", join(bundle.deliveries.supervisor.directory, "supervisor.json")]);
  });

  test("a host upgrade moves the working directory to the build's release", () => {
    const upgraded = { ...bundle, images: { ...bundle.images, supervisorRelease: "/srv/release/next" } };
    expect(factorySupervisorUnitArguments(upgraded, SETTINGS)).toContain("--working-directory=/srv/release/next");
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

describe("FactoryComposeTarget.apply and startSupervisor", () => {
  test("writes private env files, brings the project up, starts the supervisor, and returns references", async () => {
    const execute = fakeExecutor((command) => command[2] === "is-active" ? { code: 3, stdout: "inactive\n", stderr: "" } : undefined);
    const resources = await target(execute).apply(bundle);
    expect(resources).toEqual({ composeProject: "ezcorp-factory-fleet-a-tenant-01", supervisorUnit: "ezcorp-factory-supervisor-fleet-a-tenant-01.service", template: TEMPLATE });
    const commands = execute.calls.map((call) => call.command);
    expect(commands[0]).toEqual(["docker", "compose", "--project-name", "ezcorp-factory-fleet-a-tenant-01", "--file", TEMPLATE, "--env-file", join(bundle.runtimeDirectory, "compose.env"), "up", "--detach", "--no-build", "--remove-orphans"]);
    expect(execute.calls[0]!.env).toEqual({ DOCKER_HOST: "unix:///run/user/1001/podman/podman.sock" });
    expect(commands.slice(1).map((command) => command.slice(0, 3))).toEqual([["systemctl", "--user", "is-active"], ["systemctl", "--user", "reset-failed"], ["systemd-run", "--user", "--collect"]]);
    for (const name of ["compose.env", "pool.env", "gateway.env", "harness.env", "orchestrator.env"]) expect((await stat(join(bundle.runtimeDirectory, name))).mode & 0o777).toBe(0o600);
    const composeEnv = await readFile(join(bundle.runtimeDirectory, "compose.env"), "utf8");
    expect(composeEnv).toContain("EZCORP_FACTORY_PROJECT=ezcorp-factory-fleet-a-tenant-01\n");
    expect(composeEnv).toContain(`EZCORP_FACTORY_HARNESS_ENV=${join(bundle.runtimeDirectory, "harness.env")}\n`);
    expect(await readFile(join(bundle.runtimeDirectory, "harness.env"), "utf8")).toContain("EZCORP_FACTORY_ENABLED=1\n");
  });

  test("an already active supervisor is left running", async () => {
    const execute = fakeExecutor((command) => command[2] === "is-active" ? { code: 0, stdout: "active\n", stderr: "" } : undefined);
    await target(execute).startSupervisor(bundle);
    expect(execute.calls.map((call) => call.command[2])).toEqual(["is-active"]);
  });

  test("restart stops an active supervisor and starts it again", async () => {
    const execute = fakeExecutor((command) => command[2] === "is-active" ? { code: 0, stdout: "active\n", stderr: "" } : undefined);
    await target(execute).startSupervisor(bundle, true);
    expect(execute.calls.map((call) => call.command[0] === "systemd-run" ? "run" : call.command[2])).toEqual(["is-active", "stop", "reset-failed", "run"]);
  });

  test("a compose failure names the step and the tail of its stderr", async () => {
    const stderr = "line 1\nline 2\nline 3\nimage not found\n";
    const execute = fakeExecutor((command) => isCompose(command, "up") ? { code: 125, stdout: "", stderr } : undefined);
    const error = await factoryRejection(target(execute).apply(bundle));
    expect(error.code).toBe("deployment_compose_failed");
    expect(error.message).toBe("compose up failed (125): line 2 | line 3 | image not found");
    expect(execute.calls.some((call) => call.command[0] === "systemd-run")).toBe(false);
  });

  test("a supervisor that will not start is a named failure", async () => {
    const execute = fakeExecutor((command) => command[0] === "systemd-run" ? { code: 1, stdout: "", stderr: "Unit already exists" } : command[2] === "is-active" ? { code: 3, stdout: "failed", stderr: "" } : undefined);
    const error = await factoryRejection(target(execute).startSupervisor(bundle));
    expect(error.code).toBe("deployment_supervisor_failed");
    expect(error.message).toContain("Unit already exists");
  });

  test("an environment value holding a newline is refused before Compose runs", async () => {
    const execute = fakeExecutor();
    const injected = { ...bundle, environment: { ...bundle.environment, pool: { HOME: "/tmp\nEVIL=1" } } };
    expect((await factoryRejection(target(execute).apply(injected))).code).toBe("deployment_environment_invalid");
    const lowercase = { ...bundle, environment: { ...bundle.environment, pool: { home: "/tmp" } } };
    expect((await factoryRejection(target(execute).apply(lowercase))).code).toBe("deployment_environment_invalid");
    expect(execute.calls).toEqual([]);
  });

  test("recreate rewrites the env and recreates only the named services", async () => {
    const execute = fakeExecutor();
    await target(execute).recreate(bundle, ["gateway", "harness"]);
    expect(execute.calls.map((call) => composeArgs(call.command))).toEqual([["up", "--detach", "--no-build", "--no-deps", "gateway", "harness"]]);
    const failing = fakeExecutor(() => ({ code: 1, stdout: "", stderr: "boom" }));
    const error = await factoryRejection(target(failing).recreate(bundle, ["pool"]));
    expect(error.code).toBe("deployment_compose_failed");
    expect(error.message).toContain("compose up pool");
  });
});

describe("FactoryComposeTarget.ready", () => {
  const probes = (supervisor: string | undefined, harness: number) => ({ readReadiness: async (path: string) => { expect(path).toBe(join(bundle.readinessDirectory, "supervisor", "supervisor.json")); return supervisor; }, fetchStatus: async (url: string) => { expect(url).toBe("http://127.0.0.1:40010/api/ready"); return harness; } });

  test("resolves once every container is healthy, the supervisor says ready, and the harness answers 200", async () => {
    const clock = virtualClock();
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined);
    await target(execute, { ...clock, ...probes(SUPERVISOR_READY, 200) }).ready(bundle);
    expect(clock.slept).toEqual([]);
    expect(composeArgs(execute.calls[0]!.command)).toEqual(["ps", "--all", "--format", "json"]);
  });

  test("polls until ready", async () => {
    const clock = virtualClock();
    let polls = 0;
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: ++polls < 3 ? "" : HEALTHY, stderr: "" } : undefined);
    await target(execute, { ...clock, pollMs: 7, ...probes(SUPERVISOR_READY, 200) }).ready(bundle);
    expect(clock.slept).toEqual([7, 7]);
  });

  test("a deadline names the first unhealthy container", async () => {
    const clock = virtualClock();
    const stdout = HEALTHY.replace('"Service":"gateway","State":"running","Health":"healthy"', '"Service":"gateway","State":"running","Health":"starting"');
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout, stderr: "" } : undefined);
    const error = await factoryRejection(target(execute, { ...clock, readyTimeoutMs: 10, pollMs: 3, ...probes(SUPERVISOR_READY, 200) }).ready(bundle));
    expect(error.code).toBe("deployment_not_ready");
    expect(error.message).toBe("Installation tenant-01 did not become ready; still waiting on gateway.");
    expect(clock.slept).toEqual([3, 3, 3, 3]);
  });

  test("a deadline names the supervisor when only its readiness is missing, then the harness", async () => {
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined);
    const supervisor = await factoryRejection(target(execute, { ...virtualClock(), readyTimeoutMs: 1, ...probes('{"lifecycle":"starting"}', 200) }).ready(bundle));
    expect(supervisor.message).toContain("still waiting on supervisor.");
    const missing = await factoryRejection(target(execute, { ...virtualClock(), readyTimeoutMs: 1, ...probes(undefined, 200) }).ready(bundle));
    expect(missing.message).toContain("still waiting on supervisor.");
    const stale = await factoryRejection(target(execute, { ...virtualClock(60_001), readyTimeoutMs: 1, ...probes(SUPERVISOR_READY, 200) }).ready(bundle));
    expect(stale.message).toContain("still waiting on supervisor.");
    const harness = await factoryRejection(target(execute, { ...virtualClock(), readyTimeoutMs: 1, ...probes(SUPERVISOR_READY, 503) }).ready(bundle));
    expect(harness.message).toContain("still waiting on harness.");
  });

  test("a zero timeout never probes and names the harness", async () => {
    const execute = fakeExecutor();
    const error = await factoryRejection(target(execute, { ...virtualClock(), readyTimeoutMs: 0 }).ready(bundle));
    expect(error.message).toContain("still waiting on harness.");
    expect(execute.calls).toEqual([]);
  });

  test("a failed ps counts every container as not ready", async () => {
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 1, stdout: HEALTHY, stderr: "no such project" } : undefined);
    const error = await factoryRejection(target(execute, { ...virtualClock(), readyTimeoutMs: 1, ...probes(SUPERVISOR_READY, 200) }).ready(bundle));
    expect(error.message).toContain("still waiting on pool.");
  });

  test("a container that exited non-zero fails at once; an exited orchestrator does not", async () => {
    const exited = HEALTHY + "\n" + JSON.stringify({ Service: "gateway", State: "exited", Health: "", ExitCode: 3 });
    const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: exited, stderr: "" } : undefined);
    const error = await factoryRejection(target(execute, { ...virtualClock(), ...probes(SUPERVISOR_READY, 200) }).ready(bundle));
    expect(error.code).toBe("deployment_service_exited");
    expect(error.message).toBe("Service gateway exited with 3.");

    const orchestrator = HEALTHY + "\n" + JSON.stringify({ Service: "orchestrator", State: "exited", Health: "", ExitCode: 1 }) + "\n" + JSON.stringify({ Service: "migrate", State: "exited", Health: "", ExitCode: 0 });
    const tolerant = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: orchestrator, stderr: "" } : undefined);
    await target(tolerant, { ...virtualClock(), ...probes(SUPERVISOR_READY, 200) }).ready(bundle);
    expect(tolerant.calls.length).toBe(1);
  });

  test("the default probes read the real readiness file and fetch the real harness", async () => {
    const readiness = await openFactoryPrivateDirectory(join(bundle.readinessDirectory, "supervisor"));
    await readiness.close();
    await writeModeFile(join(bundle.readinessDirectory, "supervisor", "supervisor.json"), JSON.stringify({ lifecycle: "ready", observedAtMs: Date.now() }));
    const seen: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { seen.push(new URL(request.url).pathname); return new Response("ok"); } });
    try {
      const local = { ...bundle, ports: { ...bundle.ports, harness: server.port! } };
      const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined);
      await target(execute).ready(local);
      expect(seen).toEqual(["/api/ready"]);
    } finally { await server.stop(true); }
  });

  test("the default probes treat a missing readiness file and a refused harness as not ready", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const closedPort = server.port!;
    await server.stop(true);
    const empty = await makeFactoryPrivateRoot();
    try {
      const local = { ...bundle, readinessDirectory: empty, ports: { ...bundle.ports, harness: closedPort } };
      const execute = fakeExecutor((command) => isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined);
      const error = await factoryRejection(target(execute, { readyTimeoutMs: 30, pollMs: 1 }).ready(local));
      expect(error.code).toBe("deployment_not_ready");
      expect(error.message).toContain("still waiting on supervisor.");
    } finally { await removeFactoryPrivateRoot(empty); }
  });
});

describe("FactoryComposeTarget.remove and purge", () => {
  const line = (call: { command: readonly string[] }) => call.command[0] === "docker" ? composeArgs(call.command).join(" ") : call.command.join(" ");
  const unit = "ezcorp-factory-supervisor-fleet-a-tenant-01.service";
  const applied = async () => { await target(fakeExecutor()).writeEnvironment(bundle); return factoryDeploymentHandle(installation, join(root, "runtime")); };

  test("remove stops the supervisor unit and brings the project down, keeping data", async () => {
    const handle = await applied();
    const execute = fakeExecutor();
    await target(execute).remove(handle);
    expect(execute.calls.map(line)).toEqual([
      `systemctl --user stop ${unit}`,
      `systemctl --user reset-failed ${unit}`,
      "down --remove-orphans --timeout 20",
    ]);
    expect(execute.calls[2]!.command).toContain(join(handle.runtimeDirectory, "compose.env"));
  });

  test("a unit that is not loaded or has nothing failed counts as stopped", async () => {
    const handle = await applied();
    for (const [stop, reset] of [[5, 5], [0, 1], [5, 1]] as const) {
      const execute = fakeExecutor((command) => command[2] === "stop" ? { code: stop, stdout: "", stderr: "" } : command[2] === "reset-failed" ? { code: reset, stdout: "", stderr: "" } : undefined);
      await target(execute).remove(handle);
      expect(execute.calls.map(line).at(-1)).toBe("down --remove-orphans --timeout 20");
    }
  });

  test("a failed unit stop or reset is reported before Compose runs", async () => {
    const handle = await applied();
    const stop = fakeExecutor((command) => command[2] === "stop" ? { code: 1, stdout: "", stderr: "line1\nAccess denied" } : undefined);
    const stopped = await factoryRejection(target(stop).remove(handle));
    expect(stopped.code).toBe("deployment_supervisor_failed");
    expect(stopped.message).toBe(`stop ${unit} failed (1): line1 | Access denied`);
    expect(stop.calls).toHaveLength(1);
    const reset = fakeExecutor((command) => command[2] === "reset-failed" ? { code: 4, stdout: "", stderr: "denied" } : undefined);
    expect((await factoryRejection(target(reset).remove(handle))).message).toBe(`reset-failed ${unit} failed (4): denied`);
    expect(reset.calls.some((call) => call.command[0] === "docker")).toBe(false);
  });

  test("an installation never applied has no env file, so only its unit is checked", async () => {
    const empty = await makeFactoryPrivateRoot();
    try {
      const execute = fakeExecutor();
      await target(execute).remove(factoryDeploymentHandle(installation, join(empty, "runtime")));
      expect(execute.calls.map(line)).toEqual([`systemctl --user stop ${unit}`, `systemctl --user reset-failed ${unit}`]);
    } finally { await removeFactoryPrivateRoot(empty); }
  });

  test("a failed compose down is reported", async () => {
    const handle = await applied();
    const execute = fakeExecutor((command) => isCompose(command, "down") ? { code: 1, stdout: "", stderr: "cannot connect" } : undefined);
    const error = await factoryRejection(target(execute).remove(handle));
    expect(error.code).toBe("deployment_compose_failed");
    expect(error.message).toContain("compose down failed (1): cannot connect");
  });

  test("purge needs no rendered bundle: it stops everything, removes the runner root inside the user namespace, and the runtime directory", async () => {
    const purgeRoot = await makeFactoryPrivateRoot();
    try {
      // No database credential exists for this installation, so no bundle can render.
      const other = makeFactoryTestInstallation(purgeRoot, { tenantId: "tenant-05" });
      const handle = factoryDeploymentHandle(other, join(purgeRoot, "runtime"));
      const directory = await openFactoryPrivateDirectory(handle.runtimeDirectory);
      await directory.close();
      await writeModeFile(join(handle.runtimeDirectory, "compose.env"), "EZCORP_FACTORY_PROJECT=x\n");
      const execute = fakeExecutor();
      await target(execute).purge(handle);
      const commands = execute.calls.map((call) => call.command);
      expect(commands.filter((command) => command[0] === "docker").map((command) => composeArgs(command).join(" "))).toEqual(["down --remove-orphans --timeout 20"]);
      expect(commands.at(-1)).toEqual(["podman", "unshare", "rm", "-rf", "--", handle.runnerRoot]);
      expect(await access(handle.runtimeDirectory).then(() => true, () => false)).toBe(false);
      // Idempotent: a purge of an already purged installation still succeeds, and skips Compose.
      const again = fakeExecutor();
      await target(again).purge(handle);
      expect(again.calls.some((call) => call.command[0] === "docker")).toBe(false);
    } finally { await removeFactoryPrivateRoot(purgeRoot); }
  });

  test("a failed runner-root removal stops the purge and keeps the runtime directory", async () => {
    const handle = await applied();
    const execute = fakeExecutor((command) => command[0] === "podman" ? { code: 1, stdout: "", stderr: "rm: cannot remove" } : undefined);
    const error = await factoryRejection(target(execute).purge(handle));
    expect(error.code).toBe("deployment_purge_failed");
    expect(error.message).toBe("remove the runner root failed (1): rm: cannot remove");
    expect(await access(handle.runtimeDirectory).then(() => true, () => false)).toBe(true);
  });
});

describe("FactoryComposeUpgradeTarget", () => {
  const upgrade = (execute: FactoryCommandExecutor, rendered: string[]) => new FactoryComposeUpgradeTarget(async (value) => { rendered.push(value.tenantId); return bundle; }, target(execute, { ...virtualClock() }));
  const activeSupervisor = (command: readonly string[]) => command[2] === "is-active" ? { code: 0, stdout: "active\n", stderr: "" } : isCompose(command, "ps") ? { code: 0, stdout: HEALTHY, stderr: "" } : undefined;
  const summary = (execute: ReturnType<typeof fakeExecutor>) => execute.calls.map((call) => call.command[0] === "docker" ? composeArgs(call.command).filter((arg) => !arg.startsWith("--")).join(" ") : call.command[0] === "systemd-run" ? "run" : call.command[2]!);

  test("the host component recreates the pool and restarts the supervisor onto its release", async () => {
    const execute = fakeExecutor(activeSupervisor);
    const rendered: string[] = [];
    await upgrade(execute, rendered).apply(installation, "host");
    expect(rendered).toEqual(["tenant-01"]);
    expect(summary(execute)).toEqual(["up pool", "is-active", "stop", "reset-failed", "run"]);
  });

  test("the orchestrator and harness components never touch the supervisor", async () => {
    for (const [component, services] of [["orchestrator", "up orchestrator"], ["harness", "up gateway harness"]] as const) {
      const execute = fakeExecutor(activeSupervisor);
      await upgrade(execute, []).apply(installation, component);
      expect(summary(execute)).toEqual([services]);
      expect(FACTORY_COMPOSE_UPGRADE_SERVICES[component].supervisor).toBe(false);
    }
  });

  test("ready re-renders and proves the installation ready", async () => {
    const execute = fakeExecutor(activeSupervisor);
    const rendered: string[] = [];
    const ready = new FactoryComposeUpgradeTarget(async (value) => { rendered.push(value.tenantId); return bundle; }, target(execute, { ...virtualClock(), readReadiness: async () => SUPERVISOR_READY, fetchStatus: async () => 200 }));
    await ready.ready(installation);
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

  test("every installation service is read-only, drops all capabilities, is bounded, has a health check, and holds no device or runtime socket", async () => {
    const { services } = await parse("installation.yml");
    expect(Object.keys(services).sort()).toEqual(["gateway", "harness", "orchestrator", "pool"]);
    for (const [name, service] of Object.entries(services)) {
      expect({ name, readOnly: service.read_only, capDrop: service.cap_drop, privileged: service.privileged, devices: service.devices }).toEqual({ name, readOnly: true, capDrop: ["ALL"], privileged: undefined, devices: undefined });
      expect(service.healthcheck).toBeDefined();
      for (const limit of ["mem_limit", "cpus", "pids_limit"]) expect(service[limit]).toBeDefined();
      expect(JSON.stringify(service.volumes)).not.toMatch(/\.sock/);
      expect(service.env_file).toEqual([expect.stringMatching(/^\$\{EZCORP_FACTORY_[A-Z]+_ENV:\?\}$/)]);
    }
  });

  test("each readiness writer mounts only its own directory; the harness reads all of it read-only", async () => {
    const { services } = await parse("installation.yml");
    const readiness = (name: string) => (services[name]!.volumes as { target: string; read_only?: boolean }[]).filter((volume) => volume.target.startsWith("/run/ezcorp/readiness"));
    expect(readiness("pool").map((volume) => [volume.target, volume.read_only ?? false])).toEqual([["/run/ezcorp/readiness/pool", false]]);
    expect(readiness("orchestrator").map((volume) => [volume.target, volume.read_only ?? false])).toEqual([["/run/ezcorp/readiness/orchestration", false]]);
    expect(readiness("harness").map((volume) => [volume.target, volume.read_only ?? false])).toEqual([["/run/ezcorp/readiness", true]]);
  });

  test("the platform template parses", async () => {
    const { services } = await parse("platform.yml");
    expect(Object.keys(services).length).toBeGreaterThan(0);
  });
});
