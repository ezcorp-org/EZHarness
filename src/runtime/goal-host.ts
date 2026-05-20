/**
 * `/goal` host-side autopilot controller — PRD §7.2 / §7.5.
 *
 * Sibling of {@link import("./start-assignment").startAssignment} but
 * deliberately a SEPARATE module (PRD decision D12 / NG7): the shipped
 * sub-agent loop is hard-wired to sub-conversations + sentinel detection;
 * `/goal` runs on the user's MAIN conversation and uses a cheap-model
 * evaluator. A future RunCompletionLoop extraction is sound but explicitly
 * post-v1, owned by a separate refactor PR that re-owns
 * `start-assignment.ts`'s 100% coverage gate.
 *
 * Responsibilities (Phase 1 — host-only, no UI):
 *   1. Own ONE consolidated subscription set on the singleton bus
 *      (`run:complete` / `run:error` / `run:cancel`, FR-17).
 *   2. Maintain `Map<conversationId, GoalRecord>` in-memory; PersistedGoal
 *      lives in `conversations.metadata.goal` JSONB (D3 — no migration).
 *   3. Parse `/goal …` subcommands (FR-2) and dispatch them via
 *      {@link handleGoalCommand} from the new slash-prefix interceptor in
 *      the messages POST route (NOT the EZ-action registry — FR-1).
 *   4. Run the per-turn evaluator (resolveModel + getCredential + pi-ai
 *      complete, mirror of `src/extensions/llm-handler.ts:316-364`).
 *      Strict-JSON `{achieved, reason}` parsing; 3-consecutive-failure →
 *      pause (FR-8); 30s timeout (FR-12.7); honor the shipped
 *      `<<TASK_DONE>>` / `<<TASK_BLOCKED>>` sentinel as a free
 *      pre-evaluator fast-path (D11).
 *   5. Re-enter `executor.streamChat(conversationId, continuationPrompt,
 *      …)` on `achieved:false` + armed + no in-flight + under turn cap
 *      (FR-10 / FR-12.6).
 *   6. Loop-stop conditions per FR-12: achieved/cleared delete
 *      `metadata.goal`; `run:error` and `run:cancel` ALWAYS pause without
 *      evaluating (watchdog kills are plain `run:error`, no substring
 *      match — FR-12.5).
 *   7. Boot sweep (FR-13a) + lazy POST rehydrate (FR-13b) rebuild
 *      `GoalRecord` from PersistedGoal on restart/resume.
 *   8. Emit `goal:update` bus events on every state transition; SSE
 *      delivery wiring lands in Phase 2.
 *
 * Master kill-switch: `EZCORP_GOAL_ENABLED` host env flag (default ON).
 * When OFF, {@link goalHost.start} no-ops and {@link handleGoalCommand}
 * returns a "goal feature disabled" card.
 *
 * NOT a refactor of `src/runtime/start-assignment.ts` — that file is on
 * the 100% per-file coverage gate (PRD D12 / NG7) and is NEVER modified
 * by this Phase 1 delivery.
 */

import { eq } from "drizzle-orm";
import { logger } from "../logger";
import type { AgentExecutor } from "./executor";
import type { EventBus } from "./events";
import type { AgentEvents, AgentRun } from "../types";
import * as convQueries from "../db/queries/conversations";
import { getDb } from "../db/connection";
import { conversations, messages, runs } from "../db/schema";
import { sql } from "drizzle-orm";
import { resolveModel as defaultResolveModel } from "../providers/router";
import { getCredential as defaultGetCredential } from "../providers/credentials";
import type { EzActionResult } from "./ez-actions/types";

const log = logger.child("goal-host");

// ── Public host constants ───────────────────────────────────────────

/** Hard cap on condition length, JS string `.length`, post-trim (FR-3). */
export const MAX_GOAL_CONDITION_LENGTH = 4000;

/** Default re-entry cap; can be overridden via factory options.
 *  Intentionally larger than `start-assignment`'s `DEFAULT_MAX_AUTONOMOUS_CYCLES=8`
 *  because `/goal` is user-initiated + observable (PRD S3). */
export const DEFAULT_MAX_GOAL_TURNS = 50;

/** Last-N transcript slice handed to the evaluator (FR-7). Matches
 *  `memory-extractor`'s `messages.slice(-20)` precedent. */
export const EVALUATOR_TRANSCRIPT_WINDOW = 20;

/** Evaluator timeout — FR-12.7. Counts as a parse failure on hit. */
export const EVALUATOR_TIMEOUT_MS = 30_000;

/** Output cap clamp on the cheap-model call. */
export const EVALUATOR_MAX_OUTPUT_TOKENS = 512;

/** Pause trigger — FR-8 (anti-garbage-loop). */
export const EVALUATOR_FAILURE_THRESHOLD = 3;

/** Pinned Haiku/flash-lite triple — D5, same set as `memory-extractor`
 *  (`bundled.ts:681-686`). Indexed by provider; values pass to
 *  `resolveModel(provider, model)` verbatim. */
export const CHEAP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "claude-haiku-4-5-20250514",
  google: "gemini-2.0-flash-lite",
  openai: "gpt-4o-mini",
  ollama: "gemma4:e2b",
};

/** Credential fallback chain (FR-6): conv provider → anthropic → any. */
export const FALLBACK_PROVIDERS: readonly string[] = [
  "anthropic",
  "openai",
  "google",
  "ollama",
];

/** Sentinel detection — D11 (cooperative main model can end a goal in
 *  zero evaluator calls). Lifted verbatim from `start-assignment.ts`'s
 *  shipped autonomous loop. */
const TASK_DONE_RE = /<<\s*TASK_DONE\s*>>/;
const TASK_BLOCKED_RE = /<<\s*TASK_BLOCKED\s*:?\s*([^>]*)>>/;

/** Clear-subcommand aliases (PRD §5.3, FR-2). Case-insensitive,
 *  trimmed. The `/goal` token followed by EOS or whitespace, then EXACTLY
 *  one of these tokens. */
export const CLEAR_ALIASES: readonly string[] = [
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel",
];

// ── Persisted shape (D3 — rides in `conversations.metadata.goal`) ───

/** The JSONB shape persisted in `conversations.metadata.goal`. KEY
 *  PRESENCE on the metadata bag == armed (canonical predicate §4). Key
 *  deletion == disarm (achieve / clear / cap). There is NO `armed`
 *  boolean — paused-ness lives only in {@link GoalRecord.status}, in
 *  memory, never persisted, so a paused goal still has `metadata.goal`
 *  present and FR-13b can resume it. */
export interface PersistedGoal {
  condition: string;
  /** Mirror of {@link GoalRecord.lastReason} so the status card has a
   *  reason to show right after a restart, BEFORE the timer/turn fields
   *  rebuild on the first post-restart turn. */
  lastReason: string | null;
  createdAt: string;
}

/** In-memory per-conversation record — NOT persisted; rebuilt on resume
 *  by {@link GoalHost.bootSweep} (FR-13a) or
 *  {@link ensureGoalRecordRehydrated} (FR-13b). Counters reset on resume
 *  per spec. */
export interface GoalRecord {
  conversationId: string;
  armedAt: number;
  turnsEvaluated: number;
  tokenAccumSinceArmed: number;
  evaluatorFailureCount: number;
  lastReason: string | null;
  status: "active" | "paused";
  inFlightRunId: string | null;
}

// ── Canonical armed predicate (§4 Glossary — the SINGLE definition) ─

/**
 * The canonical "armed" predicate referenced by FR-12 / FR-18 / §5.3 /
 * R11. There is exactly ONE definition. Any inline `armed === true`
 * check elsewhere is a bug.
 */
export function isGoalArmed(
  persisted: PersistedGoal | undefined,
  record: GoalRecord | undefined,
): boolean {
  return (
    persisted !== undefined &&
    record !== undefined &&
    record.status === "active"
  );
}

// ── Persistence helpers (read / write / delete `metadata.goal`) ─────

/** Read `metadata.goal` for a conversation; absent ⇒ undefined. */
export async function readPersistedGoal(
  conversationId: string,
): Promise<PersistedGoal | undefined> {
  const conv = await convQueries.getConversation(conversationId);
  if (!conv) return undefined;
  const meta = (conv.metadata ?? {}) as { goal?: PersistedGoal };
  return meta.goal;
}

/** Upsert `metadata.goal` preserving all other metadata keys. No DDL —
 *  the column is a plain JSONB bag (D3). */
export async function writePersistedGoal(
  conversationId: string,
  goal: PersistedGoal,
): Promise<void> {
  const conv = await convQueries.getConversation(conversationId);
  if (!conv) return;
  const meta = {
    ...((conv.metadata ?? {}) as Record<string, unknown>),
    goal,
  };
  await getDb()
    .update(conversations)
    .set({ metadata: meta })
    .where(eq(conversations.id, conversationId));
}

/** DELETE `metadata.goal` — the canonical disarm op (R11). Preserves
 *  other metadata keys. No-op when the conversation is missing or the
 *  key is already absent. */
export async function deletePersistedGoal(
  conversationId: string,
): Promise<void> {
  const conv = await convQueries.getConversation(conversationId);
  if (!conv) return;
  const meta = { ...((conv.metadata ?? {}) as Record<string, unknown>) };
  if (!("goal" in meta)) return;
  delete meta.goal;
  await getDb()
    .update(conversations)
    .set({ metadata: meta })
    .where(eq(conversations.id, conversationId));
}

// ── Slash-prefix parser (FR-2 / U1) ─────────────────────────────────

export type GoalSubcommand = "set" | "status" | "clear";

export interface ParsedGoalCommand {
  subcommand: GoalSubcommand;
  /** Present only for `set`. Already trimmed. May be multi-line. */
  condition?: string;
}

/**
 * True when `content` (whose `trimStart()` is what matters) leads with
 * the `/goal` token followed by EOS or whitespace. `/goalpost` MUST NOT
 * match (FR-1 / §7.2.1 step 2).
 */
export function isGoalCommand(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed === "/goal" ||
    trimmed.startsWith("/goal ") ||
    trimmed.startsWith("/goal\n") ||
    trimmed.startsWith("/goal\t") ||
    trimmed.startsWith("/goal\r")
  );
}

/**
 * Parse a `/goal …` message body. Caller is expected to gate with
 * {@link isGoalCommand} first; passing a non-`/goal` body throws. The
 * parser computes the `rest` (everything after the `/goal` token,
 * trimmed) and dispatches per §6 FR-2:
 *   - empty rest → `status`
 *   - rest is exactly one token whose lowercase ∈ {@link CLEAR_ALIASES}
 *     → `clear`
 *   - any other non-empty rest → `set` (rest is the condition; may be
 *     multi-line).
 */
export function parseGoalCommand(content: string): ParsedGoalCommand {
  if (!isGoalCommand(content)) {
    throw new Error("parseGoalCommand called on non-/goal content");
  }
  // Strip the leading `/goal` token. Trim both ends of what follows.
  const trimmed = content.trimStart();
  const rest = trimmed.slice("/goal".length).trim();
  if (rest.length === 0) return { subcommand: "status" };
  // Single-token (no internal whitespace) alias detection — case
  // insensitive. `/goal CLEAR something` therefore parses as `set` with
  // condition "CLEAR something" (U1 expectation).
  const isSingleToken = !/\s/.test(rest);
  if (isSingleToken && CLEAR_ALIASES.includes(rest.toLowerCase())) {
    return { subcommand: "clear" };
  }
  return { subcommand: "set", condition: rest };
}

// ── Evaluator response parser (FR-8 / U2) ──────────────────────────

export interface EvaluatorResponse {
  achieved: boolean;
  reason: string;
  /** True when the model output was malformed and we defensively
   *  treated it as `achieved:false`. Bumps the failure counter. */
  parseFailed: boolean;
}

/**
 * Parse the cheap-model's strict-JSON `{achieved, reason}` response.
 * Defensive: any non-JSON, missing field, or wrong type collapses to
 * `{achieved:false, reason:<note>, parseFailed:true}` so the host
 * NEVER trusts a non-conforming response to clear a goal (FR-8). The
 * three-consecutive-failure → pause counter lives on
 * {@link GoalRecord.evaluatorFailureCount}, not here.
 */
export function parseEvaluatorResponse(raw: string): EvaluatorResponse {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      achieved: false,
      reason: "evaluator returned an unparseable response; continuing",
      parseFailed: true,
    };
  }
  // Tolerate fenced-code wrappers (some models can't be talked out of
  // them) — strip a leading ```json / ``` and a trailing ```.
  const dejacketed = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(dejacketed);
  } catch {
    return {
      achieved: false,
      reason: "evaluator returned an unparseable response; continuing",
      parseFailed: true,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      achieved: false,
      reason: "evaluator returned an unparseable response; continuing",
      parseFailed: true,
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.achieved !== "boolean") {
    return {
      achieved: false,
      reason: "evaluator returned an unparseable response; continuing",
      parseFailed: true,
    };
  }
  const reasonRaw = typeof obj.reason === "string" ? obj.reason : "";
  // Clamp at the spec ≤280 char limit (FR-8). We DO NOT reject for
  // length — clamp + accept.
  const reason = reasonRaw.length > 280 ? reasonRaw.slice(0, 280) : reasonRaw;
  return { achieved: obj.achieved, reason, parseFailed: false };
}

// ── Sentinel fast-path (D11) ────────────────────────────────────────

/**
 * Honor the shipped `<<TASK_DONE>>` / `<<TASK_BLOCKED>>` sentinel as a
 * free pre-evaluator short-circuit. Returns:
 *   - `{achieved:true, reason:"task done sentinel"}` for `<<TASK_DONE>>`
 *   - `{achieved:false, reason:"task blocked: …"}` for blocked (NO
 *     auto-achieve; blocked still pauses the loop on the upstream side
 *     because `achieved:false` + the watching code's policy will pause
 *     on the next non-progress turn — but at least the model's reason
 *     is surfaced)
 *   - `null` when no sentinel present (caller should run the evaluator).
 */
export function detectSentinel(
  text: string,
): EvaluatorResponse | null {
  if (TASK_DONE_RE.test(text)) {
    return { achieved: true, reason: "task done sentinel", parseFailed: false };
  }
  const m = text.match(TASK_BLOCKED_RE);
  if (m) {
    const r = (m[1] ?? "").trim();
    return {
      achieved: false,
      reason: r ? `task blocked: ${r}` : "task blocked",
      parseFailed: false,
    };
  }
  return null;
}

// ── Evaluator model resolver (FR-6 / U3) ───────────────────────────

export type CredentialFn = (
  provider: string,
  conversationId?: string,
) => Promise<{ type: string; token: string }>;

export type ResolveModelFn = (
  provider?: string,
  model?: string,
) => Promise<{ provider: string; model: string; piModel: unknown }>;

export interface ResolvedEvaluatorModel {
  provider: string;
  model: string;
  piModel: unknown;
  credential: { type: string; token: string };
}

/**
 * Resolve a cheap evaluator model + credential, with the FR-6
 * fallback chain:
 *   1. Conversation's provider (if it has a cheap-model mapping)
 *   2. Anthropic Haiku
 *   3. Any provider in {@link FALLBACK_PROVIDERS} with a working
 *      credential + cheap-model mapping.
 *
 * Returns `null` when NO provider can satisfy the call — caller MUST
 * pause the goal with the reason "No evaluator model available" (FR-6,
 * never silently stall).
 */
export async function resolveEvaluatorModel(
  preferredProvider: string | undefined,
  conversationId: string,
  deps: {
    resolveModel?: ResolveModelFn;
    getCredential?: CredentialFn;
  } = {},
): Promise<ResolvedEvaluatorModel | null> {
  const resolveFn = deps.resolveModel ?? defaultResolveModel;
  const credFn = deps.getCredential ?? defaultGetCredential;

  // Build the candidate order: preferred first (if it has a cheap-model
  // mapping), then the canonical fallback chain, deduped.
  const ordered: string[] = [];
  if (preferredProvider && CHEAP_MODEL_BY_PROVIDER[preferredProvider]) {
    ordered.push(preferredProvider);
  }
  for (const p of FALLBACK_PROVIDERS) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  for (const provider of ordered) {
    const modelId = CHEAP_MODEL_BY_PROVIDER[provider];
    if (!modelId) continue;
    let resolved: { provider: string; model: string; piModel: unknown };
    try {
      resolved = await resolveFn(provider, modelId);
    } catch (err) {
      log.debug("resolveEvaluatorModel: resolveModel failed", {
        provider,
        modelId,
        error: String((err as Error)?.message ?? err),
      });
      continue;
    }
    let cred: { type: string; token: string };
    try {
      cred = await credFn(resolved.provider, conversationId);
    } catch (err) {
      log.debug("resolveEvaluatorModel: getCredential failed", {
        provider,
        modelId,
        error: String((err as Error)?.message ?? err),
      });
      continue;
    }
    return {
      provider: resolved.provider,
      model: resolved.model,
      piModel: resolved.piModel,
      credential: cred,
    };
  }
  return null;
}

// ── FR-9 SQL token-spend aggregation ───────────────────────────────

/**
 * Sum `(messages.usage->>'inputTokens')::int + (messages.usage->>'outputTokens')::int`
 * over `messages.conversationId = :conversationId` joined to `runs` on
 * `messages.runId = runs.id` where `runs.createdAt >= :armedAt`. This
 * is the **single source of truth** for `tokenSpendSinceArmed` (FR-9,
 * PRD §5.2 status card). `messages.usage` shape is
 * `{inputTokens, outputTokens}` only — there is no cost field
 * (`schema.ts:95`); spend is **token counts**, not currency.
 */
export async function computeTokenSpendSinceArmed(
  conversationId: string,
  armedAt: number,
): Promise<number> {
  const db = getDb();
  const armedDate = new Date(armedAt);
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(
      COALESCE((${messages.usage} ->> 'inputTokens')::int, 0)
      + COALESCE((${messages.usage} ->> 'outputTokens')::int, 0)
    ), 0) AS total
    FROM ${messages}
    JOIN ${runs} ON ${messages.runId} = ${runs.id}
    WHERE ${messages.conversationId} = ${conversationId}
      AND ${runs.createdAt} >= ${armedDate}
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0];
  if (!row) return 0;
  const total = row.total;
  if (typeof total === "number") return total;
  if (typeof total === "string") {
    const n = parseInt(total, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ── Continuation prompt (FR-10) ────────────────────────────────────

/** Terse continuation prompt carrying the evaluator's reason as
 *  guidance (FR-10). The condition is re-pinned via the turn's normal
 *  system context, not re-sent in full each turn (mirrors
 *  `start-assignment.ts:CONTINUATION_PROMPT`). */
export function buildContinuationPrompt(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    return "Continue working toward the active /goal condition. Keep going until it's met.";
  }
  return (
    "Continue working toward the active /goal condition. " +
    `Evaluator's note from the previous turn: ${trimmed}`
  );
}

// ── Evaluator system prompt (FR-8 — strict JSON contract) ──────────

export const EVALUATOR_SYSTEM_PROMPT = [
  "You are a goal-evaluator. You judge a conversation against a user-",
  "specified completion condition. You have NO tools and CANNOT read",
  "files — judge strictly from the transcript you are shown.",
  "",
  "Output a single line of strict JSON and nothing else:",
  '{"achieved": <true|false>, "reason": "<≤280 chars>"}',
  "",
  "Rules:",
  "- `achieved` is true ONLY if the condition is unambiguously met by",
  "  the transcript so far.",
  "- `reason` is a short free-text note (the user sees it on the goal",
  "  status card).",
  "- If unsure, return `achieved:false`. The host will run another",
  "  turn — that is the safe default.",
  "- DO NOT wrap the JSON in code fences. DO NOT add any commentary.",
].join("\n");

// ── pi-ai complete wrapper (host-side, mirrors llm-handler.ts:97-125) ─

export type CompleteFn = (
  piModel: unknown,
  body: {
    systemPrompt?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string; timestamp: number }>;
  },
  opts: { apiKey: string; maxTokens?: number; temperature?: number; timeoutMs?: number },
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  usage?: { input?: number; output?: number; cost?: number };
  stopReason?: string;
  model?: string;
}>;

async function defaultPiComplete(
  piModel: unknown,
  body: {
    systemPrompt?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string; timestamp: number }>;
  },
  opts: { apiKey: string; maxTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<{
  content: Array<{ type: string; text?: string }>;
  usage?: { input?: number; output?: number; cost?: number };
  stopReason?: string;
  model?: string;
}> {
  // Dynamic import so a host without pi-ai keys at boot doesn't crash
  // on goal-host module load — same pattern as
  // `src/extensions/llm-handler.ts:97-125`.
  const piAi = (await import("@mariozechner/pi-ai")) as {
    complete: (...args: unknown[]) => Promise<unknown>;
  };
  const piOpts: Record<string, unknown> = { apiKey: opts.apiKey };
  if (opts.maxTokens !== undefined) piOpts.maxTokens = opts.maxTokens;
  if (opts.temperature !== undefined) piOpts.temperature = opts.temperature;
  if (opts.timeoutMs !== undefined && typeof AbortSignal?.timeout === "function") {
    piOpts.signal = AbortSignal.timeout(opts.timeoutMs);
  }
  const result = await piAi.complete(piModel, body, piOpts);
  return result as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input?: number; output?: number; cost?: number };
    stopReason?: string;
    model?: string;
  };
}

// ── Transcript shaping (FR-7) ───────────────────────────────────────

/**
 * Filter the conversation transcript down to a slim text-only history
 * the cheap model can judge from. Strip non-conversational rows
 * (`ez-action-result`, `capability-event`, `extension`) AND any row
 * with `excluded:true` (already dropped from the LLM history pipeline).
 * Tool blocks are not in `messages.content` for this codebase
 * (tool-call payloads ride in a separate table) so no extra stripping
 * is needed here, but we DEFENSIVELY map unknown roles to "user"
 * because pi-ai only accepts `system|user|assistant`.
 */
export function buildEvaluatorTranscript(
  msgs: ReadonlyArray<{ role: string; content: string; excluded?: boolean }>,
  window = EVALUATOR_TRANSCRIPT_WINDOW,
): Array<{ role: "system" | "user" | "assistant"; content: string; timestamp: number }> {
  const filtered = msgs.filter((m) => {
    if (m.excluded === true) return false;
    if (m.role === "ez-action-result") return false;
    if (m.role === "capability-event") return false;
    if (m.role === "extension") return false;
    return true;
  });
  const sliced = filtered.slice(-window);
  const now = Date.now();
  return sliced.map((m) => {
    const role: "system" | "user" | "assistant" =
      m.role === "system" ? "system"
      : m.role === "assistant" ? "assistant"
      : "user";
    return { role, content: m.content, timestamp: now };
  });
}

// ── Evaluator invoke (timeout + parse) ──────────────────────────────

export interface EvaluatorInvokeResult {
  /** When set, the evaluator failed (parse error / timeout) and the
   *  host MUST bump `evaluatorFailureCount`. `response` still carries
   *  the defensive `achieved:false` value, so callers can use a single
   *  code path. */
  response: EvaluatorResponse;
  /** Token usage from the pi-ai call (best-effort). */
  inputTokens: number;
  outputTokens: number;
}

export async function invokeEvaluator(
  resolved: ResolvedEvaluatorModel,
  condition: string,
  transcript: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string; timestamp: number }>,
  opts: {
    timeoutMs?: number;
    maxTokens?: number;
    complete?: CompleteFn;
  } = {},
): Promise<EvaluatorInvokeResult> {
  const completeFn = opts.complete ?? defaultPiComplete;
  const userTurn = {
    role: "user" as const,
    content:
      `Goal condition:\n${condition}\n\n` +
      "Transcript follows. Judge ONLY from it.",
    timestamp: Date.now(),
  };
  try {
    const upstream = await completeFn(
      resolved.piModel,
      {
        systemPrompt: EVALUATOR_SYSTEM_PROMPT,
        messages: [userTurn, ...transcript],
      },
      {
        apiKey: resolved.credential.token,
        maxTokens: opts.maxTokens ?? EVALUATOR_MAX_OUTPUT_TOKENS,
        temperature: 0,
        timeoutMs: opts.timeoutMs ?? EVALUATOR_TIMEOUT_MS,
      },
    );
    const text = (upstream.content ?? [])
      .filter((c) => c?.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const response = parseEvaluatorResponse(text);
    return {
      response,
      inputTokens: upstream.usage?.input ?? 0,
      outputTokens: upstream.usage?.output ?? 0,
    };
  } catch (err) {
    log.debug("invokeEvaluator: call failed/timed out", {
      error: String((err as Error)?.message ?? err),
    });
    return {
      response: {
        achieved: false,
        reason: "evaluator returned an unparseable response; continuing",
        parseFailed: true,
      },
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

// ── Status card builder (FR-19) ─────────────────────────────────────

export interface GoalStatusFields {
  state: "active" | "paused" | "none";
  condition?: string;
  /** Milliseconds since `armedAt`. Resets on resume/restart by design. */
  elapsedMs?: number;
  turnsEvaluated?: number;
  tokenSpendSinceArmed?: number;
  lastReason?: string | null;
}

export function buildStatusCard(fields: GoalStatusFields): EzActionResult {
  if (fields.state === "none") {
    return {
      kind: "decline",
      card: {
        title: "No active goal",
        body: "There's no active /goal on this conversation. Type `/goal <condition>` to start one.",
        variant: "info",
      },
    };
  }
  const condition = fields.condition ?? "(unknown)";
  const elapsed = formatElapsed(fields.elapsedMs ?? 0);
  const turns = fields.turnsEvaluated ?? 0;
  const tokens = fields.tokenSpendSinceArmed ?? 0;
  const lastReason = fields.lastReason?.trim();
  const lines = [
    `Condition: ${condition}`,
    `Status: ${fields.state}`,
    `Elapsed: ${elapsed}`,
    `Turns evaluated: ${turns}`,
    `Token spend (since armed): ${tokens}`,
    lastReason ? `Latest evaluator reason: ${lastReason}` : "Latest evaluator reason: (none yet)",
  ];
  return {
    kind: "success",
    card: {
      title: fields.state === "paused" ? "Goal paused" : "Goal active",
      body: lines.join("\n"),
      variant: fields.state === "paused" ? "warning" : "info",
    },
  };
}

export function buildClearedCard(condition: string | undefined): EzActionResult {
  return {
    kind: "success",
    card: {
      title: "Goal cleared",
      body: condition
        ? `Cleared the active goal: "${truncateForCard(condition)}".`
        : "Cleared the active goal.",
      variant: "info",
    },
  };
}

export function buildNoGoalCard(): EzActionResult {
  return {
    kind: "decline",
    card: {
      title: "No active goal",
      body: "There's no active /goal on this conversation. Type `/goal <condition>` to start one.",
      variant: "info",
    },
  };
}

export function buildAchievedCard(reason: string, condition: string): EzActionResult {
  return {
    kind: "success",
    card: {
      title: "Goal achieved",
      body: `"${truncateForCard(condition)}" — ${reason || "evaluator marked achieved."}`,
      variant: "success",
    },
  };
}

export function buildPausedCard(reason: string, condition: string): EzActionResult {
  return {
    kind: "decline",
    card: {
      title: "Goal paused",
      body:
        `"${truncateForCard(condition)}" — ${reason}. ` +
        "Send another message to resume, or `/goal clear` to drop it.",
      variant: "warning",
    },
  };
}

export function buildRejectTooLongCard(actualLength: number): EzActionResult {
  return {
    kind: "error",
    card: {
      title: "Goal condition too long",
      body:
        `The /goal condition must be ≤ ${MAX_GOAL_CONDITION_LENGTH} characters; got ${actualLength}. ` +
        "Please shorten and retry.",
      variant: "error",
    },
  };
}

export function buildDisabledCard(): EzActionResult {
  return {
    kind: "decline",
    card: {
      title: "/goal disabled",
      body: "The /goal feature is disabled on this server (EZCORP_GOAL_ENABLED=0). Contact the operator to enable.",
      variant: "warning",
    },
  };
}

export function buildTurnCapCard(condition: string, cap: number): EzActionResult {
  return {
    kind: "decline",
    card: {
      title: "Goal stopped — reached turn cap",
      body:
        `Reached the host's ${cap}-turn cap before "${truncateForCard(condition)}" was met. ` +
        "Re-arm with a fresh `/goal …` if you want to continue.",
      variant: "warning",
    },
  };
}

function truncateForCard(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

// ── handleGoalCommand dispatch result (FR-1 / §7.2.1) ──────────────

export interface GoalCommandInput {
  subcommand: GoalSubcommand;
  condition?: string;
  conversationId: string;
  userId: string;
  projectId: string;
  userMessageId: string;
}

export type GoalCommandResult =
  | { kind: "card"; result: EzActionResult }
  | { kind: "start-turn"; turnMessage: string };

// ── The goal host (single instance owned by ensureInitialized) ────

export interface GoalHostOptions {
  bus: EventBus<AgentEvents>;
  executor: AgentExecutor;
  /** Default ON; passing `false` makes start() a no-op and
   *  `handleGoalCommand` return a "disabled" card. */
  enabled?: boolean;
  /** Override for tests. */
  maxGoalTurns?: number;
  /** Override for tests. */
  resolveModel?: ResolveModelFn;
  /** Override for tests. */
  getCredential?: CredentialFn;
  /** Override for tests. */
  complete?: CompleteFn;
  /** Override for tests — defaults to the live `convQueries`. */
  getMessages?: typeof convQueries.getMessages;
  /** Override for tests — defaults to the live `convQueries`. */
  createMessage?: typeof convQueries.createMessage;
  /** Override for tests — defaults to the live SQL aggregator. */
  computeTokenSpend?: (
    conversationId: string,
    armedAt: number,
  ) => Promise<number>;
  /** Override for tests — defaults to live write/delete. */
  writeGoal?: (conversationId: string, goal: PersistedGoal) => Promise<void>;
  /** Override for tests — defaults to live write/delete. */
  deleteGoal?: (conversationId: string) => Promise<void>;
  /** Override for tests — list of conversation ids whose `metadata.goal`
   *  is present, for the boot sweep. Defaults to a live SQL scan. */
  scanGoalConversations?: () => Promise<Array<{ id: string; persisted: PersistedGoal }>>;
  /** Test-only clock. */
  now?: () => number;
  /** Pending-message dequeue (FR-18 supersede). Defaults to the live
   *  `pending-messages` module. */
  dequeuePending?: (conversationId: string) => unknown;
}

export class GoalHost {
  private records = new Map<string, GoalRecord>();
  private unsubs: Array<() => void> = [];
  private started = false;
  private readonly enabled: boolean;
  private readonly maxGoalTurns: number;
  private readonly bus: EventBus<AgentEvents>;
  private readonly executor: AgentExecutor;
  private readonly resolveModelFn: ResolveModelFn;
  private readonly getCredentialFn: CredentialFn;
  private readonly completeFn: CompleteFn;
  private readonly getMessagesFn: typeof convQueries.getMessages;
  private readonly createMessageFn: typeof convQueries.createMessage;
  private readonly computeTokenSpendFn: (
    conversationId: string,
    armedAt: number,
  ) => Promise<number>;
  private readonly writeGoalFn: (
    conversationId: string,
    goal: PersistedGoal,
  ) => Promise<void>;
  private readonly deleteGoalFn: (conversationId: string) => Promise<void>;
  private readonly scanGoalConversationsFn: () => Promise<
    Array<{ id: string; persisted: PersistedGoal }>
  >;
  private readonly nowFn: () => number;
  private readonly dequeuePendingFn: (conversationId: string) => unknown;

  constructor(opts: GoalHostOptions) {
    this.bus = opts.bus;
    this.executor = opts.executor;
    this.enabled = opts.enabled ?? true;
    this.maxGoalTurns = opts.maxGoalTurns ?? DEFAULT_MAX_GOAL_TURNS;
    this.resolveModelFn = opts.resolveModel ?? defaultResolveModel;
    this.getCredentialFn = opts.getCredential ?? defaultGetCredential;
    this.completeFn = opts.complete ?? defaultPiComplete;
    this.getMessagesFn = opts.getMessages ?? convQueries.getMessages;
    this.createMessageFn = opts.createMessage ?? convQueries.createMessage;
    this.computeTokenSpendFn = opts.computeTokenSpend ?? computeTokenSpendSinceArmed;
    this.writeGoalFn = opts.writeGoal ?? writePersistedGoal;
    this.deleteGoalFn = opts.deleteGoal ?? deletePersistedGoal;
    this.scanGoalConversationsFn =
      opts.scanGoalConversations ?? defaultScanGoalConversations;
    this.nowFn = opts.now ?? (() => Date.now());
    this.dequeuePendingFn =
      opts.dequeuePending ??
      ((conversationId: string) => {
        // Live wiring. Lazy require so test-only goal-hosts don't pull
        // pending-messages into their dependency graph.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("./pending-messages") as {
          dequeue: (id: string) => unknown;
        };
        return mod.dequeue(conversationId);
      });
  }

  /** True when the feature flag is on (EZCORP_GOAL_ENABLED). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Attach the consolidated bus subscription set (FR-17) and run the
   * boot sweep (FR-13a). Idempotent — second call is a no-op.
   *
   * When `enabled === false` (EZCORP_GOAL_ENABLED=0) this is a no-op:
   * no subscriptions attached, no sweep performed.
   */
  async start(): Promise<void> {
    if (this.started) return;
    if (!this.enabled) {
      log.info("goal-host: disabled via EZCORP_GOAL_ENABLED=0");
      this.started = true;
      return;
    }
    this.started = true;

    this.unsubs.push(
      this.bus.on("run:complete", (data) => {
        this.onRunComplete(data).catch((err) => {
          log.error("onRunComplete failed", {
            error: String((err as Error)?.message ?? err),
          });
        });
      }),
    );
    this.unsubs.push(
      this.bus.on("run:error", (data) => {
        this.onRunTerminal(data.run, data.conversationId, "error", data.error).catch(
          (err) => {
            log.error("onRunTerminal(error) failed", {
              error: String((err as Error)?.message ?? err),
            });
          },
        );
      }),
    );
    this.unsubs.push(
      this.bus.on("run:cancel", (data) => {
        this.onRunTerminal(data.run, data.conversationId, "cancel").catch((err) => {
          log.error("onRunTerminal(cancel) failed", {
            error: String((err as Error)?.message ?? err),
          });
        });
      }),
    );

    try {
      await this.bootSweep();
    } catch (err) {
      log.error("bootSweep failed", {
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  /** Tear down the bus subscriptions; clears the records map. Used by
   *  tests + future shutdown wiring. */
  stop(): void {
    for (const off of this.unsubs) {
      try { off(); } catch { /* ignore */ }
    }
    this.unsubs = [];
    this.records.clear();
    this.started = false;
  }

  /** FR-13a boot sweep — scan persisted goals, rebuild `GoalRecord`s. */
  async bootSweep(): Promise<void> {
    const rows = await this.scanGoalConversationsFn();
    const now = this.nowFn();
    for (const row of rows) {
      // Reset all counters per spec. `lastReason` carries from persisted
      // mirror so the status card has something to show before the first
      // post-restart turn.
      this.records.set(row.id, {
        conversationId: row.id,
        armedAt: now,
        turnsEvaluated: 0,
        tokenAccumSinceArmed: 0,
        evaluatorFailureCount: 0,
        lastReason: row.persisted.lastReason,
        status: "active",
        inFlightRunId: null,
      });
    }
    log.info("goal-host: boot sweep complete", { count: rows.length });
  }

  /** FR-13b lazy rebuild + conditional paused→active flip. Called by
   *  the messages POST handler BEFORE the slash-prefix interceptor AND
   *  BEFORE `streamChat`. The `isGoalCmd` flag is computed by the
   *  caller (via {@link isGoalCommand}) — when true, the helper rebuilds
   *  the record in its persisted state without flipping paused→active
   *  (the subcommand owns that decision). */
  async ensureGoalRecordRehydrated(
    conversationId: string,
    isGoalCmd: boolean,
  ): Promise<void> {
    const persisted = await readPersistedGoal(conversationId);
    if (!persisted) return; // nothing to rehydrate; no goal armed
    let record = this.records.get(conversationId);
    if (!record) {
      record = {
        conversationId,
        armedAt: this.nowFn(),
        turnsEvaluated: 0,
        tokenAccumSinceArmed: 0,
        evaluatorFailureCount: 0,
        lastReason: persisted.lastReason,
        status: "active",
        inFlightRunId: null,
      };
      this.records.set(conversationId, record);
    }
    // Conditional paused→active flip. ONLY for non-/goal posts; /goal
    // subcommands own resume/clear/replace (FR-13b safety; I5d).
    if (!isGoalCmd && record.status === "paused") {
      record.status = "active";
      this.emitUpdate(conversationId, "active", record, persisted);
    }
  }

  /** Public accessor for tests + the messages route's status branch. */
  getRecord(conversationId: string): GoalRecord | undefined {
    return this.records.get(conversationId);
  }

  /** Public accessor for the canonical armed predicate. */
  async isArmed(conversationId: string): Promise<boolean> {
    const persisted = await readPersistedGoal(conversationId);
    const record = this.records.get(conversationId);
    return isGoalArmed(persisted, record);
  }

  /**
   * Slash-prefix interceptor entry point — FR-1 / §7.2.1. Called from
   * `messages/+server.ts` AFTER the user-message persist and BEFORE the
   * EZ-action scan. The interceptor's caller is responsible for:
   *   - branching on `kind`: `"card"` → persist the `ez-action-result`
   *     row + early-return; `"start-turn"` → DO NOT return, fall through
   *     to the existing `streamChat` call.
   *
   * Persistence side-effects: `set` writes `metadata.goal` + creates the
   * `GoalRecord` + emits `goal:update{state:"active"}`. `clear` deletes
   * `metadata.goal` + drops the `GoalRecord` + emits `goal:update{off}`.
   * `status` is read-only.
   */
  async handleGoalCommand(input: GoalCommandInput): Promise<GoalCommandResult> {
    if (!this.enabled) {
      return { kind: "card", result: buildDisabledCard() };
    }
    if (input.subcommand === "set") {
      return this.handleSet(input);
    }
    if (input.subcommand === "clear") {
      return this.handleClear(input);
    }
    return this.handleStatus(input);
  }

  private async handleSet(input: GoalCommandInput): Promise<GoalCommandResult> {
    const condition = (input.condition ?? "").trim();
    if (condition.length === 0) {
      // Defensive — parser maps empty to status; if we got here it's a
      // caller bug. Treat as status.
      return this.handleStatus(input);
    }
    if (condition.length > MAX_GOAL_CONDITION_LENGTH) {
      // FR-3: reject, no metadata.goal write, no GoalRecord, no
      // streamChat.
      return {
        kind: "card",
        result: buildRejectTooLongCard(condition.length),
      };
    }
    const now = this.nowFn();
    const persisted: PersistedGoal = {
      condition,
      lastReason: null,
      createdAt: new Date(now).toISOString(),
    };
    await this.writeGoalFn(input.conversationId, persisted);
    // Replaces any active goal (FR-7 / §5.1 silent supersede). The
    // single consolidated subscription stays attached; the next
    // run:complete just re-evaluates the canonical armed predicate
    // (R10 — re-/goal on an active conv doesn't double-subscribe).
    this.records.set(input.conversationId, {
      conversationId: input.conversationId,
      armedAt: now,
      turnsEvaluated: 0,
      tokenAccumSinceArmed: 0,
      evaluatorFailureCount: 0,
      lastReason: null,
      status: "active",
      inFlightRunId: null,
    });
    this.emitUpdate(input.conversationId, "active", this.records.get(input.conversationId)!, persisted);
    return {
      kind: "start-turn",
      turnMessage: condition, // not used by the route — body.content is the turn input
    };
  }

  private async handleClear(input: GoalCommandInput): Promise<GoalCommandResult> {
    const persisted = await readPersistedGoal(input.conversationId);
    if (!persisted) {
      // No goal to clear — silent no-op card. Per spec §5.3 / R11 the
      // record is also absent so the in-flight turn (if any) is
      // un-affected.
      return { kind: "card", result: buildNoGoalCard() };
    }
    // Single op (R11 — clear-vs-disarm single predicate): delete +
    // drop. No `armed:false` two-step.
    await this.deleteGoalFn(input.conversationId);
    this.records.delete(input.conversationId);
    this.emitUpdate(input.conversationId, "off");
    const persistResult = await this.persistResultRow(input, buildClearedCard(persisted.condition));
    return { kind: "card", result: persistResult };
  }

  private async handleStatus(input: GoalCommandInput): Promise<GoalCommandResult> {
    const persisted = await readPersistedGoal(input.conversationId);
    if (!persisted) {
      return {
        kind: "card",
        result: buildStatusCard({ state: "none" }),
      };
    }
    const record = this.records.get(input.conversationId);
    // Status NEVER auto-resumes a paused goal (I5d / FR-13b). The
    // helper at the route boundary suppresses the flip when the post
    // is a /goal command; here we just report whatever state we have.
    const state: "active" | "paused" =
      record?.status === "paused" ? "paused" : "active";
    let elapsedMs = 0;
    let turnsEvaluated = 0;
    let tokenSpendSinceArmed = 0;
    let lastReason: string | null = persisted.lastReason;
    if (record) {
      elapsedMs = this.nowFn() - record.armedAt;
      turnsEvaluated = record.turnsEvaluated;
      // Reconcile to the SQL aggregate (FR-9 SoT).
      const sqlSpend = await this.computeTokenSpendFn(input.conversationId, record.armedAt);
      record.tokenAccumSinceArmed = sqlSpend;
      tokenSpendSinceArmed = sqlSpend;
      lastReason = record.lastReason ?? persisted.lastReason;
    }
    const card = buildStatusCard({
      state,
      condition: persisted.condition,
      elapsedMs,
      turnsEvaluated,
      tokenSpendSinceArmed,
      lastReason,
    });
    const persistResult = await this.persistResultRow(input, card);
    return { kind: "card", result: persistResult };
  }

  /** Persist an `ez-action-result` row carrying the EzActionResult JSON
   *  (FR-19 — row convention only, not the EZ scan loop). Returns the
   *  ORIGINAL card (the route serialises this into the response). */
  private async persistResultRow(
    input: GoalCommandInput,
    card: EzActionResult,
  ): Promise<EzActionResult> {
    try {
      await this.createMessageFn(input.conversationId, {
        role: "ez-action-result",
        content: JSON.stringify(card),
        parentMessageId: input.userMessageId,
      });
    } catch (err) {
      log.warn("persistResultRow failed (continuing)", {
        error: String((err as Error)?.message ?? err),
      });
    }
    return card;
  }

  // ── run:complete handler — the core loop ──────────────────────────

  private async onRunComplete(data: AgentEvents["run:complete"]): Promise<void> {
    const conversationId = data.conversationId;
    if (!conversationId) return;
    const persisted = await readPersistedGoal(conversationId);
    const record = this.records.get(conversationId);
    if (!isGoalArmed(persisted, record)) return;
    if (record!.inFlightRunId !== data.run.id) {
      // Not the run this loop authored / a separate turn we didn't
      // arm against. Still count: this is a `run:complete` on an
      // armed conversation — the spec says EVERY turn-complete on an
      // armed conv triggers an evaluator (FR-5).
      record!.inFlightRunId = null;
    } else {
      record!.inFlightRunId = null;
    }
    record!.turnsEvaluated++;

    // FR-18 supersede check.
    const pending = this.dequeuePendingFn(conversationId);
    if (pending) {
      // User has another message queued — let the user's turn run,
      // evaluator will re-fire on its run:complete with the post-user
      // transcript.
      log.debug("goal-host: superseded by pending user message", { conversationId });
      return;
    }

    // FR-12.6 hard turn-cap backstop (independent of model self-report).
    if (record!.turnsEvaluated >= this.maxGoalTurns) {
      const card = buildTurnCapCard(persisted!.condition, this.maxGoalTurns);
      // Clear (delete metadata.goal + drop record) + transcript row.
      await this.deleteGoalFn(conversationId);
      this.records.delete(conversationId);
      this.emitUpdate(conversationId, "off");
      await this.persistResultRowBare(conversationId, card);
      return;
    }

    // Build the transcript + sentinel fast-path (D11).
    let transcript: ReadonlyArray<{ role: string; content: string; excluded?: boolean }>;
    try {
      transcript = await this.getMessagesFn(conversationId);
    } catch (err) {
      log.warn("getMessages failed; pausing", {
        error: String((err as Error)?.message ?? err),
      });
      await this.pauseRecord(conversationId, "transcript fetch failed", record!, persisted!);
      return;
    }
    const lastAssistantText = lastAssistantContent(transcript);
    const sentinel = lastAssistantText ? detectSentinel(lastAssistantText) : null;

    let evalResult: EvaluatorResponse;
    let usedSentinel = false;
    if (sentinel) {
      evalResult = sentinel;
      usedSentinel = true;
    } else {
      const resolved = await resolveEvaluatorModel(
        data.run.provider,
        conversationId,
        { resolveModel: this.resolveModelFn, getCredential: this.getCredentialFn },
      );
      if (!resolved) {
        await this.pauseRecord(
          conversationId,
          "No evaluator model available",
          record!,
          persisted!,
        );
        return;
      }
      const shaped = buildEvaluatorTranscript(transcript);
      const invoked = await invokeEvaluator(resolved, persisted!.condition, shaped, {
        complete: this.completeFn,
      });
      evalResult = invoked.response;
    }

    if (evalResult.parseFailed) {
      record!.evaluatorFailureCount++;
      if (record!.evaluatorFailureCount >= EVALUATOR_FAILURE_THRESHOLD) {
        await this.pauseRecord(
          conversationId,
          "evaluator failed 3 times in a row",
          record!,
          persisted!,
        );
        return;
      }
      // Below threshold — fall through with achieved:false, continue.
    } else {
      record!.evaluatorFailureCount = 0;
    }

    // Mirror the reason into persisted metadata so the status card has
    // it after a restart (FR-15).
    record!.lastReason = evalResult.reason;
    await this.writeGoalFn(conversationId, {
      ...persisted!,
      lastReason: evalResult.reason,
    });

    if (evalResult.achieved) {
      const card = buildAchievedCard(evalResult.reason, persisted!.condition);
      await this.deleteGoalFn(conversationId);
      this.records.delete(conversationId);
      this.emitUpdate(conversationId, "off");
      await this.persistResultRowBare(conversationId, card);
      return;
    }

    // Re-entry guard (FR-18 — canonical predicate re-check, in-flight clear).
    const stillPersisted = await readPersistedGoal(conversationId);
    if (!isGoalArmed(stillPersisted, record)) return; // cleared mid-flight (R11)

    // Re-enter streamChat (FR-10). Fresh runId; we own the bookkeeping.
    const newRunId = crypto.randomUUID();
    record!.inFlightRunId = newRunId;
    const continuation = buildContinuationPrompt(evalResult.reason);
    this.emitUpdate(conversationId, "active", record!, stillPersisted!);
    try {
      const streamPromise = this.executor.streamChat(conversationId, continuation, {
        runId: newRunId,
      });
      streamPromise.catch((err) => {
        log.error("goal-host: streamChat error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      log.error("goal-host: streamChat sync throw", {
        error: String((err as Error)?.message ?? err),
      });
      await this.pauseRecord(
        conversationId,
        "continuation turn failed to start",
        record!,
        stillPersisted!,
      );
    }
    if (usedSentinel) {
      // Marker for log line — sentinel fast-path saved one evaluator call.
      log.debug("goal-host: sentinel fast-path achieved/not-yet", {
        conversationId,
        achieved: evalResult.achieved,
      });
    }
  }

  /** FR-12.3 / FR-12.4 / FR-12.5: ANY run:error or run:cancel for the
   *  armed conv's run → pause WITHOUT evaluating. */
  private async onRunTerminal(
    run: AgentRun,
    conversationId: string | undefined,
    kind: "error" | "cancel",
    errorText?: string,
  ): Promise<void> {
    if (!conversationId) return;
    const persisted = await readPersistedGoal(conversationId);
    const record = this.records.get(conversationId);
    if (!isGoalArmed(persisted, record)) return;
    if (record!.inFlightRunId === run.id) {
      record!.inFlightRunId = null;
    }
    const reason =
      kind === "cancel"
        ? "Run was cancelled (Stop / Ctrl-C)"
        : `Run failed: ${errorText ?? "unknown error"}`;
    await this.pauseRecord(conversationId, reason, record!, persisted!);
  }

  private async pauseRecord(
    conversationId: string,
    reason: string,
    record: GoalRecord,
    persisted: PersistedGoal,
  ): Promise<void> {
    record.status = "paused";
    record.lastReason = reason;
    record.inFlightRunId = null;
    await this.writeGoalFn(conversationId, {
      ...persisted,
      lastReason: reason,
    });
    this.emitUpdate(conversationId, "paused", record, persisted);
    await this.persistResultRowBare(
      conversationId,
      buildPausedCard(reason, persisted.condition),
    );
  }

  /** Persist a card row WITHOUT a userMessageId parent — used by the
   *  loop's own "achieved" / "paused" / "turn cap" transcript entries.
   *  Best-effort; logs on failure but never throws. */
  private async persistResultRowBare(
    conversationId: string,
    card: EzActionResult,
  ): Promise<void> {
    try {
      await this.createMessageFn(conversationId, {
        role: "ez-action-result",
        content: JSON.stringify(card),
      });
    } catch (err) {
      log.warn("persistResultRowBare failed", {
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  private emitUpdate(
    conversationId: string,
    state: "active" | "paused" | "off",
    record?: GoalRecord,
    persisted?: PersistedGoal,
  ): void {
    const payload: AgentEvents["goal:update"] = {
      conversationId,
      state,
    };
    if (persisted) payload.condition = persisted.condition;
    if (record) {
      payload.armedAt = record.armedAt;
      payload.turnsEvaluated = record.turnsEvaluated;
      payload.lastReason = record.lastReason;
    }
    this.bus.emit("goal:update", payload);
  }
}

// ── Default boot-sweep scan (live SQL) ──────────────────────────────

async function defaultScanGoalConversations(): Promise<
  Array<{ id: string; persisted: PersistedGoal }>
> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT id, metadata
    FROM ${conversations}
    WHERE metadata ? 'goal'
  `);
  const out: Array<{ id: string; persisted: PersistedGoal }> = [];
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const meta = (row.metadata ?? {}) as { goal?: unknown };
    const goal = meta.goal as PersistedGoal | undefined;
    if (!goal || typeof goal.condition !== "string") continue;
    out.push({ id: row.id as string, persisted: goal });
  }
  return out;
}

// ── Internal helpers ────────────────────────────────────────────────

function lastAssistantContent(
  msgs: ReadonlyArray<{ role: string; content: string; excluded?: boolean }>,
): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.excluded === true) continue;
    if (m.role === "assistant") return m.content;
  }
  return null;
}

// ── Singleton accessor (D9 — `ensureInitialized()` constructs it) ──

let singleton: GoalHost | null = null;

/** Construct + retain the process-wide goal-host. Idempotent. Called
 *  from `ensureInitialized()` in `web/src/lib/server/context.ts`
 *  alongside `executor.startOrphanCleanup()`. */
export function initGoalHost(opts: GoalHostOptions): GoalHost {
  if (singleton) return singleton;
  singleton = new GoalHost(opts);
  return singleton;
}

/** Public accessor — throws when {@link initGoalHost} hasn't run. */
export function getGoalHost(): GoalHost {
  if (!singleton) {
    throw new Error("goal-host not initialized — call initGoalHost() first");
  }
  return singleton;
}

/** Test-only reset. */
export function _resetGoalHostSingleton(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
