/**
 * The periodic orphan sweep C10 asks for, as a host-maintenance-daemon sub-tick.
 *
 * The sub-tick itself landed with the stage-2b legacy-engine changes; what was
 * never proven is the property the contract states: "an orphaned legacy run
 * reaches a terminal or resumable state within the C11 detection bound". This
 * file drives the REAL daemon against a real database and checks both branches,
 * that the sub-tick is on every tick rather than behind a modulo, and that the
 * factory side detects the loss without waiting for the daemon at all.
 *
 * No wall clock is asserted anywhere. The daemon's clock is injected and the
 * lease comparison is against that injected instant, so the verdict is a
 * function of the rows rather than of how loaded the box is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mapLegacyWorkflowStatus, type LegacyWorkflowRunFacts } from "../factory/legacy-workflow/status";
import { closeTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";

mockDbConnection();

const { HostMaintenanceDaemon } = await import("../extensions/host-maintenance-daemon");
const { getDb } = await import("../db/connection");

const NOW = Date.UTC(2030, 0, 1, 12);
const USER_ID = "legacy-orphan-user";

interface RunRow {
  status: string;
  run_phase: string;
  resumable: boolean;
  suspended_reason: string | null;
  finished_at: Date | string | null;
  claimed_by: string | null;
  lease_expires_at: Date | string | null;
  cursor: { batchIndex?: number } | string | null;
  result: { error?: unknown } | string | null;
}

function facts(row: RunRow, inFlight: readonly string[] = []): LegacyWorkflowRunFacts {
  const result = typeof row.result === "string" ? JSON.parse(row.result) as { error?: unknown } : row.result;
  const cursor = typeof row.cursor === "string" ? JSON.parse(row.cursor) as { batchIndex?: number } : row.cursor;
  const error = result?.error;
  return {
    status: row.status,
    runPhase: row.run_phase,
    suspendedReason: row.suspended_reason,
    resumable: row.resumable,
    leaseExpiresAtMs: row.lease_expires_at === null ? null : new Date(row.lease_expires_at).getTime(),
    cursorBatchIndex: cursor?.batchIndex ?? null,
    inFlightStepNames: inFlight,
    resultErrorCode: typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : null,
    resultErrorMessage: typeof error === "string" ? error : typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : null,
    resultOutput: null,
    observedAtMs: NOW,
  };
}

async function readRun(id: string): Promise<RunRow> {
  const rows = await getDb().execute(sql`SELECT status,run_phase,resumable,suspended_reason,finished_at,claimed_by,lease_expires_at,cursor,result FROM workflow_runs WHERE id=${id}`);
  const row = (rows as unknown as { rows: RunRow[] }).rows[0];
  if (!row) throw new Error(`workflow run ${id} is missing`);
  return row;
}

async function seedOrphan(id: string, runPhase: "boundary" | "in-batch", batchIndex: number): Promise<void> {
  await getDb().execute(sql`INSERT INTO workflow_runs (id,workflow_name,user_id,status,input,started_at,run_phase,cursor,claimed_by,lease_expires_at) VALUES (${id},'legacy-orphan-workflow',${USER_ID},'running','{}'::jsonb,${new Date(NOW - 600_000)},${runPhase},${JSON.stringify({ batchIndex, completedSteps: [], prevStepName: null })}::jsonb,'dead-worker',${new Date(NOW - 1_000)})`);
}

function daemon(): InstanceType<typeof HostMaintenanceDaemon> {
  // A wake interval long enough that only the explicit `tickOnce` calls fire.
  return new HostMaintenanceDaemon({ wakeIntervalMs: 3_600_000, skipLockfile: true, now: () => NOW });
}

describe("the legacy orphan sweep resolves a lost run", () => {
  beforeAll(async () => {
    await setupTestDb();
    await getDb().execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${USER_ID},'legacy-orphan@example.test','x','Orphan','admin')`);
  });

  afterAll(async () => { await closeTestDb(); });

  beforeEach(async () => { await getDb().execute(sql`DELETE FROM workflow_runs WHERE workflow_name='legacy-orphan-workflow'`); });

  test("a run orphaned at a batch boundary becomes resumable, and the adapter reads it as a resumable wait", async () => {
    await seedOrphan("legacy-orphan-boundary", "boundary", 3);
    const before = await readRun("legacy-orphan-boundary");

    // Before the daemon notices, the factory side already refuses to call the
    // outcome a fact: an expired lease is uncertain, never assumed alive.
    expect(mapLegacyWorkflowStatus(facts(before))).toMatchObject({ state: "uncertain", reason: "lease-expired", terminal: false });

    const outcome = await daemon().tickOnce();
    expect(outcome.workflowOrphans).toBeGreaterThanOrEqual(1);

    const after = await readRun("legacy-orphan-boundary");
    expect(after).toMatchObject({ status: "suspended", resumable: true, suspended_reason: "orphaned-resumable", claimed_by: null, lease_expires_at: null });
    expect(after.finished_at).toBeNull();
    expect(mapLegacyWorkflowStatus(facts(after))).toEqual({ state: "waiting", reason: "orphaned-resumable", resumable: true });
  });

  test("a run orphaned mid-batch fails closed with its batch index and in-flight steps", async () => {
    await seedOrphan("legacy-orphan-midbatch", "in-batch", 2);
    const outcome = await daemon().tickOnce();
    expect(outcome.workflowOrphans).toBeGreaterThanOrEqual(1);

    const after = await readRun("legacy-orphan-midbatch");
    expect(after).toMatchObject({ status: "error", resumable: false, suspended_reason: null, claimed_by: null });
    expect(after.finished_at).not.toBeNull();
    const mapped = mapLegacyWorkflowStatus(facts(after, ["publish"]));
    expect(mapped).toMatchObject({ state: "failed", batchIndex: 2, inFlightSteps: ["publish"] });
    expect(mapped.state === "failed" && mapped.reason).toContain("orphaned mid-batch");
    expect(mapped.state === "failed" && mapped.reason).toContain("batch 2");
  });

  test("the sub-tick runs on every tick, so the detection bound is the daemon's own interval", async () => {
    const instance = daemon();
    await seedOrphan("legacy-orphan-first", "boundary", 0);
    expect((await instance.tickOnce()).workflowOrphans).toBe(1);
    // Nothing left to sweep: the same tick must not claim a run it already resolved.
    expect((await instance.tickOnce()).workflowOrphans).toBe(0);
    // A run orphaned AFTER the first tick is resolved by the next one, which is
    // what "periodic" means. A modulo-gated sub-tick would report zero here.
    await seedOrphan("legacy-orphan-second", "boundary", 0);
    expect((await instance.tickOnce()).workflowOrphans).toBe(1);
    expect((await readRun("legacy-orphan-second")).status).toBe("suspended");
  });

  test("a live run inside its lease is never swept", async () => {
    await getDb().execute(sql`INSERT INTO workflow_runs (id,workflow_name,user_id,status,input,started_at,run_phase,claimed_by,lease_expires_at) VALUES ('legacy-orphan-live','legacy-orphan-workflow',${USER_ID},'running','{}'::jsonb,${new Date(NOW - 600_000)},'in-batch','live-worker',${new Date(NOW + 60_000)})`);
    expect((await daemon().tickOnce()).workflowOrphans).toBe(0);
    const row = await readRun("legacy-orphan-live");
    expect(row).toMatchObject({ status: "running", resumable: false, claimed_by: "live-worker" });
    expect(mapLegacyWorkflowStatus(facts(row))).toEqual({ state: "running" });
  });
});
