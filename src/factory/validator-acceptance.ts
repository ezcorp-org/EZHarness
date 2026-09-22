/**
 * How a protected acceptance command waits for its validators instead of failing the run.
 *
 * The Node orchestrator runs an effect command exactly once
 * (`executeCommand`, `maximumAttempts: 1`), and any thrown effect fails the
 * whole workflow with `FACTORY_COMMAND_FAILED`. W05's `requestAcceptance`
 * throws an infrastructure error whenever a claim's evidence does not exist
 * yet, and it never exists yet the first time: the validator that produces it
 * has not been scheduled, let alone run. So an acceptance node could only ever
 * fail.
 *
 * The shape here is the one a task attempt already uses. `dispatch-node`
 * answers `null` and its result arrives later through the durable inbox; so
 * does `request-acceptance` now:
 *
 * 1. The command handler records the current candidate, schedules every
 *    missing validator through W05's `FactoryProtectedValidatorScheduler`, and
 *    answers `null`. The kernel keeps the acceptance node waiting under its own
 *    deadline, which is the bound.
 * 2. The `validator-scheduling` role re-drives every acceptance command that
 *    has no delivered decision: it reserves, admits once the pool admits, and
 *    when every claim's attempt has a completed terminal it calls W05's
 *    decision (`decideAcceptance`, which is `requestAcceptance` with a hook),
 *    writing the durable receipt and its inbox event in one transaction, the
 *    way `FactoryTaskCompletions` delivers a task result. A validator attempt
 *    that fails or ends uncertain is answered with the typed rejection.
 * 3. An installation with no validator composed refuses the command by name at
 *    once (`factoryValidatorAcceptanceRefusal`); it never waits.
 *
 * Nothing here decides a verdict, reads a report, or writes a receipt. Those
 * stay W05's. What this file adds is the waiting.
 */
import { sql } from "drizzle-orm";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import type { TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { FactoryAttemptQueue } from "./attempt-queue";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryInbox } from "./inbox";
import { classifyFactoryAcceptanceFailure, type FactoryProtectedCommandEffects } from "./protected-command-effects";
import { assertFactoryIdentity } from "./records";
import type { FactoryRoleDriver } from "./runtime-seams";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { FactoryValidatorAttemptDispatch } from "./validator-dispatch";
import type { FactoryProtectedValidatorSchedule, FactoryProtectedValidatorScheduler } from "./validator-scheduler";

/** Acceptance commands visited per pass. Bounded so one pass cannot hold the pool. */
export const FACTORY_VALIDATOR_ACCEPTANCE_SCAN_LIMIT = 16;

/**
 * Delivery states in which a validator attempt with no completed terminal will never produce one.
 *
 * `delivered` belongs here: a validator that ran and did not complete settles through
 * `FactoryValidatorAttemptDispatch.recordInTransaction`, which records no terminal fact, so its
 * delivery ends `delivered` with nothing to read. `outcome_unknown` is the uncertain one.
 */
const FAILED_STATES: ReadonlySet<string> = new Set(["delivered", "cancelled", "dead_letter"]);
const UNCERTAIN_STATES: ReadonlySet<string> = new Set(["outcome_unknown"]);

/** The event-id prefixes a delivered acceptance decision can carry. */
export const FACTORY_ACCEPTANCE_EVENT_PREFIXES = Object.freeze(["protected-acceptance:", "protected-rejection:", "protected-acceptance-unsettled:"] as const);

/** The codes that mean "not yet" for this driver; everything else is reported. */
const NOT_YET_CODES: ReadonlySet<string> = new Set(["factory_compute_admission_not_admitted"]);

/** Codes that mean the command is no longer the current one; the kernel moved on. */
const SUPERSEDED_CODES: ReadonlySet<string> = new Set(["factory_command_stale"]);

export class FactoryValidatorAcceptanceError extends Error {
  constructor(readonly code: "factory_validator_none_declared" | "factory_validator_unavailable", readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "FactoryValidatorAcceptanceError";
  }
}

/**
 * The `request-acceptance` effect of an installation that can judge no protected claim.
 *
 * It refuses by name at once rather than letting the kernel wait: with no validator runtime composed
 * nothing will ever produce the evidence, so a wait could only end at the deadline.
 */
export function factoryValidatorAcceptanceRefusal(code: FactoryValidatorAcceptanceError["code"], detail: string): (service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference) => Promise<never> {
  return async () => { throw new FactoryValidatorAcceptanceError(code, detail); };
}

export interface FactoryValidatorAcceptanceOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  /** The private-service identity the role acts as, the same one the orchestrator authenticates as. */
  readonly service: TrustedFactoryServiceIdentity;
  readonly authority: Pick<FactoryCommandAuthority, "withCurrentAcceptanceInTransaction">;
  readonly scheduler: Pick<FactoryProtectedValidatorScheduler, "planInTransaction" | "reserveInTransaction" | "admitInTransaction">;
  readonly dispatch: Pick<FactoryValidatorAttemptDispatch, "readInTransaction">;
  readonly queue: Pick<FactoryAttemptQueue, "readInTransaction">;
  readonly effects: Pick<FactoryProtectedCommandEffects, "recordCurrentCandidate" | "decideAcceptance">;
  readonly inbox: Pick<FactoryInbox, "enqueueInTransaction">;
  readonly report: (role: string, error: unknown) => void;
  readonly limit?: number;
}

/** Where one acceptance command stands after a pass. */
export interface FactoryValidatorAcceptanceState {
  /** Every claim's validator attempt has a completed terminal fact. */
  readonly ready: boolean;
  /** This pass reserved or admitted something new. */
  readonly progressed: boolean;
  /** A validator attempt that will never produce a terminal fact, and whether its outcome is unknown. */
  readonly unsettled?: { readonly attemptId: string; readonly uncertain: boolean };
}

function code(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | null | undefined)?.code;
  return typeof value === "string" ? value : undefined;
}

export class FactoryValidatorAcceptance {
  private readonly limit: number;

  constructor(private readonly options: FactoryValidatorAcceptanceOptions) {
    assertFactoryIdentity(options.tenantId);
    if (options.service.tenantId !== options.tenantId) throw new Error("factory_validator_acceptance_scope");
    this.limit = options.limit ?? FACTORY_VALIDATOR_ACCEPTANCE_SCAN_LIMIT;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error("factory_validator_acceptance_invalid");
  }

  /**
   * The `request-acceptance` effect: schedule what is missing and let the kernel wait.
   *
   * A refusal still throws, and fails the run by name: a revoked trust or a
   * stale command is not something waiting fixes. Only "the evidence does not
   * exist yet" becomes a wait, and it is the role, not this call, that delivers
   * the decision once it does.
   */
  command = async (service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<KernelEvent | null> => {
    await this.advance(service, reference);
    return null;
  };

  /** Move one acceptance command as far as it can go without deciding it. */
  async advance(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<FactoryValidatorAcceptanceState> {
    await this.options.effects.recordCurrentCandidate(service, reference);
    const schedules = await this.options.database.transaction(transaction => this.options.scheduler.planInTransaction(transaction, service, reference));
    let ready = true;
    let progressed = false;
    for (const schedule of schedules) {
      const state = await this.settle(service, reference, schedule);
      if (state.unsettled) return state;
      ready = ready && state.ready;
      progressed = progressed || state.progressed;
    }
    return { ready, progressed };
  }

  /**
   * Deliver one command's decision once its validators have run.
   *
   * The decision and its inbox event commit in ONE transaction
   * (`decideAcceptance`), so neither can exist without the other. Both are
   * idempotent — the receipt by command, the event by its id — so a restarted
   * role that re-drives a delivered command writes nothing new, and the scan
   * stops seeing it once its event exists.
   *
   * A validator attempt that will never produce a terminal fact is answered
   * with the typed rejection, named for what happened, rather than a wait that
   * could only end at the deadline. An acceptance node is virtual, so the
   * rejection is the one failure the kernel can apply to it without trying to
   * stop an attempt that never existed.
   */
  async deliver(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<boolean> {
    const state = await this.advance(service, reference);
    if (state.unsettled) {
      await this.rejectUnsettled(service, reference, state.unsettled);
      return true;
    }
    if (!state.ready) return state.progressed;
    await this.options.effects.decideAcceptance(service, reference, (transaction, event) => this.options.inbox.enqueueInTransaction(transaction, this.inboxKey(reference), event));
    return true;
  }

  private inboxKey(reference: TrustedFactoryCommandReference) {
    return { projectId: reference.projectId, runId: reference.logicalRunId, interpreterId: reference.interpreterId };
  }

  /** The typed rejection for a validator that failed or ended uncertain, bound to the current command. */
  private async rejectUnsettled(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, unsettled: NonNullable<FactoryValidatorAcceptanceState["unsettled"]>): Promise<void> {
    await this.options.database.transaction(transaction => this.options.authority.withCurrentAcceptanceInTransaction(transaction, service, reference, async (tx, context) => {
      const event: KernelEvent = {
        kind: "node-failed", id: `protected-acceptance-unsettled:${context.command.id}`, atMs: context.commandState.nowMs,
        nodeId: context.command.nodeId, commandId: context.command.id, candidateGeneration: context.command.candidateGeneration, attempt: context.attempt.attempt,
        error: unsettled.uncertain ? "factory_validator_attempt_uncertain" : "factory_validator_attempt_failed",
        failureKind: "acceptance_rejected",
      };
      await this.options.inbox.enqueueInTransaction(tx, this.inboxKey(reference), event);
    }));
  }

  /** The `validator-scheduling` role: one bounded pass over the undelivered acceptance commands. */
  driver(): FactoryRoleDriver {
    return {
      step: async (signal) => {
        let worked = false;
        for (const reference of await this.pending()) {
          if (signal.aborted) break;
          try {
            worked = await this.deliver(this.options.service, reference) || worked;
          } catch (error) {
            const found = code(error);
            if (found !== undefined && (NOT_YET_CODES.has(found) || SUPERSEDED_CODES.has(found))) continue;
            // The acceptance classes name what an operator does next: an
            // infrastructure fault retries on its own, a trust or corruption
            // fault needs a person. The class travels in the role name.
            this.options.report(`validator-scheduling:${classifyFactoryAcceptanceFailure(error)}:${reference.projectId}/${reference.commandId}`, error);
          }
        }
        return worked;
      },
    };
  }

  /**
   * Acceptance commands of live runs whose decision has not reached the inbox.
   *
   * The command id carries its kind (`<run>:<node>:request-acceptance:<n>`),
   * which is only a filter: every candidate is re-authorized through
   * `withCurrentAcceptanceInTransaction` before anything acts on it, so a row
   * the filter admits wrongly is refused rather than trusted. Newest first, so
   * a superseded command cannot starve the one the kernel is waiting on.
   */
  private async pending(): Promise<readonly TrustedFactoryCommandReference[]> {
    const found = rows<{ project_id: string; run_id: string; interpreter_id: string; command_id: string }>(await this.options.database.execute(sql`
      SELECT c.project_id, c.run_id, c.interpreter_id, c.command_id
      FROM factory_transition_commands c
      JOIN factory_run_lifecycle l ON l.tenant_id=c.tenant_id AND l.project_id=c.project_id AND l.run_id=c.run_id
      WHERE c.tenant_id=${this.options.tenantId} AND l.status IN ('running','waiting') AND c.command_id LIKE ${"%:request-acceptance:%"}
        AND NOT EXISTS (
          SELECT 1 FROM factory_inbox_events i
          WHERE i.tenant_id=c.tenant_id AND i.project_id=c.project_id AND i.run_id=c.run_id AND i.interpreter_id=c.interpreter_id
            AND i.event_id IN (${FACTORY_ACCEPTANCE_EVENT_PREFIXES[0]} || c.command_id, ${FACTORY_ACCEPTANCE_EVENT_PREFIXES[1]} || c.command_id, ${FACTORY_ACCEPTANCE_EVENT_PREFIXES[2]} || c.command_id))
      ORDER BY c.source_sequence DESC, c.command_id
      LIMIT ${this.limit}`));
    return found.map(row => Object.freeze({ tenantId: this.options.tenantId, projectId: row.project_id, logicalRunId: row.run_id, interpreterId: row.interpreter_id, commandId: row.command_id }));
  }

  /** One schedule: read its attempt if it exists, otherwise reserve and try to admit. */
  private async settle(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, schedule: FactoryProtectedValidatorSchedule): Promise<FactoryValidatorAcceptanceState> {
    const { database, queue, dispatch, scheduler } = this.options;
    // The delivery row only: the stored request is readable through the journal
    // while the attempt is live, and a completed attempt is exactly the one
    // this has to read.
    const delivery = await database.transaction(transaction => queue.readInTransaction(transaction, reference.projectId, schedule.attemptId));
    if (delivery !== null) {
      const terminal = await database.transaction(transaction => dispatch.readInTransaction(transaction, service, { ...reference, commandId: schedule.attemptId }));
      if (terminal !== undefined) return { ready: true, progressed: false };
      if (FAILED_STATES.has(delivery.state) || UNCERTAIN_STATES.has(delivery.state)) {
        return { ready: false, progressed: false, unsettled: { attemptId: schedule.attemptId, uncertain: UNCERTAIN_STATES.has(delivery.state) } };
      }
      return { ready: false, progressed: false };
    }
    const reserved = await database.transaction(transaction => scheduler.reserveInTransaction(transaction, service, reference, schedule));
    try {
      await database.transaction(transaction => scheduler.admitInTransaction(transaction, service, reference, schedule));
      return { ready: false, progressed: true };
    } catch (error) {
      if (code(error) === "factory_compute_admission_not_admitted") return { ready: false, progressed: reserved.created };
      throw error;
    }
  }
}
