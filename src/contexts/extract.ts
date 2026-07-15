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
import { MAX_TRANSCRIPT_CHARS, isConversationalMessage } from "./detect";
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

/** Verbatim-biased extraction prompt: a structured, self-contained Markdown
 *  record of one topic. Always opens with a topic-tag block (topic + "where it
 *  stands") followed by the optional details / code / open-questions sections. */
export function buildExtractSystemPrompt(topicLabel: string, typeLabel: string): string {
  return `You are extracting the complete record of ONE topic from a chat conversation.

Topic: "${topicLabel}" (${typeLabel})

Write a self-contained Markdown document that lets someone act on this topic without reading the conversation. Use this structure. The heading and the tag block are ALWAYS required. Omit the other sections only when they have no content:

# ${topicLabel}
> **Topic:** ${topicLabel} (${typeLabel})
> **Where it stands:** 1-3 sentences summarizing the current state of the work on this topic — what has been decided or completed, and what is actively being worked on now.

**Details** — every requirement, decision, number, name, and constraint about this topic, as bullets, using the conversation's EXACT wording for decisions, names, and numbers.

**Code** — every relevant code block, COMPLETE and VERBATIM, in fenced blocks with the original language.

**Open questions** — anything about this topic raised but not resolved.

Rules:
- Include ONLY what is actually in the conversation. Never invent, assume, or fill gaps.
- Make every bullet self-contained: replace pronouns like "it" / "that approach" with the thing they refer to.
- Conversations evolve: when later messages change or override earlier ones, record the FINAL state and note what it replaced ("initially X, changed to Y").
- For "Where it stands", prioritize the MOST RECENT messages — they reflect the current state of the work.
- Messages marked \`>>> [RELEVANT TO TOPIC]\` are the primary anchors; also pull in related context from anywhere else in the conversation when it belongs to this topic.
- Ignore other topics, greetings, and meta-chat about the assistant itself.
- Output the Markdown document only — no preamble, no commentary about the task. /no_think`;
}

/**
 * Recency anchor: small models drift from the system instruction after a long
 * transcript, so the user prompt is the transcript PLUS a trailing reminder of
 * the task + the target topic. Restates "Markdown only" right before decoding.
 */
export function buildExtractUserPrompt(transcript: string, topicLabel: string): string {
  return `${transcript}\n\n---\nNow extract the context for topic "${topicLabel}" following the system instructions. Markdown only.`;
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

  // Strip UI-only telemetry / tool-card rows + empty turns so raw
  // capability-event JSON never leaks into the extracted markdown.
  const conversational = messages.filter(isConversationalMessage);
  const { transcript, truncated } = buildExtractTranscript(
    conversational,
    new Set(params.topic.messageIds),
  );

  const rawText = await deps.runCompletion({
    target,
    systemPrompt: buildExtractSystemPrompt(params.topic.label, typeLabel),
    userPrompt: buildExtractUserPrompt(transcript, params.topic.label),
    temperature: 0.1,
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
