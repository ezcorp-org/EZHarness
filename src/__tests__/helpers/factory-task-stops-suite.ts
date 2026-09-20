import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import { advanceKernel, createKernelState, FACTORY_LAZY_INPUT_SCHEMA_VERSION, referenceCodeV1, type FactoryDefinition, type FactoryRunnerRequest, type FactoryRunnerResult, type FactoryRunStartBody, type JsonValue, type KernelEvent } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestBytes } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArtifacts } from "../../factory/artifacts";
import { createFactoryArtifactActivities } from "../../factory/artifact-activities";
import { FactoryAttemptQueue } from "../../factory/attempt-queue";
import { FactoryCommandAuthority } from "../../factory/command-authority";
import { FactoryComputeAdmissions } from "../../factory/compute-admissions";
import { FactoryDefinitionArtifacts } from "../../factory/definition-artifacts";
import { FactoryDefinitions } from "../../factory/definitions";
import { FactoryExecutionJournal } from "../../factory/executions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryInbox } from "../../factory/inbox";
import { FactoryNativeRunnerPolicy } from "../../factory/native-runner-policy";
import { FactoryCommandOutbox } from "../../factory/outbox";
import type { PoolAdmissionClient } from "../../factory/pool/client";
import type { PoolLeaseStatus } from "../../factory/pool/ledger";
import { FactoryRecords } from "../../factory/records";
import { FactoryRunLifecycle } from "../../factory/run-lifecycle";
import { FactoryRunTransitionProjector } from "../../factory/run-transition-projector";
import { FactoryDatabaseAttemptLaunchStore, signFactoryPhysicalStopReceipt, type FactoryAttemptLease, type FactoryPhysicalStopReceipt, type FactoryUnsignedPhysicalStopReceipt } from "../../factory/runner/attempt-runtime";
import { FactoryTaskAdmission, type FactoryTaskResourceProfile } from "../../factory/task-admission";
import { FactoryTaskExecutionAdmission } from "../../factory/task-execution-admission";
import { FactoryTaskOutcomes } from "../../factory/task-outcomes";
import { FactoryTaskStops, FactoryTaskStopError, FACTORY_STOP_SCAN_MAX_LIMIT, type FactoryPhysicalStopper, type FactoryPoolStopAcknowledger, type FactoryStopHostKey, type FactoryTaskStopRequest } from "../../factory/task-stops";
import { FactoryTransitionArtifacts } from "../../factory/transition-artifacts";
import { FactoryUsageReconciliation, FactoryUsageSettlements } from "../../factory/usage-settlement";
import { persistTransition } from "../../../packages/@ezcorp/factory-orchestrator/src/transition-pages";

const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rotatedKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const foreignKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

export interface FactoryTaskStopsFixture { db: TransactionalDb; blobs?: BlobStore; close(): Promise<void> }

/** Every C02 stop and C03 settlement behaviour, against one isolated database. */
export function factoryTaskStopsConformance(create: () => Promise<FactoryTaskStopsFixture>): void {
  let fixture: FactoryTaskStopsFixture;
  let definitions: FactoryDefinitions;
  let grants: FactoryGrants;
  let lifecycle: FactoryRunLifecycle;
  let body: FactoryRunStartBody;
  let objectStore: BlobStore;
  const now = Date.UTC(2030, 0, 1);
  let sequence = 0;
  const tenantId = "stop-tenant";
  const projectId = "stop-project";
  const hostId = "stop-host";
  const principal: FactoryPrincipal = { kind: "user", id: "stop-owner", authentication: "session" };
  const key = { projectId, factoryId: "stop-factory" };
  const service = { tenantId, subject: "orchestration" };
  const profile: FactoryTaskResourceProfile = { resources: { cpu: 1 }, memoryBytes: 128, budget: { costMicros: "5", tokens: 6, computeMs: 7 } };
  const contents = new Map<string, Uint8Array>();
  const memoryBlobs = { async put(bytes: Uint8Array) { const digest = digestBytes(bytes); contents.set(digest, bytes.slice()); return digest; }, async get(digest: string) { const bytes = contents.get(digest); if (!bytes) throw new Error("blob unavailable"); return bytes.slice(); } };
  const runKey = (runId: string) => ({ projectId, runId });

  function signed(request: FactoryTaskStopRequest, overrides: Partial<FactoryPhysicalStopReceipt> = {}, key = hostKeys.privateKey, keyId = "stop-host-key-1"): FactoryPhysicalStopReceipt {
    const unsigned: FactoryUnsignedPhysicalStopReceipt = {
      schemaVersion: "factory.physical-stop.v1", attemptId: request.attemptId, reservationId: request.reservationId,
      workerId: request.workerId, holderGeneration: request.holderGeneration, allocationGeneration: request.allocationGeneration,
      processGroupAbsent: true, stoppedAtMs: now, reason: request.reason, hostId: request.hostId, ...overrides,
    };
    const signature = signFactoryPhysicalStopReceipt(unsigned, keyId, key);
    return Object.freeze({ ...unsigned, ...signature, receiptDigest: `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}` });
  }

  /** A trusted pool that settles exactly the generations and host it is shown. */
  function acknowledger(overrides: Partial<PoolLeaseStatus> = {}, onCall?: () => void): FactoryPoolStopAcknowledger {
    return {
      async confirmStopped(input) {
        onCall?.();
        return { reservationId: input.reservationId, tenantId, state: "settled", allocationGeneration: 1, holderGeneration: input.holderGeneration, effects: 0, resources: { cpu: 1 }, hostId: input.hostId, ...overrides } satisfies PoolLeaseStatus;
      },
    };
  }

  function stopper(sign: (request: FactoryTaskStopRequest) => Promise<FactoryPhysicalStopReceipt>, calls?: { count: number }): FactoryPhysicalStopper {
    return { async stop(request) { if (calls) calls.count++; return sign(request); } };
  }

  interface StopHarness {
    readonly stops: FactoryTaskStops;
    readonly settlements: FactoryUsageSettlements;
    readonly journal: FactoryExecutionJournal;
  }

  function harness(attempt: Attempt, physical: FactoryPhysicalStopper, pool: FactoryPoolStopAcknowledger, keys: readonly FactoryStopHostKey[] = [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }], timeoutMs = 20_000): StopHarness {
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const settlements = new FactoryUsageSettlements(fixture.db, tenantId, inbox, () => now);
    const outcomes = new FactoryTaskOutcomes(fixture.db, attempt.authority, attempt.admissions, attempt.journal, attempt.queue, lifecycle.budgets, inbox, () => now);
    const stops = new FactoryTaskStops(fixture.db, attempt.authority, attempt.admissions, attempt.journal, outcomes, attempt.queue, lifecycle.budgets, inbox, settlements, physical, pool, keys, () => now, timeoutMs);
    return { stops, settlements, journal: attempt.journal };
  }

  interface Attempt {
    readonly run: { runId: string; revision: number };
    readonly identity: { tenantId: string; projectId: string; logicalRunId: string; interpreterId: string };
    readonly transitions: FactoryTransitionArtifacts;
    readonly activities: ReturnType<typeof createFactoryArtifactActivities>;
    readonly compiled: Awaited<ReturnType<FactoryDefinitions["readVersion"]>>["compiled"];
    readonly authority: FactoryCommandAuthority;
    readonly admissions: FactoryComputeAdmissions;
    readonly journal: FactoryExecutionJournal;
    readonly queue: FactoryAttemptQueue;
    readonly launches: FactoryDatabaseAttemptLaunchStore;
    readonly reservationId: string;
    readonly attemptId: string;
    readonly request: FactoryRunnerRequest;
    readonly dispatchReference: { tenantId: string; projectId: string; logicalRunId: string; interpreterId: string; commandId: string };
    readonly state: ReturnType<typeof advanceKernel>;
    readonly lease: FactoryAttemptLease;
  }

  /** Drives one run to a live, launched attempt through the real kernel and stores. */
  async function launchedAttempt(): Promise<Attempt> {
    const started = await lifecycle.start(principal, key, body, 0, `stop-start-${++sequence}`);
    const run = { runId: started.run.runId, revision: started.run.revision };
    const identity = { tenantId, projectId, logicalRunId: run.runId, interpreterId: "root" };
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const { compiled } = await definitions.readVersion(principal, key, body.factoryVersion);
    const input = Object.fromEntries(Object.entries(body.parameters).map(([name, value]) => [name, value.kind === "inline" ? value.value : null])) as JsonValue;
    const { fence } = await fixture.db.transaction(transaction => lifecycle.readExecutionPlanInTransaction(transaction, runKey(run.runId)));
    const created = createKernelState(compiled, run.runId, input, now, { schemaVersion: FACTORY_LAZY_INPUT_SCHEMA_VERSION, parameters: body.parameters });
    const event = { kind: "start", id: `stop-start-event-${sequence}`, atMs: now } as const;
    const first = advanceKernel(compiled, { ...created, runDeadlineAtMs: Math.min(created.runDeadlineAtMs, fence.deadlineAtMs) }, event);
    const admissionCommand = first.commands.find(command => command.kind === "request-admission")!;
    const authority = new FactoryCommandAuthority(fixture.db, tenantId, lifecycle, transitions, ["orchestration"], () => now);
    await persistTransition(identity, 1, event, first.nextState, first.commands, undefined, activities);
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const unavailable = async (): Promise<never> => { throw new Error("This fixture admits product facts without a remote pool."); };
    const reference = { ...identity, commandId: admissionCommand.id };
    const requestPool = { request: unavailable, status: unavailable, cancel: unavailable, acknowledgeStart: unavailable, renew: unavailable, confirmStopped: unavailable } satisfies PoolAdmissionClient;
    const reserved = await new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, { cpu: profile }, new FactoryComputeAdmissions(fixture.db, tenantId, authority, lifecycle.budgets, inbox, requestPool, () => now), () => now).request(service, reference);
    await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId));
    const queued = (await new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now, "pool").inspect(reserved.outboxCommandId))!;
    const requested = queued.command.body as { request: { resources: Record<string, number> } };
    const poolLease = { reservationId: reserved.reservationId, tenantId, grantRevision: body.grantRevision, allocationGeneration: 1, holderGeneration: 1, allocationToken: "stop-allocation", fence: "stop-fence", deadlineAt: new Date(now + 60_000), resources: requested.request.resources, hostId };
    const admissions = new FactoryComputeAdmissions(fixture.db, tenantId, authority, lifecycle.budgets, inbox, { ...requestPool, async request() { return { status: "admitted" as const, reservationId: reserved.reservationId, lease: poolLease }; }, async status() { return undefined; } }, () => now);
    const admitted = await admissions.recover(service, { projectId, runId: run.runId, reservationId: reserved.reservationId });
    if (admitted.status !== "admitted") throw new Error("fixture compute admission failed");
    // A dispatch-node admission always carries its kernel event; a validator
    // origin is the only shape that does not, and this fixture has none.
    if (!admitted.receipt.event) throw new Error("fixture compute admission produced no admission-result event");
    const next = advanceKernel(compiled, first.nextState, admitted.receipt.event);
    const dispatch = next.commands.find(command => command.kind === "dispatch-node")!;
    await persistTransition(identity, 2, admitted.receipt.event, next.nextState, next.commands, undefined, activities);
    const dispatchReference = { ...identity, commandId: dispatch.id };
    const journal = new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction);
    const queue = new FactoryAttemptQueue(fixture.db, journal, tenantId, () => now);
    const taskNode = compiled.indexes.nodeById[dispatch.nodeId];
    if (taskNode?.kind !== "task") throw new Error("fixture dispatch task is missing");
    const policy = new FactoryNativeRunnerPolicy(tenantId, grants, [{ runner: taskNode.runner, resourceClass: "cpu", allocation: profile, allowedCapabilities: taskNode.capabilities ?? [], tools: [] }], "factory-broker");
    const execution = await new FactoryTaskExecutionAdmission(authority, admissions, journal, queue, policy, () => now).admit(service, dispatchReference);
    const request = { ...execution.request, broker: { ...execution.request.broker, attemptToken: "stop-fixture-token" } } as FactoryRunnerRequest;
    const lease: FactoryAttemptLease = { reservationId: reserved.reservationId, grantRevision: body.grantRevision, allocationGeneration: 1, holderGeneration: 1, allocationToken: "stop-allocation", hostId };
    const launches = new FactoryDatabaseAttemptLaunchStore(fixture.db);
    const preparedPackage = { projectId, reference: request.runner, trustRevision: 1, packageTrustDigest: `sha256:${"a".repeat(64)}`, releaseDigest: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"a".repeat(64)}`, artifactDigest: "b".repeat(64), imageDigest: `sha256:${"a".repeat(64)}`, manifestDigest: `sha256:${"a".repeat(64)}`, evidenceDigest: `sha256:${"a".repeat(64)}`, buildIdentity: "stop-build", receiptDigest: `sha256:${"a".repeat(64)}` };
    await launches.prepare(request, lease, preparedPackage);
    await launches.state(request.authority.attemptId, "launched");
    return { run, identity, transitions, activities, compiled, authority, admissions, journal, queue, launches, reservationId: reserved.reservationId, attemptId: request.authority.attemptId, request, dispatchReference, state: next, lease };
  }

  /** Cancels the run and commits the transition that carries the live `cancel-node` command. */
  async function cancelled(attempt: Attempt): Promise<{ reference: typeof attempt.dispatchReference; advanced: ReturnType<typeof advanceKernel> }> {
    await lifecycle.cancel(principal, runKey(attempt.run.runId), attempt.run.revision, `stop-cancel-${attempt.run.runId}`);
    const stored = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${attempt.run.runId} AND payload::jsonb->>'kind'='cancel'`));
    const event = JSON.parse(stored[0]!.payload) as KernelEvent;
    const advanced = advanceKernel(attempt.compiled, attempt.state.nextState, event);
    const cancelCommand = advanced.commands.find(command => command.kind === "cancel-node");
    if (!cancelCommand) throw new Error("fixture cancellation produced no cancel-node command");
    await persistTransition(attempt.identity, 3, event, advanced.nextState, advanced.commands, undefined, attempt.activities);
    return { reference: { ...attempt.identity, commandId: cancelCommand.id }, advanced };
  }

  /** The sealed attempt authority as the durable execution row holds it. */
  async function sealedAuthority(attempt: Attempt) {
    const authority = await fixture.db.transaction(transaction => attempt.journal.readAuthorityInTransaction(transaction, { tenantId, projectId, runId: attempt.run.runId, attemptId: attempt.attemptId }));
    if (!authority) throw new Error("fixture attempt authority is missing");
    return authority;
  }

  /** One prepared and dispatched journal operation, ready to settle or reconcile. */
  async function dispatchedOperation(attempt: Attempt) {
    const authority = await sealedAuthority(attempt);
    const operation = { operationId: `${attempt.run.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:0`, operationIndex: 0, kind: "model" as const, requestDigest: "a".repeat(64) };
    await attempt.journal.prepare(authority, operation);
    await attempt.journal.dispatch(authority, operation.operationId);
    return { authority, operation };
  }

  /**
   * Records a non-success outcome whose settled journal evidence really sums to
   * its terminal usage, then commits the transition that cancels the node.
   */
  async function failedOutcome(attempt: Attempt, mode: "measured" | "held"): Promise<{ reference: typeof attempt.dispatchReference }> {
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const outcomes = new FactoryTaskOutcomes(fixture.db, attempt.authority, attempt.admissions, attempt.journal, attempt.queue, lifecycle.budgets, inbox, () => now);
    let result: FactoryRunnerResult;
    if (mode === "measured") {
      const { authority, operation } = await dispatchedOperation(attempt);
      const checkpoint = { artifactId: `stop-checkpoint-${attempt.run.runId}`, digest: `sha256:${"b".repeat(64)}`, encodedBytes: 1, journalCursor: 0 };
      const usage = { kind: "measured" as const, inputTokens: 1, outputTokens: 2, computeMs: 3, costMicros: "4" };
      await attempt.journal.settle(authority, operation.operationId, "completed", { result: { done: true }, resultDigest: "d".repeat(64), usage, workspaceCheckpoint: checkpoint });
      result = { schemaVersion: "factory.runner.result.v1", status: "failed", resultDigest: "c".repeat(64), error: { code: "RUNNER_FAILED", message: "runner failed", retryable: false }, journalCursor: 0, operations: [{ ...operation, state: "completed", resultDigest: "d".repeat(64), usage, workspaceCheckpoint: checkpoint }], usage };
    } else {
      // A provider whose cost is not yet known reports an uncertain terminal,
      // which is the shape that carries a held cost and no settled operation.
      result = { schemaVersion: "factory.runner.result.v1", status: "uncertain", journalCursor: -1, operations: [], providerReceiptDigest: "e".repeat(64), usage: { kind: "unknown", reason: "provider receipt pending", heldCostMicros: "900" } };
    }
    const receipt = await fixture.db.transaction(transaction => outcomes.recordInTransaction(transaction, service, attempt.dispatchReference, result));
    const advanced = advanceKernel(attempt.compiled, attempt.state.nextState, receipt.event);
    const cancelCommand = advanced.commands.find(command => command.kind === "cancel-node");
    if (!cancelCommand) throw new Error("fixture outcome produced no cancel-node command");
    await persistTransition(attempt.identity, 3, receipt.event, advanced.nextState, advanced.commands, undefined, attempt.activities);
    return { reference: { ...attempt.identity, commandId: cancelCommand.id } };
  }

  const reservationState = async (reservationId: string) => rows<{ state: string; actual: string | null }>(await fixture.db.execute(sql`SELECT state,actual FROM factory_budget_reservations WHERE reservation_id=${reservationId}`))[0];
  const executionStatus = async (attemptId: string) => rows<{ status: string }>(await fixture.db.execute(sql`SELECT status FROM factory_executions WHERE attempt_id=${attemptId}`))[0]?.status;
  const inboxKinds = async (runId: string) => rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${runId} ORDER BY sequence`)).map(row => (JSON.parse(row.payload) as KernelEvent).kind);
  const stopRow = async (runId: string) => rows<{ state: string; source: string; attempt_command_id: string | null }>(await fixture.db.execute(sql`SELECT state,source,attempt_command_id FROM factory_task_stops WHERE run_id=${runId}`))[0];

  beforeAll(async () => {
    fixture = await create();
    const records = new FactoryRecords(fixture.db, tenantId);
    await records.bindInstallation();
    await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Stop settlement','/tmp/factory-stop')`);
    await records.bindProject(projectId);
    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${principal.id},'stop@example.test','not-a-login','Stop owner','admin')`);
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('stop-membership',${projectId},${principal.id},'owner')`);
    grants = new FactoryGrants(fixture.db, tenantId, () => now);
    for (const action of ["factory.author", "factory.publish", "factory.run", "factory.operate", "factory.approve", "factory.trust", "factory.release"] as const) await grants.set(principal, { principal, projectId, action, expectedRevision: 0, expiresAtMs: null });
    objectStore = fixture.blobs ?? memoryBlobs;
    definitions = new FactoryDefinitions(fixture.db, tenantId, grants, objectStore);
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: key.factoryId };
    await definitions.save(principal, key, 0, "stop-definition-create", source);
    const version = await definitions.publish(principal, key, 1, "stop-definition-publish");
    body = { factoryVersion: version.version, definitionDigest: version.definitionDigest, grantRevision: 1, parameters: Object.fromEntries(Object.entries(source.inputPorts).map(([name, schema]) => [name, { kind: "inline" as const, value: schema.type === "object" ? {} : "stop value" }])) };
    lifecycle = new FactoryRunLifecycle(fixture.db, tenantId, { definitions, grants, interpreterBuild: "kernel-build-immutable", interpreterCompatibility: source.interpreterCompatibility, limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 },
      async stageDefinitionInTransaction(transaction, compiled, identity) { return new FactoryDefinitionArtifacts(new FactoryArtifacts(fixture.db, objectStore, tenantId)).stageDefinitionInTransaction(transaction, compiled, identity); },
      async resolveParameters(_transaction, _principal, _key, parameters) { return Object.fromEntries(Object.entries(parameters).map(([name, value]) => { if (value.kind !== "inline") throw new Error("fixture has no artifact input"); return [name, value.value]; })) as JsonValue; } }, () => now);
  });
  afterAll(async () => { await fixture?.close(); });

  test("stops a still-running attempt from its sealed launch, with no outcome to fabricate", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    expect(rows(await fixture.db.execute(sql`SELECT command_id FROM factory_task_outcomes WHERE run_id=${attempt.run.runId}`))).toEqual([]);
    const calls = { count: 0 };
    const { stops } = harness(attempt, stopper(async request => signed(request), calls), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.state).toBe("stopped");
    expect(receipt.event).toMatchObject({ kind: "attempt-stopped", commandId: attempt.attemptId, uncertain: true });
    expect(receipt.stopReceipt).toMatchObject({ processGroupAbsent: true, hostId, reason: "cancelled", workerId: receipt.stopReceipt!.workerId });
    expect(await stopRow(attempt.run.runId)).toEqual({ state: "stopped", source: "sealed-launch", attempt_command_id: null });
    expect(await executionStatus(attempt.attemptId)).toBe("stopped");
    // No terminal result exists, so the hold is retained rather than settled.
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain", actual: null });
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "cancel", "attempt-stopped"]);
    // A replay is the same sealed fact and never calls the host twice.
    expect(await stops.stop(service, reference)).toEqual(receipt);
    expect(calls.count).toBe(1);
  });

  test("settles a measured cost once and emits one usage-settled event", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await failedOutcome(attempt, "measured");
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.state).toBe("stopped");
    expect(receipt.event.uncertain).toBeUndefined();
    expect(await stopRow(attempt.run.runId)).toMatchObject({ state: "stopped", source: "terminal-outcome", attempt_command_id: attempt.dispatchReference.commandId });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    const settlement = await fixture.db.transaction(transaction => settlements.readLatestInTransaction(transaction, { projectId, runId: attempt.run.runId, reservationId: attempt.reservationId }));
    expect(settlement).toMatchObject({ revision: 1, source: "stop", knownCostMicros: "4", attemptId: attempt.attemptId });
    expect(settlement!.unknownCostMicros).toBeUndefined();
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "node-failed", "usage-settled", "attempt-stopped"]);
    expect(await stops.stop(service, reference)).toEqual(receipt);
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "node-failed", "usage-settled", "attempt-stopped"]);
  });

  test("keeps an unknown provider cost visible instead of settling it as zero", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await failedOutcome(attempt, "held");
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.event.uncertain).toBe(true);
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain", actual: null });
    const settlement = await fixture.db.transaction(transaction => settlements.readLatestInTransaction(transaction, { projectId, runId: attempt.run.runId, reservationId: attempt.reservationId }));
    expect(settlement).toMatchObject({ revision: 1, source: "stop", knownCostMicros: "0", unknownCostMicros: "900" });
  });

  test("a bounded stop timeout leaves durable uncertainty and a later receipt settles the same operation", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    let request: FactoryTaskStopRequest | undefined;
    const slow = { async stop(value: FactoryTaskStopRequest, signal: AbortSignal) { request = value; return new Promise<FactoryPhysicalStopReceipt>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host stop aborted"))); }); } };
    let acknowledgements = 0;
    const { stops } = harness(attempt, slow, acknowledger({}, () => { acknowledgements++; }), undefined, 5);
    const uncertain = await stops.stop(service, reference);
    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.event).toMatchObject({ kind: "attempt-stopped", uncertain: true });
    expect(uncertain.stopReceipt).toBeUndefined();
    // The hold and the allocation are retained; the pool was never told to release.
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain" });
    expect(acknowledgements).toBe(0);
    expect(await executionStatus(attempt.attemptId)).toBe("cancel_accepted");
    expect(await stopRow(attempt.run.runId)).toMatchObject({ state: "uncertain" });
    const late = harness(attempt, stopper(async value => signed(value)), acknowledger({}, () => { acknowledgements++; }));
    const settled = await late.stops.confirm(service, reference, signed(request!));
    expect(settled.state).toBe("stopped");
    expect(acknowledgements).toBe(1);
    expect(await executionStatus(attempt.attemptId)).toBe("stopped");
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "cancel", "attempt-stopped", "attempt-stopped"]);
    expect(await late.stops.confirm(service, reference, signed(request!))).toEqual(settled);
  });

  test("only a configured supervisor key can assert a stop, and the pool must agree first", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const rejected = harness(attempt, stopper(async request => signed(request, {}, foreignKeys.privateKey)), acknowledger());
    expect((await rejected.stops.stop(service, reference)).state).toBe("uncertain");
    const unknownKey = harness(attempt, stopper(async request => signed(request, {}, hostKeys.privateKey, "unconfigured-key")), acknowledger());
    expect((await unknownKey.stops.stop(service, reference)).state).toBe("uncertain");
    const forged = harness(attempt, stopper(async request => signed(request, { processGroupAbsent: false as never })), acknowledger());
    expect((await forged.stops.stop(service, reference)).state).toBe("uncertain");
    const mismatched = harness(attempt, stopper(async request => signed(request)), acknowledger({ state: "running" }));
    expect((await mismatched.stops.stop(service, reference)).state).toBe("uncertain");
    const staleGeneration = harness(attempt, stopper(async request => signed(request)), acknowledger({ allocationGeneration: 9 }));
    expect((await staleGeneration.stops.stop(service, reference)).state).toBe("uncertain");
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain" });
    expect(await executionStatus(attempt.attemptId)).toBe("cancel_accepted");
    const accepted = harness(attempt, stopper(async request => signed(request)), acknowledger());
    expect((await accepted.stops.stop(service, reference)).state).toBe("stopped");
  });

  test("a rotated host key signs new stops while the retired key is refused", async () => {
    const first = await launchedAttempt();
    const firstReference = (await cancelled(first)).reference;
    const rotated: readonly FactoryStopHostKey[] = [{ hostId, hostKeyId: "stop-host-key-2", publicKey: rotatedKeys.publicKey }];
    // The retired key cannot assert a stop once it leaves the configured map.
    const retired = harness(first, stopper(async request => signed(request)), acknowledger(), rotated);
    expect((await retired.stops.stop(service, firstReference)).state).toBe("uncertain");
    const current = harness(first, stopper(async request => signed(request, {}, rotatedKeys.privateKey, "stop-host-key-2")), acknowledger(), rotated);
    expect((await current.stops.stop(service, firstReference)).state).toBe("stopped");
    // While both keys are configured, a receipt from either is admissible.
    const second = await launchedAttempt();
    const secondReference = (await cancelled(second)).reference;
    const both = harness(second, stopper(async request => signed(request)), acknowledger(), [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }, ...rotated]);
    expect((await both.stops.stop(service, secondReference)).state).toBe("stopped");
  });

  test("rejects malformed host key material and an empty key set", () => {
    const attempt = { authority: undefined } as never;
    expect(() => harness(attempt, stopper(async request => signed(request)), acknowledger(), [])).toThrow();
    expect(() => harness(attempt, stopper(async request => signed(request)), acknowledger(), [{ hostId, hostKeyId: "bad", publicKey: "not a key" }])).toThrow();
  });

  test("reconciles a trusted later receipt into one idempotent settlement", async () => {
    const attempt = await launchedAttempt();
    // A lost provider response leaves the operation dispatched, which is the
    // only state a later receipt may reconcile, so the live stop path is the
    // one that reaches reconciliation.
    const { operation } = await dispatchedOperation(attempt);
    const { reference } = await cancelled(attempt);
    const held = harness(attempt, stopper(async request => signed(request)), acknowledger());
    expect((await held.stops.stop(service, reference)).state).toBe("stopped");
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain" });
    const providerReceiptDigest = `sha256:${"d".repeat(64)}`;
    const usage = { kind: "measured" as const, inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" };
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements);
    const settled = await reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage });
    expect(settled).toMatchObject({ revision: 1, source: "reconciliation", knownCostMicros: "5", providerReceiptDigest });
    expect(settled.unknownCostMicros).toBeUndefined();
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    const replay = await reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage });
    expect(replay).toEqual(settled);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(1);
    await expect(reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: "another-attempt", operationId: operation.operationId, providerReceiptDigest, usage })).rejects.toMatchObject({ code: "factory_usage_settlement_conflict" });
    await expect(reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage: { ...usage, costMicros: "1" } })).rejects.toMatchObject({ code: "factory_usage_settlement_conflict" });
    await expect(reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest: "unverified", usage })).rejects.toMatchObject({ code: "factory_usage_settlement_receipt_invalid" });
    await expect(reconciler.reconcile({ reservationId: "missing-reservation", attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage })).rejects.toMatchObject({ code: "factory_usage_settlement_not_found" });
  });

  test("a listed hold resolves to the sealed facts reconciliation needs, or stays unknown", async () => {
    const attempt = await launchedAttempt();
    const { operation } = await dispatchedOperation(attempt);
    // A second operation that settles with its own receipt before the run is
    // cancelled. It is not this hold's evidence and must never be borrowed.
    const authority = await sealedAuthority(attempt);
    const second = { operationId: `${attempt.run.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:1`, operationIndex: 1, kind: "model" as const, requestDigest: "a".repeat(64) };
    await attempt.journal.prepare(authority, second);
    await attempt.journal.dispatch(authority, second.operationId);
    await attempt.journal.settle(authority, second.operationId, "failed", { resultDigest: "f".repeat(64), providerReceiptDigest: `sha256:${"9".repeat(64)}`, usage: { kind: "measured", inputTokens: 9, outputTokens: 9, computeMs: 9, costMicros: "99" } });

    const { reference } = await cancelled(attempt);
    const held = harness(attempt, stopper(async request => signed(request)), acknowledger());
    expect((await held.stops.stop(service, reference)).state).toBe("stopped");
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements);
    const holds = await fixture.db.transaction(transaction => lifecycle.budgets.listUncertainWithCostInTransaction(transaction));
    const hold = holds.find(entry => entry.reservationId === attempt.reservationId)!;
    expect(hold).toBeDefined();

    // No receipt has landed on the operation that caused the hold, so the hold
    // stays held rather than settling as zero, and the settled operation's own
    // receipt is not borrowed for it.
    expect(await reconciler.resolve(hold)).toEqual({ kind: "unknown", reservationId: attempt.reservationId, reason: "no-operation-receipt" });

    // The operation that caused the hold now carries a receipt but no measured
    // usage, which is still unknown, not zero.
    const providerReceiptDigest = `sha256:${"7".repeat(64)}`;
    await fixture.db.execute(sql`UPDATE factory_execution_operations SET state='uncertain', provider_receipt_digest=${providerReceiptDigest}, usage_json=${JSON.stringify({ kind: "unknown", reason: "provider receipt pending", heldCostMicros: "900" })}::jsonb WHERE attempt_id=${attempt.attemptId} AND operation_id=${operation.operationId}`);
    expect(await reconciler.resolve(hold)).toEqual({ kind: "unknown", reservationId: attempt.reservationId, reason: "usage-still-unknown" });

    // A tampered digest is refused rather than handed on to the reconciler.
    await fixture.db.execute(sql`UPDATE factory_execution_operations SET usage_json=${JSON.stringify({ kind: "measured", inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" })}::jsonb, provider_receipt_digest='not-a-digest' WHERE attempt_id=${attempt.attemptId} AND operation_id=${operation.operationId}`);
    await expect(reconciler.resolve(hold)).rejects.toMatchObject({ code: "factory_usage_settlement_receipt_invalid" });
    // A tampered usage is corrupt, never rounded to something usable.
    await fixture.db.execute(sql`UPDATE factory_execution_operations SET usage_json=${JSON.stringify({ kind: "measured", inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "-5" })}::jsonb, provider_receipt_digest=${providerReceiptDigest} WHERE attempt_id=${attempt.attemptId} AND operation_id=${operation.operationId}`);
    await expect(reconciler.resolve(hold)).rejects.toMatchObject({ code: "factory_usage_settlement_corrupt" });

    // With the sealed facts present, the hold resolves to exactly the four the
    // reconciler needs, and resolving twice gives the same answer.
    await fixture.db.execute(sql`UPDATE factory_execution_operations SET usage_json=${JSON.stringify({ kind: "measured", inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" })}::jsonb WHERE attempt_id=${attempt.attemptId} AND operation_id=${operation.operationId}`);
    const resolved = await reconciler.resolve(hold);
    expect(resolved).toEqual({ kind: "resolved", reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage: { kind: "measured", inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" } });
    expect(await reconciler.resolve(hold)).toEqual(resolved);

    // Those facts settle the hold exactly once, and the hold leaves the list.
    if (resolved.kind !== "resolved") throw new Error("expected resolved facts");
    const settled = await reconciler.reconcile({ reservationId: resolved.reservationId, attemptId: resolved.attemptId, operationId: resolved.operationId, providerReceiptDigest: resolved.providerReceiptDigest, usage: resolved.usage });
    expect(settled).toMatchObject({ source: "reconciliation", knownCostMicros: "5", providerReceiptDigest });
    expect(await reconciler.reconcile({ reservationId: resolved.reservationId, attemptId: resolved.attemptId, operationId: resolved.operationId, providerReceiptDigest: resolved.providerReceiptDigest, usage: resolved.usage })).toEqual(settled);
    expect(rows(await fixture.db.execute(sql`SELECT revision FROM factory_usage_settlements WHERE run_id=${attempt.run.runId} AND reservation_id=${attempt.reservationId}`))).toHaveLength(1);
    const remaining = await fixture.db.transaction(transaction => lifecycle.budgets.listUncertainWithCostInTransaction(transaction));
    expect(remaining.map(entry => entry.reservationId)).not.toContain(attempt.reservationId);

    // A hold naming a different run than its sealed stop funds nothing.
    await expect(reconciler.resolve({ ...hold, runId: "other-run" })).rejects.toMatchObject({ code: "factory_usage_settlement_conflict" });
    // A hold with no sealed stop at all is unknown, not an error.
    expect(await reconciler.resolve({ ...hold, reservationId: "reservation-without-a-stop" })).toEqual({ kind: "unknown", reservationId: "reservation-without-a-stop", reason: "no-sealed-attempt" });
  });

  test("a corrupt sealed stop is refused rather than replayed", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const { stops } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    await stops.stop(service, reference);
    for (const mutation of [
      sql`UPDATE factory_task_stops SET request_digest=${`sha256:${"0".repeat(64)}`} WHERE run_id=${attempt.run.runId}`,
      sql`UPDATE factory_task_stops SET source='terminal-outcome' WHERE run_id=${attempt.run.runId}`,
      sql`UPDATE factory_task_stops SET stopped_event_digest=${`sha256:${"0".repeat(64)}`} WHERE run_id=${attempt.run.runId}`,
      sql`UPDATE factory_task_stops SET accepted_at_ms=-1 WHERE run_id=${attempt.run.runId}`,
    ]) {
      const before = rows<Record<string, unknown>>(await fixture.db.execute(sql`SELECT * FROM factory_task_stops WHERE run_id=${attempt.run.runId}`))[0]!;
      const applied = await fixture.db.execute(mutation).then(() => true, () => false);
      if (!applied) continue;
      await expect(stops.stop(service, reference)).rejects.toBeInstanceOf(FactoryTaskStopError);
      await fixture.db.execute(sql`UPDATE factory_task_stops SET request_digest=${before.request_digest as string},source=${before.source as string},stopped_event_digest=${before.stopped_event_digest as string},accepted_at_ms=${Number(before.accepted_at_ms)} WHERE run_id=${attempt.run.runId}`);
    }
    expect((await stops.stop(service, reference)).state).toBe("stopped");
  });

  test("refuses a stop outside its tenant, its service, or its sealed generations", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const { stops } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    await expect(stops.stop({ ...service, subject: "foreign" }, reference)).rejects.toBeInstanceOf(Error);
    await expect(stops.stop(service, { ...reference, tenantId: "foreign-tenant" })).rejects.toMatchObject({ code: "factory_task_stop_scope" });
    await expect(stops.confirm(service, { ...reference, commandId: "missing-command" }, signed({ ...attempt, cancelReference: reference, attemptId: attempt.attemptId, reservationId: attempt.reservationId, workerId: "w", holderGeneration: 1, allocationGeneration: 1, hostId, reason: "cancelled", source: "sealed-launch" } as FactoryTaskStopRequest))).rejects.toMatchObject({ code: "factory_task_stop_not_found" });
    const wrongGeneration = harness(attempt, stopper(async request => signed(request, { holderGeneration: 7 })), acknowledger());
    expect((await wrongGeneration.stops.stop(service, reference)).state).toBe("uncertain");
    expect((await stops.stop(service, reference)).state).toBe("stopped");
  });

  test("one signed receipt settles one attempt and cannot be replayed onto another", async () => {
    const first = await launchedAttempt();
    const firstReference = (await cancelled(first)).reference;
    const firstHarness = harness(first, stopper(async request => signed(request)), acknowledger());
    const settled = await firstHarness.stops.stop(service, firstReference);
    const second = await launchedAttempt();
    const secondReference = (await cancelled(second)).reference;
    // The first attempt's signed receipt names another attempt, so presenting
    // it here leaves durable uncertainty rather than a second settlement.
    const replayed = harness(second, stopper(async () => settled.stopReceipt!), acknowledger());
    expect((await replayed.stops.stop(service, secondReference)).state).toBe("uncertain");
    await expect(replayed.stops.confirm(service, secondReference, settled.stopReceipt!)).rejects.toMatchObject({ code: "factory_task_stop_proof_invalid" });
    const secondHarness = harness(second, stopper(async request => signed(request)), acknowledger());
    expect((await secondHarness.stops.stop(service, secondReference)).state).toBe("stopped");
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_task_stops WHERE stop_receipt_digest=${settled.stopReceipt!.receiptDigest}`))).toEqual([{ attempt_id: first.attemptId }]);
  });

  test("a pool acknowledgement that outlives a failed product transaction settles once on retry", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await failedOutcome(attempt, "measured");
    let acknowledgements = 0;
    const base = harness(attempt, stopper(async request => signed(request)), acknowledger({}, () => { acknowledgements++; }));
    // The pool releases capacity, then the product transaction fails. Nothing
    // durable may be left behind, and the retry must not settle twice.
    let failures = 1;
    const brittle = Object.create(base.settlements, { recordInTransaction: { value: async (...args: Parameters<FactoryUsageSettlements["recordInTransaction"]>) => {
      if (failures-- > 0) throw new Error("product settlement transaction lost");
      return base.settlements.recordInTransaction(...args);
    } } }) as FactoryUsageSettlements;
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const outcomes = new FactoryTaskOutcomes(fixture.db, attempt.authority, attempt.admissions, attempt.journal, attempt.queue, lifecycle.budgets, inbox, () => now);
    const interrupted = new FactoryTaskStops(fixture.db, attempt.authority, attempt.admissions, attempt.journal, outcomes, attempt.queue, lifecycle.budgets, inbox, brittle, stopper(async request => signed(request)), acknowledger({}, () => { acknowledgements++; }), [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }], () => now, 20_000);
    // The pool has released, but nothing the product owns may be settled: the
    // stop degrades to durable uncertainty and keeps its hold.
    expect((await interrupted.stop(service, reference)).state).toBe("uncertain");
    expect(acknowledgements).toBe(1);
    expect(await stopRow(attempt.run.runId)).toMatchObject({ state: "uncertain" });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain", actual: null });
    expect(await executionStatus(attempt.attemptId)).toBe("cancel_accepted");
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(0);
    const settled = await base.stops.stop(service, reference);
    expect(settled.state).toBe("stopped");
    expect(acknowledgements).toBe(2);
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    // One uncertain event and one stopped event, and exactly one settlement.
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "attempt-stopped")).toHaveLength(2);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(1);
    expect(rows(await fixture.db.execute(sql`SELECT revision FROM factory_usage_settlements WHERE run_id=${attempt.run.runId}`))).toHaveLength(1);
  });

  test("cancelling during admission claims no capacity and leaves no stop to settle", async () => {
    // The run is cancelled while the compute request is still queued, so no
    // attempt was ever dispatched and there is nothing physical to stop.
    const started = await lifecycle.start(principal, key, body, 0, `admitting-start-${++sequence}`);
    const run = { runId: started.run.runId, revision: started.run.revision };
    const identity = { tenantId, projectId, logicalRunId: run.runId, interpreterId: "root" };
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const { compiled } = await definitions.readVersion(principal, key, body.factoryVersion);
    const input = Object.fromEntries(Object.entries(body.parameters).map(([name, value]) => [name, value.kind === "inline" ? value.value : null])) as JsonValue;
    const { fence } = await fixture.db.transaction(transaction => lifecycle.readExecutionPlanInTransaction(transaction, runKey(run.runId)));
    const created = createKernelState(compiled, run.runId, input, now, { schemaVersion: FACTORY_LAZY_INPUT_SCHEMA_VERSION, parameters: body.parameters });
    const event = { kind: "start", id: `admitting-start-event-${sequence}`, atMs: now } as const;
    const first = advanceKernel(compiled, { ...created, runDeadlineAtMs: Math.min(created.runDeadlineAtMs, fence.deadlineAtMs) }, event);
    const admissionCommand = first.commands.find(command => command.kind === "request-admission")!;
    const authority = new FactoryCommandAuthority(fixture.db, tenantId, lifecycle, transitions, ["orchestration"], () => now);
    await persistTransition(identity, 1, event, first.nextState, first.commands, undefined, activities);
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const unavailable = async (): Promise<never> => { throw new Error("A cancelled admission never reaches the pool."); };
    const requestPool = { request: unavailable, status: unavailable, cancel: unavailable, acknowledgeStart: unavailable, renew: unavailable, confirmStopped: unavailable } satisfies PoolAdmissionClient;
    const admissions = new FactoryComputeAdmissions(fixture.db, tenantId, authority, lifecycle.budgets, inbox, requestPool, () => now);
    const reserved = await new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, { cpu: profile }, admissions, () => now).request(service, { ...identity, commandId: admissionCommand.id });
    expect(await reservationState(reserved.reservationId)).toMatchObject({ state: "held" });

    await lifecycle.cancel(principal, runKey(run.runId), run.revision, `admitting-cancel-${run.runId}`);
    const stored = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${run.runId} AND payload::jsonb->>'kind'='cancel'`));
    const cancelEvent = JSON.parse(stored[0]!.payload) as KernelEvent;
    const advanced = advanceKernel(compiled, first.nextState, cancelEvent);
    // The kernel does ask to cancel the node, and its `attemptCommandId` is the
    // admission command, because no dispatch command was ever issued.
    const cancelCommand = advanced.commands.find(command => command.kind === "cancel-node");
    expect(cancelCommand).toMatchObject({ attemptCommandId: admissionCommand.id });
    await persistTransition(identity, 2, cancelEvent, advanced.nextState, advanced.commands, undefined, activities);

    // The physical stop refuses it: there is no sealed launch, so there is no
    // holder to fence and nothing to sign. It never fabricates a stop fact.
    const stopped = new FactoryTaskStops(fixture.db, authority, admissions, new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction), new FactoryTaskOutcomes(fixture.db, authority, admissions, new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction), new FactoryAttemptQueue(fixture.db, new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction), tenantId, () => now), lifecycle.budgets, inbox, () => now), new FactoryAttemptQueue(fixture.db, new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction), tenantId, () => now), lifecycle.budgets, inbox, new FactoryUsageSettlements(fixture.db, tenantId, inbox, () => now), stopper(async () => { throw new Error("an unadmitted attempt has no host to stop"); }), acknowledger({}, () => { throw new Error("an unadmitted attempt never released capacity"); }), [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }], () => now, 20_000);
    await expect(stopped.stop(service, { ...identity, commandId: cancelCommand!.id })).rejects.toMatchObject({ code: "factory_task_stop_stale" });
    expect(rows(await fixture.db.execute(sql`SELECT cancel_command_id FROM factory_task_stops WHERE run_id=${run.runId}`))).toEqual([]);
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_attempt_launches WHERE run_id=${run.runId}`))).toEqual([]);
    // No capacity was ever claimed, and the unused hold is still the admission
    // path's to release: `factory_budget_reservations` never left `held`.
    expect(await reservationState(reserved.reservationId)).toMatchObject({ state: "held" });
  });

  test("lists exactly the accepted cancellations a stop worker must still drive", async () => {
    const list = (stops: FactoryTaskStops, options?: { limit?: number; after?: { acceptedAtMs: number; cancelCommandId: string } }) =>
      fixture.db.transaction(transaction => stops.listStoppableInTransaction(transaction, options));

    // An empty scan on a tenant with no accepted cancellation.
    const first = await launchedAttempt();
    const empty = harness(first, stopper(async request => signed(request)), acknowledger());
    expect(await list(empty.stops)).toEqual([]);

    // One accepted-but-unsettled stop appears, with the exact cancel reference
    // `stop` takes and the sealed identities beside it.
    const firstReference = (await cancelled(first)).reference;
    const uncertainHarness = harness(first, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, acknowledger(), undefined, 5);
    expect((await uncertainHarness.stops.stop(service, firstReference)).state).toBe("uncertain");
    const pending = await list(empty.stops);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ reference: firstReference, attemptId: first.attemptId, reservationId: first.reservationId, source: "sealed-launch", state: "uncertain" });
    expect(pending[0]!.cursor).toEqual({ acceptedAtMs: pending[0]!.acceptedAtMs, cancelCommandId: firstReference.commandId });

    // A second and third accepted cancellation page deterministically, and the
    // pages partition the work with no repeat and no gap.
    const second = await launchedAttempt();
    const secondReference = (await cancelled(second)).reference;
    const third = await launchedAttempt();
    const thirdReference = (await cancelled(third)).reference;
    for (const [attempt, reference] of [[second, secondReference], [third, thirdReference]] as const) {
      const accepting = harness(attempt, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, acknowledger(), undefined, 5);
      expect((await accepting.stops.stop(service, reference)).state).toBe("uncertain");
    }
    const all = await list(empty.stops);
    expect(all.map(entry => entry.reference.commandId)).toEqual([firstReference.commandId, secondReference.commandId, thirdReference.commandId].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
    // Oldest first: the acceptance clock never decreases across the page.
    expect(all.map(entry => entry.acceptedAtMs)).toEqual([...all.map(entry => entry.acceptedAtMs)].sort((left, right) => left - right));
    const pageOne = await list(empty.stops, { limit: 2 });
    expect(pageOne).toHaveLength(2);
    const pageTwo = await list(empty.stops, { limit: 2, after: pageOne[1]!.cursor });
    expect(pageTwo.map(entry => entry.reference.commandId)).toEqual(all.slice(2).map(entry => entry.reference.commandId));
    expect(await list(empty.stops, { limit: 2, after: all[all.length - 1]!.cursor })).toEqual([]);
    expect([...pageOne, ...pageTwo].map(entry => entry.reference.commandId)).toEqual(all.map(entry => entry.reference.commandId));

    // Concurrent scans take no locks and agree, so two workers see the same
    // work; only one of them can settle it.
    expect(await Promise.all([list(empty.stops), list(empty.stops)])).toEqual([all, all]);
    const settled = harness(third, stopper(async request => signed(request)), acknowledger());
    const racing = await Promise.allSettled([settled.stops.stop(service, thirdReference), settled.stops.stop(service, thirdReference)]);
    for (const outcome of racing) expect(outcome.status === "fulfilled" ? outcome.value.state : "rejected").toBe("stopped");
    // A settled stop is terminal and leaves the work list.
    expect((await list(empty.stops)).map(entry => entry.reference.commandId)).not.toContain(thirdReference.commandId);

    // Bounds and a malformed cursor are refused rather than scanned.
    for (const limit of [0, -1, 1.5, FACTORY_STOP_SCAN_MAX_LIMIT + 1]) await expect(list(empty.stops, { limit })).rejects.toMatchObject({ code: "factory_task_stop_invalid" });
    await expect(list(empty.stops, { after: { acceptedAtMs: -1, cancelCommandId: firstReference.commandId } })).rejects.toMatchObject({ code: "factory_task_stop_invalid" });
    await expect(list(empty.stops, { after: { acceptedAtMs: 1, cancelCommandId: "" } })).rejects.toBeInstanceOf(Error);
    // A corrupt source is refused rather than handed to a worker. The durable
    // CHECK normally makes this unreachable, so it is lifted to prove the scan
    // does not trust the column, then restored.
    await fixture.db.execute(sql`ALTER TABLE factory_task_stops DROP CONSTRAINT factory_task_stops_source_check`);
    try {
      await fixture.db.execute(sql`UPDATE factory_task_stops SET source='forged' WHERE cancel_command_id=${firstReference.commandId}`);
      await expect(list(empty.stops)).rejects.toMatchObject({ code: "factory_task_stop_corrupt" });
    } finally {
      await fixture.db.execute(sql`UPDATE factory_task_stops SET source='sealed-launch' WHERE cancel_command_id=${firstReference.commandId}`);
      await fixture.db.execute(sql`ALTER TABLE factory_task_stops ADD CONSTRAINT factory_task_stops_source_check CHECK (source IN ('terminal-outcome','sealed-launch'))`);
    }
    expect((await list(empty.stops)).length).toBeGreaterThan(0);
  });

  test("concurrent stop and confirm commit one settlement", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    let sealed: FactoryTaskStopRequest | undefined;
    const { stops } = harness(attempt, stopper(async request => { sealed = request; return signed(request); }), acknowledger());
    const first = await stops.stop(service, reference);
    const results = await Promise.allSettled([stops.stop(service, reference), stops.confirm(service, reference, signed(sealed!)), stops.stop(service, reference)]);
    for (const result of results) expect(result.status === "fulfilled" ? result.value : result.reason).toEqual(first);
    expect(rows(await fixture.db.execute(sql`SELECT cancel_command_id FROM factory_task_stops WHERE run_id=${attempt.run.runId}`))).toHaveLength(1);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "attempt-stopped")).toHaveLength(1);
  });
}
