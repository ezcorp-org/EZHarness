/**
 * `src/extensions/perm-audit-coalescer.ts` — the burst folder for the PDP's
 * step-4 ALLOW audit row.
 *
 * The property under test is narrow and load-bearing: the FIRST decision of
 * a burst is always written verbatim, the tail is folded into exactly one
 * counted summary, and a burst that CHANGES — different tool, different
 * user, different caller — is a different burst.
 *
 * Every timing case drives an explicit tiny window and awaits it, rather
 * than reaching for fake timers: the module's contract includes `unref`'d
 * real timers, and a fake-timer harness would be testing a different
 * scheduler than the one that ships.
 */
import { test, expect, describe } from "bun:test";
import {
  COALESCE_FLUSH_AT,
  COALESCE_MAX_KEYS,
  COALESCE_WINDOW_MS,
  createPermAuditCoalescer,
  type AllowAuditKey,
  type CoalescedAllowSummary,
} from "../extensions/perm-audit-coalescer";

const KEY: AllowAuditKey = {
  extensionId: "ext-1",
  userId: "user-1",
  conversationId: null,
  toolName: "ez-factory__read_files",
  callerExtensionId: null,
};

/** A coalescer plus the summaries it emitted, in order. */
function harness(opts?: { windowMs?: number; flushAt?: number; maxKeys?: number }) {
  const summaries: CoalescedAllowSummary[] = [];
  const coalescer = createPermAuditCoalescer((s) => summaries.push(s), opts);
  return { coalescer, summaries };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("the defaults are the documented ones", () => {
  test("window, early-flush threshold and key cap", () => {
    // Pinned by value because all three are operator-visible: the window
    // bounds how stale a count can get, and the cap bounds memory.
    expect(COALESCE_WINDOW_MS).toBe(10_000);
    expect(COALESCE_FLUSH_AT).toBe(250);
    expect(COALESCE_MAX_KEYS).toBe(512);
  });
});

describe("the head of a burst is never folded", () => {
  test("a single allow writes its row and emits no summary", async () => {
    const { coalescer, summaries } = harness({ windowMs: 30 });
    expect(coalescer.shouldWrite(KEY, "audit-1")).toBe(true);
    await sleep(60);
    // A lone allow must look EXACTLY as it did before this module existed
    // — one row, no tail. Every existing PDP test asserts that shape.
    expect(summaries).toEqual([]);
  });

  test("the first allow of each new window is written verbatim", async () => {
    const { coalescer } = harness({ windowMs: 30 });
    expect(coalescer.shouldWrite(KEY, "a1")).toBe(true);
    await sleep(60);
    expect(coalescer.shouldWrite(KEY, "a2")).toBe(true);
  });
});

describe("the tail is folded into one counted summary", () => {
  test("700 allows produce 1 verbatim row and 1 summary carrying 699", async () => {
    // The actual reported flood: `read_files` walking a project.
    const { coalescer, summaries } = harness({ windowMs: 40, flushAt: 10_000 });
    let written = 0;
    for (let i = 0; i < 700; i++) {
      if (coalescer.shouldWrite(KEY, `audit-${i}`)) written++;
    }
    expect(written).toBe(1);
    await sleep(90);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.suppressed).toBe(699);
    // 1 + 699 === 700: nothing was lost, it was counted.
    expect(written + summaries[0]!.suppressed).toBe(700);
  });

  test("the summary names the head row it belongs to", () => {
    const { coalescer, summaries } = harness({ windowMs: 5_000 });
    coalescer.shouldWrite(KEY, "head-audit-id");
    coalescer.shouldWrite(KEY, "tail-1");
    coalescer.flushAll();
    expect(summaries[0]?.firstAuditId).toBe("head-audit-id");
    expect(summaries[0]?.key).toEqual(KEY);
    expect(summaries[0]?.windowMs).toBe(5_000);
  });
});

describe("sameness folds, novelty always surfaces", () => {
  const variants: Array<[string, AllowAuditKey]> = [
    ["a different extension", { ...KEY, extensionId: "ext-2" }],
    ["a different user", { ...KEY, userId: "user-2" }],
    ["a different conversation", { ...KEY, conversationId: "conv-1" }],
    ["a different tool", { ...KEY, toolName: "ez-factory__write_file" }],
    ["a different calling extension", { ...KEY, callerExtensionId: "ext-9" }],
  ];

  for (const [what, variant] of variants) {
    test(`${what} opens a NEW window and is written verbatim`, () => {
      const { coalescer } = harness({ windowMs: 5_000 });
      expect(coalescer.shouldWrite(KEY, "a1")).toBe(true);
      expect(coalescer.shouldWrite(KEY, "a2")).toBe(false);
      // The point of the key: a burst that changes what it is doing is a
      // new fact, and a new fact is never suppressed.
      expect(coalescer.shouldWrite(variant, "b1")).toBe(true);
      coalescer.flushAll();
    });
  }

  test("the null and non-null forms of a field are different keys", () => {
    // The join must not collapse `{conversationId: null}` and
    // `{conversationId: ""}`-shaped neighbours onto one another.
    const { coalescer } = harness({ windowMs: 5_000 });
    expect(coalescer.shouldWrite({ ...KEY, toolName: null }, "a")).toBe(true);
    expect(coalescer.shouldWrite({ ...KEY, toolName: "" }, "b")).toBe(true);
    coalescer.flushAll();
  });
});

describe("a long burst reports progress instead of going silent", () => {
  test("hitting the early-flush threshold emits a summary and reopens", () => {
    const { coalescer, summaries } = harness({ windowMs: 60_000, flushAt: 5 });
    // 1 head + 4 folded, then the 6th trips the threshold: it flushes the
    // count so far and becomes the head of a fresh window.
    const written: boolean[] = [];
    for (let i = 0; i < 6; i++) written.push(coalescer.shouldWrite(KEY, `a${i}`));
    expect(written).toEqual([true, false, false, false, false, true]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.suppressed).toBe(5);
    expect(coalescer.size()).toBe(1);
  });
});

describe("the memory backstop flushes rather than forgets", () => {
  test("evicting the oldest window emits its summary", () => {
    const { coalescer, summaries } = harness({ windowMs: 60_000, maxKeys: 2 });
    coalescer.shouldWrite({ ...KEY, extensionId: "old" }, "o1");
    coalescer.shouldWrite({ ...KEY, extensionId: "old" }, "o2");
    coalescer.shouldWrite({ ...KEY, extensionId: "mid" }, "m1");
    expect(coalescer.size()).toBe(2);
    // The third distinct key is over the cap — the OLDEST is evicted, and
    // eviction must not silently drop the count it was holding.
    coalescer.shouldWrite({ ...KEY, extensionId: "new" }, "n1");
    expect(coalescer.size()).toBe(2);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.key.extensionId).toBe("old");
    expect(summaries[0]?.suppressed).toBe(1);
  });

  test("a window with nothing folded is evicted WITHOUT a summary", () => {
    const { coalescer, summaries } = harness({ windowMs: 60_000, maxKeys: 1 });
    coalescer.shouldWrite({ ...KEY, extensionId: "a" }, "a1");
    coalescer.shouldWrite({ ...KEY, extensionId: "b" }, "b1");
    // A summary saying "0 suppressed" would be a row claiming a flood
    // that did not happen.
    expect(summaries).toEqual([]);
  });
});

describe("flushAll and dropAll are different on purpose", () => {
  test("flushAll emits pending summaries and empties the map", () => {
    const { coalescer, summaries } = harness({ windowMs: 60_000 });
    coalescer.shouldWrite(KEY, "a1");
    coalescer.shouldWrite(KEY, "a2");
    expect(coalescer.size()).toBe(1);
    coalescer.flushAll();
    expect(coalescer.size()).toBe(0);
    expect(summaries).toHaveLength(1);
  });

  test("flushAll on an empty coalescer is a no-op", () => {
    const { coalescer, summaries } = harness();
    coalescer.flushAll();
    expect(summaries).toEqual([]);
    expect(coalescer.size()).toBe(0);
  });

  test("dropAll discards WITHOUT emitting — test isolation, not shutdown", async () => {
    const { coalescer, summaries } = harness({ windowMs: 20 });
    coalescer.shouldWrite(KEY, "a1");
    coalescer.shouldWrite(KEY, "a2");
    coalescer.dropAll();
    expect(coalescer.size()).toBe(0);
    // The timer must be cancelled too, or a summary lands in whatever
    // suite runs next — the exact cross-test bleed this method prevents.
    await sleep(60);
    expect(summaries).toEqual([]);
  });
});

describe("a broken summary writer cannot break a permission decision", () => {
  test("a throwing emitter is swallowed and the window still closes", () => {
    const coalescer = createPermAuditCoalescer(
      () => {
        throw new Error("audit table unreachable");
      },
      { windowMs: 60_000 },
    );
    coalescer.shouldWrite(KEY, "a1");
    coalescer.shouldWrite(KEY, "a2");
    expect(() => coalescer.flushAll()).not.toThrow();
    expect(coalescer.size()).toBe(0);
  });
});
