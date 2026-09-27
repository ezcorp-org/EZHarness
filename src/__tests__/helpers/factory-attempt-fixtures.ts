import type { FactoryModelPin, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryAttemptAuthority } from "../../factory/executions";

/**
 * One durable attempt and the runner request it was admitted with, for suites
 * that drive the real journal. The request digest a journal read fences on is
 * `factoryRunnerRequestDigest(request)`, so a suite seals the authority with it
 * rather than trusting the placeholder here.
 */

export const FACTORY_TEST_DIGEST = `sha256:${"a".repeat(64)}`;

export const factoryTestModelPin: FactoryModelPin = {
  provider: "anthropic", model: "claude-opus-5", configurationDigest: FACTORY_TEST_DIGEST, configuration: {}, policyDigest: FACTORY_TEST_DIGEST, policy: {},
};

export interface FactoryTestAttemptScope {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
}

export function factoryTestAuthority(scope: FactoryTestAttemptScope, overrides: Partial<FactoryAttemptAuthority> = {}): FactoryAttemptAuthority {
  return {
    ...scope, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0,
    requestDigest: "a".repeat(64), deadlineAt: new Date(Date.now() + 600_000), ...overrides,
  };
}

export function factoryTestRunnerRequest(attempt: FactoryAttemptAuthority): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: { attemptId: attempt.attemptId, tenantId: attempt.tenantId, projectId: attempt.projectId, runId: attempt.runId, nodeInstanceId: attempt.nodeInstanceId, candidateGeneration: attempt.candidateGeneration, attemptNumber: attempt.attemptNumber, grantRevision: attempt.grantRevision, reservationGeneration: attempt.reservationGeneration, executionEpoch: attempt.executionEpoch, cancellationEpoch: attempt.cancellationEpoch, deadlineAtMs: attempt.deadlineAt.getTime(), nextOperationIndex: 0 },
    runner: { package: "runner", manifestName: "runner", version: "1", digest: FACTORY_TEST_DIGEST, export: "run" },
    input: { kind: "inline", value: { task: "answer" } },
    grants: [], resources: {}, model: factoryTestModelPin, tools: [],
    broker: { attemptToken: "ephemeral-guest-model-token", audience: "gateway" },
  };
}
