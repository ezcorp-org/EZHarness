// webhook-ticket-loop — unit tests for the reference webhook Loop example.
//
// Drives `ticketCheck` / `ticketAct` with hand-built contexts (no live channel)
// so the deterministic gate + the untrusted-payload narrowing are covered. The
// full trigger → daemon dispatch → check/act path is proven by the
// subprocess integration test; `start()` + the artifact mapper by boot.test.ts.

import { test, expect, describe } from "bun:test";
import type { LoopActContext, LoopCheckContext, WebhookInput } from "@ezcorp/sdk/runtime";
import { defineWebhookLoop, ticketAct, ticketCheck } from "./index";
import config from "./ezcorp.config";
import { validateManifestV2 } from "../../../../src/extensions/manifest";

function whInput(parsed: unknown, overrides: Partial<WebhookInput> = {}): WebhookInput {
  return {
    kind: "webhook",
    slug: "tickets",
    untrusted: true,
    contentType: "application/json",
    body: typeof parsed === "string" ? parsed : JSON.stringify(parsed),
    parsed,
    deliveryId: "d-1",
    receivedAt: "2026-07-16T10:00:00.000Z",
    ...overrides,
  };
}

function checkCtx(
  input: WebhookInput,
  settings: Record<string, unknown> = {},
): LoopCheckContext<WebhookInput> {
  return {
    input,
    settings,
    fire: {
      id: "d-1",
      firedAt: "2026-07-16T10:00:00.000Z",
      trigger: { kind: "webhook", slug: "tickets" },
      catchUp: false,
    },
    cursor: { get: async () => undefined, set: async () => {} },
    fetch: (async () => new Response("")) as unknown as typeof fetch,
    log: () => {},
  };
}

function actCtx(input: WebhookInput, settings: Record<string, unknown> = {}): LoopActContext<WebhookInput> {
  return {
    fire: {
      id: "d-1",
      firedAt: "2026-07-16T10:00:00.000Z",
      trigger: { kind: "webhook", slug: "tickets" },
      catchUp: false,
    },
    input,
    settings,
    llm: { complete: async () => { throw new Error("llm not used"); } } as never,
    recentMessages: async () => [],
    formatMessages: (m) => m.map((x) => `[${x.id}] ${x.role}: ${x.content}`).join("\n\n"),
    spawn: (async () => { throw new Error("spawn not used"); }) as never,
    log: () => {},
  };
}

describe("ticketCheck", () => {
  test("enabled=false → settings_disabled", async () => {
    const r = await ticketCheck(checkCtx(whInput({ id: "T1", priority: "high" }), { enabled: false }));
    expect(r).toEqual({ proceed: false, reason: "settings_disabled" });
  });

  test("no ticket id (parsed missing id) → no_ticket_id", async () => {
    expect(await ticketCheck(checkCtx(whInput({ priority: "high" })))).toEqual({
      proceed: false, reason: "no_ticket_id",
    });
  });

  test("parsed is not an object (e.g. a JSON array / null) → no_ticket_id", async () => {
    expect(await ticketCheck(checkCtx(whInput([1, 2, 3])))).toEqual({ proceed: false, reason: "no_ticket_id" });
    expect(await ticketCheck(checkCtx(whInput(undefined, { parsed: undefined })))).toEqual({
      proceed: false, reason: "no_ticket_id",
    });
  });

  test("below the configured threshold → below_priority_threshold", async () => {
    // Default min_priority is "high"; a "low" ticket is below it.
    expect(await ticketCheck(checkCtx(whInput({ id: "T1", priority: "low" })))).toEqual({
      proceed: false, reason: "below_priority_threshold",
    });
    // An unknown priority ranks below every threshold.
    expect(await ticketCheck(checkCtx(whInput({ id: "T1", priority: "bogus" })))).toEqual({
      proceed: false, reason: "below_priority_threshold",
    });
    // Missing priority → below threshold too.
    expect(await ticketCheck(checkCtx(whInput({ id: "T1" })))).toEqual({
      proceed: false, reason: "below_priority_threshold",
    });
  });

  test("at/above threshold → proceed:true", async () => {
    expect(await ticketCheck(checkCtx(whInput({ id: "T1", priority: "high" })))).toEqual({ proceed: true });
    // Lower the threshold via settings → a medium ticket clears it.
    expect(
      await ticketCheck(checkCtx(whInput({ id: "T1", priority: "medium" }), { min_priority: "medium" })),
    ).toEqual({ proceed: true });
  });

  test("an unknown min_priority setting falls back to the 'high' threshold", async () => {
    expect(
      await ticketCheck(checkCtx(whInput({ id: "T1", priority: "medium" }), { min_priority: "nonsense" })),
    ).toEqual({ proceed: false, reason: "below_priority_threshold" });
  });
});

describe("ticketAct", () => {
  test("records the accepted ticket as a terminal outcome", async () => {
    const r = await ticketAct(actCtx(whInput({ id: "T9", priority: "high" }, { deliveryId: "del-9" })));
    expect(r).toEqual({
      kind: "terminal",
      status: "done",
      outcome: { ticketId: "T9", priority: "high", deliveryId: "del-9" },
    });
  });

  test("a ticket with a missing priority records 'unknown'", async () => {
    const r = await ticketAct(actCtx(whInput({ id: "T2" })));
    expect(r).toMatchObject({ kind: "terminal", outcome: { ticketId: "T2", priority: "unknown" } });
  });

  test("no ticket id → skip (defensive; check normally gates this)", async () => {
    expect(await ticketAct(actCtx(whInput({ priority: "high" })))).toEqual({ kind: "skip", reason: "no_ticket_id" });
  });
});

describe("defineWebhookLoop", () => {
  test("registers without throwing (import.meta.main is false under test)", () => {
    expect(() => defineWebhookLoop()).not.toThrow();
  });
});

describe("manifest", () => {
  test("passes validateManifestV2 (snake_case settings keys)", () => {
    const result = validateManifestV2(config);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    // snake_case keys only (validateManifestV2 rejects camelCase).
    expect(Object.keys(config.settings ?? {})).toEqual(
      expect.arrayContaining(["enabled", "min_priority"]),
    );
  });

  test("declares the webhook grant + storage; is persistent", () => {
    expect(config.name).toBe("webhook-ticket-loop");
    expect(config.persistent).toBe(true);
    expect(config.permissions?.webhooks).toEqual(["tickets"]);
    expect(config.permissions?.storage).toBe(true);
  });
});
