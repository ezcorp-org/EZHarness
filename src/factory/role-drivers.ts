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
 * **One item's failure must not abandon the page.** W06's settleable-child scan
 * orders by start instant and verifies every row, so a binding whose sealed
 * clock no longer matches its digest throws rather than being skipped — which
 * is right. But if that throw abandoned the page, the oldest corrupt row would
 * sit at the head of every later scan and no child behind it would ever settle:
 * one bad row would stop settlement for the whole installation. Each item is
 * therefore settled independently, and a failure is reported and stepped over.
 *
 * **Progress means at least one item settled.** A page where every item failed
 * returns no progress, so the worker waits its idle delay instead of spinning
 * on rows it cannot move. The failures are still reported on every pass, so the
 * condition stays loud while it lasts.
 *
 * The one bound worth naming: if an entire page fails, the role stops making
 * progress until something changes. That needs as many simultaneously
 * unsettleable items as the page limit — 200 for the child scan — and every one
 * of them is reported on every pass. It is a stall an operator can see, not a
 * silent one.
 */
import type { FactoryRoleDriver } from "./runtime-seams";

export interface FactoryPageDriverOptions<Item> {
  /** One bounded page of work. An empty page means there is nothing to do. */
  page(signal: AbortSignal): Promise<readonly Item[]>;
  /** Acts on exactly one item. Its failure belongs to that item alone. */
  settle(item: Item, signal: AbortSignal): Promise<void>;
  /**
   * Where an item's failure is reported. A background role has no caller to
   * throw to, and a swallowed corruption is the failure mode this whole shape
   * exists to avoid.
   */
  report(item: Item, error: unknown): void;
}

export interface FactoryPageProgress {
  readonly scanned: number;
  readonly settled: number;
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
  let progress: FactoryPageProgress = Object.freeze({ scanned: 0, settled: 0, failed: 0 });
  return {
    get progress() {
      return progress;
    },
    async step(signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return false;
      const items = await options.page(signal);
      let settled = 0;
      let failed = 0;
      for (const item of items) {
        // Shutdown stops between items, never mid-settlement: the item already
        // in flight owns its own abort through the signal it was given.
        if (signal.aborted) break;
        try {
          await options.settle(item, signal);
          settled++;
        } catch (error) {
          failed++;
          options.report(item, error);
        }
      }
      progress = Object.freeze({ scanned: items.length, settled, failed });
      return settled > 0;
    },
  };
}
