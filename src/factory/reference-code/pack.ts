import { referenceCodeV1 } from "@ezcorp/factory-sdk";
import type { FactoryDefinition, FactoryNode, RunnerReference } from "@ezcorp/factory-sdk";
import { referenceCodeProtectedChecks, type ReferenceCodeChecksInput, type ReferenceCodeChecksReport } from "./checks";
import { freezeReferenceCodeCandidate, type ReferenceCodeCandidate, type ReferenceCodeFreezeInput } from "./freeze";
import { generateReferenceCodeCandidate, type ReferenceCodeGenerateInput, type ReferenceCodeGeneration } from "./generate";
import { referenceCodeGuestDigest } from "./guest";
import { referenceCodeSupervisedReview, type ReferenceCodeReview, type ReferenceCodeReviewInput } from "./review";
import { snapshotReferenceCodeRepository, type ReferenceCodeRepositoryReader, type ReferenceCodeSnapshot } from "./snapshot";

/**
 * The reference code pack, as one thing an application composes.
 *
 * `reference.code.v1` names five runner exports across two packages. Until now those names were
 * the only evidence the implementations existed, which is exactly the gap the requirement index
 * records against C10.1: "every task body names a package that does not exist". This module binds
 * each declared name to the function that answers it, and `pack.test.ts` compares the two lists in
 * both directions, so a definition that names an export nobody wrote, or an implementation the
 * definition never asks for, fails a test rather than a production run.
 *
 * It is a registry, not a runtime. Artifact resolution, journaling, and dispatch belong to the
 * attempt runtime that already exists; what was missing was one place for a composition root to
 * look up "what runs `generateCandidate`".
 */

export const REFERENCE_CODE_GENERATOR_PACKAGE = "@ezcorp/reference-code";
export const REFERENCE_CODE_VALIDATOR_PACKAGE = "@ezcorp/reference-code-validator";

export type ReferenceCodeExportName =
  | "snapshotRepository"
  | "generateCandidate"
  | "freezeGitTree"
  | "protectedChecks"
  | "supervisedReview";

export interface ReferenceCodeSnapshotRequest {
  readonly reader: ReferenceCodeRepositoryReader;
  readonly baseCommitSha: string;
}

/**
 * The five implementations, keyed by the export name the definition declares.
 *
 * Each one is the ordinary product function, not a wrapper that adds behaviour. A registry that
 * quietly reshaped its entries would be a second implementation of each of them.
 */
export const REFERENCE_CODE_IMPLEMENTATIONS = Object.freeze({
  snapshotRepository: (request: ReferenceCodeSnapshotRequest): Promise<ReferenceCodeSnapshot> =>
    snapshotReferenceCodeRepository(request.reader, request.baseCommitSha),
  generateCandidate: (request: ReferenceCodeGenerateInput): Promise<ReferenceCodeGeneration> =>
    generateReferenceCodeCandidate(request),
  freezeGitTree: (request: ReferenceCodeFreezeInput): ReferenceCodeCandidate =>
    freezeReferenceCodeCandidate(request),
  protectedChecks: (request: ReferenceCodeChecksInput): Promise<ReferenceCodeChecksReport> =>
    referenceCodeProtectedChecks(request),
  supervisedReview: (request: ReferenceCodeReviewInput): Promise<ReferenceCodeReview> =>
    referenceCodeSupervisedReview(request),
} as const satisfies Record<ReferenceCodeExportName, unknown>);

/** Which package each export belongs to, matching the definition's own runner references. */
export const REFERENCE_CODE_EXPORT_PACKAGES: Readonly<Record<ReferenceCodeExportName, string>> = Object.freeze({
  snapshotRepository: REFERENCE_CODE_GENERATOR_PACKAGE,
  generateCandidate: REFERENCE_CODE_GENERATOR_PACKAGE,
  freezeGitTree: REFERENCE_CODE_GENERATOR_PACKAGE,
  protectedChecks: REFERENCE_CODE_VALIDATOR_PACKAGE,
  supervisedReview: REFERENCE_CODE_VALIDATOR_PACKAGE,
});

/** Every runner reference `reference.code.v1` names, from its nodes and from its claims. */
export function referenceCodeRunnerReferences(definition: FactoryDefinition = referenceCodeV1): readonly RunnerReference[] {
  const references: RunnerReference[] = [];
  const visit = (node: FactoryNode): void => {
    if ("runner" in node && node.runner) references.push(node.runner);
    if (node.kind === "release") references.push(node.adapter);
  };
  for (const node of definition.graph.nodes) visit(node);
  for (const claim of definition.acceptance.claims) references.push(claim.validator);
  return references;
}

/** The export names this pack owns, from the two packages it implements. */
export function referenceCodeDeclaredExports(definition: FactoryDefinition = referenceCodeV1): readonly string[] {
  const owned = new Set<string>([REFERENCE_CODE_GENERATOR_PACKAGE, REFERENCE_CODE_VALIDATOR_PACKAGE]);
  const names = new Set<string>();
  for (const reference of referenceCodeRunnerReferences(definition)) {
    if (owned.has(reference.package)) names.add(reference.export);
  }
  return [...names].sort();
}

export interface ReferenceCodePackIdentity {
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly packages: readonly string[];
  readonly exports: readonly ReferenceCodeExportName[];
  /** The digest of the bytes the isolated validator guest actually runs. */
  readonly validatorGuestDigest: string;
}

/**
 * What this deployment would run, named and digested.
 *
 * The guest digest is measured from the staged source rather than declared, so an installation
 * record cannot claim a validator it does not hold.
 */
export async function referenceCodePackIdentity(definition: FactoryDefinition = referenceCodeV1): Promise<ReferenceCodePackIdentity> {
  return {
    definitionId: definition.id,
    definitionVersion: definition.version,
    packages: [REFERENCE_CODE_GENERATOR_PACKAGE, REFERENCE_CODE_VALIDATOR_PACKAGE],
    exports: Object.keys(REFERENCE_CODE_IMPLEMENTATIONS) as ReferenceCodeExportName[],
    validatorGuestDigest: await referenceCodeGuestDigest(),
  };
}
