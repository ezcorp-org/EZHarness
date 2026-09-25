import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryWorkerProgress } from "./background-workers";
import { FactoryCheckpointCoordinator, type FactoryCheckpointPoolSource, type FactoryCheckpointSlotSource } from "./checkpoint-barrier";
import { createPoolCheckpointClient, type PoolAdmissionClient, type PoolCheckpointClient } from "./pool/client";
import type { FactoryRestorePoolLedger } from "./restore";
import { factoryPoolSnapshotFromPages } from "./pool/checkpoint";
import { S3FactoryRecoveryArchive } from "./recovery-archive";
import { S3FactoryReleaseArchive } from "./release-adapters";
import { loadFactoryStorageCredentials } from "./release-composition";
import { readPrivatePath } from "./private-files";
import { FactoryRetention, S3FactoryRetentionBlobEraser } from "./retention";
import type { FactoryStartupConfig } from "./startup-config";
import { FactoryTemporalHttpPositions } from "./temporal-retention";

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
 * `checkpoint-barrier` keeps a sealed checkpoint younger than the interval.
 * The database refuses a release claim or attempt launch whenever the newest
 * sealed checkpoint is older than fifteen minutes, whether or not this role
 * runs: an installation that cannot run barriers fails closed, and readiness
 * reports the held role. Each barrier holds one of the pool's sixteen
 * cluster-wide slots and records every live workflow's Temporal position.
 */

/** How often a barrier runs. Well inside the fifteen-minute bound, so one aborted barrier never lets it lapse. */
export const FACTORY_CHECKPOINT_INTERVAL_MS = 5 * 60_000;

export type FactoryRoleStep = (signal: AbortSignal) => Promise<FactoryWorkerProgress>;

export interface FactoryRecoveryRoles {
  readonly retention?: FactoryRoleStep;
  readonly checkpoint?: FactoryRoleStep;
  /**
   * The recovery sections the startup document does not declare. Recovery is
   * required, so the barrier holds and effect claims stay closed; this names
   * why, apart from a declared section that failed to compose.
   */
  readonly undeclared?: readonly FactoryRecoverySection[];
}

/**
 * The startup-document sections recovery needs that have no default. The key
 * service defaults to the operator key file; the Temporal HTTP endpoint has
 * no default, because no checkpoint may omit Temporal positions.
 */
export const FACTORY_RECOVERY_SECTIONS = Object.freeze(["temporalHttp"] as const);
export type FactoryRecoverySection = (typeof FACTORY_RECOVERY_SECTIONS)[number];

/** The recovery sections this document leaves out. */
export function factoryUndeclaredRecoverySections(config: Pick<FactoryStartupConfig, FactoryRecoverySection>): readonly FactoryRecoverySection[] {
  return FACTORY_RECOVERY_SECTIONS.filter(section => config[section] === undefined);
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

/** The pool's cluster-wide barrier slots over the tenant's mutual-TLS client. */
export function factoryPoolCheckpointClientSlots(client: Pick<PoolCheckpointClient, "acquireCheckpointSlot" | "releaseCheckpointSlot">): FactoryCheckpointSlotSource {
  return {
    acquire: async signal => { const slot = await client.acquireCheckpointSlot(signal); return slot === null ? null : { token: slot.token }; },
    release: async (token, signal) => { await client.releaseCheckpointSlot(token, signal); },
  };
}

/**
 * The tenant namespace's Temporal position reader, from the startup document.
 * No endpoint means no checkpoint could record positions, so the barrier role
 * does not compose and holds by name.
 */
export async function factoryTemporalPositionsFromConfig(config: Pick<FactoryStartupConfig, "temporalNamespace" | "temporalHttp">): Promise<FactoryTemporalHttpPositions> {
  const http = config.temporalHttp;
  if (http === undefined) throw new Error("the startup document declares no temporalHttp endpoint, so no checkpoint could record Temporal positions");
  const text = async (path: string) => new TextDecoder("utf-8", { fatal: true }).decode(await readPrivatePath(path, 64 * 1024));
  return new FactoryTemporalHttpPositions({
    endpoint: http.endpoint, namespace: config.temporalNamespace,
    ...(http.tls === undefined ? {} : { tls: { cert: await text(http.tls.certificatePath), key: await text(http.tls.privateKeyPath), ca: await text(http.tls.caPath) } }),
  });
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
  const undeclared = factoryUndeclaredRecoverySections(config);
  const declaredness = undeclared.length === 0 ? {} : { undeclared };
  let archiveOptions: ConstructorParameters<typeof S3FactoryRecoveryArchive>[0];
  try {
    archiveOptions = { endpoint: config.storage.archive.endpoint, bucket: config.storage.archive.bucket, prefix: config.storage.archive.prefix, credentials: { ...await loadFactoryStorageCredentials(config.storage.archive, config.tenantId) } };
  } catch (error) {
    report("recovery-archive", error);
    return declaredness;
  }
  const archive = new S3FactoryRecoveryArchive(archiveOptions);
  const roles: { retention?: FactoryRoleStep; checkpoint?: FactoryRoleStep; undeclared?: readonly FactoryRecoverySection[] } = { ...declaredness };
  try {
    const eraser = new S3FactoryRetentionBlobEraser({ endpoint: config.storage.ordinary.endpoint, bucket: config.storage.ordinary.bucket, prefix: config.storage.ordinary.prefix, credentials: { ...await loadFactoryStorageCredentials(config.storage.ordinary, config.tenantId) } });
    roles.retention = factoryRetentionStep(new FactoryRetention({ database, tenantId: config.tenantId, installationId: config.installationId, archive, releaseArchive: new S3FactoryReleaseArchive({ ...archiveOptions, credentials: { ...archiveOptions.credentials } }), eraser }));
  } catch (error) { report("retention-gc", error); }
  // Not declared is not a failure to compose: the barrier holds with its own reason.
  if (undeclared.length > 0) return roles;
  try {
    const client = await (input.poolClient ?? (() => createPoolCheckpointClient({
      tenantId: config.tenantId, baseUrl: config.pool.baseUrl,
      tls: { caPath: config.pool.tls.caPath, certificatePath: config.pool.tls.certificatePath, privateKeyPath: config.pool.tls.privateKeyPath, serviceTokenPath: config.pool.serviceTokenPath },
    })))();
    const temporal = await factoryTemporalPositionsFromConfig(config);
    const coordinator = new FactoryCheckpointCoordinator({ database, tenantId: config.tenantId, installationId: config.installationId, archive, pool: factoryPoolCheckpointClientSource(client), slots: factoryPoolCheckpointClientSlots(client), temporal, keyService: config.keyManagement?.kind ?? "operator-master-key" });
    roles.checkpoint = factoryCheckpointStep(coordinator, report);
  } catch (error) { report("checkpoint-barrier", error); }
  return roles;
}
