/**
 * Composer-suggestions telemetry writes. Content-free by contract — see
 * src/db/migrations/add-suggestion-feedback.ts. Reads are operator-side
 * SQL for now (acceptance-rate rollups live on the indexes this table
 * ships with).
 */
import { getDb } from "../connection";
import { suggestionFeedback } from "../schema";

export interface SuggestionFeedbackEvent {
  userId: string;
  conversationId?: string | null;
  kind: "tool" | "enhance";
  action: "shown" | "accepted" | "dismissed";
  toolName?: string | null;
  latencyMs?: number | null;
}

export async function insertSuggestionFeedback(event: SuggestionFeedbackEvent): Promise<void> {
  await getDb().insert(suggestionFeedback).values({
    userId: event.userId,
    conversationId: event.conversationId ?? null,
    kind: event.kind,
    action: event.action,
    toolName: event.toolName ?? null,
    latencyMs: event.latencyMs ?? null,
  });
}
