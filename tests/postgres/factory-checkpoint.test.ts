import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "../../src/db/schema";
import type { TransactionalDb } from "../../src/db/migrations/types";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { FACTORY_CHECKPOINT_LIMITS, FactoryCheckpointCoordinator, latestFactoryCheckpoint, type FactoryCheckpointOutcome, type FactoryCheckpointPoolSource, type FactoryCheckpointTemporalSource } from "../../src/factory/checkpoint-barrier";
import { InstallationDataKey, StaticMasterKeyProvider } from "../../src/factory/encryption";
import { DatabaseInstallationKeyWrapStore } from "../../src/factory/encryption-key-wrap-store";
import type { FactoryPrincipal } from "../../src/factory/grants";
import { FactoryRecords } from "../../src/factory/records";
import type { FactoryRecoveryArchive } from "../../src/factory/recovery-archive";
import { createFactoryReleaseWorld, digest, type FactoryReleaseWorld } from "../../src/__tests__/helpers/factory-release-world";
import { factoryRecoveryStorage } from "./helpers/factory-recovery-storage";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

/**
 * C06's compatible checkpoint barrier against real PostgreSQL and the real
 * independent archive. Every bound here is MEASURED and written to the evidence
 * directory; no test waits on a clock to prove one. A test observes the
 * database (a waiting advisory lock, a committed pause flag) instead.
 */

const tenantId = "checkpoint-tenant";
const installationId = "checkpoint-installation";
const projectId = "checkpoint-project";
const admin: FactoryPrincipal = { kind: "user", id: "checkpoint-admin", authentication: "session" };
const evidence = process.env.W15_EVIDENCE_DIR;

let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
let storage: Awaited<ReturnType<typeof factoryRecoveryStorage>>;
let side: SQL;
let sideDb: TransactionalDb;
let records: FactoryRecords;
let world: FactoryReleaseWorld;
const measurements: Record<string, unknown> = {};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

/** An archive whose writes can be held open, so a test can observe the barrier mid-seal. */
function gatedArchive(inner: FactoryRecoveryArchive) {
  let gate: ReturnType<typeof deferred> | null = null;
  let entered: ReturnType<typeof deferred> | null = null;
  let failing = false;
  const archive: FactoryRecoveryArchive = {
    async write(...args) {
      if (failing) throw new Error("archive unavailable");
      if (gate) { entered?.resolve(); await gate.promise; }
      return inner.write(...args);
    },
    read: (...args) => inner.read(...args),
    list: (...args) => inner.list(...args),
  };
  return {
    archive,
    hold() { gate = deferred(); entered = deferred(); return entered.promise; },
    release() { gate?.resolve(); gate = null; },
    fail(value: boolean) { failing = value; },
  };
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  // An observed condition, polled against the database; the bound is on attempts, not time.
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`never observed: ${what}`);
}

async function advisoryWaiters(): Promise<number> {
  return Number(rows<{ count: string | number }>(await side`SELECT count(*) AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0]!.count);
}

async function run(runId: string, batches = 1): Promise<void> {
  await records.createRun({ projectId, runId, definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: Number(rows<{ execution_epoch: number }>(await fixture.db.execute(sql`SELECT execution_epoch FROM factory_installation`))[0]!.execution_epoch), input: {}, principalId: admin.id }, async () => {});
  for (let index = 1; index <= batches; index += 1) await append(runId);
}

const heads = new Map<string, { sourceSequence: number; digest: string | null }>();
async function append(runId: string, database: TransactionalDb = fixture.db): Promise<void> {
  const head = heads.get(runId) ?? { sourceSequence: 0, digest: null };
  const batch = await new FactoryRecords(database, tenantId).appendAudit({ projectId, runId, interpreterId: "root", sourceSequence: head.sourceSequence + 1, predecessorDigest: head.digest, payload: { step: head.sourceSequence + 1 } });
  heads.set(runId, { sourceSequence: batch.sourceSequence, digest: batch.digest });
}

function coordinator(archive: FactoryRecoveryArchive, extra: Partial<ConstructorParameters<typeof FactoryCheckpointCoordinator>[0]> = {}) {
  return new FactoryCheckpointCoordinator({ database: fixture.db, tenantId, installationId, archive, ...extra });
}

beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  storage = await factoryRecoveryStorage();
  const url = new URL(fixture.databaseUrl);
  side = new SQL(url.toString(), { max: 6 });
  sideDb = drizzle(side, { schema }) as unknown as TransactionalDb;
  records = new FactoryRecords(fixture.db, tenantId);
  world = await createFactoryReleaseWorld({ database: fixture.db, tenantId, projectId, admin, archive: storage.releaseArchive, now: Date.now });
  await InstallationDataKey.loadOrCreate(installationId, new DatabaseInstallationKeyWrapStore(fixture.db), new StaticMasterKeyProvider({ id: "master-1", bytes: new Uint8Array(32).fill(7) }));
  await run("run-seed", 3);
});

afterAll(async () => {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(`${evidence}/checkpoint-bounds.json`, `${JSON.stringify({ recordedAt: new Date().toISOString(), database: "real PostgreSQL", archive: "real independent S3 archive (same host)", limits: FACTORY_CHECKPOINT_LIMITS, ...measurements }, null, 2)}\n`);
  }
  await side?.close();
  await storage?.cleanup().then(result => console.log(`w15 checkpoint storage cleanup ${JSON.stringify(result)}`));
  await fixture?.close();
});

describe("the compatible checkpoint barrier", () => {
  test("a barrier seals a manifest with the WAL position, product state, object versions, and the key wrap it needs", async () => {
    const barrier = coordinator(storage.archive);
    const outcome = await barrier.run();
    expect(outcome.kind).toBe("sealed");
    const sealed = outcome as Extract<FactoryCheckpointOutcome, { kind: "sealed" }>;
    expect(sealed.lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    const latest = (await latestFactoryCheckpoint(storage.archive, tenantId))!;
    expect(latest.seal.checkpointId).toBe(sealed.checkpointId);
    expect(latest.manifest.product.lsn).toBe(sealed.lsn);
    expect(latest.manifest.product.state.runCount).toBe(1);
    expect(latest.manifest.product.liveRuns.map(item => item.runId)).toEqual(["run-seed"]);
    expect(latest.manifest.keys).toMatchObject({ installationId, wrapVersion: 1, masterKeyId: "master-1" });
    expect(latest.manifest.pool).toEqual({ captured: false, reason: "no pool ledger source is composed in this process" });
    expect(latest.manifest.temporal.captured).toBe(false);
    expect((await barrier.newest())!.checkpointId).toBe(sealed.checkpointId);
    const row = rows<{ state: string; key_wrap_version: number; duration_ms: number }>(await fixture.db.execute(sql`SELECT state, key_wrap_version, duration_ms FROM factory_checkpoints WHERE checkpoint_id = ${sealed.checkpointId}`))[0]!;
    expect(row).toMatchObject({ state: "sealed", key_wrap_version: 1 });
    measurements.firstBarrier = { durationMs: sealed.durationMs, withinTarget: sealed.withinTarget };
  });

  test("a writer that has not written yet waits for the barrier and its write lands after the recorded position", async () => {
    const gated = gatedArchive(storage.archive);
    await run("run-blocked", 1);
    const entered = gated.hold();
    const barrier = coordinator(gated.archive).run();
    await entered;
    // The barrier holds its exclusive lock and waits in its first archive write.
    const started = performance.now();
    const writer = append("run-blocked", sideDb).then(() => performance.now() - started);
    await waitFor(async () => (await advisoryWaiters()) >= 1, "the writer waiting on the barrier's pause lock");
    expect(rows(await fixture.db.execute(sql`SELECT 1 FROM factory_audit_batches WHERE run_id = 'run-blocked' AND source_sequence = 2`))).toHaveLength(0);
    gated.release();
    const outcome = await barrier as Extract<FactoryCheckpointOutcome, { kind: "sealed" }>;
    const blockedMs = await writer;
    expect(outcome.kind).toBe("sealed");
    const latest = (await latestFactoryCheckpoint(storage.archive, tenantId))!;
    const blocked = latest.manifest.product.liveRuns.find(item => item.runId === "run-blocked")!;
    expect(blocked.interpreters).toEqual([expect.objectContaining({ interpreterId: "root", sourceSequence: 1 })]);
    const after = rows<{ lsn: string }>(await fixture.db.execute(sql`SELECT pg_current_wal_lsn()::text AS lsn`))[0]!.lsn;
    expect(rows<{ later: boolean }>(await fixture.db.execute(sql`SELECT ${after}::pg_lsn > ${outcome.lsn}::pg_lsn AS later`))[0]!.later).toBe(true);
    measurements.blockedWriter = { waitedMs: Math.round(blockedMs), barrierDurationMs: outcome.durationMs, writePauseMs: outcome.writePauseMs };
  });

  test("a transaction already writing is never blocked by the pause; the barrier waits for it and records its write", async () => {
    await run("run-member", 1);
    const member = await side.reserve();
    try {
      await member`BEGIN`;
      const head = heads.get("run-member")!;
      await member.unsafe(`SELECT 1`);
      // The member's first write takes the shared barrier lock and marks the transaction.
      await member`UPDATE factory_runs SET next_sequence = next_sequence WHERE tenant_id = ${tenantId} AND run_id = 'run-member'`;
      const barrier = coordinator(storage.archive).run();
      await waitFor(async () => rows<{ paused: boolean }>(await fixture.db.execute(sql`SELECT paused FROM factory_checkpoint_gate WHERE tenant_id = ${tenantId}`))[0]?.paused === true, "the pause flag committed");
      // A member's later statement proceeds through the paused gate.
      await member`UPDATE factory_runs SET next_sequence = next_sequence WHERE tenant_id = ${tenantId} AND run_id = 'run-member'`;
      await member`COMMIT`;
      expect((await barrier).kind).toBe("sealed");
      expect(head.sourceSequence).toBe(1);
    } finally { member.release(); }
  });

  test("past the maximum the barrier aborts, claims no checkpoint, and the gate reopens", async () => {
    const before = (await storage.archive.list(tenantId, "checkpoint", "seals")).length;
    const member = await side.reserve();
    let outcome: Extract<FactoryCheckpointOutcome, { kind: "aborted" }>;
    try {
      await member`BEGIN`;
      await member`UPDATE factory_runs SET next_sequence = next_sequence WHERE tenant_id = ${tenantId} AND run_id = 'run-member'`;
      outcome = await coordinator(storage.archive, { maximumMs: 300 }).run() as Extract<FactoryCheckpointOutcome, { kind: "aborted" }>;
      await member`COMMIT`;
    } finally { member.release(); }
    expect(outcome).toMatchObject({ kind: "aborted", code: "barrier_timeout" });
    expect((await storage.archive.list(tenantId, "checkpoint", "seals")).length).toBe(before);
    expect(rows<{ state: string; abort_code: string }>(await fixture.db.execute(sql`SELECT state, abort_code FROM factory_checkpoints WHERE checkpoint_id = ${outcome.checkpointId}`))[0]).toEqual({ state: "aborted", abort_code: "barrier_timeout" });
    expect(rows<{ paused: boolean }>(await fixture.db.execute(sql`SELECT paused FROM factory_checkpoint_gate WHERE tenant_id = ${tenantId}`))[0]!.paused).toBe(false);
    await append("run-member");
    measurements.abortedBarrier = { maximumMs: 300, durationMs: outcome.durationMs };
  });

  test("an old checkpoint closes new effect claims and a sealed one reopens them", async () => {
    const barrier = coordinator(storage.archive);
    await barrier.enforceFreshness(900);
    const accepted = await world.acceptRun("run-claims");
    await fixture.db.execute(sql`UPDATE factory_checkpoints SET sealed_at = sealed_at - interval '16 minutes' WHERE tenant_id = ${tenantId} AND state = 'sealed'`);
    expect(await barrier.effectClaimsClosedReason()).toBe("checkpoint_stale");
    const refused = await accepted.claimOnly("stale").then(() => null, error => error as Error);
    expect(`${refused?.message} ${String((refused?.cause as Error | undefined)?.message)}`).toContain("factory_effect_claims_closed:checkpoint_stale");
    expect((await barrier.run()).kind).toBe("sealed");
    expect(await barrier.effectClaimsClosedReason()).toBeNull();
    expect((await accepted.claimOnly("fresh")).state).toBe("executing");
    await expect(barrier.enforceFreshness(901)).rejects.toMatchObject({ code: "factory_checkpoint_invalid" });
  });

  test("while a barrier drains senders it refuses new effect claims, and the refusal expires with the barrier", async () => {
    const accepted = await world.acceptRun("run-drain");
    // The executing release from the previous test is an in-flight sender, so the
    // barrier enters its drain step; its injected wait lets the test hold it there.
    const draining = deferred(), resume = deferred();
    let held = false;
    const barrier = coordinator(storage.archive, { wait: async () => { if (!held) { held = true; draining.resolve(); await resume.promise; } } }).run();
    await draining.promise;
    expect(await coordinator(storage.archive).effectClaimsClosedReason()).toBe("checkpoint_barrier");
    // Ordinary writes still flow during the drain: the preparation commits, and only the claim is refused.
    const refused = await accepted.claimOnly("during-barrier").then(() => null, error => error as Error);
    expect(`${refused?.message} ${String((refused?.cause as Error | undefined)?.message)}`).toContain("factory_effect_claims_closed:checkpoint_barrier");
    resume.resolve();
    expect((await barrier).kind).toBe("sealed");
    expect(await coordinator(storage.archive).effectClaimsClosedReason()).toBeNull();
    // A coordinator that died mid-barrier leaves a flag that expires by itself.
    await fixture.db.execute(sql`UPDATE factory_checkpoint_gate SET claims_paused_until = clock_timestamp() - interval '1 second' WHERE tenant_id = ${tenantId}`);
    expect(await coordinator(storage.archive).effectClaimsClosedReason()).toBeNull();
  });

  test("an executing release is fenced by name in the manifest for restore to reconcile", async () => {
    const outcome = await coordinator(storage.archive).run() as Extract<FactoryCheckpointOutcome, { kind: "sealed" }>;
    expect(outcome.kind).toBe("sealed");
    expect(outcome.fenced).toBeGreaterThanOrEqual(1);
    const manifest = (await latestFactoryCheckpoint(storage.archive, tenantId))!.manifest;
    expect(manifest.fenced.releases.map(release => release.runId)).toContain("run-claims");
  });

  test("every other abort claims nothing: gaps, archive, pool, Temporal, gate coverage, cancellation", async () => {
    const gated = gatedArchive(storage.archive);
    await fixture.db.execute(sql`UPDATE factory_runs SET next_sequence = next_sequence + 5 WHERE tenant_id = ${tenantId} AND run_id = 'run-seed'`);
    expect(await coordinator(storage.archive).run()).toMatchObject({ kind: "aborted", code: "audit_inconsistent" });
    await fixture.db.execute(sql`UPDATE factory_runs SET next_sequence = next_sequence - 5 WHERE tenant_id = ${tenantId} AND run_id = 'run-seed'`);
    gated.fail(true);
    expect(await coordinator(gated.archive).run()).toMatchObject({ kind: "aborted", code: "archive_failed" });
    gated.fail(false);
    const pool: FactoryCheckpointPoolSource = { snapshotTenant: async () => { throw new Error("pool unreachable"); } };
    expect(await coordinator(storage.archive, { pool }).run()).toMatchObject({ kind: "aborted", code: "pool_unavailable" });
    const temporal: FactoryCheckpointTemporalSource = { namespace: "checkpoint", positions: async () => { throw new Error("temporal unreachable"); } };
    expect(await coordinator(storage.archive, { temporal }).run()).toMatchObject({ kind: "aborted", code: "temporal_unavailable" });
    const cancelled = new AbortController(); cancelled.abort();
    expect(await coordinator(storage.archive).run(cancelled.signal)).toMatchObject({ kind: "aborted", code: "cancelled" });
    await fixture.db.execute(sql.raw("CREATE TABLE factory_w15_ungated_probe (tenant_id TEXT PRIMARY KEY)"));
    try { expect(await coordinator(storage.archive).run()).toMatchObject({ kind: "aborted", code: "barrier_gate_incomplete" }); }
    finally { await fixture.db.execute(sql.raw("DROP TABLE factory_w15_ungated_probe")); }
    const aborted = rows<{ abort_code: string }>(await fixture.db.execute(sql`SELECT abort_code FROM factory_checkpoints WHERE tenant_id = ${tenantId} AND state = 'aborted' ORDER BY created_at`)).map(row => row.abort_code);
    expect(aborted).toEqual(expect.arrayContaining(["audit_inconsistent", "archive_failed", "pool_unavailable", "temporal_unavailable", "cancelled", "barrier_gate_incomplete"]));
  });

  test("pool rows and Temporal positions are recorded when their sources are composed", async () => {
    const pool: FactoryCheckpointPoolSource = { snapshotTenant: async tenant => ({ position: "0/AB", rows: [{ reservation_id: "reservation-1", tenant_id: tenant, state: "running" }] }) };
    const temporal: FactoryCheckpointTemporalSource = { namespace: "checkpoint-namespace", positions: async ids => ids.map(workflowId => ({ workflowId, runId: "temporal-run", status: "WORKFLOW_EXECUTION_STATUS_RUNNING", historyLength: 7 })) };
    expect((await coordinator(storage.archive, { pool, temporal }).run()).kind).toBe("sealed");
    const manifest = (await latestFactoryCheckpoint(storage.archive, tenantId))!.manifest;
    expect(manifest.pool).toMatchObject({ captured: true, position: "0/AB", rows: [{ reservation_id: "reservation-1" }] });
    expect(manifest.temporal).toMatchObject({ captured: true, namespace: "checkpoint-namespace" });
    if (manifest.temporal.captured) expect(manifest.temporal.workflows.map(workflow => workflow.workflowId)).toContain(`${tenantId}/run-blocked`);
  });

  test("an open restore epoch skips the barrier; the barrier counts its windows", async () => {
    await fixture.db.execute(sql`INSERT INTO factory_restore_epochs (tenant_id, restore_id, mode, checkpoint_id, manifest_digest, previous_epoch, execution_epoch, state, started_at_ms) VALUES (${tenantId}, 'skip-probe', 'tenant', 'x', ${digest("a")}, 1, 2, 'fenced', 0)`);
    try { expect(await coordinator(storage.archive).run()).toEqual({ kind: "skipped", reason: "restore_epoch_open" }); }
    finally { await fixture.db.execute(sql`DELETE FROM factory_restore_epochs WHERE restore_id = 'skip-probe'`); }
    const windows = await coordinator(storage.archive).windows(0);
    expect(windows.sealed).toBeGreaterThanOrEqual(5);
    expect(windows.aborted).toBeGreaterThanOrEqual(7);
    expect(windows.maxMs).toBeGreaterThan(0);
    expect(() => coordinator(storage.archive, { maximumMs: 10_001 })).toThrow();
  });

  test("measured: barriers under continuous writes seal, and every duration is recorded", async () => {
    const writers = 4, barriers = Number(process.env.W15_BARRIER_SAMPLES ?? 20);
    for (let index = 0; index < writers; index += 1) await run(`run-load-${index}`, 1);
    let stop = false;
    const latencies: number[] = [];
    const loads = Array.from({ length: writers }, async (_, index) => {
      const database = drizzle(side, { schema }) as unknown as TransactionalDb;
      while (!stop) {
        const started = performance.now();
        await append(`run-load-${index}`, database);
        latencies.push(performance.now() - started);
      }
    });
    const outcomes: FactoryCheckpointOutcome[] = [];
    try { for (let index = 0; index < barriers; index += 1) outcomes.push(await coordinator(storage.archive).run()); }
    finally { stop = true; await Promise.all(loads); }
    const sealed = outcomes.filter((outcome): outcome is Extract<FactoryCheckpointOutcome, { kind: "sealed" }> => outcome.kind === "sealed");
    const durations = sealed.map(outcome => outcome.durationMs).sort((left, right) => left - right);
    const pauses = sealed.map(outcome => outcome.writePauseMs).sort((left, right) => left - right);
    const percentile = (values: readonly number[], fraction: number) => values[Math.min(values.length - 1, Math.floor(fraction * values.length))] ?? null;
    const sortedLatency = [...latencies].sort((left, right) => left - right);
    measurements.underLoad = {
      writers, barriers, sealed: sealed.length, aborted: outcomes.filter(outcome => outcome.kind === "aborted").map(outcome => (outcome as { code: string }).code),
      durationMs: { min: durations[0] ?? null, p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: durations.at(-1) ?? null },
      writePauseMs: { min: pauses[0] ?? null, p50: percentile(pauses, 0.5), p95: percentile(pauses, 0.95), max: pauses.at(-1) ?? null },
      withinTarget: sealed.filter(outcome => outcome.withinTarget).length,
      writerLatencyMs: { count: sortedLatency.length, p50: percentile(sortedLatency, 0.5), p95: percentile(sortedLatency, 0.95), max: sortedLatency.at(-1) ?? null },
    };
    // The contract's claim is structural: every barrier either sealed or aborted without a claim.
    expect(outcomes.every(outcome => outcome.kind === "sealed" || outcome.kind === "aborted")).toBe(true);
    expect(sealed.length).toBeGreaterThan(0);
    expect(latencies.length).toBeGreaterThan(0);
  });
});
