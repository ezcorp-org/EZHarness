/**
 * W09e R2: a release's stop, its claim and its dispatch start take the same operation row lock, so what the
 * stop reads under that lock decides the effect: `pending`, or `executing` with no dispatch started, proves no
 * publish started (a claim and a dispatch start both refuse a stopped release); a started dispatch may have
 * published, so the effect is uncertain.
 *
 * Every order runs on real PostgreSQL, synchronised on the database and never on a clock: a gate connection
 * holds the operation row; the first contender queues on it; the second queues behind it; each wait is
 * confirmed in pg_locks with a bounded poll; then the gate releases.
 * - claim, then stop: the claim moves the release to `executing` with no dispatch started, so the stop fails
 *   it `stopped_before_dispatch` with no effect;
 * - stop, then claim: the claim finds the release stopped and is refused `factory_release_stopped`;
 * - dispatch start, then stop: the publish may be running, so the effect is uncertain;
 * - stop, then dispatch start: the dispatch is refused `factory_release_sender_fenced` and never publishes.
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

/** A provider whose response is lost: every publish it starts fails after it is called, so nothing settles. */
function losingProvider() {
  return { calls: 0, async publish() { this.calls += 1; throw new Error("provider response lost"); }, async lookupReceipt() { return null; }, async verifyReceipt() { return false; }, async proveNoEffect() { return false; } };
}

type Contender = "claim" | "stop" | "dispatch";

async function race(runId: string, first: Contender, second: Contender) {
  const run = await world.acceptRun(runId);
  const needsClaim = first === "dispatch" || second === "dispatch";
  const { operationId, approvalId } = await run.approveOnly(first);
  const claimed = needsClaim ? await world.releases.claim(admin, projectId, operationId, { kind: "approval", approvalId }) : undefined;
  const provider = losingProvider();
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
  const start: Record<Contender, () => Promise<Awaited<ReturnType<typeof settle>>>> = {
    claim: () => settle(world.releases.claim(admin, projectId, operationId, { kind: "approval", approvalId })),
    stop: () => settle(fixture.db.transaction(transaction => world.releases.stopInTransaction(transaction, projectId, operationId, { commandId: `cancel-${runId}`, epoch: 1, requestedAtMs: Date.now() }, stopEvent))),
    dispatch: () => settle(world.releases.dispatch(claimed!, provider)),
  };
  const firstResult = start[first]();
  await waitingOnOperation(1);
  const secondResult = start[second]();
  await waitingOnOperation(2);
  release();
  await gate;
  const results = Object.fromEntries([[first, await firstResult], [second, await secondResult]]) as Partial<Record<Contender, Awaited<ReturnType<typeof settle>>>>;
  const [operation] = rows<{ state: string; outcome_code: string | null; dispatch_started: boolean; stop_command_id: string | null; stop_outcome: string | null }>(await fixture.db.execute(sql`SELECT state,outcome_code,dispatch_started,stop_command_id,stop_outcome FROM factory_release_operations WHERE tenant_id=${tenantId} AND project_id=${projectId} AND operation_id=${operationId}`));
  return { ...results, operation, runId, publishes: provider.calls };
}

test("a claim that takes the row first starts no publish: the stop fails the release with no effect", async () => {
  const { claim, stop, operation, runId } = await race("race-claim-first", "claim", "stop");
  expect(claim).toMatchObject({ ok: true, value: { state: "executing" } });
  expect(stop).toEqual({ ok: true, value: stopEvent("none") });
  expect(operation).toEqual({ state: "failed", outcome_code: "stopped_before_dispatch", dispatch_started: false, stop_command_id: `cancel-${runId}`, stop_outcome: "no_effect" });
}, 60_000);

test("a stop that takes the row first fails the release before dispatch, and the claim finds it stopped", async () => {
  const { claim, stop, operation, runId } = await race("race-stop-first", "stop", "claim");
  expect(stop).toEqual({ ok: true, value: stopEvent("none") });
  expect(claim).toEqual({ ok: false, code: "factory_release_stopped" });
  expect(operation).toEqual({ state: "failed", outcome_code: "stopped_before_dispatch", dispatch_started: false, stop_command_id: `cancel-${runId}`, stop_outcome: "no_effect" });
}, 60_000);

test("a dispatch that starts first may publish: the stop names the effect uncertain", async () => {
  const { dispatch, stop, operation, runId, publishes } = await race("race-dispatch-first", "dispatch", "stop");
  expect(stop).toEqual({ ok: true, value: stopEvent("uncertain") });
  expect(dispatch).toMatchObject({ ok: true, value: { state: "uncertain", outcomeCode: "provider_response_unknown" } });
  expect(publishes).toBe(1);
  expect(operation).toEqual({ state: "uncertain", outcome_code: "provider_response_unknown", dispatch_started: true, stop_command_id: `cancel-${runId}`, stop_outcome: null });
}, 60_000);

test("a stop that takes the row before the dispatch starts keeps the publish from ever starting", async () => {
  const { dispatch, stop, operation, runId, publishes } = await race("race-stop-before-dispatch", "stop", "dispatch");
  expect(stop).toEqual({ ok: true, value: stopEvent("none") });
  expect(dispatch).toEqual({ ok: false, code: "factory_release_sender_fenced" });
  expect(publishes).toBe(0);
  expect(operation).toEqual({ state: "failed", outcome_code: "stopped_before_dispatch", dispatch_started: false, stop_command_id: `cancel-${runId}`, stop_outcome: "no_effect" });
}, 60_000);
