/**
 * W01h fix round 2 (validator-2's finding D1 on W01i's lane): the lost-result
 * write and a stop settlement lock an attempt's two rows in one order.
 *
 * A settlement locks the attempt's `factory_task_stops` row and then its
 * `factory_attempt_launches` row. The lost-result write used to lock the launch
 * row and then take the stop row FOR SHARE, so the two, interleaved, deadlocked
 * on the proof server ("deadlock detected", 12:35:31Z). This drives exactly
 * that interleaving on real PostgreSQL, where two connections can hold locks at
 * once: the settlement side holds the stop row, the lost result takes the
 * launch row, and then the settlement asks for the launch row.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import type { FactoryPrincipal } from "../../src/factory/grants";
import { FACTORY_STOP_LAUNCH_LOCK_ORDER } from "../../src/factory/runner/attempt-runtime";
import { failedFactoryRunnerResult } from "../../src/factory/runner/native";
import type { FactoryTaskResourceProfile } from "../../src/factory/task-admission";
import { createFactoryLiveAttemptWorld, type FactoryLiveAttemptWorld } from "../../src/__tests__/helpers/factory-live-attempt-world";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = Date.UTC(2030, 0, 1);
const tenantId = "lock-tenant";
const projectId = "lock-project";
const service = { tenantId, subject: "orchestration" };
const principal: FactoryPrincipal = { kind: "user", id: "lock-owner", authentication: "session" };
const profile: FactoryTaskResourceProfile = { resources: { cpu: 1 }, memoryBytes: 128, budget: { costMicros: "5", tokens: 6, computeMs: 7 } };

let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
let world: FactoryLiveAttemptWorld;
beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  world = await createFactoryLiveAttemptWorld(fixture, { label: "lock", tenantId, projectId, principal, factoryId: "lock-factory", hostId: "lock-host", now, profile, service, hostKeys });
});
afterAll(async () => { await fixture.close(); });

const settle = (promise: Promise<unknown>) => promise.then(value => ({ ok: true as const, value }), (error: unknown) => {
  const parts: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) parts.push(current.message);
  return { ok: false as const, error: parts.join(" | ") };
});

/** Waits until `count` backends of this database wait on a lock while asking for the attempt's launch row. */
async function blockedOnLaunchRow(count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = rows<{ waiting: number | string }>(await fixture.db.execute(sql`SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%factory_attempt_launches%'`));
    if (Number(row?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${count} transactions blocked on the launch row after 10 s`);
    await Bun.sleep(20);
  }
}

test(`a real settlement and a real lost result on the same attempt both complete (${FACTORY_STOP_LAUNCH_LOCK_ORDER})`, async () => {
  const attempt = await world.launchedAttempt(false);
  const { reference } = await world.cancelled(attempt);
  // The stop is sealed (reason cancelled) while the host does not answer.
  const hung = world.stopHarness(attempt, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, world.settlingPool(), undefined, 1);
  expect((await hung.stops.stop(service, reference)).state).toBe("uncertain");

  // 1. The gate holds the launch row until both real paths queue behind it.
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let gateHeld!: () => void;
  const held = new Promise<void>(resolve => { gateHeld = resolve; });
  const gate = fixture.db.transaction(async transaction => {
    await transaction.execute(sql`SELECT attempt_id FROM factory_attempt_launches WHERE attempt_id=${attempt.attemptId} FOR UPDATE`);
    gateHeld();
    await released;
  });
  await held;
  // 2. The real lost-result write queues on the launch row first.
  const lost = settle(attempt.launches.recordLostTerminal(attempt.attemptId, failedFactoryRunnerResult({ operations: [], journalCursor: -1 }, { code: "RUNNER_CONTAINER_EXIT", message: "Container ended with exit code 1", retryable: true })));
  await blockedOnLaunchRow(1);
  // 3. The real settlement locks the stop row, then queues on the launch row behind it.
  const settlement = settle(world.stopHarness(attempt, world.countingStopper(async request => world.signedStop(request)), world.settlingPool()).stops.stop(service, reference));
  await blockedOnLaunchRow(2);
  // 4. The lost result now holds the launch row while the settlement holds the stop row.
  release();
  await gate;
  const [recorded, stopped] = await Promise.all([lost, settlement]);

  // Before the fix one side was aborted with "deadlock detected"; now both complete.
  expect(recorded).toEqual({ ok: true, value: { state: "stop-sealed", cancelCommandId: reference.commandId, sealedReason: "cancelled" } });
  expect(stopped).toMatchObject({ ok: true, value: { state: "stopped", stopReceipt: { reason: "cancelled" } } });
  expect(await attempt.launches.terminalResult(attempt.attemptId)).toBeUndefined();
  expect(rows(await fixture.db.execute(sql`SELECT id FROM audit_log WHERE id=${`factory-attempt-exit-after-stop:${attempt.attemptId}`}`))).toHaveLength(1);
}, 60_000);
