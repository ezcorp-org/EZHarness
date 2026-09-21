import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestBytes } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArtifacts, artifactJson } from "../../factory/artifacts";
import {
  FactoryLegacyWorkflowError,
  FactoryLegacyWorkflows,
  factoryLegacyIdempotencyKey,
  type FactoryLegacyAttemptKey,
  type FactoryLegacyEngine,
  type FactoryLegacyStartRequest,
} from "../../factory/legacy-workflow/adapter";
import {
  classifyLegacyWorkflow,
  legacyWorkflowClassificationDigest,
  type LegacyWorkflowClassification,
} from "../../factory/legacy-workflow/classification";
import { FactoryLegacyImports } from "../../factory/legacy-workflow/import";
import type { LegacyWorkflowRunFacts } from "../../factory/legacy-workflow/status";
import { FactoryRecords } from "../../factory/records";
import type { ConsentCapability, ConsentHashSources } from "../../runtime/workflow-capability-hash";
import { WORKFLOW_RELEASE_AUTHORITY_LOST } from "../../runtime/workflow-release-assets";
import type { WorkflowDefinition } from "../../types";

interface Fixture { readonly db: TransactionalDb; readonly blobs: BlobStore; close(): Promise<void> }

/** A legacy engine the adapter drives, with every call counted. */
class RecordingEngine implements FactoryLegacyEngine {
  readonly created = new Map<string, LegacyWorkflowRunFacts>();
  readonly byKey = new Map<string, string>();
  startCalls = 0;
  lookupCalls = 0;
  /** Set to throw AFTER the run exists, which is the crash this adapter exists for. */
  failAfterCreate = false;
  /** Observed while the engine was running, so the test can prove the journal committed first. */
  journalStateAtStart: string | null = null;

  constructor(private readonly database: TransactionalDb, private readonly tenantId: string) {}

  async start(request: { workflowName: string; idempotencyKey: string; input: Record<string, unknown>; projectId: string; userId?: string }): Promise<{ legacyRunId: string }> {
    this.startCalls += 1;
    const state = rows<{ state: string }>(await this.database.execute(sql`SELECT state FROM factory_legacy_workflow_starts WHERE tenant_id=${this.tenantId} AND idempotency_key=${request.idempotencyKey}`))[0];
    this.journalStateAtStart = state?.state ?? null;
    const existing = this.byKey.get(request.idempotencyKey);
    if (existing !== undefined) throw new Error("unique violation on workflow_runs.idempotency_key");
    const legacyRunId = `legacy-run-${this.startCalls}`;
    this.byKey.set(request.idempotencyKey, legacyRunId);
    this.created.set(legacyRunId, runningFacts());
    if (this.failAfterCreate) throw new Error("the adapter died between start and its record");
    return { legacyRunId };
  }

  async lookup(_workflowName: string, idempotencyKey: string): Promise<{ legacyRunId: string } | null> {
    this.lookupCalls += 1;
    const found = this.byKey.get(idempotencyKey);
    return found === undefined ? null : { legacyRunId: found };
  }

  async facts(legacyRunId: string, observedAtMs: number): Promise<LegacyWorkflowRunFacts | null> {
    const found = this.created.get(legacyRunId);
    return found === undefined ? null : { ...found, observedAtMs };
  }

  set(legacyRunId: string, facts: Partial<LegacyWorkflowRunFacts>): void {
    this.created.set(legacyRunId, { ...this.created.get(legacyRunId)!, ...facts });
  }
}

function runningFacts(): LegacyWorkflowRunFacts {
  return {
    status: "running", runPhase: "boundary", suspendedReason: null, resumable: false, leaseExpiresAtMs: null,
    cursorBatchIndex: null, inFlightStepNames: [], resultErrorCode: null, resultErrorMessage: null, resultOutput: null,
    observedAtMs: 0,
  };
}

export function factoryLegacyWorkflowConformance(createFixture: () => Promise<Fixture>): void {
  const tenantId = "legacy-workflow-tenant", projectId = "legacy-workflow-project";
  const runId = "legacy-workflow-run", foreignTenantId = "legacy-workflow-foreign-tenant";
  const now = Date.UTC(2030, 0, 1);
  const adminId = "legacy-workflow-admin";

  let fixture: Fixture, database: TransactionalDb, artifacts: FactoryArtifacts;
  let adapter: FactoryLegacyWorkflows, imports: FactoryLegacyImports;

  const readOnly = definition("read-only-report", [{ name: "read", kind: "tool", tool: "notes__read_note" }]);
  const shelling = definition("shell-report", [{ name: "run", kind: "tool", tool: "ops__run_command" }]);
  const toolGrants: Record<string, readonly ConsentCapability[]> = {
    notes__read_note: [{ kind: "fs.read", value: "/project" }],
    ops__run_command: [{ kind: "shell" }],
  };

  function definition(name: string, steps: WorkflowDefinition["steps"]): WorkflowDefinition {
    return { name, description: `${name} fixture`, steps };
  }

  function sources(definitions: readonly WorkflowDefinition[]): ConsentHashSources {
    const byName = new Map(definitions.map(entry => [entry.name, entry] as const));
    return {
      resolve: (name: string) => byName.get(name),
      identify: () => ({ kind: "unversioned" }),
      capabilitiesForTool: (tool: string) => (Object.hasOwn(toolGrants, tool) ? toolGrants[tool] : undefined),
      capabilitiesForAgent: () => undefined,
    };
  }

  const cleanClassification = (): LegacyWorkflowClassification => classifyLegacyWorkflow(readOnly, sources([readOnly]));
  const shellClassification = (): LegacyWorkflowClassification => classifyLegacyWorkflow(shelling, sources([shelling]));

  async function attempt(attemptId: string, nodeInstanceId: string, candidateGeneration = 0): Promise<void> {
    await database.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${attemptId},${tenantId},${projectId},${runId},${nodeInstanceId},${candidateGeneration},1,1,1,1,0,${new Date(now + 600_000)},${"a".repeat(64)},'{}'::jsonb,'admitted')`);
  }

  function key(attemptId: string, nodeInstanceId: string, candidateGeneration = 0): FactoryLegacyAttemptKey {
    return { projectId, runId, nodeInstanceId, candidateGeneration, attemptId };
  }

  function request(attemptKey: FactoryLegacyAttemptKey, classification: LegacyWorkflowClassification, input: Record<string, unknown> = { topic: "release notes" }): FactoryLegacyStartRequest {
    return { ...attemptKey, workflowName: classification.closure[0]!, classification, input, userId: adminId };
  }

  beforeAll(async () => {
    fixture = await createFixture();
    database = fixture.db;
    const records = new FactoryRecords(database, tenantId);
    await records.bindInstallation();
    await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Legacy workflow','/tmp/legacy-workflow')`);
    await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${adminId},'legacy-workflow@example.test','x','Legacy','admin')`);
    await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('legacy-workflow-member',${projectId},${adminId},'owner')`);
    await records.bindProject(projectId);
    await records.createRun({ projectId, runId, definitionDigest: `sha256:${"d".repeat(64)}`, interpreterBuild: "factory-legacy-v1", executionEpoch: 1, input: {}, principalId: adminId }, async () => {});
    artifacts = new FactoryArtifacts(database, fixture.blobs, tenantId);
    adapter = new FactoryLegacyWorkflows(database, tenantId);
    imports = new FactoryLegacyImports(database, tenantId, adapter, artifacts);
    for (const [attemptId, node] of [
      ["legacy-attempt-clean", "wrap-clean"], ["legacy-attempt-shell", "wrap-shell"], ["legacy-attempt-crash", "wrap-crash"],
      ["legacy-attempt-race", "wrap-race"], ["legacy-attempt-status", "wrap-status"], ["legacy-attempt-import", "wrap-import"],
      ["legacy-attempt-conflict", "wrap-conflict"], ["legacy-attempt-corrupt", "wrap-corrupt"], ["legacy-attempt-revoke", "wrap-revoke"],
      ["legacy-attempt-edited", "wrap-edited"], ["legacy-attempt-settle", "wrap-settle"],
    ] as const) await attempt(attemptId, node);
  });

  afterAll(async () => { await fixture?.close(); });

  test("an allowlisted workflow starts under a `factory:` identity, and the journal is durable before the engine is called", async () => {
    const attemptKey = key("legacy-attempt-clean", "wrap-clean");
    const engine = new RecordingEngine(database, tenantId);
    const started = await adapter.ensureStarted(request(attemptKey, cleanClassification()), engine);

    expect(started).toEqual({ legacyRunId: "legacy-run-1", adopted: false });
    // The engine read the journal while it was running: proof the row committed first.
    expect(engine.journalStateAtStart).toBe("journaled");
    expect(engine.lookupCalls).toBe(1);

    const journal = await adapter.read(attemptKey);
    expect(journal).toMatchObject({ state: "started", legacyRunId: "legacy-run-1", attestationDigest: null, workflowName: "read-only-report" });
    expect(journal!.idempotencyKey).toBe(factoryLegacyIdempotencyKey(attemptKey));
    expect(journal!.idempotencyKey.startsWith("factory:")).toBe(true);
    expect(journal!.idempotencyKey.startsWith("nested:")).toBe(false);
  });

  test("a shell-bearing workflow without an attestation is denied, and journals nothing", async () => {
    const attemptKey = key("legacy-attempt-shell", "wrap-shell");
    const engine = new RecordingEngine(database, tenantId);
    await expect(adapter.ensureStarted(request(attemptKey, shellClassification()), engine)).rejects.toMatchObject({ code: "factory_legacy_unattested" });

    expect(engine.startCalls).toBe(0);
    expect(await adapter.read(attemptKey)).toBeNull();
  });

  test("an administrator's attestation admits exactly that classification, and re-attesting is idempotent", async () => {
    const classification = shellClassification();
    const attested = await adapter.attest({ projectId, workflowName: "shell-report", classification, attestedBy: adminId });
    expect(attested).toMatchObject({ workflowName: "shell-report", definitionDigest: classification.definitionDigest, attestedBy: adminId, revoked: false });
    expect(attested.classificationDigest).toBe(legacyWorkflowClassificationDigest(classification));
    expect(await adapter.attest({ projectId, workflowName: "shell-report", classification, attestedBy: adminId })).toEqual(attested);

    const engine = new RecordingEngine(database, tenantId);
    const attemptKey = key("legacy-attempt-shell", "wrap-shell");
    const started = await adapter.ensureStarted(request(attemptKey, classification), engine);
    expect(started.adopted).toBe(false);
    expect((await adapter.read(attemptKey))!.attestationDigest).toBe(attested.attestationDigest);
  });

  test("a second administrator cannot silently replace an attestation for the same definition", async () => {
    await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES ('legacy-workflow-second','second@example.test','x','Second','admin')`);
    await expect(adapter.attest({ projectId, workflowName: "shell-report", classification: shellClassification(), attestedBy: "legacy-workflow-second" }))
      .rejects.toMatchObject({ code: "factory_legacy_conflict" });
  });

  test("any definition change invalidates the attestation", async () => {
    const edited = definition("shell-report", [{ name: "run", kind: "tool", tool: "ops__run_command" }, { name: "again", kind: "tool", tool: "ops__run_command" }]);
    const classification = classifyLegacyWorkflow(edited, sources([edited]));
    expect(classification.definitionDigest).not.toBe(shellClassification().definitionDigest);

    const engine = new RecordingEngine(database, tenantId);
    await expect(adapter.ensureStarted(request(key("legacy-attempt-edited", "wrap-edited"), classification), engine))
      .rejects.toMatchObject({ code: "factory_legacy_unattested" });
    expect(engine.startCalls).toBe(0);
  });

  test("a classification that no longer matches the one a human saw is refused under the same definition digest", async () => {
    const classification = shellClassification();
    const widened: LegacyWorkflowClassification = { ...classification, capabilities: [...classification.capabilities, "network::api.example.test"] };
    expect(widened.definitionDigest).toBe(classification.definitionDigest);

    const engine = new RecordingEngine(database, tenantId);
    await expect(adapter.ensureStarted(request(key("legacy-attempt-edited", "wrap-edited"), widened), engine))
      .rejects.toMatchObject({ code: "factory_legacy_unattested" });
  });

  test("revoking an attestation stops admitting the workflow, and revoking an absent one is not found", async () => {
    const classification = classifyLegacyWorkflow(
      definition("revoked-report", [{ name: "run", kind: "tool", tool: "ops__run_command" }]),
      sources([definition("revoked-report", [{ name: "run", kind: "tool", tool: "ops__run_command" }])]),
    );
    await adapter.attest({ projectId, workflowName: "revoked-report", classification, attestedBy: adminId });
    await adapter.revokeAttestation(projectId, "revoked-report", classification.definitionDigest);

    const engine = new RecordingEngine(database, tenantId);
    await expect(adapter.ensureStarted(request(key("legacy-attempt-revoke", "wrap-revoke"), classification), engine))
      .rejects.toMatchObject({ code: "factory_legacy_unattested" });
    await expect(adapter.revokeAttestation(projectId, "never-attested", classification.definitionDigest))
      .rejects.toMatchObject({ code: "factory_legacy_not_found" });
  });

  test("a crash between journal and start creates no duplicate legacy run", async () => {
    const attemptKey = key("legacy-attempt-crash", "wrap-crash");
    const engine = new RecordingEngine(database, tenantId);
    engine.failAfterCreate = true;
    await expect(adapter.ensureStarted(request(attemptKey, cleanClassification()), engine)).rejects.toThrow("died between start and its record");

    // The run exists in the engine, and the journal still says `journaled`.
    expect(engine.startCalls).toBe(1);
    expect((await adapter.read(attemptKey))!.state).toBe("journaled");

    engine.failAfterCreate = false;
    const recovered = await adapter.ensureStarted(request(attemptKey, cleanClassification()), engine);
    expect(recovered).toEqual({ legacyRunId: "legacy-run-1", adopted: true });
    expect(engine.startCalls).toBe(1);
    expect(engine.byKey.size).toBe(1);
    expect((await adapter.read(attemptKey))!.legacyRunId).toBe("legacy-run-1");
  });

  test("two concurrent starts of the same attempt agree on one legacy run", async () => {
    const attemptKey = key("legacy-attempt-race", "wrap-race");
    const engine = new RecordingEngine(database, tenantId);
    const both = await Promise.allSettled([
      adapter.ensureStarted(request(attemptKey, cleanClassification()), engine),
      adapter.ensureStarted(request(attemptKey, cleanClassification()), engine),
    ]);
    const succeeded = both.filter(result => result.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThan(0);
    const journalled = (await adapter.read(attemptKey))!.legacyRunId;
    expect(journalled).not.toBeNull();
    for (const result of succeeded) expect(result.value.legacyRunId).toBe(journalled!);
    expect(engine.byKey.size).toBe(1);
  });

  test("replaying a journal with different input is a conflict, not a second run", async () => {
    const attemptKey = key("legacy-attempt-conflict", "wrap-conflict");
    const engine = new RecordingEngine(database, tenantId);
    await adapter.ensureStarted(request(attemptKey, cleanClassification(), { topic: "first" }), engine);
    await expect(adapter.ensureStarted(request(attemptKey, cleanClassification(), { topic: "second" }), engine))
      .rejects.toMatchObject({ code: "factory_legacy_conflict" });
    expect(engine.startCalls).toBe(1);
  });

  test("every C10 status row is driven through the real journal", async () => {
    const attemptKey = key("legacy-attempt-status", "wrap-status");
    const engine = new RecordingEngine(database, tenantId);
    const { legacyRunId } = await adapter.ensureStarted(request(attemptKey, cleanClassification()), engine);

    expect(await adapter.observe(attemptKey, engine, now)).toEqual({ state: "running" });

    engine.set(legacyRunId, { status: "suspended", suspendedReason: "approval", resumable: false });
    expect(await adapter.observe(attemptKey, engine, now)).toEqual({ state: "waiting", reason: "approval", resumable: false });

    engine.set(legacyRunId, { status: "suspended", suspendedReason: "orphaned-resumable", resumable: true });
    expect(await adapter.observe(attemptKey, engine, now)).toEqual({ state: "waiting", reason: "orphaned-resumable", resumable: true });

    engine.set(legacyRunId, { status: "running", suspendedReason: null, resumable: false, leaseExpiresAtMs: now - 1 });
    expect(await adapter.observe(attemptKey, engine, now)).toMatchObject({ state: "uncertain", reason: "lease-expired", terminal: false });

    engine.set(legacyRunId, { status: "error", leaseExpiresAtMs: null, resultErrorMessage: WORKFLOW_RELEASE_AUTHORITY_LOST });
    expect(await adapter.observe(attemptKey, engine, now)).toMatchObject({ state: "failed", reason: "release-authority-lost" });
    expect((await adapter.read(attemptKey))!.state).toBe("settled");

    engine.set(legacyRunId, { status: "error", resultErrorMessage: "orphaned mid-batch", cursorBatchIndex: 2, inFlightStepNames: ["publish"], runPhase: "in-batch" });
    expect(await adapter.observe(attemptKey, engine, now)).toEqual({ state: "failed", reason: "orphaned mid-batch", batchIndex: 2, inFlightSteps: ["publish"] });

    engine.set(legacyRunId, { status: "awaiting_approval", resultErrorMessage: "needs a human" });
    expect(await adapter.observe(attemptKey, engine, now)).toEqual({ state: "uncertain", reason: "awaiting-approval", terminal: true, blocker: "needs a human" });

    engine.set(legacyRunId, { status: "success", resultOutput: { report: "done" } });
    expect(await adapter.observe(attemptKey, engine, now)).toEqual({ state: "succeeded", output: { report: "done" } });
  });

  test("a terminal outcome settles the journal exactly once", async () => {
    const attemptKey = key("legacy-attempt-settle", "wrap-settle");
    const engine = new RecordingEngine(database, tenantId);
    const { legacyRunId } = await adapter.ensureStarted(request(attemptKey, cleanClassification()), engine);
    engine.set(legacyRunId, { status: "success", resultOutput: { report: "once" } });

    await adapter.observe(attemptKey, engine, now);
    const settled = rows<{ updated_at: Date | string }>(await database.execute(sql`SELECT updated_at FROM factory_legacy_workflow_starts WHERE tenant_id=${tenantId} AND project_id=${projectId} AND attempt_id=${attemptKey.attemptId}`))[0]!;
    await adapter.observe(attemptKey, engine, now);
    const again = rows<{ updated_at: Date | string }>(await database.execute(sql`SELECT updated_at FROM factory_legacy_workflow_starts WHERE tenant_id=${tenantId} AND project_id=${projectId} AND attempt_id=${attemptKey.attemptId}`))[0]!;
    expect(String(again.updated_at)).toBe(String(settled.updated_at));
  });

  test("observing an attempt that never journaled, or a run the engine forgot, is not found", async () => {
    const engine = new RecordingEngine(database, tenantId);
    await expect(adapter.observe(key("legacy-attempt-clean", "never-journaled"), engine, now)).rejects.toMatchObject({ code: "factory_legacy_not_found" });
    const attemptKey = key("legacy-attempt-clean", "wrap-clean");
    engine.byKey.set(factoryLegacyIdempotencyKey(attemptKey), "legacy-run-1");
    await expect(adapter.observe(attemptKey, engine, now)).rejects.toMatchObject({ code: "factory_legacy_not_found" });
  });

  test("a legacy output is imported only as a digest-verified copy, and repeating it returns the same record", async () => {
    const attemptKey = key("legacy-attempt-import", "wrap-import");
    const engine = new RecordingEngine(database, tenantId);
    const { legacyRunId } = await adapter.ensureStarted(request(attemptKey, cleanClassification()), engine);
    const bytes = artifactJson.canonical({ report: "legacy bytes" });
    const declaredDigest = `sha256:${digestBytes(bytes)}`;

    const record = await imports.importOutput(attemptKey, { name: "report.json", legacyRunId, declaredDigest, bytes });
    expect(record).toMatchObject({ sourceName: "report.json", legacyRunId, declaredDigest, verifiedDigest: declaredDigest, byteCount: bytes.byteLength });
    expect(record.artifact.digest).toBe(declaredDigest);
    expect(await imports.importOutput(attemptKey, { name: "report.json", legacyRunId, declaredDigest, bytes })).toEqual(record);
    expect(await imports.list(attemptKey)).toEqual([record]);

    const loaded = await artifacts.load({ tenantId, projectId, logicalRunId: runId }, { objectId: record.artifact.artifactId, digest: record.artifact.digest, encodedBytes: record.artifact.encodedBytes }, ["candidate_output"]);
    expect(Buffer.from(loaded.content).equals(Buffer.from(bytes))).toBe(true);
  });

  test("bytes that disagree with the declared digest are refused, and nothing is written", async () => {
    const attemptKey = key("legacy-attempt-import", "wrap-import");
    const engine = new RecordingEngine(database, tenantId);
    const { legacyRunId } = await adapter.ensureStarted(request(attemptKey, cleanClassification()), engine);
    const bytes = artifactJson.canonical({ report: "tampered" });

    await expect(imports.importOutput(attemptKey, { name: "tampered.json", legacyRunId, declaredDigest: `sha256:${"0".repeat(64)}`, bytes }))
      .rejects.toMatchObject({ code: "factory_legacy_corrupt" });
    expect((await imports.list(attemptKey)).some(record => record.sourceName === "tampered.json")).toBe(false);
  });

  test("an output from another legacy run cannot be imported under this attempt", async () => {
    const attemptKey = key("legacy-attempt-import", "wrap-import");
    const bytes = artifactJson.canonical({ report: "foreign" });
    await expect(imports.importOutput(attemptKey, { name: "foreign.json", legacyRunId: "legacy-run-999", declaredDigest: `sha256:${digestBytes(bytes)}`, bytes }))
      .rejects.toMatchObject({ code: "factory_legacy_scope" });
  });

  test("the ownerless ez-factory job store is never surfaced inside a factory project", async () => {
    const attemptKey = key("legacy-attempt-import", "wrap-import");
    const engine = new RecordingEngine(database, tenantId);
    const { legacyRunId } = await adapter.ensureStarted(request(attemptKey, cleanClassification()), engine);
    const bytes = artifactJson.canonical({ jobs: ["nightly-docs"] });
    const declaredDigest = `sha256:${digestBytes(bytes)}`;

    for (const name of ["job-index", "meta"]) {
      await expect(imports.importOutput(attemptKey, { name, legacyRunId, declaredDigest, bytes }))
        .rejects.toMatchObject({ code: "factory_legacy_scope" });
    }
    // A key with a separator never reaches the store check: it is not a leaf name at all.
    for (const name of ["job:nightly-docs", "run:nightly-docs:run-1", "run-index:nightly-docs", "../escape", "a/b"]) {
      await expect(imports.importOutput(attemptKey, { name, legacyRunId, declaredDigest, bytes }))
        .rejects.toMatchObject({ code: expect.stringMatching(/^factory_legacy_(scope|invalid)$/) });
    }
    expect((await imports.list(attemptKey)).some(record => record.sourceName.includes("job"))).toBe(false);
  });

  test("a second import under the same name with different bytes is a conflict", async () => {
    const attemptKey = key("legacy-attempt-import", "wrap-import");
    const engine = new RecordingEngine(database, tenantId);
    const { legacyRunId } = await adapter.ensureStarted(request(attemptKey, cleanClassification()), engine);
    const other = artifactJson.canonical({ report: "different bytes" });
    await expect(imports.importOutput(attemptKey, { name: "report.json", legacyRunId, declaredDigest: `sha256:${digestBytes(other)}`, bytes: other }))
      .rejects.toMatchObject({ code: "factory_legacy_conflict" });
  });

  test("an empty or oversized payload, and a malformed declared digest, are all refused", async () => {
    const attemptKey = key("legacy-attempt-import", "wrap-import");
    const bytes = artifactJson.canonical({ report: "bounded" });
    await expect(imports.importOutput(attemptKey, { name: "empty.json", legacyRunId: "legacy-run-1", declaredDigest: `sha256:${digestBytes(new Uint8Array(0))}`, bytes: new Uint8Array(0) }))
      .rejects.toMatchObject({ code: "factory_legacy_invalid" });
    await expect(imports.importOutput(attemptKey, { name: "bad-digest.json", legacyRunId: "legacy-run-1", declaredDigest: "not-a-digest", bytes }))
      .rejects.toMatchObject({ code: "factory_legacy_invalid" });
  });

  test("another tenant cannot read this tenant's journal or compose against its stores", async () => {
    const foreign = new FactoryLegacyWorkflows(database, foreignTenantId);
    expect(await foreign.read(key("legacy-attempt-clean", "wrap-clean"))).toBeNull();
    expect(() => new FactoryLegacyImports(database, foreignTenantId, adapter, artifacts)).toThrow(FactoryLegacyWorkflowError);
  });

  test("a tampered journal seal and a tampered attestation seal are both refused as corrupt", async () => {
    const attemptKey = key("legacy-attempt-corrupt", "wrap-corrupt");
    const engine = new RecordingEngine(database, tenantId);
    await adapter.ensureStarted(request(attemptKey, cleanClassification()), engine);
    await database.execute(sql`UPDATE factory_legacy_workflow_starts SET workflow_name='swapped' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND attempt_id=${attemptKey.attemptId}`);
    await expect(adapter.read(attemptKey)).rejects.toMatchObject({ code: "factory_legacy_corrupt" });

    await database.execute(sql`UPDATE factory_legacy_attestations SET attested_by='someone-else' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND workflow_name='shell-report'`);
    await expect(adapter.attest({ projectId, workflowName: "shell-report", classification: shellClassification(), attestedBy: adminId }))
      .rejects.toMatchObject({ code: "factory_legacy_corrupt" });
  });

  test("a malformed attempt coordinate is refused before anything durable happens", async () => {
    const engine = new RecordingEngine(database, tenantId);
    const attemptKey = { ...key("legacy-attempt-clean", "wrap-clean"), candidateGeneration: -1 };
    await expect(adapter.ensureStarted(request(attemptKey, cleanClassification()), engine)).rejects.toMatchObject({ code: "factory_legacy_invalid" });
    await expect(adapter.observe(attemptKey, engine, now)).rejects.toMatchObject({ code: "factory_legacy_invalid" });
    await expect(adapter.observe(key("legacy-attempt-clean", "wrap-clean"), engine, -1)).rejects.toMatchObject({ code: "factory_legacy_invalid" });
    await expect(adapter.ensureStarted(request(key("legacy-attempt-clean", "wrap-clean"), { ...cleanClassification(), closure: [""] }), engine))
      .rejects.toMatchObject({ code: "factory_legacy_invalid" });
    await expect(adapter.attest({ projectId, workflowName: "", classification: cleanClassification(), attestedBy: adminId }))
      .rejects.toMatchObject({ code: "factory_legacy_invalid" });
    expect(engine.startCalls).toBe(0);
  });
}
