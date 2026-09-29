import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { snapshotIntent, type FactoryAttemptLaunchIntent } from "../../factory/runner/attempt-wire";

const launchDigest = `sha256:${"a".repeat(64)}`;

/**
 * One valid launch intent for `hostId`, built the way the product builds it.
 *
 * Every identity on the wire is derived and rechecked on arrival, so a literal
 * would be refused; `snapshotIntent` is the only thing that can produce one.
 * Nothing here is durable. Its tenant is "tenant-a".
 */
export function factoryHostLaunchIntent(hostId: string, devices?: Parameters<typeof snapshotIntent>[3], attemptId = "attempt-1"): FactoryAttemptLaunchIntent {
  const runner = { package: "runner", manifestName: "runner", version: "1", digest: launchDigest, export: "run", model: "m", configurationDigest: launchDigest };
  const runnerRequest: FactoryRunnerRequest = {
    schemaVersion: "factory.runner.request.v1",
    authority: {
      attemptId, tenantId: "tenant-a", projectId: "project-a", runId: "run-a", nodeInstanceId: "node-a",
      candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6,
      cancellationEpoch: 0, deadlineAtMs: 4_102_444_800_000, nextOperationIndex: 0,
    },
    runner,
    input: { kind: "inline", value: { prompt: "one" } },
    grants: [], resources: {}, tools: [],
    broker: { audience: "gateway", attemptToken: "ephemeral" },
  };
  return snapshotIntent(
    runnerRequest,
    { reservationId: "reservation-1", grantRevision: 4, allocationGeneration: 5, holderGeneration: 5, allocationToken: "allocation-1", hostId },
    { projectId: "project-a", reference: runner, trustRevision: 1, packageTrustDigest: launchDigest, releaseDigest: launchDigest, sourceDigest: launchDigest, artifactDigest: "a".repeat(64), imageDigest: launchDigest, manifestDigest: launchDigest, evidenceDigest: launchDigest, buildIdentity: "build-1", receiptDigest: launchDigest },
    ...(devices === undefined ? [] : [devices]),
  );
}
