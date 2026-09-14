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
const booleanSchema: PortSchema = { type: "boolean" };
const mapOutcomeSchema = (value: PortSchema): PortSchema => ({
  type: "object",
  properties: { outcome: { type: "string", enum: ["succeeded", "failed"] }, value, error: { type: "string" } },
  required: ["outcome"],
  additionalProperties: false,
});
/**
 * The one input an authorized repair may replace on a candidate producer.
 *
 * A rejection carries its failures back to the operator, who seals them here. Re-running the
 * producer with them is what makes the next generation a repair rather than a blind retry, and the
 * empty literal is the first generation's "no remediation yet".
 */
const remediationSchema: PortSchema = { type: "string", maxLength: 4096 };
const noRemediation = { kind: "literal" as const, value: "" };

function runner(packageName: string, exportName: string, hex: string, model?: string): RunnerReference {
  let packageCode = 0;
  for (const character of packageName) packageCode = (packageCode + character.charCodeAt(0)) % 6;
  const packageHex = "abcdef"[packageCode] as string;
  return {
    package: packageName,
    // The scoped distribution name is not a legal v4 manifest name, so the
    // manifest's own name is derived by stripping the scope and normalising.
    manifestName: manifestNameOf(packageName),
    version: "1.0.0",
    digest: digest(packageHex),
    export: exportName,
    ...(model === undefined ? {} : { model }),
    configurationDigest: digest(hex),
  };
}

/**
 * The v4 manifest name a scoped distribution name corresponds to.
 *
 * Every result satisfies `isManifestName`, which is the whole point: a pack
 * calls this to get a conventional name without having to know the grammar.
 * The grammar requires a LETTER first, so leading digits and dashes are dropped
 * rather than merely trimmed; a name that normalises away entirely falls back
 * to a legal constant instead of returning something the validator would refuse.
 */
export function manifestNameOf(packageName: string): string {
  const unscoped = packageName.includes("/") ? packageName.slice(packageName.lastIndexOf("/") + 1) : packageName;
  const normalised = [...unscoped.toLowerCase()].map(character => (/[a-z0-9-]/.test(character) ? character : "-")).join("");
  const fromLetter = normalised.replace(/^[^a-z]+/, "").slice(0, 64);
  return fromLetter.length > 0 ? fromLetter : "runner";
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
const codeFreeze = runner("@ezcorp/reference-code", "freezeGitTree", "d");
const codeChecks = runner("@ezcorp/reference-code-validator", "protectedChecks", "e", "claude-haiku-4-5-20251001");
const githubRelease = runner("@ezcorp/github-release", "releasePullRequest", "f");

export const referenceCodeV1: FactoryDefinition = baseDefinition(
  "reference.code.v1",
  {
    nodes: [
      {
        ...task("snapshot-repository", codeSnapshot, [], { snapshot: artifactSchema }),
        inputPorts: { repositoryConnection: { type: "object", additionalProperties: true }, baseCommitSha: stringSchema },
        bindings: { repositoryConnection: input("repositoryConnection"), baseCommitSha: input("baseCommitSha") },
      },
      {
        // The one repairable node. A protected rejection replaces its remediation input, and the
        // freeze, the checks and the decision below all re-run against the tree it then produces.
        ...task("generate-private-candidate", codeGenerate, ["snapshot-repository"], { candidate: artifactSchema }, ["write"]),
        inputPorts: { snapshot: artifactSchema, request: stringSchema, baseBranch: stringSchema, remediation: remediationSchema },
        bindings: { snapshot: ref("snapshot-repository", "snapshot"), request: input("request"), baseBranch: input("baseBranch"), remediation: noRemediation },
        repairableInputs: ["remediation"],
        maxIterations: 12,
      },
      { ...task("freeze-complete-git-tree", codeFreeze, ["generate-private-candidate"], { candidate: artifactSchema }), inputPorts: { candidate: artifactSchema, baseCommitSha: stringSchema }, bindings: { candidate: ref("generate-private-candidate", "candidate"), baseCommitSha: input("baseCommitSha") } },
      { ...task("protected-checks", codeChecks, ["freeze-complete-git-tree"], { evidence: evidenceSchema }), inputPorts: { candidate: artifactSchema }, bindings: { candidate: ref("freeze-complete-git-tree", "candidate") } },
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
  [codeSnapshot, codeGenerate, codeFreeze, codeChecks, githubRelease].map(packageOf).filter((item, index, values) => values.findIndex((candidate) => candidate.name === item.name) === index),
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
const imageRoundResultSchema: PortSchema = {
  type: "object",
  properties: { accepted: booleanSchema, candidate: artifactSchema, evidence: evidenceSchema, revisedPrompt: stringSchema },
  required: ["accepted", "candidate", "evidence", "revisedPrompt"],
  additionalProperties: false,
};

export const referenceImageV1: FactoryDefinition = baseDefinition(
  "reference.image.v1",
  {
    nodes: [
      {
        ...task("brief-snapshot", runner("@ezcorp/reference-image", "snapshotBrief", "f"), [], { brief: stringSchema }),
        inputPorts: { brief: stringSchema, outputName: stringSchema, remediation: remediationSchema },
        bindings: { brief: input("brief"), outputName: input("outputName"), remediation: noRemediation },
        repairableInputs: ["remediation"],
      },
      {
        id: "candidate-rounds",
        kind: "loop",
        dependsOn: ["brief-snapshot"],
        initialInput: ref("brief-snapshot", "brief"),
        carriedSchema: stringSchema,
        resultSchema: imageRoundResultSchema,
        body: {
          nodes: [
            {
              id: "generate-four-seeds",
              kind: "map",
              collection: { kind: "literal", value: [11, 23, 37, 53] },
              itemSchema: { type: "integer", enum: [11, 23, 37, 53] },
              body: {
                nodes: [{
                  ...task("generate-seed", imageGenerate, [], { image: artifactSchema }, ["write"]),
                  inputPorts: { seed: { type: "integer" }, prompt: stringSchema, inferenceSteps: { type: "integer", const: 30 }, guidance: { type: "number", const: 7.5 }, width: { type: "integer", const: 1024 }, height: { type: "integer", const: 1024 } },
                  bindings: { seed: { kind: "ref", root: "map", name: "item" }, prompt: { kind: "ref", root: "loop", name: "carried" }, inferenceSteps: { kind: "literal", value: 30 }, guidance: { kind: "literal", value: 7.5 }, width: { kind: "literal", value: 1024 }, height: { kind: "literal", value: 1024 } },
                }],
                outputs: { variants: ref("generate-seed", "image") },
              },
              mode: "collect",
              maxItems: 4,
              maxConcurrency: 4,
              outputPorts: { variants: { type: "array", items: mapOutcomeSchema(artifactSchema), maxItems: 4 } },
              resources: { resourceClass: "gpu", maxComputeMs: 4 * 60 * 60 * 1_000 },
              effects: ["write"],
            },
            { ...task("normalize-png", imageNormalize, ["generate-four-seeds"], { variants: { type: "array", items: artifactSchema, maxItems: 4 } }, ["write"]), inputPorts: { variants: { type: "array", items: mapOutcomeSchema(artifactSchema), maxItems: 4 } }, bindings: { variants: ref("generate-four-seeds", "variants") } },
            { ...task("protected-image-checks", imageValidate, ["normalize-png"], { evidence: evidenceSchema }), inputPorts: { variants: { type: "array", items: artifactSchema, maxItems: 4 } }, bindings: { variants: ref("normalize-png", "variants") } },
            { ...task("choose-first-accepted", imageSelect, ["normalize-png", "protected-image-checks"], { result: imageRoundResultSchema }), inputPorts: { variants: { type: "array", items: artifactSchema, maxItems: 4 }, evidence: evidenceSchema, prompt: stringSchema }, bindings: { variants: ref("normalize-png", "variants"), evidence: ref("protected-image-checks", "evidence"), prompt: { kind: "ref", root: "loop", name: "carried" } } },
          ],
          outputs: {
            accepted: { kind: "ref", root: "node", name: "choose-first-accepted", path: ["result", "accepted"] },
            candidate: { kind: "ref", root: "node", name: "choose-first-accepted", path: ["result", "candidate"] },
            evidence: { kind: "ref", root: "node", name: "choose-first-accepted", path: ["result", "evidence"] },
            revisedPrompt: { kind: "ref", root: "node", name: "choose-first-accepted", path: ["result", "revisedPrompt"] },
          },
        },
        until: { kind: "ref", root: "loop", name: "result", path: ["accepted"] },
        nextInput: { kind: "ref", root: "loop", name: "result", path: ["revisedPrompt"] },
        maxIterations: 2,
        maxElapsedMs: 8 * 60 * 60 * 1_000,
        onExhausted: "escalate",
        outputPorts: { accepted: booleanSchema, candidate: artifactSchema, evidence: evidenceSchema, revisedPrompt: stringSchema },
        effects: ["write"],
      },
      { id: "acceptance", kind: "acceptance", dependsOn: ["candidate-rounds"], contract: "reference.image.v1.contract", candidate: ref("candidate-rounds", "candidate"), evidence: ref("candidate-rounds", "evidence"), maxRepairs: 1, outputPorts: { acceptedCandidate: artifactSchema } },
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
      { ...task("input-snapshot", runner("@ezcorp/reference-data", "snapshotCsv", "e"), [], { snapshot: artifactSchema }), inputPorts: { csv: artifactSchema, remediation: remediationSchema }, bindings: { csv: input("csv"), remediation: noRemediation }, repairableInputs: ["remediation"] },
      {
        ...task("parse-schema-validation", dataParse, ["input-snapshot"], { partitions: { type: "array", items: artifactSchema, maxItems: 100 } }),
        inputPorts: { snapshot: artifactSchema, maximumRows: { type: "integer", const: 1_000_000 }, maximumBytes: { type: "integer", const: 256 * 1024 * 1024 }, partitionRows: { type: "integer", const: 10_000 } },
        bindings: { snapshot: ref("input-snapshot", "snapshot"), maximumRows: { kind: "literal", value: 1_000_000 }, maximumBytes: { kind: "literal", value: 256 * 1024 * 1024 }, partitionRows: { kind: "literal", value: 10_000 } },
      },
      { id: "transform-partitions", kind: "map", dependsOn: ["parse-schema-validation"], collection: ref("parse-schema-validation", "partitions"), itemSchema: artifactSchema, body: { nodes: [{ ...task("pyarrow-transform", dataTransform, [], { partition: artifactSchema }, ["write"]), inputPorts: { partition: artifactSchema }, bindings: { partition: { kind: "ref", root: "map", name: "item" } } }], outputs: { partitions: ref("pyarrow-transform", "partition") } }, mode: "all", maxItems: 100, maxConcurrency: 32, effects: ["write"], outputPorts: { partitions: { type: "array", items: artifactSchema, maxItems: 100 } } },
      { ...task("ordered-reduction", dataReduce, ["transform-partitions"], { dataset: artifactSchema, manifest: artifactSchema }, ["write"]), inputPorts: { partitions: { type: "array", items: artifactSchema, maxItems: 100 } }, bindings: { partitions: ref("transform-partitions", "partitions") } },
      { ...task("protected-reconciliation", dataValidate, ["input-snapshot", "ordered-reduction"], { evidence: evidenceSchema }), inputPorts: { snapshot: artifactSchema, dataset: artifactSchema, manifest: artifactSchema }, bindings: { snapshot: ref("input-snapshot", "snapshot"), dataset: ref("ordered-reduction", "dataset"), manifest: ref("ordered-reduction", "manifest") } },
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
const catalogPrepare = runner("@ezcorp/reference-catalog", "prepareCatalogRequest", "e");
const githubDestinationSchema: PortSchema = {
  type: "object",
  properties: { repository: { type: "object", additionalProperties: true }, baseBranch: stringSchema },
  required: ["repository", "baseBranch"],
  additionalProperties: false,
};

export const referenceCatalogV1: FactoryDefinition = baseDefinition(
  "reference.catalog.v1",
  {
    nodes: [
      { id: "accepted-data", kind: "subfactory", factory: dataReference, releaseMode: "none", grants: [], inputPorts: { csv: artifactSchema }, bindings: { csv: input("csv") }, outputPorts: { artifact: artifactSchema, evidence: evidenceSchema } },
      { id: "accepted-image", kind: "subfactory", factory: imageReference, releaseMode: "none", grants: [], inputPorts: { brief: stringSchema, outputName: stringSchema }, bindings: { brief: input("brief"), outputName: { kind: "literal", value: "catalog-tree.png" } }, outputPorts: { artifact: artifactSchema, evidence: evidenceSchema } },
      { ...task("prepare-catalog-request", catalogPrepare, ["accepted-data", "accepted-image"], { request: stringSchema }), inputPorts: { data: artifactSchema, image: artifactSchema }, bindings: { data: ref("accepted-data", "artifact"), image: ref("accepted-image", "artifact") } },
      {
        id: "static-catalog-code",
        kind: "subfactory",
        dependsOn: ["prepare-catalog-request"],
        factory: codeReference,
        releaseMode: "none",
        grants: [],
        inputPorts: { repositoryConnection: { type: "object", additionalProperties: true }, baseCommitSha: stringSchema, request: stringSchema, destinationRepository: { type: "object", additionalProperties: true }, baseBranch: stringSchema },
        bindings: { repositoryConnection: input("repository"), baseCommitSha: input("baseCommitSha"), request: ref("prepare-catalog-request", "request"), destinationRepository: { kind: "ref", root: "input", name: "githubDestination", path: ["repository"] }, baseBranch: { kind: "ref", root: "input", name: "githubDestination", path: ["baseBranch"] } },
        outputPorts: { candidate: artifactSchema },
      },
      { ...task("protected-catalog-tests", catalogValidate, ["static-catalog-code"], { evidence: evidenceSchema }), inputPorts: { candidate: artifactSchema }, bindings: { candidate: ref("static-catalog-code", "candidate") } },
      { id: "acceptance", kind: "acceptance", dependsOn: ["static-catalog-code", "protected-catalog-tests"], contract: "reference.catalog.v1.contract", candidate: ref("static-catalog-code", "candidate"), evidence: ref("protected-catalog-tests", "evidence"), outputPorts: { acceptedCandidate: artifactSchema } },
      { id: "release-approval", kind: "approval", dependsOn: ["acceptance"], choices: ["approve", "deny"], context: ref("acceptance", "acceptedCandidate"), actorScope: "tenant-contract-admin", expiresInMs: 24 * 60 * 60 * 1_000, onDenied: "fail", onExpired: "escalate" },
      { id: "github-pr-release", kind: "release", dependsOn: ["acceptance", "release-approval"], adapter: githubRelease, acceptedCandidate: ref("acceptance", "acceptedCandidate"), destination: input("githubDestination"), effects: ["publish"], outputPorts: { receipt: receiptSchema } },
    ],
    outputs: { receipt: ref("github-pr-release", "receipt") },
  },
  { csv: artifactSchema, brief: stringSchema, repository: { type: "object", additionalProperties: true }, baseCommitSha: stringSchema, githubDestination: githubDestinationSchema },
  { receipt: receiptSchema },
  [claim("catalog-build", catalogValidate), claim("catalog-render", catalogValidate)],
  [packageOf(catalogValidate), packageOf(catalogPrepare), packageOf(githubRelease)],
  [dataReference, imageReference, codeReference],
);

export const referenceFactories = Object.freeze([
  referenceCodeV1,
  referenceImageV1,
  referenceDataV1,
  referenceCatalogV1,
] as const);
