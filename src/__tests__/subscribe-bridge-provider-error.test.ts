import { describe, expect, test } from "bun:test";
import type { StreamChatContext } from "../runtime/stream-chat/context";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import { subscribeBridge } from "../runtime/stream-chat/subscribe-bridge";

function makeAgent() {
  let listener: (event: unknown) => void = () => {};
  return {
    subscribe(next: (event: unknown) => void) {
      listener = next;
      return () => {};
    },
    emit(event: unknown) {
      listener(event);
    },
  };
}

function makeContext(): StreamChatContext {
  return {
    run: { id: "run-provider-error" },
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
    emittedToClient: false,
    providerErrorMessage: undefined,
    lastSavedMessageId: null,
    turnParentMessageId: null,
    dbQueue: Promise.resolve(),
    totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as StreamChatContext;
}

function makeHost(): StreamChatHost {
  return {
    bus: { emit: () => {}, on: () => () => {} },
    persist: false,
    pendingPermissions: new Map(),
    controllers: new Map(),
    runConversations: new Map(),
    activeAgents: new Map(),
    runs: new Map(),
    watchdog: { bumpActivity: () => {}, noteToolStart: () => {}, noteToolEnd: () => {} },
    stateMediator: undefined,
    spawnQuota: {} as StreamChatHost["spawnQuota"],
    executor: {} as StreamChatHost["executor"],
  } as StreamChatHost;
}

describe("subscribeBridge provider errors", () => {
  test("retains an actual terminal assistant provider error for failover", () => {
    const ctx = makeContext();
    const agent = makeAgent();

    subscribeBridge(ctx, makeHost(), agent as never, "conv-provider-error", {}, null);
    agent.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "400: context_length_exceeded",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });

    expect(ctx.providerErrorMessage).toBe("400: context_length_exceeded");
  });
});
