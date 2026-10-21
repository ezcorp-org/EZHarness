import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLimits, filesDigest, PodmanRunner } from "@ezcorp/extension-runner";
import { referenceCodeV1, type FactoryRunnerRequest, type JsonValue } from "@ezcorp/factory-sdk";
import { validateFactoryValidatorClaimReport } from "@ezcorp/factory-sdk/validation";
import { provision } from "../../../packages/@ezcorp/extension-runner/tests/helpers";
import { openFactoryEffectClaimsForTest } from "../../__tests__/helpers/factory-effect-claims";
import { factoryGuestStagedJson } from "../../__tests__/helpers/factory-guest-material-host";
import { referenceCodeGuestChain } from "../../__tests__/helpers/reference-code-guest-chain";
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
} from "../runner/attempt-runtime";
import { REFERENCE_CODE_GUEST_ENTRYPOINT } from "./guest";
import { REFERENCE_CODE_VALIDATOR_MANIFEST_NAME } from "./pack";
import { REFERENCE_CODE_RESULT_OUTPUT } from "./runner-entry";
import { referenceCodeRunnerPackageFiles } from "./runner-packages";

/**
 * The toolchain claims lane in a real guest (W4H-28 P3).
 *
 * The validator package is built by the product's isolated build, which fetches its locked toolchain
 * by version and SHA-512; the guest then runs `protectedChecks` with no network, a read-only root and
 * a noexec /tmp, reading the frozen candidate through its one reverse frame. The accepted fixture
 * candidate passes all nine claims; the base's unchanged case fails declared-tests and nothing else.
 */

const raw = "b".repeat(64);
const digest = `sha256:${raw}`;
const tenantId = "tenant-reference-lane", projectId = "project-reference-lane", runId = "run-reference-lane";
const lease: FactoryAttemptLease = { reservationId: "factory-reservation:lane", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "lane-allocation", hostId: "host-lane" };
const renewedLease: PoolLease = { ...lease, tenantId, fence: "lane-fence", deadlineAt: new Date(Date.now() + 600_000), resources: {} };
const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signStopReceipt = async (receipt: FactoryUnsignedPhysicalStopReceipt) => signFactoryPhysicalStopReceipt(receipt, "lane-host-key", hostKeys.privateKey);
const validator = referenceCodeV1.acceptance.claims.find(claim => claim.validator.export === "protectedChecks")!.validator;

test("the validator package's guest runs the nine protected claims on its pinned toolchain", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-reference-lane-"));
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  const runner = new PodmanRunner({ root, ...await provision() });
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Lane','/tmp/lane')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${tenantId},1)`);
    await openFactoryEffectClaimsForTest(db, tenantId);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${tenantId},${projectId})`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES (${tenantId},${projectId},${runId},${digest},'lane',1,${digest},'{}')`);

    const files = await referenceCodeRunnerPackageFiles(REFERENCE_CODE_VALIDATOR_MANIFEST_NAME);
    const build = await runner.build({ operationId: "reference-lane-build", sourceDigest: filesDigest(files), files, entrypoint: REFERENCE_CODE_GUEST_ENTRYPOINT, limits: buildLimits });
    if (build.state !== "succeeded" || !build.artifactDigest) throw new Error(`the validator package did not build: ${build.diagnostics.map(entry => `${entry.code}: ${entry.message}`).join(" | ").slice(0, 4000)}`);
    const prepared: FactoryPreparedPackageReceipt = { projectId, reference: validator, trustRevision: 1, packageTrustDigest: digest, releaseDigest: digest, sourceDigest: digest, artifactDigest: build.artifactDigest, imageDigest: digest, manifestDigest: digest, evidenceDigest: digest, buildIdentity: "build-lane", receiptDigest: digest };

    let broker: (payload: JsonValue) => Promise<unknown> = async () => { throw new Error("no chain"); };
    const runtime = new IsolatedFactoryAttemptRuntime({
      runner,
      launches: new FactoryDatabaseAttemptLaunchStore(db),
      pool: { acknowledgeStart: async () => renewedLease, renew: async () => renewedLease },
      broker: { invoke: async (_request, payload) => broker(payload as JsonValue) },
      signStopReceipt,
      readiness: { assertDispatchReady: async () => prepared },
      presentStopReceipt: async () => {},
      mintAttemptToken: async () => "lane-attempt-token",
    });

    /** One validator attempt over one fixture candidate's frozen chain; the verdict of each claim. */
    const verdicts = async (candidate: "accepted" | "unchanged-case") => {
      const chain = await referenceCodeGuestChain({ candidate });
      broker = chain.host.call;
      const attemptId = `factory-validator-attempt:${candidate}`;
      const request: FactoryRunnerRequest = {
        schemaVersion: "factory.runner.request.v1",
        authority: { attemptId, tenantId, projectId, runId, nodeInstanceId: `factory-validator-node:${candidate}`, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, deadlineAtMs: Date.now() + 600_000, nextOperationIndex: 0 },
        runner: validator, input: { kind: "artifact", artifact: chain.frozenOutput }, grants: [], resources: {}, tools: [],
        broker: { audience: "trusted-validator-gateway", attemptToken: "durable-validator-admission" },
      };
      await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${attemptId},${tenantId},${projectId},${runId},${request.authority.nodeInstanceId},0,1,1,1,1,0,${new Date(request.authority.deadlineAtMs)},${digest},'{}','admitted')`);
      const trusted = new IsolatedFactoryTrustedRunner(runtime, { lease: async () => lease, preparedPackage: async () => prepared }, { assertDispatchReady: async () => prepared });
      const result = await trusted.run(request);
      expect(result.status).toBe("completed");
      const report = factoryGuestStagedJson(chain.host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { claims: { id: string; verdict: string; summary: string }[] };
      expect(validateFactoryValidatorClaimReport(report)).toEqual({ ok: true });
      return Object.fromEntries(report.claims.map(claim => [claim.id, claim.verdict]));
    };

    const accepted = await verdicts("accepted");
    expect(accepted).toEqual({
      "frozen-install": "PASS", build: "PASS", typecheck: "PASS", "declared-tests": "PASS", "protected-fixtures": "PASS",
      "dependency-advisory": "PASS", "secret-scan": "PASS", "allowed-paths": "PASS", "protected-assets-unchanged": "PASS",
    });
    const unchanged = await verdicts("unchanged-case");
    expect(Object.entries(unchanged).filter(([, verdict]) => verdict !== "PASS").map(([id]) => id).sort()).toEqual(["declared-tests", "protected-fixtures"]);
  } finally {
    await runner.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 1_800_000);
