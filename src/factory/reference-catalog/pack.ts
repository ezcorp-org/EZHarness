import { isManifestName, manifestNameOf, referenceCatalogV1, type FactoryDefinition, type FactoryReference, type RunnerReference } from "@ezcorp/factory-sdk";
import {
  buildReferenceCatalogCandidate,
  prepareCatalogRequest,
  referenceCatalogCandidateDigest,
  referenceCatalogClaims,
  REFERENCE_CATALOG_CLAIM_IDS,
  type ReferenceCatalogClaim,
  type ReferenceCatalogRequest,
} from "./catalog";
import type { ReferenceCodeFile } from "../reference-code/snapshot";

export const REFERENCE_CATALOG_VERSION = "1.0.0";
export const REFERENCE_CATALOG_PACKAGE = "@ezcorp/reference-catalog";
export const REFERENCE_CATALOG_VALIDATOR_PACKAGE = "@ezcorp/reference-catalog-validator";

/**
 * The v4 manifest names the two distributions build under.
 *
 * Derived from the scoped package name rather than written twice, per the
 * freeze's dated correction: a scoped name can never be a legal v4 manifest
 * name, and a pack that spells both by hand fails at bind time on the next
 * rename instead of here.
 */
export const REFERENCE_CATALOG_MANIFEST_NAME = manifestNameOf(REFERENCE_CATALOG_PACKAGE);
export const REFERENCE_CATALOG_VALIDATOR_MANIFEST_NAME = manifestNameOf(REFERENCE_CATALOG_VALIDATOR_PACKAGE);

export type ReferenceCatalogExportName = "prepareCatalogRequest" | "protectedCatalogChecks";

/** What the protected validator reports for one candidate. */
export interface ReferenceCatalogReport {
  readonly schemaVersion: "factory.reference-catalog-report.v1";
  readonly candidateDigest: string;
  readonly requestDigest: string;
  readonly claims: readonly ReferenceCatalogClaim[];
}

/**
 * The parent's protected checks, as the validator export.
 *
 * It recomputes the candidate digest as well as the claims, so a report can
 * never be read as evidence about a different tree than the one evaluated.
 */
export function protectedCatalogChecks(input: { readonly candidate: readonly ReferenceCodeFile[]; readonly request: ReferenceCatalogRequest }): ReferenceCatalogReport {
  return Object.freeze({
    schemaVersion: "factory.reference-catalog-report.v1" as const,
    candidateDigest: referenceCatalogCandidateDigest(input.candidate),
    requestDigest: input.request.requestDigest,
    claims: referenceCatalogClaims(input.candidate, input.request),
  });
}

/** Every export the two catalog distributions publish, keyed by the name the graph uses. */
export const REFERENCE_CATALOG_IMPLEMENTATIONS = Object.freeze({
  prepareCatalogRequest,
  protectedCatalogChecks,
}) satisfies Record<ReferenceCatalogExportName, unknown>;

export const REFERENCE_CATALOG_EXPORT_PACKAGES: Readonly<Record<ReferenceCatalogExportName, string>> = Object.freeze({
  prepareCatalogRequest: REFERENCE_CATALOG_PACKAGE,
  protectedCatalogChecks: REFERENCE_CATALOG_VALIDATOR_PACKAGE,
});

export const REFERENCE_CATALOG_EXPORT_MANIFEST_NAMES: Readonly<Record<ReferenceCatalogExportName, string>> = Object.freeze({
  prepareCatalogRequest: REFERENCE_CATALOG_MANIFEST_NAME,
  protectedCatalogChecks: REFERENCE_CATALOG_VALIDATOR_MANIFEST_NAME,
});

/**
 * Every runner reference the catalog graph pins.
 *
 * Walks the composite shapes as well as the flat ones. A subfactory node pins
 * a FACTORY rather than a runner and so contributes none, which is exactly
 * why {@link referenceCatalogChildFactories} exists beside this: reporting
 * only runners would make a composite definition look under-pinned.
 */
export function referenceCatalogRunnerReferences(definition: FactoryDefinition = referenceCatalogV1): readonly RunnerReference[] {
  const found: RunnerReference[] = [];
  for (const node of definition.graph.nodes) {
    if (node.kind === "task") found.push(node.runner);
    if (node.kind === "release") found.push(node.adapter);
  }
  for (const value of definition.acceptance.claims) found.push(value.validator);
  const seen = new Set<string>();
  return Object.freeze(found.filter(reference => {
    const key = `${reference.package}#${reference.export}#${reference.digest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

/** Every child factory the catalog composes, in graph order. */
export function referenceCatalogChildFactories(definition: FactoryDefinition = referenceCatalogV1): readonly FactoryReference[] {
  return Object.freeze(definition.graph.nodes.flatMap(node => (node.kind === "subfactory" ? [node.factory] : [])));
}

/**
 * Every reference whose `manifestName` is not a legal v4 manifest name, or is
 * not the one its scoped package derives.
 *
 * Empty is the only acceptable answer: a reference the execution schema admits
 * must be one `validateManifest` would admit too.
 */
export function referenceCatalogManifestNameFaults(definition: FactoryDefinition = referenceCatalogV1): readonly string[] {
  return Object.freeze(referenceCatalogRunnerReferences(definition).flatMap(reference => {
    if (!isManifestName(reference.manifestName)) return [`${reference.package}#${reference.export} declares an illegal manifest name ${reference.manifestName}`];
    if (reference.manifestName !== manifestNameOf(reference.package)) return [`${reference.package}#${reference.export} declares ${reference.manifestName}, not ${manifestNameOf(reference.package)}`];
    return [];
  }));
}

export interface ReferenceCatalogPackIdentity {
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly packages: readonly string[];
  readonly manifestNames: readonly string[];
  readonly exports: readonly string[];
  readonly children: readonly string[];
  readonly claims: readonly string[];
}

/** What this pack is, for a receipt that has to name it without loading it. */
export function referenceCatalogPackIdentity(definition: FactoryDefinition = referenceCatalogV1): ReferenceCatalogPackIdentity {
  return Object.freeze({
    definitionId: definition.id,
    definitionVersion: definition.version,
    packages: Object.freeze([...new Set(Object.values(REFERENCE_CATALOG_EXPORT_PACKAGES))].sort()),
    manifestNames: Object.freeze([...new Set(Object.values(REFERENCE_CATALOG_EXPORT_MANIFEST_NAMES))].sort()),
    exports: Object.freeze([...Object.keys(REFERENCE_CATALOG_IMPLEMENTATIONS)].sort()),
    children: Object.freeze(referenceCatalogChildFactories(definition).map(child => child.id)),
    claims: Object.freeze([...REFERENCE_CATALOG_CLAIM_IDS]),
  });
}

export { buildReferenceCatalogCandidate, prepareCatalogRequest };
