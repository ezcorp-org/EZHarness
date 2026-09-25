import type { FactoryPrivateRequest, FactoryPrivateResponse } from "../private-https";
import { verifyFactoryAttemptToken } from "../attempt-token";
import type { FactoryAttemptAuthority } from "../executions";
import { verifyPoolToken, type PoolTokenVerifierOptions } from "../pool/service-token";
import { FACTORY_GUEST_BROKER_MAX_BODY_BYTES, FACTORY_GUEST_BROKER_PATH, FACTORY_GUEST_BROKER_SCOPE } from "./guest-broker-contract";
import type { FactoryGuestMaterialFrameBroker } from "./guest-material-broker";
import { isFactoryGuestModelPayload } from "./guest-model-broker";
import type { FactoryGuestModelFrameBroker } from "./guest-model-route";

/**
 * The product-side route a runner host forwards a guest's staging frame or
 * model request to.
 *
 * C02 puts the container runner and the host signing key in one process and
 * every tenant record in another, and a sandboxed guest runs on
 * `--network=none`, so a guest cannot reach the execution gateway itself and
 * the host cannot answer for it: the host holds no tenant credential, no
 * database, no material service, and no provider. The frame therefore travels back the way
 * the launch came, over the same mutual TLS, and is answered here.
 *
 * **The host and the attempt are each proved, and neither by the frame.** The
 * host proves itself twice, as the private service's callers do: its mutual-TLS
 * peer identity must be a declared host, and its bearer token must verify, name
 * that same identity, and carry `factory:guest-broker`. The attempt token says
 * which attempt the frame belongs to; it is the guest's own short-lived
 * credential, carrying the tenant, project, run, node instance, candidate
 * generation, every fence counter, and the deadline. Then the two are bound:
 * the host must be the one that holds the attempt's lease, exactly as the
 * launch route refuses an intent for another host. A declared host forwarding
 * for an attempt it does not hold is refused `forbidden_host`.
 *
 * The attempt token is read from the body because the `Authorization` header
 * carries the host's own token. It is never logged. The staging half never
 * sees it; the model half carries it on the attempt's in-memory runner request
 * to the provider broker, exactly as an in-process runner would, and no
 * journal row, receipt, or log line records it.
 */

export interface FactoryGuestBrokerServiceOptions {
  /** Each host that may forward a guest frame: its mTLS peer identity, and the host id it runs as. */
  readonly hosts: Readonly<Record<string, string>>;
  /** The issuer, audience, and public keys a host's bearer token verifies against. Read per request. */
  tokens(): Promise<PoolTokenVerifierOptions>;
  /** The host that holds this attempt's lease, or undefined when no launch records one. */
  leaseHost(authority: FactoryAttemptAuthority): Promise<string | undefined>;
  readonly broker: FactoryGuestMaterialFrameBroker;
  /**
   * The model half. Always present: an installation that pins no provider
   * composes one whose every call fails by name, so a model request is never
   * handed to the staging broker, which would call it an invalid frame.
   */
  readonly model: FactoryGuestModelFrameBroker;
  readonly jwtSecret: string;
  readonly installationId: string;
}

function json(status: number, value: unknown): FactoryPrivateResponse {
  return { status, body: Buffer.from(JSON.stringify(value)) };
}

/**
 * The authenticated guest-broker route.
 *
 * Every failure before the broker is an HTTP status, and every outcome from the
 * broker is HTTP 200 carrying a typed response — including a refusal. A refusal
 * is an answer the guest must be able to read and act on; turning it into a
 * transport error would make "your attempt was superseded" indistinguishable
 * from "the product process is down".
 */
export function createFactoryGuestBrokerRouteHandler(options: FactoryGuestBrokerServiceOptions): (request: FactoryPrivateRequest) => Promise<FactoryPrivateResponse> {
  const hosts = new Map(Object.entries(options.hosts));
  return async (request: FactoryPrivateRequest): Promise<FactoryPrivateResponse> => {
    if (request.path !== FACTORY_GUEST_BROKER_PATH) return json(404, { error: "not_found" });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const hostId = hosts.get(request.peerIdentity);
    if (hostId === undefined) return json(403, { error: "forbidden" });
    if (!await hostTokenVerifies(request, options)) return json(401, { error: "unauthorized" });
    if (request.body.byteLength > FACTORY_GUEST_BROKER_MAX_BODY_BYTES) return json(413, { error: "request_too_large" });

    let body: { attemptToken?: unknown; payload?: unknown };
    try { body = JSON.parse(request.body.toString("utf8")) as { attemptToken?: unknown; payload?: unknown }; }
    catch { return json(400, { error: "invalid_request" }); }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.attemptToken !== "string" || !Object.hasOwn(body, "payload")) return json(400, { error: "invalid_request" });

    const authority = await verifyFactoryAttemptToken(body.attemptToken, options.jwtSecret, options.installationId);
    // An unverifiable token is never an attempt. The frame is refused here
    // rather than reaching a broker that would have to invent a scope for it.
    if (!authority) return json(401, { error: "unauthorized" });
    // A host forwards only for the attempts its own lease holds.
    if (await options.leaseHost(authority) !== hostId) return json(403, { error: "forbidden_host" });

    if (isFactoryGuestModelPayload(body.payload)) return json(200, await options.model.frame(authority, body.attemptToken, body.payload));
    return json(200, await options.broker.frame(authority, body.payload));
  };
}

/** The host's bearer token verifies, names the peer that sent it, and carries the route's scope. */
async function hostTokenVerifies(request: FactoryPrivateRequest, options: FactoryGuestBrokerServiceOptions): Promise<boolean> {
  const bearer = request.headers.authorization;
  if (!bearer?.startsWith("Bearer ")) return false;
  try {
    const claims = verifyPoolToken(bearer.slice(7), await options.tokens());
    return claims.sub === request.peerIdentity && claims.scope.includes(FACTORY_GUEST_BROKER_SCOPE);
  } catch {
    return false;
  }
}
