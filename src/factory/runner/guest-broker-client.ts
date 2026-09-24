import { createGatewayTransport, type GatewayTransportOptions } from "@ezcorp/factory-transport";
import { isFactoryGuestMaterialFrame, validateFactoryGuestMaterialResponse, type FactoryGuestMaterialResponse, type FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { FACTORY_GUEST_BROKER_MAX_BODY_BYTES, FACTORY_GUEST_BROKER_PATH } from "./guest-broker-contract";
import { FactoryGuestFrameError } from "./guest-frames";
import type { FactoryGuestBroker } from "./guest-model-broker";

/**
 * The host's half of the guest broker, and the route W09b left undefined.
 *
 * A host supervisor holds a container runner and its own host identity, and no
 * tenant credential, no database, and no material service. So the only correct
 * answer it can give a guest's staging frame is to carry it, unchanged, to the
 * product process that holds all three. This forwards it under the attempt's
 * own short-lived token — the credential the guest already runs under — over
 * the same mutual TLS the launch arrived on.
 *
 * It adds nothing and decides nothing. A refusal comes back as the typed
 * refusal the product issued, so a guest is told `stale_epoch` or `sealed`
 * rather than being handed a transport failure it cannot distinguish from a
 * dead product process. The exception is a transport fault, which is exactly
 * what it looks like and is raised.
 *
 * `factoryHostBrokerUnavailable` stays the default. A supervisor whose
 * configuration names `services.guestBroker` builds this client; one that does
 * not still refuses by name.
 */

export interface FactoryGuestBrokerClientOptions extends GatewayTransportOptions {
  /**
   * Where a reverse payload that is not a staging frame goes. A model request
   * is one: its provider lives in the product process too, but nothing defines
   * that route yet, so it keeps whatever answer the composition gives it rather
   * than being forwarded to a route that would not know what to do with it.
   */
  readonly delegate?: FactoryGuestBroker;
}

function invalid(detail: string): never {
  throw new FactoryGuestFrameError("frame_invalid", detail);
}

export async function createFactoryGuestBrokerClient(options: FactoryGuestBrokerClientOptions): Promise<FactoryGuestBroker> {
  const transport = await createGatewayTransport(options);
  return Object.freeze({
    async invoke(request: FactoryRunnerRequest, payload: unknown): Promise<unknown> {
      if (!isFactoryGuestMaterialFrame(payload)) {
        if (options.delegate) return options.delegate.invoke(request, payload);
        invalid("Factory guest reverse payload is not a staging frame and this host has no other route.");
      }
      // The guest's own attempt token, exactly as the launch intent carries it.
      // The host mints nothing and substitutes nothing.
      const response = await transport.request("POST", FACTORY_GUEST_BROKER_PATH, { attemptToken: request.broker.attemptToken, payload }, FACTORY_GUEST_BROKER_MAX_BODY_BYTES);
      let answer: unknown;
      try { answer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
      catch { invalid("The product process answered a staging frame with something that is not JSON."); }
      // Validated on the way back as well as on the way out: a guest must never
      // receive a staging answer the shared contract would refuse, because it
      // has no second hop on which to discover that.
      if (!validateFactoryGuestMaterialResponse(answer).ok) invalid("The product process answered a staging frame with a value that is not a staging response.");
      return answer as FactoryGuestMaterialResponse;
    },
  });
}
