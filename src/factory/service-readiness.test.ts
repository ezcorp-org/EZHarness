import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FACTORY_SUPERVISOR_FACTS,
  FACTORY_SUPERVISOR_READINESS_SCHEMA,
  FactoryServiceReadinessError,
  createFactoryServiceReadinessWriter,
  factorySupervisorReadinessExpectation,
  factorySupervisorReadinessOptions,
  readFactoryServiceReadiness,
  verifyFactoryServiceReadiness,
  type FactoryServiceReadinessOptions,
} from "./service-readiness";
import { makeFactoryTempPrivateRoot } from "../__tests__/helpers/factory-private-root";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const directory = await makeFactoryTempPrivateRoot("w09-readiness-");
  roots.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function options(root: string, overrides: Partial<FactoryServiceReadinessOptions> = {}): FactoryServiceReadinessOptions {
  return {
    ...factorySupervisorReadinessOptions({
      hostId: "host-01",
      readinessFilePath: join(root, "supervisor.json"),
      readinessHeartbeatMs: 1_000,
    }),
    ...overrides,
  };
}

const ready = { lifecycle: "ready" as const, facts: { hostKeyReady: true, runnerReady: true , hostServicesReady: false } };

describe("factorySupervisorReadinessOptions", () => {
  test("names the service, its schema, and exactly the facts a supervisor observes", () => {
    const built = factorySupervisorReadinessOptions({ hostId: "h", readinessFilePath: "/run/s.json" });
    expect(built).toMatchObject({ schemaVersion: FACTORY_SUPERVISOR_READINESS_SCHEMA, service: "host-supervisor", instanceId: "h" });
    expect(built.factNames).toEqual([...FACTORY_SUPERVISOR_FACTS]);
    expect(built.readinessHeartbeatMs).toBeUndefined();
    // Shared by every installation on the host: the options name no installation.
    expect("installationId" in built).toBe(false);
    expect(factorySupervisorReadinessOptions({ hostId: "h", readinessFilePath: "/run/s.json", readinessHeartbeatMs: 2_000 }).readinessHeartbeatMs).toBe(2_000);
  });
});

describe("createFactoryServiceReadinessWriter", () => {
  test("publishes a record a reader accepts, and rewrites it on each heartbeat", async () => {
    const root = await privateRoot();
    let now = 10_000;
    const scope = options(root);
    const writer = createFactoryServiceReadinessWriter(scope, () => now);

    await writer.write({ lifecycle: "starting", facts: { hostKeyReady: true, runnerReady: false , hostServicesReady: false } });
    const published = await writer.write(ready);
    expect(published).toMatchObject({ service: "host-supervisor", instanceId: "host-01", lifecycle: "ready", observedAtMs: 10_000 });
    expect(JSON.parse(await readFile(scope.readinessFilePath, "utf8"))).toEqual(published);
    expect(await readFactoryServiceReadiness(scope, () => 12_999)).toEqual(published);

    now = 20_000;
    const later = await writer.write(ready);
    expect(later.observedAtMs).toBe(20_000);
  });

  test("carries an error code on a degraded record and refuses a malformed one", async () => {
    const root = await privateRoot();
    const scope = options(root);
    const writer = createFactoryServiceReadinessWriter(scope, () => 1_000);
    expect(await writer.write({ lifecycle: "degraded", facts: { hostKeyReady: false, runnerReady: false , hostServicesReady: false }, errorCode: "runner_unreachable" }))
      .toMatchObject({ lifecycle: "degraded", errorCode: "runner_unreachable" });

    await expect(writer.write({ lifecycle: "ready", facts: { hostKeyReady: true } })).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    await expect(writer.write({ lifecycle: "ready", facts: { hostKeyReady: true, runnerReady: true, extra: true , hostServicesReady: false } })).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    await expect(writer.write({ lifecycle: "ready", facts: ready.facts, errorCode: "NOT A CODE" })).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    await expect(writer.write({ lifecycle: "wedged" as never, facts: ready.facts })).rejects.toBeInstanceOf(FactoryServiceReadinessError);
  });

  test("refuses options that cannot identify a service", () => {
    const build = (overrides: Partial<FactoryServiceReadinessOptions>) =>
      () => createFactoryServiceReadinessWriter({
        schemaVersion: "factory.supervisor-readiness.v1", service: "host-supervisor",
        installationId: "i", instanceId: "h", readinessFilePath: "/run/s.json", factNames: ["ok"], ...overrides,
      });
    expect(build({ service: "Host Supervisor" })).toThrow(FactoryServiceReadinessError);
    expect(build({ schemaVersion: "" })).toThrow(FactoryServiceReadinessError);
    expect(build({ installationId: "" })).toThrow(FactoryServiceReadinessError);
    expect(build({ instanceId: "with\0null" })).toThrow(FactoryServiceReadinessError);
    expect(build({ readinessFilePath: "" })).toThrow(FactoryServiceReadinessError);
    expect(build({ readinessHeartbeatMs: 999 })).toThrow(FactoryServiceReadinessError);
    expect(build({ factNames: [] })).toThrow(FactoryServiceReadinessError);
    expect(build({ factNames: ["ok", "ok"] })).toThrow(FactoryServiceReadinessError);
    expect(build({ factNames: ["not a name"] })).toThrow(FactoryServiceReadinessError);
    expect(build({ factNames: Array.from({ length: 33 }, (_value, index) => `f${index}`) })).toThrow(FactoryServiceReadinessError);
  });
});

describe("readFactoryServiceReadiness", () => {
  test("refuses a stale, foreign, not-ready, or absent record with the same error", async () => {
    const root = await privateRoot();
    const scope = options(root);
    const writer = createFactoryServiceReadinessWriter(scope, () => 10_000);
    await writer.write(ready);

    // Fresh and exact passes; one heartbeat past three windows does not.
    expect(await readFactoryServiceReadiness(scope, () => 13_000)).toMatchObject({ lifecycle: "ready" });
    await expect(readFactoryServiceReadiness(scope, () => 13_001)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    // A clock behind the record is as suspect as one too far ahead.
    await expect(readFactoryServiceReadiness(scope, () => 9_999)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    await expect(readFactoryServiceReadiness({ ...scope, instanceId: "host-02" }, () => 10_000)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    await expect(readFactoryServiceReadiness({ ...scope, installationId: "installation-02" }, () => 10_000)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    await expect(readFactoryServiceReadiness({ ...scope, service: "pool-admission" }, () => 10_000)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    await expect(readFactoryServiceReadiness({ ...scope, readinessFilePath: join(root, "absent.json") }, () => 10_000)).rejects.toBeInstanceOf(FactoryServiceReadinessError);

    await createFactoryServiceReadinessWriter(scope, () => 10_000).write({ lifecycle: "stopped", facts: { hostKeyReady: false, runnerReady: false , hostServicesReady: false } });
    await expect(readFactoryServiceReadiness(scope, () => 10_000)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
  });

  test("refuses bytes that are not a record of this shape", async () => {
    const root = await privateRoot();
    const scope = options(root);
    for (const body of ["{not json", "[]", '"text"', JSON.stringify({ schemaVersion: "other" }),
      JSON.stringify({ ...{ schemaVersion: FACTORY_SUPERVISOR_READINESS_SCHEMA, service: "host-supervisor", instanceId: "host-01", lifecycle: "ready", observedAtMs: 1, facts: { hostKeyReady: true, runnerReady: true , hostServicesReady: false } }, surprise: 1 })]) {
      await writeFile(scope.readinessFilePath, body, { mode: 0o600 });
      await chmod(scope.readinessFilePath, 0o600);
      await expect(readFactoryServiceReadiness(scope, () => 1)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    }
  });

  test("refuses a record whose observation time is not a usable number", async () => {
    const root = await privateRoot();
    const scope = options(root);
    for (const observedAtMs of [-1, 1.5, "1"]) {
      await writeFile(scope.readinessFilePath, JSON.stringify({
        schemaVersion: FACTORY_SUPERVISOR_READINESS_SCHEMA, service: "host-supervisor",
        instanceId: "host-01", lifecycle: "ready",
        observedAtMs, facts: { hostKeyReady: true, runnerReady: true , hostServicesReady: false },
      }), { mode: 0o600 });
      await chmod(scope.readinessFilePath, 0o600);
      await expect(readFactoryServiceReadiness(scope, () => 1_000)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    }
  });

  test("refuses options it cannot validate, without reading anything", async () => {
    await expect(readFactoryServiceReadiness({
      schemaVersion: "v1", service: "BAD", installationId: "i", instanceId: "h", readinessFilePath: "/run/s.json", factNames: ["ok"],
    })).rejects.toBeInstanceOf(FactoryServiceReadinessError);
  });
});

describe("owned and shared services", () => {
  const owned = (root: string): FactoryServiceReadinessOptions => ({
    schemaVersion: "factory.owned-readiness.v1", service: "owned-service", installationId: "installation-01",
    instanceId: "worker-01", readinessFilePath: join(root, "owned.json"), readinessHeartbeatMs: 1_000, factNames: ["ok"],
  });

  test("an owned service names its installation, and only that installation reads it", async () => {
    const root = await privateRoot();
    const published = await createFactoryServiceReadinessWriter(owned(root), () => 5_000).write({ lifecycle: "ready", facts: { ok: true } });
    expect(published.installationId).toBe("installation-01");
    expect(await readFactoryServiceReadiness(owned(root), () => 5_000)).toEqual(published);
    await expect(readFactoryServiceReadiness({ ...owned(root), installationId: "installation-02" }, () => 5_000)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    // A reader for a shared service accepts no record that names an installation.
    const { installationId: _installation, ...shared } = owned(root);
    await expect(readFactoryServiceReadiness(shared, () => 5_000)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
  });

  test("a shared service's record names no installation, and an owned reader refuses it", async () => {
    const root = await privateRoot();
    const scope = options(root);
    const published = await createFactoryServiceReadinessWriter(scope, () => 5_000).write(ready);
    expect("installationId" in published).toBe(false);
    await expect(readFactoryServiceReadiness({ ...scope, installationId: "installation-01" }, () => 5_000)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
  });
});

describe("verifyFactoryServiceReadiness (a record from the network, W4H-35)", () => {
  const expectation = factorySupervisorReadinessExpectation({ hostId: "host-01", readinessHeartbeatMs: 1_000 });
  const record = { schemaVersion: FACTORY_SUPERVISOR_READINESS_SCHEMA, service: "host-supervisor", instanceId: "host-01", lifecycle: "ready", observedAtMs: 10_000, facts: { hostKeyReady: true, runnerReady: true, hostServicesReady: true } };

  test("the expectation is the file options without a path", () => {
    const { readinessFilePath, ...rest } = factorySupervisorReadinessOptions({ hostId: "host-01", readinessFilePath: "/run/s.json", readinessHeartbeatMs: 1_000 });
    expect(readinessFilePath).toBe("/run/s.json");
    expect(rest).toEqual(expectation);
    expect(factorySupervisorReadinessExpectation({ hostId: "h" }).readinessHeartbeatMs).toBeUndefined();
  });

  test("accepts exactly a fresh ready record for the exact host, as the file reader does", () => {
    expect(verifyFactoryServiceReadiness(record, expectation, 12_000)).toEqual(record as never);
    expect(Object.isFrozen(verifyFactoryServiceReadiness(record, expectation, 12_000))).toBe(true);
    for (const [value, now] of [
      [record, 13_001], [record, 9_999], [{ ...record, instanceId: "host-02" }, 12_000], [{ ...record, lifecycle: "degraded", errorCode: "x" }, 12_000],
      [{ ...record, installationId: "inst-1" }, 12_000], [{ ...record, facts: { hostKeyReady: true } }, 12_000], ["ready", 12_000], [null, 12_000], [record, Number.NaN],
    ] as const) {
      const error = (() => { try { verifyFactoryServiceReadiness(value, expectation, now); } catch (thrown) { return thrown as FactoryServiceReadinessError; } throw new Error("expected a refusal"); })();
      expect(error).toBeInstanceOf(FactoryServiceReadinessError);
      expect(error.code).toBe("host-supervisor");
    }
    expect(() => verifyFactoryServiceReadiness(record, { ...expectation, factNames: [] }, 12_000)).toThrow(FactoryServiceReadinessError);
  });

  // C12 row "Container runtime readiness (hosted)" (W4H-35 run 12): the held role rides the record in the product's one held-role
  // entry shape; a ready record holds runnerReady false only together with the container-runtime entry, and nothing else says so.
  test("a ready record holds runnerReady false only with the container-runtime held entry; any other held shape is refused (W4H-35 run 12)", () => {
    const facts = { hostKeyReady: true, runnerReady: false, hostServicesReady: true };
    const entry = { role: "container-runtime", workPackage: "W16", reason: "container_runtime_unreachable" };
    const held = { ...record, facts, held: [entry] };
    expect(verifyFactoryServiceReadiness(held, expectation, 12_000)).toEqual(held as never);
    expect(Object.hasOwn(held, "warnings")).toBe(false);
    const degraded = { ...held, lifecycle: "degraded", errorCode: "observation_stale" };
    expect(() => verifyFactoryServiceReadiness(degraded, expectation, 12_000)).toThrow(FactoryServiceReadinessError);
    for (const value of [
      { ...record, facts }, { ...held, held: undefined }, { ...held, held: [] }, { ...held, held: [entry, entry] },
      { ...record, held: [entry] }, { ...held, held: [{ ...entry, role: "other-role" }] }, { ...held, held: [{ ...entry, workPackage: "W17" }] },
      { ...held, held: [{ ...entry, reason: "Bad Reason" }] }, { ...held, held: [{ ...entry, host: "host-01" }] }, { ...held, held: [{ role: entry.role, workPackage: entry.workPackage }] },
      { ...held, held: {} }, { ...held, held: ["x"] }, { ...held, held: Array.from({ length: 9 }, () => entry) },
      { ...held, warnings: [{ role: "containerRuntime", code: "container_runtime_unreachable" }] }, { ...held, roles: { containerRuntime: "held" } },
    ]) expect(() => verifyFactoryServiceReadiness(JSON.parse(JSON.stringify(value)), expectation, 12_000)).toThrow(FactoryServiceReadinessError);
    // A service whose expectation declares no held fact can never carry a held entry.
    expect(() => verifyFactoryServiceReadiness(held, { ...expectation, heldFacts: {} }, 12_000)).toThrow(FactoryServiceReadinessError);
    // An expectation that declares a held fact it does not carry is refused as an expectation.
    expect(() => verifyFactoryServiceReadiness(held, { ...expectation, heldFacts: { unknownFact: { role: "x", workPackage: "W16" } } }, 12_000)).toThrow(FactoryServiceReadinessError);
  });
});

describe("the writer publishes a record's held entries (W4H-35 run 12)", () => {
  test("the held entry is written and read back by the file reader; a ready record without it is refused", async () => {
    const root = await privateRoot();
    const writer = createFactoryServiceReadinessWriter(options(root), () => 1_000);
    const entry = { role: "container-runtime", workPackage: "W16", reason: "runner_unavailable" };
    const facts = { ...ready.facts, runnerReady: false };
    const written = await writer.write({ lifecycle: "ready", facts, held: [entry] });
    expect(written.held).toEqual([entry]);
    expect(JSON.parse(await readFile(options(root).readinessFilePath, "utf8")).held).toEqual([entry]);
    expect((await readFactoryServiceReadiness(options(root), () => 1_500)).held).toEqual([entry]);
    await expect(writer.write({ lifecycle: "ready", facts })).rejects.toThrow(FactoryServiceReadinessError);
  });
});
