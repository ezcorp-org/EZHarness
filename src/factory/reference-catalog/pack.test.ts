import { expect, test } from "bun:test";
import { isManifestName, manifestNameOf, referenceCatalogV1, referenceCodeV1, referenceDataV1, referenceImageV1 } from "@ezcorp/factory-sdk";
import { digestBytes } from "../../extensions/v4/digest";
import { factoryChildAcceptanceResult } from "../child-release-mode";
import { referenceCodeLaunchRepository } from "../reference-code/fixtures";
import {
  buildReferenceCatalogCandidate,
  prepareCatalogRequest,
  referenceCatalogCandidateDigest,
  referenceCatalogClaims,
  REFERENCE_CATALOG_DATA_PATH,
  REFERENCE_CATALOG_IMAGE_PATH,
} from "./catalog";
import {
  protectedCatalogChecks,
  referenceCatalogChildFactories,
  referenceCatalogManifestNameFaults,
  referenceCatalogPackIdentity,
  referenceCatalogRunnerReferences,
  REFERENCE_CATALOG_EXPORT_MANIFEST_NAMES,
  REFERENCE_CATALOG_EXPORT_PACKAGES,
  REFERENCE_CATALOG_IMPLEMENTATIONS,
  REFERENCE_CATALOG_MANIFEST_NAME,
  REFERENCE_CATALOG_PACKAGE,
  REFERENCE_CATALOG_VALIDATOR_MANIFEST_NAME,
  REFERENCE_CATALOG_VALIDATOR_PACKAGE,
  REFERENCE_CATALOG_VERSION,
} from "./pack";

const dataBytes = new TextEncoder().encode(JSON.stringify({ rowCount: 3, total: "400" }));
const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(0x11)]);
const issue = "Build the accepted catalog.";

function child(bytes: Uint8Array, mediaType: string, decisionId: string) {
  return {
    receipt: factoryChildAcceptanceResult({
      decisionId,
      contractDigest: `sha256:${"c".repeat(64)}`,
      candidateDigest: `sha256:${digestBytes(bytes)}`,
      evidenceSetDigest: `sha256:${"e".repeat(64)}`,
      artifact: { digest: `sha256:${digestBytes(bytes)}`, mediaType, storage: "immutable://accepted" },
    }),
    bytes,
  };
}

const requestInput = { data: child(dataBytes, "application/json", "decision-data"), image: child(imageBytes, "image/png", "decision-image"), issue };

test("the registry dispatches to the same implementations a direct call reaches", () => {
  const throughRegistry = REFERENCE_CATALOG_IMPLEMENTATIONS.prepareCatalogRequest(requestInput);
  expect(throughRegistry).toEqual(prepareCatalogRequest(requestInput));

  const candidate = buildReferenceCatalogCandidate(referenceCodeLaunchRepository(), throughRegistry, new Map([
    [REFERENCE_CATALOG_DATA_PATH, dataBytes],
    [REFERENCE_CATALOG_IMAGE_PATH, imageBytes],
  ]));
  const report = REFERENCE_CATALOG_IMPLEMENTATIONS.protectedCatalogChecks({ candidate, request: throughRegistry });
  expect(report).toEqual(protectedCatalogChecks({ candidate, request: throughRegistry }));
  expect(report.claims).toEqual(referenceCatalogClaims(candidate, throughRegistry));
  expect(report.candidateDigest).toBe(referenceCatalogCandidateDigest(candidate));
  expect(report.requestDigest).toBe(throughRegistry.requestDigest);
  expect(report.claims.every(claim => claim.verdict === "PASS")).toBe(true);
});

test("the report names the tree it evaluated, so it cannot be read as evidence about another", () => {
  const request = prepareCatalogRequest(requestInput);
  const candidate = buildReferenceCatalogCandidate(referenceCodeLaunchRepository(), request, new Map([
    [REFERENCE_CATALOG_DATA_PATH, dataBytes],
    [REFERENCE_CATALOG_IMAGE_PATH, imageBytes],
  ]));
  const other = candidate.filter(file => file.path !== REFERENCE_CATALOG_IMAGE_PATH);
  expect(protectedCatalogChecks({ candidate, request }).candidateDigest)
    .not.toBe(protectedCatalogChecks({ candidate: other, request }).candidateDigest);
});

test("every runner reference the catalog pins declares a legal manifest name derived from its package", () => {
  expect(referenceCatalogManifestNameFaults()).toEqual([]);
  const references = referenceCatalogRunnerReferences();
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) {
    expect(isManifestName(reference.manifestName), reference.package).toBe(true);
    expect(reference.manifestName, reference.package).toBe(manifestNameOf(reference.package));
    expect(reference.manifestName, reference.package).not.toBe(reference.package);
  }
  expect(references.map(reference => reference.export).sort()).toEqual(["prepareCatalogRequest", "protectedCatalogChecks", "releasePullRequest"]);
});

test("a reference whose manifest name drifted from its package is reported, not tolerated", () => {
  const broken = {
    ...referenceCatalogV1,
    graph: { ...referenceCatalogV1.graph, nodes: referenceCatalogV1.graph.nodes.map(node =>
      node.kind === "task" && node.id === "prepare-catalog-request" ? { ...node, runner: { ...node.runner, manifestName: "@ezcorp/reference-catalog" } } : node) },
  };
  expect(referenceCatalogManifestNameFaults(broken)).toEqual(["@ezcorp/reference-catalog#prepareCatalogRequest declares an illegal manifest name @ezcorp/reference-catalog"]);

  const renamed = {
    ...referenceCatalogV1,
    graph: { ...referenceCatalogV1.graph, nodes: referenceCatalogV1.graph.nodes.map(node =>
      node.kind === "task" && node.id === "prepare-catalog-request" ? { ...node, runner: { ...node.runner, manifestName: "something-else" } } : node) },
  };
  expect(referenceCatalogManifestNameFaults(renamed)).toEqual(["@ezcorp/reference-catalog#prepareCatalogRequest declares something-else, not reference-catalog"]);
});

test("the catalog composes exactly the three reference children it pins", () => {
  expect(referenceCatalogChildFactories().map(child => child.id)).toEqual([referenceDataV1.id, referenceImageV1.id, referenceCodeV1.id]);
  for (const child of referenceCatalogChildFactories()) {
    expect(referenceCatalogV1.factories?.some(declared => declared.id === child.id && declared.digest === child.digest), child.id).toBe(true);
  }
});

test("the pack identity names both distributions and both protected claims", () => {
  expect(referenceCatalogPackIdentity()).toEqual({
    definitionId: "reference.catalog.v1",
    definitionVersion: referenceCatalogV1.version,
    packages: [REFERENCE_CATALOG_PACKAGE, REFERENCE_CATALOG_VALIDATOR_PACKAGE].sort(),
    manifestNames: [REFERENCE_CATALOG_MANIFEST_NAME, REFERENCE_CATALOG_VALIDATOR_MANIFEST_NAME].sort(),
    exports: ["prepareCatalogRequest", "protectedCatalogChecks"],
    children: [referenceDataV1.id, referenceImageV1.id, referenceCodeV1.id],
    claims: ["catalog-build", "catalog-render"],
  });
  expect(REFERENCE_CATALOG_EXPORT_PACKAGES.protectedCatalogChecks).toBe(REFERENCE_CATALOG_VALIDATOR_PACKAGE);
  expect(REFERENCE_CATALOG_EXPORT_MANIFEST_NAMES.prepareCatalogRequest).toBe("reference-catalog");
  expect(REFERENCE_CATALOG_VERSION).toBe("1.0.0");
});

test("the definition's own acceptance claims are the two this pack evaluates", () => {
  expect(referenceCatalogV1.acceptance.claims.map(claim => claim.id)).toEqual(["catalog-build", "catalog-render"]);
  for (const claim of referenceCatalogV1.acceptance.claims) {
    expect(claim.required, claim.id).toBe(true);
    expect(claim.protected, claim.id).toBe(true);
    expect(claim.validator.package, claim.id).toBe(REFERENCE_CATALOG_VALIDATOR_PACKAGE);
  }
});
