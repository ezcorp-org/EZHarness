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
} from "../runner/attempt-runtime";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, REFERENCE_CODE_FIXTURE_REQUEST } from "./fixtures";
import { referenceCodeGuestFiles, REFERENCE_CODE_GUEST_ENTRYPOINT } from "./guest";
import { REFERENCE_CODE_GUEST_MANIFEST, REFERENCE_CODE_GUEST_SCHEMA_VERSION, REFERENCE_CODE_GUEST_TOOL, type ReferenceCodeGuestInput } from "./guest-entry";
import { REFERENCE_CODE_VALIDATOR_MANIFEST_NAME, REFERENCE_CODE_VALIDATOR_PACKAGE } from "./pack";
import type { ReferenceCodeFile } from "./snapshot";

/**
 * The reference code validator, running as a real isolated attempt.
 *
 * Every leg is the product's: the guest is the bundled validator, the sandbox is a real Podman
 * container with no network and a read-only root, and the request is the shape the protected
 * validator scheduler mints — the candidate as input, no grants, no tools, one freshly minted
 * attempt token. What the guest reports must be a strict claim report the SDK accepts, and it must
 * agree with the verdicts the host computes from the same bytes.
 */

const raw = "b".repeat(64);
const digest = `sha256:${raw}`;
const tenantId = "tenant-reference-code", projectId = "project-reference-code", runId = "run-reference-code";
const attemptId = "factory-validator-attempt:reference-code";
const nodeInstanceId = "factory-validator-node:reference-code";
const BASE = "a".repeat(39) + "1";
const TREE = "c".repeat(39) + "3";
const MEASURED_AT = Date.parse("2026-09-14T00:00:00.000Z");

function wire(files: readonly ReferenceCodeFile[]): ReferenceCodeGuestInput["candidateFiles"] {
  return files.map(file => ({ path: file.path, mode: file.mode, contentBase64: Buffer.from(file.content).toString("base64") }));
}

function guestInput(candidate: readonly ReferenceCodeFile[]): ReferenceCodeGuestInput {
  return {
    schemaVersion: REFERENCE_CODE_GUEST_SCHEMA_VERSION,
    baseSha: BASE,
    treeSha: TREE,
    snapshotFiles: wire(referenceCodeLaunchRepository()),
    candidateFiles: wire(candidate),
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    measuredAtMs: MEASURED_AT,
  };
}

function request(input: ReferenceCodeGuestInput): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: { attemptId, tenantId, projectId, runId, nodeInstanceId, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, deadlineAtMs: Date.now() + 120_000, nextOperationIndex: 0 },
    // The manifest name is taken from the guest's OWN manifest rather than written out, because
    // that is the string `releaseFacts()` compares the reference against (freeze section 17). A
    // literal here would let the two drift apart silently and only fail at bind time.
    runner: { package: REFERENCE_CODE_VALIDATOR_PACKAGE, manifestName: REFERENCE_CODE_GUEST_MANIFEST.name, version: "1.0.0", digest, export: REFERENCE_CODE_GUEST_TOOL, configurationDigest: digest },
    input: { kind: "inline", value: input as never },
    grants: [],
    resources: {},
    tools: [],
    broker: { audience: "trusted-validator-gateway", attemptToken: "durable-validator-admission" },
  };
}

const lease: FactoryAttemptLease = { reservationId: "factory-reservation:reference-code", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "reference-code-allocation", hostId: "host-reference-code" };
const renewedLease: PoolLease = { ...lease, tenantId, fence: "reference-code-fence", deadlineAt: new Date(Date.now() + 120_000), resources: {} };
const prepared: FactoryPreparedPackageReceipt = { projectId, reference: request(guestInput(referenceCodeLaunchRepository())).runner, trustRevision: 1, packageTrustDigest: digest, releaseDigest: digest, sourceDigest: digest, artifactDigest: raw, imageDigest: digest, manifestDigest: digest, evidenceDigest: digest, buildIdentity: "build-reference-code-guest", receiptDigest: digest };
const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signStopReceipt = async (receipt: FactoryUnsignedPhysicalStopReceipt) => signFactoryPhysicalStopReceipt(receipt, "reference-code-host-key", hostKeys.privateKey);

test("a real isolated guest reports the reference code contract's static protected claims", async () => {
  const guestSource = await referenceCodeGuestFiles();
  const root = await mkdtemp(join(tmpdir(), "factory-reference-code-guest-"));
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  const runner = new PodmanRunner({ root, ...await provision() });
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Reference code','/tmp/reference-code')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${tenantId},1)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${tenantId},${projectId})`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES (${tenantId},${projectId},${runId},${digest},'reference-code',1,${digest},'{}')`);

    const files = guestSource;
    expect(Object.keys(files)).toContain(REFERENCE_CODE_GUEST_ENTRYPOINT);
    // The scoped package and the v4 manifest name are different strings for the same package, and
    // the reference carries both. Nothing here reconciles them.
    expect(REFERENCE_CODE_GUEST_MANIFEST.name).toBe(REFERENCE_CODE_VALIDATOR_MANIFEST_NAME);
    expect(REFERENCE_CODE_VALIDATOR_PACKAGE).not.toBe(REFERENCE_CODE_GUEST_MANIFEST.name);
    const build = await runner.build({ operationId: "reference-code-guest-build", sourceDigest: filesDigest(files), files, entrypoint: REFERENCE_CODE_GUEST_ENTRYPOINT, limits: buildLimits });
    if (build.state !== "succeeded") throw new Error(`isolated reference code validator build failed: ${build.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join(" | ").slice(0, 4000)}`);
    if (!build.artifactDigest) throw new Error("isolated reference code validator artifact was not built");
    const guestPrepared = { ...prepared, artifactDigest: build.artifactDigest };

    const reports: { kind: string; report: unknown }[] = [];
    const tokens: string[] = [];
    const runtime = new IsolatedFactoryAttemptRuntime({
      runner,
      launches: new FactoryDatabaseAttemptLaunchStore(db),
      pool: { acknowledgeStart: async () => renewedLease, renew: async () => renewedLease },
      broker: { invoke: async (_request, input) => { reports.push(input as (typeof reports)[number]); return { accepted: true }; } },
      signStopReceipt,
      readiness: { assertDispatchReady: async () => guestPrepared },
      presentStopReceipt: async () => {},
      mintAttemptToken: async () => { const token = `minted-reference-code-token-${tokens.length + 1}`; tokens.push(token); return token; },
    });

    /** One isolated attempt over one candidate, returning the claims the guest measured. */
    const runCandidate = async (candidate: readonly ReferenceCodeFile[], suffix: string) => {
      const trusted = new IsolatedFactoryTrustedRunner(runtime, { lease: async () => lease, preparedPackage: async () => guestPrepared }, { assertDispatchReady: async () => guestPrepared });
      const attempt = { ...request(guestInput(candidate)) };
      const scoped: FactoryRunnerRequest = { ...attempt, authority: { ...attempt.authority, attemptId: `${attemptId}:${suffix}` } };
      await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${scoped.authority.attemptId},${tenantId},${projectId},${runId},${nodeInstanceId},0,1,1,1,1,0,${new Date(scoped.authority.deadlineAtMs)},${digest},'{}','admitted')`);
      const result = await trusted.run(scoped);
      expect(result.status).toBe("cancelled");
      return reports.at(-1)!;
    };

    // The accepted candidate: every static claim the guest measures passes.
    const accepted = await runCandidate(referenceCodeFixtureCandidate("accepted"), "accepted");
    expect(accepted.kind).toBe("validator-report");
    expect(validateFactoryValidatorClaimReport(accepted.report)).toEqual({ ok: true });
    const acceptedClaims = (accepted.report as { claims: { id: string; verdict: string }[] }).claims;
    expect(acceptedClaims.map(claim => `${claim.id}=${claim.verdict}`).sort()).toEqual([
      "allowed-paths=PASS", "dependency-advisory=PASS", "protected-assets-unchanged=PASS", "secret-scan=PASS",
    ]);
    // A guest cannot mint provenance; the gateway seals that from the durable assignment row.
    expect(JSON.stringify(accepted.report)).not.toContain("provenance");

    // One freshly minted token per attempt, never the durable placeholder the scheduler stored.
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toBe(request(guestInput(referenceCodeLaunchRepository())).broker.attemptToken);

    // A candidate that leaked a credential is refused inside the sandbox, and the finding never
    // quotes the credential it found.
    const leaked = await runCandidate(referenceCodeFixtureCandidate("leaked-secret"), "leaked");
    const leakedClaims = (leaked.report as { claims: { id: string; verdict: string; summary: string }[] }).claims;
    expect(leakedClaims.find(claim => claim.id === "secret-scan")).toMatchObject({ verdict: "FAIL" });
    expect(JSON.stringify(leaked.report)).not.toContain("QmFkU2VjcmV0");

    // A candidate that wrote outside the approved paths is refused by name.
    const outside = await runCandidate(referenceCodeFixtureCandidate("outside-allowed-paths"), "outside");
    const outsideClaims = (outside.report as { claims: { id: string; verdict: string; summary: string }[] }).claims;
    expect(outsideClaims.find(claim => claim.id === "allowed-paths")).toMatchObject({ verdict: "FAIL" });
    expect(outsideClaims.find(claim => claim.id === "allowed-paths")!.summary).toContain("tools/release.ts");

    // A payload the guest does not recognize is a validator error, never a pass.
    const trusted = new IsolatedFactoryTrustedRunner(runtime, { lease: async () => lease, preparedPackage: async () => guestPrepared }, { assertDispatchReady: async () => guestPrepared });
    const strange = { ...request(guestInput(referenceCodeLaunchRepository())), input: { kind: "inline" as const, value: { schemaVersion: "not.a.known.shape" } as never } };
    const strangeRequest: FactoryRunnerRequest = { ...strange, authority: { ...strange.authority, attemptId: `${attemptId}:strange` } };
    await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${strangeRequest.authority.attemptId},${tenantId},${projectId},${runId},${nodeInstanceId},0,1,1,1,1,0,${new Date(strangeRequest.authority.deadlineAtMs)},${digest},'{}','admitted')`);
    await trusted.run(strangeRequest);
    const rejected = reports.at(-1)!;
    expect((rejected.report as { claims: { verdict: string }[] }).claims.every(claim => claim.verdict === "VALIDATOR_ERROR")).toBe(true);
    expect(validateFactoryValidatorClaimReport(rejected.report)).toEqual({ ok: true });

    const launches = (await db.execute(sql`SELECT attempt_id, state, worker_id FROM factory_attempt_launches`)).rows as { attempt_id: string; state: string; worker_id: string }[];
    expect(launches).toHaveLength(4);
    expect(launches.every(launch => Boolean(launch.worker_id))).toBe(true);
  } finally {
    await runner.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 900_000);
