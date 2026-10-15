import { expect, test } from "bun:test";
import { isFactoryValidatorClaimReport, isFactoryValidatorReport } from "./schema.js";
import { validateFactoryValidatorClaimReport, validateFactoryValidatorReport } from "./validation.js";
import {
  FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION,
  FACTORY_VALIDATOR_REPORT_SCHEMA_VERSION,
  type FactoryValidatorClaimOutcome,
  type FactoryValidatorClaimReport,
  type FactoryValidatorProvenance,
  type FactoryValidatorReport,
  type FactoryValidatorVerdict,
} from "./types.js";

const digest = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;

function claim(overrides: Partial<FactoryValidatorClaimOutcome> = {}): FactoryValidatorClaimOutcome {
  return {
    id: "unit-tests",
    verdict: "PASS",
    decisive: true,
    summary: "every unit test passed",
    reasonCode: "tests.passed",
    evidence: [{ artifactId: "artifact-report", digest: digest("a"), encodedBytes: 128 }],
    measuredAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function claimReport(overrides: Partial<FactoryValidatorClaimReport> = {}): FactoryValidatorClaimReport {
  return { schemaVersion: FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION, claims: [claim()], ...overrides };
}

function provenance(overrides: Partial<FactoryValidatorProvenance> = {}): FactoryValidatorProvenance {
  return {
    attemptId: "attempt-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    runId: "run-1",
    candidateNodeInstanceId: "node-a",
    candidateGeneration: 0,
    candidateDigest: digest("b"),
    validatorLockDigest: digest("c"),
    runnerDigest: digest("d"),
    environmentDigest: digest("e"),
    configurationDigest: digest("f"),
    trustRevision: 1,
    issuerGrantRevision: 1,
    issuedAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_060_000,
    ...overrides,
  };
}

function report(overrides: Partial<FactoryValidatorReport> = {}): FactoryValidatorReport {
  return { schemaVersion: FACTORY_VALIDATOR_REPORT_SCHEMA_VERSION, provenance: provenance(), claims: [claim()], ...overrides };
}

const code = (value: unknown, validate: (input: unknown) => ReturnType<typeof validateFactoryValidatorReport>): string | undefined => {
  const result = validate(value);
  return result.ok ? undefined : result.issues[0]!.code;
};

test("a guest claim report carries every verdict and no provenance", () => {
  for (const verdict of ["PASS", "FAIL", "INCONCLUSIVE", "VALIDATOR_ERROR"] as const satisfies readonly FactoryValidatorVerdict[]) {
    const value = claimReport({ claims: [claim({ verdict })] });
    expect(isFactoryValidatorClaimReport(value)).toBe(true);
    expect(validateFactoryValidatorClaimReport(value)).toEqual({ ok: true });
  }
  const sealed = { ...claimReport(), provenance: provenance() };
  expect(isFactoryValidatorClaimReport(sealed)).toBe(false);
  expect(code(sealed, validateFactoryValidatorClaimReport)).toBe("VALIDATOR_CLAIMS_SCHEMA");
});

test("the generated claim schema rejects an unknown verdict, an unknown key, and the claim bounds", () => {
  expect(isFactoryValidatorClaimReport(claimReport({ claims: [claim({ verdict: "OK" as FactoryValidatorVerdict })] }))).toBe(false);
  expect(isFactoryValidatorClaimReport({ ...claimReport(), extra: 1 })).toBe(false);
  expect(isFactoryValidatorClaimReport(claimReport({ claims: [] }))).toBe(false);
  expect(isFactoryValidatorClaimReport(claimReport({ claims: Array.from({ length: 1001 }, (_value, index) => claim({ id: `claim-${index}` })) }))).toBe(false);
  expect(isFactoryValidatorClaimReport(claimReport({ claims: [claim({ summary: "s".repeat(2049) })] }))).toBe(false);
  expect(isFactoryValidatorClaimReport(claimReport({ claims: [claim({ reasonCode: "" })] }))).toBe(false);
  const manyEvidence = Array.from({ length: 101 }, (_value, index) => ({ artifactId: `artifact-${index}`, digest: digest("a"), encodedBytes: 1 }));
  expect(isFactoryValidatorClaimReport(claimReport({ claims: [claim({ evidence: manyEvidence })] }))).toBe(false);
  expect(isFactoryValidatorClaimReport({ schemaVersion: "factory.validator-result.v1", claims: [claim()] })).toBe(false);
});

test("claim semantics reject duplicates, control characters, unmeasurable times, and foreign evidence", () => {
  expect(code(claimReport({ claims: [claim(), claim()] }), validateFactoryValidatorClaimReport)).toBe("VALIDATOR_CLAIM_DUPLICATE");
  expect(code(claimReport({ claims: [claim({ id: "broken\u0007id" })] }), validateFactoryValidatorClaimReport)).toBe("VALIDATOR_CLAIM_IDENTITY");
  expect(code(claimReport({ claims: [claim({ reasonCode: "broken\u0007code" })] }), validateFactoryValidatorClaimReport)).toBe("VALIDATOR_CLAIM_IDENTITY");
  expect(code(claimReport({ claims: [claim({ measuredAtMs: 1.5 })] }), validateFactoryValidatorClaimReport)).toBe("VALIDATOR_CLAIM_MEASURED_AT");
  expect(code(claimReport({ claims: [claim({ evidence: [{ artifactId: "../escape", digest: digest("a"), encodedBytes: 1 }] })] }), validateFactoryValidatorClaimReport)).toBe("RUNNER_ARTIFACT_ID");
});

test("a FAIL claim must give a repair something to read", () => {
  expect(code(claimReport({ claims: [claim({ verdict: "FAIL", summary: "", evidence: [] })] }), validateFactoryValidatorClaimReport)).toBe("VALIDATOR_CLAIM_EVIDENCE");
  expect(validateFactoryValidatorClaimReport(claimReport({ claims: [claim({ verdict: "FAIL", summary: "the suite failed", evidence: [] })] }))).toEqual({ ok: true });
  expect(validateFactoryValidatorClaimReport(claimReport({ claims: [claim({ verdict: "FAIL", summary: "" })] }))).toEqual({ ok: true });
  expect(validateFactoryValidatorClaimReport(claimReport({ claims: [claim({ verdict: "INCONCLUSIVE", summary: "", evidence: [] })] }))).toEqual({ ok: true });
});

test("an infrastructure error is reportable only when every claim is VALIDATOR_ERROR", () => {
  const error = { code: "guest_exited", message: "the guest died before writing a verdict" };
  expect(validateFactoryValidatorClaimReport(claimReport({ claims: [claim({ verdict: "VALIDATOR_ERROR" })], error }))).toEqual({ ok: true });
  expect(code(claimReport({ claims: [claim({ verdict: "VALIDATOR_ERROR" }), claim({ id: "lint", verdict: "PASS" })], error }), validateFactoryValidatorClaimReport)).toBe("VALIDATOR_ERROR_SCOPE");
  expect(code(claimReport({ claims: [claim({ verdict: "VALIDATOR_ERROR" })], error: { code: "bad\u0007code", message: "m" } }), validateFactoryValidatorClaimReport)).toBe("VALIDATOR_ERROR_BODY");
  expect(code(claimReport({ claims: [claim({ verdict: "VALIDATOR_ERROR" })], error: { code: "c", message: "m\u0007" } }), validateFactoryValidatorClaimReport)).toBe("VALIDATOR_ERROR_BODY");
});

test("a sealed report accepts gateway provenance and reuses the claim rules", () => {
  const value = report();
  expect(isFactoryValidatorReport(value)).toBe(true);
  expect(validateFactoryValidatorReport(value)).toEqual({ ok: true });
  expect(validateFactoryValidatorReport(report({ provenance: provenance({ model: { provider: "anthropic", model: "claude", configurationDigest: digest("f"), configuration: {}, policyDigest: digest("9"), policy: {} } }) }))).toEqual({ ok: true });
  expect(isFactoryValidatorReport(claimReport())).toBe(false);
  expect(code(claimReport(), validateFactoryValidatorReport)).toBe("VALIDATOR_REPORT_SCHEMA");
  expect(code(report({ claims: [claim(), claim()] }), validateFactoryValidatorReport)).toBe("VALIDATOR_CLAIM_DUPLICATE");
});

test("sealed provenance rejects every forged identity, digest, counter, freshness, and model pin", () => {
  expect(code(report({ provenance: provenance({ attemptId: "attempt\u00071" }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_IDENTITY");
  expect(code(report({ provenance: provenance({ candidateNodeInstanceId: "node\u0007a" }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_IDENTITY");
  expect(code(report({ provenance: provenance({ candidateDigest: `sha256:${"Z".repeat(64)}` }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_DIGEST");
  expect(code(report({ provenance: provenance({ configurationDigest: `sha256_${"a".repeat(64)}` }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_DIGEST");
  expect(code(report({ provenance: provenance({ candidateGeneration: 0.5 }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_COUNTER");
  expect(code(report({ provenance: provenance({ trustRevision: 1.5 }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_COUNTER");
  expect(code(report({ provenance: provenance({ issuerGrantRevision: 2.5 }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_COUNTER");
  expect(code(report({ provenance: provenance({ issuedAtMs: 1.5 }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_COUNTER");
  expect(code(report({ provenance: provenance({ expiresAtMs: 1_700_000_000_000 }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_FRESHNESS");
  const foreignModel = { provider: "anthropic", model: "claude", configurationDigest: digest("1"), configuration: {}, policyDigest: digest("9"), policy: {} };
  expect(code(report({ provenance: provenance({ model: foreignModel }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_MODEL");
  expect(code(report({ provenance: provenance({ model: { ...foreignModel, configurationDigest: digest("f"), provider: "bad\u0007provider" } }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_MODEL");
  expect(code(report({ provenance: provenance({ model: { ...foreignModel, configurationDigest: digest("f"), model: "bad\u0007model" } }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_MODEL");
  expect(code(report({ provenance: provenance({ model: { ...foreignModel, configurationDigest: digest("f"), policyDigest: "not-a-digest" } }) }), validateFactoryValidatorReport)).toBe("VALIDATOR_PROVENANCE_MODEL");
});
