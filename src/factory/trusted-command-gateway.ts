import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";

/** The only command reference accepted from the Temporal mTLS gateway. */
export interface TrustedFactoryCommandReference {
  tenantId: string;
  projectId: string;
  logicalRunId: string;
  interpreterId: string;
  commandId: string;
}

/** Derived from the verified client certificate and service bearer token. */
export interface TrustedFactoryServiceIdentity {
  subject: string;
  tenantId: string;
}

/**
 * Product code owns this transaction. It loads the immutable command by ID,
 * compares its reference, checks service authority, constructs the complete
 * C02 request, and admits it through the same journal transaction.
 */
export interface TrustedFactoryCommandPolicy {
  admit(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<FactoryRunnerRequest>;
}

export interface TrustedFactoryRunner {
  run(request: FactoryRunnerRequest): Promise<FactoryRunnerResult>;
}

/** Keeps untrusted transport bodies out of runner authority construction. */
export class TrustedFactoryCommandGateway {
  constructor(private readonly policy: TrustedFactoryCommandPolicy, private readonly runner: TrustedFactoryRunner) {}

  async dispatch(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<FactoryRunnerResult> {
    if (!service.subject || !service.tenantId || !reference.commandId || !reference.tenantId || service.tenantId !== reference.tenantId || !reference.projectId || !reference.logicalRunId || !reference.interpreterId) throw new Error("Trusted factory command reference is invalid.");
    // `admit` commits before this external execution begins. A replay reuses
    // the same immutable request and durable journal identity.
    return this.runner.run(await this.policy.admit(service, reference));
  }
}
