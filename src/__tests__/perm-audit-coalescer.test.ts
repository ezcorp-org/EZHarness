/**
 * `src/extensions/perm-audit-coalescer.ts` — the burst folder for the PDP's
 * step-4 ALLOW audit row and its step-2 subset-check DENY.
 *
 * The property under test is narrow and load-bearing: the FIRST decision of
 * a burst is always written verbatim, the tail is folded into exactly one
 * counted summary, and a burst that CHANGES — different tool, different
 * user, different caller, different DECISION, different missing capability
 * — is a different burst.
 *
 * A folded deny is only legitimate if nothing is lost, so the deny cases
 * assert the arithmetic (`suppressed + 1` equals the decisions made) and
 * the span (`firstAt`/`lastAt`), not merely that folding happened.
 *
 * Every timing case drives an explicit tiny window and awaits it, rather
 * than reaching for fake timers: the module's contract includes `unref`'d
 * real timers, and a fake-timer harness would be testing a different
 * scheduler than the one that ships. The two cases that assert TIMESTAMP
 * VALUES freeze `Date.now` instead of measuring the clock — under a
 * parallel pool a wall-clock assertion measures the host, not the code.
 */
import { test, expect, describe, spyOn } from "bun:test";
import {
  COALESCE_FLUSH_AT,
  COALESCE_MAX_KEYS,
  COALESCE_WINDOW_MS,
  createPermAuditCoalescer,
  type CoalescedPermSummary,
  type PermAuditKey,
} from "../extensions/perm-audit-coalescer";

const KEY: PermAuditKey = {
  decision: "allow",
  extensionId: "ext-1",
  userId: "user-1",
  conversationId: null,
  toolName: "ez-factory__read_files",
  callerExtensionId: null,
  capabilityKind: null,
  capabilityValue: null,
  reason: null,
};

/**
 * The deny shape the PDP builds at step 2: same identity fields, plus the
 * missing capability and the reason string that names it.
 */
const DENY_KEY: PermAuditKey = {
  ...KEY,
  decision: "deny",
  toolName: "weather-mcp__forecast",
  capabilityKind: "network",
  capabilityValue: "api.weather.test",
  reason: "missing capability network:api.weather.test for tool weather-mcp__forecast",
};

/** A coalescer plus the summaries it emitted, in order. */
function harness(opts?: { windowMs?: number; flushAt?: number; maxKeys?: number }) {
  const summaries: CoalescedPermSummary[] = [];
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

describe("a folded deny loses nothing (#206)", () => {
  test("the head is verbatim and the summary accounts for every refusal", () => {
    // The reported generator: a revoked grant refuses every call in the
    // turn, bounded by MAX_TOOL_CALLS_PER_TURN (100).
    const { coalescer, summaries } = harness({ windowMs: 60_000, flushAt: 10_000 });
    let written = 0;
    for (let i = 0; i < 100; i++) {
      if (coalescer.shouldWrite(DENY_KEY, `deny-${i}`)) written++;
    }
    coalescer.flushAll();

    expect(written).toBe(1);
    expect(summaries).toHaveLength(1);
    // The count is the whole justification for folding a security event:
    // 1 verbatim + 99 counted === the 100 refusals that happened.
    expect(summaries[0]!.suppressed).toBe(99);
    expect(written + summaries[0]!.suppressed).toBe(100);
    // And the row can still say WHAT was refused.
    expect(summaries[0]!.key.capabilityKind).toBe("network");
    expect(summaries[0]!.key.capabilityValue).toBe("api.weather.test");
    expect(summaries[0]!.key.reason).toBe(DENY_KEY.reason);
    expect(summaries[0]!.firstAuditId).toBe("deny-0");
  });

  test("an allow burst and a deny burst never share a window", () => {
    const { coalescer, summaries } = harness({ windowMs: 60_000 });
    // Same extension, same tool, interleaved — only the decision differs.
    const allow = { ...DENY_KEY, decision: "allow" as const };
    expect(coalescer.shouldWrite(allow, "a1")).toBe(true);
    expect(coalescer.shouldWrite(DENY_KEY, "d1")).toBe(true);
    expect(coalescer.shouldWrite(allow, "a2")).toBe(false);
    expect(coalescer.shouldWrite(DENY_KEY, "d2")).toBe(false);
    expect(coalescer.size()).toBe(2);

    coalescer.flushAll();
    expect(summaries.map((s) => s.key.decision).sort()).toEqual(["allow", "deny"]);
    // One folded row each — a deny tail must never be reported as an
    // allow tail, which is what a shared window would produce.
    expect(summaries.every((s) => s.suppressed === 1)).toBe(true);
  });

  test("firstAt and lastAt bracket the burst", () => {
    // Frozen clock, not a measured one: under the parallel pool a real
    // elapsed-time assertion measures the host. Freezing turns the bound
    // into an equality, which is the stronger claim.
    let now = 1_700_000_000_000;
    const spy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { coalescer, summaries } = harness({ windowMs: 60_000 });
      coalescer.shouldWrite(DENY_KEY, "d0"); // opens at T+0
      now += 1_000;
      coalescer.shouldWrite(DENY_KEY, "d1");
      now += 4_000;
      coalescer.shouldWrite(DENY_KEY, "d2"); // last fold at T+5s
      now += 2_000; // time passes with no decision
      coalescer.flushAll();

      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.firstAt).toBe(1_700_000_000_000);
      // The LAST DECISION, not the flush — a folded row's span must
      // describe the refusals, not when the timer happened to fire.
      expect(summaries[0]!.lastAt).toBe(1_700_000_005_000);
      expect(summaries[0]!.lastAt - summaries[0]!.firstAt).toBe(5_000);
    } finally {
      spy.mockRestore();
    }
  });

  test("a window with a single fold reports a zero-width span, not a stale one", () => {
    // `lastAt` is seeded from the head, so it can never predate `firstAt`
    // — a summary must not claim a span it did not observe.
    let now = 1_800_000_000_000;
    const spy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { coalescer, summaries } = harness({ windowMs: 60_000 });
      coalescer.shouldWrite(DENY_KEY, "d0");
      coalescer.shouldWrite(DENY_KEY, "d1"); // same instant
      now += 90_000; // long flush delay
      coalescer.flushAll();
      expect(summaries[0]!.firstAt).toBe(1_800_000_000_000);
      expect(summaries[0]!.lastAt).toBe(1_800_000_000_000);
    } finally {
      spy.mockRestore();
    }
  });

  test("an early flush's span ends at the last decision it accounts for", () => {
    let now = 1_900_000_000_000;
    const spy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { coalescer, summaries } = harness({ windowMs: 60_000, flushAt: 3 });
      coalescer.shouldWrite(DENY_KEY, "d0"); // head, T+0
      for (const _ of [1, 2, 3]) {
        now += 500;
        expect(coalescer.shouldWrite(DENY_KEY, "d")).toBe(false);
      }
      // Window is full (3 folded, last at T+1500). The next decision
      // flushes it and becomes the next window's verbatim head, so it is
      // NOT inside this summary's span or its count.
      now += 9_000;
      expect(coalescer.shouldWrite(DENY_KEY, "d4")).toBe(true);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.suppressed).toBe(3);
      expect(summaries[0]!.firstAt).toBe(1_900_000_000_000);
      expect(summaries[0]!.lastAt).toBe(1_900_000_001_500);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sameness folds, novelty always surfaces", () => {
  const variants: Array<[string, PermAuditKey]> = [
    ["a different extension", { ...KEY, extensionId: "ext-2" }],
    ["a different user", { ...KEY, userId: "user-2" }],
    ["a different conversation", { ...KEY, conversationId: "conv-1" }],
    ["a different tool", { ...KEY, toolName: "ez-factory__write_file" }],
    ["a different calling extension", { ...KEY, callerExtensionId: "ext-9" }],
    // #206 — the deny fields. A refusal must never fold into an allow,
    // and two refusals for DIFFERENT missing capabilities are two facts.
    ["a different decision", { ...KEY, decision: "deny" }],
    ["a different capability kind", { ...KEY, capabilityKind: "fs.read" }],
    ["a different capability value", { ...KEY, capabilityValue: "api.other.test" }],
    ["a different deny reason", { ...KEY, reason: "override-lookup-failed" }],
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
    // 1 head + 5 folded fills the window; the 7th call trips the threshold,
    // flushes the count so far and becomes the head of a fresh window.
    const written: boolean[] = [];
    for (let i = 0; i < 7; i++) written.push(coalescer.shouldWrite(KEY, `a${i}`));
    expect(written).toEqual([true, false, false, false, false, false, true]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.suppressed).toBe(5);
    expect(coalescer.size()).toBe(1);
  });

  test("heads + suppressed equals the number of decisions, across flushes", () => {
    // The accounting invariant, stated as an equality. Before #206 the
    // call that TRIPPED a flush was both counted as suppressed and written
    // verbatim, so this sum over-reported by one per flush — 43 for 40
    // decisions at flushAt 13. Harmless on an allow burst; on a folded
    // DENY the count is the forensic content of the row.
    const { coalescer, summaries } = harness({ windowMs: 60_000, flushAt: 13 });
    const DECISIONS = 40;
    let heads = 0;
    for (let i = 0; i < DECISIONS; i++) {
      if (coalescer.shouldWrite(KEY, `a${i}`)) heads++;
    }
    coalescer.flushAll();
    const folded = summaries.reduce((n, s) => n + s.suppressed, 0);
    expect(heads + folded).toBe(DECISIONS);
    // Not vacuous: folding really happened (3 heads, 37 folded).
    expect(heads).toBe(3);
    expect(folded).toBe(37);
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
