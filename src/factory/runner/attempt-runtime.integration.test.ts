import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import type { Runner, RunnerExecution, RunnerInspection, StartRequest } from "@ezcorp/extension-contract";
import { PodmanRunner, buildLimits, filesDigest } from "@ezcorp/extension-runner";
import { canonicalJson } from "@ezcorp/extension-contract";
import { provision } from "../../../packages/@ezcorp/extension-runner/tests/helpers";
import type { FactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { FactoryPreparedPackageReceipt } from "../package-preparation";
import type { PoolLease } from "../pool/ledger";
import { migrate } from "../../db/migrate";
import * as schema from "../../db/schema";
import { FactoryDatabaseAttemptLaunchStore, IsolatedFactoryAttemptRuntime, IsolatedFactoryTrustedRunner, factoryAttemptDeviceGrant, factoryAttemptInvocationId, factoryAttemptWorkerId, signFactoryPhysicalStopReceipt, type FactoryAttemptDeviceAuthorization, type FactoryAttemptLaunchIntent, type FactoryAttemptLaunchState, type FactoryAttemptLaunchStore, type FactoryAttemptLease, type FactoryAttemptRuntime, type FactoryPhysicalStopReceipt, type FactoryUnsignedPhysicalStopReceipt } from "./attempt-runtime";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";

const raw = "a".repeat(64);
const digest = `sha256:${raw}`;
const request = {
  schemaVersion: "factory.runner.request.v1" as const,
  authority: { attemptId: "attempt-runtime", tenantId: "tenant-runtime", projectId: "project-runtime", runId: "run-runtime", nodeInstanceId: "node-runtime", candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6, cancellationEpoch: 0, deadlineAtMs: Date.now() + 60_000, nextOperationIndex: 0 },
  runner: { package: "runner", version: "1", digest, export: "run", model: "runtime-model", configurationDigest: digest }, input: { kind: "inline" as const, value: { prompt: "isolated" } }, grants: [], resources: {}, tools: [], broker: { audience: "gateway", attemptToken: "ephemeral-token" },
};
const lease: FactoryAttemptLease = { reservationId: "reservation-runtime", grantRevision: 4, allocationGeneration: 5, holderGeneration: 5, allocationToken: "allocation-runtime", hostId: "host-runtime" };
const renewedLease: PoolLease = { ...lease, tenantId: request.authority.tenantId, fence: "lease-fence", deadlineAt: new Date(Date.now() + 60_000), resources: {} };
const prepared: FactoryPreparedPackageReceipt = { projectId: request.authority.projectId, reference: request.runner, trustRevision: 1, packageTrustDigest: digest, releaseDigest: digest, sourceDigest: digest, artifactDigest: raw, imageDigest: digest, manifestDigest: digest, evidenceDigest: digest, buildIdentity: "build-runtime", receiptDigest: digest };
const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signStopReceipt = async (receipt: FactoryUnsignedPhysicalStopReceipt) => signFactoryPhysicalStopReceipt(receipt, "test-host-key", hostKeys.privateKey);
const dispatchReadiness = { assertDispatchReady: async () => prepared };

class ResponseLossRunner implements Runner {
  starts = 0;
  attaches = 0;
  acknowledgements: StartRequest[] = [];
  private inspection: RunnerInspection = { id: "", state: "unknown", diagnostics: [] };
  private readonly execution: RunnerExecution = { workerId: "", request: async () => ({ schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] }), close: async () => {}, onNotification: () => () => {} };
  async build(): Promise<never> { throw new Error("build is not part of attempt launch"); }
  async collectArtifacts(): Promise<never> { throw new Error("artifact collection is not part of attempt launch"); }
  async inspect(id: string): Promise<RunnerInspection> { return { ...this.inspection, id }; }
  async start(input: StartRequest): Promise<RunnerExecution> { this.starts += 1; this.acknowledgements.push(input); this.inspection = { id: input.workerId, state: "running", diagnostics: [] }; throw new Error("simulated response loss after Podman start"); }
  async attach(input: StartRequest): Promise<RunnerExecution> { this.attaches += 1; return { ...this.execution, workerId: input.workerId }; }
  async cancel(id: string): Promise<void> { this.inspection = { id, state: "cancelled", diagnostics: [] }; }
}

class MemoryLaunchStore implements FactoryAttemptLaunchStore {
  private intent: FactoryAttemptLaunchIntent | undefined;
  private terminal: FactoryRunnerResult | undefined;
  constructor(private readonly initialState: FactoryAttemptLaunchState = "prepared") {}
  async prepare(value: typeof request, held: FactoryAttemptLease, receipt: FactoryPreparedPackageReceipt, devices?: FactoryAttemptDeviceAuthorization): Promise<FactoryAttemptLaunchIntent> {
    this.intent ??= { schemaVersion: "factory.attempt-launch.v1", request: value, requestDigest: factoryRunnerRequestDigest(value), lease: held, preparedPackage: receipt, workerId: factoryAttemptWorkerId(value.authority.attemptId), invocationId: factoryAttemptInvocationId(value.authority.attemptId, value.authority.candidateGeneration, value.authority.attemptNumber), devices: factoryAttemptDeviceGrant(value.authority.attemptId, held, devices), state: this.initialState };
    return this.intent;
  }
  async claimStart(): Promise<{ readonly intent: FactoryAttemptLaunchIntent; readonly claimed: boolean }> { if (!this.intent) throw new Error("launch is missing"); if (this.intent.state !== "prepared") return { intent: this.intent, claimed: false }; this.intent = { ...this.intent, state: "launching" }; return { intent: this.intent, claimed: true }; }
  async state(_attemptId: string, state: FactoryAttemptLaunchState): Promise<void> { if (!this.intent) throw new Error("launch is missing"); this.intent = { ...this.intent, state }; }
  async recordTerminal(_attemptId: string, result: FactoryRunnerResult): Promise<FactoryRunnerResult> {
    if (this.terminal && canonicalJson(this.terminal) !== canonicalJson(result)) throw new Error("terminal result conflict");
    this.terminal ??= JSON.parse(canonicalJson(result)) as FactoryRunnerResult;
    return this.terminal;
  }
  async terminalResult(): Promise<FactoryRunnerResult | undefined> { return this.terminal; }
}

class RenewalFailureRunner implements Runner {
  private inspection: RunnerInspection = { id: "", state: "unknown", diagnostics: [] };
  private readonly execution: RunnerExecution = { workerId: "", request: async () => { await Bun.sleep(5_200); return { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] }; }, close: async () => {}, onNotification: () => () => {} };
  async build(): Promise<never> { throw new Error("build is not part of lease renewal"); }
  async collectArtifacts(): Promise<never> { throw new Error("artifact collection is not part of lease renewal"); }
  async inspect(id: string): Promise<RunnerInspection> { return { ...this.inspection, id }; }
  async start(input: StartRequest): Promise<RunnerExecution> { this.inspection = { id: input.workerId, state: "running", diagnostics: [] }; return { ...this.execution, workerId: input.workerId }; }
  async attach(input: StartRequest): Promise<RunnerExecution> { return { ...this.execution, workerId: input.workerId }; }
  async cancel(id: string): Promise<void> { this.inspection = { id, state: "cancelled", diagnostics: [] }; }
}

class TerminalRunner implements Runner {
  async build(): Promise<never> { throw new Error("build is not part of terminal recovery"); }
  async collectArtifacts(): Promise<never> { throw new Error("artifact collection is not part of terminal recovery"); }
  async inspect(id: string): Promise<RunnerInspection> { return { id, state: "cancelled", diagnostics: [] }; }
  async start(): Promise<never> { throw new Error("terminal workers must never start"); }
  async cancel(): Promise<void> {}
}

test("a durable launch intent attaches after start response loss and never starts the worker twice", async () => {
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${request.authority.projectId},'Attempt runtime','/tmp/attempt-runtime')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${request.authority.tenantId},6)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${request.authority.tenantId},${request.authority.projectId})`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES (${request.authority.tenantId},${request.authority.projectId},${request.authority.runId},${digest},'runtime',6,${digest},'{}')`);
    await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${request.authority.attemptId},${request.authority.tenantId},${request.authority.projectId},${request.authority.runId},${request.authority.nodeInstanceId},2,3,4,5,6,0,${new Date(request.authority.deadlineAtMs)},${digest},'{}','admitted')`);
    const runner = new ResponseLossRunner();
    const pool = { acknowledgeStart: async () => renewedLease, renew: async () => renewedLease };
    const runtime = new IsolatedFactoryAttemptRuntime({ runner, launches: new FactoryDatabaseAttemptLaunchStore(db), pool, broker: { invoke: async () => { throw new Error("response-loss runner does not call the broker"); } }, signStopReceipt, readiness: dispatchReadiness, presentStopReceipt: async () => {}, mintAttemptToken: async () => "fresh-attempt-token" });
    const opened = await runtime.open(request, lease, prepared);
    expect(opened.disposition).toBe("attached");
    expect(runner.starts).toBe(1);
    expect(runner.attaches).toBe(1);
    expect(runner.acknowledgements[0]?.context.token).toBe("fresh-attempt-token");
    await expect(opened.wait()).rejects.toThrow("durable terminal result");
    const restarted = new IsolatedFactoryAttemptRuntime({ runner, launches: new FactoryDatabaseAttemptLaunchStore(db), pool, broker: { invoke: async () => { throw new Error("response-loss runner does not call the broker"); } }, signStopReceipt, readiness: dispatchReadiness, presentStopReceipt: async () => {}, mintAttemptToken: async () => "fresh-recovery-token" });
    const recovered = await restarted.open(request, lease, prepared);
    expect(recovered.disposition).toBe("attached");
    expect(runner.starts).toBe(1);
    expect(runner.attaches).toBe(2);
    const receipt = await recovered.stop("cancelled");
    expect(receipt).toMatchObject({ attemptId: request.authority.attemptId, workerId: recovered.workerId, processGroupAbsent: true, reason: "cancelled", hostId: "host-runtime", hostKeyId: "test-host-key" });
    expect(receipt.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const { hostKeyId: _keyId, hostSignature, receiptDigest: _digest, ...unsigned } = receipt;
    expect(verify("RSA-SHA256", Buffer.from(canonicalJson(unsigned)), hostKeys.publicKey, Buffer.from(hostSignature, "base64url"))).toBe(true);
    expect(receipt.receiptDigest).toBe(`sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`);
  } finally { await database.close(); }
}, 120_000);

test("a failed five-second renewal physically stops the guest and presents its signed receipt", async () => {
  const runner = new RenewalFailureRunner();
  const receipts: FactoryPhysicalStopReceipt[] = [];
  const runtime = new IsolatedFactoryAttemptRuntime({ runner, launches: new MemoryLaunchStore(), pool: { acknowledgeStart: async () => renewedLease, renew: async () => { throw new Error("pool renewal revoked"); } }, broker: { invoke: async () => { throw new Error("renewal runner does not call the broker"); } }, signStopReceipt, readiness: dispatchReadiness, presentStopReceipt: async receipt => { receipts.push(receipt); }, mintAttemptToken: async () => "fresh-renewal-token" });
  const opened = await runtime.open(request, lease, prepared);
  await expect(opened.wait()).rejects.toThrow("pool renewal revoked");
  expect(await runner.inspect(opened.workerId)).toMatchObject({ state: "cancelled" });
  expect(receipts).toMatchObject([{ reason: "lease-revoked", processGroupAbsent: true, reservationId: lease.reservationId }]);
}, 30_000);

test("terminal and uncertain recovery states cannot execute another worker", async () => {
  const pool = { acknowledgeStart: async () => renewedLease, renew: async () => renewedLease };
  const options = { pool, broker: { invoke: async () => { throw new Error("recovery must not invoke a broker"); } }, signStopReceipt, readiness: dispatchReadiness, presentStopReceipt: async () => {}, mintAttemptToken: async () => "recovery-token" };
  const terminal = await new IsolatedFactoryAttemptRuntime({ ...options, runner: new TerminalRunner(), launches: new MemoryLaunchStore() }).open(request, lease, prepared);
  expect(terminal.disposition).toBe("terminal");
  await expect(terminal.wait()).rejects.toThrow("terminal state");
  const uncertain = await new IsolatedFactoryAttemptRuntime({ ...options, runner: new ResponseLossRunner(), launches: new MemoryLaunchStore("launching") }).open(request, lease, prepared);
  expect(uncertain.disposition).toBe("uncertain");
  await expect(uncertain.wait()).rejects.toThrow("outcome is uncertain");
});

test("concurrent open calls have one durable start winner and the other caller only attaches", async () => {
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${request.authority.projectId},'Concurrent runtime','/tmp/concurrent-runtime')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${request.authority.tenantId},6)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${request.authority.tenantId},${request.authority.projectId})`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES (${request.authority.tenantId},${request.authority.projectId},${request.authority.runId},${digest},'runtime',6,${digest},'{}')`);
    await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${request.authority.attemptId},${request.authority.tenantId},${request.authority.projectId},${request.authority.runId},${request.authority.nodeInstanceId},2,3,4,5,6,0,${new Date(request.authority.deadlineAtMs)},${digest},'{}','admitted')`);
    const runner = new ResponseLossRunner();
    const pool = { acknowledgeStart: async () => renewedLease, renew: async () => renewedLease };
    const runtime = new IsolatedFactoryAttemptRuntime({ runner, launches: new FactoryDatabaseAttemptLaunchStore(db), pool, broker: { invoke: async () => { throw new Error("concurrent recovery does not invoke the broker"); } }, signStopReceipt, readiness: dispatchReadiness, presentStopReceipt: async () => {}, mintAttemptToken: async () => "concurrent-token" });
    const [first, second] = await Promise.all([runtime.open(request, lease, prepared), runtime.open(request, lease, prepared)]);
    expect([first.disposition, second.disposition].sort()).toEqual(["attached", "attached"]);
    expect(runner.starts).toBe(1);
    expect(runner.attaches).toBe(2);
  } finally { await database.close(); }
}, 120_000);

test("the trusted runner checks current package readiness before the isolated runtime opens", async () => {
  const canonical = { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] } as const;
  const calls: string[] = [];
  const runtime: FactoryAttemptRuntime = { open: async () => ({ disposition: "started", workerId: "factory-test", invocationId: "invocation-test", wait: async () => canonical, stop: async () => { throw new Error("stop is not part of this dispatch test"); } }) };
  const trusted = new IsolatedFactoryTrustedRunner(runtime, {
    lease: async () => { calls.push("lease"); return lease; },
    preparedPackage: async () => { calls.push("package"); return prepared; },
  }, { assertDispatchReady: async () => { calls.push("readiness"); return prepared; } });
  expect(await trusted.run(request)).toEqual(canonical);
  expect(calls).toEqual(["lease", "package", "readiness"]);
});

test("a fresh isolated Bun guest receives only the minted attempt token and returns its canonical result", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-attempt-runtime-"));
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  const runner = new PodmanRunner({ root, configuredDevices: ["/dev/kfd", "/dev/dri/renderD128", "/dev/dri/renderD129"], ...await provision() });
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${request.authority.projectId},'Attempt guest','/tmp/attempt-guest')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${request.authority.tenantId},6)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${request.authority.tenantId},${request.authority.projectId})`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES (${request.authority.tenantId},${request.authority.projectId},${request.authority.runId},${digest},'runtime',6,${digest},'{}')`);
    await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${request.authority.attemptId},${request.authority.tenantId},${request.authority.projectId},${request.authority.runId},${request.authority.nodeInstanceId},2,3,4,5,6,0,${new Date(request.authority.deadlineAtMs)},${digest},'{}','admitted')`);
    const files = {
      "extension.ts": `import {defineExtension,serve} from '@ezcorp/sdk/v4';const manifest={schemaVersion:4 as const,name:'factory-attempt',version:'1.0.0',author:{name:'factory'},description:'isolated factory attempt',permissions:{},tools:[{name:'run',description:'return canonical C02 cancellation',inputSchema:{type:'object'},outputSchema:{type:'object'}}]};await serve(defineExtension({manifest,tools:{run:async(_input,context)=>{await context.call('factory.broker',{kind:'model',operation:'guest-operation'});return {schemaVersion:'factory.runner.result.v1',status:'cancelled',journalCursor:0,operations:[]}}}}));`,
      "feature.test.ts": "import {expect,test} from 'bun:test';test('factory guest source',()=>expect(true).toBe(true));",
    };
    const build = await runner.build({ operationId: "attempt-guest-build", sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    if (build.state !== "succeeded") throw new Error(`isolated guest build failed: ${build.diagnostics.map(diagnostic => diagnostic.code).join(",")}`);
    if (!build.artifactDigest) throw new Error("isolated guest artifact was not built");
    const guestPrepared = { ...prepared, artifactDigest: build.artifactDigest };
    const pool = { acknowledgeStart: async () => renewedLease, renew: async () => renewedLease };
    const brokerInputs: unknown[] = [];
    const runtime = new IsolatedFactoryAttemptRuntime({ runner, launches: new FactoryDatabaseAttemptLaunchStore(db), pool, broker: { invoke: async (_request, input) => { brokerInputs.push(input); return { accepted: true }; } }, signStopReceipt, readiness: dispatchReadiness, presentStopReceipt: async () => {}, mintAttemptToken: async () => "fresh-isolated-attempt-token" });
    const opened = await runtime.open(request, lease, guestPrepared);
    expect(opened.disposition).toBe("started");
    expect(await opened.wait()).toEqual({ schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] });
    expect(brokerInputs).toEqual([{ kind: "model", operation: "guest-operation" }]);
    await opened.stop("cancelled");
  } finally {
    await runner.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
