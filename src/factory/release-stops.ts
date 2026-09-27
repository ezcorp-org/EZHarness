import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryInbox } from "./inbox";
import type { FactoryProtectedCommandEffects } from "./protected-command-effects";
import { assertFactoryIdentity } from "./records";
import type { FactoryReleases, FactoryReleaseStopEffect } from "./releases";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

/**
 * The stop of a release node (W09e).
 *
 * A release node's attempt is its `request-release` effect command, not a process. The execution cancel route
 * resolves a cancel through the attempt queue, which never holds a release, so a run stopped while its release
 * was in flight stayed `stopping` for ever (reproduced red: `factory_task_stop_stale`, run `cancelling`).
 *
 * A release cannot be settled in place, because its publish may be in flight at the provider (W01h ruling).
 * So the stop is certain for the node and names the external effect: the operation the command prepared is
 * marked with this stop under its row lock (the lock `claim` takes), and the kernel gets `attempt-stopped` with
 * `uncertain: false` and, when a publish may have started or did, `effect: "uncertain" | "published"`. The mark
 * and the event's enqueue commit in one transaction. The release outcome later proves what the publish did.
 *
 * This path locks neither an attempt's `factory_task_stops` row nor its `factory_attempt_launches` row; a
 * release has neither, so `FACTORY_STOP_LAUNCH_LOCK_ORDER` (W01h) does not apply to it.
 */
export class FactoryReleaseStops {
  readonly #database: TransactionalDb;
  readonly #authority: FactoryCommandAuthority;
  readonly #inbox: FactoryInbox;
  readonly #releases: Pick<FactoryReleases, "stopInTransaction">;
  readonly #effects: Pick<FactoryProtectedCommandEffects, "releaseOperationIdInTransaction">;
  readonly #now: () => number;

  constructor(database: TransactionalDb, authority: FactoryCommandAuthority, inbox: FactoryInbox, releases: Pick<FactoryReleases, "stopInTransaction">, effects: Pick<FactoryProtectedCommandEffects, "releaseOperationIdInTransaction">, now: () => number = Date.now) {
    if (inbox.tenantId !== authority.tenantId) throw new Error("factory_release_stop_scope");
    this.#database = database;
    this.#authority = authority;
    this.#inbox = inbox;
    this.#releases = releases;
    this.#effects = effects;
    this.#now = now;
  }

  /**
   * Stops the release node a `cancel-node` names and returns its `attempt-stopped` event, or undefined when
   * the command is not a current cancel of a release node, so the task stop decides it (and names any
   * refusal). A repeated cancel returns the event recorded the first time.
   */
  async stop(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<KernelEvent | undefined> {
    assertFactoryIdentity(...Object.values(reference));
    const recorded = await this.#database.transaction(transaction => this.#recorded(transaction, reference));
    if (recorded) return recorded;
    try {
      return await this.#authority.withCurrentCancellation(service, reference, async (transaction, context) => {
        if (context.node.kind !== "release") return undefined;
        const { command, attempt, fence } = context;
        const eventFor = (effect: FactoryReleaseStopEffect): KernelEvent => Object.freeze({
          kind: "attempt-stopped", id: `${reference.commandId}:stopped`, atMs: Math.max(this.#now(), context.state.nowMs),
          nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt,
          ...(effect === "none" ? {} : { uncertain: false, effect }),
        });
        const releaseCommand = { ...reference, commandId: attempt.commandId };
        const operationId = await this.#effects.releaseOperationIdInTransaction(transaction, releaseCommand);
        // No operation: the effect command never prepared one, so there is nothing to publish or to stop.
        const event = operationId === undefined ? eventFor("none")
          : await this.#releases.stopInTransaction(transaction, reference.projectId, operationId, { commandId: reference.commandId, epoch: fence.cancellationEpoch, requestedAtMs: this.#now() }, eventFor);
        await this.#inbox.enqueueInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, interpreterId: reference.interpreterId }, event);
        return event;
      });
    } catch (error) {
      // Not a current cancel (for example a task stop's repeat after its attempt stopped): the task stop owns it.
      if ((error as { code?: unknown } | null | undefined)?.code === "factory_command_stale") return undefined;
      throw error;
    }
  }

  /**
   * The event this cancel already recorded, if it stopped a release before. A task's stop records the same
   * event id but always beside its own `factory_task_stops` row, which a release never has; so an event with
   * no such row is a release's.
   */
  async #recorded(transaction: MigrationDb, reference: TrustedFactoryCommandReference): Promise<KernelEvent | undefined> {
    const [row] = rows<{ payload: string }>(await transaction.execute(sql`SELECT payload FROM factory_inbox_events e
      WHERE e.tenant_id=${reference.tenantId} AND e.project_id=${reference.projectId} AND e.run_id=${reference.logicalRunId} AND e.interpreter_id=${reference.interpreterId}
        AND e.event_id=${`${reference.commandId}:stopped`}
        AND NOT EXISTS (SELECT 1 FROM factory_task_stops s WHERE s.tenant_id=e.tenant_id AND s.project_id=e.project_id AND s.run_id=e.run_id AND s.interpreter_id=e.interpreter_id AND s.cancel_command_id=${reference.commandId})`));
    return row ? JSON.parse(row.payload) as KernelEvent : undefined;
  }
}
