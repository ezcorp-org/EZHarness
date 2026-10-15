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
import { FACTORY_USAGE_NOTHING_LAUNCHED_BASIS, FactoryUsageSettlements } from "../../src/factory/usage-settlement";
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
 *
 * R4: the budget hold settles all zero, cost, tokens and compute, in the
 * stop's own transaction, through the `no-operations` source under the basis
 * "no-operations: nothing launched, all zero" named on the settlement record,
 * proven by the sealed stop's digest. Nothing was admitted, so no compute ran.
 *
 * R5: lock order. A reserved attempt has no stop row and no launch row, so
 * FACTORY_STOP_LAUNCH_LOCK_ORDER has nothing to order; the admission row is
 * the stop row, and it is locked under the run lock. The stop and a late
 * grant's commit both take the run row, then the run's lifecycle row, and only
 * then the admission row. Both orders run on real PostgreSQL, synchronised on
 * the database and never on a clock: a gate transaction holds the lifecycle
 * row, the first contender takes the run row and queues behind the gate, the
 * second queues on the run row behind the first (pg_blocking_pids names each
 * blocker), and neither has reached the admission row while it waits. Either
 * way the run ends cancelled, the hold settles once at zero, the grant is
 * released at the pool once and never committed, and nothing deadlocks.
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

test("W09h R4: the unused hold settles all zero in the stop's transaction, basis \"nothing launched, all zero\"", async () => {
  const reserved = await reservedRun();
  expect(await reserved.hold()).toBe("held");
  const { advanced } = await reserved.cancel();
  const outcome = await reserved.stop();
  expect(outcome).toMatchObject({ settled: { state: "stopped" } });
  const budget = rows<{ state: string; actual: string; receipt_digest: string; xmin: string }>(await fixture.db.execute(sql`SELECT state, actual, receipt_digest, xmin::text AS xmin FROM factory_budget_reservations WHERE reservation_id=${reserved.key.reservationId}`))[0]!;
  const settlements = rows<{ source: string; known_cost_micros: string; unknown_cost_micros: string | null; stop_receipt_digest: string; basis: string; attempt_id: string; xmin: string }>(await fixture.db.execute(sql`SELECT source, known_cost_micros, unknown_cost_micros, stop_receipt_digest, basis, attempt_id, xmin::text AS xmin FROM factory_usage_settlements WHERE reservation_id=${reserved.key.reservationId}`));
  const admissionXmin = rows<{ xmin: string }>(await fixture.db.execute(sql`SELECT xmin::text AS xmin FROM factory_compute_admissions WHERE reservation_id=${reserved.key.reservationId}`))[0]!.xmin;
  record("R4 hold after the stop", budget);
  record("R4 settlements", settlements);
  // All zero, compute too: nothing was admitted, so nothing ran. Proven by the sealed stop, not a host.
  expect(budget.state).toBe("settled");
  expect(JSON.parse(budget.actual)).toEqual({ costMicros: "0", tokens: "0", computeMs: "0" });
  expect(settlements).toEqual([{ source: "no-operations", known_cost_micros: "0", unknown_cost_micros: null, stop_receipt_digest: budget.receipt_digest, basis: FACTORY_USAGE_NOTHING_LAUNCHED_BASIS, attempt_id: reserved.admissionCommandId, xmin: budget.xmin }]);
  // One transaction: the stop mark, the hold and its settlement were all written by the same one.
  expect(admissionXmin).toBe(budget.xmin);
  // The kernel gets the settlement before the stop; both fold, and the run ends.
  const events = await reserved.events();
  expect(events.map(event => event.kind)).toEqual(["cancel", "usage-settled", "attempt-stopped"]);
  const folded = events.slice(1).reduce((state, event) => advanceKernel(reserved.compiled, state, event).nextState, advanced.nextState);
  expect(folded.status).toBe("cancelled");
  // A repeat settles nothing twice.
  expect(await reserved.stop()).toEqual(outcome);
  expect(rows(await fixture.db.execute(sql`SELECT revision FROM factory_usage_settlements WHERE reservation_id=${reserved.key.reservationId}`))).toHaveLength(1);
});

/** One transaction of this test's database that waits on a lock: who blocks it, and which factory tables it has reached. */
interface LockWaiter { readonly pid: number; readonly blockedBy: number[]; readonly tables: string[] }

/**
 * Waits until `count` transactions of this test's own database wait on a lock, and returns them. The database
 * is created for this file alone, so every waiter in it is a contender. The bound only turns a hang into a
 * failure that prints what each backend was doing; the synchronisation itself is the database's lock queue.
 */
async function waitingOnLocks(count: number): Promise<LockWaiter[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiters = rows<{ pid: number | string; blocked_by: Array<number | string>; tables: string[] | null }>(await fixture.db.execute(sql`SELECT a.pid, pg_blocking_pids(a.pid) AS blocked_by,
        (SELECT array_agg(DISTINCT c.relname ORDER BY c.relname) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = a.pid AND c.relkind = 'r' AND c.relname LIKE 'factory_%') AS tables
      FROM pg_stat_activity a WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' ORDER BY a.pid`));
    if (waiters.length >= count) return waiters.map(waiter => ({ pid: Number(waiter.pid), blockedBy: waiter.blocked_by.map(Number), tables: waiter.tables ?? [] }));
    if (Date.now() > deadline) {
      const activity = rows(await fixture.db.execute(sql`SELECT pid, state, wait_event_type, wait_event, left(query, 160) AS query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`));
      throw new Error(`fewer than ${count} transactions waiting on a lock after 10 s: ${JSON.stringify(activity)}`);
    }
  }
}

type Contender = "stop" | "grant";

/**
 * Drives the stop and the late grant's commit against each other in the given order. A gate transaction holds
 * the run's lifecycle row. The first contender takes the run row and queues on the lifecycle row behind the
 * gate; the second then queues on the run row behind the first. Each wait is read from pg_locks, never
 * inferred from time; then the gate commits and the two run in that order.
 */
async function race(first: Contender, second: Contender) {
  const pool = gatedPool();
  const reserved = await reservedRun(pool.client);
  const polling = reserved.admissions.recover(service, reserved.key).then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  const request = await pool.reached;
  const { advanced, cancelNode } = await reserved.cancel();
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let held!: (pid: number) => void;
  const holding = new Promise<number>(resolve => { held = resolve; });
  const gate = fixture.db.transaction(async transaction => {
    await transaction.execute(sql`SELECT run_id FROM factory_run_lifecycle WHERE tenant_id=${tenantId} AND run_id=${reserved.run.runId} FOR UPDATE`);
    held(Number(rows<{ pid: number | string }>(await transaction.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
    await released;
  });
  const gatePid = await holding;
  const results: Partial<Record<Contender, Promise<unknown>>> = {};
  const start = (contender: Contender) => {
    if (contender === "stop") results.stop = reserved.stop();
    // The pool answers; the worker then commits its decision under the run's authority.
    else { pool.grant(request); results.grant = polling; }
  };
  let waits: { readonly gatePid: number; readonly first: LockWaiter; readonly second: LockWaiter };
  try {
    start(first);
    const [firstWaiter] = await waitingOnLocks(1);
    start(second);
    const secondWaiter = (await waitingOnLocks(2)).find(waiter => waiter.pid !== firstWaiter!.pid)!;
    waits = { gatePid, first: firstWaiter!, second: secondWaiter };
  } finally {
    release();
    await gate;
  }
  record(`R5 ${first} then ${second}: lock waits`, waits);
  const stop = await results.stop;
  const grant = await results.grant;
  const events = await reserved.events();
  const folded = events.slice(1).reduce((state, event) => advanceKernel(reserved.compiled, state, event).nextState, advanced.nextState);
  const facts = {
    stop, grant, cancellations: pool.cancellations, admission: await reserved.admission(), hold: await reserved.hold(), kinds: events.map(event => event.kind), status: folded.status,
    settlements: rows<{ source: string; basis: string }>(await fixture.db.execute(sql`SELECT source, basis FROM factory_usage_settlements WHERE reservation_id=${reserved.key.reservationId}`)),
    stopRows: rows(await fixture.db.execute(sql`SELECT cancel_command_id FROM factory_task_stops WHERE run_id=${reserved.run.runId}`)),
    launchRows: rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_attempt_launches WHERE run_id=${reserved.run.runId}`)),
  };
  record(`R5 ${first} then ${second}`, facts);
  return { ...facts, waits, cancelNode, reservationId: reserved.key.reservationId };
}

/**
 * What both orders must show. The lock order: each contender takes the run row before anything else, the
 * first waits on the lifecycle row the gate holds, the second waits on the run row the first holds, and
 * neither has reached the admission row (the stop row here) while it waits. The end: the run cancelled, the
 * hold settled once at zero, the grant released at the pool once and never committed, and no deadlock.
 */
function expectOrderedSettledAndReleased(facts: Awaited<ReturnType<typeof race>>) {
  const { gatePid, first, second } = facts.waits;
  expect(first.blockedBy).toEqual([gatePid]);
  expect(first.tables).toEqual(expect.arrayContaining(["factory_runs", "factory_run_lifecycle"]));
  expect(second.blockedBy).toEqual([first.pid]);
  expect(second.tables).toContain("factory_runs");
  expect(second.tables).not.toContain("factory_run_lifecycle");
  expect([...first.tables, ...second.tables]).not.toContain("factory_compute_admissions");

  expect(facts.stop).toMatchObject({ settled: { state: "stopped", event: { stoppedBefore: "admission" } } });
  expect(facts.grant).toMatchObject({ ok: true, value: { status: "cancelled", reservationId: facts.reservationId } });
  expect(facts.cancellations).toEqual([[facts.reservationId, 1]]);
  expect(facts.admission).toMatchObject({ state: "cancelled", stop_command_id: facts.cancelNode.id });
  expect(facts.hold).toBe("settled");
  expect(facts.settlements).toEqual([{ source: "no-operations", basis: FACTORY_USAGE_NOTHING_LAUNCHED_BASIS }]);
  expect(facts.kinds).toEqual(["cancel", "usage-settled", "attempt-stopped"]);
  expect(facts.status).toBe("cancelled");
  // Only the admission row was the stop's: there is no stop row and no launch row to order.
  expect(facts.stopRows).toEqual([]);
  expect(facts.launchRows).toEqual([]);
}

test("W09h R5: a stop that takes the run first settles in place; the late grant behind it is refused by name and released", async () => {
  const facts = await race("stop", "grant");
  expectOrderedSettledAndReleased(facts);
  expect(facts.grant).toMatchObject({ value: { refused: FACTORY_COMPUTE_ADMISSION_ATTEMPT_STOPPED } });
}, 60_000);

test("W09h R5: a grant that takes the run first loses the cancelled run's authority and is released; the stop behind it still settles in place", async () => {
  const facts = await race("grant", "stop");
  expectOrderedSettledAndReleased(facts);
  expect(facts.grant).not.toMatchObject({ value: { refused: FACTORY_COMPUTE_ADMISSION_ATTEMPT_STOPPED } });
}, 60_000);
