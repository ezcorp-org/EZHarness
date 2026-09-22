import { createGatewayTransport, GatewayStatusError, type GatewayTransportOptions } from "@ezcorp/factory-transport";
import { FACTORY_HOST_STOP_PATH } from "./runner/host-stop-service";
import type { FactoryPhysicalStopReason, FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import { FactoryTaskStopError, type FactoryPhysicalStopper, type FactoryTaskStopRequest } from "./task-stops";

export interface FactoryHostStopClientOptions extends GatewayTransportOptions {
  /** The host this endpoint speaks for. A receipt naming another host is refused. */
  readonly hostId: string;
}

const RECEIPT_FIELDS = [
  "schemaVersion", "attemptId", "reservationId", "workerId", "holderGeneration", "allocationGeneration",
  "processGroupAbsent", "stoppedAtMs", "reason", "hostId", "hostKeyId", "hostSignature", "receiptDigest",
] as const;

const REASONS = new Set<FactoryPhysicalStopReason>(["completed", "failed", "cancelled", "lease-revoked"]);
const RESPONSE_LIMIT_BYTES = 8 * 1024;

/**
 * A stop the host refused, carrying the host's own reason.
 *
 * `GatewayStatusError` says "factory gateway returned HTTP 409" and keeps the
 * body on the error, which is correct and useless to a role that reports its
 * failures as text: the two 409s this route answers mean entirely different
 * things. `conflict` is a receipt that does not match the command that asked
 * for it, and `stop_uncertain` is a runtime that would not confirm the process
 * group is gone. Measured on a real run, where every pass of `stop-settlement`
 * reported the status and none of them reported which one it was.
 */
export class FactoryHostStopRefusedError extends Error {
  readonly code = "factory_host_stop_refused";
  constructor(readonly status: number, readonly hostError: string, options: { cause: unknown }) {
    super(`factory host refused the stop with HTTP ${status}: ${hostError}`, options);
    this.name = "FactoryHostStopRefusedError";
  }
}

/** The host's own error code, or a name for the fact that it sent none. */
function hostRefusal(body: Uint8Array): string {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    const code = (parsed as { error?: unknown } | null)?.error;
    return typeof code === "string" && code.length > 0 && code.length <= 128 ? code : "unnamed";
  } catch { return "unreadable"; }
}

function opaque(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new FactoryTaskStopError("factory_task_stop_proof_invalid");
  return value;
}

function counter(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new FactoryTaskStopError("factory_task_stop_proof_invalid");
  return value;
}

/**
 * Decodes the host's reply into the exact receipt shape.
 *
 * The signature is verified later, against the configured host keys, by
 * `validateFactoryStopReceipt`. This step only refuses a wire body that is not
 * a receipt at all, so a transport fault can never be mistaken for a proof.
 */
export function parseFactoryHostStopReceipt(value: unknown, hostId: string): FactoryPhysicalStopReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FactoryTaskStopError("factory_task_stop_proof_invalid");
  const body = value as Record<string, unknown>;
  const present = new Set(Object.keys(body));
  if (present.size !== RECEIPT_FIELDS.length || RECEIPT_FIELDS.some(field => !present.has(field))) throw new FactoryTaskStopError("factory_task_stop_proof_invalid");
  if (body.schemaVersion !== "factory.physical-stop.v1" || body.processGroupAbsent !== true) throw new FactoryTaskStopError("factory_task_stop_proof_invalid");
  if (typeof body.reason !== "string" || !REASONS.has(body.reason as FactoryPhysicalStopReason)) throw new FactoryTaskStopError("factory_task_stop_proof_invalid");
  if (opaque(body.hostId) !== hostId) throw new FactoryTaskStopError("factory_task_stop_proof_invalid");
  return Object.freeze({
    schemaVersion: "factory.physical-stop.v1",
    attemptId: opaque(body.attemptId),
    reservationId: opaque(body.reservationId),
    workerId: opaque(body.workerId),
    holderGeneration: counter(body.holderGeneration, 1),
    allocationGeneration: counter(body.allocationGeneration, 1),
    processGroupAbsent: true,
    stoppedAtMs: counter(body.stoppedAtMs, 0),
    reason: body.reason as FactoryPhysicalStopReason,
    hostId,
    hostKeyId: opaque(body.hostKeyId, 512),
    hostSignature: opaque(body.hostSignature),
    receiptDigest: opaque(body.receiptDigest, 128),
  });
}

/**
 * The concrete authenticated host stop transport.
 *
 * It carries only the sealed physical coordinates: the cancel command, the run,
 * and the tenant's own references never leave the product. Mutual TLS is the
 * authentication, and the reply is a fact the host signed with a key this
 * process does not hold.
 */
export async function createFactoryHostStopClient(options: FactoryHostStopClientOptions): Promise<FactoryPhysicalStopper> {
  const hostId = opaque(options.hostId, 512);
  const transport = await createGatewayTransport(options);
  return Object.freeze({
    async stop(request: FactoryTaskStopRequest, signal: AbortSignal): Promise<FactoryPhysicalStopReceipt> {
      if (request.hostId !== hostId) throw new FactoryTaskStopError("factory_task_stop_pool_mismatch");
      const body = {
        attemptId: request.attemptId, reservationId: request.reservationId, workerId: request.workerId,
        holderGeneration: request.holderGeneration, allocationGeneration: request.allocationGeneration,
        hostId: request.hostId, reason: request.reason,
      };
      let response: Awaited<ReturnType<typeof transport.request>>;
      try {
        response = await transport.request("POST", FACTORY_HOST_STOP_PATH, body, RESPONSE_LIMIT_BYTES, signal);
      } catch (error) {
        // Every non-2xx still throws and the transport stays fail-closed; the
        // only thing added here is the host's own name for the refusal.
        if (!(error instanceof GatewayStatusError)) throw error;
        throw new FactoryHostStopRefusedError(error.response.statusCode, hostRefusal(error.response.body), { cause: error });
      }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
      catch { throw new FactoryTaskStopError("factory_task_stop_proof_invalid"); }
      const receipt = parseFactoryHostStopReceipt(parsed, hostId);
      if (receipt.attemptId !== request.attemptId || receipt.reservationId !== request.reservationId || receipt.workerId !== request.workerId
        || receipt.holderGeneration !== request.holderGeneration || receipt.allocationGeneration !== request.allocationGeneration
        || receipt.reason !== request.reason) throw new FactoryTaskStopError("factory_task_stop_proof_invalid");
      return receipt;
    },
  });
}
