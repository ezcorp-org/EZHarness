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
  capStaleToolResults,
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
const toolResultParts = (id: string, content: any[]): Msg => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "t",
  content,
  isError: false,
  timestamp: 1,
});
const imagePart = { type: "image", data: "x", mimeType: "image/png" };

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

// ── Stale tool-result cap ────────────────────────────────────────────

/**
 * The exact wire format of the elision mark, re-declared here on purpose: it
 * is a byte-stability contract (Anthropic's prefix cache), so a careless edit
 * to the marker must fail a test rather than silently bust the cache.
 */
const elided = (n: number) =>
  `\n…[${n} chars of this older tool result elided to cut re-sent context]…\n`;

const trText = (m: Msg): string => m.content[0].text;

describe("capStaleToolResults", () => {
  const cfg = (toolResultCap: number) => ({ ...DEFAULTS, toolResultCap });

  test("caps older tool results and NEVER the newest one", () => {
    const msgs = [
      userMsg("q1"),
      toolResult("c1", "A".repeat(500)),
      userMsg("q2"),
      toolResult("c2", "B".repeat(500)),
      userMsg("q3"),
      toolResult("c3", "C".repeat(500)),
    ];
    const out = capStaleToolResults(msgs, cfg(100));

    // Older two are capped to head+tail …
    expect(trText(out[1])).toBe("A".repeat(50) + elided(400) + "A".repeat(50));
    expect(trText(out[3])).toBe("B".repeat(50) + elided(400) + "B".repeat(50));
    // … the newest is passed through BY IDENTITY (the agent just ran it).
    expect(out[5]).toBe(msgs[5]);
    expect(trText(out[5])).toBe("C".repeat(500));
    // Non-toolResult messages are untouched by identity; length is preserved.
    expect(out.length).toBe(msgs.length);
    expect(out[0]).toBe(msgs[0]);
    expect(out[2]).toBe(msgs[2]);
    // Input array is never mutated.
    expect(trText(msgs[1])).toBe("A".repeat(500));
  });

  test("retains head AND tail — the verdict at the end survives", () => {
    const body = `START${"m".repeat(200)}VERDICT`;
    const msgs = [toolResult("c1", body), userMsg("next"), toolResult("c2", "newest")];
    const out = capStaleToolResults(msgs, cfg(20));
    const text = trText(out[0]);
    expect(text.startsWith("START")).toBe(true);
    expect(text.endsWith("VERDICT")).toBe(true);
    expect(text).toBe(`START${"m".repeat(5)}${elided(192)}${"m".repeat(3)}VERDICT`);
  });

  test("DETERMINISTIC: identical input caps to byte-identical output", () => {
    const build = () => [
      toolResult("c1", "Z".repeat(9_999)),
      userMsg("next"),
      toolResult("c2", "newest"),
    ];
    const first = capStaleToolResults(build(), cfg(64));
    const second = capStaleToolResults(build(), cfg(64));
    expect(trText(first[0])).toBe(trText(second[0]));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Asserted twice: the same value both times, no hidden per-call state.
    const third = capStaleToolResults(build(), cfg(64));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  test("CACHE-STABLE: a stale result caps identically as the thread grows", () => {
    // Turn N, then the same history plus a new turn — the shape that would
    // bust a prefix-matched cache if the capped bytes shifted per turn.
    const stale = () => toolResult("c1", "hist".repeat(5_000));
    const turnN = [userMsg("q1"), stale(), userMsg("q2"), toolResult("c2", "fresh")];
    const turnN1 = [...turnN, userMsg("q3"), toolResult("c3", "newer")];

    const outN = capStaleToolResults(turnN, cfg(256));
    const outN1 = capStaleToolResults(turnN1, cfg(256));

    expect(trText(outN[1])).toBe(trText(outN1[1]));
    // And the leading byte-identical run covers the capped stale result, so
    // the provider's cached prefix survives the growth.
    expect(JSON.stringify(outN.slice(0, 2))).toBe(JSON.stringify(outN1.slice(0, 2)));
  });

  test("cap 0 / negative / NaN disables it → the input array by identity", () => {
    const msgs = [toolResult("c1", "A".repeat(5_000)), userMsg("q"), toolResult("c2", "b")];
    expect(capStaleToolResults(msgs, cfg(0))).toBe(msgs);
    expect(capStaleToolResults(msgs, cfg(-1))).toBe(msgs);
    expect(capStaleToolResults(msgs, cfg(Number.NaN))).toBe(msgs);
    expect(capStaleToolResults(msgs, cfg(Number.POSITIVE_INFINITY))).toBe(msgs);
  });

  test("nothing to cap → the input array by identity", () => {
    // No toolResult at all.
    const none = [userMsg("a"), asstText("b")];
    expect(capStaleToolResults(none)).toBe(none);
    // A single toolResult IS the newest, so it is exempt.
    const one = [userMsg("a"), toolResult("c1", "A".repeat(100_000))];
    expect(capStaleToolResults(one)).toBe(one);
    // Stale but already under the cap.
    const small = [toolResult("c1", "tiny"), userMsg("q"), toolResult("c2", "x")];
    expect(capStaleToolResults(small, cfg(100))).toBe(small);
  });

  test("defaults to a live cap (enabled out of the box)", () => {
    expect(DEFAULTS.toolResultCap).toBeGreaterThan(0);
    const msgs = [
      toolResult("c1", "A".repeat(DEFAULTS.toolResultCap * 4)),
      userMsg("q"),
      toolResult("c2", "b"),
    ];
    const out = capStaleToolResults(msgs);
    expect(trText(out[0]).length).toBeLessThan(DEFAULTS.toolResultCap + 200);
  });

  test("collapses multiple text parts into one, keeping image parts", () => {
    const msgs = [
      toolResultParts("c1", [
        { type: "text", text: "A".repeat(100) },
        imagePart,
        { type: "text", text: "B".repeat(100) },
      ]),
      userMsg("q"),
      toolResult("c2", "newest"),
    ];
    const out = capStaleToolResults(msgs, cfg(50));
    const content = (out[0] as any).content;
    // Parts joined with "\n" → 100 + 1 + 100 = 201 chars, 151 elided.
    expect(content.length).toBe(2);
    expect(content[0].text).toBe("A".repeat(25) + elided(151) + "B".repeat(25));
    expect(content[1]).toBe(imagePart);
  });

  test("an image-only tool result has no text to cap", () => {
    const msgs = [toolResultParts("c1", [imagePart]), userMsg("q"), toolResult("c2", "n")];
    expect(capStaleToolResults(msgs, cfg(1))).toBe(msgs);
  });

  test("never cuts a surrogate pair in half", () => {
    // cap 10 → head 5 / tail 5, both landing mid-emoji.
    const body = `abcd😀${"F".repeat(50)}😀wxyz`;
    const msgs = [toolResult("c1", body), userMsg("q"), toolResult("c2", "newest")];
    const out = capStaleToolResults(msgs, cfg(10));
    const text = trText(out[0]);
    // The orphaned halves are dropped, so 54 (not 52) chars are elided.
    expect(text).toBe(`abcd${elided(54)}wxyz`);
    // No lone surrogate survived (a lone surrogate would not round-trip).
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
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

  test("caps stale tool results while comfortably UNDER budget", async () => {
    // 2 × 200k chars ≈ 100k tokens against a ~234k budget: the existing
    // over-budget truncation never fires, but the stale result is still
    // re-sent on every loop iteration — which is exactly the wasted spend.
    const msgs = [
      userMsg("q1"),
      asstToolCall("c1", "read", {}),
      toolResult("c1", "F".repeat(200_000)),
      asstText("ok"),
      userMsg("q2"),
      asstToolCall("c2", "read", {}),
      toolResult("c2", "G".repeat(200_000)),
    ];
    const transform = makeCompactionTransform(fakeModel(272_000, 128_000));
    expect(estimateTokens(msgs)).toBeLessThan(computeInputBudget(fakeModel(272_000, 128_000)));

    const out = await transform(msgs);

    expect(out).not.toBe(msgs);
    expect(out.length).toBe(msgs.length);
    // No turn was evicted — this is the cap acting alone, not compaction.
    expect(out.some(isCompactionMarker)).toBe(false);
    expect(trText(out[2])).toContain("elided to cut re-sent context");
    expect(trText(out[2]).length).toBeLessThan(DEFAULTS.toolResultCap + 200);
    // Newest tool result kept in full, by identity.
    expect(out[6]).toBe(msgs[6]);
    expect(estimateTokens(out)).toBeLessThan(estimateTokens(msgs));
  });

  test("toolResultCap 0 leaves an under-budget history byte-identical", async () => {
    const msgs = [
      toolResult("c1", "F".repeat(200_000)),
      userMsg("q2"),
      toolResult("c2", "G".repeat(200_000)),
    ];
    const off = makeCompactionTransform(fakeModel(272_000, 128_000), { toolResultCap: 0 });
    expect(await off(msgs)).toBe(msgs);
    // …and it is strategy-independent: 'none' does NOT switch the cap off.
    const on = makeCompactionTransform(fakeModel(272_000, 128_000), { strategy: "none" });
    const out = await on(msgs);
    expect(out).not.toBe(msgs);
    expect(trText(out[0])).toContain("elided to cut re-sent context");
  });

  test("running ahead of the budget check, the cap can avert compaction", async () => {
    const model = fakeModel(272_000, 128_000);
    const budget = computeInputBudget(model);
    const msgs = [
      toolResult("c1", "F".repeat(1_200_000)), // ~300k tokens on its own
      userMsg("q2"),
      toolResult("c2", "small"),
    ];
    // Genuinely over budget BEFORE the cap …
    expect(estimateTokens(msgs)).toBeGreaterThan(budget);

    const out = await makeCompactionTransform(model)(msgs);

    // … and under it after, so no turn had to be evicted at all.
    expect(estimateTokens(out)).toBeLessThanOrEqual(budget);
    expect(out.some(isCompactionMarker)).toBe(false);
    expect(out.length).toBe(msgs.length);
    expect(trText(out[0])).toContain("elided to cut re-sent context");
  });

  test("the strategy receives already-capped history", async () => {
    let seen: Msg[] = [];
    registerCompactionStrategy({
      name: "xform-records",
      async compact(messages) {
        seen = messages as Msg[];
        return { messages, droppedCount: 0, droppedTokens: 0, strategy: "xform-records" };
      },
    });
    const transform = makeCompactionTransform(fakeModel(10, 0), {
      strategy: "xform-records",
      safetyFraction: 0,
      responseReserveFloor: 0,
      responseReserveCap: 0,
      toolResultCap: 100,
    });
    const msgs = [
      toolResult("c1", "A".repeat(5_000)),
      userMsg("q"),
      toolResult("c2", "B".repeat(5_000)),
    ];
    await transform(msgs);

    expect(trText(seen[0])).toBe("A".repeat(50) + elided(4_900) + "A".repeat(50));
    // The newest is still whole when the strategy runs — capping is the cost
    // control, evicting/truncating it is the strategy's own call.
    expect(seen[2]).toBe(msgs[2]);
  });

  test("cap + the over-budget emergency truncation compose", async () => {
    // Even after capping, this history is far over a 1k budget, so trim also
    // evicts turns and the backstop truncates the newest result — which the
    // cap deliberately left whole.
    const msgs: Msg[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(userMsg("u".repeat(50) + i));
      msgs.push(asstToolCall("c" + i, "read", {}));
      msgs.push(toolResult("c" + i, "BIG".repeat(2_000)));
    }
    const transform = makeCompactionTransform(fakeModel(1_000, 1_000), {
      safetyFraction: 0,
      responseReserveFloor: 0,
      responseReserveCap: 0,
      toolResultCap: 400,
    });
    const out = await transform(msgs);

    // The trim strategy evicted turns …
    expect(out.filter(isCompactionMarker).length).toBe(1);
    // … and it is the EMERGENCY backstop, not the cap, that finally shrinks
    // the newest tool result (the cap never touches it, at any budget).
    const last = out[out.length - 1] as any;
    expect(last.role).toBe("toolResult");
    expect(trText(last)).toContain("truncated to fit context");
    expect(trText(last)).not.toContain("elided to cut re-sent context");
    expect(estimateTokens(out)).toBeLessThanOrEqual(1_000);
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
