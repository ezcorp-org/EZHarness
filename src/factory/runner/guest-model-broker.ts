import { canonicalJson } from "@ezcorp/extension-contract";
import { validateFactoryGuestModelRequest, validateFactoryGuestModelResponse, type FactoryGuestModelRefusal, type FactoryGuestModelRequest, type FactoryGuestModelResponse, type FactoryMeasuredUsage, type FactoryModelPin, type FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { FactoryGuestFrameError } from "./guest-frames";

/**
 * The one reverse-capability seam a factory guest reaches, and the only one.
 *
 * Before this there were three shapes for the same thing — the isolated
 * runtime's `{ invoke }`, the host launch supervisor's bare function, and the
 * provider broker's `stream` — so the composition could not write an adapter
 * across them and no guest could request a model call at all. Both host-side
 * shapes are now this interface; `createFactoryOneHopProvider` adapts the
 * third onto it.
 */
export interface FactoryGuestBroker {
  invoke(request: FactoryRunnerRequest, payload: unknown): Promise<unknown>;
}

/** The guest model contract, served over that one seam. */
export interface FactoryGuestModelBroker extends FactoryGuestBroker {
  call(request: FactoryRunnerRequest, payload: unknown): Promise<FactoryGuestModelResponse>;
}

/** What a provider double or the real SDK broker must answer in one hop. */
export interface FactoryModelCompletion {
  readonly text: string;
  readonly providerReceiptDigest: string;
  readonly usage: FactoryMeasuredUsage;
}

/** The single-hop provider seam. W10's streaming broker is adapted onto this. */
export interface FactoryOneHopProvider {
  complete(request: FactoryGuestModelRequest, attempt: FactoryRunnerRequest): Promise<FactoryModelCompletion>;
}

/**
 * The outcome of the durable one-winner claim.
 *
 * `busy` and `settled` are distinct because the guest is told which: a second
 * concurrent call may be retried once the first finishes, and a call after the
 * operation settled never may.
 */
export type FactoryGuestModelClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly reason: "busy" | "settled" };

/**
 * The durable half of a model call.
 *
 * `claim` runs before any provider effect and is the authority on concurrency:
 * an in-memory guard cannot refuse a second caller in another process, and the
 * host supervisor and the product process are two processes. `record` writes
 * the provider receipt digest and the measured usage against the attempt's own
 * operation, which is what W03c's usage resolver settles from.
 */
export interface FactoryGuestModelJournal {
  claim(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest): Promise<FactoryGuestModelClaim>;
  record(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, completion: FactoryModelCompletion): Promise<void>;
  /** Settles a claimed operation that never produced a completion. */
  fail(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, reason: string): Promise<void>;
}

export interface FactoryGuestModelBrokerOptions {
  readonly provider: FactoryOneHopProvider;
  readonly journal: FactoryGuestModelJournal;
  /**
   * Where a reverse payload that is not a guest model request goes. The
   * validator report frame is one, so collapsing the seam must not strand it.
   */
  readonly delegate?: FactoryGuestBroker;
}

function refusal(operationId: string, code: FactoryGuestModelRefusal, message: string): FactoryGuestModelResponse {
  return Object.freeze({ schemaVersion: "factory.guest-model-response.v1" as const, status: "refused" as const, operationId, refusal: Object.freeze({ code, message }) });
}

/** The pin must match the attempt's own, field for field, or the call is refused. */
function pinned(attempt: FactoryRunnerRequest, asked: FactoryModelPin): boolean {
  return attempt.model !== undefined && canonicalJson(attempt.model) === canonicalJson(asked);
}

/** True for the one payload shape this broker answers itself. */
export function isFactoryGuestModelPayload(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && !Array.isArray(payload) && (payload as { schemaVersion?: unknown }).schemaVersion === "factory.guest-model-request.v1";
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 4_096) : "The provider was unavailable.";
}

/**
 * Builds the broker.
 *
 * Every refusal but one happens before the provider is reached, so a refused
 * call costs nothing and leaves no receipt to settle. A guest asking for a
 * model other than its pin, sending more than the frame policy allows, calling
 * twice at once for one operation, or calling after that operation settled all
 * get a typed refusal rather than a substitution or a silent failure.
 *
 * The exception is a call whose cost cannot be recorded. The effect already
 * happened, so the operation stays dispatched for `reconcileLate` rather than
 * being marked failed, and the guest is refused rather than handed an answer
 * whose cost nothing can settle.
 */
export function createFactoryGuestModelBroker(options: FactoryGuestModelBrokerOptions): FactoryGuestModelBroker {
  const call = async (attempt: FactoryRunnerRequest, payload: unknown): Promise<FactoryGuestModelResponse> => {
    const validation = validateFactoryGuestModelRequest(payload);
    if (!validation.ok) {
      const operationId = typeof (payload as { operationId?: unknown })?.operationId === "string" ? (payload as { operationId: string }).operationId : "unknown";
      const code: FactoryGuestModelRefusal = validation.issues[0]?.code === "GUEST_MODEL_INPUT_BYTES" || validation.issues[0]?.code === "GUEST_MODEL_MESSAGES" ? "input_too_large" : "invalid_request";
      return refusal(operationId, code, validation.issues[0]?.message ?? "Guest model request is invalid.");
    }
    const request = payload as FactoryGuestModelRequest;

    if (!pinned(attempt, request.model)) return refusal(request.operationId, "model_pin_mismatch", "A guest may only call the model its attempt pinned.");

    const claim = await options.journal.claim(attempt, request);
    if (!claim.claimed) {
      return claim.reason === "settled"
        ? refusal(request.operationId, "operation_settled", "That operation already settled and cannot call a model again.")
        : refusal(request.operationId, "operation_busy", "That operation already has a model call in flight.");
    }

    let completion: FactoryModelCompletion;
    try {
      completion = await options.provider.complete(request, attempt);
    } catch (error) {
      const message = reason(error);
      // The claim is released as a failed settlement so the operation is not
      // left dispatched forever by a provider that was simply unavailable.
      // A failed release is reported to the guest as the same refusal; the
      // operation then stays dispatched for `reconcileLate` to settle.
      await options.journal.fail(attempt, request, message).catch(() => undefined);
      return refusal(request.operationId, "provider_unavailable", message);
    }

    try {
      // Durable before the guest is told: an unsettleable cost is worse than a
      // failed call, so the recording is part of answering, not a follow-up.
      await options.journal.record(attempt, request, completion);
    } catch (error) {
      return refusal(request.operationId, "provider_unavailable", reason(error));
    }

    const response = Object.freeze({
      schemaVersion: "factory.guest-model-response.v1" as const,
      status: "completed" as const,
      operationId: request.operationId,
      text: completion.text,
      providerReceiptDigest: completion.providerReceiptDigest,
      usage: completion.usage,
    });
    // Checked after the recording, never before: an answer too large for the
    // frame still cost what it cost. Truncating it here would be a silent
    // substitution, so the guest is refused and the receipt stays settled.
    const carried = validateFactoryGuestModelResponse(response);
    if (!carried.ok) return refusal(request.operationId, "provider_unavailable", carried.issues[0]?.message ?? "The provider answer does not fit the guest frame.");
    return response;
  };

  return Object.freeze({
    call,
    async invoke(attempt: FactoryRunnerRequest, payload: unknown): Promise<unknown> {
      if (isFactoryGuestModelPayload(payload)) return call(attempt, payload);
      if (options.delegate) return options.delegate.invoke(attempt, payload);
      throw new FactoryGuestFrameError("frame_invalid", "Factory guest reverse payload is not a model request and this broker has no other route.");
    },
  });
}
