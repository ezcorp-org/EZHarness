/**
 * Lessons distiller — runtime-internal LLM call that listens for
 * `run:complete` events, decides whether the conversation slice is
 * worth distilling (via pure heuristics in `triggers.ts`), asks a
 * cheap-tier LLM to extract a single lesson, and persists it via the
 * Phase 1 query layer.
 *
 * Architecturally a near-clone of `src/memory/extraction.ts` — same
 * listener shape, same per-provider cheap-model selector, same
 * per-project mutex, same fire-and-forget error semantics. Read that
 * file alongside this one; the deltas are documented inline.
 *
 * Major deviations from the memory-extraction template:
 *
 *   - Output schema is a SINGLE JSON envelope (`{slug,title,body,
 *     frontmatter}`) rather than an array. Lessons are coarser-grained
 *     than memories — at most one lesson per run is the realistic
 *     ceiling.
 *
 *   - The LLM may return `null` or the literal string `"EMPTY"` to say
 *     "nothing worth capturing." Both cases are silent no-ops, NEVER
 *     warnings — the model declining to fabricate is the desired path.
 *
 *   - Slug uniqueness collisions (partial unique index in the
 *     migration) downgrade to a debug log. v1 does not retry with a
 *     suffix — the existing row is the authoritative one. Other DB
 *     errors still surface.
 *
 *   - Visibility defaults to `'user'` (per-user blast radius). The
 *     promotion ladder (user → project → global) is human-clicked in
 *     v1.5+, never automatic.
 *
 *   - `ownerId` is sourced from the conversation row (NOT the
 *     `AgentRun`, which has no user attribution). If the conversation
 *     has no `userId` (e.g. system-initiated runs), distillation is
 *     skipped — there is no user to attribute the lesson to.
 *
 *   - `projectId` precedence: prefer `run.projectId`, fall back to the
 *     conversation row's `projectId`. The conversation always carries
 *     one (NOT NULL in schema); the run's may be undefined for some
 *     legacy code paths.
 */

import type { AgentRun, AgentEvents } from "../../types";
import type { EventBus } from "../events";
import type { NewLesson } from "../../db/schema";
import { createLesson } from "../../db/queries/lessons";
import { getSetting } from "../../db/queries/settings";
import { getMessages, getConversation } from "../../db/queries/conversations";
import { listToolCallsByConversation } from "../../db/queries/tool-calls";
import {
  shouldDistill,
  detectUserCorrection,
  detectErrorRecovery,
  detectExplicitTag,
} from "./triggers";
import { logger } from "../../logger";

const log = logger.child("lessons-distiller");

// ── Per-project mutex ──────────────────────────────────────────────
//
// Serializes distillation within a project so two simultaneous
// `run:complete` events can't race past the slug-uniqueness check
// (the `createLesson` insert is not atomic with any prior read; the
// lock prevents the partial-unique-index from being the only line of
// defense). Mirrors `extractionLocks` / `withExtractionLock` in
// src/memory/extraction.ts:14–29 verbatim.
const distillationLocks = new Map<string, Promise<void>>();
async function withDistillationLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = distillationLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  distillationLocks.set(projectId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (distillationLocks.get(projectId) === next) distillationLocks.delete(projectId);
  }
}

// ── Cheap-tier model selector ──────────────────────────────────────
//
// Independent map (NOT a re-export of EXTRACTION_MODELS) so the two
// pipelines can be tuned separately when one of them outgrows haiku/
// flash-lite. v1 uses identical values to memory extraction.
export const DISTILLATION_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20250514",
  openai: "gpt-4o-mini",
  google: "gemini-2.0-flash-lite",
};

export function getDistillationModel(
  activeProvider: string,
): { provider: string; model: string } {
  const model = DISTILLATION_MODELS[activeProvider];
  if (model) return { provider: activeProvider, model };
  return { provider: "google", model: "gemini-2.0-flash-lite" };
}

// ── System prompt ──────────────────────────────────────────────────
//
// Emits a JSON envelope rather than markdown frontmatter. The plan
// (section 5.2) describes a YAML-frontmatter schema; we override that
// here because mirroring extraction.ts's JSON shape is simpler than
// adding a YAML parser to the runtime, and the persisted column is
// JSONB anyway.
//
// The model is explicitly told it MAY return `null` (or the literal
// string `"EMPTY"`) when nothing qualifies. False negatives (no lesson
// when one exists) are far cheaper than false positives (a low-quality
// lesson that pollutes the user's library forever).
export const DISTILLATION_SYSTEM_PROMPT = `You are a lessons-keeper. Read the recent conversation between a user and an AI assistant and decide whether it contains exactly ONE generally-applicable lesson worth surfacing in future, similar conversations.

A lesson is a small, self-contained Markdown note that captures:
- A non-obvious gotcha the assistant ran into and recovered from
- A user preference, project convention, or correction the assistant should remember
- A reusable pattern the assistant figured out the hard way

DO NOT extract:
- Transient state (current task progress, file the user was just looking at)
- Trivia the model already knows from its training
- Restatements of the user's most recent question

If nothing qualifies, return the literal string "EMPTY". Do NOT fabricate.

Otherwise, respond with a single JSON object matching this schema (no commentary, no code fences):

{
  "slug": "kebab-case-id-3-to-6-words",
  "title": "Short imperative title (≤80 chars)",
  "body": "Markdown body, ≤300 words, focused on the actionable insight",
  "frontmatter": {
    "trigger": ["short phrase describing when this lesson applies"],
    "applies_to": ["lang:ts", "tool:bun", "domain:auth"],
    "confidence": "high"
  }
}

The "frontmatter.confidence" field MUST be one of "high", "medium", "low".`;

// ── Output shape ──────────────────────────────────────────────────
interface DistilledLesson {
  slug: string;
  title: string;
  body: string;
  frontmatter?: Record<string, unknown> | null;
}

// ── Pipeline entry point ──────────────────────────────────────────
//
// Same signature shape as `extractMemories(run, conversationId)`.
// Returns void; errors are logged + swallowed so the listener's
// fire-and-forget contract holds.
export async function distillLesson(
  run: AgentRun,
  conversationId: string,
): Promise<void> {
  // ── Settings toggle ─────────────────────────────────────────────
  // Mirrors extraction.ts:77 — treat missing setting as enabled.
  const enabled = await getSetting("global:lessonDistillerEnabled");
  if (enabled === false) return;

  // ── Status / agent gating ──────────────────────────────────────
  // Same shape as extraction.ts:81 — only successful chat runs.
  if (run.agentName !== "chat" || run.status !== "success") return;

  // ── Conversation fetch ──────────────────────────────────────────
  // We need both messages (LLM input) and the conversation row (to
  // resolve ownerId, since AgentRun has no user attribution).
  const conversation = await getConversation(conversationId);
  if (!conversation) return;
  const ownerId = conversation.userId;
  if (!ownerId) {
    // System-initiated runs (no user). Nothing to attribute the
    // lesson to — silent no-op.
    return;
  }
  const projectId = run.projectId ?? conversation.projectId;
  if (!projectId) return;

  const allMessages = await getMessages(conversationId);
  if (allMessages.length === 0) return;

  // Take last ~20 messages (10 pairs) for context — same window as
  // extraction.ts:88 to keep token cost predictable.
  const recentMessages = allMessages.slice(-20);
  const conversationText = recentMessages
    .map((m) => `[${m.id}] ${m.role}: ${m.content}`)
    .join("\n\n");

  // Stable hash of the exact slice we feed the LLM. Stored in
  // `lessons.source_sha256` so debugging can answer "what input
  // produced this lesson?" without re-reading the messages table.
  const sourceSha256 = sha256Hex(conversationText);

  // ── Trigger gate (Hermes "trigger discipline") ─────────────────
  //
  // Pure-heuristic OR-of-flags from `runtime/lessons/triggers.ts`:
  // we only pay the LLM call when at least one signal fires
  // (≥5 tool calls, error→ok recovery, user-correction tokens,
  // explicit `[lesson]` tag). Sources:
  //   - tool-call signals come from `tool_calls` (single SELECT
  //     of just the `success` column, ordered by created_at —
  //     order matters for the recovery detector)
  //   - text signals reuse the `recentMessages` slice already in
  //     memory (no re-load)
  //
  // If the tool-calls query throws, we DO NOT swallow it: the
  // listener's `.catch` already logs, and a hard DB failure here
  // is a real signal that something is wrong with the runtime.
  const userMessageTexts = recentMessages
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  const toolCallRows = await listToolCallsByConversation(conversationId);
  const triggerInput = {
    toolCallCount: toolCallRows.length,
    errorRecoveryObserved: detectErrorRecovery(
      toolCallRows.map((r) => ({ status: r.success ? "ok" : "error" })),
    ),
    userCorrectionObserved: detectUserCorrection(userMessageTexts),
    explicitlyTagged: detectExplicitTag(userMessageTexts),
  };
  if (!shouldDistill(triggerInput)) return;

  // ── Provider / model resolution ────────────────────────────────
  // Mirrors extraction.ts:94–108.
  const provider = run.provider ?? "google";
  const { provider: distProvider, model } = getDistillationModel(provider);

  const { complete } = await import("@mariozechner/pi-ai");
  const { resolveModel } = await import("../../providers/router");
  const { getCredential } = await import("../../providers/credentials");

  const resolved = await resolveModel(distProvider, model);
  const cred = await getCredential(resolved.provider);

  const result = await complete(
    resolved.piModel,
    {
      systemPrompt: DISTILLATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Distill at most one lesson from this conversation:\n\n${conversationText}`,
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: cred.token, maxTokens: 1024, temperature: 0 },
  );

  // ── Parse JSON envelope ────────────────────────────────────────
  let lesson: DistilledLesson | null;
  try {
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    let jsonText = text.trim();
    const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) jsonText = fenced[1]!.trim();

    if (!jsonText) {
      // Empty response — silent no-op (model declined).
      return;
    }
    if (jsonText === "EMPTY" || jsonText === '"EMPTY"' || jsonText === "null") {
      // Model explicitly declined — silent no-op.
      return;
    }
    // Tolerate `[]` / `{}` as additional "nothing here" signals,
    // mirroring extraction.ts's defensiveness.
    const parsed = JSON.parse(jsonText);
    if (parsed === null || parsed === "EMPTY") return;
    if (Array.isArray(parsed)) {
      // Empty array, or first element if non-empty — but the
      // schema is single-object; an array means the model misread
      // the prompt, so treat empty as no-op and any other array
      // shape as malformed.
      if (parsed.length === 0) return;
      log.warn("Distiller: LLM returned an array; expected single object");
      return;
    }
    if (typeof parsed !== "object") {
      log.warn("Distiller: LLM response was not a JSON object", { got: typeof parsed });
      return;
    }
    lesson = parsed as DistilledLesson;
  } catch (err) {
    log.warn("Distiller: failed to parse JSON response", { error: (err as Error).message });
    return;
  }

  if (!lesson?.slug || !lesson.title || !lesson.body) {
    log.warn("Distiller: LLM response missing required fields", {
      hasSlug: !!lesson?.slug,
      hasTitle: !!lesson?.title,
      hasBody: !!lesson?.body,
    });
    return;
  }

  // ── Persist (serialized per project) ───────────────────────────
  await withDistillationLock(projectId, async () => {
    const row: NewLesson = {
      projectId,
      ownerId,
      visibility: "user", // promotion ladder is v1.5+
      slug: lesson!.slug,
      title: lesson!.title,
      body: lesson!.body,
      frontmatter: lesson!.frontmatter ?? null,
      source: "distiller",
      sourceSha256,
    };
    try {
      await createLesson(row);
    } catch (err) {
      // Slug collision against the partial unique index — soft skip.
      // The migration declares two such indexes:
      //   idx_lessons_user_slug_unique(project_id, owner_id, slug)
      //   idx_lessons_shared_slug_unique(project_id, slug) WHERE …
      // PGlite + node-postgres surface PG SQLSTATE 23505 as `err.code`
      // on the underlying PG error. Drizzle wraps it in a
      // DrizzleQueryError where the PG error sits on `.cause`, so we
      // walk the cause chain rather than only inspecting the outer
      // throw. The message-text fallback catches future driver
      // changes that drop the structured `.code`.
      if (isUniqueViolationError(err)) {
        log.debug("Distiller: slug collision, skipping insert", {
          slug: lesson!.slug,
          projectId,
          ownerId,
        });
        return;
      }
      // Anything else is a real DB error — let it propagate so the
      // listener's catch logs it with the surrounding context.
      throw err;
    }
  });
}

// ── PG unique-violation detection ─────────────────────────────────
//
// Drizzle wraps the driver-level error in a DrizzleQueryError whose
// `.cause` is the actual PG error carrying SQLSTATE `23505`. We walk
// the cause chain (defensive: 5 hops max, in case some intermediate
// wrapper appears) checking both `.code` and the message text. The
// message-text fallback handles drivers that drop the structured code
// (older PGlite revisions did this for a while).
function isUniqueViolationError(err: unknown): boolean {
  let current: unknown = err;
  for (let hops = 0; hops < 5 && current !== undefined && current !== null; hops += 1) {
    const code = (current as { code?: string }).code;
    if (code === "23505") return true;
    const message = (current as { message?: string }).message;
    if (typeof message === "string" && /duplicate key|unique constraint/i.test(message)) {
      return true;
    }
    const next = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  return false;
}

// ── SHA-256 helper ─────────────────────────────────────────────────
//
// Bun's `CryptoHasher` is the native fast path on the Bun runtime
// (the project's default). Falls back to Node's `crypto.createHash`
// when running under Node (e.g. some CI / Vitest paths).
function sha256Hex(input: string): string {
  const BunGlobal = (globalThis as unknown as {
    Bun?: { CryptoHasher: new (algo: string) => { update(s: string): void; digest(enc: string): string } };
  }).Bun;
  if (BunGlobal?.CryptoHasher) {
    const h = new BunGlobal.CryptoHasher("sha256");
    h.update(input);
    return h.digest("hex");
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

// ── Event Listener Registration ────────────────────────────────────
//
// Mirrors `registerExtractionListener` (extraction.ts:194–205) verbatim.
// Fire-and-forget: errors in `distillLesson` are caught and logged so
// they never propagate up to the EventBus emit loop.
export function registerLessonDistillerListener(
  bus: EventBus<AgentEvents>,
): () => void {
  return bus.on(
    "run:complete",
    (data: { run: AgentRun; conversationId?: string }) => {
      const { run, conversationId } = data;
      if (!conversationId) return;
      distillLesson(run, conversationId).catch((err) =>
        log.error("Lesson distillation failed", { error: String(err) }),
      );
    },
  );
}
