/**
 * Unit tests for per-model history compaction
 * (`src/runtime/stream-chat/context-compaction.ts`). Pure module — no
 * DB, no mocks. Covers token estimation, turn-block splitting, budget
 * math, the strategy registry, the `trim`/`none` built-ins, and the
 * `makeCompactionTransform` wiring (incl. a custom strategy).
 */
import { test, expect, describe } from "bun:test";
import {
  DEFAULTS,
  estimateMessageTokens,
  estimateTokens,
  splitTurnBlocks,
  computeResponseReserve,
  computeInputBudget,
  registerCompactionStrategy,
  getCompactionStrategy,
  listCompactionStrategies,
  isCompactionMarker,
  makeCompactionTransform,
  type CompactionContext,
  type CompactionStrategy,
} from "../runtime/stream-chat/context-compaction";

// ── Fixtures ─────────────────────────────────────────────────────────

type Msg = any;

const userMsg = (text: string): Msg => ({ role: "user", content: text, timestamp: 1 });
const userImg = (n: number): Msg => ({
  role: "user",
  content: Array.from({ length: n }, () => ({ type: "image", data: "x", mimeType: "image/png" })),
  timestamp: 1,
});
const asstText = (text: string): Msg => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 1,
});
const asstToolCall = (id: string, name: string, args: object): Msg => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
  api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: 1,
});
const toolResult = (id: string, text: string): Msg => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "t",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 1,
});

const fakeModel = (contextWindow: number, maxTokens: number): any => ({
  id: "test-model",
  contextWindow,
  maxTokens,
});

const mkCtx = (budget: number, cfg = DEFAULTS): CompactionContext => ({
  model: fakeModel(1, 1),
  budget,
  cfg,
  estimateTokens: (m) => estimateTokens(m, cfg),
  splitTurnBlocks,
});

// ── Token estimation ─────────────────────────────────────────────────

describe("estimateTokens", () => {
  test("user string: overhead + ceil(chars/cpt)", () => {
    expect(estimateMessageTokens(userMsg("hello"))).toBe(4 + Math.ceil(5 / 4));
  });

  test("images charged a flat per-image cost", () => {
    expect(estimateMessageTokens(userImg(2))).toBe(4 + 2 * DEFAULTS.imageTokens);
  });

  test("assistant toolCall counts name + serialized arguments", () => {
    const m = asstToolCall("c1", "search", { q: "abc" });
    const chars = "search".length + JSON.stringify({ q: "abc" }).length;
    expect(estimateMessageTokens(m)).toBe(4 + Math.ceil(chars / 4));
  });

  test("toolResult counts toolName + content text", () => {
    const m = toolResult("c1", "result-body");
    const chars = "t".length + "result-body".length;
    expect(estimateMessageTokens(m)).toBe(4 + Math.ceil(chars / 4));
  });

  test("non-LLM custom messages contribute zero", () => {
    expect(estimateMessageTokens({ role: "capability-event", foo: 1 } as Msg)).toBe(0);
    expect(estimateMessageTokens({ kind: "ui-only" } as Msg)).toBe(0);
  });

  test("monotonic in text length", () => {
    expect(estimateMessageTokens(userMsg("a".repeat(400)))).toBeGreaterThan(
      estimateMessageTokens(userMsg("a".repeat(40))),
    );
  });

  test("sums across messages", () => {
    const msgs = [userMsg("aaaa"), asstText("bbbb")];
    expect(estimateTokens(msgs)).toBe(
      estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[1]),
    );
  });
});

// ── Turn blocks ──────────────────────────────────────────────────────

describe("splitTurnBlocks", () => {
  test("splits at each user boundary; tool loop stays in its turn", () => {
    const msgs = [
      userMsg("u1"),
      asstToolCall("c1", "t", {}),
      toolResult("c1", "r1"),
      asstText("a1"),
      userMsg("u2"),
      asstText("a2"),
    ];
    const blocks = splitTurnBlocks(msgs);
    expect(blocks.length).toBe(2);
    expect(blocks[0].length).toBe(4);
    expect(blocks[1].length).toBe(2);
    // Last block is the active turn.
    expect(blocks[blocks.length - 1][0]).toBe(msgs[4]);
  });

  test("leading non-user messages form their own first block", () => {
    const msgs = [asstText("preamble"), userMsg("u1")];
    const blocks = splitTurnBlocks(msgs);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toEqual([msgs[0]]);
  });

  test("empty input → no blocks", () => {
    expect(splitTurnBlocks([])).toEqual([]);
  });
});

// ── Budget math ──────────────────────────────────────────────────────

describe("computeResponseReserve", () => {
  test("clamps Codex 128k down to the cap", () => {
    expect(computeResponseReserve({ maxTokens: 128_000 })).toBe(DEFAULTS.responseReserveCap);
  });
  test("clamps tiny maxTokens up to the floor", () => {
    expect(computeResponseReserve({ maxTokens: 500 })).toBe(DEFAULTS.responseReserveFloor);
  });
  test("passes through a mid-range value", () => {
    expect(computeResponseReserve({ maxTokens: 8_000 })).toBe(8_000);
  });
  test("missing/zero maxTokens falls back to the cap", () => {
    expect(computeResponseReserve({ maxTokens: 0 })).toBe(DEFAULTS.responseReserveCap);
  });
});

describe("computeInputBudget", () => {
  test("Codex 272k/128k → 234240", () => {
    const budget = computeInputBudget({ contextWindow: 272_000, maxTokens: 128_000 });
    // 272000 - 16000 - ceil(272000 * 0.08)=21760
    expect(budget).toBe(272_000 - 16_000 - 21_760);
  });
  test("never negative for a tiny window", () => {
    expect(computeInputBudget({ contextWindow: 1_000, maxTokens: 500 })).toBeGreaterThanOrEqual(1);
  });
  test("missing contextWindow falls back to 128k baseline", () => {
    const budget = computeInputBudget({ contextWindow: 0, maxTokens: 8_000 });
    expect(budget).toBe(128_000 - 8_000 - Math.ceil(128_000 * 0.08));
  });
});

// ── Registry ─────────────────────────────────────────────────────────

describe("strategy registry", () => {
  test("built-ins registered", () => {
    expect(listCompactionStrategies()).toEqual(expect.arrayContaining(["trim", "none"]));
    expect(getCompactionStrategy("trim").name).toBe("trim");
    expect(getCompactionStrategy("none").name).toBe("none");
  });

  test("unknown name falls back to trim", () => {
    expect(getCompactionStrategy("does-not-exist").name).toBe("trim");
  });

  test("register + retrieve a custom strategy", () => {
    const custom: CompactionStrategy = {
      name: "unit-custom",
      async compact(messages) {
        return { messages, droppedCount: 0, droppedTokens: 0, strategy: "unit-custom" };
      },
    };
    registerCompactionStrategy(custom);
    expect(getCompactionStrategy("unit-custom")).toBe(custom);
  });

  test("none strategy is an exact passthrough", async () => {
    const msgs = [userMsg("a"), asstText("b")];
    const res = await getCompactionStrategy("none").compact(msgs, mkCtx(0));
    expect(res.messages).toBe(msgs);
    expect(res.droppedCount).toBe(0);
  });
});

// ── TrimStrategy ─────────────────────────────────────────────────────

describe("trim strategy", () => {
  const trim = getCompactionStrategy("trim");

  test("keeps a stable oldest anchor + active turn, marker AFTER the anchor", async () => {
    const turns = Array.from({ length: 10 }, (_, i) => userMsg("x".repeat(400) + i));
    // Anchor is opt-in (default 0); this test exercises the anchor feature.
    const res = await trim.compact(turns, mkCtx(300, { ...DEFAULTS, cacheAnchorFraction: 0.5 }));

    // Cache-stable prefix: the OLDEST original turn leads (byte-stable),
    // NOT a per-turn-changing marker.
    expect(isCompactionMarker(res.messages[0])).toBe(false);
    expect(res.messages[0]).toBe(turns[0]);
    // Exactly one marker, and it is NOT at index 0.
    expect(res.messages.filter(isCompactionMarker).length).toBe(1);
    expect(res.messages.findIndex(isCompactionMarker)).toBeGreaterThan(0);
    // Active (last) turn preserved by identity.
    expect(res.messages[res.messages.length - 1]).toBe(turns[turns.length - 1]);
    expect(res.droppedCount).toBeGreaterThan(0);
    // dropped + survivors (survivors = everything except the one marker).
    expect(res.droppedCount).toBe(10 - (res.messages.length - 1));
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(300);
  });

  test("anchor is BYTE-STABLE across consecutive compacted turns (cache survives)", async () => {
    // Turn N history, then the follow-up turn appends an assistant reply +
    // a new user prompt — exactly how a thread grows.
    const turnsN = Array.from({ length: 12 }, (_, i) => userMsg("x".repeat(400) + "_" + i));
    const turnsN1 = [...turnsN, asstText("reply".repeat(80)), userMsg("next question")];

    // Anchor is opt-in (default 0); this test exercises the anchor feature.
    const anchorCfg = { ...DEFAULTS, cacheAnchorFraction: 0.5 };
    const outN = (await trim.compact(turnsN, mkCtx(300, anchorCfg))).messages;
    const outN1 = (await trim.compact(turnsN1, mkCtx(300, anchorCfg))).messages;

    // Both actually compacted (a marker was injected).
    expect(outN.some(isCompactionMarker)).toBe(true);
    expect(outN1.some(isCompactionMarker)).toBe(true);

    // The leading byte-identical run (the provider's reusable cache prefix)
    // is non-empty AND begins at the oldest original turn — so the cached
    // prefix is NOT invalidated by the trim. The naive front-marker trim
    // would put a different-count marker at index 0, collapsing this to 0.
    let shared = 0;
    while (shared < outN.length && shared < outN1.length && outN[shared] === outN1[shared]) {
      shared++;
    }
    expect(shared).toBeGreaterThan(0);
    expect(outN[0]).toBe(turnsN[0]);
    expect(outN1[0]).toBe(turnsN[0]);
  });

  test("cacheAnchorFraction: 0 disables the anchor → marker at the front", async () => {
    const turns = Array.from({ length: 10 }, (_, i) => userMsg("x".repeat(400) + i));
    const cfg = { ...DEFAULTS, cacheAnchorFraction: 0 };
    const ctx: CompactionContext = {
      model: { id: "m", contextWindow: 1, maxTokens: 1 } as any,
      budget: 300,
      cfg,
      estimateTokens: (m) => estimateTokens(m, cfg),
      splitTurnBlocks,
    };
    const res = await trim.compact(turns, ctx);
    expect(isCompactionMarker(res.messages[0])).toBe(true);
    // Recent-only: the active turn is still the last message.
    expect(res.messages[res.messages.length - 1]).toBe(turns[turns.length - 1]);
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(300);
  });

  test("cacheAnchorFraction > 1 is clamped (anchor never exceeds the budget)", async () => {
    const turns = Array.from({ length: 12 }, (_, i) => userMsg("x".repeat(400) + i));
    const cfg = { ...DEFAULTS, cacheAnchorFraction: 5 };
    const ctx: CompactionContext = {
      model: { id: "m", contextWindow: 1, maxTokens: 1 } as any,
      budget: 300,
      cfg,
      estimateTokens: (m) => estimateTokens(m, cfg),
      splitTurnBlocks,
    };
    const res = await trim.compact(turns, ctx);
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(300);
    // Still keeps the oldest turn as a stable anchor.
    expect(res.messages[0]).toBe(turns[0]);
  });

  test("preserves recent context (newest non-active turns kept)", async () => {
    const turns = Array.from({ length: 12 }, (_, i) => userMsg("q".repeat(200) + "#" + i));
    const res = await trim.compact(turns, mkCtx(600));
    // The block immediately before the active turn survives (recent window).
    expect(res.messages).toContain(turns[turns.length - 2]);
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(600);
  });

  test("huge oldest block → empty anchor → marker leads, still fits", async () => {
    const msgs = [
      userMsg("HUGE".repeat(4_000)), // block 0: far bigger than the anchor cap
      userMsg("m1"),
      userMsg("m2"),
      userMsg("active"),
    ];
    const res = await trim.compact(msgs, mkCtx(200));
    expect(isCompactionMarker(res.messages[0])).toBe(true);
    expect(res.messages[res.messages.length - 1]).toBe(msgs[msgs.length - 1]);
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(200);
  });

  test("drops the middle AND truncates an oversized recent tool result", async () => {
    const msgs: Msg[] = [];
    for (let i = 0; i < 6; i++) msgs.push(userMsg("small" + i)); // cheap oldest blocks
    // Active turn carries a giant tool result that alone blows the budget.
    msgs.push(userMsg("final question"));
    msgs.push(asstToolCall("c-big", "search", {}));
    msgs.push(toolResult("c-big", "BIG".repeat(5_000)));
    const res = await trim.compact(msgs, mkCtx(120));

    // A middle turn was dropped (marker present) …
    expect(res.messages.filter(isCompactionMarker).length).toBe(1);
    // … and the oversized tool result was truncated to fit.
    const tr = res.messages.find((m: any) => m.role === "toolResult") as any;
    expect(tr.content[0].text).toContain("truncated to fit context");
    // The user's own prompt text is never mangled.
    const finalUser = res.messages.find(
      (m: any) => m.role === "user" && m.content === "final question",
    );
    expect(finalUser).toBeDefined();
    expect(res.droppedCount).toBeGreaterThan(0);
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(120);
  });

  test("no-op when already within budget", async () => {
    const msgs = [userMsg("a"), asstText("b")];
    const res = await trim.compact(msgs, mkCtx(10_000));
    expect(res.messages).toBe(msgs);
    expect(res.droppedCount).toBe(0);
  });

  test("preserves toolCall/toolResult pairing in survivors", async () => {
    const msgs: Msg[] = [];
    for (let i = 0; i < 8; i++) {
      msgs.push(userMsg("u".repeat(200) + i));
      msgs.push(asstToolCall(`call-${i}`, "search", { q: "z".repeat(200) }));
      msgs.push(toolResult(`call-${i}`, "r".repeat(200)));
      msgs.push(asstText("done" + i));
    }
    const res = await trim.compact(msgs, mkCtx(800));

    const callIds = new Set<string>();
    for (const m of res.messages) {
      if (m.role === "assistant") {
        for (const p of m.content) if (p.type === "toolCall") callIds.add(p.id);
      }
    }
    for (const m of res.messages) {
      if (m.role === "toolResult") {
        expect(callIds.has(m.toolCallId)).toBe(true);
      }
    }
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(800);
  });

  test("degenerate single oversized turn → tool-result truncated, user prompt intact", async () => {
    const msgs = [userMsg("short question"), toolResult("c1", "BIG".repeat(5_000))];
    const res = await trim.compact(msgs, mkCtx(50));

    expect(res.droppedCount).toBe(0);
    expect(res.droppedTokens).toBeGreaterThan(0);
    const user = res.messages.find((m: any) => m.role === "user") as any;
    expect(user.content).toBe("short question");
    const tr = res.messages.find((m: any) => m.role === "toolResult") as any;
    expect(tr.content[0].text).toContain("truncated to fit context");
  });

  test("does not accumulate markers across passes", async () => {
    const turns = Array.from({ length: 8 }, (_, i) => userMsg("y".repeat(400) + i));
    const first = await trim.compact(turns, mkCtx(300));
    const second = await trim.compact(first.messages, mkCtx(300));
    expect(second.messages.filter(isCompactionMarker).length).toBe(1);
  });
});

// ── makeCompactionTransform ──────────────────────────────────────────

describe("makeCompactionTransform", () => {
  test("returns the same array untouched when under budget", async () => {
    const transform = makeCompactionTransform(fakeModel(272_000, 128_000));
    const msgs = [userMsg("hello"), asstText("hi")];
    expect(await transform(msgs)).toBe(msgs);
  });

  test("trims a long history below the computed budget", async () => {
    // Anchor is opt-in (default 0); this test exercises the anchor layout
    // (oldest turn leads, marker relocated after it).
    const transform = makeCompactionTransform(fakeModel(1_000, 1_000), {
      safetyFraction: 0,
      responseReserveFloor: 0,
      responseReserveCap: 0,
      cacheAnchorFraction: 0.5,
    });
    const turns = Array.from({ length: 30 }, (_, i) => userMsg("z".repeat(400) + i));
    const out = await transform(turns);
    expect(out.length).toBeLessThan(turns.length);
    // Cache-stable: the oldest turn leads (byte-stable prefix), not the marker.
    expect(isCompactionMarker(out[0])).toBe(false);
    expect(out[0]).toBe(turns[0]);
    expect(out.some(isCompactionMarker)).toBe(true);
    expect(estimateTokens(out)).toBeLessThanOrEqual(1_000);
  });

  test("honors a custom strategy selected via config", async () => {
    const sentinel = userMsg("SENTINEL");
    registerCompactionStrategy({
      name: "xform-test",
      async compact() {
        return { messages: [sentinel], droppedCount: 99, droppedTokens: 1, strategy: "xform-test" };
      },
    });
    const transform = makeCompactionTransform(fakeModel(10, 0), {
      strategy: "xform-test",
      safetyFraction: 0,
      responseReserveFloor: 0,
      responseReserveCap: 0,
    });
    const out = await transform([userMsg("a".repeat(10_000))]);
    expect(out).toEqual([sentinel]);
  });

  test("fail-open net: a throwing strategy returns the input history unchanged", async () => {
    registerCompactionStrategy({
      name: "xform-throws",
      async compact() {
        throw new Error("strategy boom");
      },
    });
    const transform = makeCompactionTransform(fakeModel(10, 0), {
      strategy: "xform-throws",
      safetyFraction: 0,
      responseReserveFloor: 0,
      responseReserveCap: 0,
    });
    const msgs = [userMsg("a".repeat(10_000))];
    // Over budget → compact() runs → throws → net returns the input verbatim
    // (never throws through transformContext, never fails the turn).
    expect(await transform(msgs)).toBe(msgs);
  });

  test("strategy 'none' leaves an over-budget history unchanged", async () => {
    const transform = makeCompactionTransform(fakeModel(10, 0), {
      strategy: "none",
      safetyFraction: 0,
      responseReserveFloor: 0,
      responseReserveCap: 0,
    });
    const msgs = [userMsg("a".repeat(10_000)), asstText("b".repeat(10_000))];
    expect(await transform(msgs)).toBe(msgs);
  });
});
