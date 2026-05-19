// Locks in the no-swallow contract from audit fix #5:
// when `registry.getProcessIfRunning(extId)` throws for one subscriber,
// the dispatch loop must still deliver to the next wired subscriber.
//
// The pre-fix code had `try { ... } catch { continue; }` with no log —
// behavior-wise this test already holds for the new code, but the test
// exists so a future regression to `try { ... } catch { return; }` or
// similar would fail loudly.

import { test, expect, describe } from "bun:test";
import { EventBus } from "../runtime/events";
import { EventSubscriptionDispatcher } from "../extensions/event-subscription-dispatcher";
import type { AgentEvents } from "../types";

interface SendCall { method: string; params: Record<string, unknown> }

function mockProc() {
  const calls: SendCall[] = [];
  return {
    isRunning: true,
    calls,
    sendNotification(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params: params ?? {} });
    },
  };
}

describe("EventSubscriptionDispatcher — error logging (no silent swallow)", () => {
  test("getProcessIfRunning throw → loop continues and delivers to next subscriber", async () => {
    const bus = new EventBus<AgentEvents>();
    const goodProc = mockProc();

    const registry = {
      getProcessIfRunning(extensionId: string) {
        if (extensionId === "ext-throws") throw new Error("boom-from-registry");
        if (extensionId === "ext-good") return goodProc;
        return null;
      },
    } as never;

    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      registry,
      async () => ["ext-throws", "ext-good"],
    );
    dispatcher.registerExtension("ext-throws", ["task:snapshot"]);
    dispatcher.registerExtension("ext-good", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:snapshot", {
      conversationId: "c1",
      tasks: [],
      activeTaskId: undefined,
    } as AgentEvents["task:snapshot"]);

    await new Promise((r) => setTimeout(r, 20));

    expect(goodProc.calls).toHaveLength(1);
    expect(goodProc.calls[0]!.method).toBe("ezcorp/event/task:snapshot");
  });
});
