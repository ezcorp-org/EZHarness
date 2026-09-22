import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryWorkerProgress } from "./background-workers";
import { FactoryCheckpointCoordinator, type FactoryCheckpointPoolSource } from "./checkpoint-barrier";
import { createPoolCheckpointClient, type PoolAdmissionClient, type PoolCheckpointClient } from "./pool/client";
import type { FactoryRestorePoolLedger } from "./restore";
import { factoryPoolSnapshotFromPages } from "./pool/checkpoint";
import { S3FactoryRecoveryArchive } from "./recovery-archive";
import { S3FactoryReleaseArchive } from "./release-adapters";
import { loadFactoryStorageCredentials } from "./release-composition";
import { FactoryRetention, S3FactoryRetentionBlobEraser } from "./retention";
import type { FactoryStartupConfig } from "./startup-config";

/**
 * W15's two background roles, composed for the product process.
 *
 * The product process already holds what both need: its product database, the
 * ordinary store's credentials (for erasing an expired candidate's current
 * version), and the archive writer's credential set (for archived audit
 * streams, checkpoint manifests, and seals). The pool ledger is reached over
 * its own tenant-scoped mutual-TLS client, never its database.
 *
 * `retention-gc` enrolls, archives early, and collects due subjects.
 * `checkpoint-barrier` keeps a sealed checkpoint younger than the interval;
 * on its first pass it turns on the database's freshness rule, so from then on
 * a release claim or attempt launch is refused whenever the newest sealed
 * checkpoint is older than fifteen minutes. The rule is enforced only where
 * this role runs, because an installation that cannot run barriers would
 * otherwise have its effect claims closed forever.
 */

/** How often a barrier runs. Well inside the fifteen-minute bound, so one aborted barrier never lets it lapse. */
export const FACTORY_CHECKPOINT_INTERVAL_MS = 5 * 60_000;

export type FactoryRoleStep = (signal: AbortSignal) => Promise<FactoryWorkerProgress>;

export interface FactoryRecoveryRoles {
  readonly retention?: FactoryRoleStep;
  readonly checkpoint?: FactoryRoleStep;
}

/** One retention pass. Work is a state change: an enrollment, an archive copy, or a collection. */
export function factoryRetentionStep(retention: Pick<FactoryRetention, "enroll" | "archivePending" | "collectDue">): FactoryRoleStep {
  return async signal => {
    const enrolled = await retention.enroll();
    const archived = await retention.archivePending(undefined, signal);
    const collected = (await retention.collectDue(undefined, signal)).filter(outcome => outcome.action === "collected").length;
    return enrolled + archived + collected > 0 ? "worked" : "idle";
  };
}

/**
 * One checkpoint pass. A fresh checkpoint means no work. An aborted barrier is
 * reported and the role goes idle, so the next attempt waits for the role's
 * idle delay instead of spinning; the interval leaves room for several.
 */
export function factoryCheckpointStep(coordinator: Pick<FactoryCheckpointCoordinator, "enforceFreshness" | "newest" | "run">, report: (role: string, error: unknown) => void, intervalMs = FACTORY_CHECKPOINT_INTERVAL_MS): FactoryRoleStep {
  let enforced = false;
  return async signal => {
    if (!enforced) { await coordinator.enforceFreshness(); enforced = true; }
    const newest = await coordinator.newest();
    if (newest !== null && newest.ageMs < intervalMs) return "idle";
    const outcome = await coordinator.run(signal);
    if (outcome.kind === "aborted") report("checkpoint-barrier", new Error(`checkpoint barrier ${outcome.checkpointId} aborted with ${outcome.code} after ${outcome.durationMs} ms; no checkpoint was claimed`));
    return outcome.kind === "sealed" ? "worked" : "idle";
  };
}

/** The pool checkpoint source over the tenant's mutual-TLS client. */
export function factoryPoolCheckpointClientSource(client: Pick<PoolCheckpointClient, "checkpoint">): FactoryCheckpointPoolSource {
  return { snapshotTenant: (_tenantId, signal) => factoryPoolSnapshotFromPages(after => client.checkpoint(after, signal)) };
}

/** Rows per restore-import request, inside the pool wire's 16 KiB body bound. */
export const FACTORY_RESTORE_IMPORT_CHUNK = 16;

/**
 * The restore's pool half over the tenant's two mutual-TLS clients: the
 * checkpoint client lists and re-imports, and admission's own `cancel` revokes.
 * The restore credential must carry `pool:restore:<tenant>`.
 */
export function factoryClientRestorePoolLedger(checkpoints: PoolCheckpointClient, admission: Pick<PoolAdmissionClient, "cancel">): FactoryRestorePoolLedger {
  return {
    async importLost(_tenantId, snapshot) {
      const present = new Set<string>(), imported: string[] = [], overcommitted: string[] = [];
      for (let offset = 0; offset === 0 || offset < snapshot.length; offset += FACTORY_RESTORE_IMPORT_CHUNK) {
        const result = await checkpoints.restoreImport(snapshot.slice(offset, offset + FACTORY_RESTORE_IMPORT_CHUNK));
        for (const id of result.present) present.add(id);
        imported.push(...result.imported); overcommitted.push(...result.overcommitted);
      }
      return { present: [...present].sort(), imported, overcommitted };
    },
    liveRows: async (_tenantId, signal) => (await factoryPoolSnapshotFromPages(after => checkpoints.checkpoint(after, signal))).rows,
    revoke: async (reservationId, allocationGeneration, signal) => ({ state: (await admission.cancel(reservationId, allocationGeneration, signal)).state }),
  };
}

export interface FactoryRecoveryCompositionInput {
  readonly config: FactoryStartupConfig;
  readonly database: TransactionalDb;
  readonly report: (role: string, error: unknown) => void;
  /** Overridden in tests; production builds the pool client from `config.pool`. */
  readonly poolClient?: () => Promise<PoolCheckpointClient>;
}

/**
 * Builds both roles from the startup document. A role that cannot compose is
 * reported under its own name and left out, and `registerFactoryRuntimeWorkers`
 * then holds it by name with the reason — the same rule every other role follows.
 */
export async function composeFactoryRecoveryRoles(input: FactoryRecoveryCompositionInput): Promise<FactoryRecoveryRoles> {
  const { config, database, report } = input;
  let archiveOptions: ConstructorParameters<typeof S3FactoryRecoveryArchive>[0];
  try {
    archiveOptions = { endpoint: config.storage.archive.endpoint, bucket: config.storage.archive.bucket, prefix: config.storage.archive.prefix, credentials: { ...await loadFactoryStorageCredentials(config.storage.archive, config.tenantId) } };
  } catch (error) {
    report("recovery-archive", error);
    return {};
  }
  const archive = new S3FactoryRecoveryArchive(archiveOptions);
  const roles: { retention?: FactoryRoleStep; checkpoint?: FactoryRoleStep } = {};
  try {
    const eraser = new S3FactoryRetentionBlobEraser({ endpoint: config.storage.ordinary.endpoint, bucket: config.storage.ordinary.bucket, prefix: config.storage.ordinary.prefix, credentials: { ...await loadFactoryStorageCredentials(config.storage.ordinary, config.tenantId) } });
    roles.retention = factoryRetentionStep(new FactoryRetention({ database, tenantId: config.tenantId, installationId: config.installationId, archive, releaseArchive: new S3FactoryReleaseArchive({ ...archiveOptions, credentials: { ...archiveOptions.credentials } }), eraser }));
  } catch (error) { report("retention-gc", error); }
  try {
    const client = await (input.poolClient ?? (() => createPoolCheckpointClient({
      tenantId: config.tenantId, baseUrl: config.pool.baseUrl,
      tls: { caPath: config.pool.tls.caPath, certificatePath: config.pool.tls.certificatePath, privateKeyPath: config.pool.tls.privateKeyPath, serviceTokenPath: config.pool.serviceTokenPath },
    })))();
    const coordinator = new FactoryCheckpointCoordinator({ database, tenantId: config.tenantId, installationId: config.installationId, archive, pool: factoryPoolCheckpointClientSource(client) });
    roles.checkpoint = factoryCheckpointStep(coordinator, report);
  } catch (error) { report("checkpoint-barrier", error); }
  return roles;
}
