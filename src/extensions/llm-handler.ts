/**
 * `ezcorp/llm-complete` reverse-RPC handler — the trust-boundary
 * implementation of `ctx.llm.complete()`.
 *
 * **The single biggest invariant guarded here: the API token NEVER
 * crosses the JSON-RPC boundary.** The host resolves credentials,
 * calls `pi-ai`'s `complete()` directly with `{apiKey: cred.token}`,
 * and serializes ONLY the result fields (`{content, blocks, usage,
 * finishReason, model}`) into the response. The subprocess does not
 * see the token in either the request side-channel or the response
 * payload.
 *
 * Soft-fail ladder (per spec):
 *   -32101  provider not granted / model not in allowlist
 *   -32103  quota exceeded (calls-per-hour | calls-per-day | tokens-per-day)
 *   -32104  credential missing for provider
 *   -32105  pi-ai upstream call failed
 *
 * Hard-deny graduation: the per-process counter at module scope
 * tracks `provider-not-granted` attempts in a 1-minute sliding
 * window per extension. On the 11th attempt, we call
 * `denyAndDisable(extensionId, "Repeated attempts to use ungranted
 * provider X")` — matches the filesystem-violation precedent.
 */

import { logger } from "../logger";
import { deriveHandlerContext, type RegisteredToolStub } from "./handler-context";
import { recordCapabilityCall } from "./recordCapabilityCall";
import { denyAndDisable } from "./security";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "./audit-actions";
import { getLlmQuota, type LlmQuota } from "./llm-quota";
import type { ExtensionPermissions, JsonRpcRequest, JsonRpcResponse } from "./types";

const log = logger.child("ext.llm-handler");

// ── Hard-deny graduation tracker (per-process; matches filesystem
//     precedent at tool-executor.ts:380). Keyed by extensionId. ────
const ABUSE_WINDOW_MS = 60_000;
const ABUSE_HARD_DENY_THRESHOLD = 11;

interface AbuseEntry {
  attempts: number[]; // ms timestamps in the rolling window
}
const abuseTracker = new Map<string, AbuseEntry>();

function recordProviderNotGrantedAttempt(extensionId: string): number {
  const now = Date.now();
  const entry = abuseTracker.get(extensionId) ?? { attempts: [] };
  // Prune.
  const cutoff = now - ABUSE_WINDOW_MS;
  while (entry.attempts.length > 0 && entry.attempts[0]! < cutoff) {
    entry.attempts.shift();
  }
  entry.attempts.push(now);
  abuseTracker.set(extensionId, entry);
  return entry.attempts.length;
}

/** Test-only — clear the abuse tracker so tests don't leak. */
export function _resetLlmAbuseTrackerForTests(): void {
  abuseTracker.clear();
}

// ── Glob match for `allowedModels` ──────────────────────────────

function modelMatchesGlob(model: string, glob: string): boolean {
  // Simple `*` glob — sufficient for `gpt-4*`, `claude-3-*` etc.
  // Sec hardened: no `..`, no leading `/` (validated at clamp time).
  const re = new RegExp("^" + glob.split("*").map(escapeRegex).join(".*") + "$");
  return re.test(model);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Request shape ───────────────────────────────────────────────

interface LlmCompleteParams {
  provider: string;
  model: string;
  systemPrompt?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string; blocks?: unknown[] }>;
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: unknown;
  timeoutMs?: number;
  /** Optional — if the SDK is calling `getBudget()` instead of
   *  `complete()`, the params include `op: "budget"` and we return
   *  the snapshot without doing anything else. */
  op?: "complete" | "budget" | "stream";
}

// ── Inline pi-ai dynamic import (mirrors distiller.ts pattern) ──

async function callPiAiComplete(
  resolvedPiModel: unknown,
  body: {
    systemPrompt?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string; timestamp: number }>;
  },
  opts: { apiKey: string; maxTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input?: number; output?: number; cost?: number }; stopReason?: string; model?: string }> {
  // Dynamic import so an environment without API keys never trips on
  // module load — keeps this file safe to import everywhere.
  const piAi = await import("@mariozechner/pi-ai");
  // The pi-ai signature is `complete(piModel, body, opts)`. We thread
  // `timeoutMs` via `signal: AbortSignal.timeout(...)` if available
  // and clamp; pi-ai itself respects abort.
  const completeFn = (piAi as unknown as { complete: (...args: unknown[]) => Promise<unknown> }).complete;
  const piOpts: Record<string, unknown> = { apiKey: opts.apiKey };
  if (opts.maxTokens !== undefined) piOpts.maxTokens = opts.maxTokens;
  if (opts.temperature !== undefined) piOpts.temperature = opts.temperature;
  if (opts.timeoutMs !== undefined && typeof AbortSignal?.timeout === "function") {
    piOpts.signal = AbortSignal.timeout(opts.timeoutMs);
  }
  const result = await completeFn(resolvedPiModel, body, piOpts);
  return result as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input?: number; output?: number; cost?: number };
    stopReason?: string;
    model?: string;
  };
}

// ── Result shape returned to subprocess ────────────────────────

export interface LlmCompleteResult {
  content: string;
  blocks: unknown[];
  usage: { inputTokens: number; outputTokens: number; estCostCents?: number };
  finishReason: "stop" | "max_tokens" | "tool_use" | "error" | "filtered";
  model: string;
}

// ── Handler context (host-injected dependencies, mockable in tests) ──

export interface LlmHandlerContext {
  /** The granted permissions for the calling extension. */
  granted: ExtensionPermissions;
  /** The registered tool — provides `extensionId` to derive the
   *  handler context. */
  registeredTool: RegisteredToolStub;
  /** Optional in-memory quota (defaults to the singleton). */
  quota?: LlmQuota;
  /** Optional model resolver (host swap-in). Defaults to the
   *  production `resolveModel` from `../providers/router`. */
  resolveModelFn?: (provider: string, model: string) => Promise<{ provider: string; model: string; piModel: unknown }>;
  /** Optional credential resolver. Defaults to production
   *  `getCredential`. */
  getCredentialFn?: (provider: string, conversationId?: string) => Promise<{ type: string; token: string }>;
  /** Optional pi-ai complete swap-in for tests. Defaults to dynamic
   *  import of `@mariozechner/pi-ai`. */
  completeFn?: typeof callPiAiComplete;
}

// ── Main entrypoint ─────────────────────────────────────────────

export async function handlePiLlmComplete(
  req: JsonRpcRequest,
  ctx: LlmHandlerContext,
  rpcMeta?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const startedAt = Date.now();
  const handlerCtx = deriveHandlerContext(rpcMeta, ctx.registeredTool);
  const params = (req.params ?? {}) as unknown as LlmCompleteParams;

  const grantedLlm = ctx.granted.llm;
  if (!grantedLlm) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32101,
        message: "ctx.llm permission not granted to this extension",
      },
    };
  }

  // ── getBudget() short-circuit ────────────────────────────────
  if (params.op === "budget") {
    const quota = ctx.quota ?? getLlmQuota();
    const snapshot = quota.budget(handlerCtx.actorExtensionId, {
      maxCallsPerHour: grantedLlm.maxCallsPerHour,
      maxCallsPerDay: grantedLlm.maxCallsPerDay,
      ...(grantedLlm.maxTokensPerDay !== undefined ? { maxTokensPerDay: grantedLlm.maxTokensPerDay } : {}),
    });
    return { jsonrpc: "2.0", id: req.id, result: snapshot };
  }

  // ── Streaming stub (locked decision: deferred to v1.4) ──────
  if (params.op === "stream") {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: "ctx.llm.stream() is not implemented (deferred to v1.4)" },
    };
  }

  // ── Provider gate ────────────────────────────────────────────
  if (typeof params.provider !== "string" || !grantedLlm.providers.includes(params.provider)) {
    const attempts = recordProviderNotGrantedAttempt(handlerCtx.actorExtensionId);
    // Audit governance row.
    await insertAuditEntry(
      handlerCtx.onBehalfOf,
      EXT_AUDIT_ACTIONS.SDK_LLM_REJECTED,
      handlerCtx.actorExtensionId,
      {
        capability: "llm",
        oldValue: undefined,
        newValue: params.provider ?? null,
        actor: handlerCtx.onBehalfOf,
        reason: "provider-not-granted",
      } satisfies ExtensionAuditMetadata,
    );

    if (attempts >= ABUSE_HARD_DENY_THRESHOLD) {
      try {
        await denyAndDisable(
          handlerCtx.actorExtensionId,
          `Repeated attempts to use ungranted provider ${params.provider}`,
          "ctx.llm.complete",
        );
        await insertAuditEntry(
          handlerCtx.onBehalfOf,
          EXT_AUDIT_ACTIONS.SDK_LLM_DENIED_AND_DISABLED,
          handlerCtx.actorExtensionId,
          {
            capability: "llm",
            oldValue: null,
            newValue: params.provider,
            actor: "system",
            reason: `${attempts} attempts in 60s`,
          } satisfies ExtensionAuditMetadata,
        );
      } catch (err) {
        log.warn("denyAndDisable-failed", { error: String(err) });
      }
    }
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32101, message: `Provider not granted: ${params.provider}` },
    };
  }

  // ── Model allowlist gate ─────────────────────────────────────
  if (grantedLlm.allowedModels && grantedLlm.allowedModels[params.provider]) {
    const globs = grantedLlm.allowedModels[params.provider]!;
    const allowed = globs.some((g) => modelMatchesGlob(params.model, g));
    if (!allowed) {
      await insertAuditEntry(
        handlerCtx.onBehalfOf,
        EXT_AUDIT_ACTIONS.SDK_LLM_REJECTED,
        handlerCtx.actorExtensionId,
        {
          capability: "llm",
          oldValue: undefined,
          newValue: { provider: params.provider, model: params.model },
          actor: handlerCtx.onBehalfOf,
          reason: "model-not-allowed",
        } satisfies ExtensionAuditMetadata,
      );
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32101, message: `Model not in allowlist: ${params.model}` },
      };
    }
  }

  // ── Quota gate ───────────────────────────────────────────────
  const quota = ctx.quota ?? getLlmQuota();
  // Always have a concrete token estimate for the quota counter.
  const reqMaxTokens: number =
    clampInt(params.maxTokens, 1, grantedLlm.maxTokensPerCall ?? 4096)
    ?? Math.min(4096, grantedLlm.maxTokensPerCall ?? 4096);
  const consumeResult = quota.consume(
    handlerCtx.actorExtensionId,
    {
      maxCallsPerHour: grantedLlm.maxCallsPerHour,
      maxCallsPerDay: grantedLlm.maxCallsPerDay,
      ...(grantedLlm.maxTokensPerDay !== undefined ? { maxTokensPerDay: grantedLlm.maxTokensPerDay } : {}),
    },
    { tokens: reqMaxTokens },
  );
  if (!consumeResult.ok) {
    await recordCapabilityCall({
      ctx: handlerCtx,
      capability: "llm",
      action: "complete",
      durationMs: Date.now() - startedAt,
      success: false,
      errorCode: "LLM_QUOTA_EXCEEDED",
      errorMessage: consumeResult.reason ?? "quota",
      provider: params.provider,
      model: params.model,
    });
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32103,
        message: `Quota exceeded: ${consumeResult.reason}`,
        data: { reason: consumeResult.reason, retryAfterMs: consumeResult.retryAfterMs },
      },
    };
  }

  // ── Resolve provider model + credential (HOST-SIDE ONLY) ─────
  let cred: { type: string; token: string };
  let resolved: { provider: string; model: string; piModel: unknown };
  try {
    const resolveModel = ctx.resolveModelFn ?? (await import("../providers/router")).resolveModel;
    resolved = await resolveModel(params.provider, params.model);
    const getCredential = ctx.getCredentialFn ?? (await import("../providers/credentials")).getCredential;
    cred = await getCredential(resolved.provider, handlerCtx.conversationId ?? undefined);
  } catch (err) {
    quota.adjustTokens(handlerCtx.actorExtensionId, -reqMaxTokens);
    await recordCapabilityCall({
      ctx: handlerCtx,
      capability: "llm",
      action: "complete",
      durationMs: Date.now() - startedAt,
      success: false,
      errorCode: "LLM_CREDENTIAL_MISSING",
      errorMessage: String((err as Error)?.message ?? err),
      provider: params.provider,
      model: params.model,
    });
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32104, message: `Credential missing for provider ${params.provider}` },
    };
  }

  // ── Issue the upstream call ─────────────────────────────────
  const completeFn = ctx.completeFn ?? callPiAiComplete;
  let upstream: Awaited<ReturnType<typeof callPiAiComplete>>;
  try {
    upstream = await completeFn(
      resolved.piModel,
      {
        ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
        messages: params.messages.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: Date.now(),
        })),
      },
      {
        apiKey: cred.token,
        ...(reqMaxTokens !== undefined ? { maxTokens: reqMaxTokens } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(grantedLlm.maxTimeoutMs !== undefined ? { timeoutMs: clampInt(params.timeoutMs, 1000, grantedLlm.maxTimeoutMs) } : {}),
      },
    );
  } catch (err) {
    // Refund the speculative token reservation.
    quota.adjustTokens(handlerCtx.actorExtensionId, -reqMaxTokens);
    await recordCapabilityCall({
      ctx: handlerCtx,
      capability: "llm",
      action: "complete",
      durationMs: Date.now() - startedAt,
      success: false,
      errorCode: "LLM_PROVIDER_ERROR",
      errorMessage: String((err as Error)?.message ?? err),
      provider: params.provider,
      model: resolved.model,
    });
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32105, message: `Provider call failed: ${String((err as Error)?.message ?? err)}` },
    };
  }

  // ── Build result + record audit ─────────────────────────────
  const text = (upstream.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  const inputTokens = upstream.usage?.input ?? 0;
  const outputTokens = upstream.usage?.output ?? 0;
  const estCostCents = upstream.usage?.cost !== undefined ? Math.round(upstream.usage.cost * 100) : undefined;

  // Adjust the day-token counter from the speculative max-tokens to
  // the actual (output_tokens from upstream). The pre-booking was
  // generous; we refund the difference.
  quota.adjustTokens(handlerCtx.actorExtensionId, outputTokens - reqMaxTokens);

  const finishReason: LlmCompleteResult["finishReason"] =
    upstream.stopReason === "max_tokens" ? "max_tokens"
    : upstream.stopReason === "tool_use" ? "tool_use"
    : upstream.stopReason === "error" ? "error"
    : upstream.stopReason === "filtered" ? "filtered"
    : "stop";

  const result: LlmCompleteResult = {
    content: text,
    // We deliberately drop tool-call blocks from the response to avoid
    // double-routing. Extensions that need tool-call orchestration
    // should use their own RPC tier (Phase 4 spawn); ctx.llm is for
    // text-completion calls.
    blocks: [],
    usage: {
      inputTokens,
      outputTokens,
      ...(estCostCents !== undefined ? { estCostCents } : {}),
    },
    finishReason,
    model: upstream.model ?? resolved.model,
  };

  // Audit. The token is NEVER serialized into `before`/`after` —
  // recordCapabilityCall puts everything through `redactForAudit`,
  // and we explicitly never thread the token into either field.
  await recordCapabilityCall({
    ctx: handlerCtx,
    capability: "llm",
    action: "complete",
    before: {
      provider: params.provider,
      model: params.model,
      messageCount: params.messages.length,
      // Include a stable hash of the prompt so the audit row can be
      // correlated to the call without persisting message content.
      promptSha256: hashStable(params.systemPrompt ?? "" + JSON.stringify(params.messages)),
    },
    after: {
      finishReason,
      usage: result.usage,
      model: result.model,
    },
    durationMs: Date.now() - startedAt,
    success: true,
    tokensUsed: inputTokens + outputTokens,
    ...(estCostCents !== undefined ? { costUsd: estCostCents / 100 } : {}),
    provider: params.provider,
    model: result.model,
    insertChatPill: handlerCtx.conversationId !== null,
  });

  return { jsonrpc: "2.0", id: req.id, result };
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function hashStable(s: string): string {
  // Simple FNV-1a so we don't pull in node:crypto for a debug hash.
  // Stable cross-process; not security-critical.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
