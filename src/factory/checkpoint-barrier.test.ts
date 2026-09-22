import { describe, expect, test } from "bun:test";
import { factoryWorkflowId } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import { factoryRecoveryMemoryStores } from "../__tests__/helpers/factory-recovery-memory";
import { FACTORY_CHECKPOINT_LIMITS, FACTORY_CHECKPOINT_MANIFEST_SCHEMA, FACTORY_CHECKPOINT_SEAL_SCHEMA, FACTORY_CHECKPOINT_SEALS_RECORD, FactoryCheckpointCoordinator, FactoryCheckpointError, factoryInterpreterWorkflowId, latestFactoryCheckpoint, readFactoryCheckpointManifest, runFactoryCheckpointCycle, type FactoryCheckpointOutcome } from "./checkpoint-barrier";
import { writeFactoryRecoveryJson } from "./recovery-archive";

describe("the checkpoint cycle across tenants", () => {
  test("at most sixteen barriers are ever in flight, and every tenant gets one", async () => {
    let inFlight = 0, peak = 0;
    let open!: () => void;
    const full = new Promise<void>(settle => { open = settle; });
    const tenants = Array.from({ length: 100 }, (_, index) => ({
      tenantId: `tenant-${index}`,
      async run(): Promise<FactoryCheckpointOutcome> {
        inFlight += 1; peak = Math.max(peak, inFlight);
        // The first sixteen hold until all sixteen lanes are busy, which is the
        // observed moment the bound is tested; later ones return at once.
        if (inFlight === FACTORY_CHECKPOINT_LIMITS.maxConcurrentBarriers) open();
        if (index < FACTORY_CHECKPOINT_LIMITS.maxConcurrentBarriers) await full;
        inFlight -= 1;
        if (index === 7) throw new Error("tenant database unreachable");
        return { kind: "skipped", reason: "restore_epoch_open" };
      },
    }));
    const cycle = await runFactoryCheckpointCycle(tenants, { monotonic: () => 0 });
    expect(cycle.maxInFlight).toBe(16);
    expect(peak).toBe(16);
    expect(cycle.outcomes).toHaveLength(100);
    expect(cycle.outcomes[7]).toEqual({ tenantId: "tenant-7", outcome: { kind: "failed", error: "tenant database unreachable" } });
    expect(cycle.durationMs).toBe(0);
  });

  test("a smaller bound is honoured, a larger one is refused, and a cancelled cycle starts nothing new", async () => {
    let peak = 0, inFlight = 0;
    const tenant = (id: string) => ({ tenantId: id, async run(): Promise<FactoryCheckpointOutcome> { inFlight += 1; peak = Math.max(peak, inFlight); await Promise.resolve(); inFlight -= 1; return { kind: "skipped", reason: "restore_epoch_open" }; } });
    expect((await runFactoryCheckpointCycle([tenant("a"), tenant("b"), tenant("c")], { maxConcurrent: 2 })).maxInFlight).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);
    await expect(runFactoryCheckpointCycle([], { maxConcurrent: 17 })).rejects.toBeInstanceOf(FactoryCheckpointError);
    await expect(runFactoryCheckpointCycle([], { maxConcurrent: 0 })).rejects.toBeInstanceOf(FactoryCheckpointError);
    const cancelled = new AbortController(); cancelled.abort();
    expect((await runFactoryCheckpointCycle([tenant("a")], { signal: cancelled.signal })).outcomes).toEqual([]);
    expect((await runFactoryCheckpointCycle([])).outcomes).toEqual([]);
    const plain = await runFactoryCheckpointCycle([{ tenantId: "x", run: async () => { throw "not an error object"; } }]);
    expect(plain.outcomes[0]).toEqual({ tenantId: "x", outcome: { kind: "failed", error: "not an error object" } });
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
