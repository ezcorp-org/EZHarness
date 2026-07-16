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

/**
 * UI-only synthetic message roles — tool-card payloads + telemetry pills, NOT
 * human/assistant conversation. Mirrors the kinds
 * `src/runtime/stream-chat/load-history.ts` strips before building LLM context
 * (keep in sync). Their content (e.g. raw capability-event JSON) must never
 * leak into a detection/extraction transcript.
 */
const NON_CONVERSATIONAL_ROLES = new Set<string>([
  "ez-action-result",
  "capability-event",
  "preprocess-result",
]);

/**
 * True when a message is real conversational content — not a UI-only synthetic
 * row and not empty/whitespace. The shared filter for BOTH the detection and
 * extraction transcripts (a topic can only be about something a human or the
 * assistant actually said).
 */
export function isConversationalMessage(m: { role: string; content: string }): boolean {
  if (NON_CONVERSATIONAL_ROLES.has(m.role)) return false;
  return m.content.trim().length > 0;
}

interface DetectMessage {
  id: string;
  role: string;
  content: string;
}

/**
 * Build the detection transcript: each message tagged with a 1-based ORDINAL
 * `[mN]` (in the given, already-conversational order) + its role,
 * per-message-truncated, joined oldest→newest. Ordinals — not 36-char UUIDs —
 * are what the model cites for anchors: trivial for a small model to copy and
 * grammar-friendly. Returns `ordinalToId` so the caller maps the model's
 * numbers back to real message ids. When the total exceeds the cap, whole
 * messages are dropped from the OLDEST end (their original ordinals stay on the
 * kept suffix) and `truncated` is set.
 */
export function buildDetectTranscript(
  messages: DetectMessage[],
): { transcript: string; truncated: boolean; ordinalToId: Map<number, string> } {
  const ordinalToId = new Map<number, string>();
  const lines = messages.map((m, i) => {
    const ordinal = i + 1;
    ordinalToId.set(ordinal, m.id);
    const body = m.content.length > MAX_PER_MESSAGE_CHARS
      ? `${m.content.slice(0, MAX_PER_MESSAGE_CHARS)}…`
      : m.content;
    return `[m${ordinal}] ${m.role}: ${body}`;
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
  return { transcript, truncated, ordinalToId };
}

/**
 * JSON schema for detection output. `type` is an OPEN plain string (not a
 * closed enum) so the model can propose new type ids; the grammar still
 * guarantees a valid JSON shape, and the anti-sprawl discipline (prefer
 * existing ids, cap new types) lives in the prompt + server validation.
 * `typeDescription` is optional — the model fills it only for a NEW type.
 * `anchors` are the 1-based `[mN]` message NUMBERS (integers) — small models
 * copy a number reliably where they cannot copy a 36-char UUID; the server
 * maps them back to real ids.
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
            anchors: { type: "array", items: { type: "integer", minimum: 1 } },
          },
          required: ["label", "type", "anchors"],
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
    "Only report topics with SUBSTANTIVE discussion — a real exchange, decision, or work",
    "happening in the conversation. Do NOT invent a topic for something merely mentioned in",
    "passing, listed, or speculative. Fewer, well-evidenced topics beat many thin ones.",
    "",
    "Each label must be a short DESCRIPTIVE phrase naming the SPECIFIC subject (e.g. 'stale",
    "watermark refresh bug', 'contexts model picker swap') — NEVER a generic category word",
    "and NEVER the type name itself.",
    "",
    "Each topic has a `type`. These types already exist (id — description):",
    typeLines,
    "",
    "Use an existing type id when one genuinely fits. When the conversation's subject is",
    "better described by a type not in the list, CREATE a new one — that is expected and",
    "useful, not a failure. Never create a near-duplicate (plural/spelling/synonym) of an",
    "existing type. A new type id is short kebab-case, singular, and generic enough to reuse",
    "(e.g. 'design-review', 'incident'); give each new type a one-line `typeDescription`.",
    "",
    "For each topic, cite the message numbers (the [mN] tags) where it is",
    "substantively discussed — as integers in `anchors` (e.g. [3, 4]).",
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
    '{"topics": [{"label": string, "type": string, "typeDescription"?: string, "anchors": number[]}]}',
    `— no markdown, no prose around it. Keep labels under ${MAX_LABEL_WORDS} words. /no_think`,
  );
  return parts.join("\n");
}

export interface RawTopic {
  label: unknown;
  type: unknown;
  /** Only present when the model proposes a NEW type. */
  typeDescription?: unknown;
  /** 1-based `[mN]` ordinals (integers) the model cited. */
  anchors: unknown;
}

/**
 * Map a raw `anchors` array (1-based `[mN]` ordinals the model emitted) to real
 * message ids via the transcript's `ordinalToId`. Non-integers and out-of-range
 * ordinals are dropped; duplicate ids are collapsed. Order follows the model's
 * citation order.
 */
export function resolveAnchors(anchors: unknown, ordinalToId: Map<number, string>): string[] {
  if (!Array.isArray(anchors)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    if (typeof a !== "number" || !Number.isInteger(a)) continue;
    const id = ordinalToId.get(a);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
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
  /** Live types (id + label) for reuse matching + the label==type evidence
   *  check. The id list grows as new types are created this pass. */
  existingTypes: Array<{ id: string; label: string }>;
  /** 1-based `[mN]` ordinal → real message id, from buildDetectTranscript. */
  ordinalToId: Map<number, string>;
  ensureContextType: (t: {
    id: string;
    label: string;
    description: string;
  }) => Promise<{ id: string }>;
}

/**
 * Validate + resolve raw topics. Label + type discipline first (these always
 * apply): drop empty-label entries; resolve the OPEN-taxonomy `type` (existing
 * id by exact/variant match is reused; an otherwise-new slug is created via
 * `ensureContextType`, source='auto', capped at MAX_NEW_TYPES_PER_PASS per
 * pass; beyond the cap or for an empty slug → seeded FALLBACK_TYPE_ID + warn);
 * drop entries whose label is just the type name (id or label,
 * case/hyphen-insensitive); word-cap labels; cap the count at MAX_TOPICS. Types
 * are ensured HERE, before the caller's `replaceTopics`, so the FK resolves.
 *
 * Then the EVIDENCE FLOOR with a wholesale-failure fallback: `anchors` are
 * `[mN]` ordinals mapped to real ids. If ANY surviving topic has real anchors,
 * the zero-anchor ones are dropped (a topic with no evidence). But if EVERY
 * surviving topic has zero anchors — the citation mechanics failed wholesale
 * (a small model that couldn't emit the numbers) — the topics are KEPT with
 * empty ids + a single warn, so the feature never returns empty over a
 * mechanical miss. Anchor-less pills don't attach, but the popover lists them
 * and extraction (which feeds the full transcript) still works.
 */
export async function validateTopics(
  raw: RawTopic[],
  opts: ValidateTopicsOpts,
): Promise<TopicInput[]> {
  // Phase 1 — label + type validation. Anchors are resolved but NOT yet used
  // to drop, so the wholesale-failure fallback below can see the full set.
  const candidates: TopicInput[] = [];
  const known = opts.existingTypes.map((t) => t.id);
  const labelById = new Map(opts.existingTypes.map((t) => [t.id, t.label]));
  let created = 0;
  for (const t of raw) {
    if (candidates.length >= MAX_TOPICS) break;
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
      labelById.set(row.id, typeLabel);
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

    // A label that's just the type name (id or its label) carries no info.
    const labelSlug = normalizeTypeSlug(label);
    const typeLabelSlug = normalizeTypeSlug(labelById.get(typeId) ?? "");
    if (labelSlug && (labelSlug === typeId || labelSlug === typeLabelSlug)) {
      log.warn("dropping topic whose label is just the type name", { label, typeId });
      continue;
    }

    const cappedLabel = label.split(/\s+/).slice(0, MAX_LABEL_WORDS).join(" ");
    const messageIds = resolveAnchors(t.anchors, opts.ordinalToId);
    candidates.push({ label: cappedLabel, typeId, messageIds });
  }

  // Phase 2 — evidence floor with wholesale-failure fallback.
  const withAnchors = candidates.filter((c) => c.messageIds.length > 0);
  if (withAnchors.length > 0) {
    for (const c of candidates) {
      if (c.messageIds.length === 0) {
        log.warn("dropping topic with no real anchor messages", { label: c.label });
      }
    }
    return withAnchors;
  }
  if (candidates.length > 0) {
    log.warn("anchor citation failed wholesale — keeping topics without anchors", {
      count: candidates.length,
    });
    return candidates;
  }
  return [];
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
  // Watermark tracks the RAW newest message + count (matches getMessageWatermark
  // in the GET route, so staleness stays consistent). The transcript + anchor
  // validation use only CONVERSATIONAL rows (UI-only telemetry / tool cards +
  // empty turns are stripped — see isConversationalMessage).
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  const conversational = messages.filter(isConversationalMessage);

  if (conversational.length === 0) {
    const cleared = await deps.replaceTopics(conversationId, []);
    const state = await deps.upsertTopicState(conversationId, {
      lastMessageId,
      messageCount: messages.length,
      model,
    });
    return { topics: cleared, analyzedAt: state.analyzedAt.toISOString(), model };
  }

  const [types, existing] = await Promise.all([
    deps.listContextTypes(),
    deps.getExistingTopics(conversationId),
  ]);

  const { transcript, ordinalToId } = buildDetectTranscript(conversational);
  const systemPrompt = buildDetectSystemPrompt(types, existing.map((e) => e.label));

  const rawText = await deps.runCompletion({
    target,
    systemPrompt,
    userPrompt: transcript,
    schema: buildDetectSchema(),
    schemaName: "topic_detection",
    temperature: 0.2,
    maxTokens: 4_000,
    conversationId,
  });

  const validated = await validateTopics(parseDetectResponse(rawText), {
    existingTypes: types,
    ordinalToId,
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
