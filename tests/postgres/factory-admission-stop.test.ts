import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { advanceKernel, type KernelCommand, type KernelEvent } from "@ezcorp/factory-sdk";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { FactoryAttemptQueue } from "../../src/factory/attempt-queue";
import { FACTORY_COMPUTE_ADMISSION_ATTEMPT_STOPPED, FactoryComputeAdmissions } from "../../src/factory/compute-admissions";
import { FactoryExecutionJournal } from "../../src/factory/executions";
import type { FactoryPrincipal } from "../../src/factory/grants";
import { FactoryInbox } from "../../src/factory/inbox";
import type { PoolAdmissionClient } from "../../src/factory/pool/client";
import type { PoolDecision, PoolLeaseStatus } from "../../src/factory/pool/ledger";
import type { PoolAdmissionRequest } from "../../src/factory/pool/service";
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
 *
 * R3: the pool side. A grant the pool decided while the stop settled reaches
 * the admission worker late: it is refused by name, released at the pool
 * through the worker's own cancel (no new trust path), and never committed,
 * so the kernel never gets an admission result and never dispatches.
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
const unavailable = async (): Promise<never> => { throw new Error("this pool call is not part of the case"); };

/** A pool whose admission answer the test gives, and which counts the capacity it is asked to release. */
function gatedPool() {
  let requested!: (request: PoolAdmissionRequest) => void;
  let answer!: (decision: PoolDecision) => void;
  const cancellations: Array<readonly [string, number]> = [];
  const lease = (request: PoolAdmissionRequest, state: PoolLeaseStatus["state"]): PoolLeaseStatus => ({ reservationId: request.reservationId, tenantId, state, allocationGeneration: 1, holderGeneration: 1, effects: 0, resources: request.resources });
  let asked: PoolAdmissionRequest | undefined;
  const reached = new Promise<PoolAdmissionRequest>(resolve => { requested = resolve; });
  const client = {
    request: (request: PoolAdmissionRequest) => { asked = request; requested(request); return new Promise<PoolDecision>(resolve => { answer = resolve; }); },
    status: async () => lease(asked!, "held"),
    cancel: async (reservationId: string, generation: number) => { cancellations.push([reservationId, generation]); return lease(asked!, "settled"); },
    acknowledgeStart: unavailable, renew: unavailable, confirmStopped: unavailable,
  } satisfies PoolAdmissionClient;
  /** The pool grants the request it holds: the capacity is allocated at the pool. */
  const grant = (request: PoolAdmissionRequest) => answer({ status: "admitted", reservationId: request.reservationId, lease: { reservationId: request.reservationId, tenantId, grantRevision: request.grantRevision, allocationGeneration: 1, holderGeneration: 1, allocationToken: `late-grant-${request.reservationId}`, fence: "late-grant-fence", deadlineAt: new Date(request.admissionDeadline), resources: request.resources } });
  return { client, reached, grant, cancellations };
}

/** A started run whose node is reserved: its compute request is queued and its budget hold is taken. */
async function reservedRun(pool: PoolAdmissionClient = { request: unavailable, status: unavailable, cancel: unavailable, acknowledgeStart: unavailable, renew: unavailable, confirmStopped: unavailable }) {
  const { run, identity, compiled, authority, first, activities, admissionCommandId } = await world.startRun();
  const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
  const admissions = new FactoryComputeAdmissions(fixture.db, tenantId, authority, world.lifecycle.budgets, inbox, pool, () => now);
  const reserved = await new FactoryTaskAdmission(fixture.db, authority, world.lifecycle.budgets, { cpu: profile }, admissions, () => now).request(service, { ...identity, commandId: admissionCommandId });
  const key = { projectId, runId: run.runId, reservationId: reserved.reservationId };
  const journal = () => new FactoryExecutionJournal(fixture.db, world.lifecycle.authorizeAttemptInTransaction);
  const queue = new FactoryAttemptQueue(fixture.db, journal(), tenantId, () => now);
  const outcomes = new FactoryTaskOutcomes(fixture.db, authority, admissions, journal(), queue, world.lifecycle.budgets, inbox, () => now);
  const stops = new FactoryTaskStops(fixture.db, authority, admissions, journal(), outcomes, queue, world.lifecycle.budgets, inbox, new FactoryUsageSettlements(fixture.db, tenantId, inbox, () => now),
    world.countingStopper(async () => { throw new Error("a reserved attempt has no host to stop"); }), world.settlingPool({}, () => { throw new Error("a reserved attempt holds no capacity"); }),
    [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }], () => now, 20_000);
  let cancelNode: Extract<KernelCommand, { kind: "cancel-node" }> | undefined;
  return {
    run, identity, compiled, activities, admissionCommandId, admissions, key,
    hold: async () => rows<{ state: string }>(await fixture.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE reservation_id=${reserved.reservationId}`))[0]?.state,
    admission: async () => rows<{ state: string; stop_command_id: string | null; stop_requested_epoch: number | string | null }>(await fixture.db.execute(sql`SELECT state,stop_command_id,stop_requested_epoch FROM factory_compute_admissions WHERE reservation_id=${reserved.reservationId}`))[0],
    events: async () => rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${run.runId} ORDER BY sequence`)).map(row => JSON.parse(row.payload) as KernelEvent),
    /** The user cancels; the kernel asks to cancel the node, naming the admission command. */
    async cancel() {
      await world.lifecycle.cancel(principal, world.runKey(run.runId), run.revision, `admission-stop-cancel-${run.runId}`);
      const cancelEvent = JSON.parse(rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${run.runId} AND payload::jsonb->>'kind'='cancel'`))[0]!.payload) as KernelEvent;
      const advanced = advanceKernel(compiled, first.nextState, cancelEvent);
      cancelNode = advanced.commands.find((command): command is Extract<KernelCommand, { kind: "cancel-node" }> => command.kind === "cancel-node");
      await persistTransition(identity, 2, cancelEvent, advanced.nextState, advanced.commands, undefined, activities);
      return { advanced, cancelNode: cancelNode! };
    },
    /** The stop worker drives that cancel-node through the task stop. */
    stop: () => stops.stop(service, { ...identity, commandId: cancelNode!.id }).then(
      receipt => ({ settled: receipt }),
      (error: unknown) => ({ refused: { code: (error as { code?: string }).code, message: (error as Error).message } }),
    ),
  };
}

type Stopped = { settled: { event: KernelEvent } };

test("W09h R2: a run cancelled while its node waits for compute admission settles the attempt in place and ends", async () => {
  const reserved = await reservedRun();
  record("hold before the cancel", await reserved.hold());
  const { advanced, cancelNode } = await reserved.cancel();
  record("cancel-node command", cancelNode);
  record("kernel status after the cancel", advanced.nextState.status);
  const outcome = await reserved.stop();
  record("task stop outcome", outcome);
  const admission = await reserved.admission();
  record("admission after the stop", admission);
  const repeated = await reserved.stop();

  // What the kernel receives, folded from the cancelled state.
  const events = await reserved.events();
  record("inbox event kinds", events.map(event => event.kind));
  const folded = events.filter(event => event.kind === "attempt-stopped").reduce((state, event) => advanceKernel(reserved.compiled, state.nextState, event), advanced).nextState;
  record("kernel status after the stop", folded.status);
  record("stopped node", folded.nodes[cancelNode.nodeId]);
  record("run lifecycle status", rows<{ status: string }>(await fixture.db.execute(sql`SELECT status FROM factory_run_lifecycle WHERE run_id=${reserved.run.runId}`))[0]?.status);
  record("hold after the stop", await reserved.hold());

  // R2: the stop settles in place, names the stop before admission, carries the epoch, and the run ends cancelled.
  const expectedEvent = { kind: "attempt-stopped", id: `${cancelNode.id}:stopped`, nodeId: cancelNode.nodeId, commandId: reserved.admissionCommandId, stoppedBefore: "admission" };
  expect(outcome).toMatchObject({ settled: { state: "stopped", event: expectedEvent } });
  expect(outcome).not.toHaveProperty("settled.stopReceipt");
  expect(admission).toEqual({ state: "pending", stop_command_id: cancelNode.id, stop_requested_epoch: expect.anything() });
  expect(Number(admission!.stop_requested_epoch)).toBe(advanced.nextState.cancellationEpoch);
  expect(repeated).toEqual(outcome);
  expect(events.filter((event): boolean => event.kind === "attempt-stopped")).toEqual([(outcome as Stopped).settled.event]);
  expect(folded.status).toBe("cancelled");
  expect(folded.nodes[cancelNode.nodeId]).toMatchObject({ status: "cancelled", error: "STOPPED_BEFORE_ADMISSION" });
  // After the kernel folds it, the cancel is no longer current; its repeat still answers the recorded event.
  await persistTransition(reserved.identity, 3, (outcome as Stopped).settled.event, folded, [], undefined, reserved.activities);
  expect(await reserved.stop()).toEqual(outcome);
});

test("W09h R3: a grant the pool decides while the stop settles is refused by name, released at the pool, and never dispatched", async () => {
  const pool = gatedPool();
  const reserved = await reservedRun(pool.client);
  // The admission worker asks the pool while the run is still running; the pool holds its answer.
  const polling = reserved.admissions.recover(service, reserved.key);
  const request = await pool.reached;
  const { advanced, cancelNode } = await reserved.cancel();
  const outcome = await reserved.stop();
  record("R3 stop outcome", outcome);
  // Now the pool grants: capacity is allocated for an attempt that is already stopped.
  pool.grant(request);
  const result = await polling;
  record("R3 admission worker result", result);
  const admission = await reserved.admission();
  record("R3 admission after the late grant", admission);
  const events = await reserved.events();
  record("R3 inbox event kinds", events.map(event => event.kind));
  const folded = events.filter(event => event.kind === "attempt-stopped").reduce((state, event) => advanceKernel(reserved.compiled, state.nextState, event), advanced).nextState;

  expect(outcome).toMatchObject({ settled: { state: "stopped", event: { stoppedBefore: "admission" } } });
  // Refused by name, and released through the worker's own cancel: the pool frees the capacity it granted.
  expect(result).toEqual({ status: "cancelled", reservationId: reserved.key.reservationId, refused: FACTORY_COMPUTE_ADMISSION_ATTEMPT_STOPPED });
  expect(pool.cancellations).toEqual([[reserved.key.reservationId, 1]]);
  expect(admission).toMatchObject({ state: "cancelled", stop_command_id: cancelNode.id });
  // Never committed: no admission result reaches the kernel, the hold never ran, nothing is dispatched.
  expect(events.map(event => event.kind)).not.toContain("admission-result");
  expect(await reserved.hold()).not.toBe("running");
  expect(folded.status).toBe("cancelled");
  expect(Object.values(folded.nodes).flatMap(node => node.attempts).filter(attempt => attempt.commandId.includes(":dispatch-node:"))).toEqual([]);
});
