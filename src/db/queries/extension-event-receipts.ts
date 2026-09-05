import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../migrations/types";
import { releaseRows } from "./extension-releases";
import { LifecycleError } from "../../extensions/v4/types";

export const EVENT_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface EventAdmissionIdentity {
  principalId: string;
  namespace: string;
  key: string;
}

export interface EventAdmission extends EventAdmissionIdentity {
  scope: string;
  payload: unknown;
}

export interface EventReceipt {
  id: string;
  scope: string;
  acceptedAt: number;
  retainUntil: number;
  deliveryIds: string[];
}

async function receiptId(identity: EventAdmissionIdentity): Promise<string> {
  if (typeof identity.principalId !== "string" || !identity.principalId || identity.principalId.length > 256 || typeof identity.namespace !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(identity.namespace) || typeof identity.key !== "string" || !/^[\x21-\x7e]{1,128}$/.test(identity.key)) throw new LifecycleError("invalid_event_key", "A bounded owner-scoped event key is required.");
  return sha256(canonicalJson([identity.principalId, identity.namespace, identity.key]));
}

export async function getEventReceipt(database: MigrationDb, identity: EventAdmissionIdentity): Promise<EventReceipt | null> {
  const id = await receiptId(identity);
  const rows = releaseRows<{ payload: string }>(await database.execute(sql`SELECT payload FROM extension_event_receipts WHERE id = ${id} AND principal_id = ${identity.principalId}`));
  return rows[0] ? JSON.parse(rows[0].payload) as EventReceipt : null;
}

export async function admitEventInTransaction(
  transaction: MigrationDb,
  admission: EventAdmission,
  publish: (eventId: string) => Promise<{ id: string }[]>,
  now = Date.now(),
): Promise<{ receipt: EventReceipt; accepted: boolean }> {
  const id = await receiptId(admission);
  if (typeof admission.scope !== "string" || !admission.scope || admission.scope.length > 256 || !Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - EVENT_RECEIPT_RETENTION_MS) throw new LifecycleError("invalid_event_scope", "A bounded host event scope and timestamp are required.");
  const payload = canonicalJson(admission.payload);
  if (Buffer.byteLength(payload) > 256 * 1024) throw new LifecycleError("event_payload_limit", "Event admission exceeds the durable payload limit.");
  const identityDigest = await sha256(canonicalJson([admission.scope, await sha256(payload)]));
  const receipt: EventReceipt = { id, scope: admission.scope, acceptedAt: now, retainUntil: now + EVENT_RECEIPT_RETENTION_MS, deliveryIds: [] };
  const inserted = releaseRows<{ id: string }>(await transaction.execute(sql`INSERT INTO extension_event_receipts(id, principal_id, identity_digest, retain_until, payload) VALUES (${id}, ${admission.principalId}, ${identityDigest}, ${receipt.retainUntil}, ${JSON.stringify(receipt)}) ON CONFLICT (id) DO NOTHING RETURNING id`));
  if (!inserted.length) {
    const [existing] = releaseRows<{ identity_digest: string; payload: string }>(await transaction.execute(sql`SELECT identity_digest, payload FROM extension_event_receipts WHERE id = ${id} FOR UPDATE`));
    if (!existing || existing.identity_digest !== identityDigest) throw new LifecycleError("event_conflict", "This event key was already used for a different payload or scope.");
    return { receipt: JSON.parse(existing.payload) as EventReceipt, accepted: false };
  }
  receipt.deliveryIds = (await publish(id)).map(delivery => delivery.id);
  if (receipt.deliveryIds.length > 1000 || receipt.deliveryIds.some(deliveryId => !deliveryId || deliveryId.length > 256)) throw new LifecycleError("event_recipient_limit", "Event admission exceeds the recipient limit.");
  await transaction.execute(sql`UPDATE extension_event_receipts SET payload = ${JSON.stringify(receipt)} WHERE id = ${id}`);
  return { receipt, accepted: true };
}

export async function purgeExpiredEventReceipts(transaction: MigrationDb, now = Date.now()): Promise<number> {
  if (!Number.isSafeInteger(now) || now < 0) throw new LifecycleError("invalid_event_scope", "A valid retention timestamp is required.");
  const deleted = releaseRows<{ id: string }>(await transaction.execute(sql`DELETE FROM extension_event_receipts WHERE id IN (
    SELECT r.id FROM extension_event_receipts r WHERE r.retain_until <= ${now}
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.payload::jsonb -> 'deliveryIds') AS reference(id)
      LEFT JOIN extension_release_deliveries d ON d.id = reference.id
      WHERE d.id IS NULL OR d.state NOT IN ('delivered', 'cancelled', 'dead_letter'))
    ORDER BY r.retain_until, r.id LIMIT 1000 FOR UPDATE OF r SKIP LOCKED
  ) RETURNING id`));
  return deleted.length;
}
