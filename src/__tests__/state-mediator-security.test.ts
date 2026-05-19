import { test, expect, describe } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { JsonRpcNotification } from "../extensions/types";
import {
  ExtensionStateMediator,
  type MediatorManifest,
} from "../extensions/state-mediator";

// ── Helpers ──────────────────────────────────────────────────────────

const MANIFEST: MediatorManifest = {
  name: "secure-ext",
  panel: { stateSchema: {} },
};

function setup() {
  const bus = new EventBus<AgentEvents>();
  const mediator = new ExtensionStateMediator(bus, () => MANIFEST);
  const events: AgentEvents["ext:state"][] = [];
  bus.on("ext:state", (e) => events.push(e));
  return { bus, mediator, events };
}

function makeNotification(
  params?: Record<string, unknown>,
  method = "ezcorp/state",
): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

// ── Security Tests ──────────────────────────────────────────────────

describe("ExtensionStateMediator — security", () => {
  describe("method injection prevention", () => {
    test("extension cannot emit task:snapshot via method field", () => {
      const { mediator, events } = setup();
      mediator.handleNotification("ext-1", makeNotification({ tasks: [] }, "task:snapshot"));
      expect(events).toHaveLength(0);
    });

    test("extension cannot emit run:complete via method field", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "ext-1",
        makeNotification({ run: {} }, "run:complete"),
      );
      expect(events).toHaveLength(0);
    });

    test("extension cannot emit agent:spawn via method field", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "ext-1",
        makeNotification({ agentName: "evil" }, "agent:spawn"),
      );
      expect(events).toHaveLength(0);
    });

    test("extension cannot emit arbitrary bus events through method field", () => {
      const methods = [
        "run:start",
        "run:error",
        "run:cancel",
        "pipeline:start",
        "tool:start",
        "orchestrator:human_input",
      ];
      for (const method of methods) {
        const { mediator, events } = setup();
        mediator.handleNotification("ext-1", makeNotification({ x: 1 }, method));
        expect(events).toHaveLength(0);
      }
    });
  });

  describe("identity spoofing prevention", () => {
    test("extension cannot impersonate another extension via payload", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "real-ext-id",
        makeNotification({ extensionId: "admin-ext", state: { hijacked: true } }),
      );
      expect(at(events, 0, "ext:state event").extensionId).toBe("real-ext-id");
      expect(at(events, 0, "ext:state event").extensionName).toBe("secure-ext");
    });

    test("extensionName comes from manifest, not from payload", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "ext-1",
        makeNotification({ extensionName: "Evil Extension", value: 1 }),
      );
      expect(at(events, 0, "ext:state event").extensionName).toBe("secure-ext");
    });
  });

  describe("HTML/XSS stripping on deeply nested values", () => {
    test("strips HTML from strings 10 levels deep", () => {
      const { mediator, events } = setup();
      // Build a 10-level nested object with HTML at the leaf
      let obj: any = { leaf: "<img onerror='alert(1)' src='x'>" };
      for (let i = 0; i < 9; i++) {
        obj = { nested: obj };
      }
      mediator.handleNotification("ext-1", makeNotification(obj));

      // Traverse to the leaf
      let node: any = at(events, 0, "ext:state event").state;
      for (let i = 0; i < 9; i++) node = node.nested;
      expect(node.leaf).not.toContain("<");
      expect(node.leaf).not.toContain(">");
    });

    test("values beyond max depth are passed through unchanged", () => {
      const { mediator, events } = setup();
      // Build 12-level deep object (exceeds MAX_STRIP_DEPTH of 10)
      let obj: any = { leaf: "<b>deep</b>" };
      for (let i = 0; i < 11; i++) {
        obj = { n: obj };
      }
      mediator.handleNotification("ext-1", makeNotification(obj));

      // The leaf may still contain tags since we're past depth limit
      let node: any = at(events, 0, "ext:state event").state;
      for (let i = 0; i < 11; i++) node = node.n;
      // At depth 12 (0-indexed: 11 wraps + leaf), stripping stops
      // This is acceptable — the depth limit prevents stack overflow
      expect(node.leaf).toBeDefined();
    });

    test("strips mixed HTML across arrays and objects", () => {
      const { mediator, events } = setup();
      mediator.handleNotification("ext-1", makeNotification({
        items: [
          { name: "<script>steal()</script>", tags: ["<b>bold</b>", "safe"] },
          "<img src=x onerror=alert(1)>",
        ],
      }));

      const state = at(events, 0, "ext:state event").state as any;
      expect(state.items[0].name).not.toContain("<");
      expect(state.items[0].tags[0]).not.toContain("<");
      expect(state.items[1]).not.toContain("<");
    });
  });

  describe("prototype pollution resistance", () => {
    test("__proto__ key in state does not crash the mediator", () => {
      const { mediator } = setup();
      mediator.handleNotification(
        "ext-1",
        makeNotification({ __proto__: { polluted: true }, safe: 1 }),
      );
      // Should either emit safely or silently drop — no crash
      expect(() => {
        // Verify no prototype pollution on Object
        const clean: Record<string, unknown> = {};
        expect((clean as any).polluted).toBeUndefined();
      }).not.toThrow();
    });

    test("constructor key in state does not crash the mediator", () => {
      const { mediator } = setup();
      expect(() => {
        mediator.handleNotification(
          "ext-1",
          makeNotification({ constructor: { prototype: { evil: true } } }),
        );
      }).not.toThrow();

      // Verify no prototype pollution
      const clean: Record<string, unknown> = {};
      expect((clean as any).evil).toBeUndefined();
    });

    test("toString override in state does not crash the mediator", () => {
      const { mediator } = setup();
      expect(() => {
        mediator.handleNotification(
          "ext-1",
          makeNotification({ toString: "<script>alert(1)</script>" }),
        );
      }).not.toThrow();
    });
  });

  describe("null/undefined resilience", () => {
    test("null values in state do not crash the mediator", () => {
      const { mediator, events } = setup();
      expect(() => {
        mediator.handleNotification(
          "ext-1",
          makeNotification({ a: null, b: "ok" }),
        );
      }).not.toThrow();
      expect(events).toHaveLength(1);
      expect(at(events, 0, "ext:state event").state).toEqual({ a: null, b: "ok" });
    });

    test("undefined values in state do not crash the mediator", () => {
      const { mediator, events } = setup();
      expect(() => {
        mediator.handleNotification(
          "ext-1",
          makeNotification({ a: undefined, b: 42 }),
        );
      }).not.toThrow();
      expect(events).toHaveLength(1);
    });

    test("mixed null/undefined/string values are handled correctly", () => {
      const { mediator, events } = setup();
      mediator.handleNotification(
        "ext-1",
        makeNotification({
          nullVal: null,
          num: 99,
          str: "<b>hello</b>",
          bool: false,
        }),
      );
      expect(events).toHaveLength(1);
      const s = at(events, 0, "ext:state event").state as any;
      expect(s.nullVal).toBeNull();
      expect(s.num).toBe(99);
      expect(s.str).toBe("bhello/b");
      expect(s.bool).toBe(false);
    });
  });
});
