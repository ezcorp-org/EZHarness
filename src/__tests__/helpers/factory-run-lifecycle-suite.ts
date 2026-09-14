import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { referenceCodeV1, validateFactoryApiResponse, createKernelState, createPartitionKernelState, advanceKernel, factoryRunnerRequestDigest, type FactoryDefinition, type FactoryRunnerRequest, type FactoryRunnerResult, type FactoryRunStartBody, type JsonValue } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import type { BlobStore } from "../../extensions/v4/types";
import { digestBytes, digestObject } from "../../extensions/v4/blobs";
import { createFactoryApplication } from "../../factory/application";
import { artifactJson, FactoryArtifacts } from "../../factory/artifacts";
import { createFactoryArtifactActivities } from "../../factory/artifact-activities";
import { FactoryDefinitionArtifacts } from "../../factory/definition-artifacts";
import { FactoryDefinitions } from "../../factory/definitions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryCommandOutbox } from "../../factory/outbox";
import { encodeFactoryPayload, FactoryRecords } from "../../factory/records";
import { FactoryRunLifecycle, type FactoryRunLifecycleOptions } from "../../factory/run-lifecycle";
import { FactoryServiceCredentials } from "../../factory/service-credentials";
import { FactoryCommandAuthority, type FactoryAuthorizedApprovalCommand } from "../../factory/command-authority";
import { FACTORY_CHILD_SETTLEMENT_SCAN_LIMIT, FactoryChildRuns } from "../../factory/child-runs";
import { FactoryTaskAdmission, factoryTaskReservationId, type FactoryTaskResourceProfile } from "../../factory/task-admission";
import { FactoryComputeAdmissions } from "../../factory/compute-admissions";
import { FactoryExecutionJournal } from "../../factory/executions";
import { FactoryAttemptQueue } from "../../factory/attempt-queue";
import { FactoryTaskExecutionAdmission } from "../../factory/task-execution-admission";
import { FactoryNativeRunnerPolicy, type FactoryNativeRunnerProfile } from "../../factory/native-runner-policy";
import { FactoryAttemptDispatcher } from "../../factory/attempt-dispatcher";
import { verifyFactoryAttemptToken } from "../../factory/attempt-token";
import { FactoryInbox } from "../../factory/inbox";
import type { PoolAdmissionClient } from "../../factory/pool/client";
import { FactoryAssuranceCommands } from "../../factory/assurance-commands";
import { FactoryReleases } from "../../factory/releases";
import { FactoryPrivateCommands, type FactoryPrivateCommandStores } from "../../factory/private-commands";
import { FactoryLazyCommands } from "../../factory/lazy-commands";
import { FactoryLazyInputReader } from "../../factory/lazy-input";
import { FactoryArtifactAccess } from "../../factory/artifact-access";
import { FactoryInputArtifacts } from "../../factory/input-artifacts";
import { FactoryRunInputs } from "../../factory/run-inputs";
import { FactoryRunControls } from "../../factory/run-controls";
import { FactoryTransitionAuthority } from "../../factory/transition-authority";
import { startFactoryPrivateService } from "../../factory/private-service";
import { FactoryTransportQueue } from "../../factory/transport-queue";
import { certificates, nodeHttpsRequest, signedServiceToken, type Certificates } from "./factory-certificates";
import { FactoryRunTransitionProjector } from "../../factory/run-transition-projector";
import { FactoryTransitionArtifacts } from "../../factory/transition-artifacts";
import { FactoryReleaseAuthorityStore } from "../../factory/release-authority";
import { FactoryTrustedValidators } from "../../factory/validator-materials";
import { FactoryAssurance } from "../../factory/assurance";
import { factorySynchronousReleaseProfile, FactoryProtectedCommandEffects } from "../../factory/protected-command-effects";
import { FactoryProtectedValidatorScheduler } from "../../factory/validator-scheduler";
import { FactoryValidatorAttemptDispatch } from "../../factory/validator-dispatch";
import { assertFactoryDispatchNodeOrigin, factoryAdmissionOriginDigest } from "../../factory/admission-origin";
import { up } from "../../db/migrations/add-factory-run-lifecycle";
import { persistTransition } from "../../../packages/@ezcorp/factory-orchestrator/src/transition-pages";

export function factoryRunLifecycleConformance(create: () => Promise<{ db: TransactionalDb; blobs?: BlobStore; close(): Promise<void> }>): void {
  let fixture: Awaited<ReturnType<typeof create>>;
  let definitions: FactoryDefinitions;
  let grants: FactoryGrants;
  let lifecycle: FactoryRunLifecycle;
  let options: FactoryRunLifecycleOptions;
  let body: FactoryRunStartBody;
  let objectStore: BlobStore;
  let now = Date.UTC(2030, 0, 1);
  let sequence = 0;
  let stages = 0;
  const duration = 7 * 24 * 60 * 60 * 1000;
  const tenantId = "lifecycle-tenant";
  const projectId = "lifecycle-project";
  const principal: FactoryPrincipal = { kind: "user", id: "lifecycle-owner", authentication: "session" };
  const key = { projectId, factoryId: "lifecycle-factory" };
  const contents = new Map<string, Uint8Array>();
  const blobs = { async put(bytes: Uint8Array) { const digest = digestBytes(bytes); contents.set(digest, bytes.slice()); return digest; }, async get(digest: string) { const bytes = contents.get(digest); if (!bytes) throw new Error("blob unavailable"); return bytes.slice(); } };
  const runKey = (runId: string) => ({ projectId, runId });
  const startRun = async (...args: Parameters<FactoryRunLifecycle["start"]>) => (await lifecycle.start(...args)).run;
  const cancelRun = async (...args: Parameters<FactoryRunLifecycle["cancel"]>) => (await lifecycle.cancel(...args)).run;
  const dispatchReady = { async assertDispatchReady() { return Object.freeze({ ready: true }); } };
  const dispatchReadinessDisposition = (error: unknown): "retry" | "deny" => error instanceof Error && error.message === "package denied" ? "deny" : "retry";
  const privateCommands = (authority: FactoryCommandAuthority, transitions: FactoryTransitionArtifacts, stores: Partial<Pick<FactoryPrivateCommandStores, "tasks" | "execution" | "inputs" | "children" | "approvals">>, effects: Partial<FactoryPrivateCommandStores["effects"]> = {}) => {
    const unused = async (): Promise<never> => { throw new Error("Unexpected product command in this fixture."); };
    return new FactoryPrivateCommands({
      service: { tenantId, subject: "orchestration" }, authority, transitions,
      tasks: { request: unused }, execution: { admit: unused }, inputs: { execute: unused }, children: { resolve: unused }, approvals: { tenantId, execute: unused },
      effects: { "cancel-node": unused, "request-acceptance": unused, "request-release": unused, "invalidate-partition": unused, "notify-partition": unused, ...effects }, ...stores,
    });
  };
  const start = () => startRun(principal, key, body, 0, `start-${++sequence}`);
  const taskAdmissions = (authority: FactoryCommandAuthority, profiles: Readonly<Record<string, FactoryTaskResourceProfile>>) => {
    const unavailable = async (): Promise<never> => { throw new Error("This fixture admits product facts without calling a remote pool."); };
    const pool = { request: unavailable, status: unavailable, cancel: unavailable, acknowledgeStart: unavailable, renew: unavailable } satisfies PoolAdmissionClient;
    const admissions = new FactoryComputeAdmissions(fixture.db, tenantId, authority, lifecycle.budgets, new FactoryInbox(fixture.db, tenantId, () => now), pool, () => now);
    return new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, profiles, admissions, () => now);
  };
  const committedInterpreter = async (runId: string, definitionKey = key, request = body, runLifecycle = lifecycle, resolvedInput?: JsonValue, clock = now) => {
    const identity = { tenantId, projectId, logicalRunId: runId, interpreterId: "root" };
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const { compiled } = await definitions.readVersion(principal, definitionKey, request.factoryVersion);
    const input = resolvedInput ?? Object.fromEntries(Object.entries(request.parameters).map(([name, value]) => [name, value.kind === "inline" ? value.value : null]));
    const event = { kind: "start", id: "authority-start", atMs: clock } as const;
    const { fence } = await fixture.db.transaction(transaction => runLifecycle.readExecutionPlanInTransaction(transaction, { projectId, runId }));
    const created = createKernelState(compiled, runId, input, clock, { schemaVersion: "factory.lazy-input.v1", parameters: request.parameters });
    const first = advanceKernel(compiled, { ...created, runDeadlineAtMs: Math.min(created.runDeadlineAtMs, fence.deadlineAtMs) }, event);
    const admission = first.commands.find(command => command.kind === "request-admission")!;
    const authority = new FactoryCommandAuthority(fixture.db, tenantId, runLifecycle, transitions, ["orchestration"], () => clock);
    return { identity, transitions, activities, compiled, event, first, admission, authority };
  };
  const dispatchedTask = async (definitionKey = key, request = body) => {
    const run = await startRun(principal, definitionKey, request, 0, `task-start-${++sequence}`);
    const { identity, transitions, activities, compiled, event, first, admission, authority } = await committedInterpreter(run.runId, definitionKey, request);
    await persistTransition(identity, 1, event, first.nextState, first.commands, undefined, activities);
    const reference = { ...identity, commandId: admission.id };
    const service = { tenantId, subject: "orchestration" };
    const profile = { resources: { cpu: 1 }, memoryBytes: 128, budget: { costMicros: "5", tokens: 6, computeMs: 7 } };
    expect(await privateCommands(authority, transitions, { tasks: taskAdmissions(authority, { cpu: profile }) }).execute(service, reference)).toBeNull();
    const reserved = await taskAdmissions(authority, { cpu: profile }).request(service, reference);
    expect(await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId))).toMatchObject({ sequence: 1, lag: 0 });
    expect(await taskAdmissions(authority, { cpu: profile }).request(service, reference)).toEqual(reserved);
    const queued = (await new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now, "pool").inspect(reserved.outboxCommandId))!;
    const input = queued.command.body as import("../../factory/task-admission").FactoryComputeAdmissionRequest;
    const lease = { reservationId: reserved.reservationId, tenantId, grantRevision: body.grantRevision, allocationGeneration: 1, holderGeneration: 1, allocationToken: "current-authority-allocation", fence: "current-authority-fence", deadlineAt: new Date(now + 1_000), resources: input.request.resources, hostId: "host-current" };
    let requests = 0;
    const pool = { async request() { requests++; return { status: "admitted" as const, reservationId: reserved.reservationId, lease }; }, async status() { return undefined; }, async cancel() { throw new Error("unexpected cancellation"); }, async acknowledgeStart() { throw new Error("unused"); }, async renew() { throw new Error("unused"); } } satisfies PoolAdmissionClient;
    const admissions = new FactoryComputeAdmissions(fixture.db, tenantId, authority, lifecycle.budgets, new FactoryInbox(fixture.db, tenantId, () => now), pool, () => now);
    const admitted = await admissions.recover(service, { projectId, runId: run.runId, reservationId: reserved.reservationId });
    expect(admitted).toMatchObject({ status: "admitted", receipt: { lease: { allocationToken: lease.allocationToken }, event: { commandId: admission.id, granted: true } } });
    expect(requests).toBe(1);
    expect(rows(await fixture.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE reservation_id=${reserved.reservationId}`))).toEqual([{ state: "running" }]);
    expect(rows(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${run.runId}`))).toHaveLength(1);
    expect(await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId))).toMatchObject({ sequence: 1, lag: 0 });
    if (admitted.status !== "admitted") throw new Error("fixture compute admission failed");
    // A dispatch-node admission always carries its kernel event; a validator
    // origin is the only shape that does not, and this fixture has none.
    if (!admitted.receipt.event) throw new Error("fixture compute admission produced no admission-result event");
    const next = advanceKernel(compiled, first.nextState, admitted.receipt.event);
    const dispatch = next.commands.find(command => command.kind === "dispatch-node");
    if (!dispatch) throw new Error("fixture dispatch command is missing");
    await persistTransition(identity, 2, admitted.receipt.event, next.nextState, next.commands, undefined, activities);
    const dispatchReference = { ...identity, commandId: dispatch.id };
    const journal = new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction);
    const queue = new FactoryAttemptQueue(fixture.db, journal, tenantId, () => now);
    return { run, identity, transitions, activities, compiled, profile, next, dispatch, dispatchReference, authority, admissions, journal, queue, service, reserved, lease };
  };
  const completedTask = async (customValue?: JsonValue, definitionKey = key, request = body) => {
    const task = await dispatchedTask(definitionKey, request);
    const taskNode = task.compiled.indexes.nodeById[task.dispatch.nodeId];
    if (taskNode?.kind !== "task") throw new Error("fixture dispatch task is missing");
    const policy = new FactoryNativeRunnerPolicy(tenantId, grants, [{ runner: taskNode.runner, resourceClass: "cpu", allocation: task.profile, allowedCapabilities: taskNode.capabilities ?? [], tools: [] }], "factory-broker");
    const execution = new FactoryTaskExecutionAdmission(task.authority, task.admissions, task.journal, task.queue, policy, () => now);
    expect(await privateCommands(task.authority, task.transitions, { execution }).execute(task.service, task.dispatchReference)).toBeNull();
    const admitted = await execution.admit(task.service, task.dispatchReference);
    const { FactoryTaskCompletions } = await import("../../factory/task-completions");
    const { FactoryTaskOutcomes } = await import("../../factory/task-outcomes");
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const completions = new FactoryTaskCompletions(fixture.db, task.authority, task.admissions, task.journal, task.queue, new FactoryArtifacts(fixture.db, objectStore, tenantId), lifecycle.budgets, inbox, () => now);
    const outcomes = new FactoryTaskOutcomes(fixture.db, task.authority, task.admissions, task.journal, task.queue, lifecycle.budgets, inbox, () => now);
    const authority = { ...admitted.delivery.reference, deadlineAt: new Date(admitted.delivery.reference.deadlineAtMs) };
    const operation = { operationId: `${task.run.runId}:${task.dispatch.nodeId}:0:0`, operationIndex: 0, kind: "tool" as const, requestDigest: "a".repeat(64) };
    const usage = { kind: "measured" as const, inputTokens: 1, outputTokens: 2, computeMs: 3, costMicros: "4" };
    const checkpoint = { artifactId: "task-checkpoint", digest: `sha256:${"b".repeat(64)}`, encodedBytes: 1, journalCursor: 0 };
    await task.journal.prepare(authority, operation);
    await task.journal.dispatch(authority, operation.operationId);
    await task.journal.settle(authority, operation.operationId, "completed", { result: { completed: true }, resultDigest: "c".repeat(64), usage, workspaceCheckpoint: checkpoint });
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const value = customValue ?? { snapshot: { digest: `sha256:${"d".repeat(64)}`, mediaType: "application/json", storage: "immutable-test-snapshot" } };
    const { artifactJson } = await import("../../factory/artifacts");
    const output = await fixture.db.transaction(tx => artifacts.stageCandidateOutputInTransaction(tx, task.identity, task.dispatch.nodeId, 0, artifactJson.canonical(value)));
    const result = { schemaVersion: "factory.runner.result.v1" as const, status: "completed" as const, journalCursor: 0, operations: [{ ...operation, state: "completed" as const, resultDigest: "c".repeat(64), usage, workspaceCheckpoint: checkpoint }], resultDigest: output.digest.slice(7), output, usage, workspaceCheckpoint: checkpoint };
    return { task, completions, outcomes, admitted, authority, result, value, artifacts };
  };
  const prepareApproval = async (scope: "owner" | "operator" | "tenant-contract-admin", suffix: string) => {
    const definitionKey = { projectId, factoryId: `${suffix}-approval-factory` };
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, inputPorts: {}, outputPorts: {},
      graph: { nodes: [{ id: "human", kind: "approval", actorScope: scope, choices: ["ship", "hold"], context: { kind: "literal", value: { subject: suffix } }, expiresInMs: 60_000, onDenied: "fail", onExpired: "fail" }], outputs: {} } };
    await definitions.save(principal, definitionKey, 0, `${suffix}-approval-create`, source);
    const version = await definitions.publish(principal, definitionKey, 1, `${suffix}-approval-publish`);
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest, parameters: {} };
    const run = await startRun(principal, definitionKey, request, 0, `${suffix}-approval-start`);
    const current = await committedInterpreter(run.runId, definitionKey, request);
    const command = current.first.commands.find(value => value.kind === "request-approval");
    if (command?.kind !== "request-approval") throw new Error("missing approval command");
    const reference = { ...current.identity, commandId: command.id };
    await persistTransition(current.identity, 1, current.event, current.first.nextState, current.first.commands, undefined, current.activities);
    const releases = new FactoryReleases(fixture.db, tenantId, grants, { tenantId } as never, {} as never, {} as never, {} as never, {} as never, {} as never, () => now, 10_000, { authority: current.authority, service: { tenantId, subject: "orchestration" } });
    const approvals = new FactoryAssuranceCommands(fixture.db, tenantId, grants, current.authority, new FactoryInbox(fixture.db, tenantId, () => now), releases, { tenantId, subject: "orchestration" }, () => now);
    expect(await privateCommands(current.authority, current.transitions, { approvals }).execute({ tenantId, subject: "orchestration" }, reference)).toBeNull();
    expect(await approvals.execute(reference)).toBeNull();
    expect((await releases.deliverNextNotification(projectId))?.kind).toBe("command_approval_requested");
    const visible = await releases.listDeliveredNotifications(principal, projectId, { limit: 200 });
    const item = visible.items.find(value => value.kind === "command_approval_requested" && value.runId === run.runId);
    if (item?.kind !== "command_approval_requested") throw new Error("missing command approval notification");
    return { ...current, approvals, command, item, reference, releases, run };
  };
  const persistCompletedTask = async (task: Awaited<ReturnType<typeof dispatchedTask>>, receipt: import("../../factory/task-completions").FactoryTaskCompletionReceipt) => {
    const advanced = advanceKernel(task.compiled, task.next.nextState, receipt.event);
    await persistTransition(task.identity, 3, receipt.event, advanced.nextState, advanced.commands, undefined, task.activities);
    expect(await new FactoryRunTransitionProjector(fixture.db, tenantId, task.transitions, lifecycle).project(runKey(task.run.runId))).toMatchObject({ sequence: 3, lag: 0 });
    return advanced;

  };
  beforeAll(async () => {
    fixture = await create();
    await up(fixture.db); await up(fixture.db);
    const { up: migrateCompletions } = await import("../../db/migrations/add-factory-task-completions");
    await migrateCompletions(fixture.db); await migrateCompletions(fixture.db);
    const { up: migrateOutcomes } = await import("../../db/migrations/add-factory-task-outcomes");
    await migrateOutcomes(fixture.db); await migrateOutcomes(fixture.db);
    const { up: migrateProtectedEffects } = await import("../../db/migrations/add-factory-protected-command-effects");
    await migrateProtectedEffects(fixture.db); await migrateProtectedEffects(fixture.db);
    const records = new FactoryRecords(fixture.db, tenantId);
    await records.bindInstallation();
    await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId}, 'Run lifecycle', '/tmp/lifecycle')`);
    await records.bindProject(projectId);
    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${principal.id}, 'lifecycle@example.test', 'not-a-login', 'Lifecycle', 'admin')`);
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('lifecycle-membership', ${projectId}, ${principal.id}, 'owner')`);
    grants = new FactoryGrants(fixture.db, tenantId, () => now);
    for (const action of ["factory.author", "factory.publish", "factory.run", "factory.operate", "factory.approve", "factory.trust", "factory.release"] as const) await grants.set(principal, { principal, projectId, action, expectedRevision: 0, expiresAtMs: null });
    objectStore = fixture.blobs ?? blobs;
    definitions = new FactoryDefinitions(fixture.db, tenantId, grants, objectStore);
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: key.factoryId };
    await definitions.save(principal, key, 0, "definition-create", source);
    const version = await definitions.publish(principal, key, 1, "definition-publish");
    const parameters = Object.fromEntries(Object.entries(source.inputPorts).map(([name, schema]) => [name, { kind: "inline" as const, value: schema.type === "object" ? {} : "test value" }]));
    body = { factoryVersion: version.version, definitionDigest: version.definitionDigest, grantRevision: 1, parameters };
    options = { definitions, grants, interpreterBuild: "kernel-build-immutable", interpreterCompatibility: source.interpreterCompatibility, limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 }, async stageDefinitionInTransaction(transaction, compiled, identity) {
      stages++;
      return new FactoryDefinitionArtifacts(new FactoryArtifacts(fixture.db, objectStore, tenantId)).stageDefinitionInTransaction(transaction, compiled, identity);
    }, async resolveParameters(_transaction, _principal, _key, parameters) {
      return Object.fromEntries(Object.entries(parameters).map(([name, value]) => {
        if (value.kind !== "inline") throw new Error("fixture has no artifact input");
        return [name, value.value];
      })) as JsonValue;
    } };
    lifecycle = new FactoryRunLifecycle(fixture.db, tenantId, options, () => now);
  });
  afterAll(async () => { await fixture?.close(); });

  test("run, budget, current grants and outbox commit once with exact mutation identity", async () => {
    const before = stages;
    const replies = await Promise.all([startRun(principal, key, body, 0, "race-start"), startRun(principal, key, body, 0, "race-start")]);
    expect(replies[0]).toEqual(replies[1]); expect(stages - before).toBe(1);
    const run = replies[0]!;
    expect(validateFactoryApiResponse({ schemaVersion: "factory.api.response.v1", kind: "run.details", resource: run })).toEqual({ ok: true });
    expect(run.status).toBe("queued");
    expect(await lifecycle.budgets.inspect({ ...runKey(run.runId), envelopeId: "root" })).toMatchObject({ limits: { tokens: "100" }, allocated: { tokens: "0" }, spent: { tokens: "0" } });
    const commands = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_command_outbox WHERE logical_run_id=${run.runId}`));
    expect(commands).toHaveLength(1);
    expect(JSON.parse(commands[0]!.payload).command.body).toMatchObject({ tenantId, projectId, logicalRunId: run.runId, interpreterId: "root", startedAtMs: now, deadlineAtMs: now + duration, durableInput: { schemaVersion: "factory.lazy-input.v1", parameters: body.parameters } });
    expect(await lifecycle.read(principal, runKey(run.runId))).toEqual(run);
    await expect(startRun(principal, key, { ...body, parameters: {} }, 0, "race-start")).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("application composition uses the same scoped definitions and real artifact staging", async () => {
    const application = createFactoryApplication({ database: fixture.db, tenantId, blobs: fixture.blobs ?? blobs, grants, availableResourceClasses: ["cpu"], runOptions: { interpreterBuild: options.interpreterBuild, interpreterCompatibility: options.interpreterCompatibility, limits: options.limits, resolveParameters: options.resolveParameters } });
    const request = await application.runs.start(principal, key, body, 0, "composed-start");
    expect(request.run.status).toBe("queued");
    expect(await application.runs.readCommand(principal, runKey(request.run.runId), request.receipt.commandId)).toMatchObject({ state: "queued" });
  });

  test("only the current committed task command admits product work under the live run fence", async () => {
    const run = await start();
    const { identity, transitions, activities, compiled, event, first, admission, authority } = await committedInterpreter(run.runId);
    expect(admission.kind).toBe("request-admission");
    const service = { tenantId, subject: "orchestration" };
    const reference = { ...identity, commandId: admission.id };
    expect(() => authority.assertService({ ...service, tenantId: "foreign-tenant" })).toThrow();
    await expect(authority.withCurrent(service, { ...reference, tenantId: "foreign-tenant" }, async () => "effect")).rejects.toMatchObject({ code: "factory_command_forbidden" });
    await expect(authority.withCurrent(service, reference, async () => "effect")).rejects.toThrow();
    await persistTransition(identity, 1, event, first.nextState, first.commands, undefined, activities);
    const check = await authority.withCurrent(service, reference, async (_transaction, context) => ({ runner: context.node.runner, command: context.command, grantRevision: context.fence.grantRevision }));
    expect(check).toEqual({ runner: expect.objectContaining({ package: "@ezcorp/reference-code", export: "snapshotRepository" }), command: admission, grantRevision: body.grantRevision });
    const profiles = { cpu: { resources: { cpu: 1, memory: 128 }, memoryBytes: 128 * 1024 * 1024, budget: { costMicros: "5", tokens: 6, computeMs: 7 } } };
    const taskAdmission = taskAdmissions(authority, profiles);
    expect(() => taskAdmissions(authority, { cpu: { ...profiles.cpu, resources: { cpu: 0 } } })).toThrow();
    await expect(taskAdmissions(authority, {}).request(service, reference)).rejects.toMatchObject({ code: "factory_command_forbidden" });
    await expect(taskAdmissions(authority, { cpu: { ...profiles.cpu, memoryBytes: 0 } }).request(service, reference)).rejects.toMatchObject({ code: "factory_command_forbidden" });
    for (const missing of ["factory_command_outbox", "factory_compute_admissions"]) {
      await fixture.db.execute(sql`ALTER TABLE ${sql.identifier(missing)} RENAME TO task_admission_hidden_storage`);
      try {
        await expect(taskAdmission.request(service, reference)).rejects.toThrow();
        expect((await lifecycle.budgets.inspect({ ...runKey(run.runId), envelopeId: "root" })).allocated.tokens).toBe("0");
      } finally { await fixture.db.execute(sql`ALTER TABLE task_admission_hidden_storage RENAME TO ${sql.identifier(missing)}`); }
      expect(rows(await fixture.db.execute(sql`SELECT reservation_id FROM factory_compute_admissions WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId}`))).toHaveLength(0);
    }
    profiles.cpu.budget.tokens = 99;
    const reserved = await taskAdmission.request(service, reference);
    expect(await taskAdmission.request(service, reference)).toEqual(reserved);
    expect(await lifecycle.budgets.inspect({ ...runKey(run.runId), envelopeId: "root" })).toMatchObject({ allocated: { costMicros: "5", tokens: "6", computeMs: "7" } });
    const pool = new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now, "pool");
    const queued = await pool.inspect(reserved.outboxCommandId);
    expect(queued?.command).toMatchObject({ kind: "compute_admission", body: { schemaVersion: "factory.compute-admission.v1", reference, request: { reservationId: reserved.reservationId, grantScope: `${tenantId}:factory`, grantRevision: 1, resources: { cpu: 1, memory: 128 }, admissionDeadline: new Date(admission.deadlineAtMs).toISOString() } } });
    await expect(authority.withCurrent({ ...service, subject: "foreign-service" }, reference, async () => "effect")).rejects.toThrow();
    await expect(authority.withCurrent(service, { ...reference, projectId: "foreign-project" }, async () => "effect")).rejects.toThrow();
    if (admission.kind !== "request-admission") throw new Error("missing admission");
    const admittedEvent = { kind: "admission-result", id: "authority-admitted", atMs: now + 1, nodeId: admission.nodeId, commandId: admission.id, candidateGeneration: admission.candidateGeneration, granted: true } as const;
    const next = advanceKernel(compiled, first.nextState, admittedEvent);
    await persistTransition(identity, 2, admittedEvent, next.nextState, next.commands, undefined, activities);
    await expect(authority.withCurrent(service, reference, async () => "effect")).rejects.toMatchObject({ code: "factory_command_stale" });
    await expect(taskAdmission.request(service, reference)).rejects.toMatchObject({ code: "factory_command_stale" });
    const dispatch = next.commands.find(command => command.kind === "dispatch-node")!;
    const currentReference = { ...identity, commandId: dispatch.id };
    await expect(taskAdmission.request(service, currentReference)).rejects.toMatchObject({ code: "factory_command_forbidden" });
    expect(await authority.withCurrent(service, currentReference, async (_transaction, context) => factoryTaskReservationId(currentReference, context))).toBe(reserved.reservationId);
    expect(await authority.withCurrent(service, currentReference, async (_transaction, context) => context.command)).toEqual(dispatch);
    const mutable = { ...currentReference };
    const pending = authority.withCurrent(service, mutable, async (_transaction, context) => context.command.id);
    mutable.commandId = "caller-changed-command";
    expect(await pending).toBe(dispatch.id);
    const originalLoad = transitions.loadCommittedTransition.bind(transitions);
    const raced = spyOn(transitions, "loadCommittedTransition").mockImplementationOnce(async (...args) => {
      const loaded = await originalLoad(...args);
      await persistTransition(identity, 3, { kind: "timer-expired", id: "authority-concurrent", atMs: now + 2, commandId: "unrelated" }, next.nextState, [], undefined, activities);
      return loaded;
    });
    try { await expect(authority.withCurrent(service, currentReference, async () => "effect")).rejects.toMatchObject({ code: "factory_command_stale" }); }
    finally { raced.mockRestore(); }
    const expired = new FactoryCommandAuthority(fixture.db, tenantId, lifecycle, transitions, ["orchestration"], () => admission.deadlineAtMs);
    await expect(expired.withCurrent(service, currentReference, async () => "effect")).rejects.toMatchObject({ code: "factory_command_stale" });
    await cancelRun(principal, runKey(run.runId), run.revision, "authority-cancel");
    await expect(authority.withCurrent(service, currentReference, async () => "effect")).rejects.toMatchObject({ code: "factory_run_stopped" });
    const projector = new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle);
    expect(await projector.project(runKey(run.runId), 8)).toMatchObject({ sequence: 3, lag: 0 });
  });

  test("compute admission commits only under the actual current command authority", async () => {
    const { run, transitions, compiled, profile, authority, admissions, journal, queue, service, reserved, lease, dispatch, dispatchReference } = await dispatchedTask();
    const taskNode = compiled.indexes.nodeById[dispatch.nodeId];
    if (taskNode?.kind !== "task") throw new Error("fixture dispatch task is missing");
    const nativeProfile: FactoryNativeRunnerProfile = { runner: taskNode.runner, resourceClass: "cpu", allocation: profile, allowedCapabilities: ["llm"], tools: [
      { declaration: { name: "read_snapshot", inputSchema: { type: "object" } }, requiredCapabilities: [] },
      { declaration: { name: "audit_snapshot", inputSchema: { type: "object" } }, requiredCapabilities: [] },
      { declaration: { name: "model_snapshot", inputSchema: { type: "object" } }, requiredCapabilities: ["llm"] },
    ] };
    const authorizations: Array<{ principal: FactoryPrincipal; projectId: string; action: string; revision?: number }> = [];
    const observedGrants = { tenantId, async authorizeInTransaction(...args: Parameters<FactoryGrants["authorizeInTransaction"]>) {
      authorizations.push({ principal: args[1], projectId: args[2], action: args[3], ...(args[4] === undefined ? {} : { revision: args[4] }) });
      return grants.authorizeInTransaction(...args);
    } };
    const policy = new FactoryNativeRunnerPolicy(tenantId, observedGrants, [nativeProfile], "factory-broker");
    await authority.withCurrent(service, dispatchReference, async (transaction, context) => {
      if (context.command.kind !== "dispatch-node") throw new Error("fixture dispatch command changed");
      const compute = await admissions.readAdmittedInTransaction(transaction, { projectId, runId: run.runId, reservationId: reserved.reservationId });
      const policyInput = { reference: dispatchReference, command: context.command, context, initiator: context.initiator, compute };
      expect(await policy.resolveInTransaction(transaction, policyInput)).toMatchObject({ grants: [], resources: { resourceClass: "cpu", memoryBytes: 128, maxCostMicros: "5", maxTokens: 6, maxComputeMs: 7 }, tools: [{ name: "audit_snapshot" }, { name: "read_snapshot" }], brokerAudience: "factory-broker" });
      expect(() => new FactoryNativeRunnerPolicy(tenantId, grants, [], "factory-broker")).toThrow("factory_native_policy_invalid");
      expect(() => new FactoryNativeRunnerPolicy(tenantId, { tenantId: "foreign-tenant", authorizeInTransaction: grants.authorizeInTransaction.bind(grants) }, [nativeProfile], "factory-broker")).toThrow("factory_native_policy_invalid");
      expect(() => new FactoryNativeRunnerPolicy(tenantId, grants, [nativeProfile, nativeProfile], "factory-broker")).toThrow("factory_native_policy_invalid");
      expect(() => new FactoryNativeRunnerPolicy(tenantId, grants, [{ ...nativeProfile, allocation: { ...profile, memoryBytes: 0 } }], "factory-broker")).toThrow("factory_native_policy_invalid");
      expect(() => new FactoryNativeRunnerPolicy(tenantId, grants, [{ ...nativeProfile, allowedCapabilities: ["llm", "llm"] }], "factory-broker")).toThrow("factory_native_policy_invalid");
      expect(() => new FactoryNativeRunnerPolicy(tenantId, grants, [{ ...nativeProfile, tools: [{ declaration: { name: "outside", inputSchema: {} }, requiredCapabilities: ["network"] }] }], "factory-broker")).toThrow("factory_native_policy_invalid");
      const unavailable = new FactoryNativeRunnerPolicy(tenantId, grants, [{ ...nativeProfile, runner: { ...nativeProfile.runner, export: "other" } }], "factory-broker");
      await expect(unavailable.resolveInTransaction(transaction, policyInput)).rejects.toMatchObject({ code: "factory_native_package_untrusted" });
      await expect(policy.resolveInTransaction(transaction, { ...policyInput, reference: { ...dispatchReference, tenantId: "foreign-tenant" } })).rejects.toMatchObject({ code: "factory_native_policy_scope" });
      const deniedResources = new FactoryNativeRunnerPolicy(tenantId, grants, [{ ...nativeProfile, allocation: { ...profile, memoryBytes: 127 } }], "factory-broker");
      await expect(deniedResources.resolveInTransaction(transaction, policyInput)).rejects.toMatchObject({ code: "factory_native_resource_denied" });
      const capabilityContext = { ...context, compiled: { ...context.compiled, definition: { ...context.compiled.definition, capabilities: ["llm"] } }, node: { ...context.node, capabilities: ["llm"] } };
      expect(await policy.resolveInTransaction(transaction, { ...policyInput, context: capabilityContext })).toMatchObject({ grants: ["llm"], tools: [{ name: "audit_snapshot" }, { name: "model_snapshot" }, { name: "read_snapshot" }] });
      const configuration = { temperature: 0 };
      const modelPolicy = { retries: 0 };
      const configurationDigest = `sha256:${digestObject(configuration)}`;
      const modeledRunner = { ...context.node.runner, model: "factory-model", configurationDigest };
      const model = { provider: "factory-broker", model: "factory-model", configurationDigest, configuration, policyDigest: `sha256:${digestObject(modelPolicy)}`, policy: modelPolicy };
      const modeledProfile = { ...nativeProfile, runner: modeledRunner, model };
      const modeledContext = { ...context, node: { ...context.node, runner: modeledRunner } };
      const modeled = new FactoryNativeRunnerPolicy(tenantId, grants, [modeledProfile], "factory-broker");
      const modeledResolution = await modeled.resolveInTransaction(transaction, { ...policyInput, context: modeledContext });
      expect(modeledResolution).toMatchObject({ model });
      const modeledSnapshot = encodeFactoryPayload(modeledResolution);
      expect(() => { (modeledResolution.model!.policy as Record<string, JsonValue>).retries = 1; }).toThrow();
      expect(() => { (modeledResolution.tools[0]!.inputSchema as { type?: string }).type = "string"; }).toThrow();
      expect(encodeFactoryPayload(await modeled.resolveInTransaction(transaction, { ...policyInput, context: modeledContext }))).toBe(modeledSnapshot);
      const deniedModel = new FactoryNativeRunnerPolicy(tenantId, grants, [{ ...modeledProfile, model: { ...model, policyDigest: `sha256:${"f".repeat(64)}` } }], "factory-broker");
      await expect(deniedModel.resolveInTransaction(transaction, { ...policyInput, context: modeledContext })).rejects.toMatchObject({ code: "factory_native_model_denied" });

      let authorizeStarted!: () => void;
      let continueAuthorize!: () => void;
      const started = new Promise<void>(resolve => { authorizeStarted = resolve; });
      const continuation = new Promise<void>(resolve => { continueAuthorize = resolve; });
      const delayed = new FactoryNativeRunnerPolicy(tenantId, { tenantId, async authorizeInTransaction(...args) {
        authorizeStarted();
        await continuation;
        return grants.authorizeInTransaction(...args);
      } }, [nativeProfile], "factory-broker");
      const mutableInput = structuredClone(policyInput);
      const delayedResolution = delayed.resolveInTransaction(transaction, mutableInput);
      await started;
      (mutableInput.reference as { projectId: string }).projectId = "mutated-project";
      (mutableInput.initiator as { id: string }).id = "mutated-principal";
      (mutableInput.compute.request as { memoryBytes: number }).memoryBytes += 1;
      (mutableInput.context.node as { capabilities?: string[] }).capabilities = ["mutated-capability"];
      continueAuthorize();
      expect(await delayedResolution).toMatchObject({ resources: { memoryBytes: 128 }, grants: [] });
    });
    const execution = new FactoryTaskExecutionAdmission(authority, admissions, journal, queue, policy, () => now);
    await fixture.db.execute(sql`ALTER TABLE factory_attempt_queue ADD CONSTRAINT task_execution_forced_rollback CHECK (FALSE) NOT VALID`);
    try { await expect(execution.admit(service, dispatchReference)).rejects.toThrow(); }
    finally { await fixture.db.execute(sql`ALTER TABLE factory_attempt_queue DROP CONSTRAINT task_execution_forced_rollback`); }
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_executions WHERE attempt_id=${dispatch.id}`))).toHaveLength(0);
    const [result, concurrent] = await Promise.all([execution.admit(service, dispatchReference), execution.admit(service, dispatchReference)]);
    expect(result).toMatchObject({ reservationId: reserved.reservationId, delivery: { state: "queued", reference: { attemptId: dispatch.id, reservationGeneration: 1 } }, request: { authority: { attemptId: dispatch.id, nextOperationIndex: 0, deadlineAtMs: lease.deadlineAt.getTime() }, resources: { resourceClass: "cpu", memoryBytes: 128, maxCostMicros: "5", maxTokens: 6, maxComputeMs: 7 }, tools: [{ name: "audit_snapshot" }, { name: "read_snapshot" }], broker: { audience: "factory-broker" } } });
    expect(concurrent.request).toEqual(result.request);
    expect("attemptToken" in result.request.broker).toBe(false);
    expect(authorizations.at(-1)).toEqual({ principal: { kind: "user", id: principal.id, authentication: "api-key" }, projectId, action: "factory.run", revision: body.grantRevision });
    await fixture.db.execute(sql`UPDATE factory_execution_operation_cursors SET next_operation_index=7 WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND node_instance_id=${dispatch.nodeId} AND candidate_generation=${dispatch.candidateGeneration}`);
    const replayed = await execution.admit(service, dispatchReference);
    expect(replayed.request).toEqual(result.request);
    expect(replayed.delivery.reference).toEqual(result.delivery.reference);
    expect(replayed.reservationId).toBe(result.reservationId);
    const changedPolicy = new FactoryNativeRunnerPolicy(tenantId, grants, [nativeProfile], "changed-broker");
    await expect(new FactoryTaskExecutionAdmission(authority, admissions, journal, queue, changedPolicy, () => now).admit(service, dispatchReference)).rejects.toMatchObject({ code: "factory_task_execution_conflict" });
    await expect(execution.admit(service, { ...dispatchReference, projectId: "foreign-project" })).rejects.toThrow("factory_transition_command_not_found");
    now = lease.deadlineAt.getTime();
    await expect(execution.admit(service, dispatchReference)).rejects.toMatchObject({ code: "factory_run_fence_changed" });
    now -= 1;
    expect(await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId))).toMatchObject({ sequence: 2, lag: 0 });
    await cancelRun(principal, runKey(run.runId), run.revision, `execution-cancel-${run.runId}`);
    await expect(execution.admit(service, dispatchReference)).rejects.toMatchObject({ code: "factory_run_stopped" });
  });

  test("successful task completion commits measured spend and one durable result, with exact recovery", async () => {
    const { task, completions, authority, result, value } = await completedTask();
    expect(await fixture.db.transaction(tx => completions.readInTransaction(tx, task.service, task.dispatchReference))).toBeUndefined();
    await expect(fixture.db.transaction(tx => completions.readInTransaction(tx, task.service, { ...task.dispatchReference, tenantId: "foreign" }))).rejects.toMatchObject({ code: "factory_task_completion_scope" });
    await expect(fixture.db.transaction(tx => completions.readInTransaction(tx, task.service, { ...task.dispatchReference, logicalRunId: "missing-run" }))).rejects.toMatchObject({ code: "factory_task_completion_scope" });
    now--;
    try { await expect(completions.complete(task.service, task.dispatchReference, result)).rejects.toMatchObject({ code: "factory_task_completion_expired" }); }
    finally { now++; }
    for (const table of ["factory_task_completions", "factory_inbox_events", "factory_budget_reservations"]) {
      await fixture.db.execute(sql`ALTER TABLE ${sql.identifier(table)} ADD CONSTRAINT task_completion_rollback CHECK (FALSE) NOT VALID`);
      try { await expect(completions.complete(task.service, task.dispatchReference, result)).rejects.toThrow(); }
      finally { await fixture.db.execute(sql`ALTER TABLE ${sql.identifier(table)} DROP CONSTRAINT task_completion_rollback`); }
      expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_execution_terminals WHERE attempt_id=${task.dispatch.id}`))).toHaveLength(0);
      expect(await lifecycle.budgets.inspect({ projectId, runId: task.run.runId, envelopeId: "root" })).toMatchObject({ allocated: { costMicros: "5" }, spent: { costMicros: "0" } });
    }
    await expect(completions.complete(task.service, task.dispatchReference, { ...result, usage: { ...result.usage, costMicros: "5" } })).rejects.toThrow("measured usage");
    const [completed, raced] = await Promise.all([completions.complete(task.service, task.dispatchReference, result), completions.complete(task.service, task.dispatchReference, result)]);
    expect(raced).toEqual(completed);
    expect(await fixture.db.transaction(tx => completions.readInTransaction(tx, task.service, task.dispatchReference))).toEqual(completed);
    expect(await fixture.db.transaction(tx => completions.readVerifiedInTransaction(tx, task.service, task.dispatchReference))).toEqual({ receipt: completed, authority, result });
    const protectedCompletion = rows<{ authority_json: string }>(await fixture.db.execute(sql`SELECT authority_json FROM factory_task_completions WHERE attempt_id=${task.dispatch.id}`))[0]!;
    await fixture.db.execute(sql`UPDATE factory_task_completions SET authority_json='{}' WHERE attempt_id=${task.dispatch.id}`);
    try { await expect(fixture.db.transaction(tx => completions.readVerifiedInTransaction(tx, task.service, task.dispatchReference))).rejects.toMatchObject({ code: "factory_task_completion_corrupt" }); }
    finally { await fixture.db.execute(sql`UPDATE factory_task_completions SET authority_json=${protectedCompletion.authority_json} WHERE attempt_id=${task.dispatch.id}`); }
    const terminalResult = rows<{ result_digest: string }>(await fixture.db.execute(sql`SELECT result_digest FROM factory_execution_terminals WHERE attempt_id=${task.dispatch.id}`))[0]!;
    await fixture.db.execute(sql`UPDATE factory_execution_terminals SET result_digest=${"f".repeat(64)} WHERE attempt_id=${task.dispatch.id}`);
    try { await expect(fixture.db.transaction(tx => completions.readVerifiedInTransaction(tx, task.service, task.dispatchReference))).rejects.toThrow(); }
    finally { await fixture.db.execute(sql`UPDATE factory_execution_terminals SET result_digest=${terminalResult.result_digest} WHERE attempt_id=${task.dispatch.id}`); }
    expect(completed.event).toMatchObject({ kind: "node-result", commandId: task.dispatch.id, nodeId: task.dispatch.nodeId, candidateGeneration: 0, output: value });
    expect(await lifecycle.budgets.inspect({ projectId, runId: task.run.runId, envelopeId: "root" })).toMatchObject({ allocated: { costMicros: "0", tokens: "0", computeMs: "0" }, spent: { costMicros: "4", tokens: "3", computeMs: "3" } });
    const advanced = await persistCompletedTask(task, completed);
    expect(advanced.nextState.nodes[task.dispatch.nodeId]?.status).toBe("succeeded");
    expect(await completions.complete(task.service, task.dispatchReference, result)).toEqual(completed);
    await expect(completions.complete(task.service, task.dispatchReference, { ...result, resultDigest: "e".repeat(64) })).rejects.toMatchObject({ code: "factory_task_completion_conflict" });
    const receipt = rows<{ receipt_json: string }>(await fixture.db.execute(sql`SELECT receipt_json FROM factory_task_completions WHERE attempt_id=${task.dispatch.id}`))[0]!;
    await fixture.db.execute(sql`UPDATE factory_task_completions SET receipt_json='{}' WHERE attempt_id=${task.dispatch.id}`);
    try { await expect(completions.complete(task.service, task.dispatchReference, result)).rejects.toMatchObject({ code: "factory_task_completion_corrupt" }); }
    finally { await fixture.db.execute(sql`UPDATE factory_task_completions SET receipt_json=${receipt.receipt_json} WHERE attempt_id=${task.dispatch.id}`); }
    expect(rows(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${task.run.runId} AND event_id=${completed.event.id}`))).toHaveLength(1);
    const completionDelivery = await task.queue.read(projectId, task.dispatch.id);
    if (!completionDelivery) throw new Error("completed attempt queue row is missing");
    await fixture.db.transaction(transaction => task.queue.recoverDeliveredInTransaction(transaction, completionDelivery));
  });

  /**
   * Builds one whole protected acceptance: a completed candidate, a pinned validator runtime, a
   * human-approved contract, and a bound validator attempt whose report carries `passed`.
   *
   * Both the accepted and the rejected path need every one of those facts, so they share this
   * rather than keeping two copies that could drift apart.
   */
  async function protectedAcceptance(passed: boolean, bindValidator = true) {
    const candidateRunner = referenceCodeV1.graph.nodes.find(node => node.id === "snapshot-repository");
    const releaseNode = referenceCodeV1.graph.nodes.find(node => node.id === "github-pr-release");
    const claim = referenceCodeV1.acceptance.claims[0]!;
    if (candidateRunner?.kind !== "task" || releaseNode?.kind !== "release") throw new Error("protected fixture runners are missing");
    const artifactPort = { type: "object" as const, additionalProperties: true };
    const definitionKey = { projectId, factoryId: `protected-effects-${++sequence}` };
    const source: FactoryDefinition = {
      ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, inputPorts: {}, outputPorts: { receipt: artifactPort },
      acceptance: { id: `${definitionKey.factoryId}.contract`, version: referenceCodeV1.acceptance.version, claims: [claim] },
      graph: { nodes: [
        { id: "candidate", kind: "task", runner: candidateRunner.runner, outputPorts: { candidate: artifactPort }, effects: ["write"] },
        { id: "accept", kind: "acceptance", dependsOn: ["candidate"], contract: `${definitionKey.factoryId}.contract`, candidate: { kind: "ref", root: "node", name: "candidate", path: ["candidate"] }, evidence: { kind: "literal", value: [] }, outputPorts: { acceptedCandidate: artifactPort } },
        { id: "release", kind: "release", dependsOn: ["accept"], adapter: releaseNode.adapter, acceptedCandidate: { kind: "ref", root: "node", name: "accept", path: ["acceptedCandidate"] }, destination: { kind: "literal", value: { target: "protected" } }, effects: ["publish"], outputPorts: { receipt: artifactPort } },
      ], outputs: { receipt: { kind: "ref", root: "node", name: "release", path: ["receipt"] } } },
    };
    await definitions.save(principal, definitionKey, 0, `protected-definition-${sequence}`, source);
    const version = await definitions.publish(principal, definitionKey, 1, `protected-publish-${sequence}`);
    const request: FactoryRunStartBody = { factoryVersion: version.version, definitionDigest: version.definitionDigest, grantRevision: 1, parameters: {} };
    const candidate = { digest: `sha256:${"7".repeat(64)}`, mediaType: "application/json", storage: "protected" };
    const completed = await completedTask({ candidate }, definitionKey, request);
    const completion = await completed.completions.complete(completed.task.service, completed.task.dispatchReference, completed.result);
    const completionDelivery = await completed.task.queue.read(projectId, completed.task.dispatch.id);
    if (!completionDelivery) throw new Error("protected completion delivery is missing");
    await fixture.db.transaction(transaction => completed.task.queue.recoverDeliveredInTransaction(transaction, completionDelivery));
    const candidateAdvanced = await persistCompletedTask(completed.task, completion);
    const acceptanceCommand = candidateAdvanced.commands.find(command => command.kind === "request-acceptance");
    if (acceptanceCommand?.kind !== "request-acceptance") throw new Error("protected acceptance command is missing");
    const acceptanceReference = { ...completed.task.identity, commandId: acceptanceCommand.id };

    const releaseAuthority = new FactoryReleaseAuthorityStore(fixture.db, tenantId, grants, lifecycle, completed.task.journal, completed.artifacts);
    const runtime = { runner: claim.validator, resources: { maxComputeMs: 1_000 }, brokerAudience: "trusted-validator", environmentDigest: `sha256:${"8".repeat(64)}`, configurationDigest: claim.validator.configurationDigest!, maxEvidenceAgeMs: 60_000 };
    const validators = new FactoryTrustedValidators(fixture.db, tenantId, lifecycle, completed.task.journal, completed.artifacts, releaseAuthority, [runtime]);
    const material = await fixture.db.transaction(transaction => validators.registerMaterialInTransaction(transaction, projectId, completed.task.compiled));
    // Trust and release enablement are per project, so a second fixture in the same project
    // advances the current revision and epoch rather than assuming it is the first.
    const currentTrust = rows<{ revision: number | string }>(await fixture.db.execute(sql`SELECT revision FROM factory_release_trust_current WHERE tenant_id=${tenantId} AND project_id=${projectId}`))[0];
    await releaseAuthority.publishTrust(principal, { projectId, expectedRevision: Number(currentTrust?.revision ?? 0), packageLock: candidateRunner.runner, validatorTrustDigest: material.validatorLockDigest }, `protected-trust-${sequence}`);
    const currentControl = rows<{ enabled: boolean; enable_epoch: number | string }>(await fixture.db.execute(sql`SELECT enabled, enable_epoch FROM factory_release_controls WHERE tenant_id=${tenantId} AND project_id=${projectId}`))[0];
    if (!currentControl?.enabled) await releaseAuthority.setReleaseEnabled(principal, projectId, true, Number(currentControl?.enable_epoch ?? 0), `protected-enable-${sequence}`);
    await fixture.db.transaction(transaction => releaseAuthority.completeCurrentCandidateInTransaction(transaction, { authority: completed.authority, result: completed.result, expectedCurrentGeneration: null }));

    const candidateKey = { projectId, runId: completed.task.run.runId, nodeInstanceId: completed.task.dispatch.nodeId, candidateGeneration: 0 };
    const validatorBase = { attemptId: `protected-validator-${sequence}`, tenantId, projectId, runId: completed.task.run.runId, nodeInstanceId: `protected-validator-node-${sequence}`, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, deadlineAt: new Date(now + 60_000) };
    const { deadlineAt, ...wire } = validatorBase;
    const validatorRequest: FactoryRunnerRequest = { schemaVersion: "factory.runner.request.v1", authority: { ...wire, deadlineAtMs: deadlineAt.getTime(), nextOperationIndex: 0 }, runner: runtime.runner, input: { kind: "artifact", artifact: completed.result.output }, grants: [], resources: runtime.resources, tools: [], broker: { attemptToken: "protected-validator-token", audience: runtime.brokerAudience } };
    const validatorAdmission = { ...validatorBase, request: validatorRequest, requestDigest: factoryRunnerRequestDigest(validatorRequest) };
    if (bindValidator) await completed.task.journal.admit(validatorAdmission);
    if (bindValidator) await fixture.db.transaction(transaction => validators.bindAttemptInTransaction(transaction, { candidate: candidateKey, validatorId: claim.id, authority: validatorAdmission }));
    if (bindValidator) await fixture.db.transaction(async transaction => {
      const { artifactJson } = await import("../../factory/artifacts");
      const output = await completed.artifacts.stageCandidateOutputInTransaction(transaction, completed.task.identity, validatorAdmission.nodeInstanceId, 0, artifactJson.canonical({ schemaVersion: "factory.validator-claims.v1", claims: [{ id: claim.id, verdict: passed ? "PASS" : "FAIL", decisive: true, summary: `${claim.id} report`, reasonCode: passed ? "pass" : "fail", evidence: [], measuredAtMs: now }] }));
      const result: Extract<FactoryRunnerResult, { status: "completed" }> = { schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor: -1, operations: [], resultDigest: output.digest.slice(7), output, usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" }, workspaceCheckpoint: { ...output, journalCursor: -1 } };
      await completed.task.journal.recordCompletedTerminalInTransaction(transaction, validatorAdmission, result, completed.artifacts);
    });
    const fenceReader = { async readCurrentInTransaction(transaction: import("../../db/migrations/types").MigrationDb, expectedTenant: string, expectedProject: string, runId: string) {
      if (expectedTenant !== tenantId || expectedProject !== projectId) throw new Error("protected fence scope mismatch");
      const fence = await lifecycle.authorizeRunInTransaction(transaction, { projectId, runId });
      return { runId, executionEpoch: fence.executionEpoch, cancellationEpoch: fence.cancellationEpoch, status: fence.status, deadlineMs: fence.deadlineAtMs };
    } };
    const assurance = new FactoryAssurance(fixture.db, tenantId, grants, validators, fenceReader, validators, Date.now);
    await assurance.approveContract(principal, { projectId, contractId: material.contractId, revision: 1, contractDigest: material.contractDigest, validatorLockDigest: material.validatorLockDigest, mandatoryClaims: material.mandatoryClaims, claimGroups: material.claimGroups }, `protected-contract-${sequence}`);
    const archive = new Map<string, Uint8Array>();
    const releases = new FactoryReleases(fixture.db, tenantId, grants, assurance, releaseAuthority, releaseAuthority,
      { async reserveInTransaction() { throw new Error("release dispatch is outside this protected prepare test"); } },
      { async writeImmutable(_tenant, operationId, name, bytes) { const key = `${operationId}/${name}`; archive.set(key, bytes.slice()); return { key, digest: `sha256:${digestBytes(bytes)}` }; }, async read(reference) { const bytes = archive.get(reference.key); if (!bytes) throw new Error("archive is missing"); return bytes.slice(); } },
      { async proveStopped() { return false; } }, Date.now);
    const effects = new FactoryProtectedCommandEffects(fixture.db, tenantId, completed.task.authority, completed.completions, releaseAuthority, assurance, releases, [factorySynchronousReleaseProfile({ adapter: releaseNode.adapter, action: "publish", build(input) { return { destination: { provider: "test", account: "protected", object: "result" }, request: { acceptedCandidate: input.acceptedCandidate, destination: input.destination }, estimatedSpendMicros: 42 }; } })]);
    return { effects, completed, acceptanceReference, acceptanceCommand, candidateAdvanced, candidate, releaseNode, releaseAuthority, assurance, releases, claim, validators, material, candidateKey, runtime, validatorAdmission };
  }

  test("protected acceptance and release use exact completed, trusted, and committed facts", async () => {
    const { effects, completed, acceptanceReference, acceptanceCommand, candidateAdvanced, candidate, releaseNode, releaseAuthority, assurance, releases } = await protectedAcceptance(true);
    const accepted = await effects.requestAcceptance(completed.task.service, acceptanceReference);
    expect(await effects.requestAcceptance(completed.task.service, acceptanceReference)).toEqual(accepted);
    expect(accepted).toMatchObject({ nodeId: "accept", commandId: acceptanceCommand.id, output: { acceptedCandidate: candidate } });
    const acceptedAdvanced = advanceKernel(completed.task.compiled, candidateAdvanced.nextState, accepted);
    await persistTransition(completed.task.identity, 4, accepted, acceptedAdvanced.nextState, acceptedAdvanced.commands, undefined, completed.task.activities);
    await new FactoryRunTransitionProjector(fixture.db, tenantId, completed.task.transitions, lifecycle).project(runKey(completed.task.run.runId), 8);
    const releaseCommand = acceptedAdvanced.commands.find(command => command.kind === "request-release");
    if (releaseCommand?.kind !== "request-release") throw new Error("protected release command is missing");
    const releaseReference = { ...completed.task.identity, commandId: releaseCommand.id };
    const noProfile = new FactoryProtectedCommandEffects(fixture.db, tenantId, completed.task.authority, completed.completions, releaseAuthority, assurance, releases, []);
    await expect(noProfile.requestRelease(completed.task.service, releaseReference)).rejects.toMatchObject({ code: "factory_protected_effect_untrusted" });
    expect(() => new FactoryProtectedCommandEffects(fixture.db, "foreign-tenant", completed.task.authority, completed.completions, releaseAuthority, assurance, releases, [])).toThrow();
    const profile = factorySynchronousReleaseProfile({ adapter: releaseNode.adapter, action: "publish", build() { return { destination: { provider: "test", account: "protected", object: "result" }, request: {}, estimatedSpendMicros: 1 }; } });
    expect(() => new FactoryProtectedCommandEffects(fixture.db, tenantId, completed.task.authority, completed.completions, releaseAuthority, assurance, releases, [profile, profile])).toThrow("factory_protected_effect_invalid");
    expect(await effects.requestRelease(completed.task.service, releaseReference)).toBeNull();
    expect(await effects.requestRelease(completed.task.service, releaseReference)).toBeNull();
    expect(rows<{ estimated_spend_micros: number | string; action: string }>(await fixture.db.execute(sql`SELECT estimated_spend_micros,action FROM factory_release_operations WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${completed.task.run.runId}`)).map(row => ({ ...row, estimated_spend_micros: Number(row.estimated_spend_micros) }))).toEqual([{ estimated_spend_micros: 42, action: "publish" }]);
    expect(rows(await fixture.db.execute(sql`SELECT kind FROM factory_protected_command_effects WHERE run_id=${completed.task.run.runId} ORDER BY kind`))).toEqual([{ kind: "request-acceptance" }, { kind: "request-release" }]);
    await new FactoryRunTransitionProjector(fixture.db, tenantId, completed.task.transitions, lifecycle).project(runKey(completed.task.run.runId));
    await expect(effects.requestAcceptance({ ...completed.task.service, subject: "foreign-service" }, acceptanceReference)).rejects.toThrow();
    await fixture.db.execute(sql`UPDATE factory_protected_command_effects SET receipt_digest=${`sha256:${"0".repeat(64)}`} WHERE command_id=${acceptanceCommand.id}`);
    await expect(effects.requestAcceptance(completed.task.service, acceptanceReference)).rejects.toMatchObject({ code: "factory_protected_effect_corrupt" });
  });

  test("a failing required claim becomes a durable rejection and a kernel failure, never a thrown activity", async () => {
    const { effects, completed, acceptanceReference, acceptanceCommand, candidateAdvanced, claim } = await protectedAcceptance(false);
    const rejected = await effects.requestAcceptance(completed.task.service, acceptanceReference);
    expect(rejected).toMatchObject({ kind: "node-failed", nodeId: "accept", commandId: acceptanceCommand.id, failureKind: "acceptance_rejected", error: "factory_assurance_claim_failed" });
    // The same command replays to the same durable fact instead of running the contract again.
    expect(await effects.requestAcceptance(completed.task.service, acceptanceReference)).toEqual(rejected);

    const stored = rows<{ decision: string; receipt_json: string }>(await fixture.db.execute(sql`SELECT decision, receipt_json FROM factory_protected_command_effects WHERE run_id=${completed.task.run.runId} AND command_id=${acceptanceCommand.id}`));
    expect(stored.map(row => row.decision)).toEqual(["rejected"]);
    const receipt = JSON.parse(stored[0]!.receipt_json) as { outcome: string; failures: { claimId: string; validatorId: string; verdict: string; reasonCode: string }[]; groupFailures: unknown[]; candidateDigest: string };
    expect(receipt.outcome).toBe("rejected");
    expect(receipt.failures).toEqual([{ claimId: claim.id, validatorId: claim.id, verdict: "FAIL", reasonCode: "claim_failed" }]);
    expect(receipt.groupFailures).toEqual([]);
    expect(receipt.candidateDigest).toBe(completed.result.output.digest);
    // No acceptance decision exists, so nothing downstream can claim release authority.
    expect(rows(await fixture.db.execute(sql`SELECT decision_id FROM factory_acceptance_decisions WHERE tenant_id=${tenantId} AND run_id=${completed.task.run.runId}`))).toEqual([]);

    // The rejection reaches the kernel as an ordinary node failure and never as a success.
    const advanced = advanceKernel(completed.task.compiled, candidateAdvanced.nextState, rejected);
    expect(advanced.nextState.nodes.accept?.status).not.toBe("succeeded");
    // An acceptance node has no physical attempt, so the kernel answers a rejection with a bounded
    // remediation wait or an exhausted bound, never with a cancel-node the gateway cannot resolve.
    expect(advanced.commands.filter(command => command.kind === "cancel-node")).toEqual([]);
    expect(advanced.nextState.nodes.accept?.status).toBe("failed");
    expect(advanced.nextState.nodes.accept?.error).toBe("ACCEPTANCE_BOUND_EXHAUSTED");
  });

  test("a missing protected validator is scheduled through durable admission with one reservation per identity", async () => {
    const { completed, acceptanceReference, acceptanceCommand, candidateKey, validators, material, runtime } = await protectedAcceptance(true, false);
    const service = completed.task.service;
    const scheduler = new FactoryProtectedValidatorScheduler(tenantId, completed.task.authority, validators, lifecycle.budgets, completed.task.admissions, completed.task.journal, completed.task.queue, {
      async resolveInTransaction() { return { envelopeId: "root", amount: { costMicros: "3", tokens: 2, computeMs: 4 }, resources: { cpu: 1 }, memoryBytes: 64 }; },
    }, () => now);

    const planned = await fixture.db.transaction(transaction => scheduler.planInTransaction(transaction, service, acceptanceReference));
    expect(planned).toHaveLength(1);
    const schedule = planned[0]!;
    expect(schedule.origin).toMatchObject({ kind: "protected-validator", acceptanceCommandId: acceptanceCommand.id, candidate: candidateKey, validatorIds: [material.mandatoryClaims[0]!.validatorId], validatorLockDigest: material.validatorLockDigest });
    expect(schedule.runtime).toMatchObject({ validatorId: material.mandatoryClaims[0]!.validatorId, runner: runtime.runner, brokerAudience: runtime.brokerAudience });
    // The acceptance command reveals the need; it is never the attempt that satisfies it.
    expect(schedule.attemptId).not.toBe(acceptanceCommand.id);
    expect(schedule.attemptId).toStartWith("factory-validator-attempt:");
    expect(schedule.nodeInstanceId).not.toBe(candidateKey.nodeInstanceId);
    // A protected-validator origin can never stand in for a committed transition command.
    expect(() => assertFactoryDispatchNodeOrigin(schedule.origin)).toThrow("factory_admission_origin_forbidden");

    expect(await fixture.db.transaction(transaction => scheduler.reserveInTransaction(transaction, service, acceptanceReference, schedule))).toEqual({ created: true });
    // A repeated schedule, a lost pool response, and a restart all converge on this one reservation.
    expect(await fixture.db.transaction(transaction => scheduler.reserveInTransaction(transaction, service, acceptanceReference, schedule))).toEqual({ created: false });
    await Promise.all([
      fixture.db.transaction(transaction => scheduler.reserveInTransaction(transaction, service, acceptanceReference, schedule)),
      fixture.db.transaction(transaction => scheduler.reserveInTransaction(transaction, service, acceptanceReference, schedule)),
    ]);
    const reservations = rows<{ reservation_id: string; state: string; origin_kind: string }>(await fixture.db.execute(sql`SELECT reservation_id,state,origin_kind FROM factory_budget_reservations WHERE tenant_id=${tenantId} AND run_id=${completed.task.run.runId} AND origin_kind='protected-validator'`));
    expect(reservations).toEqual([{ reservation_id: schedule.reservationId, state: "held", origin_kind: "protected-validator" }]);
    const admissions = rows<{ reservation_id: string; origin_kind: string; origin_digest: string; origin_json: string }>(await fixture.db.execute(sql`SELECT reservation_id,origin_kind,origin_digest,origin_json FROM factory_compute_admissions WHERE tenant_id=${tenantId} AND run_id=${completed.task.run.runId} AND origin_kind='protected-validator'`));
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({ reservation_id: schedule.reservationId, origin_digest: factoryAdmissionOriginDigest(schedule.origin) });
    expect(JSON.parse(admissions[0]!.origin_json)).toEqual(schedule.origin);

    // The schedule is only actionable under the exact acceptance command that produced it.
    const foreign = { ...schedule, origin: { ...schedule.origin, acceptanceCommandId: "another-acceptance-command" } };
    await expect(fixture.db.transaction(transaction => scheduler.reserveInTransaction(transaction, service, acceptanceReference, foreign))).rejects.toMatchObject({ code: "factory_validator_schedule_stale" });
    const rekeyed = { ...schedule, reservationId: "factory-reservation:rekeyed" };
    await expect(fixture.db.transaction(transaction => scheduler.reserveInTransaction(transaction, service, acceptanceReference, rekeyed))).rejects.toMatchObject({ code: "factory_validator_schedule_invalid" });
    expect(() => new FactoryProtectedValidatorScheduler("foreign-tenant", completed.task.authority, validators, lifecycle.budgets, completed.task.admissions, completed.task.journal, completed.task.queue, { async resolveInTransaction() { throw new Error("unused"); } }, () => now)).toThrow();

    // The pool admits the validator identity. It carries no kernel event: no node awaits one.
    // The lease must return the exact normalized vector the enlisted request carries.
    const enlisted = JSON.parse(rows<{ request_json: string }>(await fixture.db.execute(sql`SELECT request_json FROM factory_compute_admissions WHERE tenant_id=${tenantId} AND reservation_id=${schedule.reservationId}`))[0]!.request_json) as { request: { resources: Record<string, number> } };
    const lease = { reservationId: schedule.reservationId, tenantId, grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "validator-allocation", fence: "validator-fence", deadlineAt: new Date(now + 30_000), resources: enlisted.request.resources, hostId: "host-validator" };
    let polls = 0;
    const pool = { async request() { polls += 1; return { status: "admitted" as const, reservationId: schedule.reservationId, lease }; }, async status() { return undefined; }, async cancel() { throw new Error("unexpected cancellation"); }, async acknowledgeStart() { throw new Error("unused"); }, async renew() { throw new Error("unused"); } } satisfies PoolAdmissionClient;
    const validatorAdmissions = new FactoryComputeAdmissions(fixture.db, tenantId, completed.task.authority, lifecycle.budgets, new FactoryInbox(fixture.db, tenantId, () => now), pool, () => now);
    const key = { projectId, runId: completed.task.run.runId, reservationId: schedule.reservationId };
    const admittedDecision = await validatorAdmissions.recover(service, key);
    expect(admittedDecision).toMatchObject({ status: "admitted", reservationId: schedule.reservationId });
    expect((admittedDecision as { event?: unknown }).event).toBeUndefined();
    expect(polls).toBe(1);
    // A concurrent poll and a repeat both resolve to the same admission and never call the pool twice.
    await Promise.all([validatorAdmissions.recover(service, key), validatorAdmissions.recover(service, key)]);
    expect(polls).toBe(1);
    expect(rows(await fixture.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE tenant_id=${tenantId} AND reservation_id=${schedule.reservationId}`))).toEqual([{ state: "running" }]);
    expect(rows(await fixture.db.execute(sql`SELECT event_json FROM factory_compute_admissions WHERE tenant_id=${tenantId} AND reservation_id=${schedule.reservationId}`))).toEqual([{ event_json: null }]);

    // The admitted identity mints exactly one durable attempt, and a restart returns the same one.
    const delivery = await fixture.db.transaction(transaction => scheduler.admitInTransaction(transaction, service, acceptanceReference, schedule));
    expect(delivery.reference).toMatchObject({ attemptId: schedule.attemptId, reservationId: schedule.reservationId, nodeInstanceId: schedule.nodeInstanceId });
    const repeated = await fixture.db.transaction(transaction => scheduler.admitInTransaction(transaction, service, acceptanceReference, schedule));
    expect(repeated.reference.requestDigest).toBe(delivery.reference.requestDigest);
    await Promise.all([
      fixture.db.transaction(transaction => scheduler.admitInTransaction(transaction, service, acceptanceReference, schedule)),
      fixture.db.transaction(transaction => scheduler.admitInTransaction(transaction, service, acceptanceReference, schedule)),
    ]);
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_executions WHERE tenant_id=${tenantId} AND node_instance_id=${schedule.nodeInstanceId}`))).toEqual([{ attempt_id: schedule.attemptId }]);
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_attempt_queue WHERE tenant_id=${tenantId} AND attempt_id=${schedule.attemptId}`))).toHaveLength(1);
    expect(rows(await fixture.db.execute(sql`SELECT validator_id FROM factory_validator_assignments WHERE tenant_id=${tenantId} AND validator_attempt_id=${schedule.attemptId}`))).toEqual([{ validator_id: material.mandatoryClaims[0]!.validatorId }]);

    // W01's runtime runs it. The guest gets the candidate read-only, with no grants and no tools.
    const settlement = new FactoryValidatorAttemptDispatch(fixture.db, tenantId, completed.task.authority, validators, completed.task.journal, completed.task.queue, completed.artifacts);
    const report = { schemaVersion: "factory.validator-claims.v1", claims: [{ id: material.mandatoryClaims[0]!.id, verdict: "PASS", decisive: true, summary: "scheduled", reasonCode: "pass", evidence: [], measuredAtMs: now }] };
    let guestRuns = 0;
    const dispatcher = new FactoryAttemptDispatcher(fixture.db, completed.task.queue, {
      async run(request) {
        guestRuns += 1;
        expect(request).toMatchObject({ input: { kind: "artifact", artifact: completed.result.output }, grants: [], tools: [] });
        const { artifactJson } = await import("../../factory/artifacts");
        const output = await fixture.db.transaction(transaction => completed.artifacts.stageCandidateOutputInTransaction(transaction, completed.task.identity, schedule.nodeInstanceId, 0, artifactJson.canonical(report)));
        return { schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor: -1, operations: [], resultDigest: output.digest.slice(7), output, usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" }, workspaceCheckpoint: { ...output, journalCursor: -1 } } as const;
      },
    }, settlement, { recordInTransaction: settlement.recordInTransaction.bind(settlement), readInTransaction: settlement.readOutcomeInTransaction.bind(settlement) }, dispatchReady, dispatchReadinessDisposition, { service, installationId: "validator-installation", attemptTokenSecret: "validator-schedule-secret", leaseMs: 5_000 });
    expect(await dispatcher.dispatchOne()).toMatchObject({ kind: "completed", attemptId: schedule.attemptId, recovered: false });
    expect(guestRuns).toBe(1);

    // The whole chain closes: the claim now has evidence, so the candidate needs no further schedule.
    const evidence = await fixture.db.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidateKey, material.mandatoryClaims[0]!.validatorId));
    expect(evidence.claims).toEqual([{ id: material.mandatoryClaims[0]!.id, verdict: "PASS", decisive: true }]);
    expect(await fixture.db.transaction(transaction => scheduler.planInTransaction(transaction, service, acceptanceReference))).toEqual([]);
    expect(rows(await fixture.db.execute(sql`SELECT validator_id FROM factory_validator_results WHERE tenant_id=${tenantId} AND validator_attempt_id=${schedule.attemptId}`))).toEqual([{ validator_id: material.mandatoryClaims[0]!.validatorId }]);

    // Cancelling the run advances its epoch, so the acceptance command that authorized this schedule
    // is no longer current and no further validator work can be planned, reserved, or admitted.
    const runKeyValue = { projectId, runId: completed.task.run.runId };
    const revision = Number(rows<{ revision: number | string }>(await fixture.db.execute(sql`SELECT revision FROM factory_run_lifecycle WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${completed.task.run.runId}`))[0]!.revision);
    await lifecycle.cancel(principal, runKeyValue, revision, `validator-schedule-cancel-${sequence}`);
    const cancelled: readonly ((transaction: import("../../db/migrations/types").MigrationDb) => Promise<unknown>)[] = [
      transaction => scheduler.planInTransaction(transaction, service, acceptanceReference),
      transaction => scheduler.reserveInTransaction(transaction, service, acceptanceReference, schedule),
      transaction => scheduler.admitInTransaction(transaction, service, acceptanceReference, schedule),
    ];
    for (const act of cancelled) await expect(fixture.db.transaction(transaction => act(transaction))).rejects.toThrow();
  });

  test("a protected validator settles through the shared attempt dispatcher, never through the kernel task path", async () => {
    const { completed, candidateKey, validators, claim, validatorAdmission } = await protectedAcceptance(true, false);
    const service = completed.task.service;
    const queue = completed.task.queue;
    const journal = completed.task.journal;
    const artifacts = completed.artifacts;
    await journal.admit(validatorAdmission);
    await fixture.db.transaction(transaction => validators.bindAttemptInTransaction(transaction, { candidate: candidateKey, validatorId: claim.id, authority: validatorAdmission }));
    // The queue row is exactly what the scheduler enqueues once the pool admits the reservation.
    const durable = await fixture.db.transaction(async transaction => {
      const request = await journal.requestInTransaction(transaction, validatorAdmission);
      return queue.enqueueDurableInTransaction(transaction, { ...validatorAdmission, request }, { ...completed.task.identity, commandId: validatorAdmission.attemptId }, `factory-reservation:${"d".repeat(57)}`);
    });
    expect(durable.reference.attemptId).toBe(validatorAdmission.attemptId);

    const settlement = new FactoryValidatorAttemptDispatch(fixture.db, tenantId, completed.task.authority, validators, journal, queue, artifacts);
    const report = { schemaVersion: "factory.validator-claims.v1", claims: [{ id: claim.id, verdict: "PASS", decisive: true, summary: "dispatched", reasonCode: "pass", evidence: [], measuredAtMs: now }] };
    let runs = 0;
    const dispatcher = new FactoryAttemptDispatcher(fixture.db, queue, {
      async run(request) {
        runs += 1;
        // The guest receives the candidate read-only, with no grants and no tools, under a fresh token.
        expect(request).toMatchObject({ input: { kind: "artifact", artifact: completed.result.output }, grants: [], tools: [] });
        expect(request.broker.attemptToken).not.toBe("durable-validator-admission");
        const { artifactJson } = await import("../../factory/artifacts");
        const output = await fixture.db.transaction(transaction => artifacts.stageCandidateOutputInTransaction(transaction, completed.task.identity, validatorAdmission.nodeInstanceId, 0, artifactJson.canonical(report)));
        return { schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor: -1, operations: [], resultDigest: output.digest.slice(7), output, usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" }, workspaceCheckpoint: { ...output, journalCursor: -1 } } as const;
      },
    }, settlement, { recordInTransaction: settlement.recordInTransaction.bind(settlement), readInTransaction: settlement.readOutcomeInTransaction.bind(settlement) }, dispatchReady, dispatchReadinessDisposition, { service, installationId: "validator-installation", attemptTokenSecret: "validator-dispatch-secret", leaseMs: 5_000 });

    expect(await dispatcher.dispatchOne()).toMatchObject({ kind: "completed", attemptId: validatorAdmission.attemptId, recovered: false });
    expect(runs).toBe(1);
    expect(await dispatcher.dispatchOne()).toEqual({ kind: "idle" });
    expect(await queue.read(projectId, validatorAdmission.attemptId)).toMatchObject({ state: "delivered" });
    // A lost acknowledgement recovers the sealed terminal fact instead of launching the guest again.
    await fixture.db.execute(sql`UPDATE factory_attempt_queue SET state='outcome_unknown',failure_code='response_lost' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND attempt_id=${validatorAdmission.attemptId}`);
    expect(await dispatcher.dispatchOne()).toMatchObject({ kind: "completed", attemptId: validatorAdmission.attemptId, recovered: true });
    expect(runs).toBe(1);
    expect(await queue.read(projectId, validatorAdmission.attemptId)).toMatchObject({ state: "delivered" });

    // No kernel fact was written: a protected validator has no node waiting on it.
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_task_completions WHERE attempt_id=${validatorAdmission.attemptId}`))).toEqual([]);
    expect(rows(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE event_id LIKE 'factory-validator-result:%'`))).toEqual([]);

    // The acceptance path reads the evidence the dispatcher sealed.
    const evidence = await fixture.db.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidateKey, claim.id));
    expect(evidence.claims).toEqual([{ id: claim.id, verdict: "PASS", decisive: true }]);

    // An attempt that is not bound to a claim cannot settle through the validator path.
    const unbound = { ...completed.task.identity, commandId: completed.task.dispatch.id };
    await expect(fixture.db.transaction(transaction => settlement.readInTransaction(transaction, service, unbound))).rejects.toMatchObject({ code: "factory_validator_dispatch_unbound" });
    const validatorReference = { ...completed.task.identity, commandId: validatorAdmission.attemptId };
    const cancelledResult = { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: -1, operations: [] } as const;
    await expect(fixture.db.transaction(transaction => settlement.completeInTransaction(transaction, service, validatorReference, cancelledResult))).rejects.toMatchObject({ code: "factory_validator_dispatch_invalid" });
    expect(await fixture.db.transaction(transaction => settlement.recordInTransaction(transaction, service, validatorReference, cancelledResult))).toMatchObject({ resultStatus: "cancelled", usageDisposition: "measured_pending_stop", event: { kind: "node-failed", error: "factory_validator_cancelled" } });
    expect(await fixture.db.transaction(transaction => settlement.recordInTransaction(transaction, service, validatorReference, { schemaVersion: "factory.runner.result.v1", status: "uncertain", journalCursor: -1, operations: [], providerReceiptDigest: "a".repeat(64), usage: { kind: "unknown", reason: "provider", heldCostMicros: "1" } }))).toMatchObject({ resultStatus: "uncertain", usageDisposition: "unknown_held" });
    await expect(fixture.db.transaction(transaction => settlement.recordInTransaction(transaction, service, validatorReference, { ...cancelledResult, status: "completed" } as never))).rejects.toMatchObject({ code: "factory_validator_dispatch_invalid" });
    expect(await settlement.readOutcomeInTransaction()).toBeUndefined();
    expect(() => new FactoryValidatorAttemptDispatch(fixture.db, "foreign-tenant", completed.task.authority, validators, journal, queue, artifacts)).toThrow();
  });

  test("attempt dispatcher mints one fresh authority and atomically commits a successful result", async () => {
    const { task, completions, outcomes, admitted, result } = await completedTask();
    let runnerCalls = 0;
    const dispatcher = new FactoryAttemptDispatcher(fixture.db, task.queue, { async run(request) {
      runnerCalls++;
      const verified = await verifyFactoryAttemptToken(request.broker.attemptToken, "dispatcher-secret", "dispatcher-installation");
      expect(verified).toMatchObject({ attemptId: task.dispatch.id, tenantId, projectId, runId: task.run.runId, nodeInstanceId: task.dispatch.nodeId, requestDigest: admitted.delivery.reference.requestDigest });
      expect(request.broker.audience).toBe("factory-broker");
      return result;
    } }, completions, outcomes, dispatchReady, dispatchReadinessDisposition, { service: task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret", leaseMs: 1_000 });
    expect(admitted.delivery.reference.command).toEqual(task.dispatchReference);
    const dispatched = await dispatcher.dispatchOne();
    expect(dispatched).toMatchObject({ kind: "completed", attemptId: task.dispatch.id, recovered: false, receipt: { reservationId: task.reserved.reservationId } });
    expect(runnerCalls).toBe(1);
    expect(await task.queue.read(projectId, task.dispatch.id)).toMatchObject({ state: "delivered" });
    expect(await dispatcher.dispatchOne()).toEqual({ kind: "idle" });
    expect(rows<{ request_json: string }>(await fixture.db.execute(sql`SELECT request_json::text AS request_json FROM factory_executions WHERE attempt_id=${task.dispatch.id}`))[0]!.request_json).not.toContain("dispatcher-secret");
    expect(rows<{ reference_json: string }>(await fixture.db.execute(sql`SELECT reference_json::text AS reference_json FROM factory_attempt_queue WHERE attempt_id=${task.dispatch.id}`))[0]!.reference_json).not.toContain("attemptToken");
    if (dispatched.kind === "completed") await persistCompletedTask(task, dispatched.receipt);
  });

  test("attempt dispatcher recovers a sealed completion without launching the runner", async () => {
    const { task, completions, outcomes, result } = await completedTask();
    const receipt = await completions.complete(task.service, task.dispatchReference, result);
    await fixture.db.execute(sql`UPDATE factory_attempt_queue SET state='outcome_unknown',failure_code='response_lost' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND attempt_id=${task.dispatch.id}`);
    const dispatcher = new FactoryAttemptDispatcher(fixture.db, task.queue, { async run() { throw new Error("runner must not relaunch"); } }, completions, outcomes, dispatchReady, dispatchReadinessDisposition, { service: task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" });
    expect(await dispatcher.dispatchOne()).toEqual({ kind: "completed", attemptId: task.dispatch.id, recovered: true, receipt });
    const recovered = await task.queue.read(projectId, task.dispatch.id);
    expect(recovered?.state).toBe("delivered");
    expect(recovered?.failureCode).toBeUndefined();
    await persistCompletedTask(task, receipt);
  });

  test("attempt dispatcher resolves a lost commit response from its sealed receipt", async () => {
    const { task, completions, outcomes, result } = await completedTask();
    let transactions = 0;
    const responseLossDatabase: TransactionalDb = {
      execute: query => fixture.db.execute(query),
      async transaction(work) {
        const value = await fixture.db.transaction(work);
        transactions++;
        if (transactions === 3) throw new Error("completion response lost");
        return value;
      },
    };
    const queue = new FactoryAttemptQueue(responseLossDatabase, task.journal, tenantId, () => now);
    const dispatcher = new FactoryAttemptDispatcher(responseLossDatabase, queue, { run: async () => result }, completions, outcomes, dispatchReady, dispatchReadinessDisposition, { service: task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret", leaseMs: 1_000 });
    const dispatched = await dispatcher.dispatchOne();
    expect(dispatched).toMatchObject({ kind: "completed", attemptId: task.dispatch.id, recovered: true });
    expect(transactions).toBe(4);
    expect(await task.queue.read(projectId, task.dispatch.id)).toMatchObject({ state: "delivered" });
    const readReceipt = await fixture.db.transaction(tx => completions.readInTransaction(tx, task.service, task.dispatchReference));
    expect(readReceipt).toBeDefined();
    expect(await completions.complete(task.service, task.dispatchReference, result)).toEqual(readReceipt!);
    if (dispatched.kind === "completed") await persistCompletedTask(task, dispatched.receipt);
  });

  test("attempt dispatcher rejects corrupt completion candidates instead of hiding them", async () => {
    const { task, completions, result } = await completedTask();
    const receipt = await completions.complete(task.service, task.dispatchReference, result);
    await fixture.db.execute(sql`UPDATE factory_attempt_queue SET state='outcome_unknown',reference_json='{}' WHERE attempt_id=${task.dispatch.id}`);
    await expect(task.queue.completionCandidates()).rejects.toMatchObject({ code: "factory_attempt_corrupt" });
    await expect(task.queue.completionCandidates(0)).rejects.toMatchObject({ code: "factory_attempt_scan_invalid" });
    await fixture.db.execute(sql`UPDATE factory_attempt_queue SET state='delivered' WHERE attempt_id=${task.dispatch.id}`);
    await persistCompletedTask(task, receipt);
  });

  test("attempt dispatcher never repeats failed, cancelled, uncertain, invalid, or lost execution outcomes", async () => {
    const cases: Array<{ expected: "failed" | "cancelled" | "outcome_unknown"; result(base: Awaited<ReturnType<typeof completedTask>>["result"]): FactoryRunnerResult }> = [
      { expected: "failed", result: base => ({ schemaVersion: base.schemaVersion, status: "failed", journalCursor: base.journalCursor, operations: base.operations, resultDigest: "e".repeat(64), error: { code: "RUNNER_FAILED", message: "runner failed", retryable: false }, usage: base.usage, workspaceCheckpoint: base.workspaceCheckpoint }) },
      { expected: "cancelled", result: base => ({ schemaVersion: base.schemaVersion, status: "cancelled", journalCursor: base.journalCursor, operations: base.operations, usage: base.usage, workspaceCheckpoint: base.workspaceCheckpoint }) },
      { expected: "outcome_unknown", result: base => ({ schemaVersion: base.schemaVersion, status: "uncertain", journalCursor: base.journalCursor, operations: base.operations, providerReceiptDigest: "f".repeat(64), usage: { kind: "unknown", reason: "provider receipt pending", heldCostMicros: "4" }, workspaceCheckpoint: base.workspaceCheckpoint }) },
    ];
    for (const testCase of cases) {
      const { task, completions, outcomes, result } = await completedTask();
      let calls = 0;
      const dispatcher = new FactoryAttemptDispatcher(fixture.db, task.queue, { async run() { calls++; return testCase.result(result); } }, completions, outcomes, dispatchReady, dispatchReadinessDisposition, { service: task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" });
      const dispatched = await dispatcher.dispatchOne();
      expect(dispatched).toMatchObject({ kind: testCase.expected, attemptId: task.dispatch.id, recovered: false, receipt: { reservationId: task.reserved.reservationId, resultStatus: testCase.expected === "outcome_unknown" ? "uncertain" : testCase.expected } });
      expect(calls).toBe(1);
      expect(await dispatcher.dispatchOne()).toEqual({ kind: "idle" });
      expect(await task.queue.read(projectId, task.dispatch.id)).toMatchObject({ state: "delivered" });
      if (!("receipt" in dispatched) || dispatched.kind === "completed") throw new Error("durable outcome receipt missing");
      expect(await fixture.db.transaction(tx => outcomes.readInTransaction(tx, task.service, task.dispatchReference))).toEqual(dispatched.receipt);
      const stopped = advanceKernel(task.compiled, task.next.nextState, dispatched.receipt.event);
      expect(stopped.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", attemptCommandId: task.dispatch.id }));
      expect(stopped.nextState.nodes[task.dispatch.nodeId]).toMatchObject({ status: "stopping", attempts: [{ stopped: false }] });
      expect(await lifecycle.budgets.inspect({ projectId, runId: task.run.runId, envelopeId: "root" })).toMatchObject({ allocated: { costMicros: "5" }, spent: { costMicros: "0" } });
      expect(rows<{ state: string }>(await fixture.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE reservation_id=${task.reserved.reservationId}`))).toEqual([{ state: testCase.expected === "outcome_unknown" ? "uncertain" : "running" }]);
      await persistTransition(task.identity, 3, dispatched.receipt.event, stopped.nextState, stopped.commands, undefined, task.activities);
      await fixture.db.execute(sql`UPDATE factory_attempt_queue SET state='outcome_unknown',failure_code='commit_response_lost' WHERE attempt_id=${task.dispatch.id}`);
      let recoveryCalls = 0;
      const restarted = new FactoryAttemptDispatcher(fixture.db, task.queue, { async run() { recoveryCalls++; throw new Error("runner must not relaunch"); } }, completions, outcomes, dispatchReady, dispatchReadinessDisposition, { service: task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" });
      expect(await restarted.dispatchOne()).toMatchObject({ kind: testCase.expected, attemptId: task.dispatch.id, recovered: true, receipt: dispatched.receipt });
      expect(recoveryCalls).toBe(0);
      const changed = testCase.result(result);
      await expect(fixture.db.transaction(tx => outcomes.recordInTransaction(tx, task.service, task.dispatchReference, { ...changed, workspaceCheckpoint: { ...result.workspaceCheckpoint, artifactId: "changed-checkpoint" } }))).rejects.toMatchObject({ code: "factory_task_outcome_conflict" });
      await expect(fixture.db.transaction(tx => outcomes.readInTransaction(tx, { ...task.service, subject: "foreign" }, task.dispatchReference))).rejects.toMatchObject({ code: "factory_command_forbidden" });
      await new FactoryRunTransitionProjector(fixture.db, tenantId, task.transitions, lifecycle).project(runKey(task.run.runId));
    }

    for (const mode of ["throw", "invalid", "completion"] as const) {
      const { task, completions, outcomes, result } = await completedTask();
      const runner = mode === "throw" ? { async run(): Promise<FactoryRunnerResult> { throw new Error("connection outcome lost"); } }
        : { async run(): Promise<FactoryRunnerResult> { return mode === "invalid" ? { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: -2, operations: [] } : result; } };
      let completionReads = 0;
      const completionStore = mode === "completion" ? {
        async readInTransaction(...args: Parameters<typeof completions.readInTransaction>) {
          if (completionReads++ > 0) throw new Error("completion receipt unavailable");
          return completions.readInTransaction(...args);
        },
        async completeInTransaction(): Promise<never> { throw new Error("completion store unavailable"); },
      } : completions;
      const dispatcher = new FactoryAttemptDispatcher(fixture.db, task.queue, runner, completionStore, outcomes, dispatchReady, dispatchReadinessDisposition, { service: task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" });
      expect(await dispatcher.dispatchOne()).toEqual({ kind: "outcome_unknown", attemptId: task.dispatch.id });
      expect(await task.queue.read(projectId, task.dispatch.id)).toMatchObject({ state: "outcome_unknown" });
      await new FactoryRunTransitionProjector(fixture.db, tenantId, task.transitions, lifecycle).project(runKey(task.run.runId));
    }
  });

  test("non-success outcome commit rolls back with its queue acknowledgement and detects corrupt recovery", async () => {
    const rolledBack = await completedTask();
    const uncertain: FactoryRunnerResult = { schemaVersion: rolledBack.result.schemaVersion, status: "uncertain", journalCursor: rolledBack.result.journalCursor, operations: rolledBack.result.operations, providerReceiptDigest: "9".repeat(64), usage: { kind: "unknown", reason: "provider pending", heldCostMicros: "4" }, workspaceCheckpoint: rolledBack.result.workspaceCheckpoint };
    await fixture.db.execute(sql`ALTER TABLE factory_task_outcomes ADD CONSTRAINT task_outcome_rollback CHECK (FALSE) NOT VALID`);
    try {
      const dispatcher = new FactoryAttemptDispatcher(fixture.db, rolledBack.task.queue, { async run() { return uncertain; } }, rolledBack.completions, rolledBack.outcomes, dispatchReady, dispatchReadinessDisposition, { service: rolledBack.task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" });
      expect(await dispatcher.dispatchOne()).toEqual({ kind: "outcome_unknown", attemptId: rolledBack.task.dispatch.id });
    } finally {
      await fixture.db.execute(sql`ALTER TABLE factory_task_outcomes DROP CONSTRAINT task_outcome_rollback`);
    }
    expect(rows(await fixture.db.execute(sql`SELECT command_id FROM factory_task_outcomes WHERE command_id=${rolledBack.task.dispatch.id}`))).toHaveLength(0);
    expect(rows(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE event_id=${`${rolledBack.task.dispatch.id}:failed`}`))).toHaveLength(0);
    expect(rows(await fixture.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE reservation_id=${rolledBack.task.reserved.reservationId}`))).toEqual([{ state: "running" }]);
    expect(await rolledBack.task.queue.read(projectId, rolledBack.task.dispatch.id)).toMatchObject({ state: "outcome_unknown", failureCode: "outcome_commit_unknown" });

    const corrupt = await completedTask();
    const failed: FactoryRunnerResult = { schemaVersion: corrupt.result.schemaVersion, status: "failed", journalCursor: corrupt.result.journalCursor, operations: corrupt.result.operations, resultDigest: "8".repeat(64), error: { code: "RUNNER_FAILED", message: "runner failed", retryable: false }, usage: corrupt.result.usage, workspaceCheckpoint: corrupt.result.workspaceCheckpoint };
    const dispatcher = new FactoryAttemptDispatcher(fixture.db, corrupt.task.queue, { async run() { return failed; } }, corrupt.completions, corrupt.outcomes, dispatchReady, dispatchReadinessDisposition, { service: corrupt.task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" });
    expect(await dispatcher.dispatchOne()).toMatchObject({ kind: "failed", receipt: { resultStatus: "failed" } });
    const saved = rows<{ input_digest: string; authority_json: string; result_json: string; receipt_json: string; receipt_digest: string }>(await fixture.db.execute(sql`SELECT input_digest,authority_json,result_json,receipt_json,receipt_digest FROM factory_task_outcomes WHERE command_id=${corrupt.task.dispatch.id}`))[0]!;
    const forgedReceipt = { ...JSON.parse(saved.receipt_json), resultStatus: "cancelled" };
    const forgedDigest = `sha256:${digestObject({ reference: corrupt.task.dispatchReference, inputDigest: saved.input_digest, authorityJson: saved.authority_json, resultJson: saved.result_json, receipt: forgedReceipt })}`;
    await fixture.db.execute(sql`UPDATE factory_task_outcomes SET receipt_json=${encodeFactoryPayload(forgedReceipt)},receipt_digest=${forgedDigest} WHERE command_id=${corrupt.task.dispatch.id}`);
    try {
      await expect(fixture.db.transaction(tx => corrupt.outcomes.readInTransaction(tx, corrupt.task.service, corrupt.task.dispatchReference))).rejects.toMatchObject({ code: "factory_task_outcome_corrupt" });
    } finally {
      await fixture.db.execute(sql`UPDATE factory_task_outcomes SET receipt_json=${saved.receipt_json},receipt_digest=${saved.receipt_digest} WHERE command_id=${corrupt.task.dispatch.id}`);
    }
    await new FactoryRunTransitionProjector(fixture.db, tenantId, rolledBack.task.transitions, lifecycle).project(runKey(rolledBack.task.run.runId));
    await new FactoryRunTransitionProjector(fixture.db, tenantId, corrupt.task.transitions, lifecycle).project(runKey(corrupt.task.run.runId));
  });

  test("attempt dispatcher retries only before runner invocation and survives an expired owner", async () => {
    const tokenFailure = await completedTask();
    let runnerCalls = 0;
    const signerFailure = new FactoryAttemptDispatcher(fixture.db, tokenFailure.task.queue, { async run() { runnerCalls++; return tokenFailure.result; } }, tokenFailure.completions, tokenFailure.outcomes, dispatchReady, dispatchReadinessDisposition, { service: tokenFailure.task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret", leaseMs: 100 }, async () => { throw new Error("signer unavailable"); });
    expect(await signerFailure.dispatchOne()).toEqual({ kind: "retry", attemptId: tokenFailure.task.dispatch.id });
    expect(runnerCalls).toBe(0);
    expect(await tokenFailure.task.queue.read(projectId, tokenFailure.task.dispatch.id)).toMatchObject({ state: "queued", failureCode: "attempt_token_unavailable" });
    now += 1_000;
    expect(await tokenFailure.task.queue.claim()).toBeNull();
    expect(await tokenFailure.task.queue.read(projectId, tokenFailure.task.dispatch.id)).toMatchObject({ state: "cancelled", failureCode: "authority_rejected" });
    await new FactoryRunTransitionProjector(fixture.db, tenantId, tokenFailure.task.transitions, lifecycle).project(runKey(tokenFailure.task.run.runId));
    const expired = await completedTask();
    const dispatcher = new FactoryAttemptDispatcher(fixture.db, expired.task.queue, { async run() {
      now += 301_000;
      expect(await expired.task.queue.claim()).toBeNull();
      return { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: expired.result.journalCursor, operations: expired.result.operations, usage: expired.result.usage, workspaceCheckpoint: expired.result.workspaceCheckpoint };
    } }, expired.completions, expired.outcomes, dispatchReady, dispatchReadinessDisposition, { service: expired.task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret", leaseMs: 300_000 });
    expect(await dispatcher.dispatchOne()).toEqual({ kind: "outcome_unknown", attemptId: expired.task.dispatch.id });
    expect(await expired.task.queue.read(projectId, expired.task.dispatch.id)).toMatchObject({ state: "outcome_unknown", failureCode: "worker_lease_expired" });
    for (const options of [
      { service: { ...expired.task.service, tenantId: "foreign" }, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" },
      { service: expired.task.service, installationId: "", attemptTokenSecret: "dispatcher-secret" },
      { service: expired.task.service, installationId: "dispatcher-installation", attemptTokenSecret: "", attemptTokenLifetimeSeconds: 0 },
      { service: expired.task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret", leaseMs: 300_001 },
    ]) expect(() => new FactoryAttemptDispatcher(fixture.db, expired.task.queue, { run: async () => expired.result }, expired.completions, expired.outcomes, dispatchReady, dispatchReadinessDisposition, options)).toThrow("configuration is invalid");
    await new FactoryRunTransitionProjector(fixture.db, tenantId, expired.task.transitions, lifecycle).project(runKey(expired.task.run.runId));
  });

  test("attempt dispatcher settles package readiness before token mint or execution", async () => {
    for (const expected of ["retry", "cancelled"] as const) {
      const { task, completions, outcomes, admitted, result } = await completedTask();
      let readinessCalls = 0;
      let signerCalls = 0;
      let runnerCalls = 0;
      const message = expected === "retry" ? "package pending" : "package denied";
      const dispatcher = new FactoryAttemptDispatcher(fixture.db, task.queue, { async run() { runnerCalls++; return result; } }, completions, outcomes, {
        async assertDispatchReady(request) {
          readinessCalls++;
          expect(request).toEqual({ authority: admitted.request.authority, runner: admitted.request.runner });
          throw new Error(message);
        },
      }, dispatchReadinessDisposition, { service: task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" }, async () => {
        signerCalls++;
        return "unreachable";
      });
      expect(await dispatcher.dispatchOne()).toEqual({ kind: expected, attemptId: task.dispatch.id });
      expect({ readinessCalls, signerCalls, runnerCalls }).toEqual({ readinessCalls: 1, signerCalls: 0, runnerCalls: 0 });
      expect(await task.queue.read(projectId, task.dispatch.id)).toMatchObject({ state: expected === "retry" ? "queued" : "cancelled", failureCode: expected === "retry" ? "runner_package_not_ready" : "runner_package_denied" });
      expect(await lifecycle.budgets.inspect({ projectId, runId: task.run.runId, envelopeId: "root" })).toMatchObject({ allocated: { costMicros: "5" }, spent: { costMicros: "0" } });
      await new FactoryRunTransitionProjector(fixture.db, tenantId, task.transitions, lifecycle).project(runKey(task.run.runId));
    }
  });

  test("attempt dispatcher fails closed before execution when recovery or minted authority is invalid", async () => {
    const unavailable = await completedTask();
    let runnerCalls = 0;
    const unreadable = new FactoryAttemptDispatcher(fixture.db, unavailable.task.queue, { async run() { runnerCalls++; return unavailable.result; } }, {
      async readInTransaction(): Promise<never> { throw new Error("completion store unavailable"); },
      completeInTransaction: unavailable.completions.completeInTransaction.bind(unavailable.completions),
    }, unavailable.outcomes, dispatchReady, dispatchReadinessDisposition, { service: unavailable.task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" });
    expect(await unreadable.dispatchOne()).toEqual({ kind: "retry", attemptId: unavailable.task.dispatch.id });
    expect(runnerCalls).toBe(0);
    expect(await unavailable.task.queue.read(projectId, unavailable.task.dispatch.id)).toMatchObject({ state: "queued", failureCode: "completion_read_unavailable" });
    await new FactoryRunTransitionProjector(fixture.db, tenantId, unavailable.task.transitions, lifecycle).project(runKey(unavailable.task.run.runId));

    const invalidToken = await completedTask();
    const dispatcher = new FactoryAttemptDispatcher(fixture.db, invalidToken.task.queue, { async run() { runnerCalls++; return invalidToken.result; } }, invalidToken.completions, invalidToken.outcomes, dispatchReady, dispatchReadinessDisposition, { service: invalidToken.task.service, installationId: "dispatcher-installation", attemptTokenSecret: "dispatcher-secret" }, async () => "");
    expect(await dispatcher.dispatchOne()).toEqual({ kind: "outcome_unknown", attemptId: invalidToken.task.dispatch.id });
    expect(runnerCalls).toBe(0);
    expect(await invalidToken.task.queue.read(projectId, invalidToken.task.dispatch.id)).toMatchObject({ state: "outcome_unknown", failureCode: "runner_request_invalid" });
    await new FactoryRunTransitionProjector(fixture.db, tenantId, invalidToken.task.transitions, lifecycle).project(runKey(invalidToken.task.run.runId));
  });

  test("task completion rejects stale authority, invalid output and oversized workflow payloads without settling holds", async () => {
    for (const [value, expectedCode] of [[{}, "factory_task_completion_output_invalid"], [{ snapshot: { digest: `sha256:${"d".repeat(64)}`, mediaType: "application/json", storage: "test" }, padding: "x".repeat(65_000) }, "factory_task_completion_oversized"]] as const) {
      const { task, completions, result } = await completedTask(value);
      await expect(completions.complete(task.service, task.dispatchReference, result)).rejects.toMatchObject({ code: expectedCode });
      expect(await lifecycle.budgets.inspect({ projectId, runId: task.run.runId, envelopeId: "root" })).toMatchObject({ spent: { costMicros: "0" }, allocated: { costMicros: "5" } });
      await new FactoryRunTransitionProjector(fixture.db, tenantId, task.transitions, lifecycle).project(runKey(task.run.runId));
    }
    const { task, completions, result } = await completedTask();
    await expect(completions.complete({ tenantId, subject: "foreign" }, task.dispatchReference, result)).rejects.toMatchObject({ code: "factory_command_forbidden" });
    await expect(completions.complete(task.service, { ...task.dispatchReference, tenantId: "foreign" }, result)).rejects.toMatchObject({ code: "factory_task_completion_invalid" });
    await expect(completions.complete(task.service, task.dispatchReference, { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: -1, operations: [] })).rejects.toMatchObject({ code: "factory_task_completion_invalid" });
    await cancelRun(principal, runKey(task.run.runId), task.run.revision, `completion-cancel-${task.run.runId}`);
    await expect(completions.complete(task.service, task.dispatchReference, result)).rejects.toThrow("factory_run_stopped");
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_execution_terminals WHERE attempt_id=${task.dispatch.id}`))).toHaveLength(0);
    await new FactoryRunTransitionProjector(fixture.db, tenantId, task.transitions, lifecycle).project(runKey(task.run.runId));
  });

  test("task limits can reduce a host budget and cannot exceed its memory profile", async () => {
    const definitionKey = { projectId, factoryId: "task-budget-factory" };
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId,
      graph: { ...referenceCodeV1.graph, nodes: referenceCodeV1.graph.nodes.map(node => node.id === "snapshot-repository" ? { ...node, resources: { resourceClass: "cpu", memoryBytes: 128, maxCostMicros: "3", maxTokens: 4, maxComputeMs: 5 } } : node) } };
    await definitions.save(principal, definitionKey, 0, "task-budget-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "task-budget-publish");
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest };
    const run = await startRun(principal, definitionKey, request, 0, "task-budget-start");
    const { identity, transitions, activities, event, first, admission, authority } = await committedInterpreter(run.runId, definitionKey, request);
    await persistTransition(identity, 1, event, first.nextState, first.commands, undefined, activities);
    const reference = { ...identity, commandId: admission.id };
    const service = { tenantId, subject: "orchestration" };
    const profile = { resources: { cpu: 1 }, memoryBytes: 127, budget: { costMicros: "8", tokens: 9, computeMs: 10 } };
    await expect(taskAdmissions(authority, { cpu: profile }).request(service, reference)).rejects.toMatchObject({ code: "factory_command_forbidden" });
    const admitted = await taskAdmissions(authority, { cpu: { ...profile, memoryBytes: 128 } }).request(service, reference);
    const delivery = await new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now, "pool").inspect(admitted.outboxCommandId);
    expect(delivery?.command.body).toMatchObject({ budget: { costMicros: "3", tokens: 4, computeMs: 5 }, memoryBytes: 128 });
    expect((await lifecycle.budgets.inspect({ ...runKey(run.runId), envelopeId: "root" })).allocated).toEqual({ costMicros: "3", tokens: "4", computeMs: "5" });
    await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId));
  });

  test("a child resolves only from the current committed parent attempt and exact published reference", async () => {
    const definitionKey = { projectId, factoryId: "parent-authority-factory" };
    const child = { id: key.factoryId, version: body.factoryVersion, digest: body.definitionDigest };
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, factories: [child], outputPorts: {},
      graph: { nodes: [{ id: "child", kind: "subfactory", factory: child, releaseMode: "none", grants: [] }], outputs: {} } };
    await definitions.save(principal, definitionKey, 0, "parent-authority-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "parent-authority-publish");
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest };
    const service = { tenantId, subject: "orchestration" };
    for (const forged of [false, true]) {
      const run = await startRun(principal, definitionKey, request, 0, `parent-authority-${forged}`);
      const { identity, transitions, activities, event, first, authority } = await committedInterpreter(run.runId, definitionKey, request);
      const command = first.commands.find(value => value.kind === "run-child");
      expect(command?.kind).toBe("run-child");
      if (command?.kind !== "run-child") throw new Error("missing child command");
      const reference = { ...identity, commandId: command.id };
      await expect(authority.withCurrentChild(service, reference, async () => "child")).rejects.toThrow();
      const commands = first.commands.map(value => forged && value.id === command.id ? { ...command, factory: { ...child, digest: `sha256:${"0".repeat(64)}` } } : value);
      await persistTransition(identity, 1, event, first.nextState, commands, undefined, activities);
      if (forged) {
        await expect(authority.withCurrentChild(service, reference, async () => "child")).rejects.toMatchObject({ code: "factory_command_stale" });
      } else {
        const resolve = () => authority.withCurrentChild(service, reference, async (_transaction, context) => ({ child: context.node.factory, command: context.command, fence: context.fence.definitionDigest }));
        expect(await resolve()).toEqual({ child, command, fence: request.definitionDigest });
        await expect(authority.withCurrent(service, reference, async () => "task")).rejects.toMatchObject({ code: "factory_command_forbidden" });
        const timer = first.commands.find(value => value.kind === "start-timer")!;
        await expect(authority.withCurrentChild(service, { ...reference, commandId: timer.id }, async () => "child")).rejects.toMatchObject({ code: "factory_command_forbidden" });
        const mutable = { ...reference };
        const pending = authority.withCurrentChild(service, mutable, async (_transaction, context) => context.command.factory);
        mutable.commandId = "caller-changed-child";
        expect(await pending).toEqual(child);
        const expired = new FactoryCommandAuthority(fixture.db, tenantId, lifecycle, transitions, [service.subject], () => command.deadlineAtMs);
        await expect(expired.withCurrentChild(service, reference, async () => "child")).rejects.toMatchObject({ code: "factory_command_stale" });
        const expiredChildren = new FactoryChildRuns(fixture.db, tenantId, expired, lifecycle, transitions);
        await expect(expiredChildren.resolve(service, { ...reference, factory: child })).rejects.toMatchObject({ code: "factory_command_stale" });
        expect(rows(await fixture.db.execute(sql`SELECT child_run_id FROM factory_child_runs WHERE tenant_id=${tenantId} AND project_id=${projectId} AND parent_run_id=${run.runId}`))).toEqual([]);
        await cancelRun(principal, runKey(run.runId), run.revision, "parent-authority-cancel");
        await expect(resolve()).rejects.toMatchObject({ code: "factory_run_stopped" });
      }
      await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId));
    }
  });

  test("a child command creates one durable child receipt without a second root outbox start", async () => {
    const definitionKey = { projectId, factoryId: "durable-child-parent" };
    const child = { id: key.factoryId, version: body.factoryVersion, digest: body.definitionDigest };
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, factories: [child], outputPorts: {},
      graph: { nodes: [{ id: "child", kind: "subfactory", factory: child, releaseMode: "none", grants: [] }], outputs: {} } };
    await definitions.save(principal, definitionKey, 0, "durable-child-parent-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "durable-child-parent-publish");
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest };
    const run = await startRun(principal, definitionKey, request, 0, "durable-child-parent-start");
    const { identity, transitions, activities, compiled, event, first, authority } = await committedInterpreter(run.runId, definitionKey, request);
    const command = first.commands.find(value => value.kind === "run-child");
    expect(command?.kind).toBe("run-child");
    if (command?.kind !== "run-child") throw new Error("missing child command");
    await persistTransition(identity, 1, event, first.nextState, first.commands, undefined, activities);
    await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId));
    const children = new FactoryChildRuns(fixture.db, tenantId, authority, lifecycle, transitions);
    const service = { tenantId, subject: "orchestration" };
    const reference = { ...identity, commandId: command.id, factory: command.factory };
    const router = privateCommands(authority, transitions, { children });
    const staged = await router.resolveFactory(service, reference);
    expect(staged.definitionDigest).toBe(child.digest);
    const childRunId = rows<{ child_run_id: string }>(await fixture.db.execute(sql`SELECT child_run_id FROM factory_child_runs WHERE tenant_id=${tenantId} AND project_id=${projectId} AND parent_run_id=${run.runId} AND parent_command_id=${command.id}`))[0]!.child_run_id;
    expect(childRunId).toMatch(/^child-[a-f0-9]{64}$/);
    expect(rows(await fixture.db.execute(sql`SELECT logical_run_id FROM factory_command_outbox WHERE tenant_id=${tenantId} AND project_id=${projectId} AND logical_run_id=${childRunId}`))).toEqual([]);
    expect(await router.resolveFactory(service, reference)).toEqual(staged);
    expect(await lifecycle.budgets.inspect({ projectId, runId: run.runId, envelopeId: "root" })).toMatchObject({ allocated: { tokens: "100" } });
    expect(await lifecycle.budgets.inspect({ projectId, runId: childRunId, envelopeId: "root" })).toMatchObject({ limits: { tokens: "100" } });
    const childStartedAtMs = await fixture.db.transaction(transaction => lifecycle.readWorkflowStartedAtInTransaction(transaction, { projectId, runId: childRunId }));
    const childCommitted = await committedInterpreter(childRunId, key, body, lifecycle, undefined, childStartedAtMs);
    const childAdmission = childCommitted.first.commands.find(value => value.kind === "request-admission");
    expect(childAdmission?.kind).toBe("request-admission");
    if (childAdmission?.kind !== "request-admission") throw new Error("missing child admission");
    await persistTransition(childCommitted.identity, 1, childCommitted.event, childCommitted.first.nextState, childCommitted.first.commands, undefined, childCommitted.activities);
    const childTaskReference = { ...childCommitted.identity, commandId: childAdmission.id };
    await expect(childCommitted.authority.withCurrent(service, childTaskReference, async () => "child-work")).resolves.toBe("child-work");
    // A sibling timer can advance the parent head without replacing this child attempt.
    await persistTransition(identity, 2, { kind: "timer-expired", id: "child-parent-unrelated", atMs: now + 1, commandId: "unrelated" }, first.nextState, [], undefined, activities);
    await expect(childCommitted.authority.withCurrent(service, childTaskReference, async () => "child-work")).resolves.toBe("child-work");
    // A repair replaces the subfactory attempt, so its original child task command is stale.
    const repaired = advanceKernel(compiled, first.nextState, { kind: "repair", id: "child-parent-repaired", atMs: now + 2, nodeId: "child", reason: "replace child" });
    await persistTransition(identity, 3, { kind: "repair", id: "child-parent-repaired", atMs: now + 2, nodeId: "child", reason: "replace child" }, repaired.nextState, repaired.commands, undefined, activities);
    await expect(childCommitted.authority.withCurrent(service, childTaskReference, async () => "child-work")).rejects.toMatchObject({ code: "factory_command_stale" });
    await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId), 8);
    const childIdentity = { tenantId, projectId, logicalRunId: childRunId, interpreterId: "root" };
    const spent = { projectId, runId: childRunId, envelopeId: "root", reservationId: "child-measured-spend", amount: { costMicros: "5", tokens: 6, computeMs: 7 }, computeRequest: { kind: "fixture" } };
    await lifecycle.budgets.reserve(spent, async () => {});
    await lifecycle.budgets.settle(spent, { costMicros: "3", tokens: 4, computeMs: 5 }, `sha256:${"c".repeat(64)}`);
    await persistTransition(childIdentity, 2, { id: "child-complete", kind: "cancel", atMs: now, reason: "settlement" } as never, { status: "completed" } as never, [{ kind: "complete-run", id: "child-terminal", output: {} }], undefined, activities);
    await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(childRunId), 8);
    await expect(Promise.all([children.settle(service, { projectId, childRunId }), children.settle(service, { projectId, childRunId })])).resolves.toEqual([undefined, undefined]);
    expect(rows(await fixture.db.execute(sql`SELECT state,settlement_digest FROM factory_child_runs WHERE tenant_id=${tenantId} AND project_id=${projectId} AND child_run_id=${childRunId}`))).toEqual([{ state: "settled", settlement_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }]);
    expect(await lifecycle.budgets.inspect({ projectId, runId: run.runId, envelopeId: "root" })).toMatchObject({ allocated: { costMicros: "0", tokens: "0", computeMs: "0" }, spent: { costMicros: "3", tokens: "4", computeMs: "5" } });
    await cancelRun(principal, runKey(run.runId), run.revision, "durable-child-parent-cancel");
    await expect(fixture.db.transaction(transaction => lifecycle.authorizeRunInTransaction(transaction, { projectId, runId: childRunId }))).rejects.toMatchObject({ code: "factory_run_stopped" });
    expect(await children.resolve(service, reference)).toEqual(staged);
    await fixture.db.execute(sql`UPDATE factory_child_runs SET started_ms=${now + 2} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND child_run_id=${childRunId}`);
    await expect(fixture.db.transaction(transaction => lifecycle.readWorkflowStartedAtInTransaction(transaction, { projectId, runId: childRunId }))).rejects.toMatchObject({ code: "factory_run_corrupt" });
  });

  test("a terminal child with an unknown hold cannot settle its parent allocation", async () => {
    const definitionKey = { projectId, factoryId: "unknown-child-parent" };
    const child = { id: key.factoryId, version: body.factoryVersion, digest: body.definitionDigest };
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, factories: [child], outputPorts: {},
      graph: { nodes: [{ id: "child", kind: "subfactory", factory: child, releaseMode: "none", grants: [] }], outputs: {} } };
    await definitions.save(principal, definitionKey, 0, "unknown-child-parent-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "unknown-child-parent-publish");
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest };
    const parent = await startRun(principal, definitionKey, request, 0, "unknown-child-parent-start");
    const committed = await committedInterpreter(parent.runId, definitionKey, request);
    const command = committed.first.commands.find(command => command.kind === "run-child");
    if (command?.kind !== "run-child") throw new Error("missing child command");
    await persistTransition(committed.identity, 1, committed.event, committed.first.nextState, committed.first.commands, undefined, committed.activities);
    const service = { tenantId, subject: "orchestration" };
    const children = new FactoryChildRuns(fixture.db, tenantId, committed.authority, lifecycle, committed.transitions);
    await children.resolve(service, { ...committed.identity, commandId: command.id, factory: command.factory });
    const childRunId = rows<{ child_run_id: string }>(await fixture.db.execute(sql`SELECT child_run_id FROM factory_child_runs WHERE tenant_id=${tenantId} AND project_id=${projectId} AND parent_run_id=${parent.runId}`))[0]!.child_run_id;
    const hold = { projectId, runId: childRunId, envelopeId: "root", reservationId: "unknown-child-hold", amount: { costMicros: "1", tokens: 1, computeMs: 1 }, computeRequest: { kind: "fixture" } };
    await lifecycle.budgets.reserve(hold, async () => {});
    await lifecycle.budgets.markUncertain(hold, "provider-unknown");
    const childIdentity = { tenantId, projectId, logicalRunId: childRunId, interpreterId: "root" };
    await persistTransition(childIdentity, 1, { id: "unknown-child-terminal", kind: "cancel", atMs: now, reason: "fixture" } as never, { status: "completed" } as never, [{ kind: "complete-run", id: "unknown-child-complete", output: {} }], undefined, committed.activities);
    const projector = new FactoryRunTransitionProjector(fixture.db, tenantId, committed.transitions, lifecycle);
    await projector.project(runKey(parent.runId), 8);
    await projector.project(runKey(childRunId), 8);
    await expect(children.settle(service, { projectId, childRunId })).rejects.toMatchObject({ code: "factory_budget_pending" });
    expect(rows(await fixture.db.execute(sql`SELECT state FROM factory_child_runs WHERE tenant_id=${tenantId} AND project_id=${projectId} AND child_run_id=${childRunId}`))).toEqual([{ state: "open" }]);
    expect(await lifecycle.budgets.inspect({ projectId, runId: parent.runId, envelopeId: "root" })).toMatchObject({ allocated: { tokens: "100" }, spent: { tokens: "0" } });
  });

  test("the settleable child scan is bounded, oldest first, and safe to run twice at once", async () => {
    const definitionKey = { projectId, factoryId: "settleable-child-parent" };
    const child = { id: key.factoryId, version: body.factoryVersion, digest: body.definitionDigest };
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, factories: [child], outputPorts: {},
      graph: { nodes: [{ id: "child", kind: "subfactory", factory: child, releaseMode: "none", grants: [] }], outputs: {} } };
    await definitions.save(principal, definitionKey, 0, "settleable-child-parent-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "settleable-child-parent-publish");
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest };
    const service = { tenantId, subject: "orchestration" };
    const entered = now;
    let children: FactoryChildRuns | undefined;
    const scan = async (limit: number, after?: { projectId: string; childRunId: string; startedAtMs: number }) =>
      fixture.db.transaction(transaction => children!.listSettleableInTransaction(transaction, limit, after));
    const full = () => scan(FACTORY_CHILD_SETTLEMENT_SCAN_LIMIT);

    /** Runs one parent to a terminal child and returns that child's durable identity. */
    const terminalChild = async (label: string): Promise<string> => {
      const parent = await startRun(principal, definitionKey, request, 0, `settleable-${label}-start`);
      const committed = await committedInterpreter(parent.runId, definitionKey, request);
      const command = committed.first.commands.find(value => value.kind === "run-child");
      if (command?.kind !== "run-child") throw new Error("missing child command");
      await persistTransition(committed.identity, 1, committed.event, committed.first.nextState, committed.first.commands, undefined, committed.activities);
      children ??= new FactoryChildRuns(fixture.db, tenantId, committed.authority, lifecycle, committed.transitions);
      await children.resolve(service, { ...committed.identity, commandId: command.id, factory: command.factory });
      const childRunId = rows<{ child_run_id: string }>(await fixture.db.execute(sql`SELECT child_run_id FROM factory_child_runs WHERE tenant_id=${tenantId} AND project_id=${projectId} AND parent_run_id=${parent.runId}`))[0]!.child_run_id;
      const projector = new FactoryRunTransitionProjector(fixture.db, tenantId, committed.transitions, lifecycle);
      // A child is settleable only once its own run is terminal, so scan before projecting it.
      expect((await full()).map(item => item.childRunId)).not.toContain(childRunId);
      await persistTransition({ tenantId, projectId, logicalRunId: childRunId, interpreterId: "root" }, 1, { id: `settleable-${label}-terminal`, kind: "cancel", atMs: now, reason: "fixture" } as never, { status: "completed" } as never, [{ kind: "complete-run", id: `settleable-${label}-complete`, output: {} }], undefined, committed.activities);
      await projector.project(runKey(parent.runId), 8);
      await projector.project(runKey(childRunId), 8);
      return childRunId;
    };

    let corrupted: string | undefined;
    let sealedStartedAtMs = 0;
    try {
      // Earlier tests leave their own settleable children, so start strictly after all of them.
      const committed = await committedInterpreter((await startRun(principal, definitionKey, request, 0, "settleable-baseline-start")).runId, definitionKey, request);
      children = new FactoryChildRuns(fixture.db, tenantId, committed.authority, lifecycle, committed.transitions);
      const baseline = await full();
      now = Math.max(entered, ...baseline.map(item => item.startedAtMs)) + 60_000;

      const first = await terminalChild("first");
      expect((await full()).map(item => item.childRunId)).toEqual([...baseline.map(item => item.childRunId), first]);
      now += 60_000;
      const second = await terminalChild("second");
      sealedStartedAtMs = now;

      const page = await full();
      const mine = page.slice(baseline.length);
      expect(mine.map(item => item.childRunId)).toEqual([first, second]);
      expect(mine.map(item => item.startedAtMs)).toEqual([now - 60_000, now]);
      expect(page.map(item => item.startedAtMs)).toEqual([...page].sort((left, right) => left.startedAtMs - right.startedAtMs).map(item => item.startedAtMs));
      // An enumeration, not a receipt: it addresses the child and orders it, and nothing more.
      expect(mine.every(item => item.projectId === projectId && item.parentRunId.length > 0)).toBe(true);
      expect(Object.keys(mine[0]!).sort()).toEqual(["childRunId", "parentRunId", "projectId", "startedAtMs"]);

      // A bounded page resumes exactly where the previous one ended, then reports no more work.
      const resume = baseline.at(-1);
      const firstPage = await scan(1, resume);
      expect(firstPage.map(item => item.childRunId)).toEqual([first]);
      const secondPage = await scan(1, firstPage[0]!);
      expect(secondPage.map(item => item.childRunId)).toEqual([second]);
      expect(await scan(1, secondPage[0]!)).toEqual([]);

      // Two workers scanning at once see the same work, and settling it twice stays idempotent.
      expect(await Promise.all([full(), full()])).toEqual([page, page]);
      await expect(Promise.all([children.settle(service, { projectId, childRunId: first }), children.settle(service, { projectId, childRunId: first })])).resolves.toEqual([undefined, undefined]);
      expect((await full()).map(item => item.childRunId)).toEqual([...baseline.map(item => item.childRunId), second]);

      for (const limit of [0, -1, 1.5, FACTORY_CHILD_SETTLEMENT_SCAN_LIMIT + 1]) {
        await expect(scan(limit)).rejects.toMatchObject({ code: "factory_child_forbidden" });
      }
      await expect(scan(1, { projectId, childRunId: second, startedAtMs: -1 })).rejects.toMatchObject({ code: "factory_child_corrupt" });
      await expect(scan(1, { projectId: "", childRunId: second, startedAtMs: 0 })).rejects.toThrow();

      // A binding whose sealed clock no longer matches its digest is reported by settle, per child,
      // so one corrupt row at the head of the order cannot stall every child behind it.
      corrupted = second;
      await fixture.db.execute(sql`UPDATE factory_child_runs SET started_ms=${sealedStartedAtMs + 1} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND child_run_id=${second}`);
      now += 60_000;
      const third = await terminalChild("third");
      const withCorrupt = await full();
      expect(withCorrupt.map(item => item.childRunId)).toEqual([...baseline.map(item => item.childRunId), second, third]);
      await expect(children.settle(service, { projectId, childRunId: second })).rejects.toMatchObject({ code: "factory_child_corrupt" });
      await children.settle(service, { projectId, childRunId: third });
      expect((await full()).map(item => item.childRunId)).toEqual([...baseline.map(item => item.childRunId), second]);
    } finally {
      now = entered;
      if (corrupted) await fixture.db.execute(sql`UPDATE factory_child_runs SET started_ms=${sealedStartedAtMs} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND child_run_id=${corrupted}`);
    }
  });

  test("a sibling child retries after a live delegated portion settles", async () => {
    const definitionKey = { projectId, factoryId: "concurrent-child-parent" };
    const child = { id: key.factoryId, version: body.factoryVersion, digest: body.definitionDigest };
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, factories: [child], outputPorts: {},
      graph: { nodes: [
        { id: "child-a", kind: "subfactory", factory: child, releaseMode: "none", grants: [] },
        { id: "child-b", kind: "subfactory", factory: child, releaseMode: "none", grants: [] },
      ], outputs: {} } };
    await definitions.save(principal, definitionKey, 0, "concurrent-child-parent-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "concurrent-child-parent-publish");
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest };
    const parent = await startRun(principal, definitionKey, request, 0, "concurrent-child-parent-start");
    const committed = await committedInterpreter(parent.runId, definitionKey, request);
    const commands = committed.first.commands.filter(command => command.kind === "run-child");
    expect(commands).toHaveLength(2);
    const [first, second] = commands;
    if (!first || !second) throw new Error("missing sibling child commands");
    await persistTransition(committed.identity, 1, committed.event, committed.first.nextState, committed.first.commands, undefined, committed.activities);
    const service = { tenantId, subject: "orchestration" };
    const children = new FactoryChildRuns(fixture.db, tenantId, committed.authority, lifecycle, committed.transitions);
    await children.resolve(service, { ...committed.identity, commandId: first.id, factory: first.factory });
    await expect(children.resolve(service, { ...committed.identity, commandId: second.id, factory: second.factory })).rejects.toMatchObject({ code: "factory_budget_held" });
    const firstRunId = rows<{ child_run_id: string }>(await fixture.db.execute(sql`SELECT child_run_id FROM factory_child_runs WHERE tenant_id=${tenantId} AND project_id=${projectId} AND parent_run_id=${parent.runId} AND parent_command_id=${first.id}`))[0]!.child_run_id;
    const firstIdentity = { tenantId, projectId, logicalRunId: firstRunId, interpreterId: "root" };
    await persistTransition(firstIdentity, 1, { id: "concurrent-child-terminal", kind: "cancel", atMs: now, reason: "fixture" } as never, { status: "completed" } as never, [{ kind: "complete-run", id: "concurrent-child-complete", output: {} }], undefined, committed.activities);
    const projector = new FactoryRunTransitionProjector(fixture.db, tenantId, committed.transitions, lifecycle);
    await projector.project(runKey(parent.runId), 8);
    await projector.project(runKey(firstRunId), 8);
    await children.settle(service, { projectId, childRunId: firstRunId });
    expect(await children.resolve(service, { ...committed.identity, commandId: second.id, factory: second.factory })).toMatchObject({ definitionDigest: child.digest });
  });

  test("nested child bindings inherit the original root clock without child start outboxes", async () => {
    const grandchild = { id: key.factoryId, version: body.factoryVersion, digest: body.definitionDigest };
    const middleKey = { projectId, factoryId: "durable-child-middle" };
    const middleSource: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: middleKey.factoryId, factories: [grandchild], outputPorts: {},
      graph: { nodes: [{ id: "grandchild", kind: "subfactory", factory: grandchild, releaseMode: "none", grants: [] }], outputs: {} } };
    await definitions.save(principal, middleKey, 0, "durable-child-middle-create", middleSource);
    const middleVersion = await definitions.publish(principal, middleKey, 1, "durable-child-middle-publish");
    const middle = { id: middleKey.factoryId, version: middleVersion.version, digest: middleVersion.definitionDigest };
    const parentKey = { projectId, factoryId: "durable-child-clock-parent" };
    const parentSource: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: parentKey.factoryId, factories: [middle], outputPorts: {},
      graph: { nodes: [{ id: "middle", kind: "subfactory", factory: middle, releaseMode: "none", grants: [] }], outputs: {} } };
    await definitions.save(principal, parentKey, 0, "durable-child-clock-parent-create", parentSource);
    const parentVersion = await definitions.publish(principal, parentKey, 1, "durable-child-clock-parent-publish");
    const parentBody = { ...body, factoryVersion: parentVersion.version, definitionDigest: parentVersion.definitionDigest };
    const rootStartedAtMs = now;
    const parentRun = await startRun(principal, parentKey, parentBody, 0, "durable-child-clock-parent-start");
    now += 1_000;
    try {
      const parent = await committedInterpreter(parentRun.runId, parentKey, parentBody, lifecycle, undefined, rootStartedAtMs);
      const parentCommand = parent.first.commands.find(command => command.kind === "run-child");
      expect(parentCommand?.kind).toBe("run-child");
      if (parentCommand?.kind !== "run-child") throw new Error("missing middle child command");
      await persistTransition(parent.identity, 1, parent.event, parent.first.nextState, parent.first.commands, undefined, parent.activities);
      await new FactoryRunTransitionProjector(fixture.db, tenantId, parent.transitions, lifecycle).project(runKey(parentRun.runId), 8);
      const service = { tenantId, subject: "orchestration" };
      const middleChildren = new FactoryChildRuns(fixture.db, tenantId, parent.authority, lifecycle, parent.transitions);
      await middleChildren.resolve(service, { ...parent.identity, commandId: parentCommand.id, factory: parentCommand.factory });
      const middleRunId = rows<{ child_run_id: string }>(await fixture.db.execute(sql`SELECT child_run_id FROM factory_child_runs WHERE tenant_id=${tenantId} AND project_id=${projectId} AND parent_run_id=${parentRun.runId} AND parent_command_id=${parentCommand.id}`))[0]!.child_run_id;
      const middleStartedAtMs = await fixture.db.transaction(transaction => lifecycle.readWorkflowStartedAtInTransaction(transaction, { projectId, runId: middleRunId }));
      expect(middleStartedAtMs).toBe(rootStartedAtMs);
      const middleBody = { ...body, factoryVersion: middleVersion.version, definitionDigest: middleVersion.definitionDigest };
      const middleRun = await committedInterpreter(middleRunId, middleKey, middleBody, lifecycle, undefined, middleStartedAtMs);
      const middleCommand = middleRun.first.commands.find(command => command.kind === "run-child");
      expect(middleCommand?.kind).toBe("run-child");
      if (middleCommand?.kind !== "run-child") throw new Error("missing nested child command");
      await persistTransition(middleRun.identity, 1, middleRun.event, middleRun.first.nextState, middleRun.first.commands, undefined, middleRun.activities);
      await new FactoryRunTransitionProjector(fixture.db, tenantId, middleRun.transitions, lifecycle).project(runKey(middleRunId), 8);
      const grandchildren = new FactoryChildRuns(fixture.db, tenantId, middleRun.authority, lifecycle, middleRun.transitions);
      await grandchildren.resolve(service, { ...middleRun.identity, commandId: middleCommand.id, factory: middleCommand.factory });
      const grandchildRunId = rows<{ child_run_id: string }>(await fixture.db.execute(sql`SELECT child_run_id FROM factory_child_runs WHERE tenant_id=${tenantId} AND project_id=${projectId} AND parent_run_id=${middleRunId} AND parent_command_id=${middleCommand.id}`))[0]!.child_run_id;
      expect(await fixture.db.transaction(transaction => lifecycle.readWorkflowStartedAtInTransaction(transaction, { projectId, runId: grandchildRunId }))).toBe(rootStartedAtMs);
      expect(rows(await fixture.db.execute(sql`SELECT logical_run_id FROM factory_command_outbox WHERE tenant_id=${tenantId} AND project_id=${projectId} AND logical_run_id IN (${middleRunId}, ${grandchildRunId})`))).toEqual([]);
    } finally { now = rootStartedAtMs; }
  });

  test("lazy reads authorize the exact pending input and stop when its committed result advances", async () => {
    const sourceRun = await start();
    const sourceIdentity = { tenantId, projectId, logicalRunId: sourceRun.runId };
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const stored = await artifacts.stage(sourceIdentity, "candidate_output", new TextEncoder().encode('{"value":"stored value"}'), { interpreterScoped: false, candidateNodeInstanceId: "source", candidateGeneration: 1 });
    const artifact = { artifactId: stored.objectId, digest: stored.digest, encodedBytes: stored.encodedBytes };
    const definitionKey = { projectId, factoryId: "input-authority-factory" };
    const inputPorts = { source: { type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"], additionalProperties: false } };
    const task = referenceCodeV1.graph.nodes.find(node => node.kind === "task")!;
    if (task.kind !== "task") throw new Error("missing reference task");
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, inputPorts, outputPorts: {},
      graph: { nodes: [{ ...task, id: "read-source", dependsOn: [], inputPorts: { value: { type: "string" } }, bindings: { value: { kind: "ref", root: "input", name: "source", path: ["value"] } } }], outputs: {} } };
    await definitions.save(principal, definitionKey, 0, "input-authority-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "input-authority-publish");
    const request: FactoryRunStartBody = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest, parameters: { source: { kind: "artifact", artifact } } };
    const runLifecycle = new FactoryRunLifecycle(fixture.db, tenantId, { ...options, async resolveParameters(transaction) {
      const loaded = await artifacts.loadInTransaction(transaction, sourceIdentity, stored, ["candidate_output"]);
      return { source: JSON.parse(new TextDecoder().decode(loaded.content)) };
    } }, () => now);
    const resolvedInput = { source: { value: "stored value" } };
    const service = { tenantId, subject: "orchestration" };
    for (const substituted of [false, true]) {
      const { run } = await runLifecycle.start(principal, definitionKey, request, 0, `input-authority-${substituted}`);
      const { identity, transitions, activities, compiled, event, first, authority } = await committedInterpreter(run.runId, definitionKey, request, runLifecycle, resolvedInput);
      const command = first.commands.find(value => value.kind === "read-input-value");
      expect(command?.kind).toBe("read-input-value");
      if (command?.kind !== "read-input-value") throw new Error("missing input command");
      const reference = { ...identity, commandId: command.id };
      const commands = first.commands.map(value => substituted && value.id === command.id ? { ...command, path: ["private"] } : value);
      await persistTransition(identity, 1, event, first.nextState, commands, undefined, activities);
      const inputs = new FactoryLazyCommands(authority, new FactoryLazyInputReader(fixture.db, tenantId, artifacts, new FactoryArtifactAccess(fixture.db, tenantId, grants, artifacts), grants, () => now));
      const router = privateCommands(authority, transitions, { inputs });
      if (substituted) {
        await expect(router.execute(service, reference)).rejects.toMatchObject({ code: "factory_command_stale" });
      } else {
        expect(await authority.withCurrentInput(service, reference, async (_transaction, context) => context.command)).toEqual(command);
        await expect(authority.withCurrent(service, reference, async () => "task")).rejects.toMatchObject({ code: "factory_command_forbidden" });
        const read = await router.execute(service, reference);
        expect(read).toMatchObject({ kind: "input-value-read", value: "stored value", artifact });
        if (!read) throw new Error("missing input result");
        const next = advanceKernel(compiled, first.nextState, read);
        await persistTransition(identity, 2, read, next.nextState, next.commands, undefined, activities);
        await expect(authority.withCurrentInput(service, reference, async () => "read")).rejects.toMatchObject({ code: "factory_command_stale" });
        const admission = next.commands.find(value => value.kind === "request-admission")!;
        await expect(authority.withCurrentInput(service, { ...reference, commandId: admission.id }, async () => "read")).rejects.toMatchObject({ code: "factory_command_forbidden" });
      }
      await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, runLifecycle).project(runKey(run.runId));
    }
  });

  test("approval decisions share the current command transaction and exact declared human scope", async () => {
    const definitionKey = { projectId, factoryId: "approval-authority-factory" };
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, inputPorts: {}, outputPorts: {},
      graph: { nodes: [{ id: "human", kind: "approval", actorScope: "operator", choices: ["approve", "deny"], context: { kind: "literal", value: { subject: "review" } }, expiresInMs: 60_000, onDenied: "fail", onExpired: "fail" }], outputs: {} } };
    await definitions.save(principal, definitionKey, 0, "approval-authority-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "approval-authority-publish");
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest, parameters: {} };
    const service = { tenantId, subject: "orchestration" };
    for (const forged of [false, true]) {
      const run = await startRun(principal, definitionKey, request, 0, `approval-authority-${forged}`);
      const { identity, transitions, activities, event, first, authority } = await committedInterpreter(run.runId, definitionKey, request);
      const command = first.commands.find(value => value.kind === "request-approval");
      expect(command?.kind).toBe("request-approval");
      if (command?.kind !== "request-approval") throw new Error("missing approval command");
      const reference = { ...identity, commandId: command.id };
      await persistTransition(identity, 1, event, first.nextState, first.commands.map(value => forged && value.id === command.id ? { ...command, actorScope: "owner" } : value), undefined, activities);
      if (forged) {
        await expect(authority.withCurrentApproval(service, reference, async () => "approval")).rejects.toMatchObject({ code: "factory_command_stale" });
      } else {
        const select = (_transaction: unknown, context: FactoryAuthorizedApprovalCommand) => Promise.resolve({ command: context.command, principal: context.initiator, attempt: context.attempt, compiled: context.compiled.digest });
        const approved = await authority.withCurrentApproval(service, reference, select);
        expect(approved).toMatchObject({ command, principal: { id: principal.id, kind: "user", authentication: "api-key" }, attempt: { commandId: command.id, candidateGeneration: 0, attempt: 1, deadlineAtMs: command.deadlineAtMs }, compiled: request.definitionDigest });
        expect(await fixture.db.transaction(transaction => authority.withCurrentApprovalInTransaction(transaction, service, reference, async (actual, context) => {
          expect(actual).toBe(transaction);
          return select(actual, context);
        }))).toEqual(approved);
        await expect(authority.withCurrent(service, reference, async () => "task")).rejects.toMatchObject({ code: "factory_command_forbidden" });
        const timer = first.commands.find(value => value.kind === "start-timer")!;
        await expect(authority.withCurrentApproval(service, { ...reference, commandId: timer.id }, async () => "approval")).rejects.toMatchObject({ code: "factory_command_forbidden" });
        await cancelRun(principal, runKey(run.runId), run.revision, "approval-authority-cancel");
        await expect(authority.withCurrentApproval(service, reference, select)).rejects.toMatchObject({ code: "factory_run_stopped" });
      }
      await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId));
    }
  });

  test("acceptance authority opens the public wrapper only for the exact current protected command", async () => {
    const definitionKey = { projectId, factoryId: "acceptance-command-authority" };
    const source: FactoryDefinition = {
      ...structuredClone(referenceCodeV1),
      id: definitionKey.factoryId,
      inputPorts: {},
      outputPorts: {},
      graph: {
        nodes: [{
          id: "accept",
          kind: "acceptance",
          contract: referenceCodeV1.acceptance.id,
          candidate: { kind: "literal", value: "candidate" },
          evidence: { kind: "literal", value: "evidence" },
          outputPorts: { acceptedCandidate: { type: "string" } },
        }, {
          id: "publish",
          kind: "release",
          dependsOn: ["accept"],
          adapter: structuredClone(referenceCodeV1.graph.nodes.find(node => node.kind === "release") as Extract<FactoryDefinition["graph"]["nodes"][number], { kind: "release" }>).adapter,
          acceptedCandidate: { kind: "ref", root: "node", name: "accept", path: ["acceptedCandidate"] },
          destination: { kind: "literal", value: "destination" },
          outputPorts: {},
        }],
        outputs: {},
      },
    };
    await definitions.save(principal, definitionKey, 0, "acceptance-authority-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "acceptance-authority-publish");
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest, parameters: {} };
    const run = await startRun(principal, definitionKey, request, 0, "acceptance-authority-start");
    const current = await committedInterpreter(run.runId, definitionKey, request);
    const command = current.first.commands.find(value => value.kind === "request-acceptance");
    if (command?.kind !== "request-acceptance") throw new Error("missing acceptance command");
    await persistTransition(current.identity, 1, current.event, current.first.nextState, current.first.commands, undefined, current.activities);
    const reference = { ...current.identity, commandId: command.id };
    const service = { tenantId, subject: "orchestration" };

    const accepted = await current.authority.withCurrentAcceptance(service, reference, async (_transaction, context) => ({
      command: context.command,
      node: context.node.id,
      attempt: context.attempt,
    }));
    expect(accepted).toMatchObject({ command, node: "accept", attempt: { commandId: command.id, candidateGeneration: 0, attempt: 1 } });
    expect(await fixture.db.transaction(transaction => current.authority.withCurrentAcceptanceInTransaction(transaction, service, reference, async (actual, context) => {
      expect(actual).toBe(transaction);
      return context.command;
    }))).toEqual(command);

    const acceptedEvent = { kind: "node-result", id: "acceptance-authority-result", atMs: now, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: 1, output: { acceptedCandidate: "candidate" } } as const;
    const next = advanceKernel(current.compiled, current.first.nextState, acceptedEvent);
    const release = next.commands.find(value => value.kind === "request-release");
    if (release?.kind !== "request-release") throw new Error("missing release command");
    await persistTransition(current.identity, 2, acceptedEvent, next.nextState, next.commands, undefined, current.activities);
    const releaseReference = { ...current.identity, commandId: release.id };
    expect(await current.authority.withCurrentRelease(service, releaseReference, async (_transaction, context) => context.command)).toEqual(release);
    expect(await fixture.db.transaction(transaction => current.authority.withCurrentReleaseInTransaction(transaction, service, releaseReference, async (actual, context) => {
      expect(actual).toBe(transaction);
      return context.command;
    }))).toEqual(release);
    await cancelRun(principal, runKey(run.runId), run.revision, "acceptance-authority-cancel");
    await expect(current.authority.withCurrentAcceptance(service, reference, async () => "stale")).rejects.toMatchObject({ code: "factory_run_stopped" });
    await new FactoryRunTransitionProjector(fixture.db, tenantId, current.transitions, lifecycle).project(runKey(run.runId));
  });

  test("partition notifications retain exact source authority across progress and repairs", async () => {
    const definitionKey = { projectId, factoryId: "partition-command-authority" };
    const template = referenceCodeV1.graph.nodes.find(node => node.id === "snapshot-repository");
    if (template?.kind !== "task") throw new Error("task fixture missing");
    const largePort = { type: "string" as const, description: "x".repeat(18_000) };
    const partitionNodes: FactoryDefinition["graph"]["nodes"] = [
      { ...template, id: "partition-node-000", inputPorts: {}, bindings: {}, outputPorts: { value: largePort }, dependsOn: [] },
      { ...template, id: "partition-hold", inputPorts: {}, bindings: {}, outputPorts: {}, dependsOn: [] },
      { ...template, id: "partition-node-001", inputPorts: {}, bindings: {}, outputPorts: { value: largePort }, dependsOn: ["partition-node-000"] },
    ];
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, inputPorts: {}, outputPorts: {}, graph: { nodes: partitionNodes, outputs: {} } };
    await definitions.save(principal, definitionKey, 0, "partition-authority-create", source);
    const version = await definitions.publish(principal, definitionKey, 1, "partition-authority-publish");
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest, parameters: {} };
    const run = await startRun(principal, definitionKey, request, 0, "partition-authority-start");
    const { compiled } = await definitions.readVersion(principal, definitionKey, version.version);
    const partition = compiled.partitions.find(candidate => candidate.outbound.length > 0);
    const edge = partition?.outbound[0];
    if (!partition || !edge) throw new Error("partition edge fixture missing");
    const identity = { tenantId, projectId, logicalRunId: run.runId, interpreterId: partition.id };
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const startEvent = { kind: "start", id: `partition-authority-start:${run.runId}`, atMs: now } as const;
    const started = advanceKernel(compiled, createPartitionKernelState(compiled, partition.id, run.runId, {}, now), startEvent);
    await persistTransition(identity, 1, startEvent, started.nextState, started.commands, undefined, activities);
    const admission = started.commands.find(command => command.kind === "request-admission" && command.nodeId === edge.nodeId);
    if (admission?.kind !== "request-admission") throw new Error("partition admission fixture missing");
    const admittedEvent = { kind: "admission-result", id: `${admission.id}:admitted`, atMs: now + 1, nodeId: edge.nodeId, commandId: admission.id, candidateGeneration: 0, granted: true } as const;
    const admitted = advanceKernel(compiled, started.nextState, admittedEvent);
    await persistTransition(identity, 2, admittedEvent, admitted.nextState, admitted.commands, undefined, activities);
    const dispatch = admitted.commands.find(command => command.kind === "dispatch-node" && command.nodeId === edge.nodeId);
    if (dispatch?.kind !== "dispatch-node") throw new Error("partition dispatch fixture missing");
    const resultEvent = { kind: "node-result", id: `${dispatch.id}:result`, atMs: now + 2, nodeId: edge.nodeId, commandId: dispatch.id, candidateGeneration: 0, attempt: 1, output: { value: "old" } } as const;
    const completed = advanceKernel(compiled, admitted.nextState, resultEvent);
    await persistTransition(identity, 3, resultEvent, completed.nextState, completed.commands, undefined, activities);
    const notification = completed.commands.find(command => command.kind === "notify-partition" && command.sourceNodeId === edge.nodeId);
    if (notification?.kind !== "notify-partition") throw new Error("partition notification fixture missing");
    const authority = new FactoryCommandAuthority(fixture.db, tenantId, lifecycle, transitions, ["orchestration"], () => now);
    const service = { tenantId, subject: "orchestration" };
    const notificationReference = { ...identity, commandId: notification.id };
    expect(await authority.withCurrentPartition(service, notificationReference, async (_transaction, context) => ({ command: context.command, sequence: context.sourceSequence, atMs: context.commandState.nowMs }))).toEqual({ command: notification, sequence: 3, atMs: now + 2 });

    const harmless = { kind: "repair", id: `partition-unrelated:${run.runId}`, atMs: now + 3, nodeId: "missing-node", reason: "unrelated" } as const;
    const advanced = advanceKernel(compiled, completed.nextState, harmless);
    await persistTransition(identity, 4, harmless, advanced.nextState, advanced.commands, undefined, activities);
    expect(await authority.withCurrentPartition(service, notificationReference, async () => "current")).toBe("current");

    const repair = { kind: "repair", id: `partition-repair:${run.runId}`, atMs: now + 4, nodeId: edge.nodeId, reason: "replace source" } as const;
    const repaired = advanceKernel(compiled, advanced.nextState, repair);
    await persistTransition(identity, 5, repair, repaired.nextState, repaired.commands, undefined, activities);
    const invalidation = repaired.commands.find(command => command.kind === "invalidate-partition" && command.sourceNodeId === edge.nodeId);
    if (invalidation?.kind !== "invalidate-partition") throw new Error("partition invalidation fixture missing");
    await expect(authority.withCurrentPartition(service, notificationReference, async () => "stale")).rejects.toMatchObject({ code: "factory_command_stale" });
    const invalidationReference = { ...identity, commandId: invalidation.id };
    expect(await authority.withCurrentPartition(service, invalidationReference, async (_transaction, context) => context.command)).toEqual(invalidation);
    const nextRepair = { kind: "repair", id: `partition-repair-next:${run.runId}`, atMs: now + 5, nodeId: edge.nodeId, reason: "replace source again" } as const;
    const pending = advanceKernel(compiled, repaired.nextState, nextRepair);
    await persistTransition(identity, 6, nextRepair, pending.nextState, pending.commands, undefined, activities);
    const nextInvalidation = pending.commands.find(command => command.kind === "invalidate-partition" && command.sourceNodeId === edge.nodeId);
    if (nextInvalidation?.kind !== "invalidate-partition") throw new Error("next partition invalidation fixture missing");
    await expect(authority.withCurrentPartition(service, invalidationReference, async () => "stale")).rejects.toMatchObject({ code: "factory_command_stale" });
    expect(await authority.withCurrentPartition(service, { ...identity, commandId: nextInvalidation.id }, async (_transaction, context) => context.command)).toEqual(nextInvalidation);
    await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId));
  });

  test("repair and replan controls seal current input and published child authority in the run inbox", async () => {
    const stringPort = { type: "string" as const };
    const runner = structuredClone(referenceCodeV1.graph.nodes.find(node => node.kind === "task") as Extract<FactoryDefinition["graph"]["nodes"][number], { kind: "task" }>).runner;
    const publish = async (source: FactoryDefinition, suffix: string) => {
      const definitionKey = { projectId, factoryId: source.id };
      await definitions.save(principal, definitionKey, 0, `${suffix}-create`, source);
      return definitions.publish(principal, definitionKey, 1, `${suffix}-publish`);
    };
    const controlStores = () => {
      const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
      const transitions = new FactoryTransitionArtifacts(artifacts);
      const authority = new FactoryTransitionAuthority(tenantId, lifecycle, transitions);
      const access = new FactoryArtifactAccess(fixture.db, tenantId, grants, artifacts);
      const inputs = new FactoryRunInputs(grants, new FactoryInputArtifacts(artifacts, access));
      return { artifacts, inputs, transitions, controls: new FactoryRunControls(fixture.db, tenantId, grants, lifecycle, authority, definitions, inputs, () => now) };
    };

    const repairSource: FactoryDefinition = {
      ...structuredClone(referenceCodeV1), id: "repair-control-factory", version: "1.0.0", inputPorts: { source: stringPort }, outputPorts: {},
      graph: { nodes: [{ id: "candidate", kind: "task", runner, inputPorts: { source: stringPort, instruction: stringPort }, bindings: { source: { kind: "ref", root: "input", name: "source" }, instruction: { kind: "literal", value: "first" } }, repairableInputs: ["instruction"], outputPorts: {} }], outputs: {} },
    };
    const repairVersion = await publish(repairSource, "repair-control");
    const repairRequest = { ...body, factoryVersion: repairVersion.version, definitionDigest: repairVersion.definitionDigest, parameters: { source: { kind: "inline" as const, value: "protected" } } };
    const repairRun = await startRun(principal, { projectId, factoryId: repairSource.id }, repairRequest, 0, "repair-control-start");
    const repairInterpreter = await committedInterpreter(repairRun.runId, { projectId, factoryId: repairSource.id }, repairRequest);
    await persistTransition(repairInterpreter.identity, 1, repairInterpreter.event, repairInterpreter.first.nextState, repairInterpreter.first.commands, undefined, repairInterpreter.activities);
    const repairStores = controlStores();
    expect(await fixture.db.transaction(transaction => repairStores.inputs.resolveInTransaction(transaction, principal, { projectId, factoryId: repairSource.id }, repairRequest.parameters, repairInterpreter.compiled))).toEqual({ kind: "factory.run-resolved-parameters", input: { source: "protected" } });
    const instructionArtifact = await fixture.db.transaction(transaction => repairStores.artifacts.stageCandidateOutputInTransaction(transaction, repairInterpreter.identity, "repair-instruction", 0, artifactJson.canonical("second")));
    const repairBody = { action: "repair" as const, nodeId: "candidate", reason: "Correct the opted-in instruction", parameters: { source: { kind: "inline" as const, value: "protected" }, instruction: { kind: "artifact" as const, artifact: instructionArtifact } } };
    await expect(fixture.db.transaction(transaction => repairStores.inputs.resolveNodeInTransaction(transaction, projectId, { ...repairBody.parameters, instruction: { kind: "artifact", artifact: { ...instructionArtifact, artifactId: "missing-artifact" } } }, repairSource.graph.nodes[0]!.inputPorts!))).rejects.toMatchObject({ code: "factory_input_invalid" });
    const viewer: FactoryPrincipal = { kind: "user", id: "repair-control-viewer", authentication: "session" };
    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${viewer.id}, 'repair-control-viewer@example.test', 'not-a-login', 'Repair viewer', 'member')`);
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('repair-control-viewer-membership', ${projectId}, ${viewer.id}, 'member')`);
    await expect(repairStores.controls.request(viewer, runKey(repairRun.runId), repairBody, 1, "repair-viewer-denied")).rejects.toMatchObject({ code: "factory_forbidden" });
    await expect(repairStores.controls.request(principal, runKey(repairRun.runId), repairBody, 2, "repair-stale")).rejects.toMatchObject({ code: "factory_control_stale" });
    await expect(repairStores.controls.request(principal, runKey(repairRun.runId), { ...repairBody, nodeId: "foreign-node" }, 1, "repair-foreign-node")).rejects.toMatchObject({ code: "factory_control_invalid" });
    await expect(repairStores.controls.request(principal, runKey(repairRun.runId), repairBody, Number.MAX_SAFE_INTEGER, "repair-overflow")).rejects.toMatchObject({ code: "factory_control_invalid" });
    await fixture.db.execute(sql`ALTER TABLE factory_inbox_events ADD CONSTRAINT repair_control_rollback CHECK (event_id NOT LIKE 'factory-control:%') NOT VALID`);
    try { await expect(repairStores.controls.request(principal, runKey(repairRun.runId), repairBody, 1, "repair-rollback")).rejects.toThrow(); }
    finally { await fixture.db.execute(sql`ALTER TABLE factory_inbox_events DROP CONSTRAINT repair_control_rollback`); }
    expect((await lifecycle.read(principal, runKey(repairRun.runId))).revision).toBe(1);
    expect(rows(await fixture.db.execute(sql`SELECT idempotency_key FROM factory_mutation_receipts WHERE idempotency_key='repair-rollback'`))).toHaveLength(0);
    const [repaired, racedRepair] = await Promise.all([
      repairStores.controls.request(principal, runKey(repairRun.runId), repairBody, 1, "repair-control"),
      repairStores.controls.request(principal, runKey(repairRun.runId), repairBody, 1, "repair-control"),
    ]);
    expect(racedRepair).toEqual(repaired);
    expect(repaired.run).toMatchObject({ runId: repairRun.runId, revision: 2 });
    expect(await repairStores.controls.request(principal, runKey(repairRun.runId), repairBody, 1, "repair-control")).toEqual(repaired);
    await expect(repairStores.controls.request(principal, runKey(repairRun.runId), { ...repairBody, reason: "Changed payload" }, 1, "repair-control")).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(repairStores.controls.request(principal, runKey(repairRun.runId), { ...repairBody, parameters: { source: { kind: "inline", value: "changed" }, instruction: { kind: "inline", value: "second" } } }, 2, "repair-protected-input")).rejects.toMatchObject({ code: "factory_control_invalid" });
    const repairEvents = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${repairRun.runId} ORDER BY sequence`));
    expect(repairEvents).toHaveLength(1);
    expect(JSON.parse(repairEvents[0]!.payload)).toMatchObject({ kind: "repair", nodeId: "candidate", inputOverride: { source: "protected", instruction: "second" } });
    await cancelRun(principal, runKey(repairRun.runId), 2, "repair-control-cancel");
    await expect(repairStores.controls.request(principal, runKey(repairRun.runId), repairBody, 1, "repair-control")).rejects.toMatchObject({ code: "factory_run_stopped" });

    const childBase: FactoryDefinition = {
      ...structuredClone(referenceCodeV1), id: "replan-child-factory", version: "1.0.0", inputPorts: { source: stringPort }, outputPorts: {},
      graph: { nodes: [{ id: "work", kind: "task", runner, inputPorts: { source: stringPort }, bindings: { source: { kind: "ref", root: "input", name: "source" } }, outputPorts: {} }], outputs: {} },
    };
    const childOne = await publish(childBase, "replan-child-one");
    const childTwoSource = { ...structuredClone(childBase), version: "2.0.0" };
    await definitions.save(principal, { projectId, factoryId: childBase.id }, 1, "replan-child-two-save", childTwoSource);
    const childTwo = await definitions.publish(principal, { projectId, factoryId: childBase.id }, 2, "replan-child-two-publish");
    const childThreeSource = { ...structuredClone(childBase), version: "3.0.0", capabilities: ["llm"] };
    await definitions.save(principal, { projectId, factoryId: childBase.id }, 2, "replan-child-three-save", childThreeSource);
    const childThree = await definitions.publish(principal, { projectId, factoryId: childBase.id }, 3, "replan-child-three-publish");
    const childOneReference = { id: childBase.id, version: childOne.version, digest: childOne.definitionDigest };
    const childTwoReference = { id: childBase.id, version: childTwo.version, digest: childTwo.definitionDigest };
    const parentSource: FactoryDefinition = {
      ...structuredClone(referenceCodeV1), id: "replan-parent-factory", version: "1.0.0", factories: [childOneReference], inputPorts: { source: stringPort }, outputPorts: {},
      graph: { nodes: [{ id: "child", kind: "subfactory", factory: childOneReference, releaseMode: "none", grants: [], inputPorts: { source: stringPort }, bindings: { source: { kind: "ref", root: "input", name: "source" } }, outputPorts: {} }], outputs: {} },
    };
    const parentVersion = await publish(parentSource, "replan-parent");
    const parentRequest = { ...body, factoryVersion: parentVersion.version, definitionDigest: parentVersion.definitionDigest, parameters: { source: { kind: "inline" as const, value: "protected" } } };
    const parentRun = await startRun(principal, { projectId, factoryId: parentSource.id }, parentRequest, 0, "replan-parent-start");
    const parentInterpreter = await committedInterpreter(parentRun.runId, { projectId, factoryId: parentSource.id }, parentRequest);
    await persistTransition(parentInterpreter.identity, 1, parentInterpreter.event, parentInterpreter.first.nextState, parentInterpreter.first.commands, undefined, parentInterpreter.activities);
    const replanStores = controlStores();
    const replanBody = { action: "replan" as const, nodeId: "child", reason: "Replace the defective child", replacement: childTwoReference, parameters: {} };
    const parentAudit = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_audit_batches WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${parentRun.runId} AND interpreter_id='root' AND source_sequence=1`))[0]!;
    await fixture.db.execute(sql`UPDATE factory_audit_batches SET payload='{}' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${parentRun.runId} AND interpreter_id='root' AND source_sequence=1`);
    await expect(replanStores.controls.request(principal, runKey(parentRun.runId), replanBody, 1, "tampered-replan")).rejects.toMatchObject({ code: "factory_control_corrupt" });
    await fixture.db.execute(sql`UPDATE factory_audit_batches SET payload=${parentAudit.payload} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${parentRun.runId} AND interpreter_id='root' AND source_sequence=1`);
    const replanned = await replanStores.controls.request(principal, runKey(parentRun.runId), replanBody, 1, "replan-control");
    expect(replanned.run.revision).toBe(2);
    const replanEvents = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${parentRun.runId} ORDER BY sequence`));
    expect(replanEvents).toHaveLength(1);
    expect(JSON.parse(replanEvents[0]!.payload)).toMatchObject({ kind: "replan", nodeId: "child", replacement: childTwoReference });
    await expect(replanStores.controls.request(principal, runKey(parentRun.runId), { ...replanBody, replacement: { ...childTwoReference, id: "foreign-child" } }, 2, "foreign-replan")).rejects.toMatchObject({ code: "factory_control_widening" });
    await expect(replanStores.controls.request(principal, runKey(parentRun.runId), { ...replanBody, replacement: { id: childBase.id, version: childThree.version, digest: childThree.definitionDigest } }, 2, "widened-replan")).rejects.toMatchObject({ code: "factory_control_widening" });
    const projector = new FactoryRunTransitionProjector(fixture.db, tenantId, replanStores.transitions, lifecycle);
    await projector.project(runKey(repairRun.runId));
    await projector.project(runKey(parentRun.runId));
  });

  test("generic approval command persists one human request and one exact inbox decision", async () => {
    const { activities, approvals, command, compiled, first, identity, item, reference, releases, run, transitions } = await prepareApproval("operator", "candidate-7");
    const application = createFactoryApplication({ database: fixture.db, tenantId, blobs: objectStore, grants, availableResourceClasses: ["cpu"], runOptions: options, createCommandApprovals: () => approvals });
    expect(application.commandApprovals).toBe(approvals);
    expect(Object.isFrozen(application.commandApprovals)).toBe(true);
    expect(await approvals.execute(reference)).toBeNull();
    expect(rows(await fixture.db.execute(sql`SELECT approval_id FROM factory_command_approvals WHERE run_id=${run.runId}`))).toHaveLength(1);
    expect(rows(await fixture.db.execute(sql`SELECT notification_id FROM factory_notifications WHERE payload::jsonb->>'approvalId' IS NOT NULL AND payload::jsonb->>'approvalId' LIKE 'factory-command-approval:%'`))).toHaveLength(1);
    expect(item).toMatchObject({ kind: "command_approval_requested", commandId: command.id, nodeInstanceId: command.nodeId, choices: ["ship", "hold"], context: { subject: "candidate-7" }, actorScope: "operator" });

    const harmless = { kind: "repair", id: `unrelated-progress:${run.runId}`, atMs: now, nodeId: "missing-node", reason: "unrelated progress" } as const;
    const advanced = advanceKernel(compiled, first.nextState, harmless);
    await persistTransition(identity, 2, harmless, advanced.nextState, advanced.commands, undefined, activities);
    expect((await releases.listDeliveredNotifications(principal, projectId, { limit: 200 })).items.some(value => value.kind === "command_approval_requested" && value.approvalId === item.approvalId)).toBe(true);

    await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET cancellation_epoch=cancellation_epoch+1 WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId}`);
    expect((await releases.listDeliveredNotifications(principal, projectId, { limit: 200 })).items.some(value => value.kind === "command_approval_requested" && value.approvalId === item.approvalId)).toBe(false);
    await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET cancellation_epoch=cancellation_epoch-1 WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId}`);

    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES ('approval-foreign','approval-foreign@example.test','x','Foreign reviewer','user')`);
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('approval-foreign-member',${projectId},'approval-foreign','member')`);
    const foreign = { kind: "user", id: "approval-foreign", authentication: "session" } as const;
    expect((await releases.listDeliveredNotifications(foreign, projectId)).items.some(value => value.kind === "command_approval_requested" && value.approvalId === item.approvalId)).toBe(false);
    await expect(approvals.decide(foreign, projectId, run.runId, item.approvalId, item.contextDigest, "ship", 0, "foreign-command-decision")).rejects.toThrow("factory_forbidden");

    await grants.revoke(principal, { principal, projectId, action: "factory.approve", expectedRevision: 1 });
    expect((await releases.listDeliveredNotifications(principal, projectId, { limit: 200 })).items.some(value => value.kind === "command_approval_requested" && value.approvalId === item.approvalId)).toBe(false);
    await expect(approvals.decide(principal, projectId, run.runId, item.approvalId, item.contextDigest, "ship", 0, "revoked-command-decision")).rejects.toThrow("factory_forbidden");
    await grants.set(principal, { principal, projectId, action: "factory.approve", expectedRevision: 2, expiresAtMs: null });

    const protectedRow = rows<{ protected_digest: string }>(await fixture.db.execute(sql`SELECT protected_digest FROM factory_command_approvals WHERE approval_id=${item.approvalId}`))[0]!;
    await fixture.db.execute(sql`UPDATE factory_command_approvals SET protected_digest=${`sha256:${"0".repeat(64)}`} WHERE approval_id=${item.approvalId}`);
    await expect(approvals.decide(principal, projectId, run.runId, item.approvalId, item.contextDigest, "ship", 0, "tampered-command-decision")).rejects.toMatchObject({ code: "factory_command_approval_corrupt" });
    await fixture.db.execute(sql`UPDATE factory_command_approvals SET protected_digest=${protectedRow.protected_digest} WHERE approval_id=${item.approvalId}`);

    await fixture.db.execute(sql`ALTER TABLE factory_inbox_events RENAME TO command_approval_hidden_inbox`);
    try { await expect(approvals.decide(principal, projectId, run.runId, item.approvalId, item.contextDigest, "ship", 0, "rollback-command-decision")).rejects.toThrow(); }
    finally { await fixture.db.execute(sql`ALTER TABLE command_approval_hidden_inbox RENAME TO factory_inbox_events`); }
    expect(rows<{ status: string }>(await fixture.db.execute(sql`SELECT status FROM factory_command_approvals WHERE approval_id=${item.approvalId}`))[0]?.status).toBe("pending");
    expect(rows(await fixture.db.execute(sql`SELECT idempotency_key FROM factory_mutation_receipts WHERE idempotency_key='rollback-command-decision'`))).toEqual([]);

    const decision = await approvals.decide(principal, projectId, run.runId, item.approvalId, item.contextDigest, "ship", 0, "command-decision");
    expect(decision).toMatchObject({ runId: run.runId, commandId: command.id, nodeInstanceId: command.nodeId, revision: 1, status: "answered", choice: "ship", decidedBy: principal.id });
    expect(await approvals.decide(principal, projectId, run.runId, item.approvalId, item.contextDigest, "ship", 0, "command-decision")).toEqual(decision);
    expect((await releases.listDeliveredNotifications(principal, projectId, { limit: 200 })).items.some(value => value.kind === "command_approval_requested" && value.approvalId === item.approvalId)).toBe(false);
    const decided = await approvals.execute(reference);
    expect(decided).toMatchObject({ kind: "approval-decided", commandId: command.id, nodeId: command.nodeId, choice: "ship" });
    const inbox = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE run_id=${run.runId} AND interpreter_id='root'`));
    expect(inbox.map(row => JSON.parse(row.payload))).toEqual([decided]);
    expect(rows(await fixture.db.execute(sql`SELECT id FROM factory_command_outbox WHERE logical_run_id=${run.runId} AND payload::jsonb#>>'{command,kind}'='decision'`))).toHaveLength(1);
    const next = advanceKernel(compiled, advanced.nextState, decided!);
    await persistTransition(identity, 3, decided!, next.nextState, next.commands, undefined, activities);
    expect(await approvals.execute(reference)).toEqual(decided);
    await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId));
  });

  test("owner and tenant contract administrator approval scopes do not widen human authority", async () => {
    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES ('approval-reviewer','approval-reviewer@example.test','x','Approval reviewer','user'),('approval-admin','approval-admin@example.test','x','Approval admin','admin')`);
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('approval-reviewer-member',${projectId},'approval-reviewer','member'),('approval-admin-member',${projectId},'approval-admin','member')`);
    const reviewer = { kind: "user", id: "approval-reviewer", authentication: "session" } as const;
    const administrator = { kind: "user", id: "approval-admin", authentication: "session" } as const;
    await grants.set(principal, { principal: reviewer, projectId, action: "factory.approve", expectedRevision: 0, expiresAtMs: null });
    await grants.set(principal, { principal: administrator, projectId, action: "factory.approve", expectedRevision: 0, expiresAtMs: null });
    await grants.set(principal, { principal: administrator, projectId, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });

    const owner = await prepareApproval("owner", "owner-scope");
    await expect(owner.approvals.decide(reviewer, projectId, owner.run.runId, owner.item.approvalId, owner.item.contextDigest, "ship", 0, "owner-foreign-decision")).rejects.toMatchObject({ code: "factory_command_approval_forbidden" });
    expect(await owner.approvals.decide(principal, projectId, owner.run.runId, owner.item.approvalId, owner.item.contextDigest, "ship", 0, "owner-decision")).toMatchObject({ actorScope: "owner", decidedBy: principal.id });

    const contractAdmin = await prepareApproval("tenant-contract-admin", "contract-admin-scope");
    await expect(contractAdmin.approvals.decide(reviewer, projectId, contractAdmin.run.runId, contractAdmin.item.approvalId, contractAdmin.item.contextDigest, "ship", 0, "contract-member-decision")).rejects.toThrow("factory_forbidden");
    expect(await contractAdmin.approvals.decide(administrator, projectId, contractAdmin.run.runId, contractAdmin.item.approvalId, contractAdmin.item.contextDigest, "hold", 0, "contract-admin-decision")).toMatchObject({ actorScope: "tenant-contract-admin", choice: "hold", decidedBy: administrator.id });
    expect(Number(rows<{ decided_trust_revision: number | string }>(await fixture.db.execute(sql`SELECT decided_trust_revision FROM factory_command_approvals WHERE approval_id=${contractAdmin.item.approvalId}`))[0]?.decided_trust_revision)).toBe(1);
    await new FactoryRunTransitionProjector(fixture.db, tenantId, owner.transitions, lifecycle).project(runKey(owner.run.runId));
    await new FactoryRunTransitionProjector(fixture.db, tenantId, contractAdmin.transitions, lifecycle).project(runKey(contractAdmin.run.runId));
  });

  test("public run reads consume bounded committed root transitions and recover from their cursor", async () => {
    const run = await start();
    const runIdentity = { tenantId, projectId, logicalRunId: run.runId, interpreterId: "root" };
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const projector = new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle);
    const first = { id: "projection-running", kind: "cancel", atMs: now, reason: "test" } as never;
    await persistTransition(runIdentity, 1, first, { status: "running" } as never, [], undefined, activities);
    const terminal = { kind: "complete-run", id: "projection-complete", output: { result: "done" } } as const;
    await persistTransition(runIdentity, 2, { id: "projection-complete-event", kind: "cancel", atMs: now + 1, reason: "test" } as never, { status: "completed" } as never, [terminal], undefined, activities);
    expect((await lifecycle.read(principal, runKey(run.runId))).status).toBe("queued");
    expect(await projector.progress(runKey(run.runId))).toMatchObject({ sequence: 0, lag: 2 });
    expect(await projector.project(runKey(run.runId), 1)).toMatchObject({ sequence: 1, lag: 1, applied: 1 });
    expect((await lifecycle.read(principal, runKey(run.runId))).status).toBe("running");
    const restarted = new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle);
    expect(await restarted.project(runKey(run.runId), 1)).toMatchObject({ sequence: 2, lag: 0, applied: 1 });
    expect(await lifecycle.read(principal, runKey(run.runId))).toMatchObject({ status: "succeeded", output: { kind: "inline", value: { result: "done" } } });
    expect(await restarted.project(runKey(run.runId))).toMatchObject({ sequence: 2, lag: 0, applied: 0 });
  });

  test("projected terminal status requires a root terminal command and preserves cancellation", async () => {
    const run = await start();
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const projector = new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle);
    const child = { tenantId, projectId, logicalRunId: run.runId, interpreterId: "child" };
    await persistTransition(child, 1, { id: "child-terminal", kind: "cancel", atMs: now, reason: "test" } as never, { status: "completed" } as never, [{ kind: "complete-run", id: "child-complete", output: {} }], undefined, activities);
    await projector.project(runKey(run.runId));
    expect((await lifecycle.read(principal, runKey(run.runId))).status).toBe("queued");
    const root = { ...child, interpreterId: "root" };
    await persistTransition(root, 1, { id: "partition-terminal", kind: "cancel", atMs: now + 1, reason: "test" } as never, { status: "completed" } as never, [{ kind: "complete-partition", id: "partition-complete", partitionId: "child" }], undefined, activities);
    await projector.project(runKey(run.runId));
    expect((await lifecycle.read(principal, runKey(run.runId))).status).not.toBe("succeeded");
    await cancelRun(principal, runKey(run.runId), 1, "projector-cancel");
    await persistTransition(root, 2, { id: "late-success", kind: "cancel", atMs: now + 2, reason: "test" } as never, { status: "completed" } as never, [{ kind: "complete-run", id: "late-complete", output: {} }], undefined, activities);
    await projector.project(runKey(run.runId));
    expect((await lifecycle.read(principal, runKey(run.runId))).status).toBe("cancelling");
    await persistTransition(root, 3, { id: "projected-cancel", kind: "cancel", atMs: now + 3, reason: "test" } as never, { status: "cancelled" } as never, [{ kind: "cancel-run", id: "root-cancel", reason: "cancelled" }], undefined, activities);
    await projector.project(runKey(run.runId));
    expect(await lifecycle.read(principal, runKey(run.runId))).toMatchObject({ status: "cancelled", error: { code: "FACTORY_RUN_CANCELLED", message: "cancelled" } });
  });

  test("persistent retry ordering prevents a corrupt oldest run from starving later work", async () => {
    const poisoned = await start();
    const healthy = await start();
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const projector = new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle);
    for (const run of [poisoned, healthy]) {
      const identity = { tenantId, projectId, logicalRunId: run.runId, interpreterId: "root" };
      await persistTransition(identity, 1, { id: `pending-${run.runId}`, kind: "cancel", atMs: now, reason: "test" } as never, { status: "completed" } as never, [{ kind: "complete-run", id: `pending-complete-${run.runId}`, output: { runId: run.runId } }], undefined, activities);
    }
    await fixture.db.execute(sql`UPDATE factory_audit_batches SET payload='{}' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${poisoned.runId}`);
    await fixture.db.execute(sql`UPDATE factory_audit_batches SET created_at='2030-01-01T00:00:00.000Z' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${poisoned.runId}`);
    await fixture.db.execute(sql`UPDATE factory_audit_batches SET created_at='2030-01-02T00:00:00.000Z' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${healthy.runId}`);
    const attempts = async () => rows<{ attempt_count: string | number; last_error_code: string }>(await fixture.db.execute(sql`SELECT attempt_count, last_error_code FROM factory_run_projection_attempts WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${poisoned.runId}`)).map(row => ({ attemptCount: Number(row.attempt_count), errorCode: row.last_error_code }));
    expect(await projector.projectPending({ runs: 1, batchesPerRun: 1 })).toMatchObject({ runs: [{ key: runKey(poisoned.runId), errorCode: "factory_audit_corrupt" }] });
    expect(await attempts()).toEqual([{ attemptCount: 1, errorCode: "factory_audit_corrupt" }]);
    const second = await projector.projectPending({ runs: 1, batchesPerRun: 1 });
    expect(second).toMatchObject({ runs: [{ key: runKey(healthy.runId), progress: { lag: 0, applied: 1 } }] });
    expect((await lifecycle.read(principal, runKey(healthy.runId))).status).toBe("succeeded");
    const restarted = new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle);
    expect(await restarted.projectPending({ runs: 1, batchesPerRun: 1 })).toMatchObject({ runs: [{ key: runKey(poisoned.runId), errorCode: "factory_audit_corrupt" }] });
    expect(await attempts()).toEqual([{ attemptCount: 2, errorCode: "factory_audit_corrupt" }]);
    await expect(projector.projectPending({ runs: 0 })).rejects.toThrow("page");
  });

  test("projection rejects corrupt sources, foreign scope, and rolls cursor back with the read model", async () => {
    const run = await start();
    const identity = { tenantId, projectId, logicalRunId: run.runId, interpreterId: "root" };
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const projector = new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle);
    await persistTransition(identity, 1, { id: "corrupt-projection", kind: "cancel", atMs: now, reason: "test" } as never, { status: "completed" } as never, [{ kind: "complete-run", id: "corrupt-complete", output: {} }], undefined, activities);
    await fixture.db.execute(sql`UPDATE factory_audit_batches SET payload='{}' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId}`);
    await expect(projector.project(runKey(run.runId))).rejects.toThrow("factory_audit_corrupt");
    expect(await projector.progress(runKey(run.runId))).toMatchObject({ sequence: 0, lag: 1 });
    expect((await lifecycle.read(principal, runKey(run.runId))).status).toBe("queued");
    await expect(projector.project({ projectId: "foreign-project", runId: run.runId })).rejects.toMatchObject({ code: "factory_run_not_found" });
    expect(() => new FactoryRunTransitionProjector(fixture.db, "foreign-tenant", transitions, lifecycle)).toThrow("scope");

    const rollback = await start();
    const rollbackIdentity = { ...identity, logicalRunId: rollback.runId };
    await persistTransition(rollbackIdentity, 1, { id: "rollback-projection", kind: "cancel", atMs: now, reason: "test" } as never, { status: "completed" } as never, [{ kind: "complete-run", id: "rollback-complete", output: {} }], undefined, activities);
    await fixture.db.execute(sql`CREATE FUNCTION reject_projected_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'projection rejected'; END $$`);
    await fixture.db.execute(sql`CREATE TRIGGER reject_projected_lifecycle BEFORE UPDATE ON factory_run_lifecycle FOR EACH ROW EXECUTE FUNCTION reject_projected_lifecycle()`);
    try { await expect(projector.project(runKey(rollback.runId))).rejects.toThrow(); }
    finally {
      await fixture.db.execute(sql`DROP TRIGGER reject_projected_lifecycle ON factory_run_lifecycle`);
      await fixture.db.execute(sql`DROP FUNCTION reject_projected_lifecycle()`);
    }
    expect(await projector.progress(runKey(rollback.runId))).toMatchObject({ sequence: 0, lag: 1 });
    expect((await lifecycle.read(principal, runKey(rollback.runId))).status).toBe("queued");
  });

  test("durable run receipts expose verified dispatch status without exposing command bodies", async () => {
    const accepted = await lifecycle.start(principal, key, body, 0, "receipt-start");
    const run = runKey(accepted.run.runId);
    expect(accepted.receipt.resourceId).toBe(run.runId);
    expect(accepted.receipt.statusUrl).toBe(`/api/factories/projects/${projectId}/runs/${run.runId}/commands/${encodeURIComponent(accepted.receipt.commandId)}`);
    expect(validateFactoryApiResponse({ schemaVersion: "factory.api.response.v1", kind: "mutation.accepted", receipt: accepted.receipt })).toEqual({ ok: true });
    const queued = await lifecycle.readCommand(principal, run, accepted.receipt.commandId);
    expect(queued).toMatchObject({ commandId: accepted.receipt.commandId, runId: run.runId, state: "queued", attempts: 0 });
    expect(validateFactoryApiResponse({ schemaVersion: "factory.api.response.v1", kind: "command.resource", resource: queued })).toEqual({ ok: true });
    expect(Object.hasOwn(queued, "body")).toBe(false);
    const outbox = new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now);
    const record = (await outbox.inspect(queued.commandId))!;
    await fixture.db.execute(sql`UPDATE factory_command_outbox SET state='outcome_unknown', payload=${JSON.stringify({ ...record, state: "outcome_unknown", attempts: 1, failureCode: "worker_lease_expired" })} WHERE id=${record.id}`);
    expect(await lifecycle.readCommand(principal, run, record.id)).toMatchObject({ state: "outcome_unknown", failureCode: "worker_lease_expired", attempts: 1 });
    expect((await lifecycle.read(principal, run)).status).toBe("queued");
    expect(await lifecycle.start(principal, key, body, 0, "receipt-start")).toEqual(accepted);
    await expect(lifecycle.readCommand(principal, runKey("foreign-run"), record.id)).rejects.toMatchObject({ code: "factory_command_not_found" });
    await expect(lifecycle.readCommand(principal, run, "missing-command")).rejects.toMatchObject({ code: "factory_command_not_found" });
    await expect(lifecycle.readCommand({ ...principal, id: "stranger" }, run, record.id)).rejects.toMatchObject({ code: "factory_forbidden" });
    const cancel = await lifecycle.cancel(principal, run, 1, "receipt-cancel");
    const repeat = await lifecycle.cancel(principal, run, 2, "receipt-already-cancelling");
    expect(repeat).toEqual(cancel);
    expect(cancel.receipt.commandId).not.toBe(accepted.receipt.commandId);
    expect(await lifecycle.readCommand(principal, run, cancel.receipt.commandId)).toMatchObject({ kind: "decision", state: "queued" });
    await fixture.db.execute(sql`DELETE FROM factory_command_outbox WHERE id=${cancel.receipt.commandId}`);
    await expect(lifecycle.cancel(principal, run, 2, "receipt-missing-original")).rejects.toMatchObject({ code: "factory_command_not_found" });
  });

  test("run lists use bounded scoped database pages and literal server-side filters", async () => {
    await start(); await start();
    const page = await lifecycle.list(principal, projectId, { limit: 1, factoryId: key.factoryId, status: "queued", search: "LIFECYCLE" });
    expect(page.items).toHaveLength(1); expect(page.nextCursor).not.toBeNull();
    expect(Object.hasOwn(page.items[0]!, "parameters")).toBe(false);
    const next = await lifecycle.list(principal, projectId, { limit: 1, cursor: page.nextCursor! });
    expect(next.items[0]!.runId > page.items[0]!.runId).toBe(true);
    expect(await lifecycle.list(principal, projectId, { search: "%_" })).toEqual({ items: [], nextCursor: null });
    expect(await lifecycle.list(principal, projectId, { factoryId: "missing" })).toEqual({ items: [], nextCursor: null });
    expect((await lifecycle.list(principal, projectId)).items.length).toBeGreaterThan(0);
    for (const query of [{ limit: 0 }, { limit: 201 }, { limit: 1.1 }, { cursor: "a".repeat(2049) }, { search: "" }, { search: "a".repeat(513) }, { status: "invalid" as never }]) await expect(lifecycle.list(principal, projectId, query)).rejects.toMatchObject({ code: "factory_page_invalid" });
    await expect(lifecycle.list({ ...principal, id: "stranger" }, projectId)).rejects.toMatchObject({ code: "factory_forbidden" });
  });

  test("outbox failure rolls back run, budget, audit and mutation receipt", async () => {
    const before = rows(await fixture.db.execute(sql`SELECT run_id FROM factory_runs`)).length;
    const budgetsBefore = rows(await fixture.db.execute(sql`SELECT envelope_id FROM factory_budget_envelopes`)).length;
    const artifactsBefore = rows(await fixture.db.execute(sql`SELECT object_id FROM factory_artifacts`)).length;
    await fixture.db.execute(sql`CREATE FUNCTION reject_lifecycle_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'command failed'; END $$`);
    await fixture.db.execute(sql`CREATE TRIGGER reject_lifecycle_command BEFORE INSERT ON factory_command_outbox FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_command()`);
    try { await expect(startRun(principal, key, body, 0, "rollback-start")).rejects.toThrow(); }
    finally {
      await fixture.db.execute(sql`DROP TRIGGER reject_lifecycle_command ON factory_command_outbox`);
      await fixture.db.execute(sql`DROP FUNCTION reject_lifecycle_command()`);
    }
    expect(rows(await fixture.db.execute(sql`SELECT run_id FROM factory_runs`))).toHaveLength(before);
    expect(rows(await fixture.db.execute(sql`SELECT envelope_id FROM factory_budget_envelopes`))).toHaveLength(budgetsBefore);
    expect(rows(await fixture.db.execute(sql`SELECT object_id FROM factory_artifacts`))).toHaveLength(artifactsBefore);
    expect(rows(await fixture.db.execute(sql`SELECT idempotency_key FROM factory_mutation_receipts WHERE idempotency_key='rollback-start'`))).toEqual([]);
    expect((await startRun(principal, key, body, 0, "rollback-start")).status).toBe("queued");
  });

  test("current initiators can cancel without operate authority; other members and revoked initiators cannot", async () => {
    const actor: FactoryPrincipal = { kind: "user", id: "run-only-member", authentication: "api-key" };
    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${actor.id}, 'run-only@example.test', 'not-a-login', 'Run only', 'user')`);
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('run-only-membership', ${projectId}, ${actor.id}, 'member')`);
    await grants.set(principal, { principal: actor, projectId, action: "factory.run", expectedRevision: 0, expiresAtMs: null });
    const owned = await startRun(actor, key, body, 0, "run-only-start");
    const other = await start();
    await expect(cancelRun(actor, runKey(other.runId), 1, "cancel-other")).rejects.toMatchObject({ code: "factory_forbidden" });
    expect((await cancelRun(actor, runKey(owned.runId), 1, "cancel-owned")).status).toBe("cancelling");
    await grants.revoke(principal, { principal: actor, projectId, action: "factory.run", expectedRevision: 1 });
    await expect(cancelRun(actor, runKey(owned.runId), 1, "cancel-owned")).rejects.toMatchObject({ code: "factory_forbidden" });
    await grants.set(principal, { principal: actor, projectId, action: "factory.operate", expectedRevision: 0, expiresAtMs: null });
    expect((await cancelRun(actor, runKey(owned.runId), 1, "cancel-owned")).status).toBe("cancelling");
    expect((await cancelRun(actor, runKey(other.runId), 1, "cancel-other")).status).toBe("cancelling");
  });

  test("service initiator expiry and grant storage failures cannot bypass cancellation authority", async () => {
    const service: FactoryPrincipal = { kind: "service", id: "run-service", authentication: "service" };
    await fixture.db.execute(sql`INSERT INTO service_accounts(id,name,created_by_user_id,project_id,max_tokens_per_day,expires_at) VALUES (${service.id}, 'run-service', ${principal.id}, ${projectId}, 100, ${new Date(now + duration)})`);
    await grants.set(principal, { principal: service, projectId, action: "factory.run", expectedRevision: 0, expiresAtMs: now + duration });
    const run = await startRun(service, key, body, 0, "service-start");
    expect((await cancelRun(service, runKey(run.runId), 1, "service-cancel")).status).toBe("cancelling");
    await fixture.db.execute(sql`UPDATE service_accounts SET expires_at=${new Date(now)} WHERE id=${service.id}`);
    await expect(cancelRun(service, runKey(run.runId), 1, "service-cancel")).rejects.toMatchObject({ code: "factory_forbidden" });
    const userRun = await start();
    const original = grants.authorizeInTransaction.bind(grants);
    const authorization = spyOn(grants, "authorizeInTransaction").mockImplementation((transaction, actor, project, action, revision) => {
      if (action === "factory.run") throw new Error("grant storage unavailable");
      return original(transaction, actor, project, action, revision);
    });
    try { await expect(cancelRun(principal, runKey(userRun.runId), 1, "storage-denied")).rejects.toThrow("grant storage unavailable"); }
    finally { authorization.mockRestore(); }
    expect((await lifecycle.read(principal, runKey(userRun.runId))).status).toBe("queued");
  });

  test("durable public service runs retain and recheck their credential fence", async () => {
    const service: FactoryPrincipal = { kind: "service", id: "run-http-service", authentication: "service" };
    await fixture.db.execute(sql`INSERT INTO service_accounts(id,name,created_by_user_id,project_id,max_tokens_per_day,expires_at) VALUES (${service.id}, 'run-http-service', ${principal.id}, ${projectId}, 100, ${new Date(now + duration)})`);
    await grants.set(principal, { principal: service, projectId, action: "factory.run", expectedRevision: 0, expiresAtMs: now + duration });
    const expiresAtMs = (Math.floor(Date.now() / 1_000) + 600) * 1_000;
    const credentials = new FactoryServiceCredentials(fixture.db, tenantId, grants);
    const credential = await credentials.issue(principal, { projectId, serviceAccountId: service.id, scopes: ["chat"], expiresAtMs, expectedRevision: 0 }, "run-http-credential");
    const publicService: FactoryPrincipal = { ...service, credential };
    const run = await startRun(publicService, key, body, 0, "run-http-service-start");
    const stored = await fixture.db.transaction(transaction => new FactoryRecords(fixture.db, tenantId).readRunRequestInTransaction(transaction, runKey(run.runId)));
    expect(stored.serviceCredential).toMatchObject({ credentialId: credential.credentialId, revision: 1, scopes: ["chat"] });
    await expect(fixture.db.transaction(transaction => lifecycle.authorizeRunInTransaction(transaction, runKey(run.runId)))).resolves.toMatchObject({ grantRevision: 1 });
    await credentials.revoke(principal, { projectId, serviceAccountId: service.id, credentialId: credential.credentialId, expectedRevision: 1 }, "run-http-credential-revoke");
    await expect(startRun(publicService, key, body, 0, "run-http-service-start")).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
    await expect(fixture.db.transaction(transaction => lifecycle.authorizeRunInTransaction(transaction, runKey(run.runId)))).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  });

  test("cancellation fences admission, retains unknown holds and is atomic with its decision", async () => {
    const run = await start(); const key = runKey(run.runId);
    const request = { ...key, envelopeId: "root", reservationId: "pending-budget", amount: { costMicros: "5", tokens: 5, computeMs: 5 }, computeRequest: { cpu: 1 } };
    await fixture.db.transaction(tx => lifecycle.budgets.reserveInTransaction(tx, request, async () => {}));
    await lifecycle.budgets.markUncertain(request, "provider-unknown");
    const results = await Promise.allSettled([cancelRun(principal, key, 1, "cancel-a"), cancelRun(principal, key, 1, "cancel-b")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const current = await lifecycle.read(principal, key);
    expect(current).toMatchObject({ status: "cancelling", revision: 2 });
    expect((await cancelRun(principal, key, 2, "already-cancelled")).revision).toBe(2);
    const winningKey = results[0]!.status === "fulfilled" ? "cancel-a" : "cancel-b";
    expect(await cancelRun(principal, key, 1, winningKey)).toEqual(current);
    await expect(lifecycle.budgets.reserve({ ...request, reservationId: "late" }, async () => {})).rejects.toMatchObject({ code: "factory_run_stopped" });
    expect((await lifecycle.budgets.inspect({ ...key, envelopeId: "root" })).allocated.tokens).toBe("5");
    const decisions = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_command_outbox WHERE logical_run_id=${run.runId} AND payload::jsonb->'command'->>'kind'='decision'`));
    expect(decisions).toHaveLength(1);
    expect(JSON.parse(decisions[0]!.payload).command.body.kind).toBe("cancel");
    await lifecycle.budgets.settle(request, { costMicros: "3", tokens: 3, computeMs: 3 }, `sha256:${"b".repeat(64)}`);
    expect((await lifecycle.budgets.inspect({ ...key, envelopeId: "root" })).spent.tokens).toBe("3");
  });

  test("cancel command failure rolls back its fence, audit and response receipt", async () => {
    const run = await start(); const key = runKey(run.runId);
    await fixture.db.execute(sql`CREATE FUNCTION reject_lifecycle_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cancel command failed'; END $$`);
    await fixture.db.execute(sql`CREATE TRIGGER reject_lifecycle_cancel BEFORE INSERT ON factory_command_outbox FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_cancel()`);
    try { await expect(cancelRun(principal, key, 1, "rollback-cancel")).rejects.toThrow(); }
    finally {
      await fixture.db.execute(sql`DROP TRIGGER reject_lifecycle_cancel ON factory_command_outbox`);
      await fixture.db.execute(sql`DROP FUNCTION reject_lifecycle_cancel()`);
    }
    expect(await lifecycle.read(principal, key)).toEqual(run);
    expect(rows(await fixture.db.execute(sql`SELECT cancellation_epoch FROM factory_run_lifecycle WHERE run_id=${run.runId}`)).map(row => Number((row as { cancellation_epoch: string }).cancellation_epoch))).toEqual([0]);
    expect(rows(await fixture.db.execute(sql`SELECT id FROM audit_log WHERE target=${run.runId} AND action='factory.run.cancel.requested'`))).toEqual([]);
    expect(rows(await fixture.db.execute(sql`SELECT idempotency_key FROM factory_mutation_receipts WHERE idempotency_key='rollback-cancel'`))).toEqual([]);
    expect((await cancelRun(principal, key, 1, "rollback-cancel")).status).toBe("cancelling");
  });

  test("current membership and grant revision are checked even for cached starts", async () => {
    const prior = await startRun(principal, key, body, 0, "recheck-start");
    await grants.set(principal, { principal, projectId, action: "factory.run", expectedRevision: 1, expiresAtMs: null });
    await expect(startRun(principal, key, body, 0, "recheck-start")).rejects.toMatchObject({ code: "factory_grant_stale" });
    body = { ...body, grantRevision: 2 };
    await fixture.db.execute(sql`DELETE FROM project_members WHERE user_id=${principal.id}`);
    await expect(lifecycle.read(principal, runKey(prior.runId))).rejects.toMatchObject({ code: "factory_forbidden" });
    await expect(start()).rejects.toMatchObject({ code: "factory_forbidden" });
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('lifecycle-membership', ${projectId}, ${principal.id}, 'owner')`);
    expect((await start()).grantRevision).toBe(2);
  });

  test("every attempt admission checks current epochs, grant revision and bounded deadline", async () => {
    const run = await start(); const key = runKey(run.runId);
    const authority = { tenantId, ...key, attemptId: "attempt", nodeInstanceId: "node", candidateGeneration: 0, attemptNumber: 1, grantRevision: body.grantRevision, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(now + 10) };
    const check = (value = authority) => fixture.db.transaction(tx => lifecycle.authorizeAttemptInTransaction(tx, value));
    await check();
    const fence = await fixture.db.transaction(tx => lifecycle.authorizeRunInTransaction(tx, key));
    expect(fence).toEqual({ tenantId, ...key, executionEpoch: 1, cancellationEpoch: 0, grantRevision: body.grantRevision, revision: 1, deadlineAtMs: now + duration, definitionDigest: body.definitionDigest, status: "queued" });
    expect(Object.isFrozen(fence)).toBe(true);
    await expect(check({ ...authority, tenantId: "foreign" })).rejects.toMatchObject({ code: "factory_scope_mismatch" });
    for (const changed of [{ executionEpoch: 2 }, { cancellationEpoch: 1 }, { grantRevision: 999 }, { deadlineAt: new Date(now + duration + 1) }, { deadlineAt: new Date(now) }, { deadlineAt: new Date(Number.NaN) }]) await expect(check({ ...authority, ...changed })).rejects.toMatchObject({ code: "factory_run_fence_changed" });
    await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch=2`);
    await expect(check()).rejects.toMatchObject({ code: "factory_run_fence_changed" });
    await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch=1`);
    await check();
    await cancelRun(principal, key, 1, "cancel-attempt");
    await expect(check()).rejects.toMatchObject({ code: "factory_run_stopped" });
  });

  test("trusted fence reads reject corrupt durable identity and unsafe counters", async () => {
    const run = await start(); const key = runKey(run.runId);
    for (const change of [sql`revision=9007199254740992`, sql`cancellation_epoch=9007199254740992`, sql`definition_digest=${`sha256:${"e".repeat(64)}`}`]) {
      await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET ${change} WHERE run_id=${run.runId}`);
      await expect(fixture.db.transaction(tx => lifecycle.authorizeRunInTransaction(tx, key))).rejects.toMatchObject({ code: "factory_run_corrupt" });
      await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET revision=1, cancellation_epoch=0, definition_digest=${body.definitionDigest} WHERE run_id=${run.runId}`);
    }
  });

  test("input, version, scope, terminal state, counters and deadline checks fail closed", async () => {
    await expect(startRun(principal, key, body, 1, "bad-revision")).rejects.toMatchObject({ code: "factory_revision_conflict" });
    await expect(startRun(principal, key, { ...body, definitionDigest: `sha256:${"c".repeat(64)}` }, 0, "bad-digest")).rejects.toMatchObject({ code: "factory_definition_conflict" });
    await expect(startRun(principal, key, { ...body, parameters: {} }, 0, "bad-input")).rejects.toMatchObject({ code: "factory_input_invalid" });
    const incompatible = new FactoryRunLifecycle(fixture.db, tenantId, { ...options, interpreterCompatibility: "different" }, () => now);
    await expect(incompatible.start(principal, key, body, 0, "incompatible")).rejects.toMatchObject({ code: "factory_interpreter_unavailable" });
    expect(() => new FactoryRunLifecycle(fixture.db, "foreign", options)).toThrow("factory_scope_mismatch");
    const invalidClock = new FactoryRunLifecycle(fixture.db, tenantId, options, () => Number.MAX_SAFE_INTEGER);
    await expect(invalidClock.start(principal, key, body, 0, "bad-clock")).rejects.toMatchObject({ code: "factory_deadline_invalid" });
    const wrongStage = new FactoryRunLifecycle(fixture.db, tenantId, { ...options, stageDefinitionInTransaction: async (transaction, compiled, identity) => ({ ...await options.stageDefinitionInTransaction(transaction, compiled, identity), definitionDigest: `sha256:${"d".repeat(64)}` }) }, () => now);
    await expect(wrongStage.start(principal, key, body, 0, "wrong-stage")).rejects.toMatchObject({ code: "factory_definition_conflict" });
    const run = await start(); const scoped = runKey(run.runId);
    await expect(lifecycle.read(principal, runKey("missing"))).rejects.toMatchObject({ code: "factory_run_not_found" });
    await expect(cancelRun(principal, scoped, 0, "bad-cancel")).rejects.toMatchObject({ code: "factory_revision_invalid" });
    await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET status='succeeded', output_json='{"kind":"inline","value":1}', error_json='{"code":"TEST","message":"recorded"}' WHERE run_id=${run.runId}`);
    expect(await lifecycle.read(principal, scoped)).toMatchObject({ output: { kind: "inline", value: 1 }, error: { code: "TEST", message: "recorded" } });
    await expect(cancelRun(principal, scoped, 1, "terminal")).rejects.toMatchObject({ code: "factory_run_terminal" });
    await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET status='queued', cancellation_epoch=${Number.MAX_SAFE_INTEGER} WHERE run_id=${run.runId}`);
    await expect(cancelRun(principal, scoped, 1, "bad-epoch")).rejects.toMatchObject({ code: "factory_epoch_invalid" });
    await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET parameters_json='{}' WHERE run_id=${run.runId}`);
    await expect(lifecycle.read(principal, scoped)).rejects.toMatchObject({ code: "factory_run_corrupt" });
    const deadline = await start();
    now += duration;
    await expect(fixture.db.transaction(tx => lifecycle.authorizeAdmissionInTransaction(tx, runKey(deadline.runId)))).rejects.toMatchObject({ code: "factory_run_stopped" });
  });

  const withPrivateConnection = async (current: Pick<Awaited<ReturnType<typeof committedInterpreter>>, "activities">, commands: FactoryPrivateCommands, work: (connection: { url: string; certs: Certificates; token: string }) => Promise<void>) => {
    const directories: string[] = [];
    let server: ReturnType<typeof startFactoryPrivateService> | undefined;
    try {
      const certs = await certificates(directories, "orchestration");
      const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const issuer = "factory-command-fixture";
      const audience = "factory-private-service";
      const token = signedServiceToken(keys.privateKey, { sub: "orchestration", iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 60, scope: ["factory:orchestrate"] });
      server = startFactoryPrivateService({
        tenantId, certificateIdentity: "orchestration", tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey },
        tokens: async () => ({ issuer, audience, publicKeys: { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() } }),
        queue: new FactoryTransportQueue(new FactoryCommandOutbox(fixture.db, tenantId, projectId), new FactoryInbox(fixture.db, tenantId)),
        artifacts: current.activities, commands,
      });
      await work({ url: server.url, certs, token });
    } finally {
      server?.stop();
      await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
    }
  };

  test("the real private Node connection admits only the committed task and exact durable request", async () => {
    const task = await dispatchedTask();
    const node = task.compiled.indexes.nodeById[task.dispatch.nodeId];
    if (node?.kind !== "task") throw new Error("missing task node");
    const policy = new FactoryNativeRunnerPolicy(tenantId, grants, [{ runner: node.runner, resourceClass: "cpu", allocation: task.profile, allowedCapabilities: [], tools: [] }], "factory-broker");
    const execution = new FactoryTaskExecutionAdmission(task.authority, task.admissions, task.journal, task.queue, policy, () => now);
    await withPrivateConnection(task, privateCommands(task.authority, task.transitions, { execution }), async ({ url: baseUrl, certs, token }) => {
      const url = `${baseUrl}/internal/factory/v1/executions/${encodeURIComponent(task.dispatch.id)}`;
      const body = { ...task.identity, command: { ...task.dispatch, input: { forged: true }, runner: { package: "untrusted" }, grants: ["admin"], resources: { memoryBytes: 999999 } } };
      expect((await nodeHttpsRequest(url, certs, { method: "PUT", token: "invalid", body })).status).toBe(401);
      expect(await fixture.db.transaction(tx => task.queue.readStoredInTransaction(tx, projectId, task.dispatch.id))).toBeNull();
      for (let retry = 0; retry < 2; retry++) expect((await nodeHttpsRequest(url, certs, { method: "PUT", token, body })).status).toBe(204);
      const stored = await fixture.db.transaction(tx => task.queue.readStoredInTransaction(tx, projectId, task.dispatch.id));
      expect(stored?.request).toMatchObject({ runner: node.runner, input: { kind: "inline", value: task.dispatch.input }, grants: [], resources: { memoryBytes: 128 }, authority: { attemptId: task.dispatch.id, tenantId, projectId, runId: task.run.runId } });
      expect((await nodeHttpsRequest(url, certs, { method: "PUT", token, body: { ...body, tenantId: "foreign" } })).status).toBe(403);
      expect(await fixture.db.transaction(tx => task.queue.readStoredInTransaction(tx, projectId, task.dispatch.id))).toEqual(stored);
    });
  });

  const partitionFixture = async (suffix: string, active = true, failed = false) => {
    const definitionKey = { projectId, factoryId: `partition-${suffix}-factory` };
    const prototype = referenceCodeV1.graph.nodes.find(node => node.kind === "task");
    if (prototype?.kind !== "task") throw new Error("missing task fixture");
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: definitionKey.factoryId, inputPorts: {}, outputPorts: {},
      bounds: { ...referenceCodeV1.bounds, maxExpandedNodes: 512 },
      graph: { nodes: [
        failed ? { id: "a", kind: "task", runner: prototype.runner, retry: { maxAttempts: 1, initialDelayMs: 1, maximumDelayMs: 1 } } : { id: "a", kind: "join", mode: "all", predecessors: [] },
        ...Array.from({ length: 130 }, (_, index) => (active ? { id: `slow-${String(index).padStart(3, "0")}`, kind: "task" as const, runner: prototype.runner } : { id: `slow-${String(index).padStart(3, "0")}`, kind: "join" as const, mode: "all" as const, predecessors: [] })),
        { id: "z", kind: "join", mode: "all", predecessors: ["a"] },
      ], outputs: {} } };
    await definitions.save(principal, definitionKey, 0, `${suffix}-partition-create`, source);
    const version = await definitions.publish(principal, definitionKey, 1, `${suffix}-partition-publish`);
    const request = { ...body, factoryVersion: version.version, definitionDigest: version.definitionDigest, parameters: {} };
    const run = await startRun(principal, definitionKey, request, 0, `${suffix}-partition-start`);
    const current = await committedInterpreter(run.runId, definitionKey, request);
    const sourcePartition = current.compiled.partitions.find(partition => partition.nodeIds.includes("a"))!;
    const targetPartition = current.compiled.partitions.find(partition => partition.nodeIds.includes("z"))!;
    expect(sourcePartition.id).not.toBe(targetPartition.id);
    const identity = { ...current.identity, interpreterId: sourcePartition.id };
    const initial = createPartitionKernelState(current.compiled, sourcePartition.id, run.runId, {}, now);
    let first = advanceKernel(current.compiled, initial, current.event);
    await persistTransition(identity, 1, current.event, first.nextState, first.commands, undefined, current.activities);
    if (failed) {
      const admission = first.commands.find(value => value.kind === "request-admission" && value.nodeId === "a");
      if (admission?.kind !== "request-admission") throw new Error("missing source admission");
      const admitted = { kind: "admission-result" as const, id: `${admission.id}:admitted`, atMs: now + 1, nodeId: "a", commandId: admission.id, candidateGeneration: 0, granted: true };
      first = advanceKernel(current.compiled, first.nextState, admitted);
      await persistTransition(identity, 2, admitted, first.nextState, first.commands, undefined, current.activities);
      const dispatch = first.commands.find(value => value.kind === "dispatch-node" && value.nodeId === "a");
      if (dispatch?.kind !== "dispatch-node") throw new Error("missing source dispatch");
      const failure = { kind: "node-failed" as const, id: `${dispatch.id}:failed`, atMs: now + 2, nodeId: "a", commandId: dispatch.id, candidateGeneration: 0, attempt: dispatch.attempt, error: "source failed", failureKind: "execution" as const };
      first = advanceKernel(current.compiled, first.nextState, failure);
      await persistTransition(identity, 3, failure, first.nextState, first.commands, undefined, current.activities);
      const stopped = { kind: "attempt-stopped" as const, id: `${dispatch.id}:stopped`, atMs: now + 3, nodeId: "a", commandId: dispatch.id, candidateGeneration: 0, attempt: dispatch.attempt, uncertain: false };
      first = advanceKernel(current.compiled, first.nextState, stopped);
      await persistTransition(identity, 4, stopped, first.nextState, first.commands, undefined, current.activities);
    }
    const command = first.commands.find(value => value.kind === "notify-partition");
    if (command?.kind !== "notify-partition") throw new Error("missing partition notification");
    return { current, identity, first, sourcePartition, targetPartition, run, command };
  };
  test("a published partition persists its full bounded command batch above the activity concurrency limit", async () => {
    const { first, run, sourcePartition, current, identity } = await partitionFixture("batch");
    expect(first.commands.length).toBeGreaterThan(32);
    const indexed = rows(await fixture.db.execute(sql`SELECT command_id FROM factory_transition_commands WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND interpreter_id=${sourcePartition.id}`));
    expect(indexed).toHaveLength(first.commands.length);
    for (const command of [first.commands[0]!, first.commands.at(-1)!]) expect(await current.transitions.loadStoredCommand({ ...identity, commandId: command.id })).toEqual(command);
  });
  test("partition commands persist one notification for an unstarted successor across harmless source progress", async () => {
    const { current, identity, first, targetPartition, run, command } = await partitionFixture("delivery");
    const { FactoryPartitionCommands } = await import("../../factory/partition-commands");
    const deliveries = new FactoryPartitionCommands(current.authority, new FactoryInbox(fixture.db, tenantId, () => now));
    const service = { tenantId, subject: "orchestration" };
    const reference = { ...identity, commandId: command.id };
    const commands = privateCommands(current.authority, current.transitions, {}, { "notify-partition": deliveries.execute.bind(deliveries), "invalidate-partition": deliveries.execute.bind(deliveries) });
    expect(await commands.execute(service, reference)).toBeNull();
    const saved = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND interpreter_id=${targetPartition.id}`));
    expect(saved).toHaveLength(1);
    const notification = JSON.parse(saved[0]!.payload);
    expect(notification).toEqual({ ...command, id: `${command.id}:result`, kind: "partition-node-completed", atMs: now });
    expect(rows(await fixture.db.execute(sql`SELECT source_sequence FROM factory_audit_batches WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND interpreter_id=${targetPartition.id}`))).toHaveLength(0);
    const event = { kind: "timer-expired" as const, id: "partition-harmless-progress", commandId: "unknown-timer", atMs: now + 1 };
    const next = advanceKernel(current.compiled, first.nextState, event);
    await persistTransition(identity, 2, event, next.nextState, next.commands, undefined, current.activities);
    expect(await deliveries.execute(service, reference)).toBeNull();
    expect(rows(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND interpreter_id=${targetPartition.id}`))).toEqual(saved);
    const target = advanceKernel(current.compiled, createPartitionKernelState(current.compiled, targetPartition.id, run.runId, {}, now), current.event);
    expect(target.nextState.nodes.z?.status).toBe("ready");
    expect(advanceKernel(current.compiled, target.nextState, notification).nextState.nodes.z?.status).toBe("succeeded");
    await expect(deliveries.execute({ ...service, tenantId: "foreign" }, reference)).rejects.toMatchObject({ code: "factory_command_forbidden" });
  });

  test("a completed source delivers only after the destination inbox and outbox commit together", async () => {
    const { current, identity, first, targetPartition, run, command } = await partitionFixture("rollback", false);
    expect(first.nextState.status).toBe("completed");
    const { FactoryPartitionCommands } = await import("../../factory/partition-commands");
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    expect(() => new FactoryPartitionCommands(current.authority, { ...inbox, tenantId: "foreign" } as FactoryInbox)).toThrow("factory_partition_commands_invalid");
    const deliveries = new FactoryPartitionCommands(current.authority, inbox);
    const service = { tenantId, subject: "orchestration" };
    const reference = { ...identity, commandId: command.id };
    const enqueue = inbox.enqueueInTransaction.bind(inbox);
    const fault = spyOn(inbox, "enqueueInTransaction").mockImplementationOnce(async (...args) => { await enqueue(...args); throw new Error("partition inbox commit fault"); });
    try { await expect(deliveries.execute(service, reference)).rejects.toThrow("partition inbox commit fault"); }
    finally { fault.mockRestore(); }
    expect(rows(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId}`))).toHaveLength(0);
    expect(rows(await fixture.db.execute(sql`SELECT id FROM factory_command_outbox WHERE tenant_id=${tenantId} AND project_id=${projectId} AND logical_run_id=${run.runId} AND payload::jsonb->'command'->>'kind'='partition_notification'`))).toHaveLength(0);
    const mutable = { ...reference };
    const pending = deliveries.execute(service, mutable);
    mutable.logicalRunId = "foreign";
    expect(await pending).toBeNull();
    const stored = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND interpreter_id=${targetPartition.id}`));
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.payload)).toMatchObject({ id: `${command.id}:result`, atMs: now, outcome: "succeeded" });
    await fixture.db.execute(sql`UPDATE factory_transition_commands SET command_digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND interpreter_id=${identity.interpreterId} AND command_id=${command.id}`);
    await expect(deliveries.execute(service, reference)).rejects.toMatchObject({ code: "factory_transition_command_corrupt" });
    expect(rows(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND interpreter_id=${targetPartition.id}`))).toEqual(stored);
  });

  test("repair invalidation rejects old source output and delivers the new candidate by the same durable route", async () => {
    const { current, identity, first, targetPartition, run, command } = await partitionFixture("repair");
    const { FactoryPartitionCommands } = await import("../../factory/partition-commands");
    const deliveries = new FactoryPartitionCommands(current.authority, new FactoryInbox(fixture.db, tenantId, () => now));
    const service = { tenantId, subject: "orchestration" };
    const reference = { ...identity, commandId: command.id };
    expect(await deliveries.execute(service, reference)).toBeNull();
    const repair = { kind: "repair" as const, id: "partition-delivery-repair", atMs: now + 1, nodeId: "a", reason: "replace source" };
    const repaired = advanceKernel(current.compiled, first.nextState, repair);
    await persistTransition(identity, 2, repair, repaired.nextState, repaired.commands, undefined, current.activities);
    await expect(deliveries.execute(service, reference)).rejects.toMatchObject({ code: "factory_command_stale" });
    const invalidation = repaired.commands.find(value => value.kind === "invalidate-partition")!;
    const notification = repaired.commands.find(value => value.kind === "notify-partition")!;
    expect(invalidation).toBeDefined(); expect(notification).toBeDefined();
    for (const effect of [invalidation, notification]) expect(await deliveries.execute(service, { ...identity, commandId: effect.id })).toBeNull();
    const events = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND interpreter_id=${targetPartition.id} ORDER BY sequence`)).map(row => JSON.parse(row.payload));
    expect(events.map(value => value.kind)).toEqual(["partition-node-completed", "partition-source-invalidated", "partition-node-completed"]);
    let target = advanceKernel(current.compiled, createPartitionKernelState(current.compiled, targetPartition.id, run.runId, {}, now), current.event).nextState;
    target = advanceKernel(current.compiled, target, events[0]).nextState;
    expect(target.nodes.z?.status).toBe("succeeded");
    target = advanceKernel(current.compiled, target, events[1]).nextState;
    expect(target.nodes.z?.status).not.toBe("succeeded");
    target = advanceKernel(current.compiled, target, { ...events[0], id: "stale-generation-replay" }).nextState;
    expect(target.nodes.z?.status).not.toBe("succeeded");
    target = advanceKernel(current.compiled, target, events[2]).nextState;
    expect(target.nodes.z).toMatchObject({ status: "succeeded", candidateGeneration: 1 });
  });

  test("a failed partition source delivers its terminal outcome to the successor", async () => {
    const { current, identity, first, targetPartition, run, command } = await partitionFixture("failed", false, true);
    expect(command.outcome).toBe("failed");
    expect(first.nextState.status).toBe("failed");
    const { FactoryPartitionCommands } = await import("../../factory/partition-commands");
    const deliveries = new FactoryPartitionCommands(current.authority, new FactoryInbox(fixture.db, tenantId, () => now));
    expect(await deliveries.execute({ tenantId, subject: "orchestration" }, { ...identity, commandId: command.id })).toBeNull();
    const records = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${run.runId} AND interpreter_id=${targetPartition.id}`));
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!.payload)).toMatchObject({ kind: "partition-node-completed", outcome: "failed", error: command.error });
  });

  test("the private Node connection delivers committed partition data and confirms only the consumed successor event", async () => {
    const { current, identity, targetPartition, run, command } = await partitionFixture("node-delivery");
    const { FactoryPartitionCommands } = await import("../../factory/partition-commands");
    const deliveries = new FactoryPartitionCommands(current.authority, new FactoryInbox(fixture.db, tenantId, () => now));
    const commands = privateCommands(current.authority, current.transitions, {}, { "notify-partition": deliveries.execute.bind(deliveries), "invalidate-partition": deliveries.execute.bind(deliveries) });
    await withPrivateConnection(current, commands, async ({ url, certs, token }) => {
      const request = { ...identity, command: { ...command, output: { forged: true }, targetPartitionId: "foreign-partition", candidateGeneration: 999 } };
      const path = `${url}/internal/factory/v1/commands/${encodeURIComponent(command.id)}`;
      expect((await nodeHttpsRequest(path, certs, { token: "invalid", body: request })).status).toBe(401);
      for (let retry = 0; retry < 2; retry++) expect((await nodeHttpsRequest(path, certs, { token, body: request })).status).toBe(204);
      const stored = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_command_outbox WHERE tenant_id=${tenantId} AND project_id=${projectId} AND logical_run_id=${run.runId} AND payload::jsonb->'command'->>'kind'='partition_notification'`));
      expect(stored).toHaveLength(1);
      const delivery = JSON.parse(stored[0]!.payload).command;
      expect(delivery).toMatchObject({ interpreterId: targetPartition.id, eventId: `${command.id}:result`, body: { candidateGeneration: 0, targetPartitionId: targetPartition.id, outcome: "succeeded" } });
      expect(delivery.body.output).toEqual(command.output);
      const confirm = async () => {
        const response = await nodeHttpsRequest(`${url}/internal/factory/v1/outbox/confirm-inbox`, certs, { token, body: { command: delivery } });
        expect(response.status).toBe(200);
        return JSON.parse(response.body.toString());
      };
      expect(await confirm()).toBe(false);
      const targetIdentity = { ...identity, interpreterId: targetPartition.id };
      const initial = advanceKernel(current.compiled, createPartitionKernelState(current.compiled, targetPartition.id, run.runId, {}, now), current.event);
      await persistTransition(targetIdentity, 1, current.event, initial.nextState, initial.commands, undefined, current.activities);
      const consumed = advanceKernel(current.compiled, initial.nextState, delivery.body);
      expect(consumed.nextState.nodes.z?.status).toBe("succeeded");
      await persistTransition(targetIdentity, 2, delivery.body, consumed.nextState, consumed.commands, { sequence: delivery.eventSequence, eventId: delivery.eventId, eventHash: delivery.eventHash }, current.activities);
      expect(await confirm()).toBe(true);
      expect((await nodeHttpsRequest(path, certs, { token, body: { ...request, tenantId: "foreign" } })).status).toBe(403);
    });
  });
}
