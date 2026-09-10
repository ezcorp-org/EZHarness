import { describe, expect, test } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createStreamChatContext } from "../runtime/stream-chat/context";
import { EventBus } from "../runtime/events";
import { WatchdogManager } from "../runtime/executor-watchdog";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import type { AgentEvents } from "../types";
import { subscribeBridge } from "../runtime/stream-chat/subscribe-bridge";

function makeAgent(): { agent: Agent; emit(event: unknown): void } {
  let listener: (event: unknown) => void = () => {};
  const agent = Object.create(null) as Agent;
  Object.assign(agent, {
    subscribe(next: (event: unknown) => void) {
      listener = next;
      return () => {};
    },
  });
  return { agent, emit: (event) => listener(event) };
}

function makeHost(): StreamChatHost {
  const bus = new EventBus<AgentEvents>();
  const runs = new Map();
  const controllers = new Map();
  const activeAgents = new Map();
  const runConversations = new Map();
  const pendingPermissions = new Map();
  const errorMessagePersisted = new Set<string>();
  return {
    bus,
    persist: false,
    pendingPermissions,
    controllers,
    runConversations,
    activeAgents,
    runs,
    watchdog: new WatchdogManager({ bus, persist: false, pendingPermissions, controllers, runConversations, activeAgents, runs, errorMessagePersisted }),
    errorMessagePersisted,
    stateMediator: undefined,
    spawnQuota: {} as StreamChatHost["spawnQuota"],
    executor: {} as StreamChatHost["executor"],
    permissionEngine: {} as StreamChatHost["permissionEngine"],
  };
}

describe("subscribeBridge provider errors", () => {
  test("retains an actual terminal assistant provider error for failover", () => {
    const ctx = createStreamChatContext(
      { id: "run-provider-error" } as Parameters<typeof createStreamChatContext>[0],
      new AbortController(),
      undefined,
    );
    const { agent, emit } = makeAgent();

    subscribeBridge(ctx, makeHost(), agent, "conv-provider-error", {}, null);
    emit({
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
