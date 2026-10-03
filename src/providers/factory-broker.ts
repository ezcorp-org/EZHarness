import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { FactoryBroker, FactoryBrokerRequest } from "../runtime/factory-execution";
import { authCallOptions, tryGetCredential, type ProviderCredential } from "./credentials";
import { credentialServesModel, resolveModelForCredential } from "./registry";
import { resolvePinnedModel, type PinnedModelResolution } from "./router";

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
  readonly isAvailableModel?: (provider: string, model: string) => boolean | Promise<boolean>;
  readonly now?: () => number;
}

/**
 * Whether the deployment can serve this pin without inventing a model.
 *
 * A catalog model is servable, and so is one the operator registered with an
 * endpoint (`provider:customModels`, the "add a local provider" path a host's
 * Ollama takes), one a refresh discovered, and the test-surface mock. The one
 * answer that is NOT servable is the synthesized stand-in, which would send the
 * call to a default endpoint that never heard of the model.
 */
export async function isFactoryServableModel(provider: string, model: string): Promise<boolean> {
  return isServableResolution(await resolvePinnedModel(provider, model));
}

/** The same verdict for a resolution already in hand, so a caller never resolves twice. */
export function isServableResolution(resolution: PinnedModelResolution): boolean {
  return resolution.source !== "stand-in";
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
  const available = options.isAvailableModel ?? isFactoryServableModel;
  const resolve = options.resolveCredential ?? tryGetCredential;
  const failures: FactoryProviderReadinessFailure[] = [];
  const credential = await resolve(pin.provider);
  // A model the catalog serves can still be one this credential cannot run: a ChatGPT-plan login
  // runs only subscription-eligible ids. That is the same named failure, not a call left to 401.
  const servable = await available(pin.provider, pin.model) && (credential === null || credentialServesModel(pin.provider, pin.model, credential.type));
  if (!servable) failures.push("model_not_available");
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

/** A request for a model other than the pin: refused by name, never served by the pin instead. */
export function factoryModelPinMismatch(provider: string, model: string): FactoryProviderReadinessError {
  return new FactoryProviderReadinessError({
    schemaVersion: FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
    provider,
    model,
    ready: false,
    credentialKind: null,
    failures: ["model_pin_mismatch"],
    checkedAtMs: Date.now(),
  });
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
  readonly resolveModel?: (provider: string, model: string) => Model<Api> | Promise<Model<Api>>;
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
  // The same resolution a pinned conversation gets, so a registered local model
  // is called at its registered endpoint rather than at a default one.
  const resolveModel = options.resolveModel ?? (async (provider: string, model: string) => (await resolvePinnedModel(provider, model)).piModel as Model<Api>);
  const send = options.stream ?? streamSimple;
  return {
    async stream(request: FactoryBrokerRequest): Promise<AssistantMessageEventStream> {
      if (request.model.provider !== options.pin.provider || request.model.id !== options.pin.model) {
        throw factoryModelPinMismatch(request.model.provider, request.model.id);
      }
      const readiness = await factoryProviderReadiness(options.pin, options);
      if (!readiness.ready) throw new FactoryProviderReadinessError(readiness);
      const credential = await resolveCredential(options.pin.provider);
      // `readiness` already resolved one; a credential that vanished in between is a failure, not
      // a reason to proceed without authentication.
      if (credential === null) throw new FactoryProviderReadinessError({ ...readiness, ready: false, credentialKind: null, failures: ["provider_not_configured"] });
      // The credential decides the wire: an OAuth login is sent to the subscription endpoint, the
      // same swap every other model call in the application makes (providers/llm.ts).
      const model = resolveModelForCredential(await resolveModel(options.pin.provider, options.pin.model), options.pin.provider, credential.type);
      return send(model, request.context, { ...request.options, ...authCallOptions(credential.token) });
    },
  };
}
