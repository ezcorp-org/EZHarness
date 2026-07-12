/**
 * P3 live-append seams (design §5): with the history-producer flag ON, the
 * subscribe-bridge mirrors each saved turn into the pi session tree.
 *
 *  - turn_end: the persisted assistant row lands as a `message` entry keyed
 *    by the row id (mirror invariant), parented on the same structural
 *    parent the messages row got.
 *  - message_start (steer reconcile): the reconciled steer row lands at its
 *    injection position so the session chain matches the reparented messages
 *    chain.
 *
 * Uses a REAL test DB (no mocked createMessage/getDb) so the entries are
 * actually persisted and read back through the session.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { runs } from "../db/schema";

mockDbConnection();

const { subscribeBridge } = await import("../runtime/stream-chat/subscribe-bridge");
const { createProject } = await import("../db/queries/projects");
const { createConversation, createMessage } = await import("../db/queries/conversations");
const { backfillSessionForConversation } = await import("../db/session-backfill");
const { ExtensionRegistry } = await import("../extensions/registry");

import type { StreamChatContext } from "../runtime/stream-chat/context";
import type { StreamChatHost } from "../runtime/stream-chat/host";

function makeBus() {
  return { emit: () => {}, on: () => () => {} } as any;
}

function makePiAgent() {
  let cb: (e: any) => void = () => {};
  return {
    subscribe(fn: (e: any) => void) { cb = fn; return () => {}; },
    fire(e: any) { cb(e); },
  };
}

function makeCtx(initialLeaf: string | null): StreamChatContext {
  return {
    run: { id: "run-1" } as any,
    controller: new AbortController(),
    system: undefined,
    agentTools: [],
    toolAbortControllers: new Map(),
    builtinToolDefsMap: new Map(),
    unsubModeChange: undefined,
    allTurnsText: "",
    turnText: "",
    turnThinking: "",
    turnHasToolCalls: false,
    pendingToolArgs: new Map(),
    unsub: undefined,
    unsubAgentActivity: [],
    lastSavedMessageId: initialLeaf,
    dbQueue: Promise.resolve(),
    totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as any,
  } as unknown as StreamChatContext;
}

function makeHost(bus: any, executor: any): StreamChatHost {
  return {
    bus,
    persist: true,
    pendingPermissions: new Map(),
    controllers: new Map(),
    runConversations: new Map(),
    activeAgents: new Map(),
    runs: new Map(),
    watchdog: { bumpActivity: () => {}, noteToolStart: () => {}, noteToolEnd: () => {} } as any,
    stateMediator: undefined,
    spawnQuota: {} as any,
    executor,
    errorMessagePersisted: new Set<string>(),
    permissionEngine: {} as any,
  };
}

function assistantTurn(text: string) {
  return { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1 } } };
}

async function sessionEntryIds(convId: string): Promise<string[]> {
  const storage = await backfillSessionForConversation(convId);
  return (await storage.getEntries()).filter((e) => e.type === "message").map((e) => e.id);
}

describe("subscribe-bridge live session append (flag ON)", () => {
  beforeEach(async () => {
    await setupTestDb();
    ExtensionRegistry.resetInstance();
    // messages.run_id → runs(id) FK: the turn_end save parents on run.id.
    await getTestDb().insert(runs).values({ id: "run-1", agentName: "t", status: "running", startedAt: new Date() });
  }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("turn_end appends the assistant turn as a session message entry", async () => {
    const project = await createProject({ name: "SA", path: "/tmp/sa" });
    const conv = await createConversation(project.id, { title: "t" });
    const u1 = await createMessage(conv.id, { role: "user", content: "hi" });
    await backfillSessionForConversation(conv.id); // session now exists (holds u1)

    const ctx = makeCtx(u1.id);
    const piAgent = makePiAgent();
    subscribeBridge(ctx, makeHost(makeBus(), {}), piAgent as any, conv.id, { sessionHistoryProducer: true }, null);

    piAgent.fire({ type: "turn_start" });
    piAgent.fire(assistantTurn("the answer"));
    await ctx.dbQueue;

    const assistantId = ctx.lastSavedMessageId!;
    expect(assistantId).not.toBe(u1.id); // a new assistant row was saved
    const ids = await sessionEntryIds(conv.id);
    expect(ids).toContain(u1.id);
    expect(ids).toContain(assistantId); // the assistant turn is now in the session tree
  });

  test("flag OFF → no session append (assistant row persisted, session untouched)", async () => {
    const project = await createProject({ name: "SAoff", path: "/tmp/saoff" });
    const conv = await createConversation(project.id, { title: "t" });
    const u1 = await createMessage(conv.id, { role: "user", content: "hi" });
    await backfillSessionForConversation(conv.id);

    const ctx = makeCtx(u1.id);
    const piAgent = makePiAgent();
    // No sessionHistoryProducer flag → append seam is a strict no-op.
    subscribeBridge(ctx, makeHost(makeBus(), {}), piAgent as any, conv.id, {}, null);
    piAgent.fire({ type: "turn_start" });
    piAgent.fire(assistantTurn("answer"));
    await ctx.dbQueue;

    const assistantId = ctx.lastSavedMessageId!;
    const ids = await sessionEntryIds(conv.id);
    expect(ids).toContain(u1.id);
    expect(ids).not.toContain(assistantId); // untouched by the OFF run
  });

  test("message_start steer reconcile appends the steer row at its injection position", async () => {
    const project = await createProject({ name: "SS", path: "/tmp/ss" });
    const conv = await createConversation(project.id, { title: "t" });
    const u1 = await createMessage(conv.id, { role: "user", content: "hi" });
    await backfillSessionForConversation(conv.id);
    // The caller persisted a steer row up-front (agent-chat pattern).
    const steerRow = await createMessage(conv.id, { role: "user", content: "steer!", parentMessageId: u1.id });

    let consumed = false;
    const executor = {
      consumeSteerPersistedId: (_runId: string, message: any) => {
        if (consumed || message?.content !== "steer!") return undefined;
        consumed = true;
        return steerRow.id;
      },
    };

    const ctx = makeCtx(u1.id);
    const piAgent = makePiAgent();
    subscribeBridge(ctx, makeHost(makeBus(), executor), piAgent as any, conv.id, { sessionHistoryProducer: true }, null);

    piAgent.fire({ type: "message_start", message: { role: "user", content: "steer!", timestamp: 1 } });
    await ctx.dbQueue;

    expect(ctx.lastSavedMessageId).toBe(steerRow.id);
    const ids = await sessionEntryIds(conv.id);
    expect(ids).toContain(steerRow.id); // steer mirrored into the session tree
  });
});
