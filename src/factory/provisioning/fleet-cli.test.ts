import { describe, expect, test } from "bun:test";
import { factoryFleetCommandFailures, reportFactoryFleetOutcome, runFactoryFleetCommand, runFactoryFleetMain, type FactoryFleetCommandContext } from "./fleet-cli";
import type { FactoryComposedFleet, FactoryFleetSettings } from "./fleet";
import { FactoryProvisioningError } from "./steps";

const settings = { fleetId: "w16", ingress: { domain: "w16.factory.test", port: 32005, address: "127.0.0.1" }, image: { reference: `localhost/f@sha256:${"a".repeat(64)}`, revision: "b".repeat(40) }, release: { directory: "/release" } } as unknown as FactoryFleetSettings;

const checks = { census: { count: async () => ({ active: 0, uncertain: 0 }) }, approvals: { verify: async () => ({ approvedBy: "admin:a@b.example" }) } };
const WHO = { actor: "cli:operator" };
const APPROVAL = "0f8b2f7a-1c1d-4a4e-9a0b-6d1f2e3c4b5a";

function context(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); if (overrides[name] instanceof Error) throw overrides[name]; return overrides[name] ?? { phase: "invitation_issued", installationId: "i-1", steps: [{ step: "database", state: "complete", attempts: 1 }] }; };
  const fleet = {
    provisioner: {
      provision: record("provision"), observeBootstrap: record("observe"), rotate: record("rotate"), purge: record("purge"), status: record("status"),
      teardown: async (...args: unknown[]) => { calls.push(["teardown", ...args]); return { installation: { phase: "torn_down" }, residues: [] }; },
      ledger: { events: record("events"), directory: record("directory") },
    },
    upgrades: { adopt: record("adopt"), register: record("register"), wave: record("wave"), abandon: record("abandon"), retire: record("retire"), builds: async () => undefined },
    services: {
      stoppable: async () => ["tenant-01", "tenant-02", "tenant-03"],
      startable: async () => ["tenant-01", "tenant-02"],
      stopInstallation: record("stop-installation"), startInstallation: record("start-installation"),
      stopHost: record("stop-host"), startHost: record("start-host"), stopPlatform: record("stop-platform"),
    },
    host: {
      identity: { poolId: "pool.w16", hostId: "host.w16" },
      admitted: async () => [{ tenantId: "tenant-01" }, { tenantId: "tenant-02" }],
      decommission: async () => { calls.push(["decommission"]); },
    },
  } as unknown as FactoryComposedFleet;
  const value: FactoryFleetCommandContext = {
    settings, fleet,
    purgeChecks: async () => checks,
    actor: "cli:operator",
    observer: async () => ({ observe: async () => ({ complete: true }) }),
    startPlatform: async () => { calls.push(["platform"]); },
  };
  return { value, calls };
}

const usage = async (work: Promise<unknown>) => { try { await work; } catch (error) { return (error as FactoryProvisioningError).code; } return undefined; };

describe("fleet commands", () => {
  test("provision derives each hostname and invited email from the fleet, and adopts the fleet's default build", async () => {
    const { value, calls } = context();
    const result = await runFactoryFleetCommand("provision", ["tenant-01", "tenant-02", "--through", "secrets"], value) as { provision: { tenantId: string; phase: string }[] };
    expect(result.provision.map((entry) => [entry.tenantId, entry.phase])).toEqual([["tenant-01", "invitation_issued"], ["tenant-02", "invitation_issued"]]);
    expect(calls.filter((call) => call[0] === "provision")).toEqual([
      ["provision", { tenantId: "tenant-01", hostname: "tenant-01.w16.factory.test", administratorEmail: "admin@tenant-01.w16.factory.test" }, { ...WHO, through: "secrets" }],
      ["provision", { tenantId: "tenant-02", hostname: "tenant-02.w16.factory.test", administratorEmail: "admin@tenant-02.w16.factory.test" }, { ...WHO, through: "secrets" }],
    ]);
    expect(calls.filter((call) => call[0] === "adopt")).toEqual([["adopt", "tenant-01", "rev-bbbbbbbbbbbb"], ["adopt", "tenant-02", "rev-bbbbbbbbbbbb"]]);
    expect(await usage(runFactoryFleetCommand("provision", ["tenant-01", "--through", "nonsense"], value))).toBe("cli_usage");
  });

  test("--admin-email names the invited administrator of exactly one tenant", async () => {
    const { value, calls } = context();
    await runFactoryFleetCommand("provision", ["tenant-03", "--admin-email", "ada@example.com"], value);
    expect(calls.filter((call) => call[0] === "provision")).toEqual([["provision", { tenantId: "tenant-03", hostname: "tenant-03.w16.factory.test", administratorEmail: "ada@example.com" }, WHO]]);
    const refused = context();
    expect(await usage(runFactoryFleetCommand("provision", ["tenant-03", "tenant-04", "--admin-email", "ada@example.com"], refused.value))).toBe("cli_usage");
    expect(refused.calls).toEqual([]);
  });

  test("a per-tenant failure is reported in the result and the others still run", async () => {
    const { value } = context({ provision: new FactoryProvisioningError("database_foreign", "foreign role") });
    const result = await runFactoryFleetCommand("provision", ["tenant-01"], value) as { provision: { error: { code: string } }[] };
    expect(result.provision[0]!.error.code).toBe("database_foreign");
    const observed = await runFactoryFleetCommand("observe", ["tenant-01"], context({ observe: new Error("unreachable") }).value) as { observe: { error: { message: string } }[] };
    expect(observed.observe[0]!.error.message).toBe("unreachable");
  });

  test("a failed tenant names its failed step: the error's own, else the one its installation records, else none", async () => {
    const named = await runFactoryFleetCommand("provision", ["tenant-01"], context({ provision: new FactoryProvisioningError("storage_unreachable", "no answer", "storage") }).value);
    expect(named).toEqual({ provision: [{ tenantId: "tenant-01", error: { name: "FactoryProvisioningError", code: "storage_unreachable", message: "no answer", step: "storage" } }] });
    const recorded = context({
      provision: new FactoryProvisioningError("deployment_not_ready", "still waiting on harness"),
      status: { steps: [{ step: "database", state: "complete" }, { step: "deployment", state: "failed" }, { step: "ingress", state: "pending" }] },
    });
    expect(await runFactoryFleetCommand("provision", ["tenant-02"], recorded.value)).toEqual({ provision: [{ tenantId: "tenant-02", error: { name: "FactoryProvisioningError", code: "deployment_not_ready", message: "still waiting on harness", step: "deployment" } }] });
    expect(recorded.calls.find((call) => call[0] === "status")).toEqual(["status", "tenant-02"]);
    const unrecorded = context({ observe: new Error("unreachable"), status: new FactoryProvisioningError("provisioning_unknown_tenant", "none") });
    expect(await runFactoryFleetCommand("observe", ["tenant-09"], unrecorded.value)).toEqual({ observe: [{ tenantId: "tenant-09", error: { name: "Error", code: undefined, message: "unreachable" } }] });
  });

  test("a command with any failed tenant fails through the channel, naming the tenant, step, and reason; a clean one only prints", () => {
    const failure = { tenantId: "tenant-02", error: { code: "deployment_not_ready", message: "still waiting on harness", step: "deployment" } };
    const result = { provision: [{ tenantId: "tenant-01", phase: "invitation_issued" }, failure] };
    expect(factoryFleetCommandFailures(result)).toEqual([failure]);
    for (const clean of [undefined, null, "text", { platform: "started" }, { provision: [{ tenantId: "tenant-01", phase: "x" }, null] }]) expect(factoryFleetCommandFailures(clean)).toEqual([]);
    const outcomes: unknown[] = [];
    const io = { print: (value: unknown) => outcomes.push(["print", value]), fail: (value: unknown) => outcomes.push(["fail", value]) };
    reportFactoryFleetOutcome(io, result);
    reportFactoryFleetOutcome(io, { observe: [{ tenantId: "tenant-01", phase: "invitation_issued" }] });
    expect(outcomes).toEqual([["print", result], ["fail", { failed: [failure] }], ["print", { observe: [{ tenantId: "tenant-01", phase: "invitation_issued" }] }]]);
  });

  test("platform, observe, rotate, teardown, purge, status, and upgrades dispatch with their arguments", async () => {
    const { value, calls } = context();
    expect(await runFactoryFleetCommand("platform", [], value)).toEqual({ platform: "started", project: "ezcorp-factory-w16-platform" });
    expect(await runFactoryFleetCommand("observe", ["tenant-01"], value)).toEqual({ observe: [{ tenantId: "tenant-01", phase: "invitation_issued" }] });
    expect(await runFactoryFleetCommand("rotate", ["tenant-01", "database"], value)).toEqual({ rotate: { tenantId: "tenant-01", step: "database", phase: "invitation_issued" } });
    expect(await runFactoryFleetCommand("rotate", ["tenant-01", "deployment"], value)).toEqual({ rotate: { tenantId: "tenant-01", step: "deployment", phase: "invitation_issued" } });
    expect(await runFactoryFleetCommand("teardown", ["tenant-01", "--reason", "left"], value)).toEqual({ teardown: { tenantId: "tenant-01", phase: "torn_down", residues: [] } });
    expect(await runFactoryFleetCommand("teardown", ["tenant-01"], value)).toMatchObject({ teardown: { phase: "torn_down" } });
    expect(await runFactoryFleetCommand("purge", ["tenant-01", "--approval", APPROVAL, "--reason", "done"], value)).toEqual({ purge: { tenantId: "tenant-01", phase: "invitation_issued" } });
    expect(await runFactoryFleetCommand("purge", ["tenant-01", "--approval", APPROVAL], value)).toMatchObject({ purge: { tenantId: "tenant-01" } });
    expect(await runFactoryFleetCommand("status", ["tenant-01"], value)).toMatchObject({ builds: null });
    expect(await runFactoryFleetCommand("status", [], value)).toHaveProperty("directory");
    expect(await runFactoryFleetCommand("upgrade", ["register", "b2", `localhost/f@sha256:${"c".repeat(64)}`, "d".repeat(40), "/release/b2"], value)).toEqual({ registered: { buildId: "b2", image: `localhost/f@sha256:${"c".repeat(64)}`, revision: "d".repeat(40), releaseDirectory: "/release/b2" } });
    expect(await runFactoryFleetCommand("upgrade", ["wave", "b2", "--canary", "tenant-01", "tenant-01", "tenant-02"], value)).toHaveProperty("wave");
    expect(await runFactoryFleetCommand("upgrade", ["abandon", "wave-1"], value)).toEqual({ abandoned: "wave-1" });
    expect(await runFactoryFleetCommand("upgrade", ["retire"], value)).toHaveProperty("retired");
    expect(calls.find((call) => call[0] === "teardown")).toEqual(["teardown", "tenant-01", { reason: "left", ...WHO }]);
    expect(calls.find((call) => call[0] === "observe")).toEqual(["observe", "tenant-01", expect.anything(), WHO]);
    expect(calls.filter((call) => call[0] === "rotate")).toEqual([["rotate", "tenant-01", "database", WHO], ["rotate", "tenant-01", "deployment", WHO]]);
    expect(calls.find((call) => call[0] === "abandon")).toEqual(["abandon", "wave-1"]);
    expect(calls.find((call) => call[0] === "retire")).toEqual(["retire", checks.census]);
    expect(calls.find((call) => call[0] === "wave")).toEqual(["wave", { buildId: "b2", canary: "tenant-01", tenants: ["tenant-01", "tenant-02"] }]);
    expect(calls.find((call) => call[0] === "purge")!.slice(2)).toEqual([{ approvalId: APPROVAL, reason: "done", ...WHO }, checks]);
  });

  test("stop stops the installations newest first, then the host, then the platform; up is its reverse; both are idempotent", async () => {
    const { value, calls } = context();
    const stopped = { stopped: { installations: ["tenant-03", "tenant-02", "tenant-01"], host: true, platform: "ezcorp-factory-w16-platform" } };
    expect(await runFactoryFleetCommand("stop", [], value)).toEqual(stopped);
    expect(await runFactoryFleetCommand("stop", [], value)).toEqual(stopped);
    const stops = [["stop-installation", "tenant-03"], ["stop-installation", "tenant-02"], ["stop-installation", "tenant-01"], ["stop-host"], ["stop-platform"]];
    expect(calls).toEqual([...stops, ...stops]);
    calls.length = 0;
    const up = { up: { platform: "ezcorp-factory-w16-platform", host: true, installations: ["tenant-01", "tenant-02"] } };
    expect(await runFactoryFleetCommand("up", [], value)).toEqual(up);
    expect(await runFactoryFleetCommand("up", [], value)).toEqual(up);
    const ups = [["platform"], ["start-host"], ["start-installation", "tenant-01"], ["start-installation", "tenant-02"]];
    expect(calls).toEqual([...ups, ...ups]);
  });

  test("host status names the shared pool, the host, and the admitted installations; decommission reaches the host", async () => {
    const { value, calls } = context();
    expect(await runFactoryFleetCommand("host", ["status"], value)).toEqual({ host: { poolId: "pool.w16", hostId: "host.w16", admitted: ["tenant-01", "tenant-02"] } });
    expect(await runFactoryFleetCommand("host", ["decommission"], value)).toEqual({ host: { decommissioned: "host.w16" } });
    expect(calls).toEqual([["decommission"]]);
  });

  test("every malformed command is a usage error, never a partial action", async () => {
    const { value, calls } = context();
    for (const [command, args] of [["rotate", ["tenant-01"]], ["rotate", ["tenant-01", "ingress"]], ["rotate", []], ["teardown", []], ["purge", ["tenant-01"]], ["purge", ["tenant-01", "--approved-by", "admin:a@b.c"]], ["purge", []], ["upgrade", ["abandon"]], ["upgrade", ["register", "b2"]], ["upgrade", ["wave", "b2", "tenant-01"]], ["upgrade", ["wave", "b2", "--canary", "tenant-01"]], ["upgrade", ["nonsense"]], ["upgrade", []], ["host", []], ["host", ["nonsense"]], ["nonsense", []]] as const) {
      expect(await usage(runFactoryFleetCommand(command, args, value))).toBe("cli_usage");
    }
    expect(calls).toEqual([]);
  });
});

describe("the main entry", () => {
  test("a missing command or an unreadable settings file fails through the injected channel, and nothing is composed", async () => {
    const outcomes: unknown[] = [];
    const io = { print: (value: unknown) => outcomes.push(["print", value]), fail: (value: unknown) => outcomes.push(["fail", value]) };
    await runFactoryFleetMain([], { argv: ["true"], env: {} }, io);
    await runFactoryFleetMain(["/nonexistent/fleet.json", "status"], { argv: ["true"], env: {} }, io);
    expect(outcomes).toEqual([
      ["fail", { error: { name: "FactoryProvisioningError", code: "cli_usage", message: expect.stringContaining("usage:") } }],
      ["fail", { error: { name: "FactoryProvisioningError", code: "fleet_settings_invalid", message: expect.stringContaining("not readable JSON") } }],
    ]);
  });

  test("the default channel prints a failure as JSON on stderr and sets a failing exit code", async () => {
    const original = console.error;
    const lines: string[] = [];
    console.error = (value: string) => { lines.push(value); };
    const previous = process.exitCode;
    try { await runFactoryFleetMain([], { argv: ["true"], env: {} }); }
    finally { console.error = original; }
    expect(process.exitCode).toBe(1);
    process.exitCode = previous ?? 0;
    expect(JSON.parse(lines[0]!)).toMatchObject({ error: { code: "cli_usage" } });
  });
});
