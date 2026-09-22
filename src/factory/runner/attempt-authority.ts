import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { FactoryAttemptAuthority } from "../executions";

/**
 * The durable attempt authority a runner request stands for.
 *
 * Three places derived this independently — the guest model journal, the native
 * entrypoint's journal binding, and now the material broker — and they have to
 * agree exactly, because the journal matches on every field at once and a
 * single disagreement reads as a stale attempt rather than as a bug.
 *
 * The request digest is taken over the token-free canonical identity
 * (`factoryRunnerRequestDigest`), so a token reissued on recovery still names
 * the same durable attempt. That is the whole reason this cannot be a spread of
 * `request.authority`: the signed transport token is deliberately absent from
 * the identity, and `deadlineAtMs` is a number on the wire and a `Date` in the
 * database.
 */
export function factoryRunnerRequestAuthority(request: FactoryRunnerRequest): FactoryAttemptAuthority {
  const authority = request.authority;
  return {
    attemptId: authority.attemptId,
    tenantId: authority.tenantId,
    projectId: authority.projectId,
    runId: authority.runId,
    nodeInstanceId: authority.nodeInstanceId,
    candidateGeneration: authority.candidateGeneration,
    attemptNumber: authority.attemptNumber,
    grantRevision: authority.grantRevision,
    reservationGeneration: authority.reservationGeneration,
    executionEpoch: authority.executionEpoch,
    cancellationEpoch: authority.cancellationEpoch,
    requestDigest: factoryRunnerRequestDigest(request),
    deadlineAt: new Date(authority.deadlineAtMs),
  };
}
