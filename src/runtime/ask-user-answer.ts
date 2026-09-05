import { sha256 } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { getDb, type DbTransaction } from "../db/connection";
import { admitEventInTransaction, getEventReceipt } from "../db/queries/extension-event-receipts";
import { releaseRows } from "../db/queries/extension-releases";
import { emitPersistedDomainEvent, publishDomainEvent, type DomainExtensionEvent } from "../extensions/domain-event-outbox";
import { LifecycleError } from "../extensions/v4/types";
import type { AgentEvents } from "../types";
import type { EventBus } from "./events";
import { getPendingAskUser } from "./ask-user-registry";

export async function acceptAskUserAnswer(principalId: string, toolCallId: string, answer: string, bus: EventBus<AgentEvents>): Promise<boolean> {
  if (!principalId || !toolCallId || toolCallId.length > 256 || !answer || Buffer.byteLength(answer) > 64 * 1024) throw new LifecycleError("invalid_answer", "A bounded question and answer are required.");
  const pending = getPendingAskUser(toolCallId);
  if (pending && pending.userId !== principalId) throw new LifecycleError("event_not_found", "Question not found.");
  const identity = { principalId, namespace: "ask-user:answer", key: await sha256(toolCallId) };
  let event: DomainExtensionEvent | undefined;
  const accepted = await getDb().transaction(async (transaction: DbTransaction) => {
    const previous = await getEventReceipt(transaction, identity);
    const conversationId = pending?.conversationId ?? previous?.scope;
    if (!conversationId) return false;
    const owners = releaseRows<{ id: string }>(await transaction.execute(sql`SELECT c.id FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ${conversationId} AND c.user_id = ${principalId} AND u.status = 'active' AND (u.role = 'admin' OR c.project_id IS NULL OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = c.project_id AND pm.user_id = u.id AND pm.role IN ('member', 'owner'))) FOR SHARE OF c, u`));
    if (!owners.length) throw new LifecycleError("event_not_found", "Question not found.");
    const payload = { toolCallId, conversationId, answer };
    const result = await admitEventInTransaction(transaction, { ...identity, scope: conversationId, payload }, async id => {
      event = { id, type: "ask-user:answer", conversationId, payload };
      return publishDomainEvent(transaction, event);
    });
    return result.accepted;
  });
  if (accepted && event) emitPersistedDomainEvent(bus, event);
  return accepted;
}
