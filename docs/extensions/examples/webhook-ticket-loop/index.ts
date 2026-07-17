#!/usr/bin/env bun
// webhook-ticket-loop — the reference WEBHOOK-triggered Loop example.
//
// One declarative `defineLoop` with a `{ kind: "webhook", slug: "tickets" }`
// trigger. The host authenticates an inbound POST, persists + claims a
// delivery, then pushes `ezcorp/webhook-fire` here; the primitive runs
// check → act on the delimited, UNTRUSTED `WebhookInput` wrapper.
//
// Untrusted-input posture (the whole point of this example): the webhook body
// is attacker-controllable. We NEVER interpolate the raw body into a
// prompt/command — we read the parsed JSON, validate its shape, and treat every
// field as hostile. A loop that spawned an agent would pass `input.body` only
// inside a clearly-delimited data block with an injection-warning preamble.
//
// See docs/extensions/loops.md § Webhook triggers for the full reference.

import {
  createToolDispatcher,
  defineLoop,
  getChannel,
  getLoopTools,
  type ActResult,
  type CheckResult,
  type LoopActContext,
  type LoopCheckContext,
  type WebhookInput,
} from "@ezcorp/sdk/runtime";

/** A recorded ticket outcome. Exported so the test can assert the shape. */
export interface TicketOutcome {
  ticketId: string;
  priority: string;
  deliveryId: string;
}

/** Priority rank for the deterministic threshold gate. Unknown → -1 (never
 *  clears any threshold). */
const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** Narrow the untrusted parsed body to the fields we consume. Hostile by
 *  assumption: anything not shaped as expected is treated as absent. */
function readTicket(input: WebhookInput): { id?: string; priority?: string } {
  const parsed = input.parsed;
  if (!parsed || typeof parsed !== "object") return {};
  const p = parsed as Record<string, unknown>;
  return {
    ...(typeof p.id === "string" ? { id: p.id } : {}),
    ...(typeof p.priority === "string" ? { priority: p.priority } : {}),
  };
}

/**
 * The deterministic pre-gate — "should the AI process even run for this
 * ticket?" It answers CHEAP, content-free questions from the (untrusted)
 * payload: is the loop enabled? does the body carry a ticket id? is the
 * priority at/above the configured threshold? A miss is a first-class `skip`
 * with a reason (logged, not an error). Exported for unit tests.
 */
export async function ticketCheck(
  ctx: LoopCheckContext<WebhookInput>,
): Promise<CheckResult<WebhookInput>> {
  if (ctx.settings.enabled === false) {
    return { proceed: false, reason: "settings_disabled" };
  }
  const ticket = readTicket(ctx.input);
  if (!ticket.id) {
    return { proceed: false, reason: "no_ticket_id" };
  }
  const minPriority = (ctx.settings.min_priority as string) ?? "high";
  const rank = PRIORITY_RANK[ticket.priority ?? ""] ?? -1;
  const threshold = PRIORITY_RANK[minPriority] ?? PRIORITY_RANK.high!;
  if (rank < threshold) {
    return { proceed: false, reason: "below_priority_threshold" };
  }
  return { proceed: true };
}

/**
 * The loop body — records the accepted ticket as a terminal outcome. Exported
 * so the unit test can drive it with a hand-built ctx. A real loop would spawn
 * an agent here, passing the untrusted body ONLY inside a delimited data block.
 */
export async function ticketAct(
  ctx: LoopActContext<WebhookInput>,
): Promise<ActResult<TicketOutcome>> {
  const ticket = readTicket(ctx.input);
  if (!ticket.id) return { kind: "skip", reason: "no_ticket_id" };
  return {
    kind: "terminal",
    status: "done",
    outcome: {
      ticketId: ticket.id,
      priority: ticket.priority ?? "unknown",
      deliveryId: ctx.input.deliveryId,
    },
  };
}

/**
 * Register the webhook loop. Exported (not auto-run) so unit tests can register
 * it against a stubbed channel without `import.meta.main`.
 */
export function defineWebhookLoop(): void {
  defineLoop<WebhookInput, TicketOutcome>({
    id: "ticket-webhook",
    trigger: { kind: "webhook", slug: "tickets" },
    contract: {
      states: ["done"],
      scope: "global",
      // The host-issued delivery id dedups a retried drain to one run.
      idempotencyKey: (input) => input.deliveryId,
      retention: { maxRuns: 50 },
    },
    check: ticketCheck,
    act: ticketAct,
    log: {
      // Mirror each accepted ticket to a human-readable artifact (fail-soft).
      artifact: (run, outcome) => ({
        path: `tickets/${run.id}.md`,
        body: `# Ticket ${outcome.ticketId}\n\nPriority: ${outcome.priority}\nDelivery: ${outcome.deliveryId}\n`,
      }),
    },
  });
}

/** Production boot: register the loop, mount the tools/call plumbing (none for
 *  a pure webhook loop), and start the channel's stdin read loop. */
export function start(): void {
  defineWebhookLoop();
  createToolDispatcher({ ...getLoopTools() });
  getChannel().start();
}

// Gated on `import.meta.main` so test imports don't open stdin.
if (import.meta.main) start();
