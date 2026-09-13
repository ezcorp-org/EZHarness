import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { referenceCodeV1, validateFactoryApiResponse, createKernelState, advanceKernel, type FactoryDefinition, type FactoryRunStartBody, type JsonValue } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import type { BlobStore } from "../../extensions/v4/types";
import { digestBytes } from "../../extensions/v4/blobs";
import { createFactoryApplication } from "../../factory/application";
import { FactoryArtifacts } from "../../factory/artifacts";
import { createFactoryArtifactActivities } from "../../factory/artifact-activities";
import { FactoryDefinitionArtifacts } from "../../factory/definition-artifacts";
import { FactoryDefinitions } from "../../factory/definitions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryCommandOutbox } from "../../factory/outbox";
import { FactoryRecords } from "../../factory/records";
import { FactoryRunLifecycle, type FactoryRunLifecycleOptions } from "../../factory/run-lifecycle";
import { FactoryServiceCredentials } from "../../factory/service-credentials";
import { FactoryCommandAuthority } from "../../factory/command-authority";
import { FactoryTaskAdmission, factoryTaskReservationId } from "../../factory/task-admission";
import { FactoryComputeAdmissions } from "../../factory/compute-admissions";
import { FactoryInbox } from "../../factory/inbox";
import type { PoolAdmissionClient } from "../../factory/pool/client";
import { FactoryRunTransitionProjector } from "../../factory/run-transition-projector";
import { FactoryTransitionArtifacts } from "../../factory/transition-artifacts";
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
  const start = () => startRun(principal, key, body, 0, `start-${++sequence}`);
  const committedInterpreter = async (runId: string, definitionKey = key, request = body, runLifecycle = lifecycle, resolvedInput?: JsonValue) => {
    const identity = { tenantId, projectId, logicalRunId: runId, interpreterId: "root" };
    const artifacts = new FactoryArtifacts(fixture.db, objectStore, tenantId);
    const transitions = new FactoryTransitionArtifacts(artifacts);
    const activities = createFactoryArtifactActivities(new FactoryDefinitionArtifacts(artifacts), transitions);
    const { compiled } = await definitions.readVersion(principal, definitionKey, request.factoryVersion);
    const input = resolvedInput ?? Object.fromEntries(Object.entries(request.parameters).map(([name, value]) => [name, value.kind === "inline" ? value.value : null]));
    const event = { kind: "start", id: "authority-start", atMs: now } as const;
    const first = advanceKernel(compiled, createKernelState(compiled, runId, input, now, { schemaVersion: "factory.lazy-input.v1", parameters: request.parameters }), event);
    const admission = first.commands.find(command => command.kind === "request-admission")!;
    const authority = new FactoryCommandAuthority(fixture.db, tenantId, runLifecycle, transitions, ["orchestration"], () => now);
    return { identity, transitions, activities, compiled, event, first, admission, authority };
  };
  beforeAll(async () => {
    fixture = await create();
    await up(fixture.db); await up(fixture.db);
    const records = new FactoryRecords(fixture.db, tenantId);
    await records.bindInstallation();
    await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId}, 'Run lifecycle', '/tmp/lifecycle')`);
    await records.bindProject(projectId);
    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${principal.id}, 'lifecycle@example.test', 'not-a-login', 'Lifecycle', 'admin')`);
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('lifecycle-membership', ${projectId}, ${principal.id}, 'owner')`);
    grants = new FactoryGrants(fixture.db, tenantId, () => now);
    for (const action of ["factory.author", "factory.publish", "factory.run", "factory.operate"] as const) await grants.set(principal, { principal, projectId, action, expectedRevision: 0, expiresAtMs: null });
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
    const taskAdmission = new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, profiles, () => now);
    expect(() => new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, { cpu: { ...profiles.cpu, resources: { cpu: 0 } } })).toThrow();
    await expect(new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, {}, () => now).request(service, reference)).rejects.toMatchObject({ code: "factory_command_forbidden" });
    await expect(new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, { cpu: { ...profiles.cpu, memoryBytes: 0 } }, () => now).request(service, reference)).rejects.toMatchObject({ code: "factory_command_forbidden" });
    await fixture.db.execute(sql`ALTER TABLE factory_command_outbox RENAME TO task_admission_hidden_outbox`);
    try {
      await expect(taskAdmission.request(service, reference)).rejects.toThrow();
      expect((await lifecycle.budgets.inspect({ ...runKey(run.runId), envelopeId: "root" })).allocated.tokens).toBe("0");
    } finally { await fixture.db.execute(sql`ALTER TABLE task_admission_hidden_outbox RENAME TO factory_command_outbox`); }
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
    const run = await start();
    const { identity, transitions, activities, event, first, admission, authority } = await taskInterpreter(run.runId);
    await persistTransition(identity, 1, event, first.nextState, first.commands, undefined, activities);
    const reference = { ...identity, commandId: admission.id };
    const service = { tenantId, subject: "orchestration" };
    const profile = { resources: { cpu: 1 }, memoryBytes: 128, budget: { costMicros: "5", tokens: 6, computeMs: 7 } };
    const reserved = await new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, { cpu: profile }, () => now).request(service, reference);
    const queued = (await new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now, "pool").inspect(reserved.outboxCommandId))!;
    const input = queued.command.body as import("../../factory/task-admission").FactoryComputeAdmissionRequest;
    const lease = { reservationId: reserved.reservationId, tenantId, grantRevision: body.grantRevision, allocationGeneration: 1, holderGeneration: 1, allocationToken: "current-authority-allocation", fence: "current-authority-fence", deadlineAt: new Date(now + 1_000), resources: input.request.resources, hostId: "host-current" };
    let requests = 0;
    const pool = { async request() { requests++; return { status: "admitted" as const, reservationId: reserved.reservationId, lease }; }, async status() { return undefined; }, async cancel() { throw new Error("unexpected cancellation"); }, async acknowledgeStart() { throw new Error("unused"); }, async renew() { throw new Error("unused"); } } satisfies PoolAdmissionClient;
    const admissions = new FactoryComputeAdmissions(fixture.db, tenantId, authority, lifecycle.budgets, new FactoryInbox(fixture.db, tenantId, () => now), pool, () => now);
    await fixture.db.transaction(transaction => admissions.enlistInTransaction(transaction, input));
    expect(await admissions.recover(service, { projectId, runId: run.runId, reservationId: reserved.reservationId })).toMatchObject({ status: "admitted", receipt: { lease: { allocationToken: lease.allocationToken }, event: { commandId: admission.id, granted: true } } });
    expect(requests).toBe(1);
    expect(rows(await fixture.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE reservation_id=${reserved.reservationId}`))).toEqual([{ state: "running" }]);
    expect(rows(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${run.runId}`))).toHaveLength(1);
    expect(await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId))).toMatchObject({ sequence: 1, lag: 0 });
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
    await expect(new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, { cpu: profile }, () => now).request(service, reference)).rejects.toMatchObject({ code: "factory_command_forbidden" });
    const admitted = await new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, { cpu: { ...profile, memoryBytes: 128 } }, () => now).request(service, reference);
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
        await cancelRun(principal, runKey(run.runId), run.revision, "parent-authority-cancel");
        await expect(resolve()).rejects.toMatchObject({ code: "factory_run_stopped" });
      }
      await new FactoryRunTransitionProjector(fixture.db, tenantId, transitions, lifecycle).project(runKey(run.runId));
    }
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
      if (substituted) {
        await expect(authority.withCurrentInput(service, reference, async () => "read")).rejects.toMatchObject({ code: "factory_command_stale" });
      } else {
        expect(await authority.withCurrentInput(service, reference, async (_transaction, context) => context.command)).toEqual(command);
        await expect(authority.withCurrent(service, reference, async () => "task")).rejects.toMatchObject({ code: "factory_command_forbidden" });
        const read = { kind: "input-value-read", id: `${command.id}:value`, atMs: now + 1, commandId: command.id, nodeId: command.nodeId, candidateGeneration: command.candidateGeneration, cancellationEpoch: command.cancellationEpoch, name: command.name, artifact, path: command.path, storageVersion: "immutable-version", mediaType: "application/json", value: "stored value" } as const;
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
        const select = (_transaction: unknown, context: Awaited<Parameters<Parameters<FactoryCommandAuthority["withCurrentApproval"]>[2]>[1]>) => Promise.resolve({ command: context.command, principal: context.initiator, attempt: context.attempt, compiled: context.compiled.digest });
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
    const artifactsBefore = rows(await fixture.db.execute(sql`SELECT object_id FROM factory_artifacts`)).length;
    await fixture.db.execute(sql`CREATE FUNCTION reject_lifecycle_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'command failed'; END $$`);
    await fixture.db.execute(sql`CREATE TRIGGER reject_lifecycle_command BEFORE INSERT ON factory_command_outbox FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_command()`);
    try { await expect(startRun(principal, key, body, 0, "rollback-start")).rejects.toThrow(); }
    finally {
      await fixture.db.execute(sql`DROP TRIGGER reject_lifecycle_command ON factory_command_outbox`);
      await fixture.db.execute(sql`DROP FUNCTION reject_lifecycle_command()`);
    }
    expect(rows(await fixture.db.execute(sql`SELECT run_id FROM factory_runs`))).toHaveLength(before);
    expect(rows(await fixture.db.execute(sql`SELECT run_id FROM factory_budget_envelopes`))).toHaveLength(before);
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
}
