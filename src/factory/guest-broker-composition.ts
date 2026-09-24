/**
 * The guest-broker route, bound by the product process.
 *
 * A sandboxed guest runs on `--network=none`, so its reverse frame is its only
 * byte path. The runner host carries each staging frame and each model request
 * here, because only this process holds the tenant database, the material
 * service, and the installation's model provider. The route adds no
 * authority: the mutual-TLS peer must be a declared HOST identity whose bearer
 * token verifies, the attempt token in the body must verify with the same
 * secret the dispatcher signs with, and the host must be the one whose lease
 * the attempt's launch record names. Every scope field comes from the verified
 * attempt token.
 *
 * The startup document declares the route in `guestBroker`. Without it nothing
 * is bound, and readiness names `factory_guest_broker_unconfigured`, so an
 * operator can see why a staging guest is refused. A route that is declared but
 * cannot bind is reported under its own role and named in readiness too, and it
 * never stops the rest of the factory from starting: a guest that stages
 * nothing does not need it.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TransactionalDb } from "../db/migrations/types";
import { createFactoryProviderBroker, factoryModelPinMismatch, isServableResolution, type FactoryProviderPin } from "../providers/factory-broker";
import { resolvePinnedModel } from "../providers/router";
import type { BlobStore } from "../extensions/v4/types";
import type { FactoryApplication } from "./application";
import { loadFactoryAttemptTokenSecret } from "./attempt-composition";
import { readPrivateText } from "./private-files";
import { factoryServiceTokenVerifier } from "./private-service-composition";
import { readFactoryAttemptLaunchFacts } from "./runner/attempt-runtime";
import { startFactoryPrivateHttps } from "./private-https";
import { FACTORY_GUEST_BROKER_MAX_BODY_BYTES, createFactoryGuestBrokerRouteHandler } from "./runner/guest-broker-service";
import { FactoryWorkspaceCheckpoints } from "./artifact-materials";
import { createFactoryGuestMaterialFrameBroker, createFactoryGuestMaterialServices } from "./runner/guest-material-broker";
import type { FactoryOneHopProvider } from "./runner/guest-model-broker";
import { createFactoryGuestModelFrameBroker } from "./runner/guest-model-route";
import { createFactoryOneHopProvider } from "./runner/provider-one-hop";
import type { FactoryStartedListener } from "./runtime-composition";
import { factoryProbeDetail } from "./service-probes";
import type { FactoryStartupConfig } from "./startup-config";

const MAX_TLS_MATERIAL_BYTES = 64 * 1024;

export const FACTORY_GUEST_BROKER_UNCONFIGURED = "factory_guest_broker_unconfigured";

/** What `/api/ready` says about the route. Names and codes only, never an endpoint. */
export type FactoryGuestBrokerReadiness =
  | { readonly state: "bound" }
  | { readonly state: "unconfigured" | "unavailable"; readonly code: string };

export interface FactoryGuestBrokerCompositionOptions {
  readonly database: TransactionalDb;
  readonly config: FactoryStartupConfig;
  readonly application: Pick<FactoryApplication, "artifacts" | "journal">;
  readonly blobs: BlobStore;
  readonly report: (role: string, error: unknown) => void;
  /** Replaces the installation's provider, so a test drives the route with no network. */
  readonly modelProvider?: (pin: FactoryProviderPin) => Promise<FactoryOneHopProvider>;
}

export const FACTORY_PROVIDER_NOT_CONFIGURED = "factory_provider_not_configured";

/**
 * The provider of an installation that pins none.
 *
 * Every call fails by name. The model broker settles the claimed operation
 * `failed` carrying this reason and refuses the guest `provider_unavailable`,
 * exactly as it does for a provider that is down, so a guest reads one rule:
 * `provider_unavailable` always names a journaled failed operation.
 */
export async function factoryUnpinnedModelProvider(): Promise<FactoryOneHopProvider> {
  throw new Error(`${FACTORY_PROVIDER_NOT_CONFIGURED}: this installation declares no modelProvider, so no guest may call a model.`);
}

/**
 * The installation's pinned provider, for one guest model call.
 *
 * The model is resolved once per call the way a pinned conversation resolves
 * it — catalog, discovered, or the operator's registered local endpoint — and
 * that one object is both what the provider broker sends to and what the
 * guest's turns are described with. The provider broker then re-checks
 * readiness and the credential before it sends, so a model or a credential
 * that disappeared since boot refuses by name.
 */
export async function factoryInstallationModelProvider(pin: FactoryProviderPin): Promise<FactoryOneHopProvider> {
  const resolved = await resolvePinnedModel(pin.provider, pin.model);
  const model = resolved.piModel as Model<Api>;
  const broker = createFactoryProviderBroker({ pin, resolveModel: () => model, isAvailableModel: () => isServableResolution(resolved) });
  return createFactoryOneHopProvider({
    broker,
    // The guest's request names the attempt's pin. It must be this
    // installation's model, or the call would be served by another model
    // while the journal named the first. The model route refuses it before
    // any claim; this refuses it again here, before the provider is reached.
    resolveModel: (asked) => {
      if (asked.provider !== pin.provider || asked.model !== pin.model) throw factoryModelPinMismatch(asked.provider, asked.model);
      return model;
    },
  });
}

export interface FactoryGuestBrokerComposition {
  readonly readiness: FactoryGuestBrokerReadiness;
  readonly listener?: FactoryStartedListener;
}

/** Bind the declared route, or say by name why there is none. */
export async function composeFactoryGuestBroker(options: FactoryGuestBrokerCompositionOptions): Promise<FactoryGuestBrokerComposition> {
  const { config } = options;
  const declared = config.guestBroker;
  // The parser refuses a declared route with no host launch secret, so the
  // second half of this guard only narrows the type.
  if (declared === undefined || config.hostLaunch === undefined) {
    return Object.freeze({ readiness: Object.freeze({ state: "unconfigured", code: FACTORY_GUEST_BROKER_UNCONFIGURED }) });
  }
  try {
    const [jwtSecret, ca, cert, key] = await Promise.all([
      loadFactoryAttemptTokenSecret(config.hostLaunch.attemptTokenSecretPath),
      readPrivateText(declared.tls.caPath, MAX_TLS_MATERIAL_BYTES),
      readPrivateText(declared.tls.certificatePath, MAX_TLS_MATERIAL_BYTES),
      readPrivateText(declared.tls.privateKeyPath, MAX_TLS_MATERIAL_BYTES),
    ]);
    const stores = {
      database: options.database,
      artifacts: options.application.artifacts,
      blobs: options.blobs,
      journal: options.application.journal,
    };
    const broker = createFactoryGuestMaterialFrameBroker({ services: createFactoryGuestMaterialServices(stores) });
    const pin = config.modelProvider;
    const provider = options.modelProvider ?? factoryInstallationModelProvider;
    const model = createFactoryGuestModelFrameBroker({
      journal: options.application.journal,
      workspace: new FactoryWorkspaceCheckpoints(stores),
      provider: pin === undefined ? factoryUnpinnedModelProvider : () => provider(pin),
      ...(pin === undefined ? {} : { installationPin: pin }),
    });
    const listener = startFactoryPrivateHttps({
      tls: { ca, cert, key },
      hostname: declared.hostname,
      port: declared.port,
      maxBodyBytes: FACTORY_GUEST_BROKER_MAX_BODY_BYTES,
      handle: createFactoryGuestBrokerRouteHandler({
        hosts: declared.hosts,
        tokens: factoryServiceTokenVerifier(declared.tokens),
        leaseHost: async (authority) => {
          const launch = await options.database.transaction(transaction => readFactoryAttemptLaunchFacts(transaction, authority.attemptId, authority.candidateGeneration, authority.attemptNumber));
          return launch?.tenantId === authority.tenantId ? launch.hostId : undefined;
        },
        broker,
        model,
        jwtSecret,
        installationId: config.installationId,
      }),
    });
    return Object.freeze({ readiness: Object.freeze({ state: "bound" }), listener });
  } catch (error) {
    options.report("guest-broker", error);
    return Object.freeze({ readiness: Object.freeze({ state: "unavailable", code: factoryProbeDetail(error) }) });
  }
}
