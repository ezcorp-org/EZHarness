import { expect, test } from "bun:test";
import { classifyFactoryAcceptanceFailure, factorySynchronousReleaseProfile, type FactoryAcceptanceFailureClass } from "./protected-command-effects";
import { FactoryAssuranceClaimError, FactoryAssuranceError } from "./assurance";
import { FactoryTrustedValidatorError } from "./validator-materials";
import { FactoryReleaseProfileError } from "./release-profile";
import type { RunnerReference } from "@ezcorp/factory-sdk";

const digest = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;

function claimFailure(): FactoryAssuranceClaimError {
  return new FactoryAssuranceClaimError(digest("a"), digest("b"), digest("c"), [{ claimId: "tests", validatorId: "tests", verdict: "FAIL", reasonCode: "claim_failed" }], []);
}

test("only a failing claim is semantic, and it is decided by class rather than by string", () => {
  expect(classifyFactoryAcceptanceFailure(claimFailure())).toBe("semantic");
  // A bare error carrying the same code is not a rejection: the receipt has no failures to name.
  expect(classifyFactoryAcceptanceFailure(new FactoryAssuranceError("factory_assurance_claim_failed"))).toBe("infrastructure");
  expect(classifyFactoryAcceptanceFailure({ code: "factory_assurance_claim_failed" })).toBe("infrastructure");
});

test("corruption, trust, and infrastructure faults stay out of the rejection branch", () => {
  const expectations: readonly (readonly [unknown, FactoryAcceptanceFailureClass])[] = [
    [new FactoryAssuranceError("factory_assurance_corrupt"), "corruption"],
    [new FactoryTrustedValidatorError("factory_validator_assignment_corrupt"), "corruption"],
    [new FactoryTrustedValidatorError("factory_validator_result_conflict"), "corruption"],
    [new FactoryAssuranceError("factory_assurance_trust"), "trust"],
    [new FactoryTrustedValidatorError("factory_validator_runtime_untrusted"), "trust"],
    [new FactoryTrustedValidatorError("factory_validator_terminal_untrusted"), "trust"],
    [{ code: "factory_release_trust_inactive" }, "trust"],
    [new FactoryAssuranceError("factory_assurance_stale"), "infrastructure"],
    [new FactoryAssuranceError("factory_assurance_evidence_stale"), "infrastructure"],
    [new FactoryAssuranceError("factory_assurance_not_found"), "infrastructure"],
    [new FactoryTrustedValidatorError("factory_validator_result_invalid"), "infrastructure"],
    [new FactoryTrustedValidatorError("factory_validator_assignment_missing"), "infrastructure"],
    [new FactoryReleaseProfileError("factory_release_profile_aborted"), "infrastructure"],
    [new Error("the pool went away"), "infrastructure"],
    [{ code: 42 }, "infrastructure"],
    [undefined, "infrastructure"],
    [null, "infrastructure"],
    ["factory_assurance_corrupt", "infrastructure"],
  ];
  for (const [error, expected] of expectations) {
    expect({ error: String((error as { code?: string })?.code ?? error), classification: classifyFactoryAcceptanceFailure(error) }).toEqual({ error: String((error as { code?: string })?.code ?? error), classification: expected });
  }
});

test("the synchronous profile bridge keeps the adapter identity it was given", () => {
  const adapter: RunnerReference = { package: "@ezcorp/release", manifestName: "release", version: "1.0.0", digest: digest("a"), export: "publish", configurationDigest: digest("b") };
  const lifted = factorySynchronousReleaseProfile({ adapter, action: "publish", build: () => ({ destination: { provider: "p", account: "a", object: "o" }, request: {}, estimatedSpendMicros: 0 }) });
  expect(lifted.adapter).toEqual(adapter);
  expect(typeof lifted.resolve).toBe("function");
});
