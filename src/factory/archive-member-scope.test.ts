/**
 * W09c: every archive member is read under the scope that sealed it.
 *
 * W04a's plan read every member under the candidate attempt's one material
 * scope. A real validator's report is its own attempt's terminal output, so the
 * archive could never read it and every real release stopped before its claim.
 * These cases pin the additive surface: a located member is read where it was
 * sealed, an attempt output only through the output reader, and a member the
 * resolver cannot locate is refused rather than read under the candidate's
 * scope. The lifecycle suite proves the resolver's authority against real rows.
 */
import { expect, test } from "bun:test";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { digestBytes } from "../extensions/v4/blobs";
import { FaultInjectingArchive, MemoryFactoryReleaseArchive } from "../__tests__/helpers/factory-archive-fixtures";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import type { FactoryMaterialScope, FactoryScopedArtifactReader } from "./artifact-materials";
import {
  FACTORY_ARCHIVE_ATTEMPT_OUTPUT_OPERATION,
  FactoryArchiveWriter,
  factoryArchiveFailureDomain,
  factoryArchiveMemberPlan,
  factoryArchivePublicationSet,
  type FactoryArchiveMemberSources,
} from "./archive-writer";
import { FactoryPublicationOutputReader } from "./release-publication-set";
import type { FactoryReleaseMaterial } from "./releases";

const TENANT = "scope-tenant";
const OPERATION = `factory-release:${"b".repeat(64)}`;
const encoder = new TextEncoder();
const candidateScope: FactoryMaterialScope = { tenantId: TENANT, projectId: "project-s", runId: "run-s", attemptId: "candidate-attempt", operationId: "candidate-operation" };
const validatorScope: FactoryMaterialScope = { ...candidateScope, attemptId: "validator-attempt", operationId: FACTORY_ARCHIVE_ATTEMPT_OUTPUT_OPERATION };
const sealedEvidenceScope: FactoryMaterialScope = { ...candidateScope, attemptId: "other-validator", operationId: "validator-operation" };

function reference(id: string, text: string): FactoryArtifactReference {
  return { artifactId: id, digest: `sha256:${digestBytes(encoder.encode(text))}`, encodedBytes: encoder.encode(text).byteLength };
}
const candidate = reference("candidate-one", "candidate bytes");
const report = reference("validator-report", "report bytes");
const sealedReport = reference("sealed-report", "sealed report bytes");
const material = (evidence: readonly FactoryArtifactReference[]): FactoryReleaseMaterial => ({
  decisionId: "decision-s", evidence: evidence.map((artifact) => ({ artifact })), packageTrustDigest: `sha256:${"a".repeat(64)}`, validatorTrustDigest: `sha256:${"b".repeat(64)}`,
} as unknown as FactoryReleaseMaterial);

test("a located evidence member is planned under the scope that sealed it, and an attempt output says so", () => {
  const sources: FactoryArchiveMemberSources = {
    scope: candidateScope, candidate,
    evidence: [
      { artifactId: report.artifactId, source: "attempt-output", scope: validatorScope },
      { artifactId: sealedReport.artifactId, source: "material", scope: sealedEvidenceScope },
    ],
  };
  const plans = factoryArchiveMemberPlan(sources, material([report, sealedReport]));
  expect(plans.find((plan) => plan.role === "candidate")).toMatchObject({ scope: candidateScope });
  expect(plans.find((plan) => plan.artifact.artifactId === report.artifactId)).toMatchObject({ scope: validatorScope, source: "attempt-output" });
  const sealed = plans.find((plan) => plan.artifact.artifactId === sealedReport.artifactId)!;
  expect(sealed.scope).toEqual(sealedEvidenceScope);
  expect(sealed.source).toBeUndefined();
});

test("an evidence member the resolver does not locate is refused, never read under the candidate's scope", () => {
  const sources: FactoryArchiveMemberSources = { scope: candidateScope, candidate, evidence: [] };
  expect(() => factoryArchiveMemberPlan(sources, material([report]))).toThrow("factory_archive_member_scope_missing");
  // A resolver that predates the locations keeps W04a's plan exactly.
  expect(factoryArchiveMemberPlan({ scope: candidateScope, candidate }, material([report])).map((plan) => plan.scope)).toEqual([candidateScope, candidateScope]);
});

function writerWith(outputs?: { read(scope: FactoryMaterialScope, artifact: FactoryArtifactReference): Promise<Uint8Array> }) {
  const reads: string[] = [];
  const reader: FactoryScopedArtifactReader = {
    async read(scope, artifact) { reads.push(`material:${scope.attemptId}:${artifact.artifactId}`); return encoder.encode(artifact.artifactId === candidate.artifactId ? "candidate bytes" : "sealed report bytes"); },
    async readChunk() { throw new Error("unused"); },
  } as FactoryScopedArtifactReader;
  const archive = new FaultInjectingArchive(new MemoryFactoryReleaseArchive());
  const writer = new FactoryArchiveWriter({
    archive, inventory: archive, reader, ...(outputs === undefined ? {} : { outputs }),
    publicationSet: factoryArchivePublicationSet(() => ({ scope: candidateScope, candidate, evidence: [{ artifactId: report.artifactId, source: "attempt-output", scope: validatorScope }] })),
    failureDomain: factoryArchiveFailureDomain({ productEndpoint: "http://127.0.0.1:18333", archiveEndpoint: "http://127.0.0.1:18334", productCredentialSet: "ordinary.json", archiveCredentialSet: "archive.json" }),
  });
  return { writer, reads };
}
const materialBytes = () => encoder.encode(JSON.stringify(material([report])));

test("an attempt-output member is read only through the output reader, under its own attempt", async () => {
  const outputReads: string[] = [];
  const { writer, reads } = writerWith({ async read(scope, artifact) { outputReads.push(`output:${scope.attemptId}:${artifact.artifactId}`); return encoder.encode("report bytes"); } });
  const stored = await writer.writeImmutable(TENANT, OPERATION, "material", materialBytes());
  expect(stored.key).toContain("/material/");
  expect(reads).toEqual([`material:${candidateScope.attemptId}:${candidate.artifactId}`]);
  expect(outputReads).toEqual([`output:validator-attempt:${report.artifactId}`]);
});

test("without an output reader an attempt-output member is refused by name", async () => {
  const { writer } = writerWith();
  await expect(writer.writeImmutable(TENANT, OPERATION, "material", materialBytes())).rejects.toThrow("factory_archive_member_unavailable");
});

/** A database whose one terminal row the case names, and an artifact store that records its loads. */
function outputReader(terminal: Record<string, unknown> | undefined) {
  const loads: unknown[] = [];
  const handle = { execute: async () => (terminal === undefined ? [] : [terminal]) } as unknown as MigrationDb;
  const database = { transaction: async <T>(work: (transaction: MigrationDb) => Promise<T>) => work(handle) } as unknown as TransactionalDb;
  const reader = new FactoryPublicationOutputReader({
    database, tenantId: TENANT,
    artifacts: { async loadInTransaction(_transaction, _scope, object, kinds) { loads.push({ object, kinds }); return { content: encoder.encode("report bytes") } as never; } },
  });
  return { reader, loads };
}

test("the output reader reads only the artifact the attempt's own terminal names", async () => {
  const bound = { output_artifact_id: report.artifactId, output_digest: report.digest, output_bytes: String(report.encodedBytes) };
  const { reader, loads } = outputReader(bound);
  expect(new TextDecoder().decode(await reader.read(validatorScope, report))).toBe("report bytes");
  expect(loads).toEqual([{ object: { objectId: report.artifactId, digest: report.digest, encodedBytes: report.encodedBytes }, kinds: ["candidate_output"] }]);

  for (const terminal of [undefined, { ...bound, output_artifact_id: "another-output" }, { ...bound, output_digest: `sha256:${"0".repeat(64)}` }, { ...bound, output_bytes: "1" }]) {
    await expect(outputReader(terminal).reader.read(validatorScope, report)).rejects.toThrow("factory_archive_member_unbound");
  }
  // A material scope, or another tenant's, is not an attempt-output location.
  await expect(outputReader(bound).reader.read({ ...validatorScope, operationId: "candidate-operation" }, report)).rejects.toThrow("factory_archive_member_unbound");
  await expect(outputReader(bound).reader.read({ ...validatorScope, tenantId: "other-tenant" }, report)).rejects.toThrow("factory_archive_member_unbound");
});
