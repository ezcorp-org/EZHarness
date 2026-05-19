// lifecycle.test.ts — 100% line + branch coverage for runtime/lifecycle.ts
//
// Strategy: registerLifecycleHook is a one-liner that forwards to
// channel.onRequest under the `lifecycle/<event>` method-name. Tests
// enumerate all four LifecycleEvent values, assert the prefixed method
// name, and assert the caller-supplied handler is passed through
// unwrapped (same reference) so that params delivered later by the
// channel land on the caller's handler.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  registerLifecycleHook,
  type LifecycleEvent,
} from "../src/runtime/lifecycle";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface OnRequestCall {
  method: string;
  handler: (params: unknown) => Promise<unknown> | unknown;
}

function stubOnRequest(): {
  calls: OnRequestCall[];
  spy: ReturnType<typeof spyOn>;
} {
  const ch: HostChannel = getChannel();
  const calls: OnRequestCall[] = [];
  const spy = spyOn(ch, "onRequest");
  spy.mockImplementation(((
    method: string,
    handler: (params: unknown) => Promise<unknown> | unknown,
  ) => {
    calls.push({ method, handler });
  }) as HostChannel["onRequest"]);
  return { calls, spy };
}

// ── every LifecycleEvent routes to lifecycle/<event> ───────────

describe("registerLifecycleHook — method-name forwarding", () => {
  const ALL_EVENTS: LifecycleEvent[] = [
    "agent:spawn",
    "agent:complete",
    "run:start",
    "run:complete",
  ];

  for (const event of ALL_EVENTS) {
    test(`${event} → channel.onRequest("lifecycle/${event}", handler)`, () => {
      const { calls } = stubOnRequest();
      const handler = (): void => {};
      registerLifecycleHook(event, handler);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe(`lifecycle/${event}`);
      expect(calls[0]?.handler).toBe(handler);
    });
  }
});

// ── handler receives params when channel fires the forwarded callback ──

describe("registerLifecycleHook — handler wiring", () => {
  test("forwarded handler receives params verbatim when the channel invokes it", async () => {
    const { calls } = stubOnRequest();
    const received: unknown[] = [];
    registerLifecycleHook("agent:spawn", (p) => {
      received.push(p);
    });
    const forwarded = calls[0]?.handler;
    expect(forwarded).toBeDefined();
    if (!forwarded) return;
    await forwarded({ agentId: "abc", capabilities: ["x"] });
    expect(received).toEqual([{ agentId: "abc", capabilities: ["x"] }]);
  });

  test("async handler (Promise<void>) compiles and resolves", async () => {
    const { calls } = stubOnRequest();
    let asyncRan = false;
    const asyncHandler = async (_p: unknown): Promise<void> => {
      await Promise.resolve();
      asyncRan = true;
    };
    registerLifecycleHook("run:complete", asyncHandler);
    const forwarded = calls[0]?.handler;
    expect(forwarded).toBeDefined();
    if (!forwarded) return;
    await forwarded({});
    expect(asyncRan).toBe(true);
  });

  test("sync void handler (no await) also compiles and fires", () => {
    const { calls } = stubOnRequest();
    let syncRan = false;
    const syncHandler = (_p: unknown): void => {
      syncRan = true;
    };
    registerLifecycleHook("run:start", syncHandler);
    const forwarded = calls[0]?.handler;
    expect(forwarded).toBeDefined();
    if (!forwarded) return;
    forwarded({});
    expect(syncRan).toBe(true);
  });

  test("registering multiple events installs one onRequest per event", () => {
    const { calls } = stubOnRequest();
    registerLifecycleHook("agent:spawn", () => {});
    registerLifecycleHook("agent:complete", () => {});
    registerLifecycleHook("run:start", () => {});
    registerLifecycleHook("run:complete", () => {});
    expect(calls.map((c) => c.method)).toEqual([
      "lifecycle/agent:spawn",
      "lifecycle/agent:complete",
      "lifecycle/run:start",
      "lifecycle/run:complete",
    ]);
  });
});
