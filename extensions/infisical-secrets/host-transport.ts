import type { ExtensionContext } from "@ezcorp/sdk/v4";
import {
  InfisicalProviderError,
  type InfisicalHttpRequest,
  type InfisicalHttpResponse,
  type InfisicalHttpTransport,
} from "./transport";

export const INFISICAL_HOST_TRANSPORT_PATH = "/api/secret-providers/infisical/transport";

export function createHostInfisicalTransport(context: Pick<ExtensionContext, "call">): InfisicalHttpTransport {
  return {
    async request(request: Readonly<InfisicalHttpRequest>): Promise<Readonly<InfisicalHttpResponse>> {
      let response: unknown;
      try {
        response = await context.call("ezcorp/api.request", {
          method: "POST",
          path: INFISICAL_HOST_TRANSPORT_PATH,
          body: request,
        });
      } catch {
        throw new InfisicalProviderError("unavailable", true);
      }
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new InfisicalProviderError("invalid_response", false);
      }
      const envelope = response as Record<string, unknown>;
      if (!Number.isSafeInteger(envelope.status) || typeof envelope.body !== "string") {
        throw new InfisicalProviderError("invalid_response", false);
      }
      const headers = envelope.headers;
      if (headers !== undefined && (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== "string"))) {
        throw new InfisicalProviderError("invalid_response", false);
      }
      return {
        status: envelope.status as number,
        body: envelope.body,
        ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
      };
    },
  };
}
