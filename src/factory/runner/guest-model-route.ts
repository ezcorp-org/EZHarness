import type { FactoryGuestModelRefusal, FactoryGuestModelResponse, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryAttemptAuthority, FactoryExecutionJournal } from "../executions";
import { factoryModelSamplingOptions } from "../model-configuration";
import { createFactoryGuestModelBroker, factoryGuestModelOperationIdOf, factoryGuestModelRefusal, type FactoryOneHopProvider } from "./guest-model-broker";
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
 *
 * **Three refusals come before any claim**, so none leaves a journal row: an
 * attempt this installation cannot read, an attempt pinned to a provider or
 * model other than the installation's own (a pin admitted before a restart
 * that changed `modelProvider` would otherwise be served by another model
 * while the journal named the first), and a pin whose configuration this
 * process cannot honour.
 *
 * **What the guest is told is typed and bounded.** The guest is untrusted, so
 * it never receives the journal's or the database's own error text: a
 * refusal carries a fixed code. A failure the attempt caused is
 * `invalid_request`; a failure of the store itself is transient and is
 * `operation_busy`, the one refusal the contract lets a guest retry.
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
  /** The installation's `modelProvider`. An attempt pinned to anything else is refused before any claim. */
  readonly installationPin?: { readonly provider: string; readonly model: string };
}

/** The journal's own invariant failures, which the attempt caused and which no retry repairs. */
const JOURNAL_REFUSALS: ReadonlyMap<string, string> = new Map([
  ["Factory operation conflicts with its durable journal entry.", "factory_operation_conflict"],
  ["Factory operation index is not contiguous.", "factory_operation_not_contiguous"],
  ["Factory durable runner request is corrupt.", "factory_attempt_request_corrupt"],
]);

const FACTORY_CODE = /^factory_[a-z0-9_]{1,120}$/;

/**
 * A store failure, as a guest may see it: a fixed code and nothing else.
 *
 * A typed factory error (an unknown or no-longer-live attempt, a moved fence)
 * and a journal invariant are the attempt's own, so they are `invalid_request`
 * naming their code. Anything else is the store failing, which is transient.
 */
function storeRefusal(payload: unknown, error: unknown): FactoryGuestModelResponse {
  const code = (error as { code?: unknown } | null)?.code;
  const named = typeof code === "string" && FACTORY_CODE.test(code) ? code : error instanceof Error ? JOURNAL_REFUSALS.get(error.message) : undefined;
  return named === undefined
    ? refused(payload, "operation_busy", "factory_journal_unavailable: the attempt's journal could not be reached; retry the operation.")
    : refused(payload, "invalid_request", named);
}

function refused(payload: unknown, code: FactoryGuestModelRefusal, message: string): FactoryGuestModelResponse {
  return factoryGuestModelRefusal(factoryGuestModelOperationIdOf(payload), code, message);
}

/** A refusal decided from the admitted attempt alone, before the broker claims anything. */
function attemptRefusal(attempt: FactoryRunnerRequest, installationPin: FactoryGuestModelRouteOptions["installationPin"], payload: unknown): FactoryGuestModelResponse | undefined {
  const pin = attempt.model;
  if (pin === undefined) return undefined;
  if (installationPin !== undefined && (pin.provider !== installationPin.provider || pin.model !== installationPin.model)) {
    return refused(payload, "model_pin_mismatch", "factory_model_pin_not_installed: this attempt's pin names a provider or model this installation does not serve.");
  }
  try { factoryModelSamplingOptions(pin.configuration); }
  catch (error) { return refused(payload, "invalid_request", (error as Error).message); }
  return undefined;
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
        // never admitted, or one whose fence moved, or a store that failed.
        // Nothing may be claimed for it either way.
        return storeRefusal(payload, error);
      }
      const early = attemptRefusal(attempt, options.installationPin, payload);
      if (early !== undefined) return early;
      try {
        return await broker.call(attempt, payload);
      } catch (error) {
        // The claim itself refused, or the store failed under it. No provider
        // was reached and nothing was recorded.
        return storeRefusal(payload, error);
      }
    },
  });
}
