import type { RunnerExecution } from "@ezcorp/extension-contract";
import { requestSensitiveProviderResult } from "@ezcorp/extension-runner/sensitive-host";

export interface ProviderCredentialIdentity {
  providerId: string;
  connectionId: string;
}

export interface ProviderCredentialScope {
  extensionId: string;
  userId: string;
  conversationId: string | null;
}

export class ProviderSecretTransportError extends Error {
  constructor() {
    super("Provider credential lookup failed.");
    this.name = "ProviderSecretTransportError";
  }
}

function boundedIdentity(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new ProviderSecretTransportError();
  return value;
}

/**
 * Internal broker transport. It has no ordinary RunnerExecution request method,
 * retains no result cache, and destroys the mutable byte buffer after decoding.
 */
export class ProviderSecretTransport {
  private readonly providerId: string;
  private readonly connectionId: string;
  constructor(private readonly execution: RunnerExecution, identity: ProviderCredentialIdentity) {
    this.providerId = boundedIdentity(identity.providerId);
    this.connectionId = boundedIdentity(identity.connectionId);
  }

  async resolve(name: string, scope: ProviderCredentialScope): Promise<string | null> {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await requestSensitiveProviderResult(this.execution, {
        providerId: this.providerId,
        connectionId: this.connectionId,
        name,
        scope: { ...scope },
      });
      if (bytes === null) return null;
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!value || /[\r\n]/.test(value)) throw new ProviderSecretTransportError();
      return value;
    } catch {
      throw new ProviderSecretTransportError();
    } finally {
      bytes?.fill(0);
    }
  }
}
