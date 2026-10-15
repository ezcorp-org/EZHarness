/**
 * The supervisor's one call to the pool, and why it has to be this process.
 *
 * C03 does not release a host's capacity on a tenant's word. The product holds
 * a host-signed physical-stop receipt and verifies it, but the pool cannot
 * verify that signature — so the tenant route
 * (`POST /v1/pool/requests/{id}/confirm-stopped`) READS the ledger and fails
 * closed until a trusted supervisor has settled it. `POST /v1/pool/supervisor/stop`
 * is the only route that mutates it, and only a supervisor certificate reaches
 * that route.
 *
 * Measured, because the symptom names the wrong owner. With nothing presenting
 * the receipt, a stop was signed by the host, refused by the pool with HTTP 409
 * ("Pool stop cannot be acknowledged before a supervisor confirms it"), marked
 * durably uncertain by the product, and retried forever. The run sat between
 * `running` and its terminal status, `stop-settlement` reported a transport
 * status on every pass, and nothing in the product was wrong.
 *
 * This client carries no tenant credential and no tenant fact: a reservation
 * id, a holder generation, and the host it speaks for. That is the whole
 * payload the supervisor route takes, which is what keeps the process
 * credential-free in the sense C01 means.
 */
import { createGatewayTransport, GatewayStatusError, type GatewayTransportOptions } from "@ezcorp/factory-transport";
import type { FactoryPhysicalStopReceipt } from "./attempt-wire";

/** The one route a supervisor may call. */
export const FACTORY_POOL_SUPERVISOR_STOP_PATH = "/v1/pool/supervisor/stop";

const RESPONSE_LIMIT_BYTES = 8 * 1024;

export class FactorySupervisorPoolError extends Error {
  constructor(
    readonly code: "factory_supervisor_pool_host" | "factory_supervisor_pool_refused" | "factory_supervisor_pool_unreadable",
    message: string,
    options?: { cause: unknown },
  ) {
    super(message, options);
    this.name = "FactorySupervisorPoolError";
  }
}

/** What the pool answered. The state is reported, never re-decided here. */
export interface FactorySupervisorPoolAcknowledgement {
  readonly reservationId: string;
  readonly state: string;
  readonly holderGeneration: number;
}

export interface FactorySupervisorPoolClient {
  presentStopReceipt(
    receipt: Pick<FactoryPhysicalStopReceipt, "reservationId" | "holderGeneration" | "hostId">,
    signal?: AbortSignal,
  ): Promise<FactorySupervisorPoolAcknowledgement>;
}

export interface FactorySupervisorPoolClientOptions extends GatewayTransportOptions {
  /** The host this supervisor speaks for. A receipt naming another host is refused here. */
  readonly hostId: string;
}

function acknowledgement(body: Uint8Array): FactorySupervisorPoolAcknowledgement {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new FactorySupervisorPoolError("factory_supervisor_pool_unreadable", "The pool answered the supervisor stop with something that is not JSON."); }
  const status = parsed as { reservationId?: unknown; state?: unknown; holderGeneration?: unknown } | null;
  if (!status || typeof status.reservationId !== "string" || typeof status.state !== "string" || typeof status.holderGeneration !== "number") {
    throw new FactorySupervisorPoolError("factory_supervisor_pool_unreadable", "The pool answered the supervisor stop without a lease status.");
  }
  return Object.freeze({ reservationId: status.reservationId, state: status.state, holderGeneration: status.holderGeneration });
}

export async function createFactorySupervisorPoolClient(options: FactorySupervisorPoolClientOptions): Promise<FactorySupervisorPoolClient> {
  const hostId = options.hostId;
  if (typeof hostId !== "string" || hostId.length < 1 || hostId.length > 512) {
    throw new FactorySupervisorPoolError("factory_supervisor_pool_host", "A supervisor pool client needs the host it speaks for.");
  }
  const transport = await createGatewayTransport(options);
  return Object.freeze({
    async presentStopReceipt(receipt: Pick<FactoryPhysicalStopReceipt, "reservationId" | "holderGeneration" | "hostId">, signal?: AbortSignal): Promise<FactorySupervisorPoolAcknowledgement> {
      // The pool authorizes by certificate and checks the host against the
      // supervisor's own list, so this check adds nothing there. It is here so
      // a misrouted receipt fails at the process that can name the mistake
      // rather than as a 403 three hops away.
      if (receipt.hostId !== hostId) throw new FactorySupervisorPoolError("factory_supervisor_pool_host", "That stop receipt names another host.");
      const body = { reservationId: receipt.reservationId, holderGeneration: receipt.holderGeneration, hostId: receipt.hostId };
      try {
        const response = await transport.request("POST", FACTORY_POOL_SUPERVISOR_STOP_PATH, body, RESPONSE_LIMIT_BYTES, signal ?? new AbortController().signal);
        const settled = acknowledgement(response.body);
        if (settled.reservationId !== receipt.reservationId || settled.holderGeneration !== receipt.holderGeneration) {
          throw new FactorySupervisorPoolError("factory_supervisor_pool_refused", "The pool answered about a different reservation.");
        }
        // The state is NOT asserted. A CPU reservation settles here; a GPU one
        // reaches `uncertain` awaiting a verified reimage receipt, which is
        // C03's contract and not a failure of this call.
        return settled;
      } catch (error) {
        if (!(error instanceof GatewayStatusError)) throw error;
        throw new FactorySupervisorPoolError("factory_supervisor_pool_refused", `The pool refused the supervisor stop with HTTP ${error.response.statusCode}.`, { cause: error });
      }
    },
  });
}
