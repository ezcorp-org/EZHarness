import { WORKFLOW_RELEASE_AUTHORITY_LOST } from "../../runtime/workflow-release-assets";

export const LEGACY_WORKFLOW_STATUS_SCHEMA_VERSION = "factory.legacy-status.v1";

/**
 * Everything the mapping reads from one `workflow_runs` row.
 *
 * A snapshot rather than the row, so the mapping is pure: no query, no
 * clock, no engine import. `observedAtMs` is supplied by the caller for the
 * same reason — a lease is expired relative to the instant the caller read
 * the row, and reading a clock in here would make the verdict depend on how
 * long the caller held the value.
 */
export interface LegacyWorkflowRunFacts {
  /** `workflow_runs.status`. The engine spells success `success`, not `done`. */
  readonly status: string;
  /** `workflow_runs.run_phase`. */
  readonly runPhase: string;
  readonly suspendedReason: string | null;
  readonly resumable: boolean;
  /** `workflow_runs.lease_expires_at` in epoch milliseconds, `null` for a lease-less run. */
  readonly leaseExpiresAtMs: number | null;
  /** `cursor -> batchIndex`, `null` when the run never wrote a cursor. */
  readonly cursorBatchIndex: number | null;
  /** Step names still `running` in `workflow_step_runs`. */
  readonly inFlightStepNames: readonly string[];
  /** `result -> error -> code`, `null` when the engine stored a bare message. */
  readonly resultErrorCode: string | null;
  /** `result -> error -> message`, or the bare `result -> error` string. */
  readonly resultErrorMessage: string | null;
  readonly resultOutput: unknown;
  readonly observedAtMs: number;
}

/** Why a legacy run's outcome is not yet a fact. */
export type LegacyWorkflowUncertainty = "awaiting-approval" | "lease-expired" | "unrecognized-status";

/**
 * The factory-side outcome of one wrapped legacy run.
 *
 * `uncertain` is terminal for `awaiting-approval` and provisional for
 * `lease-expired`: C10 makes the first a blocker the adapter never resumes,
 * and leaves the second to the orphan sweep. The discriminator carries which
 * it is rather than a boolean, so a caller cannot read one as the other.
 */
export type LegacyWorkflowOutcome =
  | { readonly state: "running" }
  | { readonly state: "waiting"; readonly reason: string; readonly resumable: boolean }
  | { readonly state: "uncertain"; readonly reason: LegacyWorkflowUncertainty; readonly terminal: boolean; readonly blocker: string }
  | { readonly state: "failed"; readonly reason: string; readonly batchIndex: number | null; readonly inFlightSteps: readonly string[] }
  | { readonly state: "succeeded"; readonly output: unknown }
  | { readonly state: "cancelled"; readonly reason: string };

/** C10's `release-authority-lost`. The adapter never re-grants authority. */
export const LEGACY_RELEASE_AUTHORITY_LOST_REASON = "release-authority-lost";

/**
 * The C10 status mapping, row for row.
 *
 * | legacy                                   | factory |
 * | ---------------------------------------- | ------- |
 * | `suspended`, any reason                  | `waiting` with its reason |
 * | orphaned at a batch boundary             | `waiting`, reason `orphaned-resumable`, resumable |
 * | `awaiting_approval`                      | terminal uncertain, surfaced as a blocker, never resumed |
 * | `running` with an expired lease           | uncertain until the sweep resolves it |
 * | `error`, `resumable=false`               | `failed` with the batch index and in-flight step names |
 * | release authority lost mid-flight        | `failed`, reason `release-authority-lost` |
 * | `success`                                | `succeeded` with the referenced outputs |
 * | `cancelled`                              | `cancelled` |
 *
 * Any other status is uncertain rather than assumed benign: a status this
 * mapping does not know is a status whose meaning it cannot claim.
 */
export function mapLegacyWorkflowStatus(facts: LegacyWorkflowRunFacts): LegacyWorkflowOutcome {
  if (facts.status === "success") return Object.freeze({ state: "succeeded" as const, output: facts.resultOutput });
  if (facts.status === "cancelled") return Object.freeze({ state: "cancelled" as const, reason: facts.resultErrorMessage ?? "cancelled" });
  if (facts.status === "suspended") {
    return Object.freeze({ state: "waiting" as const, reason: facts.suspendedReason ?? "suspended", resumable: facts.resumable });
  }
  if (facts.status === "awaiting_approval") {
    return Object.freeze({
      state: "uncertain" as const,
      reason: "awaiting-approval" as const,
      // Terminal in the legacy engine, so terminal here. The adapter never
      // answers the approval and never resumes the run.
      terminal: true,
      blocker: facts.resultErrorMessage ?? "awaiting_approval",
    });
  }
  if (facts.status === "error") {
    const lost = facts.resultErrorCode === "release-unavailable"
      || facts.resultErrorCode === "not-resumable" && facts.resultErrorMessage === WORKFLOW_RELEASE_AUTHORITY_LOST
      || facts.resultErrorMessage === WORKFLOW_RELEASE_AUTHORITY_LOST;
    return Object.freeze({
      state: "failed" as const,
      reason: lost ? LEGACY_RELEASE_AUTHORITY_LOST_REASON : facts.resultErrorCode ?? facts.resultErrorMessage ?? "error",
      batchIndex: facts.cursorBatchIndex,
      inFlightSteps: Object.freeze([...facts.inFlightStepNames]),
    });
  }
  if (facts.status === "running") {
    if (facts.leaseExpiresAtMs !== null && facts.leaseExpiresAtMs < facts.observedAtMs) {
      return Object.freeze({
        state: "uncertain" as const,
        reason: "lease-expired" as const,
        // The sweep resolves it; this verdict must not close the question.
        terminal: false,
        blocker: `lease expired at ${facts.leaseExpiresAtMs}`,
      });
    }
    return Object.freeze({ state: "running" as const });
  }
  return Object.freeze({
    state: "uncertain" as const,
    reason: "unrecognized-status" as const,
    terminal: false,
    blocker: facts.status,
  });
}

/**
 * Whether the adapter may ask the daemon to resume this run.
 *
 * Only a resumable `waiting` run. An `awaiting_approval` run is terminal in
 * the legacy engine, and resuming an uncertain run would re-enter a step
 * whose outcome nobody has established.
 */
export function legacyWorkflowIsResumable(outcome: LegacyWorkflowOutcome): boolean {
  return outcome.state === "waiting" && outcome.resumable;
}

/** Whether this outcome closes the wrapped task. */
export function legacyWorkflowIsTerminal(outcome: LegacyWorkflowOutcome): boolean {
  return outcome.state === "succeeded" || outcome.state === "failed" || outcome.state === "cancelled"
    || outcome.state === "uncertain" && outcome.terminal;
}
