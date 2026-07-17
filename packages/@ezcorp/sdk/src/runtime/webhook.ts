// ── Webhook — typed receiver for the ezcorp/webhook-fire host push ────
//
// Manifest-only registration: webhook slugs live in the manifest's
// `permissions.webhooks[]`; the host mints a per-hook secret and routes an
// authenticated inbound `POST /api/hooks/:extensionId/:slug` onto a persistent,
// claim-before-dispatch delivery queue (mirrors `extension_schedules`). When a
// delivery is claimed the host `sendNotification("ezcorp/webhook-fire", …)`s
// this subprocess with the delimited, size-capped payload.
//
// The SDK silently drops a fire for a slug with no registered handler —
// defense-in-depth; the manifest + the host grant are the source of truth, so
// the host should never fire one we didn't declare. Mirrors `schedule.ts`.

import { getChannel } from "./channel";
import type { WebhookInput } from "./loop-types";

/** The wire shape the host pushes on `ezcorp/webhook-fire`. Carries the
 *  delimited untrusted payload wrapper the loop's check/act consume verbatim
 *  (via {@link WebhookInput}) plus per-fire metadata. */
export interface WebhookFireContext {
  slug: string;
  deliveryId: string;
  receivedAt: string; // ISO timestamp
  /** The delimited UNTRUSTED payload wrapper (see {@link WebhookInput}). */
  input: WebhookInput;
  /** True when this delivery was drained from the pending backlog after the
   *  subprocess was down / the kill switch was engaged (cron-style catch-up). */
  catchUp: boolean;
}

export type WebhookHandler = (ctx: WebhookFireContext) => Promise<void> | void;

const handlers = new Map<string, WebhookHandler>();
let receiverInstalled = false;

function installReceiver(): void {
  if (receiverInstalled) return;
  receiverInstalled = true;
  getChannel().onRequest("ezcorp/webhook-fire", async (params: unknown) => {
    const ctx = params as WebhookFireContext;
    const handler = handlers.get(ctx.slug);
    if (!handler) {
      // Silent drop — no manifest registration for this slug. The host should
      // never fire one we didn't declare; this is defense-in-depth.
      return undefined;
    }
    await handler(ctx);
    return undefined;
  });
}

export class Webhook {
  /** Register a handler for the given webhook slug. The manifest must declare
   *  the same slug in `permissions.webhooks` — the host refuses to route any
   *  undeclared slug. */
  on(slug: string, handler: WebhookHandler): void {
    handlers.set(slug, handler);
    installReceiver();
  }
}

/** @internal test-only — clear the handler registry + receiver latch so each
 *  test starts from a clean slate (mirrors the loop registry reset). */
export function __resetWebhooksForTests(): void {
  handlers.clear();
  receiverInstalled = false;
}
