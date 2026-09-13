import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { referenceCodeV1, validateFactoryApiResponse, type FactoryDefinition, type FactoryRunStartBody, type JsonValue } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import type { BlobStore } from "../../extensions/v4/types";
import { digestBytes } from "../../extensions/v4/blobs";
import { createFactoryApplication } from "../../factory/application";
import { FactoryArtifacts } from "../../factory/artifacts";
import { FactoryDefinitionArtifacts } from "../../factory/definition-artifacts";
import { FactoryDefinitions } from "../../factory/definitions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryCommandOutbox } from "../../factory/outbox";
import { FactoryRecords } from "../../factory/records";
import { FactoryRunLifecycle, type FactoryRunLifecycleOptions } from "../../factory/run-lifecycle";
import { FactoryServiceCredentials } from "../../factory/service-credentials";
import { up } from "../../db/migrations/add-factory-run-lifecycle";

export function factoryRunLifecycleConformance(create: () => Promise<{ db: TransactionalDb; blobs?: BlobStore; close(): Promise<void> }>): void {
  let fixture: Awaited<ReturnType<typeof create>>;
  let definitions: FactoryDefinitions;
  let grants: FactoryGrants;
  let lifecycle: FactoryRunLifecycle;
  let options: FactoryRunLifecycleOptions;
  let body: FactoryRunStartBody;
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
    const objectStore = fixture.blobs ?? blobs;
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
    expect(JSON.parse(commands[0]!.payload).command.body).toMatchObject({ tenantId, projectId, logicalRunId: run.runId, interpreterId: "root", startedAtMs: now, deadlineAtMs: now + duration });
    expect(await lifecycle.read(principal, runKey(run.runId))).toEqual(run);
    await expect(startRun(principal, key, { ...body, parameters: {} }, 0, "race-start")).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("application composition uses the same scoped definitions and real artifact staging", async () => {
    const application = createFactoryApplication({ database: fixture.db, tenantId, blobs: fixture.blobs ?? blobs, grants, availableResourceClasses: ["cpu"], runOptions: { interpreterBuild: options.interpreterBuild, interpreterCompatibility: options.interpreterCompatibility, limits: options.limits, resolveParameters: options.resolveParameters } });
    const request = await application.runs.start(principal, key, body, 0, "composed-start");
    expect(request.run.status).toBe("queued");
    expect(await application.runs.readCommand(principal, runKey(request.run.runId), request.receipt.commandId)).toMatchObject({ state: "queued" });
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
