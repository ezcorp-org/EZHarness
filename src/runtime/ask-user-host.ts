// Host-side helpers for the `ask-user` bundled extension.
//
// Mirrors the `orchestration-host.ts` / `task-tracking-host.ts` shape so
// the setup-tools call site is a one-liner. Two exports:
//   • `ensureAskUserWired(conversationId)` — idempotent insert into
//     `conversation_extensions`. Auto-wire-every-turn pattern (NOT
//     wire-on-first-use): the LLM cannot bootstrap a tool whose own
//     use is required to wire it, so this call must happen on every
//     turn before the tool-loading phase resolves.
//   • `wireAskUserToolForTurn(params)` — appends the extension's
//     `ask_user_question` tool to the per-turn `agentTools` list with
//     `invocationMetadata: { conversationId }`. The per-call seam in
//     `extensionToAgentTool` (`src/extensions/tool-executor.ts`) merges
//     `toolCallId` into that metadata at invoke time, so the
//     extension handler receives BOTH fields on `ctx.invocationMetadata`.
//
// No per-turn schema override (the schema is static) — `schemaOverride`
// is omitted from the `extensionToAgentTool` call. Mirrors `ask_human`
// in `orchestration-host.ts:300-318`.

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getDb } from "../db/connection";
import { conversationExtensions } from "../db/schema";
import { getExtensionByName } from "../db/queries/extensions";
import type { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor, extensionToAgentTool } from "../extensions/tool-executor";
import type { EventBus } from "./events";
import type { AgentEvents } from "../types";
import { logger } from "../logger";
import { registerPendingAskUser, clearPendingAskUser } from "./ask-user-registry";
const log = logger.child("ask-user-host");

// ── Extension-id resolution (cached) ────────────────────────────────

let cachedExtId: string | undefined;

/**
 * Resolve the installed `ask-user` extension's DB id. Cached
 * module-local after the first hit; resets on a fresh process only.
 * Returns `undefined` if the extension isn't installed — a misconfigured
 * boot skips ask-user wiring for the turn rather than killing the run.
 */
async function getAskUserExtensionId(): Promise<string | undefined> {
  if (cachedExtId) return cachedExtId;
  const row = await getExtensionByName("ask-user");
  if (!row) return undefined;
  cachedExtId = row.id;
  return cachedExtId;
}

/** Test-only: clear the cached extension id so mocks re-resolve. */
export function _resetAskUserExtensionIdCache(): void {
  cachedExtId = undefined;
}

// ── Wiring helpers ──────────────────────────────────────────────────

/**
 * Ensure the ask-user extension is wired to the given conversation.
 * Idempotent via the existing `UNIQUE(conversation_id, extension_id)`
 * constraint on `conversation_extensions`.
 *
 * Returns `true` when the row exists after the call (fresh or already
 * wired) and `false` on catastrophic failure (extension missing, insert
 * throws with something other than a unique-constraint collision).
 * Callers use the return value to decide whether to skip wiring for
 * the current turn.
 */
export async function ensureAskUserWired(
  conversationId: string,
): Promise<boolean> {
  let extId: string | undefined;
  try {
    extId = await getAskUserExtensionId();
  } catch (err) {
    log.warn("Failed to resolve ask-user extension id", { error: String(err) });
    return false;
  }
  if (!extId) {
    log.warn("ask-user extension not installed — did ensureBundledExtensions() run?");
    return false;
  }

  try {
    const db = getDb();
    await db
      .insert(conversationExtensions)
      .values({ conversationId, extensionId: extId })
      .onConflictDoNothing();
    return true;
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (/unique|duplicate/i.test(msg)) return true;
    log.warn("Failed to insert conversation_extensions row for ask-user", {
      conversationId,
      error: msg,
    });
    return false;
  }
}

export interface WireAskUserToolParams {
  agentTools: AgentTool[];
  conversationId: string;
  runId: string;
  registry: ExtensionRegistry;
  bus?: EventBus<AgentEvents>;
  /** Acting-user id (forwarded to the ToolExecutor for storage scope /
   *  on-behalf-of headers). May be omitted in test contexts. */
  userId?: string;
}

/**
 * Append the ask-user extension's `ask_user_question` tool to the per-turn
 * `agentTools` list, wired with `invocationMetadata: { conversationId }`
 * so the handler receives the conversationId via `ctx.invocationMetadata`.
 * The per-call seam in `extensionToAgentTool` adds `toolCallId` to that
 * metadata at invoke time — the handler reads both.
 *
 * Idempotent guard: if a tool named `ask_user_question` is already in
 * `agentTools` (e.g. another wire-block already pushed it), this is a
 * no-op. That guards against the dedup check in setup-tools.ts's
 * generic `convExtIds` loop double-wiring the same tool with different
 * metadata.
 */
export async function wireAskUserToolForTurn(
  params: WireAskUserToolParams,
): Promise<void> {
  const { agentTools, conversationId, runId, registry, bus, userId } = params;

  // Dedup guard: the convExtIds loop in setup-tools.ts also wires
  // every tool from a `conversation_extensions` row. Match against
  // BOTH the namespaced form (what the registry exposes) and the
  // bare `ask_user_question` (defensive, in case a future change
  // exposes the originalName too).
  if (agentTools.some((t) => t.name === "ask-user__ask_user_question" || t.name === "ask_user_question")) return;

  const extId = await getAskUserExtensionId();
  if (!extId) {
    log.warn("ask-user extension not installed — skipping wire for turn", {
      conversationId, runId,
    });
    return;
  }

  const registeredTools = registry.getToolsForExtension(extId);
  const askTool = registeredTools.find((t) => t.originalName === "ask_user_question");
  if (!askTool) {
    log.warn(
      "ask-user extension has no ask_user_question tool registered — registry not loaded?",
      { conversationId, runId, extId },
    );
    return;
  }

  const toolExec = new ToolExecutor(registry, bus ? { bus } : undefined);
  if (userId) toolExec.setCurrentUserId(userId);

  // Per-turn invocationMetadata. `toolCallId` is added by
  // extensionToAgentTool's per-call seam; we only seed `conversationId`
  // here because the handler needs both fields, but only conversationId
  // is known at wire time.
  const invocationMetadata: Record<string, unknown> = { conversationId };

  // Use the registry's NAMESPACED name (`ask-user__ask_user_question`).
  // The registry's `toolMap` is keyed on the namespaced form (see
  // src/extensions/registry.ts:222) — passing `originalName` would
  // make the wrapper call `executeToolCall("ask_user_question", ...)`
  // and the registry lookup at `tool-executor.ts:182` would return
  // null, surfacing as "Unknown tool: ask_user_question". The LLM
  // sees the namespaced form too, which matches the convention every
  // other auto-wired extension tool (scratchpad__*, task_*) uses.
  const wrapped = extensionToAgentTool(
    {
      name: askTool.name,
      description: askTool.description,
      inputSchema: askTool.inputSchema as Record<string, unknown>,
    },
    toolExec,
    conversationId,
    runId,
    undefined,
    invocationMetadata,
  );

  // Wrap `execute` to populate the host-side `ask-user-registry` for
  // the duration of the gate. The POST endpoint at
  // `/api/ask-user/answer/+server.ts` reads from that registry to
  // resolve `toolCallId → conversationId` (and authorize the acting
  // user) WITHOUT needing the `tool_calls` DB row to exist — which it
  // doesn't yet, because the row is only persisted after the
  // subprocess returns, and the subprocess won't return until the
  // user answers. See `ask-user-registry.ts` for the full rationale.
  const userIdForRegistry = userId ?? null;
  const originalExecute = wrapped.execute;
  wrapped.execute = async (toolCallId, params, signal) => {
    // Capture the LLM-supplied prompt so the GET active-run endpoint
    // can re-hydrate the inline question card on a refreshed client.
    const input = (params ?? {}) as { question?: unknown; options?: unknown };
    const question = typeof input.question === "string" ? input.question : undefined;
    const options = Array.isArray(input.options)
      ? input.options.filter((o): o is string => typeof o === "string")
      : undefined;
    registerPendingAskUser(toolCallId, conversationId, userIdForRegistry, {
      question,
      options,
    });
    try {
      return await originalExecute(toolCallId, params, signal);
    } finally {
      clearPendingAskUser(toolCallId);
    }
  };

  agentTools.push(wrapped);
}
