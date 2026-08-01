#!/usr/bin/env bun
// lessons-distiller — bundled extension. Captures at most ONE durable
// lesson per completed chat run (auto, via a `run:complete` loop) and on
// demand via the `!EZ:distill` action (the `distill_now` tool).
//
// Every privileged op goes through an SDK capability surface:
//
//   - messages + projectId →  ctx.invoke("runtime.conversations.getMessages")
//   - trigger gate         →  ctx.invoke("runtime.lessons.triggerGate")
//   - LLM call             →  ctx.llm.complete  (host-brokered; token never crosses)
//   - lesson write         →  ctx.lessons.write (slug-collision soft)
//
// The trigger gate and the message read stay host-side because they need
// privileged data the extension can't see (tool-call histories, message
// rows) — the invoke handlers are the smallest possible wrappers around
// the existing host helpers.
//
// Cost shape (binding): the auto path reads the conversation EXACTLY
// ONCE and consults the trigger gate BEFORE the LLM call, so a
// gate-rejected fire — the common case — costs one message read and zero
// tokens. `distill` is the single pipeline; `distillRunComplete` and
// `distillNow` are thin callers that differ only in where the messages
// and the settings come from.
//
// Settings flow: tool dispatch carries resolved settings on
// `invocationMetadata.settings` (host clamps against the manifest schema
// at wire time; SDK's `getSetting(ctx, key)` reads them with no extra
// round-trip). The `run:complete` loop act has no per-call ctx, so the
// loop primitive resolves them via `runtime.settings.getMine` and hands
// them to `distillRunComplete`.
//
// Module-level seams (`runtimeApi`, `_setRuntimeApiForTests`) let unit
// tests swap in a fake without going through the JSON-RPC pipe — same
// pattern scratchpad uses for `store`. Production code path is
// unchanged.

import {
  createToolDispatcher,
  defineLoop,
  formatMessages,
  getChannel,
  getLoopTools,
  getSetting,
  JsonRpcError,
  Lessons,
  Llm,
  LlmCredentialError,
  LlmProviderError,
  resolveProviderModel,
  toolError,
  toolResult,
  invoke,
  type ToolHandler,
  type ToolHandlerContext,
} from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";

// ── System prompt ──────────────────────────────────────────────────
//
// This file is the ONLY definition of the distillation prompt — editing
// the wording changes every lesson this extension ever captures, so
// treat a change here as a behaviour change, not a copy tweak.
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
// One `success`, five `decline` reasons, three `error` reasons. Every
// variant is reachable from the single `distill` pipeline; callers
// (the loop act, the tool envelope) switch on `kind`/`reason`.
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
  | {
      kind: "error";
      reason: "llm_error";
      detail: string;
      /**
       * Soft classification of the LLM failure so callers can degrade
       * fail-soft. `"unavailable"` marks a provider/credential-class
       * failure (no credential, provider not granted) — the distiller's
       * model isn't usable on this instance, so the `run:complete`
       * listener warns ONCE (not error-spam) and skips cleanly rather
       * than re-failing the same credential-less call on every run.
       * `"transient"` is everything else (upstream 5xx, timeout) — worth
       * a retry next run, not worth a startup warning.
       */
      cause: "unavailable" | "transient";
    }
  | { kind: "error"; reason: "internal"; detail: string };

interface DistilledLesson {
  slug: string;
  title: string;
  body: string;
  frontmatter?: Record<string, unknown> | null;
}

// ── Provider/model defaults ─────────────────────────────────────────
//
// The provider→default-model map + resolution logic live in the SDK
// (`resolveProviderModel`, imported above) — the Loop primitive owns the
// single shared copy, so there is no per-extension duplicate. v1 values:
// google/gemini-2.0-flash-lite, openai/gpt-4o-mini,
// anthropic/claude-haiku-4-5, ollama/gemma4:e2b.

// ── RPC contract shapes ─────────────────────────────────────────────
interface RuntimeMessage {
  id: string;
  role: string;
  content: string;
}

/** `runtime.conversations.getMessages` response — the conversation's
 *  messages in chronological order plus the row's projectId. The host
 *  applies its own auth rules (the caller must be wired to the
 *  conversation) before returning. Both halves come back in ONE
 *  round-trip; never split this into two reads. */
interface RuntimeMessagesEnvelope {
  messages: RuntimeMessage[];
  projectId: string | null;
}

/** Params for `runtime.lessons.triggerGate`. `runId` / `runStartedAtMs`
 *  scope the host heuristics to the run that just finished — without
 *  them the gate scores the whole conversation and keeps re-firing on
 *  every later turn. These names are the host contract: do not rename. */
type RuntimeTriggerGateParams = {
  conversationId: string;
  runId?: string;
  runStartedAtMs?: number;
};

interface RuntimeTriggerGateResult {
  shouldDistill: boolean;
  reason?: string;
}

// ── Module-level SDK seam ───────────────────────────────────────────
//
// Tests swap these via `_setRuntimeApiForTests` to bypass the JSON-RPC
// pipe. Production wiring below installs the real implementations.
export interface DistillerRuntimeApi {
  getMessagesEnvelope(conversationId: string): Promise<RuntimeMessagesEnvelope>;
  triggerGate(params: RuntimeTriggerGateParams): Promise<RuntimeTriggerGateResult>;
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
}

const lessons = new Lessons();
const llm = new Llm();

let runtimeApi: DistillerRuntimeApi = {
  getMessagesEnvelope: async (conversationId: string) => {
    const result = await invoke<{ messages: RuntimeMessage[]; projectId?: string | null }>(
      "runtime.conversations.getMessages",
      { conversationId },
    );
    return { messages: result.messages, projectId: result.projectId ?? null };
  },
  triggerGate: async (params: RuntimeTriggerGateParams) => {
    return invoke<RuntimeTriggerGateResult>("runtime.lessons.triggerGate", params);
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

// ── LLM-failure classification ──────────────────────────────────────
//
// Provider/credential-class failures (`LlmCredentialError`,
// `LlmProviderError`) mean the distiller's configured model is not
// usable on THIS instance — e.g. the default `google` /
// `gemini-2.0-flash-lite` with no GOOGLE/GEMINI credential configured.
// These are a deployment-config condition, not a transient blip, so we
// degrade fail-soft: skip distillation and warn exactly once instead of
// re-failing (and re-spamming) the identical credential-less call on
// every `run:complete`. Everything else is treated as transient.
function classifyLlmError(err: unknown): "unavailable" | "transient" {
  if (err instanceof LlmCredentialError || err instanceof LlmProviderError) {
    return "unavailable";
  }
  return "transient";
}

function llmErrorOutcome(err: unknown): DistillationOutcome {
  return {
    kind: "error",
    reason: "llm_error",
    detail: (err as Error).message,
    cause: classifyLlmError(err),
  };
}

// ── Pure JSON parser ────────────────────────────────────────────────
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
// THE pipeline. Both entry points (`distillRunComplete` for the
// `run:complete` loop, `distillNow` for `!EZ:distill`) already hold the
// conversation envelope — they need `projectId` out of the same
// round-trip — so they hand the messages in rather than making this
// function re-read them.

/** Run scope forwarded to the host trigger gate so its heuristics score
 *  only the run that just finished. Sourced from the `run:complete`
 *  payload's `run.id` / `run.startedAt`. */
export interface DistillRunScope {
  runId?: string;
  runStartedAtMs?: number;
}

export interface DistillOptions {
  conversationId: string;
  /** The conversation, already fetched by the caller. The last 20
   *  messages become the LLM's window. */
  messages: RuntimeMessage[];
  /** When true, the host-side trigger gate is bypassed (the user invoked
   *  `!EZ:distill` explicitly). When false, the gate must say yes before
   *  we pay for the LLM call. */
  skipTriggerGate: boolean;
  /** Resolved settings for the calling user. Provided by the caller so
   *  the loop path (settings from the primitive) and the tool-dispatch
   *  path (settings on ctx) can both feed the same shape. */
  settings: { provider?: string; model?: string };
  /** Project id for the conversation — comes back on the `getMessages`
   *  envelope, so no separate RPC is needed. */
  projectId: string;
  /** Omitted on the manual path, which skips the gate entirely. */
  runScope?: DistillRunScope;
}

export async function distill(opts: DistillOptions): Promise<DistillationOutcome> {
  if (opts.messages.length === 0) {
    return { kind: "decline", reason: "empty_conversation" };
  }

  // Gate BEFORE anything billable: everything below this block costs
  // either LLM tokens or a lessons write.
  if (!opts.skipTriggerGate) {
    let gate: RuntimeTriggerGateResult;
    try {
      gate = await runtimeApi.triggerGate({
        conversationId: opts.conversationId,
        ...opts.runScope,
      });
    } catch (err) {
      return { kind: "error", reason: "internal", detail: (err as Error).message };
    }
    if (!gate.shouldDistill) {
      return { kind: "decline", reason: "trigger_gate_blocked" };
    }
  }

  // Last-20 window, formatted via the SDK's shared `formatMessages` (the
  // same `[id] role: content` join the Loop primitive's ctx.formatMessages
  // uses).
  const conversationText = formatMessages(opts.messages.slice(-20));

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
    return llmErrorOutcome(err);
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

// ── run:complete distillation core ──────────────────────────────────
//
// The auto-distill path, driven by the `defineLoop` act
// (`defineDistillLoop`), which passes `ctx.settings` (the
// primitive-owned settings resolution) in.
//
// Returns the produced `DistillationOutcome`, or `undefined` when a gate
// short-circuits before distillation.

/** The subset of `AgentRun` (src/types.ts) the `run:complete` payload
 *  carries that we act on. The dispatcher forwards `run:complete`
 *  unsanitised, so `id` / `startedAt` are present in production; they
 *  stay optional here because the payload crosses an untyped wire. */
interface RunCompletePayloadRun {
  id?: string;
  agentName?: string;
  status?: string;
  startedAt?: number;
}

/** Narrow the run record to the gate's scope params, omitting anything
 *  the payload didn't carry (an explicit `undefined` would just be
 *  dropped by JSON serialisation anyway). */
function runScopeFrom(run: RunCompletePayloadRun | undefined): DistillRunScope {
  return {
    ...(typeof run?.id === "string" ? { runId: run.id } : {}),
    ...(typeof run?.startedAt === "number" ? { runStartedAtMs: run.startedAt } : {}),
  };
}

export async function distillRunComplete(
  payload: { run?: unknown; conversationId?: string },
  settings: Record<string, unknown>,
): Promise<DistillationOutcome | undefined> {
  const conversationId = payload?.conversationId;
  if (!conversationId) return undefined;
  if (settings.enabled === false) return undefined;

  // Status / agent gating — only successful chat runs distill.
  const run = payload?.run as RunCompletePayloadRun | undefined;
  if (run?.agentName !== "chat" || run?.status !== "success") return undefined;

  // ONE conversation read: the envelope carries both the projectId and
  // the slice the LLM will see. -32604 ("not found"/"not wired") →
  // silent skip; anything else → log + skip (fire-and-forget; never
  // throw).
  let envelope: RuntimeMessagesEnvelope;
  try {
    envelope = await runtimeApi.getMessagesEnvelope(conversationId);
  } catch (err) {
    if (err instanceof JsonRpcError && err.code === -32604) {
      return undefined; // expected for deleted / unwired conversations
    }
    console.warn("[lessons-distiller] distillRunComplete: getMessagesEnvelope failed", {
      conversationId,
      code: err instanceof JsonRpcError ? err.code : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  if (!envelope.projectId) return undefined;

  // Run distillation. The ONE special case is a provider/credential-class
  // LLM failure: the configured model is unusable on this instance — warn
  // ONCE per (provider, model) and skip, never error-spam.
  const outcome = await distill({
    conversationId,
    messages: envelope.messages,
    skipTriggerGate: false,
    settings: {
      provider: settings.provider as string | undefined,
      model: settings.model as string | undefined,
    },
    projectId: envelope.projectId,
    runScope: runScopeFrom(run),
  }).catch((err): DistillationOutcome => llmErrorOutcome(err));

  if (
    outcome.kind === "error" &&
    outcome.reason === "llm_error" &&
    outcome.cause === "unavailable"
  ) {
    warnDistillerModelUnavailableOnce(
      resolveProviderModel(
        settings.provider as string | undefined,
        settings.model as string | undefined,
      ),
      outcome.detail,
    );
  }
  return outcome;
}

// ── Fail-soft "model unavailable" warning (deduped per process) ──────
//
// Provider/credential-class LLM failures repeat identically on every
// run until the operator configures a credential, so we warn at most
// once per (provider, model) per process. info/warn level only — this
// is a config nudge, NOT an error, so it must not error-spam the logs.
const _warnedUnavailableModels = new Set<string>();

/** Test-only — clear the dedupe set so each test starts fresh. */
export function _resetDistillerModelWarningForTests(): void {
  _warnedUnavailableModels.clear();
}

function warnDistillerModelUnavailableOnce(
  resolved: { provider: string; model: string },
  detail: string,
): void {
  const key = `${resolved.provider}/${resolved.model}`;
  if (_warnedUnavailableModels.has(key)) return;
  _warnedUnavailableModels.add(key);
  console.warn(
    `[lessons-distiller] distillation skipped — model "${resolved.model}" ` +
      `(provider "${resolved.provider}") is unavailable on this instance: ${detail}. ` +
      `Configure a credential for "${resolved.provider}", or set the ` +
      `lessons-distiller "provider"/"model" settings to a configured ` +
      `provider. This warning is shown once per server start.`,
  );
}

// ── Tool dispatcher (distill_now) ───────────────────────────────────
//
// Manual !EZ:distill path — bypasses the trigger gate (the user
// explicitly asked, the heuristics don't apply), so it carries no run
// scope. Returns a structured `ToolCallResult` that the route forwarder
// maps to the existing `EzActionResult` chat-card shape.
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
    return distillerToolResult({ kind: "decline", reason: "settings_disabled" });
  }

  // One read for both the slice and the projectId — the SDK has no
  // direct conversation-row read, so this RPC is the only source of the
  // project id.
  let envelope: RuntimeMessagesEnvelope;
  try {
    envelope = await runtimeApi.getMessagesEnvelope(conversationId);
  } catch (err) {
    return distillerToolResult({ kind: "error", reason: "internal", detail: (err as Error).message });
  }
  if (!envelope.projectId) {
    return distillerToolResult({ kind: "error", reason: "internal", detail: "conversation has no projectId" });
  }

  const outcome = await distill({
    conversationId,
    messages: envelope.messages,
    skipTriggerGate: true,
    settings: {
      provider: getSetting<string>(ctx, "provider"),
      model: getSetting<string>(ctx, "model"),
    },
    projectId: envelope.projectId,
  });
  return distillerToolResult(outcome);
};

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

// ── Loop definition (run:complete capture) ──────────────────────────
//
// The auto-distill listener is a `defineLoop` terminal capture loop. The
// primitive owns the settings resolution (`ctx.settings`) and the run
// record + retention. The distillation PIPELINE (prompt, JSON parse,
// slug-collision, the warn-once on an unavailable model) stays bespoke —
// it's this loop's domain logic (design §6), invoked from `act`.
//
// `idempotencyKey = slug` is set by the act AFTER the LLM names the slug,
// so it can't gate the fire up-front; instead the existing host-side
// slug-collision (`lessons.write` → created:false) maps to a `skip`,
// preserving the legacy "duplicate slug declines" behavior exactly.
export function defineDistillLoop(): void {
  defineLoop<{ run?: unknown; conversationId?: string }, DistillationOutcome>({
    id: "distill",
    trigger: { kind: "event", event: "run:complete" },
    contract: {
      states: ["done"],
      terminal: ["done"],
      scope: "user",
    },
    act: async (ctx) => {
      // Settings resolution is OWNED by the primitive — `ctx.settings`
      // already has the `{}` fallback applied. The gating, the single
      // conversation read, the project-id resolution and the warn-once
      // all live in `distillRunComplete`.
      const outcome = await distillRunComplete(ctx.input, ctx.settings);
      if (!outcome) return { kind: "skip", reason: "gated" };
      if (outcome.kind === "success") {
        return { kind: "terminal", status: "done", outcome };
      }
      // The unavailable-model case already warned + we skip cleanly.
      if (
        outcome.kind === "error" &&
        outcome.reason === "llm_error" &&
        outcome.cause === "unavailable"
      ) {
        return { kind: "skip", reason: "model_unavailable" };
      }
      // Transient errors throw so the loop records the failure (+ retries
      // next run); declines map to a first-class skip.
      if (outcome.kind === "error") {
        throw new Error(`${outcome.reason}: ${outcome.detail}`);
      }
      return { kind: "skip", reason: outcome.reason };
    },
    // NOTE — deliberately no `log` block. This loop used to declare a
    // `log.artifact` that claimed to mirror each lesson to
    // `lessons/<slug>.md`. It never wrote anything: the SDK's `fsWrite`
    // throws client-side unless the extension holds a `filesystem` grant
    // (`ensureFsAllowed`), the distiller declares none, and the loop's
    // terminal-log step swallows the throw. Its path was wrong too — it
    // keyed on the LOOP id (`distill`) rather than the extension name
    // required by `<projectRoot>/.ezcorp/extension-data/<extension-name>/`.
    // The lesson row in the DB is the source of truth; don't re-add it.
  });
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
  defineDistillLoop();
  // Merge the loop's manual-trigger tools (none here) with the
  // hand-written `distill_now` (which returns the DistillerEnvelope the
  // route forwarder expects — so it stays hand-written, not a generated
  // manual trigger).
  createToolDispatcher({ ...getLoopTools(), ...tools });
  getChannel().start();
}
