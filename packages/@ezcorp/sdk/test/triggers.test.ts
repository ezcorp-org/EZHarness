// triggers.test.ts — 100% line coverage for runtime/triggers.ts
//
// Two contracts matter from the client side:
//
//  1. THE WIRE SHAPE. `register` must never send a slug — the host mints it
//     from the manifest prefix and the extension name, and the absence of
//     the field is what makes forgery inexpressible rather than merely
//     denied. These tests pin that from the SDK side.
//
//  2. DISPATCH IS KEYED ON `key`, NOT ON THE CRON STRING. That is the whole
//     reason `ezcorp/trigger-fire` exists instead of reusing
//     `ezcorp/schedule-fire`: two jobs sharing `0 9 * * 1` must reach their
//     OWN handlers. A DB that stores them correctly and a dispatcher that
//     runs them identically is worse than the constraint violation it
//     replaced, because it fails silently.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  Triggers,
  __resetTriggersForTests,
  type TriggerFireContext,
} from "../src/runtime/triggers";
import { __resetChannelForTests, getChannel, type HostChannel } from "../src/runtime/channel";

afterEach(() => {
  __resetTriggersForTests();
  __resetChannelForTests();
});

function spyRequest(result: unknown = { v: 1, key: "job:1", kind: "cron" }) {
  const ch: HostChannel = getChannel();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation((async (method: string, params: unknown) => {
    calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
    return result;
  }) as HostChannel["request"]);
  return { calls, spy };
}

/** Capture the `ezcorp/trigger-fire` receiver the SDK installs, so a test
 *  can push a fire at it the way the host would. */
function captureReceiver() {
  const ch: HostChannel = getChannel();
  let received: ((params: unknown) => Promise<unknown> | unknown) | undefined;
  const spy = spyOn(ch, "onRequest");
  spy.mockImplementation(((method: string, handler: (p: unknown) => Promise<unknown>) => {
    if (method === "ezcorp/trigger-fire") received = handler;
  }) as HostChannel["onRequest"]);
  return {
    fire: (ctx: Partial<TriggerFireContext> & { key: string }) =>
      received?.({
        v: 1,
        kind: "cron",
        firedAt: "2026-07-29T09:00:00.000Z",
        fireId: "f1",
        catchUp: false,
        attempt: 0,
        ...ctx,
      }),
    installed: () => received !== undefined,
  };
}

describe("register", () => {
  test("sends {v, action, kind, key, cron} over ezcorp/triggers", async () => {
    const { calls } = spyRequest();

    await new Triggers().register({ kind: "cron", key: "job:1", cron: "0 9 * * 1" });

    expect(calls[0]?.method).toBe("ezcorp/triggers");
    expect(calls[0]?.params).toEqual({
      v: 1,
      action: "register",
      kind: "cron",
      key: "job:1",
      cron: "0 9 * * 1",
    });
  });

  test("passes an explicit timezone through", async () => {
    const { calls } = spyRequest();
    await new Triggers().register({
      kind: "cron",
      key: "job:1",
      cron: "0 9 * * 1",
      timezone: "America/New_York",
    });
    expect(calls[0]?.params.timezone).toBe("America/New_York");
  });

  test("a webhook registration carries NO slug field", async () => {
    // The structural bound: with no slug on the wire there is no field in
    // which to name another extension's hook.
    const { calls } = spyRequest({
      v: 1,
      key: "job:1",
      kind: "webhook",
      slug: "factory-abc123abc123",
      url: "/api/hooks/ext/factory-abc123abc123",
    });

    await new Triggers().register({ kind: "webhook", key: "job:1" });

    expect(calls[0]?.params).toEqual({ v: 1, action: "register", kind: "webhook", key: "job:1" });
    expect(Object.keys(calls[0]?.params ?? {})).not.toContain("slug");
  });

  test("returns the host's registered trigger verbatim", async () => {
    const reg = {
      v: 1,
      key: "job:1",
      kind: "webhook",
      slug: "factory-abc123abc123",
      url: "/api/hooks/ext/factory-abc123abc123",
    };
    spyRequest(reg);
    const out = await new Triggers().register({ kind: "webhook", key: "job:1" });
    expect(out).toEqual(reg as never);
  });

  test("propagates a host rejection", async () => {
    const ch: HostChannel = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation((async () => {
      throw Object.assign(new Error("cron trigger quota exceeded"), {
        data: { reason: "TRIGGERS_QUOTA_EXCEEDED" },
      });
    }) as HostChannel["request"]);

    await expect(
      new Triggers().register({ kind: "cron", key: "job:1", cron: "0 9 * * 1" }),
    ).rejects.toThrow("cron trigger quota exceeded");
  });
});

describe("unregister", () => {
  test("sends {v, action, kind, key}", async () => {
    const { calls } = spyRequest({ removed: true });
    const out = await new Triggers().unregister("webhook", "job:1");
    expect(calls[0]?.params).toEqual({
      v: 1,
      action: "unregister",
      kind: "webhook",
      key: "job:1",
    });
    expect(out).toEqual({ removed: true });
  });
});

describe("list", () => {
  test("unwraps the host's {triggers} envelope", async () => {
    const triggers = [
      { kind: "cron", key: "job:1", cron: "0 9 * * 1" },
      { kind: "webhook", key: "job:2", slug: "factory-aaa", url: "/api/hooks/e/factory-aaa" },
    ];
    const { calls } = spyRequest({ v: 1, triggers });

    const out = await new Triggers().list();

    expect(calls[0]?.params).toEqual({ v: 1, action: "list" });
    expect(out).toEqual(triggers as never);
  });
});

describe("the orphan-sync responder", () => {
  /** Capture the `ezcorp/triggers-sync` responder the SDK installs. */
  function captureSync() {
    const ch: HostChannel = getChannel();
    let responder: ((params: unknown) => Promise<unknown> | unknown) | undefined;
    const spy = spyOn(ch, "onRequest");
    spy.mockImplementation(((method: string, handler: (p: unknown) => Promise<unknown>) => {
      if (method === "ezcorp/triggers-sync") responder = handler;
    }) as HostChannel["onRequest"]);
    return {
      ask: () => responder?.({ v: 1, keys: [] }),
      installed: () => responder !== undefined,
    };
  }

  test("answers with the keys that have wired handlers", async () => {
    // The honest answer: a key with no handler cannot do anything when it
    // fires, so the host is right to sweep it.
    const rx = captureSync();
    const t = new Triggers();
    t.on("job:a", () => {});
    t.on("job:b", () => {});
    expect(await rx.ask()).toEqual({ v: 1, keys: ["job:a", "job:b"] });
  });

  test("a key removed with `off` drops out of the answer", async () => {
    const rx = captureSync();
    const t = new Triggers();
    t.on("job:a", () => {});
    t.on("job:b", () => {});
    t.off("job:a");
    expect(await rx.ask()).toEqual({ v: 1, keys: ["job:b"] });
  });

  test("the responder is NOT installed until a handler is wired", () => {
    // Load-bearing asymmetry: with no responder the host gets -32601 and
    // reads it as "unknown — disable nothing", instead of as "zero live
    // keys". Otherwise an extension that registers rows before wiring
    // handlers would lose every one of its users' jobs on restart.
    const rx = captureSync();
    expect(rx.installed()).toBe(false);
    new Triggers().on("job:a", () => {});
    expect(rx.installed()).toBe(true);
  });
});

describe("fire dispatch — keyed on `key`", () => {
  test("TWO JOBS SHARING A CRON reach their OWN handlers", async () => {
    // The regression this whole notification exists for.
    const rx = captureReceiver();
    const t = new Triggers();
    const seen: string[] = [];
    t.on("job:a", (c) => {
      seen.push(`a:${c.key}`);
    });
    t.on("job:b", (c) => {
      seen.push(`b:${c.key}`);
    });

    await rx.fire({ key: "job:a", cron: "0 9 * * 1" });
    await rx.fire({ key: "job:b", cron: "0 9 * * 1" });

    expect(seen).toEqual(["a:job:a", "b:job:b"]);
  });

  test("the handler receives the full fire context", async () => {
    const rx = captureReceiver();
    let got: TriggerFireContext | undefined;
    new Triggers().on("job:1", (c) => {
      got = c;
    });

    await rx.fire({
      key: "job:1",
      kind: "webhook",
      fireId: "f9",
      catchUp: true,
      attempt: 2,
      payload: { hello: "world" },
    });

    expect(got).toMatchObject({
      v: 1,
      key: "job:1",
      kind: "webhook",
      fireId: "f9",
      catchUp: true,
      attempt: 2,
      payload: { hello: "world" },
    });
  });

  test("a fire for an unregistered key is dropped silently", async () => {
    // Happens when a row outlives the job that made it, or when the
    // extension restarts and re-registers rows before wiring handlers.
    const rx = captureReceiver();
    new Triggers().on("job:1", () => {
      throw new Error("must not run");
    });
    await expect(rx.fire({ key: "job:unknown" })).resolves.toBeUndefined();
  });

  test("the receiver installs once across many `on` calls", async () => {
    const ch: HostChannel = getChannel();
    const spy = spyOn(ch, "onRequest");
    spy.mockImplementation((() => {}) as HostChannel["onRequest"]);
    const t = new Triggers();
    t.on("job:1", () => {});
    t.on("job:2", () => {});
    t.on("job:3", () => {});
    expect(spy.mock.calls.filter((c) => c[0] === "ezcorp/trigger-fire")).toHaveLength(1);
  });

  test("`off` stops handling without unregistering the row", async () => {
    const rx = captureReceiver();
    let ran = 0;
    const t = new Triggers();
    t.on("job:1", () => {
      ran++;
    });
    await rx.fire({ key: "job:1" });
    t.off("job:1");
    await rx.fire({ key: "job:1" });
    expect(ran).toBe(1);
  });

  test("re-registering a key replaces its handler", async () => {
    const rx = captureReceiver();
    const seen: string[] = [];
    const t = new Triggers();
    t.on("job:1", () => {
      seen.push("first");
    });
    t.on("job:1", () => {
      seen.push("second");
    });
    await rx.fire({ key: "job:1" });
    expect(seen).toEqual(["second"]);
  });

  test("an async handler is awaited", async () => {
    const rx = captureReceiver();
    let done = false;
    new Triggers().on("job:1", async () => {
      await new Promise((r) => setTimeout(r, 1));
      done = true;
    });
    await rx.fire({ key: "job:1" });
    expect(done).toBe(true);
  });
});
