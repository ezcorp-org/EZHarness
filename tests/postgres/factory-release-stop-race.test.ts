/**
 * W09e R2: a release's stop and its claim take the same operation row lock, so "pending under the lock" at
 * stop time proves no publish started.
 *
 * Both orders, on real PostgreSQL, synchronised on the database and never on a clock: a gate connection holds
 * the operation row; the first contender queues on it; the second queues behind it; each wait is confirmed in
 * pg_locks with a bounded poll; then the gate releases.
 * - claim first: the claim moves the release to `executing`, and the stop then finds a publish that may be
 *   running, so the effect is uncertain;
 * - stop first: the stop fails the release `stopped_before_dispatch`, and the claim then finds it stopped and
 *   is refused `factory_release_stopped`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import type { FactoryPrincipal } from "../../src/factory/grants";
import type { FactoryReleaseStopEffect } from "../../src/factory/releases";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { MemoryFactoryReleaseArchive } from "../../src/__tests__/helpers/factory-archive-fixtures";
import { openFactoryEffectClaimsForTest } from "../../src/__tests__/helpers/factory-effect-claims";
import { createFactoryReleaseWorld, type FactoryReleaseWorld } from "../../src/__tests__/helpers/factory-release-world";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

const tenantId = "release-race-tenant";
const projectId = "release-race-project";
const admin: FactoryPrincipal = { kind: "user", id: "release-race-admin", authentication: "session" };

let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
let world: FactoryReleaseWorld;
beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  world = await createFactoryReleaseWorld({ database: fixture.db, tenantId, projectId, admin, archive: new MemoryFactoryReleaseArchive() as never, now: Date.now });
  await openFactoryEffectClaimsForTest(fixture.db, tenantId);
});
afterAll(async () => { await fixture.close(); });

const settle = (promise: Promise<unknown>) => promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, code: (error as { code?: string }).code }));

/** Waits until `count` backends of this database wait on a lock while touching the release table. */
async function waitingOnOperation(count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = rows<{ waiting: number | string }>(await fixture.db.execute(sql`SELECT count(DISTINCT l.pid) AS waiting
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database() AND a.query ILIKE '%factory_release_operations%'`));
    if (Number(row?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${count} transactions waiting on the release row after 10 s`);
  }
}

const stopEvent = (effect: FactoryReleaseStopEffect): KernelEvent => ({ kind: "attempt-stopped", id: "cancel-release:stopped", atMs: 1, nodeId: "release-node", commandId: "request-release", candidateGeneration: 1, attempt: 1, ...(effect === "none" ? {} : { uncertain: false, effect }) }) as KernelEvent;

async function race(runId: string, first: "claim" | "stop") {
  const run = await world.acceptRun(runId);
  const { operationId, approvalId } = await run.approveOnly(first);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let held!: () => void;
  const holding = new Promise<void>(resolve => { held = resolve; });
  const gate = fixture.db.transaction(async transaction => {
    await transaction.execute(sql`SELECT operation_id FROM factory_release_operations WHERE tenant_id=${tenantId} AND project_id=${projectId} AND operation_id=${operationId} FOR UPDATE`);
    held();
    await released;
  });
  await holding;
  const claim = () => settle(world.releases.claim(admin, projectId, operationId, { kind: "approval", approvalId }));
  const stop = () => settle(fixture.db.transaction(transaction => world.releases.stopInTransaction(transaction, projectId, operationId, { commandId: `cancel-${runId}`, epoch: 1, requestedAtMs: Date.now() }, stopEvent)));
  const firstResult = first === "claim" ? claim() : stop();
  await waitingOnOperation(1);
  const secondResult = first === "claim" ? stop() : claim();
  await waitingOnOperation(2);
  release();
  await gate;
  const [claimed, stopped] = first === "claim" ? await Promise.all([firstResult, secondResult]) : (await Promise.all([firstResult, secondResult])).reverse();
  const [operation] = rows<{ state: string; outcome_code: string | null; stop_command_id: string | null; stop_outcome: string | null }>(await fixture.db.execute(sql`SELECT state,outcome_code,stop_command_id,stop_outcome FROM factory_release_operations WHERE tenant_id=${tenantId} AND project_id=${projectId} AND operation_id=${operationId}`));
  return { claimed, stopped, operation, runId };
}

test("a claim that takes the row first leaves a publish running: the stop names its effect uncertain", async () => {
  const { claimed, stopped, operation, runId } = await race("race-claim-first", "claim");
  expect(claimed).toMatchObject({ ok: true, value: { state: "executing" } });
  expect(stopped).toEqual({ ok: true, value: stopEvent("uncertain") });
  expect(operation).toEqual({ state: "executing", outcome_code: null, stop_command_id: `cancel-${runId}`, stop_outcome: null });
}, 60_000);

test("a stop that takes the row first fails the release before dispatch, and the claim finds it stopped", async () => {
  const { claimed, stopped, operation, runId } = await race("race-stop-first", "stop");
  expect(stopped).toEqual({ ok: true, value: stopEvent("none") });
  expect(claimed).toEqual({ ok: false, code: "factory_release_stopped" });
  expect(operation).toEqual({ state: "failed", outcome_code: "stopped_before_dispatch", stop_command_id: `cancel-${runId}`, stop_outcome: "no_effect" });
}, 60_000);
