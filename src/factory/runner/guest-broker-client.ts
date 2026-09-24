import { createGatewayTransport, type GatewayTransportOptions } from "@ezcorp/factory-transport";
import { isFactoryGuestMaterialFrame, validateFactoryGuestMaterialResponse, validateFactoryGuestModelResponse, type FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { FACTORY_GUEST_BROKER_MAX_BODY_BYTES, FACTORY_GUEST_BROKER_PATH } from "./guest-broker-service";
import { FactoryGuestFrameError } from "./guest-frames";
import { isFactoryGuestModelPayload, type FactoryGuestBroker } from "./guest-model-broker";

/**
 * The host's half of the guest broker, and the route W09b left undefined.
 *
 * A host supervisor holds a container runner and its own host identity, and no
 * tenant credential, no database, no material service, and no provider. So the
 * only correct answer it can give a guest's staging frame or model request is
 * to carry it, unchanged, to the product process that holds all four. This forwards it under the attempt's
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

/**
 * How long the host waits for the product to answer a model request.
 *
 * A staging frame is answered in milliseconds and keeps the transport's
 * ordinary timeout. A model request is answered only after the provider
 * finishes, which for a real model can take far longer, so it gets the
 * transport's own ceiling. The attempt's signed deadline still bounds the
 * guest, and the product settles the call on the journal before it answers.
 */
export const FACTORY_GUEST_MODEL_REQUEST_TIMEOUT_MS = 300_000;

export interface FactoryGuestBrokerClientOptions extends GatewayTransportOptions {
  /** Overrides {@link FACTORY_GUEST_MODEL_REQUEST_TIMEOUT_MS}. */
  readonly modelRequestTimeoutMs?: number;
  /**
   * Where a reverse payload that is neither a staging frame nor a model request
   * goes. The product route answers exactly those two, so anything else keeps
   * the answer the composition gives it rather than being forwarded to a route
   * that would not know what to do with it.
   */
  readonly delegate?: FactoryGuestBroker;
}

/** The two payloads the product route answers, each with the response contract it is checked against. */
function responseContract(payload: unknown): { readonly name: string; readonly model: boolean; readonly valid: (answer: unknown) => boolean } | undefined {
  if (isFactoryGuestMaterialFrame(payload)) return { name: "staging frame", model: false, valid: (answer) => validateFactoryGuestMaterialResponse(answer).ok };
  if (isFactoryGuestModelPayload(payload)) return { name: "model request", model: true, valid: (answer) => validateFactoryGuestModelResponse(answer).ok };
  return undefined;
}

function invalid(detail: string): never {
  throw new FactoryGuestFrameError("frame_invalid", detail);
}

export async function createFactoryGuestBrokerClient(options: FactoryGuestBrokerClientOptions): Promise<FactoryGuestBroker> {
  const transport = await createGatewayTransport(options);
  const modelTransport = await createGatewayTransport({ ...options, requestTimeoutMs: options.modelRequestTimeoutMs ?? FACTORY_GUEST_MODEL_REQUEST_TIMEOUT_MS });
  return Object.freeze({
    async invoke(request: FactoryRunnerRequest, payload: unknown): Promise<unknown> {
      const contract = responseContract(payload);
      if (contract === undefined) {
        if (options.delegate) return options.delegate.invoke(request, payload);
        invalid("Factory guest reverse payload is not a staging frame or a model request and this host has no other route.");
      }
      // The guest's own attempt token, exactly as the launch intent carries it.
      // The host mints nothing and substitutes nothing.
      const response = await (contract.model ? modelTransport : transport).request("POST", FACTORY_GUEST_BROKER_PATH, { attemptToken: request.broker.attemptToken, payload }, FACTORY_GUEST_BROKER_MAX_BODY_BYTES);
      let answer: unknown;
      try { answer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
      catch { invalid(`The product process answered a ${contract.name} with something that is not JSON.`); }
      // Validated on the way back as well as on the way out: a guest must never
      // receive an answer the shared contract would refuse, because it has no
      // second hop on which to discover that.
      if (!contract.valid(answer)) invalid(`The product process answered a ${contract.name} with a value its response contract refuses.`);
      return answer;
    },
  });
}
