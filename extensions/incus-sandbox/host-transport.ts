import type { ExtensionContext } from "@ezcorp/sdk/v4";
import {
  IncusTransportError,
  type IncusTransport,
  type IncusTransportErrorKind,
  type IncusTransportRequest,
} from "./transport";

/** This capability is installed only for a host-minted provider invocation. */
export const INCUS_HOST_TRANSPORT_RPC = "ezcorp/provider.incus.transport";
const MAX_TRANSPORT_RESPONSE_BYTES = 1_048_576;
const transportErrorKinds = new Set<IncusTransportErrorKind>([
  "invalid", "not_found", "already_exists", "revision_conflict", "unsupported", "deadline",
  "unavailable", "permission", "resource_exhausted", "internal",
]);

function effectAfterDispatch(command: Readonly<IncusTransportRequest>): "none" | "unknown" {
  return command.idempotency ? "unknown" : "none";
}

export function createHostIncusTransport(context: Pick<ExtensionContext, "call">): IncusTransport {
  return {
    async request(command: Readonly<IncusTransportRequest>): Promise<unknown> {
      let response: unknown;
      try { response = await context.call(INCUS_HOST_TRANSPORT_RPC, { command }); }
      catch {
        throw new IncusTransportError("unavailable", "Protected Incus transport is unavailable", {
          effect: effectAfterDispatch(command),
        });
      }
      if (!response || typeof response !== "object" || Array.isArray(response)
        || Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_TRANSPORT_RESPONSE_BYTES) {
        throw new IncusTransportError("internal", "Protected Incus transport returned an invalid response", {
          effect: effectAfterDispatch(command),
        });
      }
      const envelope = response as Record<string, unknown>;
      if (envelope.ok === true && Object.hasOwn(envelope, "result") && Object.keys(envelope).length === 2) {
        return envelope.result;
      }
      if (envelope.ok === false && envelope.error && typeof envelope.error === "object"
        && !Array.isArray(envelope.error) && Object.keys(envelope).length === 2) {
        const error = envelope.error as Record<string, unknown>;
        if (transportErrorKinds.has(error.kind as IncusTransportErrorKind)
          && (error.effect === "none" || error.effect === "unknown")
          && (error.operationId === undefined || typeof error.operationId === "string"
            && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(error.operationId))) {
          throw new IncusTransportError(error.kind as IncusTransportErrorKind, "Protected Incus transport rejected the request", {
            effect: error.effect,
            operationId: error.operationId as string | undefined,
          });
        }
      }
      throw new IncusTransportError("internal", "Protected Incus transport returned an invalid response", {
        effect: effectAfterDispatch(command),
      });
    },
  };
}
