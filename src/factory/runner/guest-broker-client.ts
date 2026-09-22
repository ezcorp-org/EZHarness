import { readFile } from "node:fs/promises";
import { createGatewayTransport, type GatewayTlsSecretPaths, type GatewayTransportOptions } from "@ezcorp/factory-transport";
import { validateFactoryGuestMaterialResponse, type FactoryGuestMaterialResponse, type FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { FACTORY_GUEST_BROKER_MAX_BODY_BYTES, FACTORY_GUEST_BROKER_PATH } from "./guest-broker-service";
import { FactoryGuestFrameError } from "./guest-frames";
import type { FactoryGuestBroker } from "./guest-model-broker";
import { isFactoryGuestMaterialPayload } from "./guest-material-broker";

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
 * `factoryHostBrokerUnavailable` stays the default. A deployment that has this
 * route supplies this client; one that does not still refuses by name.
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
      if (!isFactoryGuestMaterialPayload(payload)) {
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

/**
 * One host's guest broker, declared in a file and resolved on first use.
 *
 * A host composes its services once, early, and the product process that
 * answers staging frames may not have published its endpoint yet — a
 * deployment starts them in either order, and a proof harness starts the
 * product side last. Resolving the declaration lazily lets the host bind its
 * listener immediately and still reach a route declared afterwards, instead of
 * making start order part of the contract.
 *
 * The declaration carries a base URL and four credential PATHS and never a
 * credential value, so nothing here reaches a process's arguments or a log. The
 * transport reloads those paths before every request, so a rotated certificate
 * needs no restart.
 *
 * A declaration that is absent, unreadable, or not a declaration is refused by
 * name on the call that needed it, which is the same answer
 * `factoryHostBrokerUnavailable` gives and for the same reason: a guest must be
 * able to tell "this host serves no broker" from "the broker said no".
 */
export function createFactoryDeclaredGuestBrokerClient(declarationPath: string, options: { readonly delegate?: FactoryGuestBroker } = {}): FactoryGuestBroker {
  let resolving: Promise<FactoryGuestBroker> | undefined;
  const resolve = async (): Promise<FactoryGuestBroker> => {
    const text = await readFile(declarationPath, "utf8").catch(() => undefined);
    if (text === undefined) invalid(`This host declares no guest broker at ${declarationPath}.`);
    let declared: unknown;
    try { declared = JSON.parse(text); }
    catch { invalid("This host's guest broker declaration is not JSON."); }
    const value = declared as { baseUrl?: unknown; serverName?: unknown; tls?: Record<string, unknown> };
    const paths = value.tls;
    if (typeof value.baseUrl !== "string" || !paths || typeof paths !== "object"
      || ["caPath", "certificatePath", "privateKeyPath", "serviceTokenPath"].some(key => typeof paths[key] !== "string")) {
      invalid("This host's guest broker declaration names no endpoint and credential paths.");
    }
    return createFactoryGuestBrokerClient({
      baseUrl: value.baseUrl,
      ...(typeof value.serverName === "string" ? { serverName: value.serverName } : {}),
      tls: paths as unknown as GatewayTlsSecretPaths,
      ...(options.delegate ? { delegate: options.delegate } : {}),
    });
  };
  return Object.freeze({
    async invoke(request: FactoryRunnerRequest, payload: unknown): Promise<unknown> {
      // A payload that is not a staging frame never needs the route, so it
      // reaches the delegate without reading a declaration it does not use.
      if (!isFactoryGuestMaterialPayload(payload) && options.delegate) return options.delegate.invoke(request, payload);
      // A failed resolution is not cached: a declaration written after this
      // host bound must still take effect, and a transport built from a
      // half-written file must not become this host's permanent answer.
      if (resolving === undefined) resolving = resolve().catch((error: unknown) => { resolving = undefined; throw error; });
      return (await resolving).invoke(request, payload);
    },
  });
}
