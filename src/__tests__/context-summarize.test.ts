/**
 * Unit tests for the `summarize` context-compaction strategy
 * (`src/runtime/stream-chat/context-summarize.ts`).
 *
 * Part A drives the strategy through an INJECTED `ctx.summarize` stub so
 * the cut-point / assembly / fail-open-to-trim logic is deterministic with
 * no LLM. Part B exercises the default `makeSummarizer` LLM path with the
 * compat `complete` + settings + credentials + router modules mocked, so
 * pi's real `generateSummary` runs but never touches the network.
 */
import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  DEFAULTS,
  estimateTokens,
  splitTurnBlocks,
  getCompactionStrategy,
  isCompactionMarker,
  type CompactionContext,
  type SummarizeFn,
} from "../runtime/stream-chat/context-compaction";

// ── Mocks for the default-summarizer path (Part B) ───────────────────
// Mutable per-test overrides, read by the mock closures below.
let settingValue: unknown;
let completeImpl: (m: any, ctx: any, o: any) => Promise<any>;
let resolveModelImpl: (p?: string, m?: string) => Promise<any>;
let getCredentialImpl: (p: string, c?: string) => Promise<any>;
let credentialProviders: string[];
let resolveModelArgs: Array<[string | undefined, string | undefined]>;

mock.module("@earendil-works/pi-ai/compat", () => ({
  complete: (m: any, ctx: any, o: any) => completeImpl(m, ctx, o),
}));
mock.module("../db/queries/settings", () => ({
  getSetting: async (_key: string) => settingValue,
}));
mock.module("../providers/router", () => ({
  resolveModel: (p?: string, m?: string) => {
    resolveModelArgs.push([p, m]);
    return resolveModelImpl(p, m);
  },
}));
mock.module("../providers/credentials", () => ({
  getCredential: (p: string, c?: string) => {
    credentialProviders.push(p);
    return getCredentialImpl(p, c);
  },
}));

const { makeSummarizer } = await import("../runtime/stream-chat/context-summarize");

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  settingValue = undefined;
  completeImpl = async () => okAssistant("DEFAULT SUMMARY");
  resolveModelImpl = async () => {
    throw new Error("resolveModel not stubbed");
  };
  getCredentialImpl = async () => ({ type: "apikey", token: "tok" });
  credentialProviders = [];
  resolveModelArgs = [];
});

// ── Fixtures ─────────────────────────────────────────────────────────

type Msg = any;
const userMsg = (text: string): Msg => ({ role: "user", content: text, timestamp: 1 });
const asstText = (text: string): Msg => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 1,
});

const okAssistant = (text: string): any => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "x", provider: "x", model: "m", usage: { input: 0, output: 0 }, stopReason: "stop", timestamp: 1,
});
const errAssistant = (): any => ({
  role: "assistant",
  content: [],
  api: "x", provider: "x", model: "m", usage: { input: 0, output: 0 }, stopReason: "error", errorMessage: "boom", timestamp: 1,
});

const summarize = getCompactionStrategy("summarize");

const mkCtx = (
  budget: number,
  summarizeFn: SummarizeFn | undefined,
  cfgOverride: Partial<typeof DEFAULTS> = {},
): CompactionContext => {
  const cfg = { ...DEFAULTS, ...cfgOverride };
  return {
    model: { id: "m", contextWindow: 1, maxTokens: 1 } as any,
    budget,
    cfg,
    estimateTokens: (m) => estimateTokens(m, cfg),
    splitTurnBlocks,
    summarize: summarizeFn,
  };
};

// ── Part A: strategy logic (injected summarize stub) ─────────────────

describe("SummarizeStrategy", () => {
  test("registered under 'summarize'", () => {
    expect(summarize.name).toBe("summarize");
  });

  test("no summarizer wired → delegates to trim", async () => {
    const msgs = Array.from({ length: 5 }, (_, i) => userMsg("q".repeat(104) + i));
    const res = await summarize.compact(msgs, mkCtx(120, undefined));
    expect(res.strategy).toBe("trim");
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(120);
  });

  test("only the active turn (≤1 block) → delegates to trim without summarizing", async () => {
    const boom: SummarizeFn = async () => {
      throw new Error("must not summarize a single turn");
    };
    const res = await summarize.compact([userMsg("only turn")], mkCtx(1, boom));
    expect(res.strategy).toBe("trim");
  });

  test("summarizes the older body + keeps the recent verbatim window", async () => {
    const stub: SummarizeFn = async (toSummarize) => `SUMMARY of ${toSummarize.length}`;
    const msgs = Array.from({ length: 5 }, (_, i) => userMsg("q".repeat(104) + i));
    const active = msgs[4];
    const res = await summarize.compact(msgs, mkCtx(120, stub, { summarizeMaxTokens: 50 }));

    expect(res.strategy).toBe("summarize");
    expect(res.droppedCount).toBe(4);
    expect(res.droppedTokens).toBeGreaterThan(0);
    // The summary marker leads, carries the summary text, and is a stripped
    // context-note marker so it never accumulates.
    expect(isCompactionMarker(res.messages[0]!)).toBe(true);
    expect((res.messages[0] as any).content).toContain("SUMMARY of 4");
    // The active turn is preserved verbatim as the tail.
    expect(res.messages[res.messages.length - 1]).toBe(active);
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(120);
  });

  test("summarizer returns null (failure) → falls open to trim", async () => {
    const stub: SummarizeFn = async () => null;
    const msgs = Array.from({ length: 5 }, (_, i) => userMsg("q".repeat(104) + i));
    const res = await summarize.compact(msgs, mkCtx(120, stub, { summarizeMaxTokens: 50 }));
    expect(res.strategy).toBe("trim");
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(120);
  });

  test("recent window absorbs the whole body (nothing to summarize) → trim", async () => {
    const boom: SummarizeFn = async () => {
      throw new Error("must not summarize when the body fits the recent window");
    };
    // Huge budget: the two small turns both fit the recent window, so the
    // droppable body is empty and the strategy defers to trim.
    const res = await summarize.compact([userMsg("a"), userMsg("b")], mkCtx(10_000, boom));
    expect(res.strategy).toBe("trim");
  });

  test("summary + recent still over budget → falls open to trim", async () => {
    const huge: SummarizeFn = async () => "X".repeat(8_000);
    const msgs = Array.from({ length: 5 }, (_, i) => userMsg("q".repeat(104) + i));
    const res = await summarize.compact(msgs, mkCtx(120, huge, { summarizeMaxTokens: 50 }));
    expect(res.strategy).toBe("trim");
    expect(estimateTokens(res.messages)).toBeLessThanOrEqual(120);
  });
});

// ── Part B: default LLM summarizer (makeSummarizer) ──────────────────

const turnModel = { id: "turn", provider: "openai", maxTokens: 8_000 } as any;
const summarizeInput = [userMsg("hello world"), asstText("hi there")];
const opts = { reserveTokens: 1_024 };

describe("makeSummarizer", () => {
  test("summarizes via generateSummary, memoizes, and uses the turn model by default", async () => {
    completeImpl = async () => okAssistant("MEMO SUMMARY");
    const fn = makeSummarizer(turnModel, "conv-A");

    const first = await fn(summarizeInput, opts);
    expect(first).toBe("MEMO SUMMARY");
    // Default (no summarizeModel setting) resolves the turn model's provider.
    expect(credentialProviders).toEqual(["openai"]);

    // Second call with the same cut point is served from the memo — the LLM
    // is not called again (a throwing complete would surface otherwise).
    completeImpl = async () => {
      throw new Error("memo miss — should not re-summarize");
    };
    const second = await fn(summarizeInput, opts);
    expect(second).toBe("MEMO SUMMARY");
  });

  test("uses the compaction:summarizeModel setting when set + resolvable", async () => {
    settingValue = "anthropic/claude-x";
    resolveModelImpl = async () => ({ provider: "anthropic", piModel: { id: "claude-x", provider: "anthropic", maxTokens: 4_000 } });
    completeImpl = async () => okAssistant("PICKED SUMMARY");

    const fn = makeSummarizer(turnModel, "conv-B");
    const out = await fn(summarizeInput, opts);

    expect(out).toBe("PICKED SUMMARY");
    expect(resolveModelArgs).toEqual([["anthropic", "claude-x"]]);
    expect(credentialProviders).toEqual(["anthropic"]);
  });

  test("falls back to the turn model when the picked summarizeModel fails to resolve", async () => {
    settingValue = "bogus/model";
    resolveModelImpl = async () => {
      throw new Error("no such model");
    };
    completeImpl = async () => okAssistant("FALLBACK SUMMARY");

    const fn = makeSummarizer(turnModel, "conv-C");
    const out = await fn(summarizeInput, opts);

    expect(out).toBe("FALLBACK SUMMARY");
    // Resolve was attempted, then it fell back to the turn model's provider.
    expect(resolveModelArgs).toEqual([["bogus", "model"]]);
    expect(credentialProviders).toEqual(["openai"]);
  });

  test("ignores a malformed summarizeModel (no '/') and uses the turn model", async () => {
    settingValue = "no-slash-here";
    completeImpl = async () => okAssistant("TURN SUMMARY");
    const fn = makeSummarizer(turnModel, "conv-D");
    const out = await fn(summarizeInput, opts);
    expect(out).toBe("TURN SUMMARY");
    expect(resolveModelArgs).toEqual([]);
    expect(credentialProviders).toEqual(["openai"]);
  });

  test("generateSummary error result → null (strategy will fall open to trim)", async () => {
    completeImpl = async () => errAssistant();
    const fn = makeSummarizer(turnModel, "conv-E");
    expect(await fn(summarizeInput, opts)).toBeNull();
  });

  test("a thrown LLM call → null", async () => {
    completeImpl = async () => {
      throw new Error("provider down");
    };
    const fn = makeSummarizer(turnModel, "conv-F");
    expect(await fn(summarizeInput, opts)).toBeNull();
  });

  test("an empty/whitespace summary → null", async () => {
    completeImpl = async () => okAssistant("   \n  ");
    const fn = makeSummarizer(turnModel, "conv-G");
    expect(await fn(summarizeInput, opts)).toBeNull();
  });

  test("the memo is bounded: the oldest entry is evicted past the cap", async () => {
    // Fill well past the 256-entry cap with distinct conversation keys.
    for (let i = 0; i < 260; i++) {
      completeImpl = async () => okAssistant(`S${i}`);
      await makeSummarizer(turnModel, `evict-${i}`)(summarizeInput, opts);
    }
    // conv `evict-0` was inserted first, so it has been evicted: re-requesting
    // it MISSES the memo and re-summarizes (returns the fresh value).
    completeImpl = async () => okAssistant("REFRESHED");
    const out = await makeSummarizer(turnModel, "evict-0")(summarizeInput, opts);
    expect(out).toBe("REFRESHED");
  });
});
