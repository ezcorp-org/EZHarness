import type { FactoryReleaseApprovalDecisionBody, FactoryReleaseContractBody, FactoryReleasePolicyBody, FactoryReleasePrepareBody, FactoryReleaseReconciliationBody } from "@ezcorp/factory-sdk";
import type { FactoryAssurance } from "./assurance";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { FactoryReleaseError, type FactoryReleaseOperation, type FactoryReleaseProvider, type FactoryReleases } from "./releases";

export interface FactoryReleaseProviderResolver {
  resolve(operation: FactoryReleaseOperation): FactoryReleaseProvider | Promise<FactoryReleaseProvider>;
}

/** Public application seam over the durable stores. Provider selection always uses the persisted destination. */
export class FactoryReleaseApplication {
  private readonly providers: FactoryReleaseProviderResolver;
  constructor(
    readonly tenantId: string,
    private readonly grants: FactoryGrants,
    private readonly assurance: FactoryAssurance,
    private readonly releases: FactoryReleases,
    providers: FactoryReleaseProviderResolver,
  ) {
    if (grants.tenantId !== tenantId || assurance.tenantId !== tenantId || releases.tenantId !== tenantId) throw new FactoryReleaseError("factory_release_scope");
    this.providers = Object.freeze({ resolve: providers.resolve.bind(providers) });
  }

  async putContract(actor: FactoryPrincipal, projectId: string, contractId: string, body: FactoryReleaseContractBody, expectedRevision: number, idempotencyKey: string) {
    await this.assurance.approveContract(actor, { projectId, contractId, revision: expectedRevision + 1, ...body }, idempotencyKey);
    return { contractId, revision: expectedRevision + 1, ...body };
  }

  prepare(actor: FactoryPrincipal, projectId: string, body: FactoryReleasePrepareBody, idempotencyKey: string) {
    return this.releases.prepare(actor, { projectId, ...body }, idempotencyKey);
  }

  async inspect(actor: FactoryPrincipal, projectId: string, operationId: string) {
    await this.grants.authorize(actor, projectId, "factory.release");
    return this.releases.inspect(projectId, operationId);
  }

  async requestApproval(actor: FactoryPrincipal, projectId: string, operationId: string, body: { readonly expiresAtMs: number }, expectedGeneration: number, idempotencyKey: string) {
    const result = await this.releases.requestApproval(actor, projectId, operationId, body.expiresAtMs, expectedGeneration, idempotencyKey);
    return { operationId, expiresAtMs: body.expiresAtMs, status: "pending" as const, ...result };
  }

  async decideApproval(actor: FactoryPrincipal, projectId: string, approvalId: string, body: FactoryReleaseApprovalDecisionBody, expectedRevision: number, idempotencyKey: string) {
    if (expectedRevision !== 0) throw new FactoryReleaseError("factory_release_precondition");
    await this.assurance.decideApproval(actor, projectId, approvalId, body.contextDigest, body.decision === "approved", idempotencyKey);
    return { approvalId, contextDigest: body.contextDigest, status: body.decision };
  }

  async putPolicy(actor: FactoryPrincipal, projectId: string, policyId: string, body: FactoryReleasePolicyBody, expectedRevision: number, idempotencyKey: string) {
    if (expectedRevision !== 0) throw new FactoryReleaseError("factory_release_precondition");
    await this.releases.createPolicy(actor, { projectId, policyId, principal: body.principalKind === "user" ? { kind: "user", id: body.principalId, authentication: "session" } : { kind: "service", id: body.principalId, authentication: "service" }, action: body.action, destinationProvider: body.destinationProvider, destinationAccount: body.destinationAccount, destinationPrefix: body.destinationPrefix, contractDigest: body.contractDigest, revision: 1, maxOperations: body.maxOperations, maxSpendMicros: body.maxSpendMicros, expiresAtMs: body.expiresAtMs }, idempotencyKey);
    return { policyId, revision: 1 as const, revoked: false as const, ...body };
  }

  async deletePolicy(actor: FactoryPrincipal, projectId: string, policyId: string, expectedRevision: number, idempotencyKey: string) {
    await this.releases.revokePolicy(actor, projectId, policyId, expectedRevision, idempotencyKey);
    return { policyId, revision: expectedRevision + 1, revoked: true as const };
  }

  async reconcile(actor: FactoryPrincipal, projectId: string, operationId: string, body: FactoryReleaseReconciliationBody, expectedGeneration: number, idempotencyKey: string) {
    if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryReleaseError("factory_release_human_required");
    const operation = await this.releases.inspect(projectId, operationId);
    if (!operation) throw new FactoryReleaseError("factory_release_not_found");
    const provider = await this.providers.resolve(operation);
    return this.releases.reconcile(actor, { projectId, operationId, ...body }, expectedGeneration, provider, idempotencyKey);
  }
}
