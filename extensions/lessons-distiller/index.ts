#!/usr/bin/env bun
// lessons-distiller — bundled extension implementation (Phase 53 Stage 1).
//
// Mirrors the legacy `src/runtime/lessons/distiller.ts` outcome model
// (`DistillationOutcome`, the 7 variants the parity test asserts on)
// but performs every privileged op via the SDK capability surfaces:
//
//   - message slice    →  ctx.invoke("runtime.conversations.getMessages")
//   - trigger gate     →  ctx.invoke("runtime.lessons.triggerGate")
//   - settings (event) →  ctx.invoke("runtime.settings.getMine")
//   - LLM call         →  ctx.llm.complete  (host-brokered; token never crosses)
//   - lesson write     →  ctx.lessons.write (slug-collision soft)
//
// The trigger gate, dedup, and settings reads stay host-side because
// they need privileged data the extension can't see (tool-call
// histories, user-scoped settings columns) — the invoke handlers are
// the smallest possible wrappers around the existing host helpers.
//
// Settings flow: tool dispatch carries resolved settings on
// `invocationMetadata.settings` (host clamps against the manifest schema
// at wire time; SDK's `getSetting(ctx, key)` reads them with no extra
// round-trip). The `run:complete` event handler has no per-call ctx, so
// it falls back to `runtime.settings.getMine` to fetch the current
// effective values for the calling extension.
//
// Module-level seams (`runtimeApi`, `_setRuntimeApiForTests`) let unit
// tests swap in a fake without going through the JSON-RPC pipe — same
// pattern scratchpad uses for `store`. Production code path is
// unchanged.

import {
  createToolDispatcher,
  getChannel,
  getSetting,
  Lessons,
  Llm,
  registerEventHandler,
  toolError,
  toolResult,
  invoke,
  type ToolHandler,
  type ToolHandlerContext,
} from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";

// `invoke` is currently consumed only by the prod-mode `runtimeApi`
// fallback wiring; reference it once via `void` so the linter doesn't
// flag the import when test-only seams are active.
void invoke;

// ── System prompt ──────────────────────────────────────────────────
//
// Copied VERBATIM from src/runtime/lessons/distiller.ts:118-145. The
// parity test asserts both code paths produce the same lesson body for
// the same fixture conversation; any wording drift here would break
// that assertion. Stage 2 deletes the legacy export, but until then
// keep the strings identical.
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

// ── Outcome shape ───────────────────────────────────────────────────
//
// Mirrors `DistillationOutcome` in src/runtime/lessons/distiller.ts.
// All 7 variants must be reachable from this code so the parity test
// can compare both pipelines outcome-for-outcome.
export interface DistilledLessonRecord {
  id: string;
  slug: string;
  title: string;
  body: string;
  frontmatter?: Record<string, unknown> | null;
  visibility: string;
}

export type DistillationOutcome =
  | { kind: "success"; lesson: DistilledLessonRecord }
  | { kind: "decline"; reason: "slug_collision"; existingSlug: string }
  | { kind: "decline"; reason: "trigger_gate_blocked" }
  | { kind: "decline"; reason: "empty_conversation" }
  | { kind: "decline"; reason: "llm_empty" }
  | { kind: "decline"; reason: "llm_malformed"; detail: string }
  | { kind: "error"; reason: "db_error"; detail: string }
  | { kind: "error"; reason: "llm_error"; detail: string }
  | { kind: "error"; reason: "internal"; detail: string };

interface DistilledLesson {
  slug: string;
  title: string;
  body: string;
  frontmatter?: Record<string, unknown> | null;
}

// ── Provider/model defaults ─────────────────────────────────────────
//
// Independent map (NOT a re-export of the legacy DISTILLATION_MODELS so
// the deletion in Stage 2 doesn't ripple here). v1 values match the
// legacy exactly so the parity test's mocked LLM response is fed
// through the same provider key. Any setting override wins; falling
// back to "google" preserves the legacy auto-listener default.
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  google: "gemini-2.0-flash-lite",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20250514",
};

function resolveProviderModel(
  providerSetting: string | undefined,
  modelSetting: string | undefined,
): { provider: string; model: string } {
  const provider = (providerSetting && PROVIDER_DEFAULT_MODEL[providerSetting])
    ? providerSetting
    : "google";
  const model = (modelSetting && modelSetting.length > 0)
    ? modelSetting
    : (PROVIDER_DEFAULT_MODEL[provider] ?? "gemini-2.0-flash-lite");
  return { provider, model };
}

// ── Conversation message + settings shapes (RPC contract) ───────────
//
// `runtime.conversations.getMessages` is a new host-side invoke method
// added by the same commit as this extension. Returns the conversation
// row's messages in chronological order; the host applies its own auth
// rules (caller must be on a run associated with the conversation
// owner) before returning.
interface RuntimeMessage {
  id: string;
  role: string;
  content: string;
}

interface RuntimeTriggerGateResult {
  shouldDistill: boolean;
  reason?: string;
}

// ── Module-level SDK seam ───────────────────────────────────────────
//
// Tests swap these via `_setRuntimeApiForTests` to bypass the JSON-RPC
// pipe. Production wiring at the bottom of the file installs the real
// implementations.
export interface DistillerRuntimeApi {
  getMessages(conversationId: string): Promise<RuntimeMessage[]>;
  /** Same RPC as `getMessages`, but returns the envelope including the
   *  conversation's projectId. The two are split so the unit-test
   *  fakes can stub them independently. */
  getMessagesEnvelope(conversationId: string): Promise<{ messages: RuntimeMessage[]; projectId: string | null }>;
  triggerGate(conversationId: string): Promise<RuntimeTriggerGateResult>;
  llmComplete(opts: {
    provider: string;
    model: string;
    systemPrompt: string;
    messages: { role: "user"; content: string }[];
    maxTokens: number;
    temperature: number;
  }): Promise<{ content: string }>;
  lessonsWrite(input: {
    slug: string;
    title: string;
    body: string;
    frontmatter?: Record<string, unknown>;
    projectId: string;
    visibility: "user" | "project";
  }): Promise<{ lesson: DistilledLessonRecord | null; created: boolean }>;
  /** Effective settings for THIS extension on behalf of the acting user.
   *  Used by the `run:complete` event handler; tool-dispatch path uses
   *  `getSetting(ctx, …)` instead. */
  getMySettings(): Promise<Record<string, unknown>>;
}

const lessons = new Lessons();
const llm = new Llm();

let runtimeApi: DistillerRuntimeApi = {
  getMessages: async (conversationId: string) => {
    const result = await invoke<{ messages: RuntimeMessage[] }>(
      "runtime.conversations.getMessages",
      { conversationId },
    );
    return result.messages;
  },
  getMessagesEnvelope: async (conversationId: string) => {
    const result = await invoke<{ messages: RuntimeMessage[]; projectId?: string | null }>(
      "runtime.conversations.getMessages",
      { conversationId },
    );
    return { messages: result.messages, projectId: result.projectId ?? null };
  },
  triggerGate: async (conversationId: string) => {
    return invoke<RuntimeTriggerGateResult>(
      "runtime.lessons.triggerGate",
      { conversationId },
    );
  },
  llmComplete: async (opts) => {
    const result = await llm.complete({
      provider: opts.provider,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    });
    return { content: result.content };
  },
  lessonsWrite: async (input) => {
    const out = await lessons.write({
      slug: input.slug,
      title: input.title,
      body: input.body,
      visibility: input.visibility,
      ...(input.frontmatter ? { frontmatter: input.frontmatter } : {}),
      projectId: input.projectId,
    });
    return {
      lesson: out.lesson
        ? {
            id: out.lesson.id,
            slug: out.lesson.slug,
            title: out.lesson.title,
            body: out.lesson.body,
            visibility: out.lesson.visibility,
            frontmatter: out.lesson.frontmatter,
          }
        : null,
      created: out.created,
    };
  },
  getMySettings: async () => {
    return invoke<Record<string, unknown>>(
      "runtime.settings.getMine",
      {},
    );
  },
};

/** Test-only — replace the live runtime API with a fake. */
export function _setRuntimeApiForTests(fake: Partial<DistillerRuntimeApi>): void {
  runtimeApi = { ...runtimeApi, ...fake };
}

// Cache the original real API so tests can fully restore it.
const _realRuntimeApi: DistillerRuntimeApi = { ...runtimeApi };

/** Test-only — restore the real runtime API after a test. */
export function _resetRuntimeApiForTests(): void {
  runtimeApi = { ..._realRuntimeApi };
}

// ── Pure JSON parser (mirrors legacy lines 305-341) ─────────────────
function parseLessonJson(rawText: string): { ok: true; lesson: DistilledLesson } | { ok: false; outcome: DistillationOutcome } {
  let jsonText = rawText.trim();
  // Tolerate ```json … ``` fences from chatty models.
  const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonText = fenced[1]!.trim();

  if (!jsonText) {
    return { ok: false, outcome: { kind: "decline", reason: "llm_empty" } };
  }
  if (jsonText === "EMPTY" || jsonText === '"EMPTY"' || jsonText === "null") {
    return { ok: false, outcome: { kind: "decline", reason: "llm_empty" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, outcome: { kind: "decline", reason: "llm_malformed", detail: (err as Error).message } };
  }
  if (parsed === null || parsed === "EMPTY") {
    return { ok: false, outcome: { kind: "decline", reason: "llm_empty" } };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { ok: false, outcome: { kind: "decline", reason: "llm_empty" } };
    return { ok: false, outcome: { kind: "decline", reason: "llm_malformed", detail: "expected single object, got array" } };
  }
  if (typeof parsed !== "object") {
    return { ok: false, outcome: { kind: "decline", reason: "llm_malformed", detail: `expected object, got ${typeof parsed}` } };
  }
  const lesson = parsed as DistilledLesson;
  if (!lesson.slug || !lesson.title || !lesson.body) {
    return {
      ok: false,
      outcome: {
        kind: "decline",
        reason: "llm_malformed",
        detail: "missing required fields (slug, title, body)",
      },
    };
  }
  return { ok: true, lesson };
}

// ── Distillation pipeline ───────────────────────────────────────────
//
// One entry point shared by the `run:complete` listener and the
// `distill_now` tool — same shape as the legacy `runDistillation`.
export interface DistillOptions {
  conversationId: string;
  /** When true, the host-side trigger gate is bypassed (the user invoked
   *  `!EZ:distill` explicitly). When false, the gate must say yes before
   *  we pay the LLM call. */
  skipTriggerGate: boolean;
  /** Resolved settings for the calling user. Provided by the caller so
   *  the listener path (which has no ctx) and the tool-dispatch path
   *  (which has settings on ctx) can both feed the same shape. */
  settings: { provider?: string; model?: string };
  /** Project id for the conversation. Embedded in the host's
   *  `getMessages` response — passed through here so a separate RPC
   *  isn't needed. */
  projectId: string;
}

export async function distill(opts: DistillOptions): Promise<DistillationOutcome> {
  let messages: RuntimeMessage[];
  try {
    messages = await runtimeApi.getMessages(opts.conversationId);
  } catch (err) {
    return { kind: "error", reason: "internal", detail: (err as Error).message };
  }
  if (messages.length === 0) {
    return { kind: "decline", reason: "empty_conversation" };
  }

  if (!opts.skipTriggerGate) {
    let gate: RuntimeTriggerGateResult;
    try {
      gate = await runtimeApi.triggerGate(opts.conversationId);
    } catch (err) {
      return { kind: "error", reason: "internal", detail: (err as Error).message };
    }
    if (!gate.shouldDistill) {
      return { kind: "decline", reason: "trigger_gate_blocked" };
    }
  }

  // Take last 20 messages — same window as the legacy distiller.
  const recent = messages.slice(-20);
  const conversationText = recent
    .map((m) => `[${m.id}] ${m.role}: ${m.content}`)
    .join("\n\n");

  const { provider, model } = resolveProviderModel(opts.settings.provider, opts.settings.model);

  let llmText: string;
  try {
    const completion = await runtimeApi.llmComplete({
      provider,
      model,
      systemPrompt: DISTILLATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Distill at most one lesson from this conversation:\n\n${conversationText}`,
        },
      ],
      maxTokens: 1024,
      temperature: 0,
    });
    llmText = completion.content;
  } catch (err) {
    return { kind: "error", reason: "llm_error", detail: (err as Error).message };
  }

  const parsed = parseLessonJson(llmText);
  if (!parsed.ok) return parsed.outcome;

  // Persist via ctx.lessons.write — soft slug-collision returns
  // `created: false` with the existing row.
  let writeResult: Awaited<ReturnType<typeof runtimeApi.lessonsWrite>>;
  try {
    writeResult = await runtimeApi.lessonsWrite({
      slug: parsed.lesson.slug,
      title: parsed.lesson.title,
      body: parsed.lesson.body,
      ...(parsed.lesson.frontmatter ? { frontmatter: parsed.lesson.frontmatter as Record<string, unknown> } : {}),
      projectId: opts.projectId,
      visibility: "user",
    });
  } catch (err) {
    return { kind: "error", reason: "db_error", detail: (err as Error).message };
  }

  if (!writeResult.created) {
    return {
      kind: "decline",
      reason: "slug_collision",
      existingSlug: writeResult.lesson?.slug ?? parsed.lesson.slug,
    };
  }
  return { kind: "success", lesson: writeResult.lesson! };
}

// ── run:complete event handler ──────────────────────────────────────
//
// Mirrors the legacy `distillLesson(run, conversationId)` — only fires
// for successful chat runs, honors the `enabled` setting, applies the
// trigger gate. Errors are silenced (fire-and-forget contract).
//
// Note: Stage 1 keeps the legacy listener registered host-side via
// `web/src/lib/server/context.ts` — Stage 2 removes it. During Stage 1
// the bundled extension's handler is "ride-along" available; whether
// it actually fires depends on the conversation being wired into the
// extension (event delivery is gated on `conversation_extensions`).
// The auto-trigger UAT path (Phase 53.2) verifies the wiring; if it
// fails, that's a Stage 1 bug to fix before Stage 2 deletion — exactly
// the gate the two-stage merge is designed to protect.
export async function handleRunComplete(payload: { run?: unknown; conversationId?: string }): Promise<void> {
  const conversationId = payload?.conversationId;
  if (!conversationId) return;

  // Settings — `run:complete` has no ctx so we round-trip via invoke.
  let settings: Record<string, unknown>;
  try {
    settings = await runtimeApi.getMySettings();
  } catch {
    // If we can't read settings, default to enabled (matches legacy
    // distillLesson which treats missing setting as enabled).
    settings = {};
  }
  if (settings.enabled === false) return;

  // Status / agent gating — only successful chat runs distill.
  const run = payload?.run as { agentName?: string; status?: string } | undefined;
  if (run?.agentName !== "chat" || run?.status !== "success") return;

  // Resolve the project id via the same getMessages call (embedded in
  // the response — see host-side handler).
  let projectId: string;
  try {
    const messagesEnvelope = await runtimeApi.getMessagesEnvelope(conversationId);
    if (!messagesEnvelope.projectId) return;
    projectId = messagesEnvelope.projectId;
  } catch {
    return;
  }

  // Run distillation. Outcome is intentionally discarded — decline +
  // error stay silent for the listener contract; the host-side audit
  // row records what happened.
  await distill({
    conversationId,
    skipTriggerGate: false,
    settings: {
      provider: settings.provider as string | undefined,
      model: settings.model as string | undefined,
    },
    projectId,
  }).catch(() => undefined);
}

// ── Tool dispatcher (distill_now) ───────────────────────────────────
//
// Manual !EZ:distill path — bypasses the trigger gate (the user
// explicitly asked, the heuristics don't apply). Returns a structured
// `ToolCallResult` that the route forwarder maps to the existing
// `EzActionResult` chat-card shape.
const distillNow: ToolHandler = async (
  args: Record<string, unknown>,
  ctx?: ToolHandlerContext,
): Promise<ToolCallResult> => {
  const { conversationId } = args as { conversationId?: unknown };
  if (typeof conversationId !== "string" || !conversationId) {
    return toolError("distill_now requires a string 'conversationId'");
  }

  const enabled = getSetting<boolean>(ctx, "enabled");
  if (enabled === false) {
    return distillerToolResult({ kind: "decline", reason: "settings_disabled" } as DistillerCardOutcome);
  }

  // Project id resolution — same trick as the event path. The tool
  // dispatcher could pass settings through ctx (host already attaches
  // them under invocationMetadata.settings), but project id needs an
  // RPC because the SDK has no direct conversation-row read.
  let projectId: string | null = null;
  let messages: RuntimeMessage[];
  try {
    const envelope = await runtimeApi.getMessagesEnvelope(conversationId);
    messages = envelope.messages;
    projectId = envelope.projectId;
  } catch (err) {
    return distillerToolResult({ kind: "error", reason: "internal", detail: (err as Error).message });
  }
  if (!projectId) {
    return distillerToolResult({ kind: "error", reason: "internal", detail: "conversation has no projectId" });
  }
  if (messages.length === 0) {
    return distillerToolResult({ kind: "decline", reason: "empty_conversation" });
  }

  const provider = getSetting<string>(ctx, "provider");
  const model = getSetting<string>(ctx, "model");

  // We already fetched messages — feed them to a private path so we
  // don't double-RPC. The simplest way is to inline-call distill() but
  // skip getMessages. We'll reuse distill() by using a per-call
  // override.
  const outcome = await distillFromMessages({
    conversationId,
    skipTriggerGate: true,
    settings: { provider, model },
    projectId,
    messages,
  });
  return distillerToolResult(outcome);
};

// Internal variant of `distill` that takes the messages directly,
// avoiding a second `getMessages` RPC for the manual handler. Same
// outcome shape as `distill`.
async function distillFromMessages(opts: DistillOptions & { messages: RuntimeMessage[] }): Promise<DistillationOutcome> {
  if (opts.messages.length === 0) {
    return { kind: "decline", reason: "empty_conversation" };
  }
  // Manual handler always passes skipTriggerGate=true; preserve the
  // shape so a future caller could pass false.
  if (!opts.skipTriggerGate) {
    let gate: RuntimeTriggerGateResult;
    try {
      gate = await runtimeApi.triggerGate(opts.conversationId);
    } catch (err) {
      return { kind: "error", reason: "internal", detail: (err as Error).message };
    }
    if (!gate.shouldDistill) {
      return { kind: "decline", reason: "trigger_gate_blocked" };
    }
  }
  const recent = opts.messages.slice(-20);
  const conversationText = recent
    .map((m) => `[${m.id}] ${m.role}: ${m.content}`)
    .join("\n\n");
  const { provider, model } = resolveProviderModel(opts.settings.provider, opts.settings.model);

  let llmText: string;
  try {
    const completion = await runtimeApi.llmComplete({
      provider,
      model,
      systemPrompt: DISTILLATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Distill at most one lesson from this conversation:\n\n${conversationText}`,
        },
      ],
      maxTokens: 1024,
      temperature: 0,
    });
    llmText = completion.content;
  } catch (err) {
    return { kind: "error", reason: "llm_error", detail: (err as Error).message };
  }

  const parsed = parseLessonJson(llmText);
  if (!parsed.ok) return parsed.outcome;

  let writeResult: Awaited<ReturnType<typeof runtimeApi.lessonsWrite>>;
  try {
    writeResult = await runtimeApi.lessonsWrite({
      slug: parsed.lesson.slug,
      title: parsed.lesson.title,
      body: parsed.lesson.body,
      ...(parsed.lesson.frontmatter ? { frontmatter: parsed.lesson.frontmatter as Record<string, unknown> } : {}),
      projectId: opts.projectId,
      visibility: "user",
    });
  } catch (err) {
    return { kind: "error", reason: "db_error", detail: (err as Error).message };
  }

  if (!writeResult.created) {
    return {
      kind: "decline",
      reason: "slug_collision",
      existingSlug: writeResult.lesson?.slug ?? parsed.lesson.slug,
    };
  }
  return { kind: "success", lesson: writeResult.lesson! };
}

// ── Tool result shaping ─────────────────────────────────────────────
//
// The route forwarder at `/api/ez-actions/[name]` parses the tool's
// JSON-encoded `text` block back into the `EzActionResult` shape so the
// chat-card render path stays unchanged. We use a single JSON envelope
// (`__ezDistillerOutcome`) so the forwarder can identify our payload
// reliably without false positives from other tools that also return
// JSON.
type DistillerCardOutcome =
  | DistillationOutcome
  | { kind: "decline"; reason: "settings_disabled" };

export interface DistillerEnvelope {
  __ezDistillerOutcome: true;
  outcome: DistillerCardOutcome;
}

function distillerToolResult(outcome: DistillerCardOutcome): ToolCallResult {
  const envelope: DistillerEnvelope = {
    __ezDistillerOutcome: true,
    outcome,
  };
  // `success` and `decline` return a non-error result so the route
  // forwarder gets the JSON payload via `result.content[0].text` and
  // maps to the right card. `error` variants set `isError: true` so the
  // forwarder maps to an error card.
  const isError = outcome.kind === "error";
  if (isError) {
    return toolError(JSON.stringify(envelope));
  }
  return toolResult(JSON.stringify(envelope));
}

// ── Boot wiring ─────────────────────────────────────────────────────
//
// `if (import.meta.main)` keeps the dispatcher off when this file is
// imported by a unit test (which mounts its own channel). Production
// path is the default subprocess-spawn entrypoint.
export const tools: Record<string, ToolHandler> = {
  distill_now: distillNow,
};

if (import.meta.main) {
  registerEventHandler("run:complete", handleRunComplete);
  createToolDispatcher(tools);
  getChannel().start();
}
