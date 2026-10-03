import { describe, expect, test } from "bun:test";
import { factoryWorkflowId } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import { factoryRecoveryMemoryStores } from "../__tests__/helpers/factory-recovery-memory";
import { FACTORY_CHECKPOINT_LIMITS, FACTORY_CHECKPOINT_MANIFEST_SCHEMA, FACTORY_CHECKPOINT_SEAL_SCHEMA, FACTORY_CHECKPOINT_SEALS_RECORD, FactoryCheckpointCoordinator, FactoryCheckpointError, factoryInterpreterWorkflowId, latestFactoryCheckpoint, readFactoryCheckpointManifest, type FactoryCheckpointSlotSource } from "./checkpoint-barrier";
import { writeFactoryRecoveryJson } from "./recovery-archive";

describe("the cluster-wide barrier slot", () => {
  // Only the restore-epoch check and the gate-coverage query reach this database.
  function coordinator(slots: FactoryCheckpointSlotSource, failure = new Error("gate coverage unreadable")) {
    let calls = 0;
    const database = { execute: async () => { calls += 1; if (calls > 1) throw failure; return []; } } as never;
    return new FactoryCheckpointCoordinator({ database, tenantId: "tenant-a", installationId: "installation-a", archive: factoryRecoveryMemoryStores().archive, slots });
  }

  test("with every slot held elsewhere the barrier defers and claims nothing", async () => {
    const released: string[] = [];
    const outcome = await coordinator({ acquire: async () => null, release: async token => { released.push(token); } }).run();
    expect(outcome).toEqual({ kind: "deferred", reason: "barrier_slots_full" });
    expect(released).toEqual([]);
  });

  test("a held slot is released whatever the barrier does", async () => {
    const released: string[] = [];
    await expect(coordinator({ acquire: async () => ({ token: "slot-token" }), release: async token => { released.push(token); } }).run()).rejects.toThrow("gate coverage unreadable");
    expect(released).toEqual(["slot-token"]);
  });
});

describe("the recorded Temporal identity", () => {
  test("an interpreter's workflow id is exactly the orchestrator's", () => {
    for (const interpreter of ["root", "partition-a", "p/1"]) expect(factoryInterpreterWorkflowId("tenant", "run-1", interpreter)).toBe(factoryWorkflowId("tenant", "run-1", interpreter));
  });
});

describe("sealed manifests in the archive", () => {
  const manifest = (tenantId: string, checkpointId: string) => ({ schemaVersion: FACTORY_CHECKPOINT_MANIFEST_SCHEMA, tenantId, checkpointId });

  test("the newest valid seal wins; a malformed or foreign seal is ignored; none means null", async () => {
    const { archive } = factoryRecoveryMemoryStores();
    expect(await latestFactoryCheckpoint(archive, "tenant-a")).toBeNull();
    const older = await writeFactoryRecoveryJson(archive, "tenant-a", "checkpoint", "c-old", manifest("tenant-a", "c-old"));
    const newer = await writeFactoryRecoveryJson(archive, "tenant-a", "checkpoint", "c-new", manifest("tenant-a", "c-new"));
    const seal = (checkpointId: string, reference: typeof older, sealedAtMs: number) => ({ schemaVersion: FACTORY_CHECKPOINT_SEAL_SCHEMA, tenantId: "tenant-a", checkpointId, manifest: reference, manifestDigest: reference.digest, sealedAtMs, durationMs: 5 });
    await writeFactoryRecoveryJson(archive, "tenant-a", "checkpoint", FACTORY_CHECKPOINT_SEALS_RECORD, seal("c-old", older, 1_000));
    await writeFactoryRecoveryJson(archive, "tenant-a", "checkpoint", FACTORY_CHECKPOINT_SEALS_RECORD, seal("c-new", newer, 2_000));
    await writeFactoryRecoveryJson(archive, "tenant-a", "checkpoint", FACTORY_CHECKPOINT_SEALS_RECORD, { schemaVersion: "other", tenantId: "tenant-a", sealedAtMs: 9_000 });
    await writeFactoryRecoveryJson(archive, "tenant-a", "checkpoint", FACTORY_CHECKPOINT_SEALS_RECORD, { ...seal("c-foreign", newer, 9_000), tenantId: "tenant-b" });
    const latest = (await latestFactoryCheckpoint(archive, "tenant-a"))!;
    expect(latest.seal.checkpointId).toBe("c-new");
    expect(latest.manifest.checkpointId).toBe("c-new");
  });

  test("a seal whose digest or manifest does not match is refused", async () => {
    const { archive } = factoryRecoveryMemoryStores();
    const reference = await writeFactoryRecoveryJson(archive, "tenant-a", "checkpoint", "c-1", manifest("tenant-a", "c-1"));
    const seal = { schemaVersion: FACTORY_CHECKPOINT_SEAL_SCHEMA, tenantId: "tenant-a", checkpointId: "c-1", manifest: reference, manifestDigest: reference.digest, sealedAtMs: 1, durationMs: 1 } as const;
    expect((await readFactoryCheckpointManifest(archive, seal)).checkpointId).toBe("c-1");
    await expect(readFactoryCheckpointManifest(archive, { ...seal, manifestDigest: `sha256:${"0".repeat(64)}` })).rejects.toMatchObject({ code: "factory_checkpoint_manifest_invalid" });
    await expect(readFactoryCheckpointManifest(archive, { ...seal, checkpointId: "c-2" })).rejects.toMatchObject({ code: "factory_checkpoint_manifest_invalid" });
    const wrongSchema = await writeFactoryRecoveryJson(archive, "tenant-a", "checkpoint", "c-3", { schemaVersion: "other", tenantId: "tenant-a", checkpointId: "c-3" });
    await expect(readFactoryCheckpointManifest(archive, { ...seal, checkpointId: "c-3", manifest: wrongSchema, manifestDigest: wrongSchema.digest })).rejects.toMatchObject({ code: "factory_checkpoint_manifest_invalid" });
  });

  test("the coordinator refuses a maximum above the contract and an invalid identity", () => {
    const { archive } = factoryRecoveryMemoryStores();
    const options = { database: {} as never, tenantId: "tenant-a", installationId: "installation-a", archive };
    expect(() => new FactoryCheckpointCoordinator({ ...options, maximumMs: FACTORY_CHECKPOINT_LIMITS.maximumMs + 1 })).toThrow(FactoryCheckpointError);
    expect(() => new FactoryCheckpointCoordinator({ ...options, maximumMs: 0 })).toThrow(FactoryCheckpointError);
    expect(() => new FactoryCheckpointCoordinator({ ...options, tenantId: "" })).toThrow();
    expect(new FactoryCheckpointCoordinator(options).tenantId).toBe("tenant-a");
  });
});
