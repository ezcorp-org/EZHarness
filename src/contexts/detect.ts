/**
 * Stage 1 — topic DETECTION.
 *
 * Runs once per explicit "Analyze / Refresh". Feeds a tagged transcript to
 * the model and gets back a grammar-constrained list of topics, each with a
 * type drawn from the LIVE `context_types` enum and a set of anchor message
 * ids. The output is validated server-side (unknown types dropped, message
 * ids filtered to real ones, labels word-capped, topic count capped) before
 * it is persisted as a transactional replace-set + a staleness watermark.
 *
 * Accuracy discipline (see tasks/topic-contexts-spec.md):
 *   - the type enum is read LIVE and enforced (grammar on the sidecar lane,
 *     prompt-described everywhere, validated server-side always);
 *   - existing labels are fed to the prompt for verbatim reuse so
 *     re-detection keeps stable pill ids instead of spawning near-duplicates.
 */

import type { ContextsTarget } from "./config";
import { describeTarget, resolveContextsTarget } from "./config";
import type { ContextsCompletionRequest } from "./llm";
import { runContextsCompletion } from "./llm";
import type { ConversationTopic, ConversationTopicState } from "../db/schema";
import type { TopicInput, TopicStateInput } from "../db/queries/contexts";
import {
  getTopics as realGetTopics,
  listContextTypes as realListContextTypes,
  replaceTopics as realReplaceTopics,
  upsertTopicState as realUpsertTopicState,
} from "../db/queries/contexts";
import { getMessages as realGetMessages } from "../db/queries/conversations";
import { logger } from "../logger";

const log = logger.child("contexts.detect");

/** Per-message truncation before tagging — keeps one verbose turn from
 *  eating the whole budget. Mirrors the summarize-conversation precedent. */
export const MAX_PER_MESSAGE_CHARS = 500;
/** Total transcript cap (~15k tokens). Oldest messages are dropped whole so
 *  recent context survives and `[m:id]` tags never split. */
export const MAX_TRANSCRIPT_CHARS = 60_000;
/** Server-side cap on how many topics we keep from one detection pass. */
export const MAX_TOPICS = 12;
/** Labels are pill text — keep them short. */
export const MAX_LABEL_WORDS = 6;

interface DetectMessage {
  id: string;
  role: string;
  content: string;
}

/**
 * Build the detection transcript: each message tagged `[m:<id>]` with its
 * role, per-message-truncated, joined oldest→newest. When the total exceeds
 * the cap, whole messages are dropped from the OLDEST end (never mid-message,
 * so every `[m:id]` tag stays intact) and `truncated` is set.
 */
export function buildDetectTranscript(
  messages: DetectMessage[],
): { transcript: string; truncated: boolean } {
  const lines = messages.map((m) => {
    const body = m.content.length > MAX_PER_MESSAGE_CHARS
      ? `${m.content.slice(0, MAX_PER_MESSAGE_CHARS)}…`
      : m.content;
    return `[m:${m.id}] ${m.role}: ${body}`;
  });

  // Accumulate from the newest end until the next message would overflow.
  const kept: string[] = [];
  let total = 0;
  let truncated = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const add = line.length + 1; // +1 for the join newline
    if (total + add > MAX_TRANSCRIPT_CHARS && kept.length > 0) {
      truncated = true;
      break;
    }
    kept.push(line);
    total += add;
  }
  kept.reverse();
  const transcript = truncated
    ? `…[older messages truncated]…\n${kept.join("\n")}`
    : kept.join("\n");
  return { transcript, truncated };
}

/** JSON schema constraining detection output to the LIVE type ids. */
export function buildDetectSchema(typeIds: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      topics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            type: { type: "string", enum: typeIds },
            messageIds: { type: "array", items: { type: "string" } },
          },
          required: ["label", "type", "messageIds"],
          additionalProperties: false,
        },
      },
    },
    required: ["topics"],
    additionalProperties: false,
  };
}

interface ContextTypeRow {
  id: string;
  label: string;
  description: string;
}

/** Detection system prompt: live type definitions + existing labels for
 *  verbatim reuse + the JSON schema described in words (the pi lane cannot
 *  see `response_format`). */
export function buildDetectSystemPrompt(
  types: ContextTypeRow[],
  existingLabels: string[],
): string {
  const typeLines = types.map((t) => `- ${t.id} (${t.label}): ${t.description}`).join("\n");
  const parts = [
    "You analyze a chat conversation and identify the distinct TOPICS discussed.",
    "A topic is a single coherent subject: a feature, an idea, a decision, a bug fix, etc.",
    "",
    "Classify each topic's `type` using ONLY one of these exact ids:",
    typeLines,
    "",
    "For each topic, list the ids of the messages most relevant to it, using the",
    "`[m:<id>]` tags in the transcript. Use the message ids verbatim.",
  ];
  if (existingLabels.length > 0) {
    parts.push(
      "",
      "These topic labels already exist for this conversation. REUSE a label",
      "VERBATIM when a topic matches it (do not invent a near-duplicate):",
      existingLabels.map((l) => `- ${l}`).join("\n"),
    );
  }
  parts.push(
    "",
    'Respond with ONLY a JSON object of the shape',
    '{"topics": [{"label": string, "type": <one of the ids above>, "messageIds": string[]}]}',
    `— no markdown, no prose around it. Keep labels under ${MAX_LABEL_WORDS} words. /no_think`,
  );
  return parts.join("\n");
}

export interface RawTopic {
  label: unknown;
  type: unknown;
  messageIds: unknown;
}

/**
 * Tolerant parse of a detection response: strips `<think>` blocks, slices the
 * outermost `{…}`, and JSON-parses it. Throws when no object is present or
 * the `topics` array is missing — the caller surfaces that as a failure
 * (never a silent empty result).
 */
export function parseDetectResponse(content: string): RawTopic[] {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = withoutThinking.indexOf("{");
  const end = withoutThinking.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("detection response contained no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutThinking.slice(start, end + 1));
  } catch (err) {
    throw new Error(`detection response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const topics = (parsed as { topics?: unknown })?.topics;
  if (!Array.isArray(topics)) {
    throw new Error("detection response was missing a `topics` array");
  }
  return topics as RawTopic[];
}

/**
 * Validate + normalize raw topics against the live type ids and the real
 * message ids: drop unknown types, filter anchor ids to real ones, word-cap
 * labels, and cap the topic count. Invalid-but-recoverable entries are kept
 * (a topic with all-unknown anchors still lists in the popover); entries with
 * no usable label or type are dropped.
 */
export function validateTopics(
  raw: RawTopic[],
  opts: { typeIds: Set<string>; realMessageIds: Set<string> },
): TopicInput[] {
  const out: TopicInput[] = [];
  for (const t of raw) {
    if (out.length >= MAX_TOPICS) break;
    const label = typeof t.label === "string" ? t.label.trim() : "";
    if (!label) continue;
    const type = typeof t.type === "string" ? t.type : "";
    if (!opts.typeIds.has(type)) {
      log.warn("dropping detected topic with unknown type", { label, type });
      continue;
    }
    const cappedLabel = label.split(/\s+/).slice(0, MAX_LABEL_WORDS).join(" ");
    const messageIds = Array.isArray(t.messageIds)
      ? t.messageIds.filter((id): id is string => typeof id === "string" && opts.realMessageIds.has(id))
      : [];
    out.push({ label: cappedLabel, typeId: type, messageIds });
  }
  return out;
}

export interface DetectDeps {
  resolveTarget: (conversationId: string) => Promise<ContextsTarget>;
  runCompletion: (req: ContextsCompletionRequest) => Promise<string>;
  getMessages: (conversationId: string) => Promise<DetectMessage[]>;
  listContextTypes: () => Promise<ContextTypeRow[]>;
  getExistingTopics: (conversationId: string) => Promise<Array<{ label: string }>>;
  replaceTopics: (conversationId: string, topics: TopicInput[]) => Promise<ConversationTopic[]>;
  upsertTopicState: (conversationId: string, input: TopicStateInput) => Promise<ConversationTopicState>;
}

const DEFAULT_DETECT_DEPS: DetectDeps = {
  resolveTarget: (conversationId) => resolveContextsTarget(conversationId),
  runCompletion: (req) => runContextsCompletion(req),
  getMessages: realGetMessages,
  listContextTypes: realListContextTypes,
  getExistingTopics: realGetTopics,
  replaceTopics: realReplaceTopics,
  upsertTopicState: realUpsertTopicState,
};

export interface DetectResult {
  topics: ConversationTopic[];
  analyzedAt: string;
  model: string;
}

/**
 * Detect + persist topics for a conversation. Resolves the model target
 * (throws `ContextsUnavailableError` when the ladder is exhausted), runs the
 * grammar-constrained pass, validates, and writes the replace-set + watermark
 * transactionally-per-query. An empty conversation short-circuits: it clears
 * topics and writes a zero-count watermark without calling the LLM.
 */
export async function detectTopics(
  conversationId: string,
  overrides: Partial<DetectDeps> = {},
): Promise<DetectResult> {
  const deps = { ...DEFAULT_DETECT_DEPS, ...overrides };
  const target = await deps.resolveTarget(conversationId);
  const model = describeTarget(target);

  const messages = await deps.getMessages(conversationId);
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]!.id : null;

  if (messages.length === 0) {
    const cleared = await deps.replaceTopics(conversationId, []);
    const state = await deps.upsertTopicState(conversationId, {
      lastMessageId,
      messageCount: 0,
      model,
    });
    return { topics: cleared, analyzedAt: state.analyzedAt.toISOString(), model };
  }

  const [types, existing] = await Promise.all([
    deps.listContextTypes(),
    deps.getExistingTopics(conversationId),
  ]);
  const typeIds = types.map((t) => t.id);

  const { transcript } = buildDetectTranscript(messages);
  const systemPrompt = buildDetectSystemPrompt(types, existing.map((e) => e.label));

  const rawText = await deps.runCompletion({
    target,
    systemPrompt,
    userPrompt: transcript,
    schema: buildDetectSchema(typeIds),
    schemaName: "topic_detection",
    temperature: 0.2,
    maxTokens: 1_500,
    conversationId,
  });

  const validated = validateTopics(parseDetectResponse(rawText), {
    typeIds: new Set(typeIds),
    realMessageIds: new Set(messages.map((m) => m.id)),
  });

  const topics = await deps.replaceTopics(conversationId, validated);
  const state = await deps.upsertTopicState(conversationId, {
    lastMessageId,
    messageCount: messages.length,
    model,
  });

  return { topics, analyzedAt: state.analyzedAt.toISOString(), model };
}
