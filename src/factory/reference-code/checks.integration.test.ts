import { describe, expect, test } from "bun:test";
import { validateFactoryValidatorClaimReport, type FactoryValidatorClaimOutcome } from "@ezcorp/factory-sdk";
import { referenceCodeProtectedChecks } from "./checks";
import { freezeReferenceCodeCandidate } from "./freeze";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, withReferenceCodeFile, REFERENCE_CODE_FIXTURE_REQUEST, type ReferenceCodeFixtureName } from "./fixtures";
import { sealReferenceCodeSnapshot, type ReferenceCodeFile } from "./snapshot";

/**
 * The deterministic protected claims against the real toolchain.
 *
 * Nothing here is stubbed: a real `bun install --frozen-lockfile` resolves the fixture's real
 * lockfile, the real TypeScript compiler runs, and the fixture's real test suite decides the
 * `declared-tests` and `protected-fixtures` claims. The C10 golden case must pass all nine, and
 * each negative fixture must fail the one claim it was built to break.
 */

const BASE = "a".repeat(39) + "1";
const snapshot = sealReferenceCodeSnapshot({
  baseSha: BASE,
  treeSha: "b".repeat(39) + "2",
  entries: referenceCodeLaunchRepository().map(file => ({ path: file.path, mode: file.mode as string, content: file.content })),
});

function checksFor(files: readonly ReferenceCodeFile[]) {
  const candidate = freezeReferenceCodeCandidate({
    snapshot,
    files,
    repositoryId: 1,
    baseBranch: REFERENCE_CODE_FIXTURE_REQUEST.baseBranch,
    issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
    title: REFERENCE_CODE_FIXTURE_REQUEST.title,
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    authoredAtSeconds: 1_760_000_000,
    candidateGeneration: 0,
  });
  return referenceCodeProtectedChecks({
    candidate,
    snapshot,
    files,
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    protectedTestPaths: ["test/slugify.protected.test.ts"],
    workspacePrefix: "ezcorp-w10-real-",
  });
}

function verdicts(claims: readonly FactoryValidatorClaimOutcome[]): Record<string, string> {
  return Object.fromEntries(claims.map(claim => [claim.id, claim.verdict]));
}

describe("the protected checks against the real Bun and TypeScript toolchain", () => {
  test("the golden slugify candidate passes all nine mandatory claims", async () => {
    const result = await checksFor(referenceCodeFixtureCandidate("accepted"));
    expect(validateFactoryValidatorClaimReport(result.report).ok).toBe(true);
    expect(verdicts(result.report.claims)).toEqual({
      "frozen-install": "PASS",
      build: "PASS",
      typecheck: "PASS",
      "declared-tests": "PASS",
      "protected-fixtures": "PASS",
      "dependency-advisory": "PASS",
      "secret-scan": "PASS",
      "allowed-paths": "PASS",
      "protected-assets-unchanged": "PASS",
    });
    expect(result.commands.every(command => command.exitCode === 0)).toBe(true);
  }, 600_000);

  test("the base commit itself fails the declared tests, so a pass means real work was done", async () => {
    // The base tree cannot be frozen (it changed nothing), so one allowed-path edit carries it in.
    const files = withReferenceCodeFile(referenceCodeLaunchRepository(), "src/unrelated.ts", "export const unrelated = 1;\n");
    const result = await checksFor(files);
    expect(verdicts(result.report.claims)["declared-tests"]).toBe("FAIL");
    expect(verdicts(result.report.claims)["protected-fixtures"]).toBe("FAIL");
    expect(verdicts(result.report.claims)["frozen-install"]).toBe("PASS");
    const failure = result.report.claims.find(claim => claim.id === "protected-fixtures")!;
    expect(failure.summary).toContain("slugify is not implemented");
  }, 600_000);

  test("a candidate that returns the wrong string fails the declared tests and the fixtures", async () => {
    const result = await checksFor(referenceCodeFixtureCandidate("unchanged-case"));
    const measured = verdicts(result.report.claims);
    expect(measured["declared-tests"]).toBe("FAIL");
    expect(measured["protected-fixtures"]).toBe("FAIL");
    expect(measured["build"]).toBe("PASS");
    expect(measured["typecheck"]).toBe("PASS");
    expect(measured["allowed-paths"]).toBe("PASS");
    expect(measured["protected-assets-unchanged"]).toBe("PASS");
    const declared = result.report.claims.find(claim => claim.id === "declared-tests")!;
    expect(declared.summary).toContain("slugify.protected.test.ts");
    expect(declared.summary).toContain("2 fail");
  }, 600_000);

  test("a candidate that does not compile fails the typecheck claim while its tests still run", async () => {
    const files = withReferenceCodeFile(referenceCodeFixtureCandidate("accepted"), "src/slugify.ts", 'export function slugify(value: string): number {\n  return value;\n}\n');
    const result = await checksFor(files);
    const measured = verdicts(result.report.claims);
    expect(measured["typecheck"]).toBe("FAIL");
    expect(measured["frozen-install"]).toBe("PASS");
    expect(result.report.claims.find(claim => claim.id === "typecheck")!.summary).toContain("error TS");
  }, 600_000);

  test("a lockfile the manifest does not match fails the frozen install and measures nothing after it", async () => {
    const manifest = JSON.parse(new TextDecoder().decode(referenceCodeLaunchRepository().find(file => file.path === "package.json")!.content)) as Record<string, unknown>;
    const drifted = JSON.stringify({ ...manifest, dependencies: { "left-pad": "1.3.0" } }, null, 2) + "\n";
    const files = withReferenceCodeFile(referenceCodeFixtureCandidate("accepted"), "package.json", drifted);
    const result = await checksFor(files);
    const measured = verdicts(result.report.claims);
    expect(measured["frozen-install"]).toBe("FAIL");
    expect(measured["build"]).toBe("INCONCLUSIVE");
    expect(measured["declared-tests"]).toBe("INCONCLUSIVE");
    expect(result.commands).toHaveLength(1);
  }, 600_000);

  test("each remaining negative fixture fails exactly the claim it was built to break", async () => {
    const cases: ReadonlyArray<readonly [ReferenceCodeFixtureName, string]> = [
      ["outside-allowed-paths", "allowed-paths"],
      ["leaked-secret", "secret-scan"],
    ];
    for (const [name, claimId] of cases) {
      const result = await checksFor(referenceCodeFixtureCandidate(name));
      const measured = verdicts(result.report.claims);
      expect(measured[claimId]).toBe("FAIL");
      expect(measured["frozen-install"]).toBe("PASS");
      expect(measured["protected-assets-unchanged"]).toBe("PASS");
    }
  }, 900_000);
});
