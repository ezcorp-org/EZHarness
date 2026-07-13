/**
 * Stage 2 — topic EXTRACTION.
 *
 * Runs once per pill click. Feeds the FULL transcript (anchor messages
 * marked `>>> [RELEVANT TO TOPIC]`) to the model with a verbatim-biased
 * prompt and gets back PLAIN MARKDOWN (no JSON — escaping code blocks
 * through JSON wrecks small models). The type is COPIED from the topic row
 * (classification already happened, enum-constrained, in detection), and the
 * result is upserted into the library with model provenance.
 */

import type { ContextsTarget } from "./config";
import { describeTarget, resolveContextsTarget } from "./config";
import type { ContextsCompletionRequest } from "./llm";
import { runContextsCompletion } from "./llm";
import { MAX_TRANSCRIPT_CHARS } from "./detect";
import type { SavedContext } from "../db/schema";
import type { UpsertSavedContextInput } from "../db/queries/contexts";
import {
  listContextTypes as realListContextTypes,
  upsertSavedContext as realUpsertSavedContext,
} from "../db/queries/contexts";
import { getMessages as realGetMessages } from "../db/queries/conversations";

interface ExtractMessage {
  id: string;
  role: string;
  content: string;
}

interface ContextTypeRow {
  id: string;
  label: string;
  description: string;
}

/**
 * Build the extraction transcript: the FULL conversation (no per-message
 * truncation — verbatim fidelity matters here), anchor messages prefixed
 * with `>>> [RELEVANT TO TOPIC]`. Capped at MAX_TRANSCRIPT_CHARS, dropping
 * whole messages from the OLDEST end so recent context and code blocks stay
 * intact.
 */
export function buildExtractTranscript(
  messages: ExtractMessage[],
  anchorIds: Set<string>,
): { transcript: string; truncated: boolean } {
  const lines = messages.map((m) => {
    const marker = anchorIds.has(m.id) ? ">>> [RELEVANT TO TOPIC]\n" : "";
    return `${marker}${m.role}: ${m.content}`;
  });

  const kept: string[] = [];
  let total = 0;
  let truncated = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const add = line.length + 2; // +2 for the blank-line join
    if (total + add > MAX_TRANSCRIPT_CHARS && kept.length > 0) {
      truncated = true;
      break;
    }
    kept.push(line);
    total += add;
  }
  kept.reverse();
  const transcript = truncated
    ? `…[older messages truncated]…\n\n${kept.join("\n\n")}`
    : kept.join("\n\n");
  return { transcript, truncated };
}

/** Verbatim-biased extraction prompt. */
export function buildExtractSystemPrompt(topicLabel: string, typeLabel: string): string {
  return [
    `Extract everything in the conversation that is relevant to this topic:`,
    `  "${topicLabel}" (a ${typeLabel}).`,
    "",
    "Rules:",
    "- Use the EXACT wording from the conversation for decisions, names, and numbers.",
    "- Reproduce any relevant code blocks COMPLETE and VERBATIM, in fenced code blocks.",
    "- Do NOT include anything that is not present in the conversation. Do not speculate.",
    "- The messages marked `>>> [RELEVANT TO TOPIC]` are the primary anchors; include",
    "  closely related context from elsewhere in the conversation when it helps.",
    "",
    "Respond with well-structured plain Markdown only — no preamble, no JSON, no",
    "commentary about the task itself. /no_think",
  ].join("\n");
}

/** Remove `<think>` reasoning blocks and trim. */
export function stripThink(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * Compose the saved-context title: the first Markdown H1 in the extracted
 * content when present (models often lead with one), else the topic label.
 * Capped so a runaway heading can't bloat the row.
 */
export function composeTitle(topicLabel: string, content: string): string {
  const h1 = content.match(/^\s*#\s+(.+?)\s*$/m);
  const raw = h1?.[1]?.trim() || topicLabel.trim();
  return raw.slice(0, 200);
}

const TRUNCATION_NOTE = "\n\n*(Extracted from the most recent portion of a long conversation.)*";

export interface ExtractDeps {
  resolveTarget: (conversationId: string) => Promise<ContextsTarget>;
  runCompletion: (req: ContextsCompletionRequest) => Promise<string>;
  getMessages: (conversationId: string) => Promise<ExtractMessage[]>;
  listContextTypes: () => Promise<ContextTypeRow[]>;
  upsertSavedContext: (input: UpsertSavedContextInput) => Promise<SavedContext>;
}

const DEFAULT_EXTRACT_DEPS: ExtractDeps = {
  resolveTarget: (conversationId) => resolveContextsTarget(conversationId),
  runCompletion: (req) => runContextsCompletion(req),
  getMessages: realGetMessages,
  listContextTypes: realListContextTypes,
  upsertSavedContext: realUpsertSavedContext,
};

export interface ExtractParams {
  conversationId: string;
  topic: { label: string; typeId: string; messageIds: string[] };
  userId: string;
  projectId: string | null;
}

/**
 * Extract the topic's context and upsert it into the library. Resolves the
 * model target (throws `ContextsUnavailableError` when exhausted), runs the
 * plain-markdown pass, strips thinking, and persists with the type copied
 * from the topic row + model provenance. Throws on an empty model response
 * (never saves a blank snapshot).
 */
export async function extractContext(
  params: ExtractParams,
  overrides: Partial<ExtractDeps> = {},
): Promise<SavedContext> {
  const deps = { ...DEFAULT_EXTRACT_DEPS, ...overrides };
  const target = await deps.resolveTarget(params.conversationId);
  const model = describeTarget(target);

  const [messages, types] = await Promise.all([
    deps.getMessages(params.conversationId),
    deps.listContextTypes(),
  ]);
  const typeLabel = types.find((t) => t.id === params.topic.typeId)?.label ?? params.topic.typeId;

  const { transcript, truncated } = buildExtractTranscript(
    messages,
    new Set(params.topic.messageIds),
  );

  const rawText = await deps.runCompletion({
    target,
    systemPrompt: buildExtractSystemPrompt(params.topic.label, typeLabel),
    userPrompt: transcript,
    temperature: 0.2,
    maxTokens: 4_000,
    conversationId: params.conversationId,
  });

  let content = stripThink(rawText);
  if (!content) {
    throw new Error("topic extraction returned no content");
  }
  if (truncated) content += TRUNCATION_NOTE;

  return deps.upsertSavedContext({
    userId: params.userId,
    projectId: params.projectId,
    conversationId: params.conversationId,
    topicLabel: params.topic.label,
    typeId: params.topic.typeId,
    title: composeTitle(params.topic.label, content),
    content,
    model,
    messageCount: messages.length,
  });
}
