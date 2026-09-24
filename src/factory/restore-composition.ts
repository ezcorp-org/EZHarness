import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryCheckpointTemporalSource } from "./checkpoint-barrier";
import { loadFactoryStopHostKeys } from "./dispatch-composition";
import { composeFactoryDataKeyWrapper, loadFactoryInstallationDataKey, type FactoryKeyCompositionDependencies } from "./key-composition";
import { createPoolAdmissionClient, createPoolCheckpointClient, type PoolAdmissionClient, type PoolCheckpointClient } from "./pool/client";
import { readPrivatePath } from "./private-files";
import { factoryClientRestorePoolLedger, factoryTemporalPositionsFromConfig } from "./recovery-composition";
import { S3FactoryRecoveryArchive } from "./recovery-archive";
import type { FactoryReleaseProviderResolver } from "./release-application";
import { S3FactoryReleaseArchive } from "./release-adapters";
import { loadFactoryStorageCredentials } from "./release-composition";
import type { FactoryReleaseOperation } from "./releases";
import { FactoryRestore, S3FactoryObjectVersionProbe, type FactoryRestoreFence, type FactoryRestoreOptions } from "./restore";
import type { FactoryStartupConfig } from "./startup-config";
import { factoryStopHostKeyMap, type FactoryPhysicalStopper } from "./task-stops";

/**
 * A restore composed from the installation's own startup document (C06, W15).
 *
 * Every part the document can build is built; a part it cannot build is
 * reported by name and left out, and the restore then records a blocking
 * finding for it instead of assuming it: no pool client means the pool check
 * blocks, no host transport means every live worker blocks, no Temporal reader
 * means the Temporal check blocks. Only the archive and the ordinary store are
 * required, because without them there is nothing to restore from.
 */

export interface FactoryRestoreCompositionInput {
  readonly config: FactoryStartupConfig;
  readonly database: TransactionalDb;
  readonly fence: FactoryRestoreFence;
  readonly report: (part: string, error: unknown) => void;
  /** The installation's release providers, from its own release composition. */
  readonly providers?: FactoryReleaseProviderResolver;
  /** The installation's host stop client. */
  readonly stopper?: FactoryPhysicalStopper;
  /** The installation's run projector, so projections are rebuilt before service resumes. */
  readonly projections?: FactoryRestoreOptions["projections"];
  readonly keys?: FactoryKeyCompositionDependencies;
  /** Overridden in tests; production builds both clients from `config.pool`. */
  readonly poolClients?: () => Promise<{ readonly checkpoints: PoolCheckpointClient; readonly admission: PoolAdmissionClient }>;
  /** Overridden in tests; production reads positions through `config.temporalHttp`. */
  readonly temporal?: FactoryCheckpointTemporalSource;
}

async function optional<Value>(part: string, report: FactoryRestoreCompositionInput["report"], build: () => Promise<Value>): Promise<Value | undefined> {
  try { return await build(); }
  catch (error) { report(part, error); return undefined; }
}

function poolClients(config: FactoryStartupConfig): () => Promise<{ readonly checkpoints: PoolCheckpointClient; readonly admission: PoolAdmissionClient }> {
  return async () => {
    const options = { tenantId: config.tenantId, baseUrl: config.pool.baseUrl, tls: { caPath: config.pool.tls.caPath, certificatePath: config.pool.tls.certificatePath, privateKeyPath: config.pool.tls.privateKeyPath, serviceTokenPath: config.pool.serviceTokenPath } };
    return { checkpoints: await createPoolCheckpointClient(options), admission: await createPoolAdmissionClient(options) };
  };
}

export async function composeFactoryRestore(input: FactoryRestoreCompositionInput): Promise<FactoryRestore> {
  const { config, report } = input;
  const archiveOptions = { endpoint: config.storage.archive.endpoint, bucket: config.storage.archive.bucket, prefix: config.storage.archive.prefix, credentials: { ...await loadFactoryStorageCredentials(config.storage.archive, config.tenantId) } };
  const ordinaryCredentials = await loadFactoryStorageCredentials(config.storage.ordinary, config.tenantId);
  const pool = await optional("restore-pool", report, input.poolClients ?? poolClients(config));
  const temporal = input.temporal ?? await optional("restore-temporal", report, () => factoryTemporalPositionsFromConfig(config));
  const hostKeys = await optional("restore-host-keys", report, async () => factoryStopHostKeyMap(await loadFactoryStopHostKeys(config.hostStopKeys ?? [])));
  const providers = input.providers;
  const stopper = input.stopper;
  return new FactoryRestore({
    database: input.database, tenantId: config.tenantId, installationId: config.installationId,
    archive: new S3FactoryRecoveryArchive(archiveOptions),
    releaseArchive: new S3FactoryReleaseArchive({ ...archiveOptions, credentials: { ...archiveOptions.credentials } }),
    loadDataKey: async () => loadFactoryInstallationDataKey(config, await composeFactoryDataKeyWrapper(config, input.keys)),
    objects: new S3FactoryObjectVersionProbe({ endpoint: config.storage.ordinary.endpoint, bucket: config.storage.ordinary.bucket, prefix: config.storage.ordinary.prefix, credentials: { ...ordinaryCredentials } }),
    fence: input.fence,
    // The host stop client carries the stop command's fields as they are; see `factoryHostStopper`.
    ...(stopper === undefined ? {} : { workers: { stop: (command, signal) => stopper.stop(command as unknown as Parameters<FactoryPhysicalStopper["stop"]>[0], signal) } }),
    hostKeys: hostKeys ?? new Map(),
    ...(pool === undefined ? {} : { pool: factoryClientRestorePoolLedger(pool.checkpoints, pool.admission), poolStops: pool.admission }),
    ...(temporal === undefined ? {} : { temporal }),
    // A provider this installation cannot name reconciles nothing: the release blocks as `provider_unavailable`.
    providers: async intent => {
      if (providers === undefined) return null;
      try { return await providers.resolve({ ...intent, tenantId: config.tenantId } as unknown as FactoryReleaseOperation); }
      catch { return null; }
    },
    ...(input.projections === undefined ? {} : { projections: input.projections }),
  });
}

/**
 * The fence an operator (or W16's provisioner) attests for one restore: a
 * private JSON file `{ restoreId, ingress, credentials }` written after the old
 * deployment's ingress route was withdrawn and its service credentials were
 * revoked. The restore refuses a file for another restore, and a refusal
 * blocks the restore.
 */
export function factoryAttestedRestoreFence(path: string): FactoryRestoreFence {
  const statement = async (restoreId: string, field: "ingress" | "credentials"): Promise<string> => {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readPrivatePath(path, 16 * 1024))) as Record<string, unknown>;
    const value = parsed[field];
    if (parsed.restoreId !== restoreId) throw new Error(`the fence attestation is for another restore`);
    if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new Error(`the fence attestation names no ${field} fence`);
    return value;
  };
  return {
    closeIngress: restoreId => statement(restoreId, "ingress"),
    revokeCredentials: restoreId => statement(restoreId, "credentials"),
  };
}
