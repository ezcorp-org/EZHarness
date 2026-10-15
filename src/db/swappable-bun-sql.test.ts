import { describe, expect, test } from "bun:test";
import { swappableBunSql, type BunSqlLike } from "./swappable-bun-sql";

interface FakePool extends BunSqlLike {
  readonly id: number;
  readonly calls: unknown[][];
  closedWith: Array<{ timeout?: number } | undefined>;
  unsafe(query: string): string;
  label?: string;
}

/** Opens numbered fake pools; `closeFails` makes a pool's close reject, `closeHangs` makes it never return. */
function opener(closeFails = false, closeHangs = false) {
  const pools: FakePool[] = [];
  let release: (() => void) | undefined;
  const open = (): FakePool => {
    const id = pools.length + 1;
    const calls: unknown[][] = [];
    const pool = Object.assign((...args: unknown[]) => { calls.push(args); return `tagged-${id}`; }, {
      id,
      calls,
      closedWith: [] as Array<{ timeout?: number } | undefined>,
      unsafe: (query: string) => `${query}@${id}`,
      close(options?: { timeout?: number }) {
        pool.closedWith.push(options);
        if (closeFails) return Promise.reject(new Error(`pool ${id} would not close`));
        if (closeHangs) return new Promise<void>(() => {});
        return new Promise<void>((resolve) => { release = resolve; });
      },
    }) as FakePool;
    pools.push(pool);
    return pool;
  };
  return { open, pools, drain: () => release?.() };
}

describe("swappableBunSql", () => {
  test("forwards calls, methods, reads and writes to the current pool", () => {
    const { open, pools } = opener();
    const swappable = swappableBunSql(open, { drainSeconds: 30, onCloseError: () => {} });
    expect(swappable.generation).toBe(1);
    expect(swappable.client("SELECT", 1)).toBe("tagged-1");
    expect(pools[0]!.calls).toEqual([["SELECT", 1]]);
    expect(swappable.client.unsafe("q")).toBe("q@1");
    expect(swappable.client.id).toBe(1);
    swappable.client.label = "main";
    expect(pools[0]!.label).toBe("main");
    expect("unsafe" in swappable.client).toBe(true);
    expect("missing" in swappable.client).toBe(false);
  });

  test("routes new work to a fresh pool and drains the old one with the timeout", async () => {
    const { open, pools, drain } = opener();
    const swappable = swappableBunSql(open, { drainSeconds: 30, onCloseError: () => {} });
    const replaced = swappable.replace();
    expect(swappable.generation).toBe(2);
    expect(swappable.client.unsafe("q")).toBe("q@2");
    expect(pools[0]!.closedWith).toEqual([{ timeout: 30 }]);
    expect(pools[1]!.closedWith).toEqual([]);
    drain();
    await replaced;
  });

  test("concurrent replacements share one, and a later one opens another pool", async () => {
    const { open, pools, drain } = opener();
    const swappable = swappableBunSql(open, { drainSeconds: 5, onCloseError: () => {} });
    const first = swappable.replace();
    expect(swappable.replace()).toBe(first);
    expect(pools).toHaveLength(2);
    drain();
    await first;
    const second = swappable.replace();
    expect(second).not.toBe(first);
    expect(pools).toHaveLength(3);
    expect(swappable.generation).toBe(3);
    drain();
    await second;
  });

  test("reports a pool that will not close without failing the replacement", async () => {
    const { open } = opener(true);
    const reported: string[] = [];
    const swappable = swappableBunSql(open, { drainSeconds: 5, onCloseError: (error) => { reported.push((error as Error).message); } });
    await swappable.replace();
    expect(reported).toEqual(["pool 1 would not close"]);
    expect(swappable.client.unsafe("q")).toBe("q@2");
  });

  test("an old pool whose close never returns is reported after its deadline, and the next replacement still happens", async () => {
    const { open, pools } = opener(false, true);
    const reported: string[] = [];
    const swappable = swappableBunSql(open, { drainSeconds: 30, closeDeadlineMs: 5, onCloseError: (error) => { reported.push((error as Error).message); } });
    await swappable.replace();
    expect(reported).toEqual(["the replaced pool did not close within 5 ms; left to the process exit"]);
    // Before the bound, this call returned the stuck replacement and opened nothing.
    await swappable.replace();
    expect(pools).toHaveLength(3);
    expect(swappable.generation).toBe(3);
    expect(swappable.client.unsafe("q")).toBe("q@3");
  });
});
