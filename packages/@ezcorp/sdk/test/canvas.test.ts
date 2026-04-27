// canvas.test.ts — coverage for runtime/canvas.ts (Phase A1).
//
// Validates the createCanvas helper end-to-end:
//   - Validation rejects bad cardType / namespace / events shapes.
//   - onRequest is registered at `ezcorp/event/<namespace>:<event>`.
//   - Inbound frames extract toolCallId/conversationId into the typed
//     context, leaving payload as the user-defined body.
//   - refresh() / close() emit notifications with the right method
//     and cardType field.
//   - Malformed inbound frames (missing context fields) drop silently
//     instead of crashing the channel.
//
// The harness mirrors events.test.ts: an isolated channel with a queue-
// based stdin and an array stdout capture. createCanvas talks to
// getChannel() — the production singleton — so a subset of tests stub
// the singleton's methods directly via spyOn.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createCanvas, type CanvasContext } from "../src/runtime/canvas";
import {
  __resetChannelForTests,
  getChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

// ── Validation ──────────────────────────────────────────────────────

describe("createCanvas — input validation", () => {
  test("rejects empty cardType", () => {
    expect(() =>
      createCanvas({ cardType: "", namespace: "ext", events: {} }),
    ).toThrow(/cardType must be a non-empty string/);
  });

  test("rejects non-string cardType", () => {
    expect(() =>
      createCanvas({
        cardType: 42 as unknown as string,
        namespace: "ext",
        events: {},
      }),
    ).toThrow(/cardType/);
  });

  test("rejects namespace not matching extension-name regex", () => {
    expect(() =>
      createCanvas({ cardType: "x", namespace: "Bad Name", events: {} }),
    ).toThrow(/namespace must match extension name regex/);
  });

  test("accepts namespace at the regex edge (single char, hyphens, dots)", () => {
    // No throw, no event registrations needed.
    createCanvas({ cardType: "x", namespace: "a", events: {} });
    createCanvas({ cardType: "x", namespace: "claude-design", events: {} });
    createCanvas({ cardType: "x", namespace: "a.b_c-d", events: {} });
  });

  test("rejects namespace longer than 64 chars", () => {
    const tooLong = "a".repeat(65);
    expect(() =>
      createCanvas({ cardType: "x", namespace: tooLong, events: {} }),
    ).toThrow(/namespace/);
  });

  test("rejects events not being an object", () => {
    expect(() =>
      createCanvas({
        cardType: "x",
        namespace: "ext",
        events: null as unknown as Record<string, never>,
      }),
    ).toThrow(/events must be an object/);
  });

  test("rejects non-function handler value", () => {
    expect(() =>
      createCanvas({
        cardType: "x",
        namespace: "ext",
        events: { boom: "not a function" as unknown as () => void },
      }),
    ).toThrow(/handler for "boom" must be a function/);
  });
});

// ── Inbound event wire format ───────────────────────────────────────
//
// Strategy: spy on the singleton's `onRequest` BEFORE calling
// createCanvas. The spy captures the (method, handler) pair as
// createCanvas registers it. We then call the captured handler
// directly with a fixture frame — exercising the real unwrap logic
// at canvas.ts without going through stdin/stdout.

// Capture the (method, handler) pairs that createCanvas registers on
// the singleton via onRequest. Tests then call handlers directly
// with fixture frames — exercising the real unwrap logic without
// stdin/stdout. We narrow the handler return to Promise<unknown> so
// `await` and `.rejects.toThrow` typecheck cleanly; the channel's
// looser `Promise<unknown> | unknown` type is fine for production
// since handlers always go async (per createCanvas's implementation).
type RegisteredHandler = (params: unknown) => Promise<unknown>;

function captureRegistrations(): Map<string, RegisteredHandler> {
  const registry = new Map<string, RegisteredHandler>();
  const ch = getChannel();
  spyOn(ch, "onRequest").mockImplementation(
    (method: string, handler: (params: unknown) => Promise<unknown> | unknown) => {
      // Wrap to coerce sync returns to a Promise — gives `.rejects` /
      // `await` a uniform shape and matches what the production
      // channel does internally before resolving the JSON-RPC response.
      registry.set(method, async (params: unknown) => handler(params));
    },
  );
  return registry;
}

describe("createCanvas — inbound event handlers", () => {
  test("registers handlers at ezcorp/event/<namespace>:<event>", () => {
    const registry = captureRegistrations();

    createCanvas({
      cardType: "design-canvas",
      namespace: "claude-design",
      events: {
        "knob-change": async () => {},
        "comment-add": async () => {},
      },
    });

    expect(registry.has("ezcorp/event/claude-design:knob-change")).toBe(true);
    expect(registry.has("ezcorp/event/claude-design:comment-add")).toBe(true);
    expect(registry.size).toBe(2);
  });

  test("inbound frame routes typed context + raw payload to user handler", async () => {
    const registry = captureRegistrations();
    type KnobPayload = {
      toolCallId: string;
      conversationId: string;
      primaryColor: string;
    };
    const seen: Array<{ payload: KnobPayload; context: CanvasContext }> = [];

    createCanvas({
      cardType: "design-canvas",
      namespace: "claude-design",
      events: {
        "knob-change": async ({ payload, context }) => {
          seen.push({ payload: payload as KnobPayload, context });
        },
      },
    });

    const handler = registry.get("ezcorp/event/claude-design:knob-change");
    if (!handler) throw new Error("handler not registered");

    // Real wire format: toolCallId/conversationId are siblings of user data
    await handler({
      toolCallId: "tc-1",
      conversationId: "c-1",
      primaryColor: "#ff0066",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.context).toEqual({ toolCallId: "tc-1", conversationId: "c-1" });
    // payload is the whole frame — toolCallId/conversationId included
    expect(seen[0]?.payload.toolCallId).toBe("tc-1");
    expect(seen[0]?.payload.primaryColor).toBe("#ff0066");
  });

  test("frame missing toolCallId is dropped silently — handler not called", async () => {
    const registry = captureRegistrations();
    let called = false;

    createCanvas({
      cardType: "design-canvas",
      namespace: "claude-design",
      events: {
        "knob-change": async () => {
          called = true;
        },
      },
    });

    const handler = registry.get("ezcorp/event/claude-design:knob-change")!;
    await handler({ conversationId: "c-1", primaryColor: "#ff0066" });

    expect(called).toBe(false);
  });

  test("frame missing conversationId is dropped silently — handler not called", async () => {
    const registry = captureRegistrations();
    let called = false;

    createCanvas({
      cardType: "design-canvas",
      namespace: "claude-design",
      events: {
        "knob-change": async () => {
          called = true;
        },
      },
    });

    const handler = registry.get("ezcorp/event/claude-design:knob-change")!;
    await handler({ toolCallId: "tc-1", primaryColor: "#ff0066" });

    expect(called).toBe(false);
  });

  test("null params is dropped silently — does not throw", async () => {
    const registry = captureRegistrations();
    let called = false;

    createCanvas({
      cardType: "x",
      namespace: "ext",
      events: { "e": async () => { called = true; } },
    });

    const handler = registry.get("ezcorp/event/ext:e")!;
    // Channel passes through whatever the host sent. Defensive against null.
    await handler(null);
    await handler(undefined);

    expect(called).toBe(false);
  });

  test("user handler exceptions propagate (channel handles error envelope)", async () => {
    const registry = captureRegistrations();

    createCanvas({
      cardType: "x",
      namespace: "ext",
      events: {
        "boom": async () => {
          throw new Error("user-handler failure");
        },
      },
    });

    const handler = registry.get("ezcorp/event/ext:boom")!;
    await expect(
      handler({ toolCallId: "tc", conversationId: "c" }),
    ).rejects.toThrow("user-handler failure");
  });

  test("same namespace:eventName twice — second call wins (Map semantics)", async () => {
    const registry = captureRegistrations();
    const seen: string[] = [];

    createCanvas({
      cardType: "x",
      namespace: "ext",
      events: { "e": async () => { seen.push("first"); } },
    });
    createCanvas({
      cardType: "x",
      namespace: "ext",
      events: { "e": async () => { seen.push("second"); } },
    });

    // Map allows duplicate keys to overwrite — final registration wins.
    const handler = registry.get("ezcorp/event/ext:e")!;
    await handler({ toolCallId: "tc", conversationId: "c" });

    expect(seen).toEqual(["second"]);
  });

  test("two namespaces with the same event suffix do not collide", async () => {
    const registry = captureRegistrations();
    const seen: string[] = [];

    createCanvas({
      cardType: "card-a",
      namespace: "ext-a",
      events: { "ping": async () => { seen.push("a"); } },
    });
    createCanvas({
      cardType: "card-b",
      namespace: "ext-b",
      events: { "ping": async () => { seen.push("b"); } },
    });

    expect(registry.size).toBe(2);
    await registry.get("ezcorp/event/ext-a:ping")!({
      toolCallId: "tc", conversationId: "c",
    });
    await registry.get("ezcorp/event/ext-b:ping")!({
      toolCallId: "tc", conversationId: "c",
    });

    expect(seen).toEqual(["a", "b"]);
  });

  test("context fields are stripped to strings — non-string toolCallId rejected", async () => {
    const registry = captureRegistrations();
    let called = false;

    createCanvas({
      cardType: "x",
      namespace: "ext",
      events: { "e": async () => { called = true; } },
    });

    const handler = registry.get("ezcorp/event/ext:e")!;
    // toolCallId provided but as a number — should be rejected
    await handler({ toolCallId: 123, conversationId: "c-1" });
    expect(called).toBe(false);

    // empty string toolCallId — rejected
    await handler({ toolCallId: "", conversationId: "c-1" });
    expect(called).toBe(false);
  });
});


// Outbound refresh/close intentionally not in Phase A. See canvas.ts
// header for the rationale. Phase A.5/B will reintroduce these methods
// with toolCallId scoping + host wiring + browser iframe re-keying.
