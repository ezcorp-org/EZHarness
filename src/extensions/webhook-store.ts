/**
 * Webhook registry + delivery-queue query helpers (Loops EZ Mode Phase 4).
 *
 * The route (accept path) and the delivery daemon (drain path) share these DB
 * primitives so the claim-before-dispatch contract is expressed once. All
 * timestamps are host-issued; the caller owns clock injection.
 */
import { getDb } from "../db/connection";
import { extensionWebhooks, webhookDeliveries, type ExtensionWebhook } from "../db/schema";
import { and, eq, gte } from "drizzle-orm";

/**
 * The ENABLED webhook registry row for `(extensionId, slug)`, or `null` when
 * absent or soft-disabled. A `null` result is the route's enumeration-safe
 * "unknown hook" — same shape whether the extension, the slug, or the grant is
 * missing (all three converge on no enabled row).
 */
export async function getEnabledWebhook(
  extensionId: string,
  slug: string,
): Promise<ExtensionWebhook | null> {
  const rows = await getDb().select().from(extensionWebhooks).where(and(
    eq(extensionWebhooks.extensionId, extensionId),
    eq(extensionWebhooks.slug, slug),
    eq(extensionWebhooks.enabled, true),
  ));
  return rows[0] ?? null;
}

export interface InsertDeliveryInput {
  webhookId: string;
  extensionId: string;
  slug: string;
  contentType: string | null;
  /** Size-capped raw request body (UTF-8). */
  body: string;
  receivedAt: Date;
  /** Drained-from-backlog marker (mirrors cron catch-up). Default false. */
  catchUp?: boolean;
}

/**
 * Persist an accepted delivery in `status: pending` (the durable queue). Returns
 * the new delivery id — the stable idempotency handle that becomes the loop
 * fire id. The row is written BEFORE any dispatch so a crash between accept and
 * dispatch is recoverable by the daemon's catch-up drain.
 */
export async function insertDelivery(
  input: InsertDeliveryInput,
): Promise<string> {
  const [row] = await getDb().insert(webhookDeliveries).values({
    webhookId: input.webhookId,
    extensionId: input.extensionId,
    slug: input.slug,
    status: "pending",
    contentType: input.contentType,
    body: input.body,
    receivedAt: input.receivedAt,
    catchUp: input.catchUp ?? false,
  }).returning();
  return row!.id;
}

/**
 * Count this extension's deliveries recorded at/after `since` (a UTC
 * start-of-day for the daily fire budget). Counts ALL non-rejected deliveries
 * (a persisted row = an accepted fire that consumes budget), so a leaked token
 * cannot burn unbounded spend even while the subprocess is down.
 */
export async function countDeliveriesSince(
  extensionId: string,
  since: Date,
): Promise<number> {
  const rows = await getDb().select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(
      eq(webhookDeliveries.extensionId, extensionId),
      gte(webhookDeliveries.receivedAt, since),
    ));
  return rows.length;
}

/** UTC start-of-day for `at` — the daily-budget window boundary. */
export function startOfUtcDay(at: Date): Date {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
