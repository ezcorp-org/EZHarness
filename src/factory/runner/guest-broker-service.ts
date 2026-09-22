import type { FactoryPrivateRequest, FactoryPrivateResponse } from "../private-https";
import { verifyFactoryAttemptToken } from "../attempt-token";
import type { FactoryGuestMaterialFrameBroker } from "./guest-material-broker";

/**
 * The product-side route a runner host forwards a guest's staging frame to.
 *
 * C02 puts the container runner and the host signing key in one process and
 * every tenant record in another, and a sandboxed guest runs on
 * `--network=none`, so a guest cannot reach the execution gateway itself and
 * the host cannot answer for it: the host holds no tenant credential, no
 * database, and no material service. The frame therefore travels back the way
 * the launch came, over the same mutual TLS, and is answered here.
 *
 * **Two independent facts authorize one frame, and neither is the frame.** The
 * mutual-TLS peer identity says which host may drive attempts at all, exactly
 * as the launch and stop routes require. The attempt token says which attempt
 * the frame belongs to, and it is the guest's own short-lived credential minted
 * for that attempt: it carries the tenant, project, run, node instance,
 * candidate generation, every fence counter, and the deadline. Nothing in the
 * body names a scope, and nothing in the body is trusted to.
 *
 * The token is read from the body rather than the `Authorization` header
 * because the header already carries the host's service credential and both
 * facts are needed. It is never logged and never leaves this function.
 */

export const FACTORY_GUEST_BROKER_PATH = "/v1/guest/broker";

/** One staging frame plus its own base64 chunk, with room for the JSON envelope. */
export const FACTORY_GUEST_BROKER_MAX_BODY_BYTES = 128 * 1024;

export interface FactoryGuestBrokerServiceOptions {
  /** mTLS peer identities allowed to forward a guest frame. */
  readonly allowedPeers: readonly string[];
  readonly broker: FactoryGuestMaterialFrameBroker;
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
  const peers = new Set(options.allowedPeers);
  return async (request: FactoryPrivateRequest): Promise<FactoryPrivateResponse> => {
    if (request.path !== FACTORY_GUEST_BROKER_PATH) return json(404, { error: "not_found" });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!peers.has(request.peerIdentity)) return json(403, { error: "forbidden" });
    if (request.body.byteLength > FACTORY_GUEST_BROKER_MAX_BODY_BYTES) return json(413, { error: "request_too_large" });

    let body: { attemptToken?: unknown; payload?: unknown };
    try { body = JSON.parse(request.body.toString("utf8")) as { attemptToken?: unknown; payload?: unknown }; }
    catch { return json(400, { error: "invalid_request" }); }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.attemptToken !== "string" || !Object.hasOwn(body, "payload")) return json(400, { error: "invalid_request" });

    const authority = await verifyFactoryAttemptToken(body.attemptToken, options.jwtSecret, options.installationId);
    // An unverifiable token is never an attempt. The frame is refused here
    // rather than reaching a broker that would have to invent a scope for it.
    if (!authority) return json(401, { error: "unauthorized" });

    return json(200, await options.broker.frame(authority, body.payload));
  };
}
