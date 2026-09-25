/**
 * The guest-broker route, bound by the product process.
 *
 * A sandboxed guest runs on `--network=none`, so its reverse frame is its only
 * byte path. The runner host carries each staging frame here, because only this
 * process holds the tenant database and the material service. The route adds no
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
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import type { FactoryApplication } from "./application";
import { loadFactoryAttemptTokenSecret } from "./attempt-composition";
import { readPrivateText } from "./private-files";
import { factoryServiceTokenVerifier } from "./private-service-composition";
import { readFactoryAttemptLaunchFacts } from "./runner/attempt-runtime";
import { startFactoryPrivateHttps } from "./private-https";
import { FACTORY_GUEST_BROKER_MAX_BODY_BYTES } from "./runner/guest-broker-contract";
import { createFactoryGuestBrokerRouteHandler } from "./runner/guest-broker-service";
import { createFactoryGuestMaterialFrameBroker, createFactoryGuestMaterialServices } from "./runner/guest-material-broker";
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
    const broker = createFactoryGuestMaterialFrameBroker({
      services: createFactoryGuestMaterialServices({
        database: options.database,
        artifacts: options.application.artifacts,
        blobs: options.blobs,
        journal: options.application.journal,
      }),
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
