import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";

/**
 * The cancellation epoch every interpreter of a stopping run holds.
 *
 * A kernel starts at 0 and its one `beginStopping` moves it to 1, whatever
 * started the stop: a user cancel, the run deadline, a failed command, a
 * partition invalidation, or a node that failed for good. It never moves again.
 * `run-cancellation-epoch.test.ts` pins this against the kernel itself.
 */
export const FACTORY_STOPPED_CANCELLATION_EPOCH = 1;

export class FactoryRunCancellationEpochError extends Error {
  readonly code = "factory_epoch_invalid";
  constructor() { super("factory_epoch_invalid"); this.name = "FactoryRunCancellationEpochError"; }
}

/**
 * Raises the run fence's durable cancellation epoch to `epoch`, never lowers it.
 *
 * Defect 2 (W01h): only a user cancel used to move the durable epoch, so a stop
 * the kernel began itself left every later `cancel-node` refused
 * `factory_command_stale` and the run in `stopping` for ever. The rule is that
 * the durable epoch is written by the transition that raises it, in the same
 * transaction as that transition's audit batch; a user cancel writes the same
 * target through this function, so the two orders converge on one value and
 * neither increments twice. A write that does not raise the epoch locks nothing.
 */
export async function advanceFactoryRunCancellationEpochInTransaction(
  transaction: MigrationDb,
  scope: { readonly tenantId: string; readonly projectId: string; readonly runId: string },
  epoch: number,
): Promise<void> {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new FactoryRunCancellationEpochError();
  await transaction.execute(sql`UPDATE factory_run_lifecycle SET cancellation_epoch=${epoch}, updated_at=NOW()
    WHERE tenant_id=${scope.tenantId} AND project_id=${scope.projectId} AND run_id=${scope.runId} AND cancellation_epoch < ${epoch}`);
}
