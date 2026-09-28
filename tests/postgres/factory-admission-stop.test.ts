import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { advanceKernel, type KernelEvent } from "@ezcorp/factory-sdk";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { FactoryAttemptQueue } from "../../src/factory/attempt-queue";
import { FactoryComputeAdmissions } from "../../src/factory/compute-admissions";
import { FactoryExecutionJournal } from "../../src/factory/executions";
import type { FactoryPrincipal } from "../../src/factory/grants";
import { FactoryInbox } from "../../src/factory/inbox";
import type { PoolAdmissionClient } from "../../src/factory/pool/client";
import { FactoryTaskAdmission, type FactoryTaskResourceProfile } from "../../src/factory/task-admission";
import { FactoryTaskOutcomes } from "../../src/factory/task-outcomes";
import { FactoryTaskStops } from "../../src/factory/task-stops";
import { FactoryUsageSettlements } from "../../src/factory/usage-settlement";
import { persistTransition } from "../../packages/@ezcorp/factory-orchestrator/src/transition-pages";
import { createFactoryLiveAttemptWorld, type FactoryLiveAttemptWorld } from "../../src/__tests__/helpers/factory-live-attempt-world";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

/**
 * W09h, on real PostgreSQL: a run cancelled while a node is `reserved` (its
 * compute request queued, no attempt ever dispatched) ends.
 *
 * R1 reproduced the defect red first: the stop was refused
 * `factory_task_stop_stale`, nothing sent attempt-stopped, the run stayed
 * `stopping`, and the hold stayed `held`. The log still records each fact.
 *
 * R2: the stop settles the reserved attempt in place, in its own transaction,
 * with no claim and no capacity: the admission carries the cancel and the
 * cancellation epoch it raised, the kernel gets attempt-stopped named
 * `stoppedBefore: "admission"`, and the run reaches `cancelled` without the
 * pool. A repeat of the cancel answers the recorded event, before and after
 * the kernel folds it.
 */

const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = Date.UTC(2030, 0, 1);
const tenantId = "admission-stop-tenant";
const projectId = "admission-stop-project";
const hostId = "admission-stop-host";
const principal: FactoryPrincipal = { kind: "user", id: "admission-stop-owner", authentication: "session" };
const service = { tenantId, subject: "orchestration" };
const profile: FactoryTaskResourceProfile = { resources: { cpu: 1 }, memoryBytes: 128, budget: { costMicros: "5", tokens: 6, computeMs: 7 } };

let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
let world: FactoryLiveAttemptWorld;
beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  world = await createFactoryLiveAttemptWorld(fixture, { label: "admission-stop", tenantId, projectId, principal, factoryId: "admission-stop-factory", hostId, now, profile, service, hostKeys });
});
afterAll(async () => { await fixture?.close(); });

const record = (fact: string, value: unknown) => console.error(`[W09h] ${fact}: ${JSON.stringify(value)}`);

test("W09h R2: a run cancelled while its node waits for compute admission settles the attempt in place and ends", async () => {
  const { run, identity, compiled, authority, first, activities, admissionCommandId } = await world.startRun();
  const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
  const unavailable = async (): Promise<never> => { throw new Error("the pool is never reached in this reproduction"); };
  const requestPool = { request: unavailable, status: unavailable, cancel: unavailable, acknowledgeStart: unavailable, renew: unavailable, confirmStopped: unavailable } satisfies PoolAdmissionClient;
  const admissions = new FactoryComputeAdmissions(fixture.db, tenantId, authority, world.lifecycle.budgets, inbox, requestPool, () => now);
  // The node is reserved: its compute request is queued and the budget hold is taken.
  const reserved = await new FactoryTaskAdmission(fixture.db, authority, world.lifecycle.budgets, { cpu: profile }, admissions, () => now).request(service, { ...identity, commandId: admissionCommandId });
  const holdState = async () => rows<{ state: string }>(await fixture.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE reservation_id=${reserved.reservationId}`))[0]?.state;
  record("hold before the cancel", await holdState());

  // The user cancels. The kernel asks to cancel the node, naming the admission command.
  await world.lifecycle.cancel(principal, world.runKey(run.runId), run.revision, `admission-stop-cancel-${run.runId}`);
  const cancelEvent = JSON.parse(rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${run.runId} AND payload::jsonb->>'kind'='cancel'`))[0]!.payload) as KernelEvent;
  const advanced = advanceKernel(compiled, first.nextState, cancelEvent);
  const cancelNode = advanced.commands.find(command => command.kind === "cancel-node");
  record("cancel-node command", cancelNode);
  record("kernel status after the cancel", advanced.nextState.status);
  await persistTransition(identity, 2, cancelEvent, advanced.nextState, advanced.commands, undefined, activities);

  // The stop worker drives that cancel-node through the task stop.
  const journal = () => new FactoryExecutionJournal(fixture.db, world.lifecycle.authorizeAttemptInTransaction);
  const queue = new FactoryAttemptQueue(fixture.db, journal(), tenantId, () => now);
  const outcomes = new FactoryTaskOutcomes(fixture.db, authority, admissions, journal(), queue, world.lifecycle.budgets, inbox, () => now);
  const stops = new FactoryTaskStops(fixture.db, authority, admissions, journal(), outcomes, queue, world.lifecycle.budgets, inbox, new FactoryUsageSettlements(fixture.db, tenantId, inbox, () => now),
    world.countingStopper(async () => { throw new Error("a reserved attempt has no host to stop"); }), world.settlingPool({}, () => { throw new Error("a reserved attempt holds no capacity"); }),
    [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }], () => now, 20_000);
  const stop = () => stops.stop(service, { ...identity, commandId: cancelNode!.id }).then(
    receipt => ({ settled: receipt }),
    (error: unknown) => ({ refused: { code: (error as { code?: string }).code, message: (error as Error).message } }),
  );
  const outcome = await stop();
  record("task stop outcome", outcome);
  const admission = rows<{ state: string; stop_command_id: string | null; stop_requested_epoch: number | string | null }>(await fixture.db.execute(sql`SELECT state,stop_command_id,stop_requested_epoch FROM factory_compute_admissions WHERE reservation_id=${reserved.reservationId}`))[0];
  record("admission after the stop", admission);
  const repeated = await stop();

  // What the kernel receives, folded from the cancelled state.
  const events = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${run.runId} ORDER BY sequence`)).map(row => JSON.parse(row.payload) as KernelEvent);
  record("inbox event kinds", events.map(event => event.kind));
  const folded = events.filter(event => event.kind === "attempt-stopped").reduce((state, event) => advanceKernel(compiled, state.nextState, event), advanced).nextState;
  record("kernel status after the stop", folded.status);
  record("stopped node", folded.nodes[cancelNode!.nodeId]);
  record("run lifecycle status", rows<{ status: string }>(await fixture.db.execute(sql`SELECT status FROM factory_run_lifecycle WHERE run_id=${run.runId}`))[0]?.status);
  record("hold after the stop", await holdState());

  // R2: the stop settles in place, names the stop before admission, carries the epoch, and the run ends cancelled.
  const expectedEvent = { kind: "attempt-stopped", id: `${cancelNode!.id}:stopped`, nodeId: cancelNode!.nodeId, commandId: admissionCommandId, stoppedBefore: "admission" };
  expect(outcome).toMatchObject({ settled: { state: "stopped", event: expectedEvent } });
  expect(outcome).not.toHaveProperty("settled.stopReceipt");
  expect(admission).toEqual({ state: "pending", stop_command_id: cancelNode!.id, stop_requested_epoch: expect.anything() });
  expect(Number(admission!.stop_requested_epoch)).toBe(advanced.nextState.cancellationEpoch);
  expect(repeated).toEqual(outcome);
  expect(events.filter((event): boolean => event.kind === "attempt-stopped")).toEqual([(outcome as { settled: { event: KernelEvent } }).settled.event]);
  expect(folded.status).toBe("cancelled");
  expect(folded.nodes[cancelNode!.nodeId]).toMatchObject({ status: "cancelled", error: "STOPPED_BEFORE_ADMISSION" });
  // After the kernel folds it, the cancel is no longer current; its repeat still answers the recorded event.
  await persistTransition(identity, 3, (outcome as { settled: { event: KernelEvent } }).settled.event, folded, [], undefined, activities);
  expect(await stop()).toEqual(outcome);
});
