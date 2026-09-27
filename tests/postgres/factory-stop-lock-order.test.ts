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

test(`a settlement holding the stop row and a lost result on the same attempt both complete (${FACTORY_STOP_LAUNCH_LOCK_ORDER})`, async () => {
  const attempt = await world.launchedAttempt(false);
  const { reference } = await world.cancelled(attempt);
  // The stop is sealed (reason cancelled) while the host does not answer.
  const hung = world.stopHarness(attempt, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, world.settlingPool(), undefined, 1);
  expect((await hung.stops.stop(service, reference)).state).toBe("uncertain");

  let heldStop!: () => void;
  const stopHeld = new Promise<void>(resolve => { heldStop = resolve; });
  // The settlement's order: the stop row, a pause in which the lost result runs, then the launch row.
  const settlement = settle(fixture.db.transaction(async transaction => {
    await transaction.execute(sql`SELECT cancel_command_id FROM factory_task_stops WHERE attempt_id=${attempt.attemptId} FOR UPDATE`);
    heldStop();
    await Bun.sleep(500);
    await transaction.execute(sql`SELECT attempt_id FROM factory_attempt_launches WHERE attempt_id=${attempt.attemptId} FOR UPDATE`);
    return "settled";
  }));
  await stopHeld;
  const lost = settle(attempt.launches.recordLostTerminal(attempt.attemptId, failedFactoryRunnerResult({ operations: [], journalCursor: -1 }, { code: "RUNNER_CONTAINER_EXIT", message: "Container ended with exit code 1", retryable: true })));
  const [held, recorded] = await Promise.all([settlement, lost]);

  // Before the fix one side was aborted with "deadlock detected"; now neither is.
  expect({ held, recorded }).toEqual({
    held: { ok: true, value: "settled" },
    recorded: { ok: true, value: { state: "stop-sealed", cancelCommandId: reference.commandId, sealedReason: "cancelled" } },
  });
  expect(await attempt.launches.terminalResult(attempt.attemptId)).toBeUndefined();
  expect(rows(await fixture.db.execute(sql`SELECT id FROM audit_log WHERE id=${`factory-attempt-exit-after-stop:${attempt.attemptId}`}`))).toHaveLength(1);
}, 60_000);
