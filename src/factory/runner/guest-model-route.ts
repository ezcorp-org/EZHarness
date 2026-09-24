import type { FactoryGuestModelRefusal, FactoryGuestModelResponse, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryAttemptAuthority, FactoryExecutionJournal } from "../executions";
import { createFactoryGuestModelBroker, type FactoryOneHopProvider } from "./guest-model-broker";
import { createFactoryJournalGuestModelJournal } from "./guest-model-journal";
import type { FactoryWorkspaceCheckpoint } from "./supervisor";

/**
 * The product half of a sandboxed guest's model call.
 *
 * A guest runs on `--network=none` and its host holds no provider, so the host
 * carries a `FactoryGuestModelRequest` here over the same guest-broker route a
 * staging frame takes. This answers it with the one broker W01e defined —
 * `createFactoryGuestModelBroker` — over the attempt's durable journal, W04's
 * workspace checkpoints, and the installation's pinned provider. It adds no
 * rule of its own: the pin comparison, the one-winner claim, the settlement
 * before the answer, and every refusal are that broker's.
 *
 * **The attempt is the durable one, not the frame's.** The route has verified
 * the attempt token; the pin, the resources, and every scope field then come
 * from the runner request the journal admitted for that authority. A guest
 * cannot name a model its attempt was not admitted with, because the admitted
 * request is the only place a pin is read from.
 */

export interface FactoryGuestModelFrameBroker {
  frame(authority: FactoryAttemptAuthority, attemptToken: string, payload: unknown): Promise<FactoryGuestModelResponse>;
}

export interface FactoryGuestModelRouteOptions {
  readonly journal: FactoryExecutionJournal;
  /** W04's checkpoint writer; a completed model operation carries its checkpoint. */
  readonly workspace: FactoryWorkspaceCheckpoint;
  /**
   * The installation's provider, resolved for each call.
   *
   * Per call because an operator registers a local model after boot, and
   * because a credential lost after boot must refuse the next call rather than
   * be remembered as present. A throw here is a provider failure: the claimed
   * operation settles `failed` carrying the reason, and the guest is refused
   * `provider_unavailable`.
   */
  readonly provider: () => Promise<FactoryOneHopProvider>;
}

function refused(payload: unknown, code: FactoryGuestModelRefusal, message: string): FactoryGuestModelResponse {
  const operationId = typeof (payload as { operationId?: unknown } | null)?.operationId === "string" ? (payload as { operationId: string }).operationId : "unknown";
  return Object.freeze({ schemaVersion: "factory.guest-model-response.v1" as const, status: "refused" as const, operationId, refusal: Object.freeze({ code, message: message.slice(0, 4_096) }) });
}

function named(error: unknown): string {
  if (!(error instanceof Error)) return "The attempt could not be read.";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? `${code}: ${error.message}` : error.message;
}

export function createFactoryGuestModelFrameBroker(options: FactoryGuestModelRouteOptions): FactoryGuestModelFrameBroker {
  const broker = createFactoryGuestModelBroker({
    provider: { complete: async (request, attempt) => (await options.provider()).complete(request, attempt) },
    journal: createFactoryJournalGuestModelJournal({ journal: options.journal, workspace: options.workspace }),
  });
  return Object.freeze({
    async frame(authority: FactoryAttemptAuthority, attemptToken: string, payload: unknown): Promise<FactoryGuestModelResponse> {
      let attempt: FactoryRunnerRequest;
      try {
        const admitted = await options.journal.request(authority);
        attempt = { ...admitted, broker: { ...admitted.broker, attemptToken } };
      } catch (error) {
        // No admitted request for this authority: an attempt this installation
        // never admitted, or one whose fence moved. Either way nothing may be
        // claimed for it, and the guest is told which by name.
        return refused(payload, "invalid_request", named(error));
      }
      try {
        return await broker.call(attempt, payload);
      } catch (error) {
        // The claim itself refused: the attempt is past its deadline, cancelled,
        // or superseded. No provider was reached and nothing was recorded.
        return refused(payload, "invalid_request", named(error));
      }
    },
  });
}
