/**
 * One tenant, one project, one published reference factory, and the real stores
 * that drive a run to a live, launched attempt.
 *
 * Shared by the stop suite (W03) and the package fence suite (W02c). Both need
 * the same thing, a run whose attempt was admitted through the real kernel and
 * stores and is now running on a host, and both used to need it built the same
 * way. Every identifier is derived from `label`, so two suites in one bun
 * process never collide on a unique index.
 */
import { createHash, type KeyObject } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { advanceKernel, createKernelState, FACTORY_LAZY_INPUT_SCHEMA_VERSION, referenceCodeV1, type FactoryDefinition, type FactoryRunnerRequest, type FactoryRunStartBody, type JsonValue, type KernelEvent } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
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
import { FactoryNativeRunnerPolicy, type FactoryPackageAdmissionFence } from "../../factory/native-runner-policy";
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
import { FactoryTaskStops, type FactoryPhysicalStopper, type FactoryPoolStopAcknowledger, type FactoryStopHostKey, type FactoryTaskStopRequest } from "../../factory/task-stops";
import { FactoryUsageSettlements } from "../../factory/usage-settlement";
import { FactoryTransitionArtifacts } from "../../factory/transition-artifacts";
import { persistTransition } from "../../../packages/@ezcorp/factory-orchestrator/src/transition-pages";

export interface FactoryLiveAttemptWorldOptions {
  /** Prefix for every identifier this world writes. */
  readonly label: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly principal: FactoryPrincipal;
  readonly factoryId: string;
  readonly hostId: string;
  readonly now: number;
  readonly profile: FactoryTaskResourceProfile;
  readonly service: { readonly tenantId: string; readonly subject: string };
  /** The host's signing key pair. Its key id is `<label>-host-key-1`. */
  readonly hostKeys: { readonly privateKey: KeyObject; readonly publicKey: KeyObject };
}

/** W03's stop store over one attempt's own collaborators. */
export interface FactoryStopHarness {
  readonly stops: FactoryTaskStops;
  readonly settlements: FactoryUsageSettlements;
  readonly journal: FactoryExecutionJournal;
}

/** A run whose first transition is committed and whose compute admission is requested. */
export interface FactoryStartedRun {
  readonly run: { runId: string; revision: number };
  readonly identity: { tenantId: string; projectId: string; logicalRunId: string; interpreterId: string };
  readonly transitions: FactoryTransitionArtifacts;
  readonly activities: ReturnType<typeof createFactoryArtifactActivities>;
  readonly compiled: Awaited<ReturnType<FactoryDefinitions["readVersion"]>>["compiled"];
  readonly authority: FactoryCommandAuthority;
  readonly first: ReturnType<typeof advanceKernel>;
  readonly admissionCommandId: string;
}

/** A run whose compute is admitted and whose `dispatch-node` transition is committed. */
export interface FactoryDispatchableRun extends FactoryStartedRun {
  readonly admissions: FactoryComputeAdmissions;
  readonly journal: FactoryExecutionJournal;
  readonly queue: FactoryAttemptQueue;
  readonly reservationId: string;
  readonly dispatchReference: { tenantId: string; projectId: string; logicalRunId: string; interpreterId: string; commandId: string };
  readonly state: ReturnType<typeof advanceKernel>;
}

export interface FactoryLiveAttempt extends FactoryDispatchableRun {
  readonly launches: FactoryDatabaseAttemptLaunchStore;
  readonly attemptId: string;
  readonly request: FactoryRunnerRequest;
  readonly lease: FactoryAttemptLease;
}

export interface FactoryLiveAttemptWorld {
  readonly grants: FactoryGrants;
  readonly definitions: FactoryDefinitions;
  readonly lifecycle: FactoryRunLifecycle;
  readonly body: FactoryRunStartBody;
  readonly objectStore: BlobStore;
  runKey(runId: string): { projectId: string; runId: string };
  /** Starts a run and commits its first transition, which requests compute admission. */
  startRun(): Promise<FactoryStartedRun>;
  /** Admits compute and commits the transition that carries `dispatch-node`. */
  dispatchable(poolPinsHost?: boolean): Promise<FactoryDispatchableRun>;
  /** Admits the attempt through the production runner policy, with an optional package fence. */
  admitAttempt(run: FactoryDispatchableRun, packages?: FactoryPackageAdmissionFence): Promise<FactoryRunnerRequest>;
  /**
   * Drives one run to a live, launched attempt.
   *
   * `poolPinsHost` is the C03 distinction, not a knob: the pool names a machine
   * only for an allocation that binds a whole one, so an ordinary CPU
   * reservation has none. Both shapes must reach a stop.
   */
  launchedAttempt(poolPinsHost?: boolean): Promise<FactoryLiveAttempt>;
  /** Commits the transition a durable kernel `cancel` event produces, and returns its `cancel-node` reference. */
  commitCancel(attempt: FactoryDispatchableRun): Promise<{ reference: FactoryDispatchableRun["dispatchReference"]; advanced: ReturnType<typeof advanceKernel>; event: KernelEvent }>;
  /** Cancels the run as its operator and commits the transition that carries the live `cancel-node` command. */
  cancelled(attempt: FactoryDispatchableRun): Promise<{ reference: FactoryDispatchableRun["dispatchReference"]; advanced: ReturnType<typeof advanceKernel> }>;
  /** A physical stop receipt signed by the host key, exactly as the supervisor signs one. */
  signedStop(request: FactoryTaskStopRequest, overrides?: Partial<FactoryPhysicalStopReceipt>, key?: KeyObject, keyId?: string): FactoryPhysicalStopReceipt;
  /** A trusted pool that settles exactly the generations and host it is shown. */
  settlingPool(overrides?: Partial<PoolLeaseStatus>, onCall?: () => void): FactoryPoolStopAcknowledger;
  countingStopper(sign: (request: FactoryTaskStopRequest) => Promise<FactoryPhysicalStopReceipt>, calls?: { count: number }): FactoryPhysicalStopper;
  stopHarness(attempt: FactoryDispatchableRun, physical: FactoryPhysicalStopper, pool: FactoryPoolStopAcknowledger, keys?: readonly FactoryStopHostKey[], timeoutMs?: number): FactoryStopHarness;
}

export async function createFactoryLiveAttemptWorld(fixture: { readonly db: TransactionalDb; readonly blobs?: BlobStore }, options: FactoryLiveAttemptWorldOptions): Promise<FactoryLiveAttemptWorld> {
  const { label, tenantId, projectId, principal, hostId, now, profile, service } = options;
  const key = { projectId, factoryId: options.factoryId };
  const runKey = (runId: string) => ({ projectId, runId });
  const contents = new Map<string, Uint8Array>();
  const objectStore: BlobStore = fixture.blobs ?? {
    async put(bytes: Uint8Array) { const digest = digestBytes(bytes); contents.set(digest, bytes.slice()); return digest; },
    async get(digest: string) { const bytes = contents.get(digest); if (!bytes) throw new Error("blob unavailable"); return bytes.slice(); },
  };
  let sequence = 0;

  const records = new FactoryRecords(fixture.db, tenantId);
  await records.bindInstallation();
  await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},${`${label} project`},${`/tmp/factory-${label}`})`);
  await records.bindProject(projectId);
  await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${principal.id},${`${label}@example.test`},'not-a-login',${`${label} owner`},'admin')`);
  await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES (${`${label}-membership`},${projectId},${principal.id},'owner')`);
  const grants = new FactoryGrants(fixture.db, tenantId, () => now);
  for (const action of ["factory.author", "factory.publish", "factory.run", "factory.operate", "factory.approve", "factory.trust", "factory.release"] as const) await grants.set(principal, { principal, projectId, action, expectedRevision: 0, expiresAtMs: null });
  const definitions = new FactoryDefinitions(fixture.db, tenantId, grants, objectStore);
  const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: key.factoryId };
  await definitions.save(principal, key, 0, `${label}-definition-create`, source);
  const version = await definitions.publish(principal, key, 1, `${label}-definition-publish`);
  const body: FactoryRunStartBody = { factoryVersion: version.version, definitionDigest: version.definitionDigest, grantRevision: 1, parameters: Object.fromEntries(Object.entries(source.inputPorts).map(([name, schema]) => [name, { kind: "inline" as const, value: schema.type === "object" ? {} : `${label} value` }])) };
  const lifecycle = new FactoryRunLifecycle(fixture.db, tenantId, { definitions, grants, interpreterBuild: "kernel-build-immutable", interpreterCompatibility: source.interpreterCompatibility, limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 },
    async stageDefinitionInTransaction(transaction, compiled, identity) { return new FactoryDefinitionArtifacts(new FactoryArtifacts(fixture.db, objectStore, tenantId)).stageDefinitionInTransaction(transaction, compiled, identity); },
    async resolveParameters(_transaction, _principal, _key, parameters) { return Object.fromEntries(Object.entries(parameters).map(([name, value]) => { if (value.kind !== "inline") throw new Error("fixture has no artifact input"); return [name, value.value]; })) as JsonValue; } }, () => now);

  const unavailable = async (): Promise<never> => { throw new Error("This fixture admits product facts without a remote pool."); };
  const requestPool = { request: unavailable, status: unavailable, cancel: unavailable, acknowledgeStart: unavailable, renew: unavailable, confirmStopped: unavailable } satisfies PoolAdmissionClient;

  async function startRun(): Promise<FactoryStartedRun> {
    const started = await lifecycle.start(principal, key, body, 0, `${label}-start-${++sequence}`);
    const run = { runId: started.run.runId, revision: started.run.revision };
    const identity = { tenantId, projectId, logicalRunId: run.runId, interpreterId: "root" };
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const { compiled } = await definitions.readVersion(principal, key, body.factoryVersion);
    const input = Object.fromEntries(Object.entries(body.parameters).map(([name, value]) => [name, value.kind === "inline" ? value.value : null])) as JsonValue;
    const { fence } = await fixture.db.transaction(transaction => lifecycle.readExecutionPlanInTransaction(transaction, runKey(run.runId)));
    const created = createKernelState(compiled, run.runId, input, now, { schemaVersion: FACTORY_LAZY_INPUT_SCHEMA_VERSION, parameters: body.parameters });
    const event = { kind: "start", id: `${label}-start-event-${sequence}`, atMs: now } as const;
    const first = advanceKernel(compiled, { ...created, runDeadlineAtMs: Math.min(created.runDeadlineAtMs, fence.deadlineAtMs) }, event);
    const admissionCommand = first.commands.find(command => command.kind === "request-admission")!;
    const authority = new FactoryCommandAuthority(fixture.db, tenantId, lifecycle, transitions, ["orchestration"], () => now);
    await persistTransition(identity, 1, event, first.nextState, first.commands, undefined, activities);
    return { run, identity, transitions, activities, compiled, authority, first, admissionCommandId: admissionCommand.id };
  }

  async function dispatchable(poolPinsHost = true): Promise<FactoryDispatchableRun> {
    const started = await startRun();
    const { run, identity, transitions, compiled, authority, first, activities } = started;
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const reserved = await new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, { cpu: profile }, new FactoryComputeAdmissions(fixture.db, tenantId, authority, lifecycle.budgets, inbox, requestPool, () => now), () => now).request(service, { ...identity, commandId: started.admissionCommandId });
    await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId));
    const queued = (await new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now, "pool").inspect(reserved.outboxCommandId))!;
    const requested = queued.command.body as { request: { resources: Record<string, number> } };
    const poolLease = { reservationId: reserved.reservationId, tenantId, grantRevision: body.grantRevision, allocationGeneration: 1, holderGeneration: 1, allocationToken: `${label}-allocation`, fence: `${label}-fence`, deadlineAt: new Date(now + 60_000), resources: requested.request.resources, ...(poolPinsHost ? { hostId } : {}) };
    const admissions = new FactoryComputeAdmissions(fixture.db, tenantId, authority, lifecycle.budgets, inbox, { ...requestPool, async request() { return { status: "admitted" as const, reservationId: reserved.reservationId, lease: poolLease }; }, async status() { return undefined; } }, () => now);
    const admitted = await admissions.recover(service, { projectId, runId: run.runId, reservationId: reserved.reservationId });
    if (admitted.status !== "admitted") throw new Error("fixture compute admission failed");
    // A dispatch-node admission always carries its kernel event; a validator
    // origin is the only shape that does not, and this fixture has none.
    if (!admitted.receipt.event) throw new Error("fixture compute admission produced no admission-result event");
    const next = advanceKernel(compiled, first.nextState, admitted.receipt.event);
    const dispatch = next.commands.find(command => command.kind === "dispatch-node")!;
    await persistTransition(identity, 2, admitted.receipt.event, next.nextState, next.commands, undefined, activities);
    const journal = new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction);
    const queue = new FactoryAttemptQueue(fixture.db, journal, tenantId, () => now);
    return { ...started, admissions, journal, queue, reservationId: reserved.reservationId, dispatchReference: { ...identity, commandId: dispatch.id }, state: next };
  }

  async function admitAttempt(run: FactoryDispatchableRun, packages?: FactoryPackageAdmissionFence): Promise<FactoryRunnerRequest> {
    const dispatch = run.state.commands.find(command => command.kind === "dispatch-node")!;
    const taskNode = run.compiled.indexes.nodeById[dispatch.nodeId];
    if (taskNode?.kind !== "task") throw new Error("fixture dispatch task is missing");
    const policy = new FactoryNativeRunnerPolicy(tenantId, grants, [{ runner: taskNode.runner, resourceClass: "cpu", allocation: profile, allowedCapabilities: taskNode.capabilities ?? [], tools: [] }], "factory-broker", packages);
    const execution = await new FactoryTaskExecutionAdmission(run.authority, run.admissions, run.journal, run.queue, policy, () => now).admit(service, run.dispatchReference);
    return { ...execution.request, broker: { ...execution.request.broker, attemptToken: `${label}-fixture-token` } } as FactoryRunnerRequest;
  }

  async function launchedAttempt(poolPinsHost = true): Promise<FactoryLiveAttempt> {
    const run = await dispatchable(poolPinsHost);
    const request = await admitAttempt(run);
    const lease: FactoryAttemptLease = { reservationId: run.reservationId, grantRevision: body.grantRevision, allocationGeneration: 1, holderGeneration: 1, allocationToken: `${label}-allocation`, hostId };
    const launches = new FactoryDatabaseAttemptLaunchStore(fixture.db);
    const preparedPackage = { projectId, reference: request.runner, trustRevision: 1, packageTrustDigest: `sha256:${"a".repeat(64)}`, releaseDigest: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"a".repeat(64)}`, artifactDigest: "b".repeat(64), imageDigest: `sha256:${"a".repeat(64)}`, manifestDigest: `sha256:${"a".repeat(64)}`, evidenceDigest: `sha256:${"a".repeat(64)}`, buildIdentity: `${label}-build`, receiptDigest: `sha256:${"a".repeat(64)}` };
    await launches.prepare(request, lease, preparedPackage);
    await launches.state(request.authority.attemptId, "launched");
    return { ...run, launches, attemptId: request.authority.attemptId, request, lease };
  }

  async function commitCancel(attempt: FactoryDispatchableRun) {
    const stored = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${attempt.run.runId} AND payload::jsonb->>'kind'='cancel'`));
    const event = JSON.parse(stored[0]!.payload) as KernelEvent;
    const advanced = advanceKernel(attempt.compiled, attempt.state.nextState, event);
    const cancelCommand = advanced.commands.find(command => command.kind === "cancel-node");
    if (!cancelCommand) throw new Error("fixture cancellation produced no cancel-node command");
    await persistTransition(attempt.identity, 3, event, advanced.nextState, advanced.commands, undefined, attempt.activities);
    return { reference: { ...attempt.identity, commandId: cancelCommand.id }, advanced, event };
  }

  async function cancelled(attempt: FactoryDispatchableRun) {
    await lifecycle.cancel(principal, runKey(attempt.run.runId), attempt.run.revision, `${label}-cancel-${attempt.run.runId}`);
    const { reference, advanced } = await commitCancel(attempt);
    return { reference, advanced };
  }

  const hostKeyId = `${label}-host-key-1`;
  function signedStop(request: FactoryTaskStopRequest, overrides: Partial<FactoryPhysicalStopReceipt> = {}, key: KeyObject = options.hostKeys.privateKey, keyId = hostKeyId): FactoryPhysicalStopReceipt {
    const unsigned: FactoryUnsignedPhysicalStopReceipt = {
      schemaVersion: "factory.physical-stop.v1", attemptId: request.attemptId, reservationId: request.reservationId,
      workerId: request.workerId, holderGeneration: request.holderGeneration, allocationGeneration: request.allocationGeneration,
      processGroupAbsent: true, stoppedAtMs: now, reason: request.reason, hostId: request.hostId, ...overrides,
    };
    const signature = signFactoryPhysicalStopReceipt(unsigned, keyId, key);
    return Object.freeze({ ...unsigned, ...signature, receiptDigest: `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}` });
  }
  function settlingPool(overrides: Partial<PoolLeaseStatus> = {}, onCall?: () => void): FactoryPoolStopAcknowledger {
    return {
      async confirmStopped(input) {
        onCall?.();
        return { reservationId: input.reservationId, tenantId, state: "settled", allocationGeneration: 1, holderGeneration: input.holderGeneration, effects: 0, resources: { cpu: 1 }, hostId: input.hostId, ...overrides } satisfies PoolLeaseStatus;
      },
    };
  }
  function countingStopper(sign: (request: FactoryTaskStopRequest) => Promise<FactoryPhysicalStopReceipt>, calls?: { count: number }): FactoryPhysicalStopper {
    return { async stop(request) { if (calls) calls.count++; return sign(request); } };
  }
  function stopHarness(attempt: FactoryDispatchableRun, physical: FactoryPhysicalStopper, pool: FactoryPoolStopAcknowledger, keys: readonly FactoryStopHostKey[] = [{ hostId, hostKeyId, publicKey: options.hostKeys.publicKey }], timeoutMs = 20_000): FactoryStopHarness {
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const settlements = new FactoryUsageSettlements(fixture.db, tenantId, inbox, () => now);
    const outcomes = new FactoryTaskOutcomes(fixture.db, attempt.authority, attempt.admissions, attempt.journal, attempt.queue, lifecycle.budgets, inbox, () => now);
    const stops = new FactoryTaskStops(fixture.db, attempt.authority, attempt.admissions, attempt.journal, outcomes, attempt.queue, lifecycle.budgets, inbox, settlements, physical, pool, keys, () => now, timeoutMs);
    return { stops, settlements, journal: attempt.journal };
  }

  return { grants, definitions, lifecycle, body, objectStore, runKey, startRun, dispatchable, admitAttempt, launchedAttempt, commitCancel, cancelled, signedStop, settlingPool, countingStopper, stopHarness };
}
