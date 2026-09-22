import { describe, expect, test } from "bun:test";
import { factoryPageDriver, type FactoryItemDisposition } from "./role-drivers";

const open = new AbortController().signal;

function driver(pages: Array<readonly string[]>, failing: ReadonlySet<string> = new Set()) {
  const reported: Array<{ item: string; message: string; disposition: FactoryItemDisposition }> = [];
  const settled: string[] = [];
  let index = 0;
  const built = factoryPageDriver<string>({
    page: async () => pages[Math.min(index++, pages.length - 1)] ?? [],
    settle: async (item) => {
      if (failing.has(item)) throw new Error(`cannot settle ${item}`);
      settled.push(item);
    },
    report: (item, error, disposition) => { reported.push({ item, message: String(error), disposition }); },
  });
  return { built, reported, settled };
}

describe("factoryPageDriver", () => {
  test("settles every item of a page and reports progress", async () => {
    const { built, settled } = driver([["a", "b", "c"]]);
    expect(await built.step(open)).toBe(true);
    expect(settled).toEqual(["a", "b", "c"]);
    expect(built.progress).toEqual({ scanned: 3, settled: 3, deferred: 0, failed: 0 });
  });

  test("an empty page is no work, and leaves the counts saying so", async () => {
    const { built, settled } = driver([[]]);
    expect(await built.step(open)).toBe(false);
    expect(settled).toEqual([]);
    expect(built.progress).toEqual({ scanned: 0, settled: 0, deferred: 0, failed: 0 });
  });

  // The defect this prevents: W06's scan orders by start instant and throws on a
  // corrupt binding. If one throw abandoned the page, the oldest corrupt row
  // would head every later scan and nothing behind it would ever settle.
  test("one item's failure is reported and stepped over, not allowed to abandon the page", async () => {
    const { built, reported, settled } = driver([["corrupt", "b", "c"]], new Set(["corrupt"]));
    expect(await built.step(open)).toBe(true);
    expect(settled).toEqual(["b", "c"]);
    expect(reported).toEqual([{ item: "corrupt", message: "Error: cannot settle corrupt", disposition: "fault" }]);
    expect(built.progress).toEqual({ scanned: 3, settled: 2, deferred: 0, failed: 1 });
  });

  test("a failure in the middle and at the end is stepped over just the same", async () => {
    const { built, reported, settled } = driver([["a", "bad", "c", "worse"]], new Set(["bad", "worse"]));
    expect(await built.step(open)).toBe(true);
    expect(settled).toEqual(["a", "c"]);
    expect(reported.map((entry) => entry.item)).toEqual(["bad", "worse"]);
    expect(built.progress).toEqual({ scanned: 4, settled: 2, deferred: 0, failed: 2 });
  });

  test("a page where nothing settles reports no progress, so the role backs off", async () => {
    const { built, reported } = driver([["x", "y"]], new Set(["x", "y"]));
    // Not `true`: returning progress here would spin the loop on rows it cannot
    // move, at the batch bound, forever.
    expect(await built.step(open)).toBe(false);
    expect(built.progress).toEqual({ scanned: 2, settled: 0, deferred: 0, failed: 2 });
    // The condition stays loud: every pass reports it again.
    expect(await built.step(open)).toBe(false);
    expect(reported.map((entry) => entry.item)).toEqual(["x", "y", "x", "y"]);
  });

  test("the next page is read fresh, because a settled item leaves the set", async () => {
    const { built, settled } = driver([["a", "b"], ["c"], []]);
    expect(await built.step(open)).toBe(true);
    expect(await built.step(open)).toBe(true);
    expect(await built.step(open)).toBe(false);
    expect(settled).toEqual(["a", "b", "c"]);
  });

  test("an aborted signal takes no page at all", async () => {
    const controller = new AbortController();
    controller.abort();
    let pages = 0;
    const built = factoryPageDriver<string>({
      page: async () => { pages++; return ["a"]; },
      settle: async () => {},
      report: () => {},
    });
    expect(await built.step(controller.signal)).toBe(false);
    expect(pages).toBe(0);
  });

  test("an abort between items stops the pass without abandoning the one in flight", async () => {
    const controller = new AbortController();
    const settled: string[] = [];
    const built = factoryPageDriver<string>({
      page: async () => ["a", "b", "c"],
      settle: async (item) => {
        settled.push(item);
        if (item === "a") controller.abort(new Error("server shutting down"));
      },
      report: () => {},
    });
    // `a` completes because it was already in flight; `b` and `c` are not begun.
    expect(await built.step(controller.signal)).toBe(true);
    expect(settled).toEqual(["a"]);
    expect(built.progress).toEqual({ scanned: 3, settled: 1, deferred: 0, failed: 0 });
  });

  test("the caller's deadline reaches both the scan and every settlement", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const built = factoryPageDriver<string>({
      page: async (signal) => { seen.push(signal); return ["a"]; },
      settle: async (_item, signal) => { seen.push(signal); },
      report: () => {},
    });
    await built.step(controller.signal);
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  test("a scan that throws is the role's failure, not one item's", async () => {
    const built = factoryPageDriver<string>({
      page: async () => { throw new Error("database unavailable"); },
      settle: async () => {},
      report: () => { throw new Error("an item report must not be reached"); },
    });
    // It propagates: the worker's own backoff owns a failing dependency, and a
    // scan that cannot run is not the same fact as an item that cannot settle.
    await expect(built.step(open)).rejects.toThrow("database unavailable");
  });

  test("refuses a driver that cannot page, settle, or report", () => {
    const good = { page: async () => [], settle: async () => {}, report: () => {} };
    expect(() => factoryPageDriver({ ...good, page: undefined as never })).toThrow(/page, a settle, and a report/);
    expect(() => factoryPageDriver({ ...good, settle: undefined as never })).toThrow(/page, a settle, and a report/);
    expect(() => factoryPageDriver({ ...good, report: undefined as never })).toThrow(/page, a settle, and a report/);
  });

  test("the progress counts are frozen, so a reader cannot rewrite what a pass did", async () => {
    const { built } = driver([["a"]]);
    await built.step(open);
    expect(Object.isFrozen(built.progress)).toBe(true);
  });
});

describe("factoryPageDriver dispositions", () => {
  // W06's `settle` throws factory_budget_pending while a child still holds an
  // uncertain budget reservation. That is a queue doing its job, not an
  // integrity fault, and an operator watching undifferentiated "failures"
  // cannot tell the two apart.
  const transientCodes = new Set(["factory_budget_pending", "factory_child_conflict"]);
  const classify = (error: unknown): FactoryItemDisposition =>
    transientCodes.has((error as { code?: string }).code ?? "") ? "transient" : "fault";

  function coded(code: string) {
    return Object.assign(new Error(code), { code });
  }

  test("separates an item that is not ready yet from one that is broken", async () => {
    const reported: Array<{ item: string; disposition: FactoryItemDisposition }> = [];
    const built = factoryPageDriver<string>({
      page: async () => ["pending", "corrupt", "fine"],
      settle: async (item) => {
        if (item === "pending") throw coded("factory_budget_pending");
        if (item === "corrupt") throw coded("factory_child_corrupt");
      },
      classify,
      report: (item, _error, disposition) => { reported.push({ item, disposition }); },
    });

    expect(await built.step(open)).toBe(true);
    expect(reported).toEqual([
      { item: "pending", disposition: "transient" },
      { item: "corrupt", disposition: "fault" },
    ]);
    expect(built.progress).toEqual({ scanned: 3, settled: 1, deferred: 1, failed: 1 });
  });

  test("a page that is entirely not-yet reports no progress, so the role waits", async () => {
    const built = factoryPageDriver<string>({
      page: async () => ["a", "b"],
      settle: async () => { throw coded("factory_budget_pending"); },
      classify,
      report: () => {},
    });
    // Waiting is exactly what a not-yet wants; spinning would not make the
    // budget hold reconcile any sooner.
    expect(await built.step(open)).toBe(false);
    expect(built.progress).toEqual({ scanned: 2, settled: 0, deferred: 2, failed: 0 });
  });

  test("an unclassified failure is the loud one", async () => {
    const reported: FactoryItemDisposition[] = [];
    const built = factoryPageDriver<string>({
      page: async () => ["a"],
      settle: async () => { throw new Error("something new"); },
      report: (_item, _error, disposition) => { reported.push(disposition); },
    });
    // A driver that downgraded an unknown error to backpressure would hide the
    // case this shape exists to surface.
    await built.step(open);
    expect(reported).toEqual(["fault"]);
    expect(built.progress).toEqual({ scanned: 1, settled: 0, deferred: 0, failed: 1 });
  });
});
