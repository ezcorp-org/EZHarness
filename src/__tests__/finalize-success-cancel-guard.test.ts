/**
 * Regression test: `finalizeSuccess` must skip entirely when the run was
 * already cancelled — the same `run.status === "cancelled"` guard
 * `finalizeError` has.
 *
 * The race: the LLM stream completes cleanly and `streamChat` proceeds to
 * `finalizeSuccess`, but a user Stop landed first — `cancelRun` already set
 * `run.status = "cancelled"` and emitted `run:cancel` (the terminal event).
 * Without the guard, finalizeSuccess overwrites the status back to
 * "success" (so `finalizeCleanup` persists a success row for a cancelled
 * run) and emits a SECOND terminal event (`run:complete`) for the same run.
 *
 * Style mirrors finalize-fallback-parent.test.ts: leaf DB sinks mocked via
 * mock.module before the SUT import; the REAL finalizeSuccess runs.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mocked DB sinks (must precede SUT import) ──────────────────────────

const createdMessages: Array<{ conversationId: string; content: string }> = [];

mock.module("../db/queries/conversations", () => ({
  createMessage: async (conversationId: string, data: { content: string }) => {
    const msg = { id: `msg-${createdMessages.length + 1}`, conversationId, content: data.content };
    createdMessages.push(msg);
    return msg;
  },
}));

// finalizeSuccess re-anchors orphaned tool_calls via getDb().update(...).
const chainNoop = {
  update: () => chainNoop,
  set: () => chainNoop,
  where: async () => undefined,
};
mock.module("../db/connection", () => ({
  getDb: () => chainNoop,
}));

import { finalizeSuccess } from "../runtime/stream-chat/finalize";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import type { StreamChatContext } from "../runtime/stream-chat/context";

const RUN_ID = "run-cg-1";
const CONV_ID = "conv-cg-1";
const USER_MSG = "user-msg-1";

function makeCtx(status: AgentRun["status"]): StreamChatContext {
  const run: AgentRun = {
    id: RUN_ID,
    agentName: "chat",
    status,
    startedAt: 1_000,
    logs: [],
  };
  if (status === "cancelled") {
    // Mirror what cancelRun records at its terminal transition.
    run.result = { success: true, output: { fullText: "partial text", partial: true } };
    run.finishedAt = 2_000;
  }
  return {
    run,
    allTurnsText: "streamed reply text",
    turnText: "",
    dbQueue: Promise.resolve(),
    turnStart: 1_000,
    totalUsage: { input: 0, output: 0 },
    lastSavedMessageId: USER_MSG,
    turnParentMessageId: USER_MSG,
  } as unknown as StreamChatContext;
}

function makeHost(): { host: StreamChatHost; events: string[] } {
  const bus = new EventBus<AgentEvents>();
  const events: string[] = [];
  bus.on("run:complete", () => events.push("run:complete"));
  bus.on("run:status", () => events.push("run:status"));
  bus.on("obs:turn", () => events.push("obs:turn"));
  return { host: { bus, persist: true } as unknown as StreamChatHost, events };
}

beforeEach(() => {
  createdMessages.length = 0;
});

describe("finalizeSuccess — cancelled-run guard (Stop racing a clean completion)", () => {
  test("cancelled run: status/result/finishedAt untouched, no events, no fallback save", async () => {
    const ctx = makeCtx("cancelled");
    const { host, events } = makeHost();

    await finalizeSuccess(ctx, host, CONV_ID, { parentMessageId: USER_MSG });

    // cancelRun's terminal record survives verbatim.
    expect(ctx.run.status).toBe("cancelled");
    expect(ctx.run.result).toEqual({
      success: true,
      output: { fullText: "partial text", partial: true },
    });
    expect(ctx.run.finishedAt).toBe(2_000);
    // No second terminal event and no lifecycle chatter for a dead run.
    expect(events).toEqual([]);
    // The no-turn-saved fallback must not write an assistant bubble either.
    expect(createdMessages).toHaveLength(0);
  });

  test("control: a running run still finalizes to success and emits run:complete", async () => {
    const ctx = makeCtx("running");
    const { host, events } = makeHost();

    await finalizeSuccess(ctx, host, CONV_ID, { parentMessageId: USER_MSG });

    expect(ctx.run.status).toBe("success");
    expect(events).toContain("run:complete");
    expect(createdMessages).toHaveLength(1);
  });
});
