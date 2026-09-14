import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { PodmanRunner, buildLimits, filesDigest } from "@ezcorp/extension-runner";
import { provision } from "../../../packages/@ezcorp/extension-runner/tests/helpers";
import { validateFactoryValidatorClaimReport } from "@ezcorp/factory-sdk/validation";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { migrate } from "../../db/migrate";
import * as schema from "../../db/schema";
import type { FactoryPreparedPackageReceipt } from "../package-preparation";
import type { PoolLease } from "../pool/ledger";
import {
  FactoryDatabaseAttemptLaunchStore,
  IsolatedFactoryAttemptRuntime,
  IsolatedFactoryTrustedRunner,
  signFactoryPhysicalStopReceipt,
  type FactoryAttemptLease,
  type FactoryUnsignedPhysicalStopReceipt,
} from "./attempt-runtime";

const raw = "b".repeat(64);
const digest = `sha256:${raw}`;
const tenantId = "tenant-validator-guest", projectId = "project-validator-guest", runId = "run-validator-guest";
const attemptId = "factory-validator-attempt:guest";
const nodeInstanceId = "factory-validator-node:guest";
const candidate = { artifactId: "candidate-under-validation", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 128 };

/** Exactly the request `FactoryProtectedValidatorScheduler.admitInTransaction` mints. */
const request: FactoryRunnerRequest = {
  schemaVersion: "factory.runner.request.v1",
  authority: { attemptId, tenantId, projectId, runId, nodeInstanceId, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, deadlineAtMs: Date.now() + 120_000, nextOperationIndex: 0 },
  runner: { package: "validator", version: "1.0.0", digest, export: "run", configurationDigest: digest },
  input: { kind: "artifact", artifact: candidate },
  grants: [],
  resources: {},
  tools: [],
  broker: { audience: "trusted-validator-gateway", attemptToken: "durable-validator-admission" },
};
const lease: FactoryAttemptLease = { reservationId: "factory-reservation:guest", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "validator-allocation", hostId: "host-validator-guest" };
const renewedLease: PoolLease = { ...lease, tenantId, fence: "validator-fence", deadlineAt: new Date(Date.now() + 120_000), resources: {} };
const prepared: FactoryPreparedPackageReceipt = { projectId, reference: request.runner, trustRevision: 1, packageTrustDigest: digest, releaseDigest: digest, sourceDigest: digest, artifactDigest: raw, imageDigest: digest, manifestDigest: digest, evidenceDigest: digest, buildIdentity: "build-validator-guest", receiptDigest: digest };
const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signStopReceipt = async (receipt: FactoryUnsignedPhysicalStopReceipt) => signFactoryPhysicalStopReceipt(receipt, "validator-host-key", hostKeys.privateKey);

/**
 * A real isolated Podman guest runs one protected validator.
 *
 * The guest is handed the exact request the scheduler mints: the candidate as a read-only artifact
 * reference, no grants, no tools, and one freshly minted attempt token that is never the durable
 * placeholder. It reports its claims back through the broker, and the SDK validator accepts that
 * payload, so the strict report contract holds across the isolation boundary and not only in
 * process. The guest never mints provenance: the gateway seals that from the durable assignment row.
 */
test("a real isolated guest validates a read-only candidate and returns a strict claim report", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-validator-guest-"));
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  const runner = new PodmanRunner({ root, ...await provision() });
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Validator guest','/tmp/validator-guest')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${tenantId},1)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${tenantId},${projectId})`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES (${tenantId},${projectId},${runId},${digest},'validator',1,${digest},'{}')`);
    await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${attemptId},${tenantId},${projectId},${runId},${nodeInstanceId},0,1,1,1,1,0,${new Date(request.authority.deadlineAtMs)},${digest},'{}','admitted')`);

    const files = {
      "extension.ts": `import {defineExtension,serve} from '@ezcorp/sdk/v4';const manifest={schemaVersion:4 as const,name:'factory-validator',version:'1.0.0',author:{name:'factory'},description:'isolated protected validator',permissions:{},tools:[{name:'run',description:'report protected claims',inputSchema:{type:'object'},outputSchema:{type:'object'}}]};await serve(defineExtension({manifest,tools:{run:async(input,context)=>{const report={schemaVersion:'factory.validator-claims.v1',claims:[{id:'frozen-install',verdict:'PASS',decisive:true,summary:'the pinned install matched its lock',reasonCode:'install.frozen',evidence:[],measuredAtMs:1}]};await context.call('factory.broker',{kind:'validator-report',seenRequest:input,report});return {schemaVersion:'factory.runner.result.v1',status:'cancelled',journalCursor:0,operations:[]}}}}));`,
      "feature.test.ts": "import {expect,test} from 'bun:test';test('validator guest source',()=>expect(true).toBe(true));",
    };
    const build = await runner.build({ operationId: "validator-guest-build", sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    if (build.state !== "succeeded") throw new Error(`isolated validator build failed: ${build.diagnostics.map(diagnostic => diagnostic.code).join(",")}`);
    if (!build.artifactDigest) throw new Error("isolated validator artifact was not built");
    const guestPrepared = { ...prepared, artifactDigest: build.artifactDigest };

    const brokerInputs: { kind: string; seenRequest: FactoryRunnerRequest; report: unknown }[] = [];
    const tokens: string[] = [];
    const runtime = new IsolatedFactoryAttemptRuntime({
      runner,
      launches: new FactoryDatabaseAttemptLaunchStore(db),
      pool: { acknowledgeStart: async () => renewedLease, renew: async () => renewedLease },
      broker: { invoke: async (_request, input) => { brokerInputs.push(input as (typeof brokerInputs)[number]); return { accepted: true }; } },
      signStopReceipt,
      readiness: { assertDispatchReady: async () => guestPrepared },
      presentStopReceipt: async () => {},
      mintAttemptToken: async () => { const token = `minted-validator-token-${tokens.length + 1}`; tokens.push(token); return token; },
    });
    const trusted = new IsolatedFactoryTrustedRunner(runtime, { lease: async () => lease, preparedPackage: async () => guestPrepared }, { assertDispatchReady: async () => guestPrepared });

    const result = await trusted.run(request);
    expect(result).toEqual({ schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] });

    // One real guest ran, under one freshly minted token that is never the durable placeholder.
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toBe(request.broker.attemptToken);
    expect(brokerInputs).toHaveLength(1);
    const reported = brokerInputs[0]!;
    expect(reported.kind).toBe("validator-report");
    // The guest is handed the whole request. It shows the candidate as a read-only artifact
    // reference, no grants, no tools, and the freshly minted token rather than the durable
    // placeholder the scheduler stored.
    expect(reported.seenRequest.input).toEqual({ kind: "artifact", artifact: candidate });
    expect(reported.seenRequest.grants).toEqual([]);
    expect(reported.seenRequest.tools).toEqual([]);
    expect(reported.seenRequest.broker.attemptToken).toBe(tokens[0]);
    expect(reported.seenRequest.authority.attemptId).toBe(attemptId);
    // The strict report contract holds across the isolation boundary, not only in process.
    expect(validateFactoryValidatorClaimReport(reported.report)).toEqual({ ok: true });
    expect(reported.report).toMatchObject({ claims: [{ id: "frozen-install", verdict: "PASS", decisive: true }] });
    // A guest cannot mint provenance: nothing it wrote carries one.
    expect(JSON.stringify(reported.report)).not.toContain("provenance");

    const launch = (await db.execute(sql`SELECT state, worker_id FROM factory_attempt_launches WHERE attempt_id=${attemptId}`)).rows as { state: string; worker_id: string }[];
    expect(launch).toHaveLength(1);
    expect(launch[0]!.worker_id).toBeTruthy();
  } finally {
    await runner.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
