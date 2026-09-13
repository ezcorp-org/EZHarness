import type {
  AcceptanceClaim,
  AcceptanceGroup,
  FactoryDefinition,
  FactoryGraph,
  FactoryNode,
  FactoryReference,
  PackageReference,
  PortSchema,
  RunnerReference,
  TaskNode,
  ValueReference,
} from "./types.js";

const digest = (hex: string): string => `sha256:${hex.repeat(64)}`;
const artifactSchema: PortSchema = {
  type: "object",
  properties: {
    digest: { type: "string", minLength: 71, maxLength: 71 },
    mediaType: { type: "string", minLength: 1 },
    storage: { type: "string", minLength: 1 },
  },
  required: ["digest", "mediaType", "storage"],
  additionalProperties: false,
};
const evidenceSchema: PortSchema = { type: "array", items: artifactSchema };
const receiptSchema: PortSchema = { type: "object", additionalProperties: true };
const stringSchema: PortSchema = { type: "string", minLength: 1 };
const repairResultSchema: PortSchema = {
  type: "object",
  properties: { accepted: { type: "boolean" }, candidate: artifactSchema },
  required: ["accepted", "candidate"],
  additionalProperties: false,
};

function runner(packageName: string, exportName: string, hex: string, model?: string): RunnerReference {
  let packageCode = 0;
  for (const character of packageName) packageCode = (packageCode + character.charCodeAt(0)) % 6;
  const packageHex = "abcdef"[packageCode] as string;
  return {
    package: packageName,
    version: "1.0.0",
    digest: digest(packageHex),
    export: exportName,
    ...(model === undefined ? {} : { model }),
    configurationDigest: digest(hex),
  };
}

function packageOf(reference: RunnerReference): PackageReference {
  return { name: reference.package, version: reference.version, digest: reference.digest };
}

function ref(name: string, port: string): ValueReference {
  return { kind: "ref", root: "node", name, path: [port] };
}

function input(name: string): ValueReference {
  return { kind: "ref", root: "input", name };
}

function task(id: string, implementation: RunnerReference, dependsOn: readonly string[], outputPorts: Readonly<Record<string, PortSchema>>, effects: FactoryNode["effects"] = ["read"]): TaskNode {
  return { id, kind: "task", runner: implementation, dependsOn, outputPorts, effects };
}

function claim(id: string, validator: RunnerReference, freshnessMs?: number, required = true): AcceptanceClaim {
  return { id, validator, required, protected: true, ...(freshnessMs === undefined ? {} : { freshnessMs }) };
}

function baseDefinition(id: string, graph: FactoryGraph, inputPorts: Readonly<Record<string, PortSchema>>, outputPorts: Readonly<Record<string, PortSchema>>, claims: readonly AcceptanceClaim[], packages: readonly PackageReference[], factories: readonly FactoryReference[] = [], groups: readonly AcceptanceGroup[] = []): FactoryDefinition {
  return {
    schemaVersion: "factory.v1",
    id,
    version: "1.0.0",
    interpreterCompatibility: "factory-kernel.v1",
    inputPorts,
    outputPorts,
    graph,
    acceptance: { id: `${id}.contract`, version: "1.0.0", claims, ...(groups.length === 0 ? {} : { groups }) },
    packages,
    factories,
    capabilities: [],
    effects: ["none", "read", "write", "publish"],
    bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16 },
  };
}

const codeSnapshot = runner("@ezcorp/reference-code", "snapshotRepository", "a");
const codeGenerate = runner("@ezcorp/reference-code", "generateCandidate", "b", "claude-haiku-4-5-20251001");
const codeRepair = runner("@ezcorp/reference-code", "repairCandidate", "c", "claude-haiku-4-5-20251001");
const codeFreeze = runner("@ezcorp/reference-code", "freezeGitTree", "d");
const codeChecks = runner("@ezcorp/reference-code-validator", "protectedChecks", "e", "claude-haiku-4-5-20251001");
const githubRelease = runner("@ezcorp/github-release", "releasePullRequest", "f");

export const referenceCodeV1: FactoryDefinition = baseDefinition(
  "reference.code.v1",
  {
    nodes: [
      task("snapshot-repository", codeSnapshot, [], { snapshot: artifactSchema }),
      { ...task("generate-private-candidate", codeGenerate, ["snapshot-repository"], { candidate: artifactSchema }, ["write"]), maxIterations: 12 },
      {
        id: "bounded-repair",
        kind: "loop",
        dependsOn: ["generate-private-candidate"],
        initialInput: ref("generate-private-candidate", "candidate"),
        carriedSchema: artifactSchema,
        resultSchema: repairResultSchema,
        body: {
          nodes: [{ ...task("repair-candidate", codeRepair, [], { result: repairResultSchema }, ["write"]), inputPorts: { candidate: artifactSchema }, bindings: { candidate: { kind: "ref", root: "loop", name: "carried" } } }],
          outputs: { result: ref("repair-candidate", "result") },
        },
        until: { kind: "ref", root: "loop", name: "result", path: ["accepted"] },
        nextInput: { kind: "ref", root: "loop", name: "result", path: ["candidate"] },
        maxIterations: 3,
        maxElapsedMs: 6 * 60 * 60 * 1_000,
        onExhausted: "escalate",
        outputPorts: { candidate: artifactSchema },
        effects: ["write"],
      },
      task("freeze-complete-git-tree", codeFreeze, ["bounded-repair"], { candidate: artifactSchema }),
      task("protected-checks", codeChecks, ["freeze-complete-git-tree"], { evidence: evidenceSchema }),
      { id: "acceptance", kind: "acceptance", dependsOn: ["freeze-complete-git-tree", "protected-checks"], contract: "reference.code.v1.contract", candidate: ref("freeze-complete-git-tree", "candidate"), evidence: ref("protected-checks", "evidence"), maxRepairs: 2, outputPorts: { acceptedCandidate: artifactSchema } },
      { id: "release-approval", kind: "approval", dependsOn: ["acceptance"], choices: ["approve", "deny"], context: ref("acceptance", "acceptedCandidate"), actorScope: "tenant-contract-admin", expiresInMs: 24 * 60 * 60 * 1_000, onDenied: "fail", onExpired: "escalate" },
      { id: "github-pr-release", kind: "release", dependsOn: ["acceptance", "release-approval"], adapter: githubRelease, acceptedCandidate: ref("acceptance", "acceptedCandidate"), destination: input("destinationRepository"), effects: ["publish"], outputPorts: { receipt: receiptSchema } },
    ],
    outputs: { receipt: ref("github-pr-release", "receipt") },
  },
  {
    repositoryConnection: { type: "object", additionalProperties: true },
    baseCommitSha: stringSchema,
    request: stringSchema,
    destinationRepository: { type: "object", additionalProperties: true },
    baseBranch: stringSchema,
  },
  { receipt: receiptSchema },
  [
    claim("frozen-install", codeChecks, 24 * 60 * 60 * 1_000),
    claim("build", codeChecks, 24 * 60 * 60 * 1_000),
    claim("typecheck", codeChecks, 24 * 60 * 60 * 1_000),
    claim("declared-tests", codeChecks, 24 * 60 * 60 * 1_000),
    claim("protected-fixtures", codeChecks, 24 * 60 * 60 * 1_000),
    claim("dependency-advisory", codeChecks, 15 * 60 * 1_000),
    claim("secret-scan", codeChecks, 24 * 60 * 60 * 1_000),
    claim("allowed-paths", codeChecks, 24 * 60 * 60 * 1_000),
    claim("protected-assets-unchanged", codeChecks, 24 * 60 * 60 * 1_000),
    claim("supervised-review", runner("@ezcorp/reference-code-validator", "supervisedReview", "e", "claude-haiku-4-5-20251001"), 15 * 60 * 1_000),
  ],
  [codeSnapshot, codeGenerate, codeRepair, codeFreeze, codeChecks, githubRelease].map(packageOf).filter((item, index, values) => values.findIndex((candidate) => candidate.name === item.name) === index),
);

const imageGenerate = runner("@ezcorp/reference-image", "generateSdxl", "a");
const imageNormalize = runner("@ezcorp/reference-image", "normalizePng", "b");
const imageValidate = runner("@ezcorp/reference-image-validator", "validateImage", "c", "claude-haiku-4-5-20251001");
const imageFormat = runner("@ezcorp/reference-image-validator", "deterministicPngChecks", "d");
const imageOcr = runner("@ezcorp/reference-image-validator", "tesseractEnglish", "e");
const imageVisionOne = runner("@ezcorp/reference-image-validator", "semanticEvaluationOne", "a", "claude-haiku-4-5-20251001");
const imageVisionTwo = runner("@ezcorp/reference-image-validator", "semanticEvaluationTwo", "b", "claude-haiku-4-5-20251001");
const imageVisionThree = runner("@ezcorp/reference-image-validator", "semanticEvaluationThree", "c", "claude-haiku-4-5-20251001");
const imageSelect = runner("@ezcorp/reference-image", "selectFirstAccepted", "d");
const s3Release = runner("@ezcorp/s3-immutable-publish", "publish", "e");

export const referenceImageV1: FactoryDefinition = baseDefinition(
  "reference.image.v1",
  {
    nodes: [
      task("brief-snapshot", runner("@ezcorp/reference-image", "snapshotBrief", "f"), [], { brief: stringSchema }),
      {
        id: "generate-four-seeds",
        kind: "map",
        dependsOn: ["brief-snapshot"],
        collection: { kind: "literal", value: [11, 23, 37, 53] },
        itemSchema: { type: "integer", enum: [11, 23, 37, 53] },
        body: { nodes: [{ ...task("generate-seed", imageGenerate, [], { image: artifactSchema }, ["write"]), inputPorts: { seed: { type: "integer" } }, bindings: { seed: { kind: "ref", root: "map", name: "item" } } }], outputs: { image: ref("generate-seed", "image") } },
        mode: "collect",
        maxItems: 4,
        maxConcurrency: 4,
        outputPorts: { variants: { type: "array", items: { type: "object", additionalProperties: true }, maxItems: 4 } },
        resources: { resourceClass: "gpu", maxComputeMs: 4 * 60 * 60 * 1_000 },
        effects: ["write"],
      },
      task("normalize-png", imageNormalize, ["generate-four-seeds"], { variants: { type: "array", items: artifactSchema, maxItems: 4 } }, ["write"]),
      task("protected-image-checks", imageValidate, ["normalize-png"], { evidence: evidenceSchema }),
      task("choose-first-accepted", imageSelect, ["normalize-png", "protected-image-checks"], { candidate: artifactSchema }),
      { id: "acceptance", kind: "acceptance", dependsOn: ["choose-first-accepted", "protected-image-checks"], contract: "reference.image.v1.contract", candidate: ref("choose-first-accepted", "candidate"), evidence: ref("protected-image-checks", "evidence"), maxRepairs: 1, outputPorts: { acceptedCandidate: artifactSchema } },
      { id: "release-approval", kind: "approval", dependsOn: ["acceptance"], choices: ["approve", "deny"], context: ref("acceptance", "acceptedCandidate"), actorScope: "tenant-contract-admin", expiresInMs: 24 * 60 * 60 * 1_000, onDenied: "fail", onExpired: "escalate" },
      { id: "s3-publication", kind: "release", dependsOn: ["acceptance", "release-approval"], adapter: s3Release, acceptedCandidate: ref("acceptance", "acceptedCandidate"), destination: input("destination"), effects: ["publish"], outputPorts: { receipt: receiptSchema } },
    ],
    outputs: { receipt: ref("s3-publication", "receipt") },
  },
  { brief: stringSchema, outputName: stringSchema, destination: { type: "object", additionalProperties: true } },
  { receipt: receiptSchema },
  [
    claim("png-single-frame", imageFormat, 24 * 60 * 60 * 1_000),
    claim("png-dimensions-color", imageFormat, 24 * 60 * 60 * 1_000),
    claim("png-size", imageFormat, 24 * 60 * 60 * 1_000),
    claim("png-no-extra-payload", imageFormat, 24 * 60 * 60 * 1_000),
    claim("ocr-no-text", imageOcr, 24 * 60 * 60 * 1_000),
    claim("semantic-evaluation-1", imageVisionOne, 15 * 60 * 1_000, false),
    claim("semantic-evaluation-2", imageVisionTwo, 15 * 60 * 1_000, false),
    claim("semantic-evaluation-3", imageVisionThree, 15 * 60 * 1_000, false),
  ],
  [imageGenerate, imageNormalize, imageValidate, imageSelect, s3Release, runner("@ezcorp/reference-image", "snapshotBrief", "f")].map(packageOf).filter((item, index, values) => values.findIndex((candidate) => candidate.name === item.name) === index),
  [],
  [{ id: "semantic-quorum", claimIds: ["semantic-evaluation-1", "semantic-evaluation-2", "semantic-evaluation-3"], minimumPasses: 2, requireAllDecisive: true }],
);

const dataParse = runner("@ezcorp/reference-data", "parseCsv", "a");
const dataTransform = runner("@ezcorp/reference-data", "transformPartition", "b");
const dataReduce = runner("@ezcorp/reference-data", "orderedReduce", "c");
const dataValidate = runner("@ezcorp/reference-data-validator", "reconcile", "d");

export const referenceDataV1: FactoryDefinition = baseDefinition(
  "reference.data.v1",
  {
    nodes: [
      task("input-snapshot", runner("@ezcorp/reference-data", "snapshotCsv", "e"), [], { snapshot: artifactSchema }),
      task("parse-schema-validation", dataParse, ["input-snapshot"], { partitions: { type: "array", items: artifactSchema, maxItems: 100 } }),
      { id: "transform-partitions", kind: "map", dependsOn: ["parse-schema-validation"], collection: ref("parse-schema-validation", "partitions"), itemSchema: artifactSchema, body: { nodes: [{ ...task("pyarrow-transform", dataTransform, [], { partition: artifactSchema }, ["write"]), inputPorts: { partition: artifactSchema }, bindings: { partition: { kind: "ref", root: "map", name: "item" } } }], outputs: { partition: ref("pyarrow-transform", "partition") } }, mode: "all", maxItems: 100, maxConcurrency: 32, effects: ["write"], outputPorts: { partitions: { type: "array", items: artifactSchema, maxItems: 100 } } },
      task("ordered-reduction", dataReduce, ["transform-partitions"], { dataset: artifactSchema, manifest: artifactSchema }, ["write"]),
      task("protected-reconciliation", dataValidate, ["input-snapshot", "ordered-reduction"], { evidence: evidenceSchema }),
      { id: "acceptance", kind: "acceptance", dependsOn: ["ordered-reduction", "protected-reconciliation"], contract: "reference.data.v1.contract", candidate: ref("ordered-reduction", "dataset"), evidence: ref("protected-reconciliation", "evidence"), maxRepairs: 1, outputPorts: { acceptedCandidate: artifactSchema } },
      { id: "release-approval", kind: "approval", dependsOn: ["acceptance"], choices: ["approve", "deny"], context: ref("acceptance", "acceptedCandidate"), actorScope: "tenant-contract-admin", expiresInMs: 24 * 60 * 60 * 1_000, onDenied: "fail", onExpired: "escalate" },
      { id: "s3-export", kind: "release", dependsOn: ["acceptance", "release-approval"], adapter: s3Release, acceptedCandidate: ref("acceptance", "acceptedCandidate"), destination: input("destination"), effects: ["publish"], outputPorts: { receipt: receiptSchema } },
    ],
    outputs: { receipt: ref("s3-export", "receipt") },
  },
  { csv: artifactSchema, destination: { type: "object", additionalProperties: true } },
  { receipt: receiptSchema },
  [
    claim("output-schema", dataValidate),
    claim("row-count-unique-ids", dataValidate),
    claim("source-row-values", dataValidate),
    claim("category-and-global-totals", dataValidate),
    claim("no-null-negative-overflow", dataValidate),
    claim("partition-sequence-complete", dataValidate),
  ],
  [dataParse, dataTransform, dataReduce, dataValidate, s3Release, runner("@ezcorp/reference-data", "snapshotCsv", "e")].map(packageOf).filter((item, index, values) => values.findIndex((candidate) => candidate.name === item.name) === index),
);

const codeReference: FactoryReference = { id: referenceCodeV1.id, version: referenceCodeV1.version, digest: digest("a") };
const imageReference: FactoryReference = { id: referenceImageV1.id, version: referenceImageV1.version, digest: digest("b") };
const dataReference: FactoryReference = { id: referenceDataV1.id, version: referenceDataV1.version, digest: digest("c") };
const catalogValidate = runner("@ezcorp/reference-catalog-validator", "protectedCatalogChecks", "d");

export const referenceCatalogV1: FactoryDefinition = baseDefinition(
  "reference.catalog.v1",
  {
    nodes: [
      { id: "accepted-data", kind: "subfactory", factory: dataReference, releaseMode: "none", grants: [], outputPorts: { artifact: artifactSchema, evidence: evidenceSchema } },
      { id: "accepted-image", kind: "subfactory", factory: imageReference, releaseMode: "none", grants: [], outputPorts: { artifact: artifactSchema, evidence: evidenceSchema } },
      { id: "static-catalog-code", kind: "subfactory", dependsOn: ["accepted-data", "accepted-image"], factory: codeReference, releaseMode: "none", grants: [], outputPorts: { candidate: artifactSchema } },
      task("protected-catalog-tests", catalogValidate, ["static-catalog-code"], { evidence: evidenceSchema }),
      { id: "acceptance", kind: "acceptance", dependsOn: ["static-catalog-code", "protected-catalog-tests"], contract: "reference.catalog.v1.contract", candidate: ref("static-catalog-code", "candidate"), evidence: ref("protected-catalog-tests", "evidence"), outputPorts: { acceptedCandidate: artifactSchema } },
      { id: "release-approval", kind: "approval", dependsOn: ["acceptance"], choices: ["approve", "deny"], context: ref("acceptance", "acceptedCandidate"), actorScope: "tenant-contract-admin", expiresInMs: 24 * 60 * 60 * 1_000, onDenied: "fail", onExpired: "escalate" },
      { id: "github-pr-release", kind: "release", dependsOn: ["acceptance", "release-approval"], adapter: githubRelease, acceptedCandidate: ref("acceptance", "acceptedCandidate"), destination: input("githubDestination"), effects: ["publish"], outputPorts: { receipt: receiptSchema } },
    ],
    outputs: { receipt: ref("github-pr-release", "receipt") },
  },
  { csv: artifactSchema, brief: stringSchema, repository: { type: "object", additionalProperties: true }, baseCommitSha: stringSchema, githubDestination: { type: "object", additionalProperties: true } },
  { receipt: receiptSchema },
  [claim("catalog-build", catalogValidate), claim("catalog-render", catalogValidate)],
  [packageOf(catalogValidate), packageOf(githubRelease)],
  [dataReference, imageReference, codeReference],
);

export const referenceFactories = Object.freeze([
  referenceCodeV1,
  referenceImageV1,
  referenceDataV1,
  referenceCatalogV1,
] as const);
