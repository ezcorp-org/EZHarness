import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFactoryPoolReadinessWriter, FACTORY_POOL_READINESS_SCHEMA, FactoryPoolReadinessError, readFactoryPoolReadiness } from "./readiness";

const directories: string[] = [];
async function directory(): Promise<string> { const value = await mkdtemp(join(process.env.HOME!, ".factory-pool-readiness-")); directories.push(value); return value; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("factory pool readiness", () => {
  test("atomically publishes and reads only a fresh exact ready identity", async () => {
    const root = await directory();
    const options = { poolId: "pool-a", readinessFilePath: join(root, "status", "pool.json"), readinessHeartbeatMs: 1_000 };
    const writer = createFactoryPoolReadinessWriter(options, () => 10_000);
    await writer.write({ lifecycle: "starting", databaseReady: true, schemaReady: false, listenerReady: false });
    const ready = await writer.write({ lifecycle: "ready", databaseReady: true, schemaReady: true, listenerReady: true });
    expect(await readFactoryPoolReadiness(options, () => 12_999)).toEqual(ready);
    expect(JSON.parse(await readFile(options.readinessFilePath, "utf8"))).toEqual(ready);
    expect(ready).toEqual({ schemaVersion: "factory.pool-readiness.v2", poolId: "pool-a", observedAtMs: 10_000, lifecycle: "ready", databaseReady: true, schemaReady: true, listenerReady: true });
    const foreign = await readFactoryPoolReadiness({ ...options, poolId: "pool-b" }, () => 12_999).catch((error: unknown) => error);
    expect(foreign).toBeInstanceOf(FactoryPoolReadinessError);
    expect((foreign as FactoryPoolReadinessError).code).toBe("factory_pool_foreign");
    expect((foreign as Error).message).toBe("Factory pool readiness names a different pool.");
    await expect(readFactoryPoolReadiness(options, () => 13_001)).rejects.toBeInstanceOf(FactoryPoolReadinessError);
    await expect(readFactoryPoolReadiness(options, () => 9_999)).rejects.toBeInstanceOf(FactoryPoolReadinessError);
  });

  test("rejects invalid states, options, files, and unsafe paths without exposing details", async () => {
    const root = await directory();
    const path = join(root, "pool.json");
    const options = { poolId: "p", readinessFilePath: path };
    const writer = createFactoryPoolReadinessWriter(options, () => 1);
    for (const update of [
      { lifecycle: "ready", databaseReady: true, schemaReady: true, listenerReady: false },
      { lifecycle: "starting", databaseReady: false, schemaReady: false, listenerReady: true },
      { lifecycle: "degraded", databaseReady: false, schemaReady: true, listenerReady: false },
      { lifecycle: "degraded", databaseReady: true, schemaReady: true, listenerReady: false, errorCode: "BAD" },
      { lifecycle: "stopped", databaseReady: true, schemaReady: false, listenerReady: false },
    ]) await expect(writer.write(update as never)).rejects.toBeInstanceOf(FactoryPoolReadinessError);
    for (const invalid of [
      { ...options, poolId: "" }, { ...options, poolId: "x".repeat(513) },
      { ...options, readinessFilePath: "" }, { ...options, readinessHeartbeatMs: 999 },
      { ...options, readinessHeartbeatMs: 60_001 },
    ]) expect(() => createFactoryPoolReadinessWriter(invalid)).toThrow(FactoryPoolReadinessError);

    await writeFile(path, "{}", { mode: 0o600 });
    await expect(readFactoryPoolReadiness(options)).rejects.toBeInstanceOf(FactoryPoolReadinessError);
    await chmod(path, 0o644);
    await expect(readFactoryPoolReadiness(options)).rejects.toBeInstanceOf(FactoryPoolReadinessError);
    await rm(path);
    await symlink("missing", path);
    await expect(readFactoryPoolReadiness(options)).rejects.toBeInstanceOf(FactoryPoolReadinessError);
  });

  test("publishes degraded and stopped records but does not report them ready", async () => {
    const root = await directory();
    const options = { poolId: "p", readinessFilePath: join(root, "pool.json") };
    const writer = createFactoryPoolReadinessWriter(options, () => 7);
    expect(await writer.write({ lifecycle: "degraded", databaseReady: false, schemaReady: true, listenerReady: false, errorCode: "database_unavailable" })).toMatchObject({ lifecycle: "degraded", errorCode: "database_unavailable" });
    await expect(readFactoryPoolReadiness(options, () => 7)).rejects.toBeInstanceOf(FactoryPoolReadinessError);
    expect(await writer.write({ lifecycle: "stopped", databaseReady: false, schemaReady: false, listenerReady: false })).toMatchObject({ lifecycle: "stopped" });
    await expect(readFactoryPoolReadiness(options, () => 7)).rejects.toBeInstanceOf(FactoryPoolReadinessError);
  });

  test("one shared pool record is read by every installation that names the pool; the record names no installation", async () => {
    const root = await directory();
    const path = join(root, "pool.json");
    const ready = await createFactoryPoolReadinessWriter({ poolId: "pool.host-a", readinessFilePath: path }, () => 50).write({ lifecycle: "ready", databaseReady: true, schemaReady: true, listenerReady: true });
    expect(Object.keys(ready)).not.toContain("installationId");
    // Two installations each hold only the pool id their startup document names.
    for (const _installation of ["installation-1", "installation-2"]) expect(await readFactoryPoolReadiness({ poolId: "pool.host-a", readinessFilePath: path }, () => 51)).toEqual(ready);
  });

  test("a v1 record, or one that still names an installation, is not readable, and is unavailable rather than foreign", async () => {
    const root = await directory();
    const path = join(root, "pool.json");
    const base = { poolId: "p", lifecycle: "ready", observedAtMs: 5, databaseReady: true, schemaReady: true, listenerReady: true };
    for (const record of [{ ...base, schemaVersion: "factory.pool-readiness.v1", installationId: "i" }, { ...base, schemaVersion: FACTORY_POOL_READINESS_SCHEMA, installationId: "i" }]) {
      await writeFile(path, JSON.stringify(record), { mode: 0o600 });
      const refused = await readFactoryPoolReadiness({ poolId: "p", readinessFilePath: path }, () => 6).catch((error: unknown) => error);
      expect((refused as FactoryPoolReadinessError).code).toBe("factory_pool_unavailable");
    }
  });
});
