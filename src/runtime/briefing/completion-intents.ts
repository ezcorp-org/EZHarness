import { sql } from "drizzle-orm";
import { getDb, type DbTransaction } from "../../db/connection";
import { releaseRows } from "../../db/queries/extension-releases";
import { publishDomainEvent, type DomainExtensionEvent } from "../../extensions/domain-event-outbox";
import { LifecycleError } from "../../extensions/v4/types";

interface Intent { runId: string; conversationId: string; userId: string; projectId: string }
const retentionMs = 30 * 60 * 1000;

export function briefingCompletionEvents(intent: Intent): DomainExtensionEvent[] {
  const payload = { conversationId: intent.conversationId, userId: intent.userId, projectId: intent.projectId };
  return [
    { id: `${intent.runId}:created`, type: "conversation:created", conversationId: intent.conversationId, payload: { ...payload, source: "briefing" } },
    { id: `${intent.runId}:delivered`, type: "briefing:delivered", conversationId: intent.conversationId, payload },
  ];
}

export async function registerBriefingCompletionIntent(intent: Intent): Promise<void> {
  if ([intent.runId, intent.conversationId, intent.userId, intent.projectId].some(value => typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))) throw new LifecycleError("invalid_event", "Invalid host briefing identity.");
  await getDb().transaction(async (transaction: DbTransaction) => {
    await transaction.execute(sql`LOCK TABLE run_domain_event_intents IN SHARE ROW EXCLUSIVE MODE`);
    const owners = releaseRows<{ userId: string; projectId: string }>(await transaction.execute(sql`SELECT c.user_id AS "userId", c.project_id AS "projectId" FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ${intent.conversationId} AND u.status = 'active' FOR SHARE OF c, u`));
    if (owners[0]?.userId !== intent.userId || owners[0]?.projectId !== intent.projectId) throw new LifecycleError("invalid_event", "Briefing intent does not match its current conversation owner.");
    const existing = releaseRows<Intent>(await transaction.execute(sql`SELECT run_id AS "runId", conversation_id AS "conversationId", user_id AS "userId", project_id AS "projectId" FROM run_domain_event_intents WHERE run_id = ${intent.runId}`));
    if (existing[0]) {
      if (existing[0].conversationId !== intent.conversationId || existing[0].userId !== intent.userId || existing[0].projectId !== intent.projectId) throw new LifecycleError("invalid_event", "A run cannot replace its briefing intent.");
      return;
    }
    const counts = releaseRows<{ total: number; owned: number }>(await transaction.execute(sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE user_id = ${intent.userId})::int AS owned FROM run_domain_event_intents`));
    if ((counts[0]?.total ?? 0) >= 10000 || (counts[0]?.owned ?? 0) >= 128) throw new LifecycleError("event_queue_full", "Pending briefing intent capacity is exhausted.");
    await transaction.execute(sql`INSERT INTO run_domain_event_intents(run_id, conversation_id, user_id, project_id) VALUES (${intent.runId}, ${intent.conversationId}, ${intent.userId}, ${intent.projectId})`);
  });
}

export async function consumeRunCompletionIntent(transaction: DbTransaction, run: { runId: string; status: string; conversationId?: string | null }): Promise<void> {
  if (!["success", "error", "cancelled"].includes(run.status)) return;
  const intents = releaseRows<Intent>(await transaction.execute(sql`SELECT run_id AS "runId", conversation_id AS "conversationId", user_id AS "userId", project_id AS "projectId" FROM run_domain_event_intents WHERE run_id = ${run.runId} FOR UPDATE`));
  const intent = intents[0];
  if (!intent) return;
  if (intent.conversationId !== run.conversationId) throw new LifecycleError("invalid_event", "Terminal run does not match its briefing conversation.");
  if (run.status === "success") {
    const owners = releaseRows<{ userId: string; projectId: string }>(await transaction.execute(sql`SELECT user_id AS "userId", project_id AS "projectId" FROM conversations WHERE id = ${intent.conversationId} FOR SHARE`));
    const content = releaseRows<{ content: string }>(await transaction.execute(sql`SELECT content FROM messages WHERE conversation_id = ${intent.conversationId} AND role = 'assistant' FOR SHARE`));
    if (owners[0]?.userId === intent.userId && owners[0]?.projectId === intent.projectId && content.some(message => message.content.trim().length > 0)) for (const event of briefingCompletionEvents(intent)) await publishDomainEvent(transaction, event);
  }
  await transaction.execute(sql`DELETE FROM run_domain_event_intents WHERE run_id = ${run.runId}`);
}

export async function recoverRunCompletionIntents(now = Date.now()): Promise<number> {
  return getDb().transaction(async (transaction: DbTransaction) => {
    const pending = releaseRows<{ runId: string; status: string | null; conversationId: string | null }>(await transaction.execute(sql`SELECT i.run_id AS "runId", r.status, r.conversation_id AS "conversationId" FROM run_domain_event_intents i LEFT JOIN runs r ON r.id = i.run_id WHERE r.status IN ('success', 'error', 'cancelled') OR (r.id IS NULL AND i.created_at < ${new Date(now - retentionMs)}) ORDER BY i.created_at LIMIT 100 FOR UPDATE OF i SKIP LOCKED`));
    for (const run of pending) {
      if (run.status === null) await transaction.execute(sql`DELETE FROM run_domain_event_intents WHERE run_id = ${run.runId}`);
      else await consumeRunCompletionIntent(transaction, { ...run, status: run.status });
    }
    return pending.length;
  });
}
