import { describe, expect, test } from "bun:test";
import { referenceDataV1, referenceCodeV1 } from "@ezcorp/factory-sdk";
import { fakeReferenceCodeBroker } from "../../__tests__/helpers/reference-code-broker-fake";
import { freezeReferenceCodeCandidate } from "./freeze";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, REFERENCE_CODE_FIXTURE_REQUEST } from "./fixtures";
import { REFERENCE_CODE_DETERMINISTIC_CLAIM_IDS } from "./static-claims";
import { REFERENCE_CODE_REVIEW_CLAIM_ID } from "./review";
import { snapshotReferenceCodeRepository } from "./snapshot";

const MODEL = { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
import {
  referenceCodeDeclaredExports,
  referenceCodePackIdentity,
  referenceCodeRunnerReferences,
  REFERENCE_CODE_EXPORT_PACKAGES,
  REFERENCE_CODE_GENERATOR_PACKAGE,
  REFERENCE_CODE_IMPLEMENTATIONS,
  REFERENCE_CODE_VALIDATOR_PACKAGE,
  type ReferenceCodeExportName,
} from "./pack";

describe("the pack answers exactly what the definition declares", () => {
  test("every export reference.code.v1 names has an implementation, and every implementation is named", () => {
    const declared = referenceCodeDeclaredExports();
    const implemented = Object.keys(REFERENCE_CODE_IMPLEMENTATIONS).sort();
    expect(declared).toEqual(implemented);
    expect(declared).toEqual(["freezeGitTree", "generateCandidate", "protectedChecks", "snapshotRepository", "supervisedReview"]);
  });

  test("each export is attributed to the package the definition puts it in", () => {
    for (const reference of referenceCodeRunnerReferences()) {
      const owned = REFERENCE_CODE_EXPORT_PACKAGES[reference.export as ReferenceCodeExportName];
      if (owned === undefined) continue;
      expect(reference.package).toBe(owned);
    }
    expect(REFERENCE_CODE_EXPORT_PACKAGES.generateCandidate).toBe(REFERENCE_CODE_GENERATOR_PACKAGE);
    expect(REFERENCE_CODE_EXPORT_PACKAGES.supervisedReview).toBe(REFERENCE_CODE_VALIDATOR_PACKAGE);
  });

  test("collects runner references from task nodes, the release adapter, and every claim", () => {
    const references = referenceCodeRunnerReferences();
    expect(references.some(reference => reference.export === "releasePullRequest")).toBe(true);
    expect(references.some(reference => reference.export === "supervisedReview")).toBe(true);
    expect(references.filter(reference => reference.export === "protectedChecks").length).toBeGreaterThan(1);
    // Every claim's validator is reachable, so a claim whose validator nobody implements is visible.
    expect(references.length).toBeGreaterThanOrEqual(referenceCodeV1.acceptance.claims.length);
  });

  test("ignores a definition's nodes that belong to another pack", () => {
    const declared = referenceCodeDeclaredExports(referenceDataV1);
    expect(declared).toEqual([]);
  });

  test("every implementation dispatches to the product function and returns what it returns", async () => {
    const BASE = "a".repeat(39) + "1";
    const TREE = "b".repeat(39) + "2";
    const entries = referenceCodeLaunchRepository().map(file => ({ path: file.path, mode: file.mode as string, content: file.content }));
    const reader = { resolveCommit: async () => ({ commitSha: BASE, treeSha: TREE }), readTree: async () => entries };

    const snapshot = await REFERENCE_CODE_IMPLEMENTATIONS.snapshotRepository({ reader, baseCommitSha: BASE });
    expect(snapshot).toEqual(await snapshotReferenceCodeRepository(reader, BASE));

    const files = referenceCodeFixtureCandidate("accepted");
    const freezeInput = {
      snapshot, files, repositoryId: 1,
      baseBranch: REFERENCE_CODE_FIXTURE_REQUEST.baseBranch,
      issue: REFERENCE_CODE_FIXTURE_REQUEST.issue, title: REFERENCE_CODE_FIXTURE_REQUEST.title,
      allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
      protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
      authoredAtSeconds: 1_760_000_000, candidateGeneration: 0,
    };
    const candidate = REFERENCE_CODE_IMPLEMENTATIONS.freezeGitTree(freezeInput);
    expect(candidate.commitSha).toBe(freezeReferenceCodeCandidate(freezeInput).commitSha);

    const generation = await REFERENCE_CODE_IMPLEMENTATIONS.generateCandidate({
      snapshot, issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
      allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
      protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
      remediation: "", candidateGeneration: 0,
      broker: fakeReferenceCodeBroker([{ text: "nothing to change" }]),
      attemptToken: "pack-attempt", model: MODEL,
    });
    expect(generation.stopReason).toBe("model-finished");

    const checks = await REFERENCE_CODE_IMPLEMENTATIONS.protectedChecks({
      candidate, snapshot, files,
      allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
      protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
      protectedTestPaths: ["test/slugify.protected.test.ts"],
      runner: { run: async command => ({ command: [...command], exitCode: 0, output: "", truncated: false, durationMs: 1, timedOut: false }) },
      workspacePrefix: "ezcorp-w10-pack-",
    });
    expect(checks.report.claims.every(claim => claim.verdict === "PASS")).toBe(true);

    const review = await REFERENCE_CODE_IMPLEMENTATIONS.supervisedReview({
      candidate, snapshot, files, issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
      broker: fakeReferenceCodeBroker([{ text: JSON.stringify({ matchesRequest: true, noUnrequestedEffect: true, noKnownCriticalIssue: true, reason: "ok" }) }]),
      attemptToken: "pack-review", model: MODEL,
    });
    expect(review.report.claims[0]!.verdict).toBe("PASS");
  }, 300_000);

  test("the pack's identity measures the guest digest rather than declaring one", async () => {
    const identity = await referenceCodePackIdentity();
    expect(identity.definitionId).toBe("reference.code.v1");
    expect(identity.definitionVersion).toBe(referenceCodeV1.version);
    expect(identity.packages).toEqual([REFERENCE_CODE_GENERATOR_PACKAGE, REFERENCE_CODE_VALIDATOR_PACKAGE]);
    expect([...identity.exports].sort()).toEqual(referenceCodeDeclaredExports() as ReferenceCodeExportName[]);
    expect(identity.validatorGuestDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the contract, as C10 writes it", () => {
  const HOUR = 60 * 60 * 1_000;
  const MINUTE = 60 * 1_000;

  test("declares exactly the ten mandatory claims, every one required and protected", () => {
    const claims = referenceCodeV1.acceptance.claims;
    expect(claims.map(claim => claim.id)).toEqual([
      "frozen-install", "build", "typecheck", "declared-tests", "protected-fixtures",
      "dependency-advisory", "secret-scan", "allowed-paths", "protected-assets-unchanged",
      "supervised-review",
    ]);
    expect(claims.every(claim => claim.required)).toBe(true);
    expect(claims.every(claim => claim.protected)).toBe(true);
  });

  test("the nine deterministic claims this package measures are the contract's first nine", () => {
    expect([...REFERENCE_CODE_DETERMINISTIC_CLAIM_IDS].sort())
      .toEqual(referenceCodeV1.acceptance.claims.slice(0, 9).map(claim => claim.id).sort());
    expect(referenceCodeV1.acceptance.claims[9]!.id).toBe(REFERENCE_CODE_REVIEW_CLAIM_ID);
  });

  test("freshness is 24 hours for the deterministic claims and 15 minutes for the advisory and the review", () => {
    const freshness = Object.fromEntries(referenceCodeV1.acceptance.claims.map(claim => [claim.id, claim.freshnessMs]));
    expect(freshness["dependency-advisory"]).toBe(15 * MINUTE);
    expect(freshness["supervised-review"]).toBe(15 * MINUTE);
    for (const id of ["frozen-install", "build", "typecheck", "declared-tests", "protected-fixtures", "secret-scan", "allowed-paths", "protected-assets-unchanged"]) {
      expect(freshness[id]).toBe(24 * HOUR);
    }
  });

  test("the generator is the one repairable node, and the release is bound to the acceptance", () => {
    const nodes = Object.fromEntries(referenceCodeV1.graph.nodes.map(node => [node.id, node]));
    const repairable = referenceCodeV1.graph.nodes.filter(node => "repairableInputs" in node && node.repairableInputs?.length);
    expect(repairable.map(node => node.id)).toEqual(["generate-private-candidate"]);
    expect(nodes["github-pr-release"]!.kind).toBe("release");
    expect(nodes["github-pr-release"]!.dependsOn).toEqual(["acceptance", "release-approval"]);
    expect(nodes["release-approval"]!.kind).toBe("approval");
  });

  test("every pinned model is the one identifier C10 names, and nothing else", () => {
    const pinned = referenceCodeRunnerReferences().filter(reference => reference.model !== undefined);
    expect([...new Set(pinned.map(reference => reference.model))]).toEqual(["claude-haiku-4-5-20251001"]);
    expect([...new Set(pinned.map(reference => reference.export))].sort())
      .toEqual(["generateCandidate", "protectedChecks", "supervisedReview"]);
  });

  test("nothing unpinned reaches the model, and the pin's reach is recorded rather than assumed", () => {
    const unpinned = referenceCodeRunnerReferences().filter(reference => reference.model === undefined).map(reference => reference.export);
    expect(unpinned).not.toContain("generateCandidate");
    expect(unpinned).not.toContain("supervisedReview");
    // `protectedChecks` also carries the pin, although the nine claims it reports run no model.
    // Filed as an interface question: a model grant a validator never uses is authority it should
    // not hold. Recorded rather than changed, because `references.ts` is the SDK owner's file.
    expect([...new Set(unpinned)].sort()).toEqual(["freezeGitTree", "releasePullRequest", "snapshotRepository"]);
  });
});
