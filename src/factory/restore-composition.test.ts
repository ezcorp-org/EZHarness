import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryCheckpointTemporalSource } from "./checkpoint-barrier";
import type { PoolAdmissionClient, PoolCheckpointClient } from "./pool/client";
import type { FactoryReleaseProvider } from "./releases";
import type { FactoryRestore, FactoryRestoreOptions } from "./restore";
import { composeFactoryRestore } from "./restore-composition";
import type { FactoryStartupConfig } from "./startup-config";
import type { FactoryPhysicalStopper } from "./task-stops";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(process.env.HOME!, ".w15-restore-composition-"));
  for (const kind of ["ordinary", "archive"]) await writeFile(join(directory, `${kind}.json`), JSON.stringify({ identities: [{ name: "tenant-r", credentials: [{ accessKey: `${kind}-access`, secretKey: `${kind}-secret` }] }] }), { mode: 0o600 });
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function config(extra: Partial<FactoryStartupConfig> = {}): FactoryStartupConfig {
  const storage = (kind: string) => ({ endpoint: `http://${kind}.invalid`, bucket: "tenant-r", prefix: kind, credentialSet: `${kind}-set`, credentialsPath: join(directory, `${kind}.json`) });
  return {
    tenantId: "tenant-r", installationId: "installation-r", temporalNamespace: "tenant-r.factory",
    storage: { ordinary: storage("ordinary"), archive: storage("archive") },
    pool: { baseUrl: "https://pool.invalid", serviceTokenPath: join(directory, "missing-token"), tls: { caPath: join(directory, "ca"), certificatePath: join(directory, "cert"), privateKeyPath: join(directory, "key") } },
    keys: { masterKeyFilePath: join(directory, "master.key"), masterKeyId: "master-1", wrappedKeyFilePath: join(directory, "wraps.json"), grantableRoots: ["/srv/project"] },
    ...extra,
  } as unknown as FactoryStartupConfig;
}

const fence = { closeIngress: async () => "closed", revokeCredentials: async () => "revoked" };
const options = (restore: FactoryRestore) => (restore as unknown as { options: FactoryRestoreOptions }).options;
const intent = { operationId: "op", tenantId: "tenant-r", projectId: "p", runId: "r", destination: { provider: "fixture", account: "a", object: "o" } } as never;

describe("a restore composed from the startup document", () => {
  test("every part that cannot compose is reported by name and left out, so the restore blocks on it", async () => {
    const reports: string[] = [];
    const restore = await composeFactoryRestore({ config: config(), database: {} as TransactionalDb, fence, report: part => reports.push(part) });
    expect(reports).toEqual(["restore-pool", "restore-temporal", "restore-host-keys"]);
    const composed = options(restore);
    expect(composed.pool).toBeUndefined();
    expect(composed.temporal).toBeUndefined();
    expect(composed.workers).toBeUndefined();
    expect(composed.hostKeys.size).toBe(0);
    expect(composed.projections).toBeUndefined();
    // No release providers: every archived release blocks as provider_unavailable.
    expect(await composed.providers(intent)).toBeNull();
    // The key check opens the data key through the selected service: here the operator key file, which is absent.
    await expect(composed.loadDataKey()).rejects.toMatchObject({ code: "factory_key_missing" });
  });

  test("supplied collaborators are used as the installation composed them", async () => {
    const stops: unknown[] = [];
    const stopper: FactoryPhysicalStopper = { stop: async (request, _signal) => { stops.push(request); return { receiptDigest: "r" } as never; } };
    const provider = { name: "fixture" } as unknown as FactoryReleaseProvider;
    const temporal: FactoryCheckpointTemporalSource = { namespace: "tenant-r.factory", positions: async () => [] };
    const checkpoints = { checkpoint: async () => ({ position: "0/0", rows: [], next: null }) } as unknown as PoolCheckpointClient;
    const admission = { confirmStopped: async () => ({ state: "released" }) } as unknown as PoolAdmissionClient;
    const projections = { project: async () => undefined };
    const reports: string[] = [];
    const restore = await composeFactoryRestore({
      config: config(), database: {} as TransactionalDb, fence, report: part => reports.push(part),
      providers: { resolve: operation => { if (operation.destination.provider !== "fixture") throw new Error("unknown"); return provider; } },
      stopper, temporal, projections, poolClients: async () => ({ checkpoints, admission }),
    });
    expect(reports).toEqual(["restore-host-keys"]);
    const composed = options(restore);
    expect(composed.temporal).toBe(temporal);
    expect(composed.poolStops).toBe(admission);
    expect(composed.projections).toBe(projections);
    expect((await composed.pool!.liveRows("tenant-r"))).toEqual([]);
    expect(await composed.providers(intent)).toBe(provider);
    expect(await composed.providers({ ...(intent as object), destination: { provider: "other", account: "a", object: "o" } } as never)).toBeNull();
    await composed.workers!.stop({ attemptId: "a", reservationId: "r", workerId: "w", holderGeneration: 1, allocationGeneration: 1, hostId: "h", reason: "lease-revoked" }, new AbortController().signal);
    expect(stops).toEqual([{ attemptId: "a", reservationId: "r", workerId: "w", holderGeneration: 1, allocationGeneration: 1, hostId: "h", reason: "lease-revoked" }]);
  });

  test("the archive and the ordinary store are required: without them there is nothing to restore from", async () => {
    const missing = config({ storage: { ...config().storage, archive: { ...config().storage.archive, credentialsPath: join(directory, "absent.json") } } } as never);
    await expect(composeFactoryRestore({ config: missing, database: {} as TransactionalDb, fence, report: () => {} })).rejects.toMatchObject({ code: "factory-storage-credentials-unusable" });
  });
});
