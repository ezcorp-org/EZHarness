// sample-loop — unit tests for the reference Loop example.
//
// Drives the loop body (`summarizeAct`) with a hand-built `ctx` (mock
// `llm` / `recentMessages`) so the act logic is covered without a live
// channel. Registration is asserted separately. The full trigger →
// store → artifact path is covered by the integration test
// (index.integration.test.ts), which spawns the real subprocess.

import { test, expect, describe } from "bun:test";
import type { LoopActContext, LoopCheckContext, LoopMessage } from "@ezcorp/sdk/runtime";
import { defineSampleLoop, summarizeAct, summarizeCheck } from "./index";

function makeCtx(
  overrides: {
    conversationId?: string;
    settings?: Record<string, unknown>;
    messages?: LoopMessage[];
    completion?: string;
  } = {},
): LoopActContext<{ conversationId?: string }> {
  const messages = overrides.messages ?? [
    { id: "m1", role: "user", content: "hi" },
    { id: "m2", role: "assistant", content: "hello there" },
  ];
  return {
    fire: {
      id: "fire-1",
      firedAt: "2026-06-18T00:00:00.000Z",
      trigger: { kind: "event", event: "run:complete" },
      catchUp: false,
    },
    input: { conversationId: overrides.conversationId ?? "conv-1" },
    settings: overrides.settings ?? {},
    llm: {
      complete: async () => ({
        content: overrides.completion ?? "A short chat.",
        blocks: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop" as const,
        model: "m",
      }),
    } as never,
    recentMessages: async () => messages,
    formatMessages: (m) => m.map((x) => `[${x.id}] ${x.role}: ${x.content}`).join("\n\n"),
    spawn: (async () => {
      throw new Error("spawn not used");
    }) as never,
    log: () => {},
  };
}

describe("summarizeAct", () => {
  test("happy path → terminal with the trimmed summary", async () => {
    const result = await summarizeAct(makeCtx({ completion: "  Discussed greetings.  " }));
    expect(result).toEqual({
      kind: "terminal",
      status: "done",
      outcome: { conversationId: "conv-1", summary: "Discussed greetings." },
    });
  });

  test("no conversationId → skip (the retained type-narrowing gate)", async () => {
    const ctx = makeCtx();
    ctx.input = {};
    expect(await summarizeAct(ctx)).toEqual({ kind: "skip", reason: "no_conversation" });
  });

  test("empty conversation → skip (LLM not called)", async () => {
    let called = false;
    const ctx = makeCtx({ messages: [] });
    ctx.llm = {
      complete: async () => {
        called = true;
        return { content: "x", blocks: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" as const, model: "m" };
      },
    } as never;
    expect(await summarizeAct(ctx)).toEqual({ kind: "skip", reason: "empty" });
    expect(called).toBe(false);
  });

  test("settings provider/model override is threaded to the LLM call", async () => {
    let seen: { provider?: string; model?: string } = {};
    const ctx = makeCtx({ settings: { provider: "openai", model: "gpt-4o-mini" } });
    ctx.llm = {
      complete: async (opts: { provider: string; model: string }) => {
        seen = { provider: opts.provider, model: opts.model };
        return { content: "ok", blocks: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" as const, model: "m" };
      },
    } as never;
    await summarizeAct(ctx);
    expect(seen).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });
});

describe("summarizeCheck", () => {
  function makeCheckCtx(
    input: { conversationId?: string },
    settings: Record<string, unknown> = {},
  ): LoopCheckContext<{ conversationId?: string }> {
    return {
      input,
      settings,
      fire: {
        id: "fire-1",
        firedAt: "2026-06-18T00:00:00.000Z",
        trigger: { kind: "event", event: "run:complete" },
        catchUp: false,
      },
      cursor: { get: async () => undefined, set: async () => {} },
      fetch: (async () => new Response("")) as unknown as typeof fetch,
      log: () => {},
    };
  }

  test("enabled=false → proceed:false (settings_disabled)", async () => {
    expect(await summarizeCheck(makeCheckCtx({ conversationId: "c1" }, { enabled: false }))).toEqual({
      proceed: false,
      reason: "settings_disabled",
    });
  });

  test("no conversationId → proceed:false (no_conversation)", async () => {
    expect(await summarizeCheck(makeCheckCtx({}))).toEqual({
      proceed: false,
      reason: "no_conversation",
    });
  });

  test("enabled + conversationId → proceed:true", async () => {
    expect(await summarizeCheck(makeCheckCtx({ conversationId: "c1" }))).toEqual({ proceed: true });
  });
});

describe("defineSampleLoop", () => {
  test("registers without throwing (import.meta.main is false under test)", () => {
    expect(() => defineSampleLoop()).not.toThrow();
  });
});
