// events-dispatch.test.ts — covers the singleton-wired paths of
// runtime/events.ts that events.test.ts deliberately leaves untouched:
//   - `registerEventHandler` wraps the user handler in the onRequest
//     closure (lines 45-51): it registers `ezcorp/event/<type>`, the
//     closure awaits the inner handler, and returns `undefined`.
//   - The `Events` class facade (`on()`) delegates to it (lines 67-70).
//
// events.test.ts registers directly on an isolated test channel and
// notes it cannot drive the singleton. Here we spy `getChannel().onRequest`
// to CAPTURE the closure `registerEventHandler` installs, then invoke it
// directly — exercising the wrapper body without a live stdin loop.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { Events, registerEventHandler } from "../src/runtime/events";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

/** Capture the closure registered for a given method on the singleton. */
function captureRegistration(): {
  byMethod: Map<string, (p: unknown) => Promise<unknown> | unknown>;
} {
  const ch: HostChannel = getChannel();
  const byMethod = new Map<string, (p: unknown) => Promise<unknown> | unknown>();
  const spy = spyOn(ch, "onRequest");
  spy.mockImplementation(((method: string, handler: (p: unknown) => unknown) => {
    byMethod.set(method, handler);
  }) as HostChannel["onRequest"]);
  return { byMethod };
}

describe("registerEventHandler — singleton wiring", () => {
  test("registers method ezcorp/event/<type> and the closure forwards the payload", async () => {
    const { byMethod } = captureRegistration();
    const seen: unknown[] = [];
    registerEventHandler("task:snapshot", (payload) => {
      seen.push(payload);
    });

    const closure = byMethod.get("ezcorp/event/task:snapshot");
    expect(closure).toBeDefined();

    const payload = { conversationId: "c1", tasks: [], activeTaskId: undefined };
    const ret = await closure!(payload);
    // Closure resolves to undefined (defensive for id-bearing requests).
    expect(ret).toBeUndefined();
    expect(seen).toEqual([payload]);
  });

  test("awaits an async handler before returning", async () => {
    const { byMethod } = captureRegistration();
    let done = false;
    registerEventHandler("tool:complete", async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    const closure = byMethod.get("ezcorp/event/tool:complete");
    await closure!({ conversationId: "c", toolName: "x" });
    expect(done).toBe(true);
  });
});

describe("Events class facade", () => {
  test("on() delegates to registerEventHandler with the same method name", async () => {
    const { byMethod } = captureRegistration();
    const seen: unknown[] = [];
    const events = new Events();
    events.on("tool:start", (payload) => {
      seen.push(payload);
    });
    const closure = byMethod.get("ezcorp/event/tool:start");
    expect(closure).toBeDefined();
    const payload = { conversationId: "c", toolName: "echo", input: {} };
    await closure!(payload);
    expect(seen).toEqual([payload]);
  });
});
