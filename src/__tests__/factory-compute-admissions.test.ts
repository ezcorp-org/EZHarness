import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { FactoryBudgets } from "../factory/budgets";
import { type FactoryAuthorizedCommand, type FactoryCommandAuthority, FactoryCommandAuthorityError } from "../factory/command-authority";
import { FactoryComputeAdmissions } from "../factory/compute-admissions";
import { FactoryInbox } from "../factory/inbox";
import { FactoryCommandOutbox } from "../factory/outbox";
import type { PoolAdmissionClient } from "../factory/pool/client";
import type { PoolDecision, PoolLeaseStatus } from "../factory/pool/ledger";
import { FactoryRecords } from "../factory/records";
import { factoryTaskReservationId, type FactoryComputeAdmissionRequest } from "../factory/task-admission";
import { factoryReservationIdForOrigin, type FactoryAdmissionOrigin, type FactoryProtectedValidatorOrigin } from "../factory/admission-origin";
import type { FactoryAuthorizedAcceptanceCommand, FactoryAuthorizedAdmissionCommand } from "../factory/command-authority";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "../factory/trusted-command-gateway";
import { closeTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";

mockDbConnection();

const tenantId = "compute-tenant";
const projectId = "compute-project";
const service = { tenantId, subject: "orchestration" } as const;
const baseNow = Date.UTC(2030, 0, 1);

class ControlledPool implements PoolAdmissionClient {
  readonly requests: FactoryComputeAdmissionRequest["request"][] = [];
  readonly statuses: string[] = [];
  readonly cancellations: Array<{ reservationId: string; generation: number }> = [];
  decisions: Array<PoolDecision | Error | (() => PoolDecision | Promise<PoolDecision>)> = [];
  leaseStatus?: PoolLeaseStatus;
  statusError?: Error;
  cancelError?: Error;

  async request(input: FactoryComputeAdmissionRequest["request"]): Promise<PoolDecision> {
    this.requests.push(structuredClone(input));
    const next = this.decisions.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next ?? { status: "queued", reservationId: input.reservationId, retryAfterSeconds: 1 };
  }
  async status(reservationId: string): Promise<PoolLeaseStatus | undefined> { this.statuses.push(reservationId); if (this.statusError) { const error = this.statusError; this.statusError = undefined; throw error; } return this.leaseStatus; }
  async cancel(reservationId: string, generation: number): Promise<PoolLeaseStatus> {
    this.cancellations.push({ reservationId, generation });
    if (this.cancelError) { const error = this.cancelError; this.cancelError = undefined; throw error; }
    if (!this.leaseStatus) throw new Error("missing lease status");
    return { ...this.leaseStatus, state: "settled" };
  }
  async acknowledgeStart(): Promise<never> { throw new Error("unused"); }
  async renew(): Promise<never> { throw new Error("unused"); }
}

class ControlledAuthority {
  current = true;
  checks = 0;
  /** The acceptance command a protected-validator poll is authorized through. */
  acceptance?: FactoryAuthorizedAcceptanceCommand;
  constructor(readonly database: TransactionalDb, readonly tenantId: string, readonly reference: TrustedFactoryCommandReference, readonly context: FactoryAuthorizedCommand) {}
  assertService(value: TrustedFactoryServiceIdentity): void {
    this.checks++;
    if (value.tenantId !== this.tenantId || value.subject !== service.subject) throw new FactoryCommandAuthorityError("factory_command_forbidden");
  }
  private live(reference: TrustedFactoryCommandReference): void {
    if (!this.current || reference.tenantId !== this.reference.tenantId || reference.projectId !== this.reference.projectId || reference.logicalRunId !== this.reference.logicalRunId || reference.interpreterId !== this.reference.interpreterId || reference.commandId !== this.reference.commandId) throw new FactoryCommandAuthorityError("factory_command_stale");
  }
  async withCurrent<Result>(value: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, work: (transaction: MigrationDb, context: FactoryAuthorizedCommand) => Promise<Result>): Promise<Result> {
    this.assertService(value);
    this.live(reference);
    return this.database.transaction(transaction => work(transaction, this.context));
  }
  /** Mirrors the real router: a validator origin is authorized by its acceptance command. */
  async withCurrentAdmission<Result>(value: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, origin: FactoryAdmissionOrigin | undefined, work: (transaction: MigrationDb, context: FactoryAuthorizedAdmissionCommand) => Promise<Result>): Promise<Result> {
    this.assertService(value);
    this.live(reference);
    if (origin?.kind !== "protected-validator") return this.database.transaction(transaction => work(transaction, this.context));
    if (!this.acceptance) throw new FactoryCommandAuthorityError("factory_command_stale");
    return this.database.transaction(transaction => work(transaction, this.acceptance!));
  }
}

interface Fixture {
  db: TransactionalDb;
  now: number;
  runId: string;
  reference: TrustedFactoryCommandReference;
  context: FactoryAuthorizedCommand;
  input: FactoryComputeAdmissionRequest;
  authority: ControlledAuthority;
  budgets: FactoryBudgets;
  pool: ControlledPool;
  admissions: FactoryComputeAdmissions;
}

let sequence = 0;

async function fixture(): Promise<Fixture> {
  const { db } = await setupTestDb();
  const records = new FactoryRecords(db, tenantId);
  await records.bindInstallation();
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId}, 'Compute project', '/tmp/compute-project')`);
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name) VALUES ('compute-user', 'compute@example.test', 'not-a-login', 'Compute user')`);
  await records.bindProject(projectId);
  const runId = `compute-run-${++sequence}`;
  await records.createRun({ projectId, runId, definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "compute-build", executionEpoch: 1, principalId: "compute-user", input: {} }, async () => {});
  let now = baseNow;
  const clock = () => now;
  const fence = { tenantId, projectId, runId, executionEpoch: 1, cancellationEpoch: 0, grantRevision: 1, revision: 1, deadlineAtMs: now + 60_000, definitionDigest: `sha256:${"a".repeat(64)}`, status: "queued" } as const;
  const command = { kind: "request-admission", id: `admit-${runId}`, nodeId: "task-node", candidateGeneration: 0, deadlineAtMs: now + 30_000 } as const;
  const context = { command, node: { id: "task-node", kind: "task", runner: { package: "runner", manifestName: "runner", version: "1", export: "run", digest: `sha256:${"b".repeat(64)}` } }, state: { nodes: { "task-node": { attempts: [{ attempt: 1 }] } } }, fence } as unknown as FactoryAuthorizedCommand;
  const reference = { tenantId, projectId, logicalRunId: runId, interpreterId: "root", commandId: command.id };
  const reservationId = factoryTaskReservationId(reference, context);
  const input: FactoryComputeAdmissionRequest = { schemaVersion: "factory.compute-admission.v1", reference, fence, budget: { costMicros: "5", tokens: 6, computeMs: 7 }, memoryBytes: 128, request: { reservationId, grantRevision: 1, grantScope: `${tenantId}:factory`, resources: { cpu: 1, memory: 128 }, admissionDeadline: new Date(command.deadlineAtMs).toISOString() } };
  const budgets = new FactoryBudgets(db, tenantId, async () => {}, clock);
  await budgets.openEnvelope({ projectId, runId, envelopeId: "root", limits: { maxCostMicros: "10", maxTokens: 10, maxComputeMs: 10 }, deadlineAtMs: now + 60_000 });
  const authority = new ControlledAuthority(db, tenantId, reference, context);
  const pool = new ControlledPool();
  const admissions = new FactoryComputeAdmissions(db, tenantId, authority as unknown as FactoryCommandAuthority, budgets, new FactoryInbox(db, tenantId, clock), pool, clock);
  const reserve = async (value = input) => budgets.reserve({ projectId, runId, envelopeId: "root", reservationId: value.request.reservationId, amount: value.budget, computeRequest: value }, async (transaction, request) => {
    await admissions.enlistInTransaction(transaction, request.computeRequest as FactoryComputeAdmissionRequest);
    await new FactoryCommandOutbox(db, tenantId, projectId, clock, "pool").enqueueInTransaction(transaction, { kind: "compute_admission", projectId, logicalRunId: runId, reservationId: value.request.reservationId, body: request.computeRequest });
  });
  await reserve();
  return { db, get now() { return now; }, set now(value: number) { now = value; }, runId, reference, context, input, authority, budgets, pool, admissions };
}

/**
 * The same run, admitted for a protected validator instead of a task attempt.
 *
 * There is no dispatch command and no kernel node: the acceptance command that
 * revealed the need is the authority, and the reservation is keyed from the
 * claim set rather than from an attempt.
 */
async function validatorFixture(claims: readonly string[] = ["claim-a", "claim-b"]): Promise<Fixture & { origin: FactoryProtectedValidatorOrigin; acceptanceCommandId: string }> {
  const base = await fixture();
  // The base fixture leaves its own task admission queued. Drain it, so the
  // validator's delivery is the only one the dispatcher can claim here.
  const baseOutbox = new FactoryCommandOutbox(base.db, tenantId, projectId, () => base.now, "pool");
  const queued = await baseOutbox.claim();
  if (queued) await baseOutbox.settle(queued, "delivered");
  // Settle the base task admission too, so the poller only ever finds the
  // validator's row and a cross-reservation claim cannot mask a real result.
  await base.db.execute(sql`UPDATE factory_compute_admissions SET state='cancelled', next_poll_at=0 WHERE tenant_id=${tenantId} AND run_id=${base.runId} AND reservation_id=${base.input.request.reservationId}`);
  const acceptanceCommandId = `accept-${base.runId}`;
  const acceptanceReference = { ...base.reference, commandId: acceptanceCommandId };
  const acceptanceCommand = { kind: "request-acceptance", id: acceptanceCommandId, nodeId: "acceptance-node", candidateGeneration: 0, deadlineAtMs: base.context.command.deadlineAtMs } as const;
  const origin: FactoryProtectedValidatorOrigin = {
    schemaVersion: "factory.admission-origin.v1", kind: "protected-validator", acceptanceCommandId,
    candidate: { projectId, runId: base.runId, nodeInstanceId: "task-node", candidateGeneration: 0 },
    validatorIds: [...claims].sort(), validatorLockDigest: `sha256:${"c".repeat(64)}`, executionProfileDigest: `sha256:${"d".repeat(64)}`,
  };
  const reservationId = factoryReservationIdForOrigin(acceptanceReference, origin);
  const input: FactoryComputeAdmissionRequest = {
    schemaVersion: "factory.compute-admission.v1", reference: acceptanceReference, fence: base.input.fence,
    budget: { costMicros: "1", tokens: 1, computeMs: 1 }, memoryBytes: 128, origin,
    request: { reservationId, grantRevision: 1, grantScope: `${tenantId}:factory`, resources: { cpu: 1 }, admissionDeadline: base.input.request.admissionDeadline },
  };
  const authority = new ControlledAuthority(base.db, tenantId, acceptanceReference, base.context);
  authority.acceptance = { command: acceptanceCommand, fence: base.input.fence } as unknown as FactoryAuthorizedAcceptanceCommand;
  const pool = new ControlledPool();
  // Delegate the clock to the base fixture, so advancing time here advances the
  // same variable every store in this fixture already reads.
  const clock = () => base.now;
  const admissions = new FactoryComputeAdmissions(base.db, tenantId, authority as unknown as FactoryCommandAuthority, base.budgets, new FactoryInbox(base.db, tenantId, clock), pool, clock);
  const value = { ...base, get now() { return base.now; }, set now(next: number) { base.now = next; }, reference: acceptanceReference, input, authority, pool, admissions, origin, acceptanceCommandId };
  await base.budgets.reserve({ projectId, runId: base.runId, envelopeId: "root", reservationId, amount: input.budget, computeRequest: input }, async (transaction, request) => {
    await admissions.enlistInTransaction(transaction, request.computeRequest as FactoryComputeAdmissionRequest);
    await new FactoryCommandOutbox(base.db, tenantId, projectId, clock, "pool").enqueueInTransaction(transaction, { kind: "compute_admission", projectId, logicalRunId: base.runId, reservationId, body: request.computeRequest });
  });
  return value;
}

function admitted(input: FactoryComputeAdmissionRequest): PoolDecision {
  return { status: "admitted", reservationId: input.request.reservationId, lease: { reservationId: input.request.reservationId, tenantId, grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: `allocation-${input.reference.logicalRunId}`, fence: `fence-${input.reference.logicalRunId}`, deadlineAt: new Date(baseNow + 20_000), resources: input.request.resources, hostId: "host-a" } };
}

async function reservationState(value: Fixture): Promise<string> {
  return rows<{ state: string }>(await value.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${value.runId} AND reservation_id=${value.input.request.reservationId}`))[0]!.state;
}

describe("FactoryComputeAdmissions", () => {
  afterAll(closeTestDb);

  test("a protected validator is admitted through its acceptance command and tells no kernel node", async () => {
    const value = await validatorFixture();
    const inboxBefore = rows(await value.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${value.runId}`)).length;
    value.pool.decisions.push({ status: "queued", reservationId: value.input.request.reservationId, retryAfterSeconds: 1 }, admitted(value.input));
    expect(await value.admissions.dispatchNext(service)).toMatchObject({ status: "queued", reservationId: value.input.request.reservationId });
    value.now += 1_001;
    const result = await value.admissions.pollNext(service);
    expect(result).toMatchObject({ status: "admitted", reservationId: value.input.request.reservationId });
    if (result.status !== "admitted") throw new Error("expected an admitted validator reservation");
    // No kernel node exists, so no `admission-result` is produced or enqueued.
    expect(result.receipt.event).toBeUndefined();
    expect(rows(await value.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${value.runId}`))).toHaveLength(inboxBefore);
    expect(rows(await value.db.execute(sql`SELECT event_json,origin_kind,origin_digest FROM factory_compute_admissions WHERE reservation_id=${value.input.request.reservationId}`))[0]).toMatchObject({ event_json: null, origin_kind: "protected-validator" });
    expect(rows<{ state: string }>(await value.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE run_id=${value.runId} AND reservation_id=${value.input.request.reservationId}`))).toEqual([{ state: "running" }]);
    const material = await value.db.transaction(transaction => value.admissions.readAdmittedInTransaction(transaction, { projectId, runId: value.runId, reservationId: value.input.request.reservationId }));
    expect(material.receipt.event).toBeUndefined();
    expect(material.receipt.lease.allocationToken).toBe(`allocation-${value.runId}`);
  });

  test("a validator admission survives a lost response, a concurrent poll, and a restart", async () => {
    const value = await validatorFixture(["claim-lost"]);
    value.pool.decisions.push(() => { throw new Error("simulated lost response"); });
    expect(await value.admissions.dispatchNext(service)).toMatchObject({ status: "retry", reservationId: value.input.request.reservationId });
    value.now += 1_001;
    value.pool.decisions.push(admitted(value.input), admitted(value.input));
    const competing = await Promise.all([value.admissions.pollNext(service), value.admissions.pollNext(service)]);
    expect(competing.filter(entry => entry.status === "admitted")).toHaveLength(1);
    expect(competing.filter(entry => entry.status === "idle")).toHaveLength(1);
    // A fresh instance recovers the same sealed terminal result and still emits nothing.
    const restarted = new FactoryComputeAdmissions(value.db, tenantId, value.authority as unknown as FactoryCommandAuthority, value.budgets, new FactoryInbox(value.db, tenantId, () => value.now), new ControlledPool(), () => value.now);
    const recovered = await restarted.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId });
    expect(recovered).toMatchObject({ status: "admitted", reservationId: value.input.request.reservationId });
    if (recovered.status !== "admitted") throw new Error("expected a recovered validator reservation");
    expect(recovered.receipt.event).toBeUndefined();
    expect(rows(await value.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${value.runId} AND payload::jsonb->>'kind'='admission-result'`))).toEqual([]);
  });

  test("a validator poll whose acceptance command is gone cancels instead of admitting", async () => {
    const value = await validatorFixture(["claim-cancel"]);
    value.pool.leaseStatus = { reservationId: value.input.request.reservationId, tenantId, state: "queued", allocationGeneration: 1, holderGeneration: 0, effects: 0, resources: { cpu: 1 } };
    value.authority.acceptance = undefined;
    expect(await value.admissions.dispatchNext(service)).toMatchObject({ status: "cancelled", reservationId: value.input.request.reservationId });
    expect(rows<{ state: string }>(await value.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE run_id=${value.runId} AND reservation_id=${value.input.request.reservationId}`))).toEqual([{ state: "held" }]);
    expect(rows(await value.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${value.runId} AND payload::jsonb->>'kind'='admission-result'`))).toEqual([]);
  });

  test("one reservation per validator identity, and a forged acceptance cannot claim one", async () => {
    const value = await validatorFixture(["claim-x", "claim-y"]);
    // The identity is the claim set, so the same set re-enlists onto the same row.
    const again = await value.db.transaction(transaction => value.admissions.enlistInTransaction(transaction, value.input));
    expect(again).toEqual({ created: false });
    expect(rows(await value.db.execute(sql`SELECT reservation_id FROM factory_compute_admissions WHERE run_id=${value.runId} AND origin_kind='protected-validator'`))).toHaveLength(1);
    // A different claim set is a different identity and a different reservation.
    const other = { ...value.origin, validatorIds: ["claim-x", "claim-z"] } as FactoryProtectedValidatorOrigin;
    expect(factoryReservationIdForOrigin(value.reference, other)).not.toBe(value.input.request.reservationId);
    // An origin naming another acceptance command is refused by the live check.
    const forged = { ...value.input, origin: { ...value.origin, acceptanceCommandId: "accept-elsewhere" } as FactoryProtectedValidatorOrigin };
    await expect(value.db.transaction(transaction => value.admissions.enlistInTransaction(transaction, forged))).rejects.toMatchObject({ code: "factory_compute_admission_conflict" });
    value.pool.decisions.push(admitted(value.input));
    const drifted = { ...value.input, origin: { ...value.origin, acceptanceCommandId: "accept-elsewhere" } as FactoryProtectedValidatorOrigin };
    await expect(value.admissions.recover(service, { projectId, runId: value.runId, reservationId: drifted.request.reservationId })).resolves.toMatchObject({ status: "admitted" });
    // A malformed origin never reaches the durable row.
    const malformed = { ...value.input, origin: { schemaVersion: "factory.admission-origin.v1", kind: "protected-validator" } as unknown as FactoryProtectedValidatorOrigin };
    await expect(value.db.transaction(transaction => value.admissions.enlistInTransaction(transaction, malformed))).rejects.toMatchObject({ code: "factory_compute_admission_invalid" });
  });

  test("queued work is recovered by the exact request and commits one stable receipt", async () => {
    const value = await fixture();
    await expect(value.db.transaction(transaction => value.admissions.readAdmittedInTransaction(transaction, { projectId, runId: value.runId, reservationId: value.input.request.reservationId }))).rejects.toMatchObject({ code: "factory_compute_admission_not_admitted" });
    value.pool.decisions.push({ status: "queued", reservationId: value.input.request.reservationId, retryAfterSeconds: 1 }, admitted(value.input));
    expect(await value.admissions.dispatchNext(service)).toMatchObject({ status: "queued", reservationId: value.input.request.reservationId });
    value.now += 1_001;
    const result = await value.admissions.pollNext(service);
    expect(result).toMatchObject({ status: "admitted", receipt: { lease: { allocationToken: `allocation-${value.runId}` }, event: { kind: "admission-result", granted: true, commandId: value.reference.commandId } } });
    expect(value.pool.requests).toEqual([value.input.request, value.input.request]);
    expect(await reservationState(value)).toBe("running");
    expect(rows(await value.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${value.runId}`))).toHaveLength(1);
    const material = await value.db.transaction(transaction => value.admissions.readAdmittedInTransaction(transaction, { projectId, runId: value.runId, reservationId: value.input.request.reservationId }));
    expect(material).toEqual({ request: value.input, receipt: (result as Extract<typeof result, { status: "admitted" }>).receipt });
    expect([material, material.request, material.receipt, material.receipt.lease, material.receipt.event].every(Object.isFrozen)).toBe(true);
    value.authority.current = false;
    const replay = await value.admissions.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId });
    expect(replay).toEqual(result);
    expect(value.pool.requests).toHaveLength(2);
  });

  test("a lost admitted response retries the original request without duplicating allocation or event", async () => {
    const value = await fixture();
    const remote = admitted(value.input);
    value.pool.decisions.push(() => { throw new Error("connection reset after response"); }, () => remote);
    expect(await value.admissions.dispatchNext(service)).toMatchObject({ status: "retry", reason: "factory_compute_admission_transport" });
    value.now += 1_001;
    expect(await value.admissions.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId })).toMatchObject({ status: "admitted" });
    value.now += 1_001;
    expect(await value.admissions.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId })).toMatchObject({ status: "admitted" });
    expect(value.pool.requests).toEqual([value.input.request, value.input.request]);
    expect(rows(await value.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${value.runId}`))).toHaveLength(1);
  });

  test("competing pollers lease one due row", async () => {
    const value = await fixture();
    await value.admissions.dispatchNext(service);
    value.now += 1_001;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    value.pool.decisions.push(async () => { await blocked; return admitted(value.input); });
    const first = value.admissions.pollNext(service);
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = await value.admissions.pollNext(service);
    release();
    expect(second).toEqual({ status: "idle" });
    expect(await first).toMatchObject({ status: "admitted" });
    expect(value.pool.requests).toHaveLength(2);
  });

  test("authority loss after remote allocation cancels it and retains the hold", async () => {
    const value = await fixture();
    value.pool.leaseStatus = { reservationId: value.input.request.reservationId, tenantId, state: "held", allocationGeneration: 1, holderGeneration: 0, effects: 0, resources: value.input.request.resources, hostId: "host-a" };
    value.pool.decisions.push(() => { value.authority.current = false; return admitted(value.input); });
    expect(await value.admissions.dispatchNext(service)).toEqual({ status: "cancelled", reservationId: value.input.request.reservationId });
    expect(value.pool.cancellations).toEqual([{ reservationId: value.input.request.reservationId, generation: 1 }]);
    expect(await reservationState(value)).toBe("held");
    expect(rows(await value.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${value.runId}`))).toEqual([]);
  });

  test("uncertain remote cancellation remains recoverable across status and cancel failures", async () => {
    const value = await fixture();
    value.pool.decisions.push(new Error("lost admission response"));
    expect(await value.admissions.dispatchNext(service)).toMatchObject({ status: "retry" });
    value.authority.current = false; value.now += 1_001;
    expect(await value.admissions.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId })).toMatchObject({ status: "cancelling" });
    value.pool.statusError = new Error("status unavailable"); value.now += 1_001;
    await expect(value.admissions.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId })).rejects.toThrow("status unavailable");
    value.pool.leaseStatus = { reservationId: value.input.request.reservationId, tenantId, state: "held", allocationGeneration: 1, holderGeneration: 1, effects: 0, resources: value.input.request.resources };
    value.pool.cancelError = new Error("cancel unavailable"); value.now += 1_001;
    await expect(value.admissions.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId })).rejects.toThrow("cancel unavailable");
    value.now += 1_001;
    expect(await value.admissions.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId })).toEqual({ status: "cancelled", reservationId: value.input.request.reservationId });
    expect(await reservationState(value)).toBe("held");
  });

  test("a concurrent terminal write wins over a queued response", async () => {
    const value = await fixture();
    value.pool.decisions.push(async () => {
      await value.db.execute(sql`UPDATE factory_compute_admissions SET state='cancelled', next_poll_at=0, poll_lease_until=0, poll_lease_token=NULL WHERE run_id=${value.runId}`);
      return { status: "queued", reservationId: value.input.request.reservationId, retryAfterSeconds: 1 };
    });
    expect(await value.admissions.dispatchNext(service)).toEqual({ status: "cancelled", reservationId: value.input.request.reservationId });
    expect(value.pool.requests).toHaveLength(1);
  });

  test("malformed pool leases never become product grants", async () => {
    const value = await fixture();
    const malformed = admitted(value.input);
    malformed.lease!.deadlineAt = new Date(value.input.request.admissionDeadline);
    malformed.lease!.deadlineAt = new Date(malformed.lease!.deadlineAt.getTime() + 1);
    value.pool.decisions.push(malformed, admitted(value.input));
    expect(await value.admissions.dispatchNext(service)).toMatchObject({ status: "retry", reason: "factory_compute_admission_invalid" });
    expect(await reservationState(value)).toBe("held");
    expect(rows(await value.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${value.runId}`))).toEqual([]);
    value.now += 1_001;
    expect(await value.admissions.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId })).toMatchObject({ status: "admitted" });
  });

  test("authority loss before any remote attempt cancels locally", async () => {
    const value = await fixture();
    value.authority.current = false;
    expect(await value.admissions.dispatchNext(service)).toEqual({ status: "cancelled", reservationId: value.input.request.reservationId });
    expect(value.pool.requests).toEqual([]);
    expect(await reservationState(value)).toBe("held");
  });

  test("rejection commits a negative event while the product hold remains", async () => {
    const value = await fixture();
    value.pool.decisions.push({ status: "rejected", reservationId: value.input.request.reservationId, reason: "capacity" });
    const result = await value.admissions.dispatchNext(service);
    expect(result).toMatchObject({ status: "rejected", event: { granted: false } });
    expect(await reservationState(value)).toBe("held");
    expect(rows(await value.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${value.runId}`))).toHaveLength(1);
  });

  test("scope, request conflicts, terminal corruption, and foreign services fail closed", async () => {
    const value = await fixture();
    await expect(value.admissions.recover({ ...service, subject: "foreign" }, { projectId, runId: value.runId, reservationId: value.input.request.reservationId })).rejects.toMatchObject({ code: "factory_command_forbidden" });
    await expect(value.db.transaction(transaction => value.admissions.enlistInTransaction(transaction, { ...value.input, memoryBytes: 129 }))).rejects.toMatchObject({ code: "factory_compute_admission_conflict" });
    await expect(value.db.transaction(transaction => value.admissions.enlistInTransaction(transaction, { ...value.input, request: { ...value.input.request, grantScope: "foreign:factory" } }))).rejects.toMatchObject({ code: "factory_compute_admission_scope" });
    value.pool.decisions.push(admitted(value.input));
    expect((await value.admissions.dispatchNext(service)).status).toBe("admitted");
    await value.db.execute(sql`UPDATE factory_compute_admissions SET event_json='{}' WHERE run_id=${value.runId}`);
    await expect(value.admissions.recover(service, { projectId, runId: value.runId, reservationId: value.input.request.reservationId })).rejects.toMatchObject({ code: "factory_compute_admission_corrupt" });
    expect(() => new FactoryComputeAdmissions(value.db, "foreign", value.authority as unknown as FactoryCommandAuthority, value.budgets, new FactoryInbox(value.db, tenantId), value.pool)).toThrow("factory_compute_admission_scope");
  });

  test("the admitted reader rejects a mismatched budget allocation fence", async () => {
    const value = await fixture();
    value.pool.decisions.push(admitted(value.input));
    expect((await value.admissions.dispatchNext(service)).status).toBe("admitted");
    await value.db.execute(sql`UPDATE factory_budget_reservations SET compute_allocation=${JSON.stringify({ allocationToken: "other", reservationGeneration: 1 })} WHERE run_id=${value.runId}`);
    await expect(value.db.transaction(transaction => value.admissions.readAdmittedInTransaction(transaction, { projectId, runId: value.runId, reservationId: value.input.request.reservationId }))).rejects.toMatchObject({ code: "factory_compute_admission_corrupt" });
  });
});
