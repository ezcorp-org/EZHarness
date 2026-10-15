/**
 * The bounded-page shape three seam-driven roles share.
 *
 * Child settlement, usage reconciliation, and release outcomes all work the
 * same way: scan a bounded page of durable work another package owns, then act
 * on each item. Only the scan and the action differ, so the loop around them
 * lives here once.
 *
 * Two rules in it are not obvious, and both come from what a page of durable
 * work is actually like.
 *
 * **One item's failure must not abandon the page.** A settlement that rejects
 * the whole pass would leave the first unsettleable item at the head of every
 * later scan, and nothing behind it would ever settle: one bad row would stop
 * the role for the whole installation. Each item is settled independently, and
 * a failure is reported and stepped over.
 *
 * **Not every failure means the same thing.** A corrupt record is an integrity
 * fault that needs a person; an item that is merely not ready yet — W06's
 * `settle` throws `factory_budget_pending` while a child still holds an
 * uncertain budget reservation — is ordinary backpressure that clears itself.
 * Both are stepped over, and both are reported, but the report says which,
 * because an operator watching a stream of undifferentiated "failures" cannot
 * tell a fault from a queue doing its job. The caller classifies, because the
 * two codes come from different error types in different modules and this file
 * should not know either vocabulary.
 *
 * **Progress means at least one item settled.** A page where nothing settled
 * returns no progress, so the worker waits its idle delay instead of spinning
 * on items it cannot move — which is also the right answer for a page that was
 * entirely deferred, since waiting is exactly what a not-yet wants.
 */
import type { FactoryRoleDriver } from "./runtime-seams";

/** Whether an item can be expected to settle later, or needs a person. */
export type FactoryItemDisposition = "transient" | "fault";

export interface FactoryPageDriverOptions<Item> {
  /** One bounded page of work. An empty page means there is nothing to do. */
  page(signal: AbortSignal): Promise<readonly Item[]>;
  /** Acts on exactly one item. Its failure belongs to that item alone. */
  settle(item: Item, signal: AbortSignal): Promise<void>;
  /**
   * Tells a not-yet from a fault. Defaults to `fault`, so an unclassified
   * failure is the loud one: a driver that silently downgraded an unknown error
   * to backpressure would hide the case this shape exists to surface.
   */
  classify?(error: unknown): FactoryItemDisposition;
  /**
   * Where an item's failure is reported. A background role has no caller to
   * throw to, and a swallowed corruption is the failure mode this whole shape
   * exists to avoid.
   */
  report(item: Item, error: unknown, disposition: FactoryItemDisposition): void;
}

export interface FactoryPageProgress {
  readonly scanned: number;
  readonly settled: number;
  /** Items that will be retried: not ready yet, not broken. */
  readonly deferred: number;
  /** Items that need a person. */
  readonly failed: number;
}

/**
 * Build a role driver that settles one bounded page per step.
 *
 * The page is re-read each pass rather than walked with a cursor, because a
 * settled item leaves the set: the next pass's first page is the next work.
 * A cursor would only be needed to walk PAST items that never settle, and those
 * must be reported rather than walked past.
 */
export function factoryPageDriver<Item>(options: FactoryPageDriverOptions<Item>): FactoryRoleDriver & {
  /** The last pass's counts, so a test and an operator read the same numbers. */
  readonly progress: FactoryPageProgress;
} {
  if (typeof options.page !== "function" || typeof options.settle !== "function" || typeof options.report !== "function") {
    throw new Error("a factory page driver needs a page, a settle, and a report");
  }
  const classify = options.classify ?? ((): FactoryItemDisposition => "fault");
  let progress: FactoryPageProgress = Object.freeze({ scanned: 0, settled: 0, deferred: 0, failed: 0 });
  return {
    get progress() {
      return progress;
    },
    async step(signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return false;
      const items = await options.page(signal);
      let settled = 0;
      let deferred = 0;
      let failed = 0;
      for (const item of items) {
        // Shutdown stops between items, never mid-settlement: the item already
        // in flight owns its own abort through the signal it was given.
        if (signal.aborted) break;
        try {
          await options.settle(item, signal);
          settled++;
        } catch (error) {
          const disposition = classify(error);
          if (disposition === "transient") deferred++;
          else failed++;
          options.report(item, error, disposition);
        }
      }
      progress = Object.freeze({ scanned: items.length, settled, deferred, failed });
      return settled > 0;
    },
  };
}
