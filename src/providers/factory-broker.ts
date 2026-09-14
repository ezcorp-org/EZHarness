import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { FactoryBroker, FactoryBrokerRequest } from "../runtime/factory-execution";
import { tryGetCredential, type ProviderCredential } from "./credentials";
import { isKnownCatalogModel, resolveModelObject } from "./registry";

/**
 * The host side of the factory provider transport.
 *
 * A factory runner never holds a provider credential. It sends a {@link FactoryBrokerRequest}
 * carrying its attempt token and a pinned model, and this module — inside the credential
 * subsystem, which is where every credential lookup belongs — resolves the deployment's own
 * configured credential and makes the call. The credential is read once per request and is never
 * returned, logged, journaled, or written into a receipt.
 *
 * The other half of its job is to refuse. C10 is explicit that an unavailable model or a missing
 * credential is a readiness failure requiring a reviewed contract revision, never a quiet
 * substitution: no other provider, no nearer model, no canned answer. {@link factoryProviderReadiness}
 * states that verdict before a test runs, and {@link createFactoryProviderBroker} enforces it again
 * at call time, because a deployment can lose a credential between the two.
 */

export const FACTORY_PROVIDER_READINESS_SCHEMA_VERSION = "factory.provider-readiness.v1" as const;

export type FactoryProviderReadinessFailure =
  | "provider_not_configured"
  | "model_not_available"
  | "model_pin_mismatch";

export interface FactoryProviderPin {
  readonly provider: string;
  readonly model: string;
}

export interface FactoryProviderReadiness {
  readonly schemaVersion: typeof FACTORY_PROVIDER_READINESS_SCHEMA_VERSION;
  readonly provider: string;
  readonly model: string;
  readonly ready: boolean;
  /** How the deployment authenticates, never the value. `null` when nothing resolved. */
  readonly credentialKind: ProviderCredential["type"] | null;
  /** Named reasons, in a fixed order, so a readiness record is comparable across runs. */
  readonly failures: readonly FactoryProviderReadinessFailure[];
  readonly checkedAtMs: number;
}

export class FactoryProviderReadinessError extends Error {
  constructor(readonly readiness: FactoryProviderReadiness) {
    super(`factory_provider_not_ready: ${readiness.provider}/${readiness.model} (${readiness.failures.join(", ")})`);
    this.name = "FactoryProviderReadinessError";
  }
}

export interface FactoryProviderReadinessOptions {
  readonly resolveCredential?: (provider: string) => Promise<ProviderCredential | null>;
  readonly isAvailableModel?: (provider: string, model: string) => boolean;
  readonly now?: () => number;
}

/**
 * Whether this deployment can actually run the pinned model, resolved by reference.
 *
 * "By reference" is the whole point: nothing here accepts a credential as an argument or reads one
 * from a test fixture. It asks the application's own configuration, and reports what it found.
 */
export async function factoryProviderReadiness(
  pin: FactoryProviderPin,
  options: FactoryProviderReadinessOptions = {},
): Promise<FactoryProviderReadiness> {
  const now = options.now ?? Date.now;
  const available = options.isAvailableModel ?? isKnownCatalogModel;
  const resolve = options.resolveCredential ?? tryGetCredential;
  const failures: FactoryProviderReadinessFailure[] = [];
  if (!available(pin.provider, pin.model)) failures.push("model_not_available");
  const credential = await resolve(pin.provider);
  if (credential === null) failures.push("provider_not_configured");
  return {
    schemaVersion: FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
    provider: pin.provider,
    model: pin.model,
    ready: failures.length === 0,
    credentialKind: credential?.type ?? null,
    failures,
    checkedAtMs: now(),
  };
}

/** The readiness record with nothing secret in it, for an evidence file. */
export function factoryProviderReadinessRecord(readiness: FactoryProviderReadiness): Record<string, unknown> {
  return {
    schemaVersion: readiness.schemaVersion,
    provider: readiness.provider,
    model: readiness.model,
    ready: readiness.ready,
    credentialKind: readiness.credentialKind,
    failures: [...readiness.failures],
    checkedAt: new Date(readiness.checkedAtMs).toISOString(),
  };
}

export interface FactoryProviderBrokerOptions extends FactoryProviderReadinessOptions {
  readonly pin: FactoryProviderPin;
  /** Injected only by tests that must drive the stream without a network. */
  readonly stream?: typeof streamSimple;
  readonly resolveModel?: (provider: string, model: string) => Model<Api>;
}

/**
 * A {@link FactoryBroker} that calls the real provider with the deployment's own credential.
 *
 * The model the runner asked for is checked against the pin rather than trusted. A runner that
 * names a cheaper or a retired model would otherwise silently change what the evidence describes,
 * and the acceptance record would name a model that never ran.
 */
export function createFactoryProviderBroker(options: FactoryProviderBrokerOptions): FactoryBroker {
  const resolveCredential = options.resolveCredential ?? tryGetCredential;
  const resolveModel = options.resolveModel ?? ((provider, model) => resolveModelObject(provider, model) as Model<Api>);
  const send = options.stream ?? streamSimple;
  return {
    async stream(request: FactoryBrokerRequest): Promise<AssistantMessageEventStream> {
      if (request.model.provider !== options.pin.provider || request.model.id !== options.pin.model) {
        throw new FactoryProviderReadinessError({
          schemaVersion: FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
          provider: request.model.provider,
          model: request.model.id,
          ready: false,
          credentialKind: null,
          failures: ["model_pin_mismatch"],
          checkedAtMs: Date.now(),
        });
      }
      const readiness = await factoryProviderReadiness(options.pin, options);
      if (!readiness.ready) throw new FactoryProviderReadinessError(readiness);
      const credential = await resolveCredential(options.pin.provider);
      // `readiness` already resolved one; a credential that vanished in between is a failure, not
      // a reason to proceed without authentication.
      if (credential === null) throw new FactoryProviderReadinessError({ ...readiness, ready: false, credentialKind: null, failures: ["provider_not_configured"] });
      return send(resolveModel(options.pin.provider, options.pin.model), request.context, { ...request.options, apiKey: credential.token });
    },
  };
}
