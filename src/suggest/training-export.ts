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
import type { ExtensionManifestV2 } from "../extensions/types";

export interface PromptToolRow {
  messageId: string;
  prompt: string;
  toolName: string;
}

export interface TrainingExample {
  /** Provenance: `"history"` from real prompt→tool usage, `"manifest"` from an
   *  extension's authored `suggestExamples` (synthetic). Stamped from the
   *  grouping messageId's `synthetic:` prefix — lets the export log a
   *  real/synthetic split. */
  source?: "history" | "manifest";
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

/** messageId prefix marking a synthetic (manifest-authored) row so
 *  `buildTrainingExamples` can stamp `source: "manifest"` and
 *  `dedupeSyntheticRows` can key off it. */
export const SYNTHETIC_PREFIX = "synthetic:";

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
  return [...byMessage.entries()].map(([messageId, entry]) => ({
    source: messageId.startsWith(SYNTHETIC_PREFIX) ? ("manifest" as const) : ("history" as const),
    messages: [
      { role: "system" as const, content: TRAINING_SYSTEM_PROMPT },
      { role: "user" as const, content: entry.prompt.slice(0, MAX_TRAINING_PROMPT_LENGTH) },
      { role: "assistant" as const, content: JSON.stringify({ tools: [...entry.tools].sort() }) },
    ],
  }));
}

/**
 * Build synthetic prompt→tool rows from extension manifests' authored
 * `suggestExamples`, so an example phrasing trains the model toward the
 * tool(s) it should surface even before any real usage history exists:
 *
 *   - a per-TOOL example → one row mapping the phrasing to that single
 *     namespaced tool (`${ext}__${tool}`);
 *   - an extension-level example → one row PER declared tool, all sharing a
 *     messageId so `buildTrainingExamples` groups them into a single example
 *     whose completion target is the extension's whole tool set.
 *
 * messageIds carry the `synthetic:` prefix so downstream provenance
 * (`source: "manifest"`) and dedupe can key off it. An extension-level
 * example on a tool-less manifest yields no rows (nothing to map to).
 */
export function syntheticPromptToolRows(
  manifests: Array<Pick<ExtensionManifestV2, "name" | "tools" | "suggestExamples">>,
): PromptToolRow[] {
  const rows: PromptToolRow[] = [];
  for (const manifest of manifests) {
    const ext = manifest.name;
    const tools = manifest.tools ?? [];
    for (const tool of tools) {
      const examples = tool.suggestExamples ?? [];
      for (let i = 0; i < examples.length; i++) {
        rows.push({
          messageId: `${SYNTHETIC_PREFIX}${ext}:${tool.name}:${i}`,
          prompt: examples[i]!,
          toolName: `${ext}__${tool.name}`,
        });
      }
    }
    const extExamples = manifest.suggestExamples ?? [];
    for (let i = 0; i < extExamples.length; i++) {
      const messageId = `${SYNTHETIC_PREFIX}${ext}::${i}`;
      for (const tool of tools) {
        rows.push({
          messageId,
          prompt: extExamples[i]!,
          toolName: `${ext}__${tool.name}`,
        });
      }
    }
  }
  return rows;
}

/** Normalize a prompt for dedupe: trim, collapse internal whitespace, lowercase. */
function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Drop synthetic rows whose (normalized) prompt already appears in the real
 * history — real usage always outranks an authored surrogate, and keeping
 * both would double-weight the phrasing in the fine-tune.
 */
export function dedupeSyntheticRows(
  real: PromptToolRow[],
  synthetic: PromptToolRow[],
): PromptToolRow[] {
  const realPrompts = new Set(real.map((r) => normalizePrompt(r.prompt)));
  return synthetic.filter((r) => !realPrompts.has(normalizePrompt(r.prompt)));
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
