import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FACTORY_SUPERVISOR_FACTS,
  FACTORY_SUPERVISOR_READINESS_SCHEMA,
  FactoryServiceReadinessError,
  createFactoryServiceReadinessWriter,
  factorySupervisorReadinessOptions,
  readFactoryServiceReadiness,
  type FactoryServiceReadinessOptions,
} from "./service-readiness";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const directory = await mkdtemp(join(process.env.HOME!, ".w09-readiness-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function options(root: string, overrides: Partial<FactoryServiceReadinessOptions> = {}): FactoryServiceReadinessOptions {
  return {
    ...factorySupervisorReadinessOptions({
      installationId: "installation-01",
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
    const built = factorySupervisorReadinessOptions({ installationId: "i", hostId: "h", readinessFilePath: "/run/s.json" });
    expect(built).toMatchObject({ schemaVersion: FACTORY_SUPERVISOR_READINESS_SCHEMA, service: "host-supervisor", instanceId: "h" });
    expect(built.factNames).toEqual([...FACTORY_SUPERVISOR_FACTS]);
    expect(built.readinessHeartbeatMs).toBeUndefined();
    expect(factorySupervisorReadinessOptions({ installationId: "i", hostId: "h", readinessFilePath: "/run/s.json", readinessHeartbeatMs: 2_000 }).readinessHeartbeatMs).toBe(2_000);
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
      JSON.stringify({ ...{ schemaVersion: FACTORY_SUPERVISOR_READINESS_SCHEMA, service: "host-supervisor", installationId: "installation-01", instanceId: "host-01", lifecycle: "ready", observedAtMs: 1, facts: { hostKeyReady: true, runnerReady: true , hostServicesReady: false } }, surprise: 1 })]) {
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
        installationId: "installation-01", instanceId: "host-01", lifecycle: "ready",
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
