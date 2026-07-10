/**
 * Offline training-data export: prompt → tool-call pairs harvested from the
 * platform's OWN stored history, emitted as chat-format JSONL ready for a
 * LoRA fine-tune (Unsloth → GGUF → `ollama create`; full runbook in
 * docs/features/composer/suggestions.md).
 *
 * Privacy contract: nothing here runs at request time. The export only
 * happens when an operator explicitly invokes
 * `bun scripts/suggest/export-training-data.ts`, and the dataset lands in
 * the gitignored `.ezcorp/` tree on their own box.
 */
import { rawQuery } from "../db/connection";

export interface PromptToolRow {
  messageId: string;
  prompt: string;
  toolName: string;
}

export interface TrainingExample {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export const TRAINING_SYSTEM_PROMPT =
  'Given a user\'s chat prompt, respond with a JSON object naming the platform tools most relevant to fulfilling it: {"tools": ["tool_name", ...]}.';

/** Prompts shorter than this carry no learnable signal ("ok", "thanks"). */
export const MIN_TRAINING_PROMPT_LENGTH = 8;
/** Cap per-example prompt size so one pasted wall of text can't dominate. */
export const MAX_TRAINING_PROMPT_LENGTH = 2000;

/**
 * Group raw (prompt, tool) rows into one example per user message, with the
 * message's full tool set (deduped, sorted) as the completion target.
 */
export function buildTrainingExamples(rows: PromptToolRow[]): TrainingExample[] {
  const byMessage = new Map<string, { prompt: string; tools: Set<string> }>();
  for (const row of rows) {
    const prompt = row.prompt.trim();
    if (prompt.length < MIN_TRAINING_PROMPT_LENGTH) continue;
    const entry = byMessage.get(row.messageId) ?? { prompt, tools: new Set<string>() };
    entry.tools.add(row.toolName);
    byMessage.set(row.messageId, entry);
  }
  return [...byMessage.values()].map((entry) => ({
    messages: [
      { role: "system" as const, content: TRAINING_SYSTEM_PROMPT },
      { role: "user" as const, content: entry.prompt.slice(0, MAX_TRAINING_PROMPT_LENGTH) },
      { role: "assistant" as const, content: JSON.stringify({ tools: [...entry.tools].sort() }) },
    ],
  }));
}

export function toJsonl(examples: TrainingExample[]): string {
  return examples.length === 0 ? "" : `${examples.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/**
 * Pair every successful tool call with the user message that triggered it:
 * the latest role='user' message in the same conversation at-or-before the
 * call. LATERAL keeps it one pass; the window bounds the scan.
 */
export async function collectPromptToolRows(days = 365): Promise<PromptToolRow[]> {
  const { rows } = await rawQuery(
    `SELECT m.id AS message_id, m.content AS prompt, tc.tool_name
       FROM tool_calls tc
       JOIN LATERAL (
         SELECT m2.id, m2.content
           FROM messages m2
          WHERE m2.conversation_id = tc.conversation_id
            AND m2.role = 'user'
            AND m2.created_at <= tc.created_at
          ORDER BY m2.created_at DESC
          LIMIT 1
       ) m ON TRUE
      WHERE tc.conversation_id IS NOT NULL
        AND tc.success = TRUE
        AND tc.created_at > NOW() - make_interval(days => $1::int)`,
    [String(days)],
  );
  return (rows as Array<{ message_id: string; prompt: string; tool_name: string }>).map((r) => ({
    messageId: r.message_id,
    prompt: r.prompt,
    toolName: r.tool_name,
  }));
}
