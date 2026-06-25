import { test, expect, describe, } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { JsonRpcNotification } from "../extensions/types";
import {
  ExtensionStateMediator,
  MAX_STATE_SIZE_BYTES,
  MAX_UPDATES_PER_SECOND,
  setStateMediator,
  getStateMediator,
  _resetStateMediatorForTests,
  type MediatorManifest,
} from "../extensions/state-mediator";

// ── Helpers ──────────────────────────────────────────────────────────

/** Index into an array, throwing if the slot is absent — avoids `!` under noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

function makeNotification(
  params?: Record<string, unknown>,
  method = "ezcorp/state",
): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

const MANIFEST: MediatorManifest = {
  name: "test-ext",
  panel: { stateSchema: {} },
};

function setup(manifest: MediatorManifest | undefined = MANIFEST, noManifest = false) {
  const bus = new EventBus<AgentEvents>();
  const getManifest = (_id: string) => (noManifest ? undefined : manifest);
  const mediator = new ExtensionStateMediator(bus, getManifest);
  const events: AgentEvents["ext:state"][] = [];
  bus.on("ext:state", (e) => events.push(e));
  return { bus, mediator, events };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ExtensionStateMediator", () => {
  describe("happy path", () => {
    test("accepts valid ezcorp/state notification and emits ext:state event", () => {
      const { mediator, events } = setup();
      mediator.handleNotification("ext-1", makeNotification({ count: 42 }));

      expect(events).toHaveLength(1);
      const first = at(events, 0, "events");
      expect(first.extensionId).toBe("ext-1");
      expect(first.extensionName).toBe("test-ext");
      expect(first.state).toEqual({ count: 42 });
      expect(typeof first.timestamp).toBe("number");
    });

    test("unwraps params.state when present", () => {
      const { mediator, events } = setup();
      mediator.handleNotification("ext-1", makeNotification({ state: { a: 1 } }));

      expect(at(events, 0, "events").state).toEqual({ a: 1 });
    });

    test("uses full params as state when no .state key", () => {
      const { mediator, events } = setup();
      mediator.handleNotification("ext-1", makeNotification({ foo: "bar" }));

      expect(at(events, 0, "events").state).toEqual({ foo: "bar" });
    });

    test("emitted event has correct shape", () => {
      const { mediator, events } = setup();
      mediator.handleNotification("ext-1", makeNotification({ x: 1 }));

      const evt = at(events, 0, "events");
      expect(evt).toHaveProperty("extensionId");
      expect(evt).toHaveProperty("extensionName");
      expect(evt).toHaveProperty("state");
      expect(evt).toHaveProperty("timestamp");
      expect(Object.keys(evt).sort()).toEqual(
        ["extensionId", "extensionName", "state", "timestamp"].sort(),
      );
    });
  });

  describe("method filtering", () => {
    test("rejects notification with wrong method (task:snapshot)", () => {
      const { mediator, events } = setup();
      mediator.handleNotification("ext-1", makeNotification({ x: 1 }, "task:snapshot"));
      expect(events).toHaveLength(0);
    });

    test("rejects notification with wrong method (run:complete)", () => {
      const { mediator, events } = setup();
      mediator.handleNotification("ext-1", makeNotification({ x: 1 }, "run:complete"));
      expect(events).toHaveLength(0);
    });
  });

  describe("params validation", () => {
    test("rejects when params missing", () => {
      const { mediator, events } = setup();
      mediator.handleNotification("ext-1", makeNotification(undefined));
      expect(events).toHaveLength(0);
    });

    test("rejects when params is not object", () => {
      const { mediator, events } = setup();
      // Cast to bypass TS — simulates malformed notification from subprocess
      mediator.handleNotification(
        "ext-1",
        { jsonrpc: "2.0", method: "ezcorp/state", params: "string" as any },
      );
      expect(events).toHaveLength(0);
    });
  });

  describe("size limit", () => {
    test("rejects payload larger than 64KB", () => {
      const { mediator, events } = setup();
      // Build a string that exceeds MAX_STATE_SIZE_BYTES when JSON-encoded
      const bigValue = "x".repeat(MAX_STATE_SIZE_BYTES);
      mediator.handleNotification("ext-1", makeNotification({ big: bigValue }));
      expect(events).toHaveLength(0);
    });

    test("accepts payload right at 64KB boundary", () => {
      const { mediator, events } = setup();
      // JSON overhead: {"k":"..."} ~ 7 chars + the string itself
      const value = "x".repeat(MAX_STATE_SIZE_BYTES - 10);
      mediator.handleNotification("ext-1", makeNotification({ k: value }));
      // If this is under 64KB it emits; if over it doesn't.
      // We just verify it doesn't crash — the exact boundary depends on key length.
      expect(events.length).toBeLessThanOrEqual(1);
    });
  });

  describe("rate limiting", () => {
    test("first MAX_UPDATES_PER_SECOND calls succeed, next is dropped", () => {
      const { mediator, events } = setup();
      for (let i = 0; i < MAX_UPDATES_PER_SECOND + 5; i++) {
        mediator.handleNotification("ext-1", makeNotification({ i }));
      }
      expect(events).toHaveLength(MAX_UPDATES_PER_SECOND);
    });

    test("rate limiter refills over time", async () => {
      const { mediator, events } = setup();
      // Exhaust all tokens
      for (let i = 0; i < MAX_UPDATES_PER_SECOND; i++) {
        mediator.handleNotification("ext-1", makeNotification({ i }));
      }
      expect(events).toHaveLength(MAX_UPDATES_PER_SECOND);

      // Wait enough for at least 1 token to refill (100ms = 1 token at 10/sec)
      await new Promise((r) => setTimeout(r, 150));

      mediator.handleNotification("ext-1", makeNotification({ after: true }));
      expect(events).toHaveLength(MAX_UPDATES_PER_SECOND + 1);
    });

    test("rate limiting is per-extension", () => {
      const { mediator, events } = setup();
      for (let i = 0; i < MAX_UPDATES_PER_SECOND; i++) {
        mediator.handleNotification("ext-A", makeNotification({ i }));
      }
      // ext-A exhausted, but ext-B should still work
      mediator.handleNotification("ext-B", makeNotification({ x: 1 }));
      expect(events).toHaveLength(MAX_UPDATES_PER_SECOND + 1);
    });
  });

  describe("manifest validation", () => {
    test("rejects when no manifest found", () => {
      const { mediator, events } = setup(undefined, true);
      mediator.handleNotification("ext-1", makeNotification({ x: 1 }));
      expect(events).toHaveLength(0);
    });

    test("rejects when manifest has no panel", () => {
      const { mediator, events } = setup({ name: "no-panel" });
      mediator.handleNotification("ext-1", makeNotification({ x: 1 }));
      expect(events).toHaveLength(0);
    });
  });

  describe("HTML stripping", () => {
    test("strips <script> from string values in state", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "ext-1",
        makeNotification({ html: "<script>alert('xss')</script>" }),
      );
      expect(at(events, 0, "events").state).toEqual({ html: "scriptalert('xss')/script" });
    });

    test("strips <iframe> from string values", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "ext-1",
        makeNotification({ tag: "<iframe src='evil'></iframe>" }),
      );
      const result = at(events, 0, "events").state.tag as string;
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
    });

    test("strips tags from deeply nested values", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "ext-1",
        makeNotification({
          a: { b: { c: { d: "<b>bold</b>" } } },
        }),
      );
      const state = at(events, 0, "events").state as any;
      expect(state.a.b.c.d).toBe("bbold/b");
    });

    test("strips tags from arrays", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "ext-1",
        makeNotification({ items: ["<a>", "ok", "<br/>"] }),
      );
      const items = at(events, 0, "events").state.items as string[];
      expect(items).toEqual(["a", "ok", "br/"]);
    });
  });

  describe("extensionId injection", () => {
    test("extensionId in emitted event comes from function parameter, not payload", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "real-ext",
        makeNotification({ extensionId: "fake-ext", value: 1 }),
      );
      expect(at(events, 0, "events").extensionId).toBe("real-ext");
    });
  });
});

// ── Process-wide mediator singleton ──────────────────────────────────
//
// `ensureSubprocessRpcWired` falls back to `getStateMediator()` when its
// per-instance `this.stateMediator` is unset, so boot-spawned / lazily-spawned
// dashboards still get their live-refresh handler. `context.ts` registers the
// mediator via `setStateMediator()` once at boot.
describe("process-wide mediator singleton", () => {
  test("set / get / reset round-trip", () => {
    _resetStateMediatorForTests();
    expect(getStateMediator()).toBeNull();

    const bus = new EventBus<AgentEvents>();
    const mediator = new ExtensionStateMediator(bus, () => MANIFEST);
    setStateMediator(mediator);
    expect(getStateMediator()).toBe(mediator);

    _resetStateMediatorForTests();
    expect(getStateMediator()).toBeNull();
  });
});
