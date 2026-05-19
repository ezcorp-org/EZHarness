/**
 * Host-side dispatcher for `runtime.*` `ezcorp/invoke` methods.
 *
 * Phase 53 Stage 1 introduces three new runtime invoke targets that
 * extensions call via `ctx.invoke("runtime.<area>.<verb>", args)`. Each
 * one exposes a tightly-scoped read of host-only state to extensions
 * that legitimately need it (the lessons-distiller is the first
 * consumer):
 *
 *   - `runtime.conversations.getMessages` — returns the conversation's
 *     messages (chronological) plus its `projectId`. The host owns this
 *     query because the SDK's `ctx.lessons.write` needs a projectId and
 *     extensions can't read the `conversations` table directly. Auth is
 *     conversation-scoped AND PER-CALL: `args.conversationId` MUST equal
 *     `ctx.currentConversationId` (the conversation the calling
 *     extension is currently wired into). Without this gate, any
 *     installed extension could read messages from any conversation
 *     across users — `conversation_extensions` wiring is not consulted
 *     by the runtime-invoke dispatch in `tool-executor.ts`.
 *
 *     Phase 53.7 amendment — event-driven path: when `ctx.eventDriven`
 *     is true (boot-spawned event-only extensions whose only entry
 *     point is `run:complete`), the strict `currentConversationId`
 *     check would always fail (the boot executor has no per-turn
 *     conversation context). For that path, the gate falls back to a
 *     `conversation_extensions` wiring lookup keyed on the calling
 *     extension's manifest name — the same trust source the
 *     `EventSubscriptionDispatcher` uses to decide WHICH extensions
 *     receive the event. Manual / per-turn invocations still take the
 *     strict path; the wiring fallback is gated on the explicit flag.
 *
 *   - `runtime.lessons.triggerGate` — runs the heuristics in
 *     `src/runtime/lessons/triggers.ts` against the conversation's
 *     tool-call history and returns `{shouldDistill, reason}`. The
 *     heuristics stay host-side because they read `tool_calls.success`
 *     (privileged data) and need to evolve without forcing extension
 *     version bumps. Same conversationId-must-match-ctx gate as
 *     getMessages — the trigger reasoning exposes recent user-message
 *     texts, error-recovery flags, and user-correction signals. Same
 *     event-driven fallback as `getMessages`.
 *
 *   - `runtime.settings.getMine` — resolves the calling extension's
 *     effective per-extension settings for the acting user. The
 *     `tool-executor` already attaches these to `invocationMetadata`
 *     for tool dispatch; the event-handler path has no per-call ctx,
 *     so this RPC fills the gap. Auth: implicit — uses ctx.extensionId
 *     set by the host (NOT a caller-supplied param), so cross-extension
 *     leakage is structurally impossible.
 *
 * Each method is read-only. No mutation paths are exposed via
 * `runtime.*` — by convention, capability surfaces (`ctx.lessons`,
 * `ctx.memory`, `ctx.llm`) handle writes with their own audit trails.
 *
 * Method-name dispatch is via `runtime.<area>.<verb>` string match.
 * Unknown verbs return JSON-RPC error -32601 (Method not found) so the
 * SDK's `invoke` reject path surfaces a clear message to the caller.
 */

import type { ExtensionPermissions, JsonRpcRequest, JsonRpcResponse } from "./types";
import { getMessages, getConversation } from "../db/queries/conversations";
import { listToolCallsByConversation } from "../db/queries/tool-calls";
import {
  shouldDistill,
  detectErrorRecovery,
  detectExplicitTag,
  detectUserCorrection,
} from "../runtime/lessons/triggers";
import { resolveExtensionSettings } from "../db/queries/extension-settings";
import { isBundledExtensionName } from "./bundled";
import { runCompaction } from "../memory/compaction";
import { dedupAndWriteMemory } from "../memory/dedup";
import { logger } from "../logger";

const log = logger.child("ext.runtime-invoke");

export interface RuntimeInvokeContext {
  /** Calling extension's id (post-resolution). */
  extensionId: string;
  /** Calling extension's manifest name. Used by the bundled-only gate
   *  on `runtime.memory.compact` and `runtime.memory.dedupMemoryWrite`
   *  — those methods are restricted to bundled extensions because they
   *  cross-cut every memory in the user's project. The host fills this
   *  in from the registry; the calling extension cannot spoof it (the
   *  field is NOT read from `args` or `rpcMeta`). Optional only so the
   *  test harness can construct a minimal ctx without a registry. */
  extensionName?: string;
  /** Acting user id, resolved by the host from the per-call rpcMeta.
   *  May be null for system-driven calls (the only `runtime.settings.getMine`
   *  caller in v1 is the `run:complete` listener path). */
  userId: string | null;
  /** The conversation the executor is currently wired into. The
   *  per-method gate for `getMessages` and `triggerGate` requires
   *  `args.conversationId === ctx.currentConversationId`. Null when
   *  the executor has no conversation context (system-driven /
   *  schedule-fired invocations) — those invocations CANNOT call the
   *  conversation-scoped methods (the gate rejects with -32604) UNLESS
   *  `eventDriven` is true and `wiringLookup` is supplied (Phase 53.7). */
  currentConversationId: string | null;
  /** Phase 53.7 — event-driven invocation flag. When true, the
   *  conversation-scope gate falls back to a `conversation_extensions`
   *  wiring lookup if the strict `currentConversationId` match fails.
   *  Set by the boot-spawn `ToolExecutor` instance constructed in
   *  `web/src/lib/server/context.ts`; per-turn executors leave this
   *  false so cross-extension manual calls keep the strict gate. */
  eventDriven?: boolean;
  /** Phase 53.7 — async lookup that returns true iff the calling
   *  extension is wired to `conversationId` via the `conversation_extensions`
   *  table (same source as `EventSubscriptionDispatcher`). Required
   *  whenever `eventDriven` is true; ignored otherwise. The host injects
   *  this from `getConversationExtensionIds` so the gate doesn't have
   *  to import a DB query directly (keeps the handler unit-testable
   *  without a PGlite). */
  wiringLookup?: (conversationId: string, extensionId: string) => Promise<boolean>;
  /** Calling extension's manifest settings schema, used to resolve
   *  effective values without an extra DB roundtrip for the schema
   *  fetch. */
  settingsSchema?: import("./types").SettingsSchema;
  /** Granted permissions block — passed in for symmetry with the other
   *  capability handlers; reserved for future per-method gating (e.g.
   *  if `runtime.conversations.getMessages` ever needs a permission
   *  ceiling beyond conversation-scope auth). */
  granted: ExtensionPermissions;
}

/** Identifies invoke targets this handler owns. The tool-executor
 *  consults this BEFORE the existing `resolveDepTool` lookup so cross-
 *  extension namespaced tools (e.g. `claude-design__tweak_design`) are
 *  unaffected. */
export function isRuntimeInvokeMethod(toolName: string): boolean {
  return toolName.startsWith("runtime.");
}

export async function handleRuntimeInvoke(
  toolName: string,
  args: Record<string, unknown>,
  ctx: RuntimeInvokeContext,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  switch (toolName) {
    case "runtime.conversations.getMessages":
      return handleGetMessages(args, ctx, req);
    case "runtime.lessons.triggerGate":
      return handleTriggerGate(args, ctx, req);
    case "runtime.settings.getMine":
      return handleGetMySettings(ctx, req);
    case "runtime.memory.compact":
      return handleMemoryCompact(args, ctx, req);
    case "runtime.memory.dedupMemoryWrite":
      return handleDedupMemoryWrite(args, ctx, req);
    default:
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: -32601,
          message: `Unknown runtime invoke method: ${toolName}`,
        },
      };
  }
}

/**
 * Per-call conversation-scope gate shared by `getMessages` and
 * `triggerGate`. The two-step check (string-shape, then identity match)
 * yields distinct error codes so callers can branch:
 *
 *   - `-32602` (Invalid params) when `args.conversationId` is missing /
 *     wrong type — caller bug, retry with proper args.
 *   - `-32604` (host extension: not-found / no-access) when the id is
 *     well-formed but doesn't match the executor's wiring. Used here
 *     for the auth gate: a mismatch means "this conversation is not
 *     yours to read", and the same code is reused below for "the
 *     conversation row no longer exists" so callers don't have to
 *     distinguish the two cases (the security-relevant signal is the
 *     same: do not retry, do not log loudly).
 *
 * `ctx.currentConversationId === null` (system-driven invocations,
 * schedule-fired extensions) rejects on the strict path. Phase 53.7
 * adds the EVENT-DRIVEN fallback: when `ctx.eventDriven === true` AND
 * `ctx.wiringLookup` is supplied, a strict-path failure consults
 * `wiringLookup(conversationId, extensionId)` — the same
 * `conversation_extensions` source the `EventSubscriptionDispatcher`
 * uses to decide WHICH extensions receive the event in the first
 * place. If the wiring confirms the extension is bound to the
 * conversation, the call passes; otherwise -32604 is preserved.
 *
 * The fallback is GATED on the explicit `eventDriven` flag so manual /
 * per-turn invocations still get the strict gate. If a legitimate
 * cross-conversation read use case shows up outside the event-driven
 * path, surface it as a new RPC with its own auth gate — do NOT widen
 * this one.
 */
async function checkConversationGate(
  args: Record<string, unknown>,
  ctx: RuntimeInvokeContext,
  req: JsonRpcRequest,
): Promise<{ ok: true; conversationId: string } | { ok: false; response: JsonRpcResponse }> {
  const conversationId = args.conversationId;
  if (typeof conversationId !== "string" || !conversationId) {
    return {
      ok: false,
      response: {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32602, message: "conversationId required" },
      },
    };
  }
  // Strict path — manual / per-turn invocation: the calling extension's
  // conversation context must equal the requested id.
  const strictOk =
    ctx.currentConversationId !== null &&
    conversationId === ctx.currentConversationId;
  if (strictOk) {
    return { ok: true, conversationId };
  }
  // Phase 53.7 — event-driven fallback. When the strict gate fails on
  // the boot-spawn path (currentConversationId is null because the boot
  // executor has no per-turn context) AND the host opted into the
  // wiring fallback, consult `conversation_extensions`. A wiring hit
  // proves the dispatcher would have delivered the corresponding
  // `run:complete` event to this extension, so reading that
  // conversation's messages is no broader an exposure than the event
  // payload itself.
  if (ctx.eventDriven === true && typeof ctx.wiringLookup === "function") {
    let wired = false;
    try {
      wired = await ctx.wiringLookup(conversationId, ctx.extensionId);
    } catch (err) {
      log.warn("event-driven wiringLookup threw", {
        conversationId,
        extensionId: ctx.extensionId,
        error: String(err),
      });
      wired = false;
    }
    if (wired) {
      return { ok: true, conversationId };
    }
  }
  // Match the wording the SDK surfaces verbatim — the test suite
  // asserts on the message string, and the same wording is reused
  // for the "not found" branch below.
  return {
    ok: false,
    response: {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32604,
        message: "conversationId must match current conversation",
      },
    },
  };
}

async function handleGetMessages(
  args: Record<string, unknown>,
  ctx: RuntimeInvokeContext,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const gate = await checkConversationGate(args, ctx, req);
  if (!gate.ok) return gate.response;
  const { conversationId } = gate;

  // Single round-trip: fetch the conversation row (for projectId) and
  // its messages. Both are needed by the lessons-distiller for the
  // `lessons.write` projectId and the LLM input slice.
  //
  // Distinguish "conversation not found" (row deleted, returns null) from
  // "DB error" (driver throws): not-found returns -32604 so callers can
  // silent-skip (matches the wiring-mismatch code above — the conversation
  // is unreachable to this caller in either case), while DB errors
  // surface as -32603 so callers log + propagate. Pre-fix this branch
  // swallowed the error and returned a `projectId: null` envelope, which
  // looked indistinguishable from a legit projectless conversation.
  let projectId: string | null = null;
  try {
    const conversation = await getConversation(conversationId);
    if (!conversation) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32604, message: "conversation not found" },
      };
    }
    projectId = conversation.projectId ?? null;
  } catch (err) {
    log.warn("getConversation threw", { conversationId, error: String(err) });
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32603,
        message: `getConversation failed: ${(err as Error).message}`,
      },
    };
  }

  let messages: { id: string; role: string; content: string }[];
  try {
    const rows = await getMessages(conversationId);
    messages = rows.map((m) => ({
      id: m.id,
      role: m.role,
      // `content` is text on chat messages; cast covers the union with
      // structured assistant blocks (the legacy distiller handles those
      // via `String(content)` implicitly through the join).
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }));
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32603, message: `getMessages failed: ${(err as Error).message}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { messages, projectId },
  };
}

async function handleTriggerGate(
  args: Record<string, unknown>,
  ctx: RuntimeInvokeContext,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const gate = await checkConversationGate(args, ctx, req);
  if (!gate.ok) return gate.response;
  const { conversationId } = gate;

  // Mirror the legacy `runDistillation` trigger-gate body verbatim
  // (src/runtime/lessons/distiller.ts:256-272). `triggers.ts` stays
  // host-side because the heuristics need privileged signals
  // (`tool_calls.success`, `messages.role` for user-message tokens)
  // that aren't safe to expose to extensions wholesale.
  let toolCallRows: Awaited<ReturnType<typeof listToolCallsByConversation>>;
  let messages: Awaited<ReturnType<typeof getMessages>>;
  try {
    toolCallRows = await listToolCallsByConversation(conversationId);
    messages = await getMessages(conversationId);
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32603, message: `triggerGate read failed: ${(err as Error).message}` },
    };
  }

  // Only consider the last 20 messages (matches the legacy slice) for
  // user-text scans — the same window the LLM eventually sees.
  const recent = messages.slice(-20);
  const userMessageTexts = recent
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : String(m.content ?? "")));

  const triggerInput = {
    toolCallCount: toolCallRows.length,
    errorRecoveryObserved: detectErrorRecovery(
      toolCallRows.map((r) => ({ status: r.success ? "ok" as const : "error" as const })),
    ),
    userCorrectionObserved: detectUserCorrection(userMessageTexts),
    explicitlyTagged: detectExplicitTag(userMessageTexts),
  };
  const fire = shouldDistill(triggerInput);
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: {
      shouldDistill: fire,
      reason: fire
        ? "trigger-fired"
        : `no-signal (toolCalls=${triggerInput.toolCallCount}, errorRecovery=${triggerInput.errorRecoveryObserved}, userCorrection=${triggerInput.userCorrectionObserved}, tagged=${triggerInput.explicitlyTagged})`,
    },
  };
}

async function handleGetMySettings(
  ctx: RuntimeInvokeContext,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  // No user → return declared defaults. Mirrors the
  // `resolveExtensionSettings(extensionId, null, schema)` contract.
  let resolved: Record<string, unknown>;
  try {
    resolved = await resolveExtensionSettings(
      ctx.extensionId,
      ctx.userId,
      ctx.settingsSchema,
    );
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32603, message: `settings resolve failed: ${(err as Error).message}` },
    };
  }
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: resolved,
  };
}

// ── Phase 53.4 — bundled-only memory invoke methods ────────────────
//
// `runtime.memory.compact` triggers the host's decay/merge sweep. The
// host owns this because compaction is cross-extension by design (it
// merges memories regardless of which extension authored them) — an
// extension cannot dedup against memories it can't see, so the same
// boundary applies to the compaction sweep.
//
// `runtime.memory.dedupMemoryWrite` is a pre-insert dedup check. The
// host's `ezcorp/memory write` action already runs through this helper
// before insert; this RPC exists for symmetry / future extension use
// (e.g. an extension running its own pipeline that wants the
// host-blessed dedup decision before deciding what to write).
//
// Both methods are restricted to BUNDLED extensions. The
// `selfOnly: false` exception that the memory-extractor needs is the
// same trust boundary that gates these RPCs — only code shipping in
// the EZCorp repo can call them. User-installed extensions get
// -32604 (host extension: not-found / no-access). The check is on
// `ctx.extensionName` (host-stamped from the registry), not on a
// param; spoofing is structurally impossible.

function checkBundledOnly(
  ctx: RuntimeInvokeContext,
  req: JsonRpcRequest,
  methodName: string,
): JsonRpcResponse | null {
  if (!ctx.extensionName || !isBundledExtensionName(ctx.extensionName)) {
    log.warn("non-bundled extension attempted bundled-only runtime invoke", {
      method: methodName,
      extensionId: ctx.extensionId,
      extensionName: ctx.extensionName ?? "<unknown>",
    });
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32604,
        message: `${methodName} is restricted to bundled extensions`,
      },
    };
  }
  return null;
}

async function handleMemoryCompact(
  args: Record<string, unknown>,
  ctx: RuntimeInvokeContext,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const denied = checkBundledOnly(ctx, req, "runtime.memory.compact");
  if (denied) return denied;

  // `projectId` is optional — undefined means "compact across every
  // project this server hosts" (matches `runCompaction()`'s legacy
  // signature). When supplied, the value MUST be a string.
  const projectIdRaw = args.projectId;
  let projectId: string | undefined;
  if (projectIdRaw !== undefined) {
    if (typeof projectIdRaw !== "string" || !projectIdRaw) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32602, message: "projectId must be a non-empty string when provided" },
      };
    }
    projectId = projectIdRaw;
  }

  let mergedCount: number;
  try {
    mergedCount = await runCompaction(projectId);
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32603, message: `compaction failed: ${(err as Error).message}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { mergedCount },
  };
}

async function handleDedupMemoryWrite(
  args: Record<string, unknown>,
  ctx: RuntimeInvokeContext,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const denied = checkBundledOnly(ctx, req, "runtime.memory.dedupMemoryWrite");
  if (denied) return denied;

  // Minimal arg validation — the helper itself rejects bad shapes.
  const {
    content,
    category,
    confidence,
    sourceMessageIds,
    conversationId,
    projectId,
    extensionId,
    injectionEligible,
  } = args as Record<string, unknown>;

  if (typeof content !== "string" || !content) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: "content must be a non-empty string" },
    };
  }
  if (
    typeof category !== "string" ||
    !["preferences", "biographical", "technical", "decisions_goals"].includes(category)
  ) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32602,
        message:
          "category must be one of preferences|biographical|technical|decisions_goals",
      },
    };
  }
  if (typeof conversationId !== "string" || !conversationId) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: "conversationId must be a non-empty string" },
    };
  }

  let result: Awaited<ReturnType<typeof dedupAndWriteMemory>>;
  try {
    result = await dedupAndWriteMemory({
      fact: {
        content,
        category: category as "preferences" | "biographical" | "technical" | "decisions_goals",
        confidence: (typeof confidence === "string" ? confidence : "medium") as
          | "high"
          | "medium"
          | "low",
        messageIds: Array.isArray(sourceMessageIds)
          ? (sourceMessageIds.filter((s) => typeof s === "string") as string[])
          : [],
      },
      conversationId,
      projectId: typeof projectId === "string" ? projectId : null,
      provenanceFactory: (action, fact, convId) => ({
        sourceConversationId: convId,
        sourceMessageIds: fact.messageIds ?? [],
        extractedAt: new Date(),
        confidence: fact.confidence ?? "medium",
        history: [
          { action, timestamp: new Date(), reason: "Extracted via runtime.memory.dedupMemoryWrite" },
        ],
        // Stamp extension provenance so the bundled extractor's writes
        // are distinguishable from the legacy pipeline's. Caller
        // supplies the ext id; the bundled-only gate above means it's
        // host-trusted.
        ...(typeof extensionId === "string" ? { extensionId } : {}),
        ...(typeof injectionEligible === "boolean" ? { injectionEligible } : {}),
      }),
    });
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32603, message: `dedupMemoryWrite failed: ${(err as Error).message}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    result,
  };
}
