// webhook.test.ts — 100% line coverage for runtime/webhook.ts
//
// `Webhook` mirrors `Schedule`: it registers a per-slug handler in a
// module-level Map and lazily installs ONE `ezcorp/webhook-fire` receiver on
// the singleton channel. A fire frame for an unregistered slug is silently
// dropped (defense-in-depth — the manifest + host grant are the source of
// truth, so the host should never fire a slug we didn't declare).
//
// Same module-state gotcha as schedule.test.ts: `receiverInstalled` latches
// true process-wide, so we capture the receiver closure exactly once on the
// VERY FIRST `on()` call (spy `onRequest` before it) and reuse that closure
// (which reads the live module-level `handlers` Map) to simulate host frames.

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import {
  Webhook,
  __resetWebhooksForTests,
  type WebhookFireContext,
} from "../src/runtime/webhook";
import type { WebhookInput } from "../src/runtime/loop-types";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";

// Captured once — the receiver closure the SDK installs for webhook-fire.
let receiver: ((p: unknown) => Promise<unknown> | unknown) | undefined;

beforeAll(() => {
  const ch: HostChannel = getChannel();
  const onReqSpy = spyOn(ch, "onRequest");
  onReqSpy.mockImplementation(((method: string, handler: (p: unknown) => unknown) => {
    if (method === "ezcorp/webhook-fire") receiver = handler;
  }) as HostChannel["onRequest"]);
  // First on() across the process → installReceiver() fires onRequest,
  // which our spy intercepts and stashes.
  new Webhook().on("__capture__", () => {
    throw new Error("capture-only handler should never fire");
  });
  onReqSpy.mockRestore();
});

afterEach(() => {
  // Only the channel is reset between tests (mirrors schedule.test.ts). The
  // `receiverInstalled` latch stays true process-wide so the "does not
  // re-register" idempotency test can observe it — the reset helper is
  // exercised explicitly in its own test below.
  __resetChannelForTests();
});

function makeInput(overrides: Partial<WebhookInput> = {}): WebhookInput {
  return {
    kind: "webhook",
    slug: "tickets",
    untrusted: true,
    contentType: "application/json",
    body: '{"id":42}',
    parsed: { id: 42 },
    deliveryId: "delivery-1",
    receivedAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<WebhookFireContext> = {},
): WebhookFireContext {
  return {
    slug: "tickets",
    deliveryId: "delivery-1",
    receivedAt: "2026-01-01T09:00:00.000Z",
    input: makeInput(),
    catchUp: false,
    ...overrides,
  };
}

describe("Webhook.on + receiver dispatch", () => {
  test("receiver closure was captured on first install", () => {
    expect(receiver).toBeDefined();
  });

  test("registered slug handler fires with the host ctx (delimited input)", async () => {
    const seen: WebhookFireContext[] = [];
    new Webhook().on("tickets", (ctx) => {
      seen.push(ctx);
    });
    const ctx = makeCtx();
    await receiver!(ctx);
    expect(seen).toEqual([ctx]);
    // The delimited untrusted wrapper reaches the handler verbatim.
    expect(seen[0]?.input.untrusted).toBe(true);
    expect(seen[0]?.input.parsed).toEqual({ id: 42 });
  });

  test("async handler is awaited", async () => {
    let resolved = false;
    new Webhook().on("slow", async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
    });
    await receiver!(makeCtx({ slug: "slow" }));
    expect(resolved).toBe(true);
  });

  test("unregistered slug is silently dropped (no throw, returns undefined)", async () => {
    const result = await receiver!(makeCtx({ slug: "never-declared" }));
    expect(result).toBeUndefined();
  });

  test("last on() for a slug wins (Map overwrite semantics)", async () => {
    const calls: string[] = [];
    const webhook = new Webhook();
    webhook.on("tickets", () => {
      calls.push("first");
    });
    webhook.on("tickets", () => {
      calls.push("second");
    });
    await receiver!(makeCtx({ slug: "tickets" }));
    expect(calls).toEqual(["second"]);
  });

  test("on() after the receiver is installed does not re-register (idempotent)", () => {
    // Spy onRequest now; a fresh on() must NOT call it again because
    // receiverInstalled already latched true on the first install.
    const ch: HostChannel = getChannel();
    const onReqSpy = spyOn(ch, "onRequest");
    new Webhook().on("later", () => {});
    expect(onReqSpy).not.toHaveBeenCalled();
    onReqSpy.mockRestore();
  });
});

describe("__resetWebhooksForTests", () => {
  test("clears the handler registry so a re-registered slug re-fires", async () => {
    let fired = 0;
    new Webhook().on("tickets", () => {
      fired++;
    });
    __resetWebhooksForTests();
    // After reset the old handler is gone — the captured receiver drops it.
    await receiver!(makeCtx({ slug: "tickets" }));
    expect(fired).toBe(0);
    // Re-registering wires it back up.
    new Webhook().on("tickets", () => {
      fired++;
    });
    await receiver!(makeCtx({ slug: "tickets" }));
    expect(fired).toBe(1);
  });
});
