/**
 * Unit tests for `finalizeSuccess`'s no-turn-saved fallback after the
 * deterministic-preprocess change (tasks/deterministic-preprocess.md):
 * the "no assistant turn was saved" detection compares
 * `ctx.lastSavedMessageId` against `ctx.turnParentMessageId` (NOT
 * `options.parentMessageId`), and the fallback message parents off
 * `ctx.turnParentMessageId` — so when preprocess chained rows and
 * re-based the turn (user → preprocess-result → …), the fallback
 * bubble still lands on the chain instead of forking off the user
 * message.
 *
 * Pinned branches:
 *   B1 — no preprocess (both fields = the user message id) → fallback
 *        fires, parent = user message. Exact pre-change parity.
 *   B2 — preprocess re-based the parent (both fields = the row id) →
 *        fallback fires, parent = the ROW id.
 *   B3 — a turn WAS saved (lastSavedMessageId advanced past
 *        turnParentMessageId) → no fallback (no duplicate bubble).
 *
 * Style mirrors finalize-error-persist-slot.test.ts: leaf DB sinks
 * mocked via mock.module before the SUT import; the REAL
 * finalizeSuccess runs.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mocked DB sinks (must precede SUT import) ──────────────────────────

interface CreatedMessage {
  conversationId: string;
  role: string;
  content: string;
  runId?: string;
  parentMessageId?: string;
}
const createdMessages: CreatedMessage[] = [];

mock.module("../db/queries/conversations", () => ({
  createMessage: async (
    conversationId: string,
    data: { role: string; content: string; runId?: string; parentMessageId?: string },
  ) => {
    const msg = {
      id: `msg-${createdMessages.length + 1}`,
      conversationId,
      role: data.role,
      content: data.content,
      runId: data.runId,
      parentMessageId: data.parentMessageId,
    };
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

const RUN_ID = "run-fb-1";
const CONV_ID = "conv-fb-1";
const USER_MSG = "user-msg-1";
const PP_ROW = "preprocess-row-1";

function makeCtx(overrides: Partial<StreamChatContext> = {}): StreamChatContext {
  const run: AgentRun = { id: RUN_ID, agentName: "chat", status: "running", startedAt: 1_000, logs: [] };
  return {
    run,
    allTurnsText: "streamed reply text",
    turnText: "",
    dbQueue: Promise.resolve(),
    turnStart: 1_000,
    totalUsage: { input: 0, output: 0 },
    lastSavedMessageId: USER_MSG,
    turnParentMessageId: USER_MSG,
    ...overrides,
  } as unknown as StreamChatContext;
}

function makeHost(): StreamChatHost {
  const bus = new EventBus<AgentEvents>();
  return { bus, persist: true } as unknown as StreamChatHost;
}

beforeEach(() => {
  createdMessages.length = 0;
});

describe("finalizeSuccess — no-turn-saved fallback vs turnParentMessageId", () => {
  test("B1: no preprocess (parity) — fallback fires, parent = user message", async () => {
    const ctx = makeCtx();
    await finalizeSuccess(ctx, makeHost(), CONV_ID, {
      parentMessageId: USER_MSG,
      model: "m",
      provider: "p",
    });
    expect(createdMessages).toHaveLength(1);
    expect(createdMessages[0]).toMatchObject({
      conversationId: CONV_ID,
      role: "assistant",
      content: "streamed reply text",
      parentMessageId: USER_MSG,
    });
    // The fallback save advances lastSavedMessageId to the new row.
    expect(ctx.lastSavedMessageId).toBe("msg-1");
  });

  test("B2: preprocess re-based the turn — fallback parents off the ROW id", async () => {
    // setup-tools moved BOTH fields onto the last preprocess row; the
    // caller's options still carry the ORIGINAL user message id.
    const ctx = makeCtx({ lastSavedMessageId: PP_ROW, turnParentMessageId: PP_ROW });
    await finalizeSuccess(ctx, makeHost(), CONV_ID, {
      parentMessageId: USER_MSG,
      model: "m",
      provider: "p",
    });
    expect(createdMessages).toHaveLength(1);
    // The chain stays intact: user → preprocess-result → assistant.
    expect(createdMessages[0]!.parentMessageId).toBe(PP_ROW);
  });

  test("B3: a turn WAS saved — no fallback, no duplicate bubble", async () => {
    const ctx = makeCtx({ lastSavedMessageId: "assistant-turn-1", turnParentMessageId: PP_ROW });
    await finalizeSuccess(ctx, makeHost(), CONV_ID, {
      parentMessageId: USER_MSG,
    });
    expect(createdMessages).toHaveLength(0);
    expect(ctx.lastSavedMessageId).toBe("assistant-turn-1");
  });

  test("run:complete is emitted on every path (fallback or not)", async () => {
    const host = makeHost();
    const completes: string[] = [];
    host.bus.on("run:complete", (d) => completes.push((d as { run: AgentRun }).run.id));
    await finalizeSuccess(makeCtx(), host, CONV_ID, { parentMessageId: USER_MSG });
    expect(completes).toEqual([RUN_ID]);
  });
});
