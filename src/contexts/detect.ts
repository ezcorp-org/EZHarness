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
  ensureContextType as realEnsureContextType,
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
/** Anti-sprawl: at most this many NEW `auto` types created per detection pass.
 *  Beyond the cap, un-resolvable proposals fall back to the seeded type below. */
export const MAX_NEW_TYPES_PER_PASS = 3;
/** Seeded type used when a proposed type can't be resolved or created. */
export const FALLBACK_TYPE_ID = "idea";
/** Max length of a normalized type slug. */
export const MAX_TYPE_SLUG_CHARS = 30;

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

/**
 * JSON schema for detection output. `type` is an OPEN plain string (not a
 * closed enum) so the model can propose new type ids; the grammar still
 * guarantees a valid JSON shape, and the anti-sprawl discipline (prefer
 * existing ids, cap new types) lives in the prompt + server validation.
 * `typeDescription` is optional — the model fills it only for a NEW type.
 */
export function buildDetectSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      topics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            type: { type: "string" },
            typeDescription: { type: "string" },
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
    "Each topic has a `type`. These types already exist (id — description):",
    typeLines,
    "",
    "Use an existing type id whenever one fits — this is strongly preferred. ONLY if",
    "none fits, invent a NEW type id: short kebab-case, singular, generic enough to",
    "reuse across many conversations (e.g. 'design-review', 'incident'). Never invent a",
    "near-duplicate of an existing type (no plural/spelling/synonym variants). When you",
    "invent a new type, also give it a one-line `typeDescription`.",
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
    '{"topics": [{"label": string, "type": string, "typeDescription"?: string, "messageIds": string[]}]}',
    `— no markdown, no prose around it. Keep labels under ${MAX_LABEL_WORDS} words. /no_think`,
  );
  return parts.join("\n");
}

export interface RawTopic {
  label: unknown;
  type: unknown;
  /** Only present when the model proposes a NEW type. */
  typeDescription?: unknown;
  messageIds: unknown;
}

/**
 * Normalize a model-proposed type into a safe kebab-case slug: trim,
 * lowercase, spaces/underscores → hyphens, strip anything outside [a-z0-9-],
 * collapse repeat hyphens, trim leading/trailing hyphens, cap at
 * MAX_TYPE_SLUG_CHARS. Returns "" when nothing survives (→ fallback type).
 */
export function normalizeTypeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TYPE_SLUG_CHARS)
    .replace(/-+$/g, "");
}

/** Hyphen-collapsed keys of a slug plus its singular forms (strip a trailing
 *  `s` or `es`) — the equality set used for trivial-variant matching. */
function typeVariantKeys(slug: string): Set<string> {
  const collapsed = slug.replace(/-/g, "");
  const keys = new Set<string>([collapsed]);
  if (collapsed.endsWith("es")) keys.add(collapsed.slice(0, -2));
  if (collapsed.endsWith("s")) keys.add(collapsed.slice(0, -1));
  return keys;
}

/**
 * Return the existing type id a normalized slug should reuse — exact match,
 * or a trivial variant (singular/plural `s`/`es`, hyphen-collapsed equality)
 * so `bug-fixes`→`bug-fix` and `bugfix`→`bug-fix`. `undefined` when the slug
 * is genuinely new.
 */
export function matchExistingType(slug: string, existingIds: string[]): string | undefined {
  if (!slug) return undefined;
  if (existingIds.includes(slug)) return slug;
  const candKeys = typeVariantKeys(slug);
  for (const id of existingIds) {
    for (const k of typeVariantKeys(id)) {
      if (candKeys.has(k)) return id;
    }
  }
  return undefined;
}

/** Human label for a new auto type: Title-Case the kebab slug. */
export function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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

export interface ValidateTopicsOpts {
  /** Live type ids for reuse matching (grows as new types are created). */
  existingTypeIds: string[];
  realMessageIds: Set<string>;
  ensureContextType: (t: {
    id: string;
    label: string;
    description: string;
  }) => Promise<{ id: string }>;
}

/**
 * Validate + resolve raw topics. Labels are word-capped and empty-label
 * entries dropped; message ids are filtered to real ones; the topic count is
 * capped at MAX_TOPICS. The `type` is resolved on the OPEN taxonomy: an
 * existing id (exact or trivial variant) is reused; an otherwise-new slug is
 * created via `ensureContextType` (source='auto'), capped at
 * MAX_NEW_TYPES_PER_PASS per pass; beyond the cap — or for an empty/invalid
 * slug — the topic falls back to the seeded FALLBACK_TYPE_ID with a warn.
 * Types are ensured HERE, before the caller's `replaceTopics`, so the
 * topic → type FK (RESTRICT) always resolves.
 */
export async function validateTopics(
  raw: RawTopic[],
  opts: ValidateTopicsOpts,
): Promise<TopicInput[]> {
  const out: TopicInput[] = [];
  const known = [...opts.existingTypeIds];
  let created = 0;
  for (const t of raw) {
    if (out.length >= MAX_TOPICS) break;
    const label = typeof t.label === "string" ? t.label.trim() : "";
    if (!label) continue;

    const slug = normalizeTypeSlug(typeof t.type === "string" ? t.type : "");
    const match = matchExistingType(slug, known);
    let typeId: string;
    if (match) {
      typeId = match;
    } else if (slug && created < MAX_NEW_TYPES_PER_PASS) {
      const typeLabel = titleCaseSlug(slug);
      const proposedDesc = typeof t.typeDescription === "string" ? t.typeDescription.trim() : "";
      const row = await opts.ensureContextType({
        id: slug,
        label: typeLabel,
        description: proposedDesc || `Auto-detected: ${typeLabel}`,
      });
      known.push(row.id);
      created++;
      typeId = row.id;
    } else {
      log.warn("topic type unresolved — falling back to seeded type", {
        label,
        proposed: typeof t.type === "string" ? t.type : "",
        slug,
        created,
      });
      typeId = FALLBACK_TYPE_ID;
    }

    const cappedLabel = label.split(/\s+/).slice(0, MAX_LABEL_WORDS).join(" ");
    const messageIds = Array.isArray(t.messageIds)
      ? t.messageIds.filter((id): id is string => typeof id === "string" && opts.realMessageIds.has(id))
      : [];
    out.push({ label: cappedLabel, typeId, messageIds });
  }
  return out;
}

export interface DetectDeps {
  resolveTarget: (conversationId: string) => Promise<ContextsTarget>;
  runCompletion: (req: ContextsCompletionRequest) => Promise<string>;
  getMessages: (conversationId: string) => Promise<DetectMessage[]>;
  listContextTypes: () => Promise<ContextTypeRow[]>;
  getExistingTopics: (conversationId: string) => Promise<Array<{ label: string }>>;
  ensureContextType: (t: { id: string; label: string; description: string }) => Promise<{ id: string }>;
  replaceTopics: (conversationId: string, topics: TopicInput[]) => Promise<ConversationTopic[]>;
  upsertTopicState: (conversationId: string, input: TopicStateInput) => Promise<ConversationTopicState>;
}

const DEFAULT_DETECT_DEPS: DetectDeps = {
  resolveTarget: (conversationId) => resolveContextsTarget(conversationId),
  runCompletion: (req) => runContextsCompletion(req),
  getMessages: realGetMessages,
  listContextTypes: realListContextTypes,
  getExistingTopics: realGetTopics,
  ensureContextType: realEnsureContextType,
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
    schema: buildDetectSchema(),
    schemaName: "topic_detection",
    temperature: 0.2,
    maxTokens: 1_500,
    conversationId,
  });

  const validated = await validateTopics(parseDetectResponse(rawText), {
    existingTypeIds: typeIds,
    realMessageIds: new Set(messages.map((m) => m.id)),
    ensureContextType: deps.ensureContextType,
  });

  const topics = await deps.replaceTopics(conversationId, validated);
  const state = await deps.upsertTopicState(conversationId, {
    lastMessageId,
    messageCount: messages.length,
    model,
  });

  return { topics, analyzedAt: state.analyzedAt.toISOString(), model };
}
