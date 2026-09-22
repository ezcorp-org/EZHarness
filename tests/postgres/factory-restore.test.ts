import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { s3ObjectKey } from "../../src/extensions/v4/blobs";
import { signFactoryAttemptToken, verifyFactoryAttemptToken } from "../../src/factory/attempt-token";
import { FactoryCheckpointCoordinator, latestFactoryCheckpoint, type FactoryCheckpointManifest, type FactoryCheckpointTemporalSource } from "../../src/factory/checkpoint-barrier";
import { InstallationDataKey, StaticMasterKeyProvider, type MasterKey } from "../../src/factory/encryption";
import { DatabaseInstallationKeyWrapStore } from "../../src/factory/encryption-key-wrap-store";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../src/factory/executions";
import type { FactoryPrincipal } from "../../src/factory/grants";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { FactoryPoolCheckpointSource, factoryDirectRestorePoolLedger } from "../../src/factory/pool/checkpoint";
import { FactoryPoolLedger, setupFactoryPoolLedger, type PoolSql } from "../../src/factory/pool/ledger";
import { FactoryRecords } from "../../src/factory/records";
import { readFactoryRunAudit } from "../../src/factory/audit-archive";
import { FactoryRestore, factoryRestoreReportDigest, runFactoryClusterRestore, S3FactoryObjectVersionProbe, type FactoryRestoreFence, type FactoryRestoreReport } from "../../src/factory/restore";
import { FactoryRetention, factoryRetentionSubjectId } from "../../src/factory/retention";
import { createFactoryReleaseWorld, digest, type FactoryReleaseWorld } from "../../src/__tests__/helpers/factory-release-world";
import { FactoryRecoveryDatabases, FactorySigningSupervisor, launchFactoryAttempt, type FactoryOpenDatabase } from "./helpers/factory-recovery-databases";
import { factoryRecoveryStorage } from "./helpers/factory-recovery-storage";

/**
 * C06 restore against real PostgreSQL copies, the real ordinary store, and the
 * real independent archive. One old deployment runs to a sealed checkpoint; a
 * byte copy taken at that barrier is the backup; the old deployment then keeps
 * working (a real release, more audit, a new guest) and is lost. Every restore
 * below starts from a fresh copy of that one backup.
 */

const tenantId = "restore-tenant";
const installationId = "restore-installation";
const projectId = "restore-project";
const hostId = "restore-host";
const admin: FactoryPrincipal = { kind: "user", id: "restore-admin", authentication: "session" };
const master: MasterKey = { id: "master-1", bytes: new Uint8Array(32).fill(9) };
const evidence = process.env.W15_EVIDENCE_DIR;
const measurements: Record<string, unknown> = {};

const databases = new FactoryRecoveryDatabases();
let storage: Awaited<ReturnType<typeof factoryRecoveryStorage>>;
let primary: FactoryOpenDatabase;
let pool: FactoryOpenDatabase;
let ledger: FactoryPoolLedger;
let world: FactoryReleaseWorld;
let backup: string;
let manifest: FactoryCheckpointManifest;
let candidate: { blobDigest: string; storageVersion: string };
let guestAuthority: FactoryAttemptAuthority;
let failureAtMs: number;
const supervisor = new FactorySigningSupervisor(hostId);
const fenceCalls: string[] = [];
const heads = new Map<string, string | null>();

const fence: FactoryRestoreFence = {
  async closeIngress(restoreId) { fenceCalls.push(`ingress:${restoreId}`); return "ingress route withdrawn for the old deployment"; },
  async revokeCredentials(restoreId) { fenceCalls.push(`credentials:${restoreId}`); return "old deployment service credential generation revoked"; },
};

async function append(db: FactoryOpenDatabase["db"], runId: string, sourceSequence: number): Promise<void> {
  const key = `${runId}`;
  const batch = await new FactoryRecords(db, tenantId).appendAudit({ projectId, runId, interpreterId: "root", sourceSequence, predecessorDigest: heads.get(key) ?? null, payload: { step: sourceSequence } });
  heads.set(key, batch.digest);
}

async function lifecycle(db: FactoryOpenDatabase["db"], runId: string, status: string, updatedMs = Date.now()): Promise<void> {
  await db.execute(sql`INSERT INTO factory_run_lifecycle(tenant_id,project_id,run_id,factory_id,factory_version,definition_digest,grant_revision,status,deadline_ms,parameters_json,parameters_digest,updated_at)
    VALUES (${tenantId},${projectId},${runId},'restore-factory','v1',${digest("d")},1,${status},${Date.now() + 86_400_000},'{}',${digest("e")},to_timestamp(${updatedMs}::double precision / 1000))`);
}

function restoreFor(db: FactoryOpenDatabase["db"], options: { masters?: MasterKey[]; temporal?: FactoryCheckpointTemporalSource; poolSql?: PoolSql; poolLedger?: FactoryPoolLedger; tenant?: string } = {}): FactoryRestore {
  const poolSql = options.poolSql ?? pool.client as unknown as PoolSql;
  const poolLedger = options.poolLedger ?? ledger;
  return new FactoryRestore({
    database: db, tenantId: options.tenant ?? tenantId, installationId,
    archive: storage.archive, releaseArchive: storage.releaseArchive,
    loadDataKey: () => InstallationDataKey.loadExisting(installationId, new DatabaseInstallationKeyWrapStore(db), new StaticMasterKeyProvider((options.masters ?? [master])[0]!, options.masters ?? [master])),
    objects: new S3FactoryObjectVersionProbe({ endpoint: "unused", bucket: storage.tenant, prefix: storage.ordinaryPrefix, credentials: { accessKeyId: "unused", secretAccessKey: "unused" }, client: storage.ordinaryClient }),
    fence, workers: supervisor, hostKeys: supervisor.hostKeys,
    poolStops: { confirmStopped: async input => poolLedger.confirmStopped(input) },
    pool: factoryDirectRestorePoolLedger(poolSql, poolLedger),
    ...(options.temporal ? { temporal: options.temporal } : {}),
    providers: () => world.provider,
    // The run view, rebuilt by replay before service resumes: the projector's
    // own contract (contiguous, verified, idempotent) over the restored stream.
    projections: {
      async project(key) {
        const records = new FactoryRecords(db, options.tenant ?? tenantId);
        for (const batch of await readFactoryRunAudit(records, key)) await records.project(batch, "restore-view", (current, next) => ({ steps: [...((current as { steps?: unknown[] } | null)?.steps ?? []), next.sourceSequence] }));
      },
    },
  });
}

async function restoredCopy(label: string, from = backup): Promise<FactoryOpenDatabase> {
  return databases.open(await databases.copy(from, label));
}

function finding(report: FactoryRestoreReport, kind: string, subjectId: string) {
  return report.findings.find(item => item.subjectKind === kind && item.subjectId === subjectId);
}

beforeAll(async () => {
  storage = await factoryRecoveryStorage();
  primary = await databases.migrated("primary");
  pool = await databases.empty("pool");
  await setupFactoryPoolLedger(pool.client as unknown as PoolSql);
  ledger = new FactoryPoolLedger(pool.client as unknown as PoolSql);
  await ledger.configureCapacity("cpu", 8);

  world = await createFactoryReleaseWorld({ database: primary.db, tenantId, projectId, admin, archive: storage.releaseArchive, now: Date.now });
  await primary.db.execute(sql`INSERT INTO factory_drafts(tenant_id,project_id,factory_id,revision,source_digest,source_json,required_resources_json,requirements_complete,validation_diagnostic_count) VALUES (${tenantId},${projectId},'restore-factory',1,${digest("d")},'{}','[]',TRUE,0)`);
  await primary.db.execute(sql`INSERT INTO factory_versions(tenant_id,project_id,factory_id,version,draft_revision,definition_digest,compiled_blob_digest,compiled_bytes,lock_json) VALUES (${tenantId},${projectId},'restore-factory','v1',1,${digest("d")},${"b".repeat(64)},1,'{}')`);
  await InstallationDataKey.loadOrCreate(installationId, new DatabaseInstallationKeyWrapStore(primary.db), new StaticMasterKeyProvider(master));

  // A settled release before the checkpoint.
  await (await world.acceptRun("run-pre")).release("pre");
  // A run with audit, and one whose audit expired into the archive before the checkpoint.
  const records = new FactoryRecords(primary.db, tenantId);
  await records.createRun({ projectId, runId: "run-audit", definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
  for (let step = 1; step <= 3; step += 1) await append(primary.db, "run-audit", step);
  await lifecycle(primary.db, "run-audit", "running");
  await records.createRun({ projectId, runId: "run-expired", definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
  for (let step = 1; step <= 2; step += 1) await append(primary.db, "run-expired", step);
  await lifecycle(primary.db, "run-expired", "succeeded", Date.now() - 400 * 86_400_000);
  const retention = new FactoryRetention({ database: primary.db, tenantId, installationId, archive: storage.archive, releaseArchive: storage.releaseArchive });
  await retention.enroll();
  const collected = await retention.collectDue();
  expect(collected.find(outcome => outcome.subjectId === factoryRetentionSubjectId(projectId, "run-expired"))?.action).toBe("collected");
  // An immutable candidate object in the ordinary versioned store.
  const bytes = new TextEncoder().encode("restore candidate bytes");
  const blobDigest = await storage.blobs.put(bytes);
  candidate = { blobDigest, storageVersion: await storage.blobs.version(blobDigest) };
  await primary.db.execute(sql`INSERT INTO factory_artifacts(object_id,tenant_id,project_id,run_id,kind,candidate_node_instance_id,candidate_generation,digest,blob_digest,storage_version,encoded_bytes) VALUES ('restore-candidate',${tenantId},${projectId},'run-audit','candidate_output','candidate-node',0,${digest("7")},${blobDigest},${candidate.storageVersion},${bytes.byteLength})`);
  // A guest running before the checkpoint, holding a real pool reservation.
  await records.createRun({ projectId, runId: "run-guest", definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
  await ledger.request({ reservationId: "reservation-guest", tenantId, grantRevision: 1, resources: { cpu: 1 }, admissionDeadline: new Date(Date.now() + 3_600_000) });
  const held = (await ledger.schedule())!;
  const guestLease = held.lease!;
  const authority = { attemptId: "attempt-guest", tenantId, projectId, runId: "run-guest", nodeInstanceId: "guest-node", candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: guestLease.allocationGeneration, executionEpoch: 1, cancellationEpoch: 0, deadlineAtMs: Date.now() + 3_600_000, nextOperationIndex: 0 };
  const request = await launchFactoryAttempt(primary.db, authority, { reservationId: "reservation-guest", allocationGeneration: guestLease.allocationGeneration, holderGeneration: guestLease.holderGeneration, hostId });
  const { deadlineAtMs, nextOperationIndex: _next, ...fields } = authority;
  guestAuthority = { ...fields, requestDigest: factoryRunnerRequestDigest(request), deadlineAt: new Date(deadlineAtMs) };

  // The barrier, then the backup at the barrier.
  const barrier = new FactoryCheckpointCoordinator({ database: primary.db, tenantId, installationId, archive: storage.archive, pool: new FactoryPoolCheckpointSource(pool.client as unknown as PoolSql) });
  const sealed = await barrier.run();
  expect(sealed.kind).toBe("sealed");
  manifest = (await latestFactoryCheckpoint(storage.archive, tenantId))!.manifest;
  await primary.close();
  backup = await databases.copy(primary.name, "backup");
  primary = databases.open(primary.name);

  // The old deployment keeps working after the checkpoint, then is lost.
  world = await createFactoryReleaseWorldReattached(primary);
  await (await world.acceptRun("run-post")).release("post");
  await append(primary.db, "run-audit", 4);
  await ledger.request({ reservationId: "reservation-post", tenantId, grantRevision: 1, resources: { cpu: 1 }, admissionDeadline: new Date(Date.now() + 3_600_000) });
  await ledger.schedule();
  failureAtMs = Date.now();
}, 180_000);

/** A release world bound to an existing database: the same store, grants, and provider memory. */
async function createFactoryReleaseWorldReattached(opened: FactoryOpenDatabase): Promise<FactoryReleaseWorld> {
  const provider = world.provider;
  // Grants already exist, so reattach by wrapping a new world whose grant writes are no-ops.
  const reattached = await createFactoryReleaseWorld({ database: opened.db, tenantId, projectId, admin: { ...admin, id: `${admin.id}-after` }, archive: storage.releaseArchive, now: Date.now });
  for (const [operationId, receipt] of provider.receipts) reattached.provider.receipts.set(operationId, receipt);
  return reattached;
}

afterAll(async () => {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(`${evidence}/restore-bounds.json`, `${JSON.stringify({ recordedAt: new Date().toISOString(), database: "real PostgreSQL (byte copy at the barrier)", archive: "real independent S3 archive (same host)", ...measurements }, null, 2)}\n`);
  }
  await primary?.close();
  await pool?.close();
  await databases.close();
  await storage?.cleanup().then(result => console.log(`w15 restore storage cleanup ${JSON.stringify(result)}`));
}, 120_000);

describe("restore into a new execution epoch", () => {
  test("a tenant restore fences the old epoch, recovers every release identity, proves the guest stopped, and waits for a human", async () => {
    const restored = await restoredCopy("tenant");
    try {
      const journal = new FactoryExecutionJournal(restored.db, async () => {});
      const token = await signFactoryAttemptToken(guestAuthority, "restore-secret", installationId, 600);
      expect(await journal.operations(guestAuthority)).toEqual([]);
      const restore = restoreFor(restored.db);
      const started = performance.now();
      const report = await restore.begin({ restoreId: "restore-main", mode: "tenant", failureAtMs });
      measurements.tenantRestore = { recoveryMs: report.measured.recoveryMs, internalProgressLossMs: report.measured.internalProgressLossMs, wallMs: Math.round(performance.now() - started) };
      expect(report.executionEpoch).toBe(report.previousEpoch + 1);
      expect(fenceCalls).toEqual(["ingress:restore-main", "credentials:restore-main"]);
      // The old-epoch broker token still verifies cryptographically, and the gateway refuses it.
      expect(await verifyFactoryAttemptToken(token, "restore-secret", installationId)).toMatchObject({ executionEpoch: 1 });
      await expect(journal.operations(guestAuthority)).rejects.toThrow("Factory run epoch is stale or unavailable.");
      for (const check of ["schema", "database-position", "keys", "object-versions"]) expect(finding(report, "check", check)?.disposition).toBe("verified");
      expect(finding(report, "projection", canonicalJson([projectId, "run-expired"]))).toMatchObject({ disposition: "reconciled", reason: "audit_imported_from_archive" });
      // Every projection was discarded and rebuilt by replay before service resumed.
      expect(rows<{ run_id: string; sequence: string | number; payload: string }>(await restored.db.execute(sql`SELECT run_id, sequence, payload FROM factory_run_projections WHERE tenant_id = ${tenantId} AND consumer_id = 'restore-view' ORDER BY run_id`)).map(row => [row.run_id, Number(row.sequence), JSON.parse(row.payload)])).toEqual([
        ["run-audit", 3, { steps: [1, 2, 3] }],
        ["run-expired", 2, { steps: [1, 2] }],
      ]);
      expect(finding(report, "worker", "attempt-guest")).toMatchObject({ disposition: "reconciled", reason: "physical_stop_proven" });
      expect(supervisor.stopped.map(command => command.attemptId)).toEqual(["attempt-guest"]);
      expect(report.releaseIdentities).toEqual({ archived: 2, recovered: 2, blocked: 0 });
      const post = rows<{ provider_verified: boolean; receipt_json: string | null }>(await restored.db.execute(sql`SELECT provider_verified, receipt_json FROM factory_recovered_releases WHERE tenant_id = ${tenantId}`));
      expect(post).toHaveLength(1);
      expect(post[0]!.provider_verified).toBe(true);
      // The guest started after the checkpoint is unknown to the restored database; its reservation is revoked and still awaits the supervisor.
      expect(finding(report, "worker", "reservation-post")).toMatchObject({ disposition: "blocked", reason: "post_checkpoint_worker_revoking" });
      expect(report.blockedChecks).toContain("worker:reservation-post:post_checkpoint_worker_revoking");
      // Service stays closed: admission and effect claims are refused while the epoch is open.
      const admission = await new FactoryRecords(restored.db, tenantId).createRun({ projectId, runId: "run-during-restore", definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: report.executionEpoch, input: {}, principalId: admin.id }, async () => {}).then(() => null, error => error as Error);
      expect(`${admission?.message} ${String((admission?.cause as Error | undefined)?.message)}`).toContain("factory_admission_closed:restore_epoch_open");
      const claim = await restored.db.execute(sql`UPDATE factory_release_operations SET state = 'executing' WHERE tenant_id = ${tenantId} AND state = 'succeeded'`).then(() => null, error => error as Error);
      expect(`${claim?.message} ${String((claim?.cause as Error | undefined)?.message)}`).toContain("factory_effect_claims_closed:restore_epoch_open");
      const digestNow = factoryRestoreReportDigest(report);
      await expect(restore.sign("restore-main", admin, digestNow)).rejects.toMatchObject({ code: "factory_restore_blocked" });
      // The supervisor confirms the post-checkpoint guest's stop; re-verification clears the block.
      const status = (await ledger.status("reservation-post"))!;
      await ledger.confirmStopped({ reservationId: "reservation-post", holderGeneration: status.holderGeneration, hostId });
      const session = await restoredSession(restored, restore, "restore-main");
      const clean = await restore.verify(session);
      expect(clean.blockedChecks).toEqual([]);
      await expect(restore.sign("restore-main", { kind: "service", id: "restore-service", authentication: "service" }, factoryRestoreReportDigest(clean))).rejects.toMatchObject({ code: "factory_restore_human_required" });
      await expect(restore.sign("restore-main", { ...admin, authentication: "api-key" }, factoryRestoreReportDigest(clean))).rejects.toMatchObject({ code: "factory_restore_human_required" });
      await expect(restore.sign("restore-main", admin, digestNow)).rejects.toMatchObject({ code: "factory_restore_report_mismatch" });
      const enabled = await restore.sign("restore-main", admin, factoryRestoreReportDigest(clean));
      expect(enabled.rebound).toBeGreaterThanOrEqual(4);
      await expect(restore.sign("restore-main", admin, factoryRestoreReportDigest(clean))).rejects.toMatchObject({ code: "factory_restore_state" });
      const reopened = await new FactoryRecords(restored.db, tenantId).createRun({ projectId, runId: "run-after-restore", definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: clean.executionEpoch, input: {}, principalId: admin.id }, async () => {});
      expect(reopened.created).toBe(true);
      measurements.tenantRestoreSigned = { recoveryMs: clean.measured.recoveryMs, internalProgressLossMs: clean.measured.internalProgressLossMs, rebound: enabled.rebound };
    } finally { await restored.close(); }
  }, 120_000);

  test("a backup that is not at the checkpoint keeps the service closed", async () => {
    await primary.close();
    const later = await databases.copy(primary.name, "incompatible");
    primary = databases.open(primary.name);
    const restored = databases.open(later);
    try {
      const restore = restoreFor(restored.db);
      const report = await restore.begin({ restoreId: "restore-incompatible", mode: "tenant" });
      expect(finding(report, "check", "database-position")).toMatchObject({ disposition: "blocked", reason: "database_position_mismatch" });
      await expect(restore.sign("restore-incompatible", admin, factoryRestoreReportDigest(report))).rejects.toMatchObject({ code: "factory_restore_blocked" });
      expect(await new FactoryCheckpointCoordinator({ database: restored.db, tenantId, installationId, archive: storage.archive }).effectClaimsClosedReason()).toBe("restore_epoch_open");
    } finally { await restored.close(); }
  }, 120_000);

  test("a missing master key or a missing key version blocks the restore", async () => {
    const restored = await restoredCopy("keys");
    try {
      const report = await restoreFor(restored.db, { masters: [{ id: "master-other", bytes: new Uint8Array(32).fill(3) }] }).begin({ restoreId: "restore-no-master", mode: "tenant" });
      expect(finding(report, "check", "keys")).toMatchObject({ disposition: "blocked", reason: "key_missing" });
    } finally { await restored.close(); }
    const stripped = await restoredCopy("key-version");
    try {
      await stripped.db.execute(sql`DELETE FROM factory_installation_key_wraps WHERE installation_id = ${installationId}`);
      const report = await restoreFor(stripped.db).begin({ restoreId: "restore-no-wrap", mode: "tenant" });
      expect(finding(report, "check", "keys")).toMatchObject({ disposition: "blocked", reason: "key_version_missing" });
    } finally { await stripped.close(); }
  }, 120_000);

  test("a manifest without a database wrap checks only that the operator's keys open the data key", async () => {
    const restored = await restoredCopy("file-wrap");
    try {
      const seal = (await latestFactoryCheckpoint(storage.archive, tenantId))!.seal;
      const fileWrapped = { seal, manifest: { ...manifest, keys: { installationId, wrapVersion: null, masterKeyId: null, wrappedDigest: null } } };
      const opens = await restoreFor(restored.db).begin({ restoreId: "restore-file-wrap", mode: "tenant", checkpoint: fileWrapped });
      expect(finding(opens, "check", "keys")).toMatchObject({ disposition: "verified", reason: "key_version_opens" });
    } finally { await restored.close(); }
  }, 120_000);

  test("a gapped or conflicting audit stream blocks only its run, and a blocked run stays at the old epoch", async () => {
    const restored = await restoredCopy("audit");
    try {
      await restored.db.execute(sql`UPDATE factory_audit_batches SET payload = '{"step":"tampered"}' WHERE tenant_id = ${tenantId} AND run_id = 'run-audit' AND source_sequence = 2`);
      const restore = restoreFor(restored.db);
      const report = await restore.begin({ restoreId: "restore-audit", mode: "tenant" });
      expect(finding(report, "run", canonicalJson([projectId, "run-audit"]))).toMatchObject({ disposition: "blocked", reason: "audit_unrecoverable", detail: { code: "factory_audit_corrupt" } });
      expect(report.blockedRuns).toEqual([canonicalJson([projectId, "run-audit"])]);
      expect(report.blockedChecks).toEqual([]);
      await restore.sign("restore-audit", admin, factoryRestoreReportDigest(report));
      const epochs = rows<{ run_id: string; execution_epoch: number }>(await restored.db.execute(sql`SELECT run_id, execution_epoch FROM factory_runs WHERE tenant_id = ${tenantId} ORDER BY run_id`));
      expect(epochs.find(row => row.run_id === "run-audit")!.execution_epoch).toBe(report.previousEpoch);
      expect(epochs.find(row => row.run_id === "run-pre")!.execution_epoch).toBe(report.executionEpoch);
    } finally { await restored.close(); }
    const gapped = await restoredCopy("gap");
    try {
      await gapped.db.execute(sql`DELETE FROM factory_audit_batches WHERE tenant_id = ${tenantId} AND run_id = 'run-audit' AND source_sequence = 2`);
      const report = await restoreFor(gapped.db).begin({ restoreId: "restore-gap", mode: "tenant" });
      expect(finding(report, "run", canonicalJson([projectId, "run-audit"]))).toMatchObject({ disposition: "blocked", reason: "audit_unrecoverable" });
    } finally { await gapped.close(); }
  }, 120_000);

  test("a lost pool ledger comes back as uncertain reservations that hold their capacity; an overcommitted one blocks", async () => {
    const lostPool = await databases.empty("lost-pool");
    try {
      const lostSql = lostPool.client as unknown as PoolSql;
      await setupFactoryPoolLedger(lostSql);
      const lostLedger = new FactoryPoolLedger(lostSql);
      await lostLedger.configureCapacity("cpu", 8);
      const restored = await restoredCopy("lost-pool");
      try {
        const report = await restoreFor(restored.db, { poolSql: lostSql, poolLedger: lostLedger }).begin({ restoreId: "restore-lost-pool", mode: "tenant" });
        expect(finding(report, "pool", "reservation-guest")).toMatchObject({ disposition: "reconciled", reason: "lost_reservation_reimported_uncertain" });
        const status = (await lostLedger.status("reservation-guest"))!;
        expect(status.state).toBe("settled");
        expect(finding(report, "worker", "attempt-guest")?.disposition).toBe("reconciled");
      } finally { await restored.close(); }
      await lostLedger.configureCapacity("cpu", 1);
      await lostLedger.request({ reservationId: "other-tenant", tenantId: "other-tenant", grantRevision: 1, resources: { cpu: 1 }, admissionDeadline: new Date(Date.now() + 3_600_000) });
      await lostLedger.schedule();
      await lostSql.unsafe("DELETE FROM factory_pool_requests WHERE reservation_id = 'reservation-guest'");
      const overcommitted = await restoredCopy("overcommitted");
      try {
        const report = await restoreFor(overcommitted.db, { poolSql: lostSql, poolLedger: lostLedger }).begin({ restoreId: "restore-overcommitted", mode: "tenant" });
        expect(finding(report, "pool", "reservation-guest")).toMatchObject({ disposition: "blocked", reason: "capacity_overcommitted" });
        expect(report.blockedChecks).toContain("pool:reservation-guest:capacity_overcommitted");
      } finally { await overcommitted.close(); }
    } finally { await lostPool.close(); }
  }, 120_000);

  test("a surviving guest whose supervisor cannot prove its stop keeps the tenant closed", async () => {
    const restored = await restoredCopy("unreachable-supervisor");
    supervisor.refuse = true;
    try {
      const report = await restoreFor(restored.db).begin({ restoreId: "restore-no-supervisor", mode: "tenant" });
      expect(finding(report, "worker", "attempt-guest")).toMatchObject({ disposition: "blocked", reason: "worker_stop_unproven" });
      expect(report.blockedChecks).toContain("worker:attempt-guest:worker_stop_unproven");
    } finally { supervisor.refuse = false; await restored.close(); }
  }, 120_000);

  test("a tenant restore blocks a run the live namespace moved past; a cluster restore requires equal positions", async () => {
    // The same sealed manifest, as a barrier with a Temporal source would have recorded it.
    const captured: FactoryCheckpointManifest = { ...manifest, temporal: { captured: true, namespace: "restore", workflows: manifest.product.liveRuns.map(run => ({ workflowId: `${tenantId}/${run.runId}`, runId: "t", status: "WORKFLOW_EXECUTION_STATUS_RUNNING", historyLength: 5 })) } };
    const live: FactoryCheckpointTemporalSource = { namespace: "restore", positions: async ids => ids.map(workflowId => ({ workflowId, runId: "t", status: "WORKFLOW_EXECUTION_STATUS_RUNNING", historyLength: workflowId.endsWith("/run-audit") ? 99 : 5 })) };
    const tenantCopy = await restoredCopy("temporal-tenant");
    try {
      const report = await restoreFor(tenantCopy.db, { temporal: live }).begin({ restoreId: "restore-temporal-tenant", mode: "tenant", checkpoint: { seal: (await latestFactoryCheckpoint(storage.archive, tenantId))!.seal, manifest: captured } });
      expect(finding(report, "run", canonicalJson([projectId, "run-audit"]))).toMatchObject({ disposition: "blocked", reason: "temporal_ahead_of_product" });
    } finally { await tenantCopy.close(); }
    const noneCopy = await restoredCopy("temporal-cluster-none");
    try {
      const withoutPositions = await restoreFor(noneCopy.db).begin({ restoreId: "restore-cluster-none", mode: "cluster" });
      expect(finding(withoutPositions, "check", "temporal")).toMatchObject({ disposition: "blocked", reason: "temporal_unavailable" });
    } finally { await noneCopy.close(); }
    const clusterCopy = await restoredCopy("temporal-cluster");
    const secondCopy = await restoredCopy("temporal-cluster-2");
    try {
      const opened: string[] = [];
      const recorder: FactoryCheckpointTemporalSource = {
        namespace: "restore",
        positions: async ids => {
          opened.push(...rows<{ restore_id: string }>(await secondCopy.db.execute(sql`SELECT restore_id FROM factory_restore_epochs`)).map(row => row.restore_id));
          return ids.map(workflowId => workflowId.endsWith("/run-audit") ? { workflowId, runId: null, status: "not_found", historyLength: null } : { workflowId, runId: "t", status: "WORKFLOW_EXECUTION_STATUS_RUNNING", historyLength: 5 });
        },
      };
      const checkpoint = { seal: (await latestFactoryCheckpoint(storage.archive, tenantId))!.seal, manifest: captured };
      const reports = await runFactoryClusterRestore([
        { restore: restoreFor(clusterCopy.db, { temporal: recorder }), restoreId: "restore-cluster-a", checkpoint },
        { restore: restoreFor(secondCopy.db, { temporal: recorder }), restoreId: "restore-cluster-b", failureAtMs, checkpoint },
      ]);
      expect(reports).toHaveLength(2);
      // Every tenant entered its epoch before the first verification read a position.
      expect(opened[0]).toBe("restore-cluster-b");
      for (const report of reports) {
        expect(finding(report, "run", canonicalJson([projectId, "run-audit"]))).toMatchObject({ disposition: "blocked", reason: "temporal_position_mismatch" });
        expect(finding(report, "run", canonicalJson([projectId, "run-pre"]))).toMatchObject({ disposition: "verified", reason: "temporal_position_consistent" });
      }
    } finally { await clusterCopy.close(); await secondCopy.close(); }
  }, 120_000);

  test("a missing object version blocks the restore", async () => {
    await storage.ordinaryClient.send(new DeleteObjectCommand({ Bucket: storage.tenant, Key: s3ObjectKey(storage.ordinaryPrefix, candidate.blobDigest), VersionId: candidate.storageVersion }));
    const restored = await restoredCopy("objects");
    try {
      const report = await restoreFor(restored.db).begin({ restoreId: "restore-objects", mode: "tenant" });
      expect(finding(report, "check", "object-versions")).toMatchObject({ disposition: "blocked", reason: "object_version_missing", detail: { missing: ["restore-candidate"] } });
    } finally { await restored.close(); }
  }, 120_000);

  test("a restore needs a sealed checkpoint and refuses a second open epoch", async () => {
    const restored = await restoredCopy("guards");
    try {
      const restore = restoreFor(restored.db);
      await restore.begin({ restoreId: "restore-guards", mode: "tenant" });
      await expect(restore.begin({ restoreId: "restore-guards-2", mode: "tenant" })).rejects.toMatchObject({ code: "factory_restore_state" });
      await expect(restore.begin({ restoreId: "restore-guards-3", mode: "sideways" as "tenant" })).rejects.toMatchObject({ code: "factory_restore_invalid" });
      await expect(restore.sign("missing", admin, digest("a"))).rejects.toMatchObject({ code: "factory_restore_not_found" });
      const empty = restoreFor(restored.db, { tenant: "tenant-without-checkpoints" });
      await expect(empty.begin({ restoreId: "restore-none", mode: "tenant" })).rejects.toMatchObject({ code: "factory_restore_no_checkpoint" });
    } finally { await restored.close(); }
  }, 120_000);
});

/** Rebuilds the session a caller holds between `open` and a later re-verification. */
async function restoredSession(restored: FactoryOpenDatabase, _restore: FactoryRestore, restoreId: string) {
  const row = rows<{ mode: "tenant" | "cluster"; previous_epoch: number; execution_epoch: number }>(await restored.db.execute(sql`SELECT mode, previous_epoch, execution_epoch FROM factory_restore_epochs WHERE restore_id = ${restoreId}`))[0]!;
  const latest = (await latestFactoryCheckpoint(storage.archive, tenantId))!;
  return { restoreId, mode: row.mode, failureAtMs, seal: latest.seal, manifest: latest.manifest, previousEpoch: Number(row.previous_epoch), executionEpoch: Number(row.execution_epoch), started: performance.now() };
}
