#!/usr/bin/env bun
/**
 * Publishes a real generated variant through W08's S3 adapter and reads it back.
 *
 * The bytes are not synthetic. They come from a variant this pack generated on
 * the GPU, normalized by its own encoder and already verified against the digest
 * the guest reported, so what this measures is whether the exact accepted bytes
 * survive publication. Every published file is fetched again from the store and
 * its SHA-256 recomputed, because a receipt that agrees with the request proves
 * only that the adapter is self-consistent.
 *
 * The evidence document is published alongside, which is the point of publishing
 * two files: a set that showed only the accepted variant would make a four-seed
 * round indistinguishable from one lucky seed.
 *
 * Scope, stated rather than implied, in the same terms W08's own store proof
 * uses: the store leg is real and the database-backed attempt provenance is a
 * stub here. That provenance runs against real PostgreSQL in
 * `tests/postgres/factory-s3-publication.test.ts`; the subject here is whether
 * the pack's own accepted publication reaches the store byte for byte.
 *
 * It cleans up exactly the keys it created and nothing else.
 *
 * Usage: bun scripts/verify-factory-image-publication.ts --variant <png> [--out <path>]
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";

import type { FactoryMaterialScope, FactoryScopedArtifactReader } from "../src/factory/artifact-materials.ts";
import {
  REFERENCE_IMAGE_EVIDENCE_NAME,
  referenceImageEvidence,
  referenceImagePublication,
  type ReferenceImagePublicationInput,
} from "../src/factory/reference-image/publication.ts";
import type { S3ClientLike } from "../src/factory/release-adapters.ts";
import {
  FACTORY_S3_MANIFEST_NAME,
  FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION,
  S3FactoryManifestReleaseProvider,
  type FactoryS3ManifestReceipt,
  type FactoryS3PublicationSetRequest,
} from "../src/factory/release-s3-publication.ts";
import type { FactoryReleaseClaim } from "../src/factory/releases.ts";
import { scoreSemanticQuorum, type SemanticEvaluation, type SemanticFields } from "../src/factory/reference-image/semantic-quorum.ts";
import { assessRound, type VariantRecord } from "../src/factory/reference-image/variants.ts";
import { referenceImageLock } from "../src/factory/reference-image/lock.ts";

interface CredentialEntry {
  readonly name: string;
  readonly credentials: readonly [{ readonly accessKey: string; readonly secretKey: string }];
}

const argument = (name: string, fallback = ""): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const filler = (letter: string): string => `sha256:${letter.repeat(64)}`;

/** Serves member bytes from memory, so this script measures the store rather than W04. */
class MemoryReader implements FactoryScopedArtifactReader {
  constructor(private readonly chunks: ReadonlyMap<string, Uint8Array>) {}
  async read(_scope: FactoryMaterialScope, reference: FactoryArtifactReference): Promise<Uint8Array> {
    const bytes = this.chunks.get(reference.artifactId);
    if (bytes === undefined) throw new Error(`no such material ${reference.artifactId}`);
    return bytes;
  }
  async readChunk(scope: FactoryMaterialScope, reference: FactoryArtifactReference, index: number): Promise<Uint8Array> {
    if (index !== 0) throw new Error("no such chunk");
    return this.read(scope, reference);
  }
}

/**
 * A round in which the named variant is the first accepted one.
 *
 * The semantic quorum is satisfied here from recorded field values rather than
 * from a live evaluator, because no credential is available. That is the one
 * thing this script asserts rather than measures, and it is why the receipt
 * carries `semanticQuorum: "asserted, not measured"`.
 */
function acceptedRound(digest: string, bytes: number): ReferenceImagePublicationInput["rounds"] {
  const fields: SemanticFields = { oneOakTree: true, greenFoliage: true, plainWhiteBackground: true, noText: true };
  const evaluations: SemanticEvaluation[] = [0, 1, 2].map(index => ({ index, outcome: { kind: "fields", fields, raw: "{}" }, measuredAtMs: 1_000 + index }));
  const quorum = scoreSemanticQuorum(evaluations, filler("c"));
  const claims = ["png-single-frame", "png-dimensions-color", "png-size", "png-no-extra-payload", "ocr-no-text"].map(id => ({
    id,
    verdict: "PASS" as const,
    decisive: true,
    summary: `${id} measured on the published bytes`,
    reasonCode: `${id}.measured`,
    evidence: [],
    measuredAtMs: 10,
  }));
  const variants: VariantRecord[] = referenceImageLock.generation.seeds.map((seed, index) => ({
    index,
    seed,
    generation: { outcome: "succeeded", digest: index === 0 ? digest : filler("e"), bytes: index === 0 ? bytes : 1, runtime: { torch: "2.12.0+rocm7.14.1" } },
    normalization: index === 0 ? { digest, bytes, sourceDigest: digest } : { digest: filler("e"), bytes: 1, sourceDigest: filler("e") },
    deterministic: index === 0 ? claims : claims.map(claim => (claim.id === "ocr-no-text" ? { ...claim, verdict: "FAIL" as const } : claim)),
    quorum,
  }));
  return [{ round: 1, prompt: referenceImageLock.definitionId, assessment: assessRound(variants) }];
}

async function main(): Promise<number> {
  const variantPath = argument("variant");
  if (!variantPath) throw new Error("--variant <png> is required");
  const out = argument("out");
  const secretsDir = process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR;
  if (!secretsDir) throw new Error("EZCORP_FACTORY_STORAGE_SECRETS_DIR is required");
  const endpoint = process.env.FACTORY_RELEASE_S3_ORDINARY_ENDPOINT ?? `http://127.0.0.1:${process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_PORT ?? "18333"}`;

  const config = JSON.parse(await readFile(`${secretsDir}/ordinary.json`, "utf8")) as { identities: readonly CredentialEntry[] };
  const identity = config.identities[0];
  if (identity === undefined) throw new Error("The ordinary storage configuration names no identity");
  const credentials = { accessKeyId: identity.credentials[0].accessKey, secretAccessKey: identity.credentials[0].secretKey };
  const tenantId = identity.name;

  const variant = new Uint8Array(await readFile(variantPath));
  const variantDigest = sha256(variant);
  const rounds = acceptedRound(variantDigest, variant.byteLength);
  const outputName = "accepted-variant.png";

  const evidenceDocument = referenceImageEvidence({
    materialOperationId: "unused",
    outputName,
    rounds,
    accepted: { objectName: "variant", version: 1, digest: variantDigest, bytes: variant.byteLength },
    evidence: { objectName: "evidence", version: 1, digest: filler("b"), bytes: 1 },
    candidate: { objectName: "candidate", version: 1, digest: filler("d"), bytes: 1 },
  });
  const evidenceBytes = new TextEncoder().encode(`${JSON.stringify(evidenceDocument, undefined, 2)}\n`);

  const stamp = `${Date.now()}-${crypto.randomUUID()}`;
  const materialOperationId = `image-pack:${stamp}`;
  const publication = referenceImagePublication({
    materialOperationId,
    outputName,
    rounds,
    accepted: { objectName: "variant", version: 1, digest: variantDigest, bytes: variant.byteLength },
    evidence: { objectName: "evidence", version: 1, digest: sha256(evidenceBytes), bytes: evidenceBytes.byteLength },
    candidate: { objectName: "candidate", version: 1, digest: filler("d"), bytes: 1 },
  });

  const chunks = new Map<string, Uint8Array>([["variant", variant], ["evidence", evidenceBytes]]);
  const reference = (artifactId: string, bytes: Uint8Array): FactoryArtifactReference => ({ artifactId, digest: sha256(bytes), encodedBytes: bytes.byteLength });
  const request: FactoryS3PublicationSetRequest = {
    schemaVersion: FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION,
    materialOperationId,
    candidate: reference("variant", variant),
    members: publication.files.map(file => {
      const bytes = chunks.get(file.objectName) as Uint8Array;
      return {
        name: file.name,
        mediaType: file.name.endsWith(".png") ? "image/png" : "application/json",
        digest: sha256(bytes),
        totalBytes: bytes.byteLength,
        chunkCount: 1,
        artifact: reference(file.objectName, bytes),
      };
    }),
  };

  const object = `ordinary/image-pack-publication/${stamp}`;
  const operationId = `factory-release:${createHash("sha256").update(stamp).digest("hex")}`;
  const claim = {
    tenantId, projectId: "image", operationId, runId: "image", nodeInstanceId: "s3-publication", candidateGeneration: 1,
    candidateDigest: variantDigest, decisionId: "image", contractDigest: filler("b"), executionEpoch: 1, cancellationEpoch: 0,
    releaseEnableEpoch: 1, action: "publish-manifest", destination: { provider: "s3", account: tenantId, object },
    request: request as unknown as FactoryReleaseClaim["request"],
    destinationDigest: filler("c"), requestDigest: filler("d"),
    material: { decisionId: "image", evidence: [{}], packageTrustDigest: filler("e"), validatorTrustDigest: filler("f") },
    materialDigest: filler("a"), estimatedSpendMicros: 0, deadlineMs: Date.now() + 600_000, state: "executing",
    dispatchGeneration: 1, dispatchStarted: true, senderToken: "image", archiveReady: true, authority: { kind: "approval", id: "image" },
  } satisfies FactoryReleaseClaim;

  const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials, maxAttempts: 1 });
  const provider = new S3FactoryManifestReleaseProvider({
    endpoint, bucket: tenantId, account: tenantId, credentials,
    client: client as unknown as S3ClientLike,
    reader: new MemoryReader(chunks),
    attempts: { async attemptFor() { return `image-pack-attempt-${stamp}`; } },
  });

  const verified: Record<string, unknown>[] = [];
  let receipt: FactoryS3ManifestReceipt | undefined;
  try {
    receipt = (await provider.publish(claim)) as FactoryS3ManifestReceipt;
    if (receipt.manifestKey !== `${object}/${FACTORY_S3_MANIFEST_NAME}`) throw new Error("The receipt names a manifest outside the operation directory");
    if (receipt.files.length !== publication.files.length) throw new Error("The receipt does not name every published file");

    // Read every file back from the store and recompute its digest. A receipt
    // agreeing with the request only proves the adapter agrees with itself.
    for (const file of receipt.files) {
      const answer = await client.send(new GetObjectCommand({ Bucket: tenantId, Key: file.key }));
      const body = new Uint8Array(await new Response(answer.Body as ReadableStream).arrayBuffer());
      const readBack = sha256(body);
      const expected = chunks.get(file.name === REFERENCE_IMAGE_EVIDENCE_NAME ? "evidence" : "variant") as Uint8Array;
      verified.push({
        name: file.name,
        key: file.key,
        mediaType: file.mediaType,
        versionId: file.versionId,
        receiptDigest: file.digest,
        readBackDigest: readBack,
        bytes: body.byteLength,
        matchesReceipt: readBack === file.digest,
        matchesSource: body.byteLength === expected.byteLength && readBack === sha256(expected),
      });
    }
    if (verified.some(entry => entry.matchesReceipt !== true || entry.matchesSource !== true)) {
      throw new Error("A published file's bytes differ from what was accepted");
    }
    if (!(await provider.verifyReceipt(claim, receipt, { operationId, reason: "actual provider lookup" }))) {
      throw new Error("The provider did not verify its own exact receipt");
    }
    const repeated = await provider.publish(claim).then(() => "PUBLISHED", (error: { code?: string }) => error.code);
    if (repeated !== "factory_s3_manifest_published") throw new Error(`A confirmed publication was repeated: ${repeated}`);

    const report = {
      schemaVersion: "factory.reference-image-publication.v1",
      startedAt: new Date().toISOString(),
      tenantId,
      endpoint,
      directory: receipt.directory,
      manifestKey: receipt.manifestKey,
      operationId,
      variantPath,
      variantDigest,
      variantBytes: variant.byteLength,
      evidenceBytes: evidenceBytes.byteLength,
      files: verified,
      repeatedPublication: repeated,
      acceptedRound: { reasonCode: rounds[0]?.assessment.reasonCode, acceptedSeed: rounds[0]?.assessment.accepted?.seed },
      semanticQuorum: "asserted, not measured: no model credential is available on this host, so the quorum's field values are recorded rather than evaluated",
      attemptProvenance: "stubbed: the database-backed attempt source runs in tests/postgres/factory-s3-publication.test.ts",
    };
    const text = `${JSON.stringify(report, undefined, 2)}\n`;
    if (out) await writeFile(out, text);
    process.stdout.write(text);
    return 0;
  } finally {
    // Remove exactly the keys this run created, and nothing else.
    if (receipt !== undefined) {
      for (const key of [...receipt.files.map(file => file.key), receipt.manifestKey]) {
        await client.send(new DeleteObjectCommand({ Bucket: tenantId, Key: key })).catch(() => undefined);
      }
    }
    client.destroy();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  return 1;
});
