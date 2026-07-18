import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ExecuteToolCall } from "./errors";

/**
 * Wraps a pi extension tool definition + ToolExecutor into an AgentTool
 * compatible with pi-agent-core's Agent class.
 *
 * Uses Type.Unsafe() to bridge JSON Schema (from extension manifests) to
 * TypeBox schemas (required by AgentTool.parameters).
 *
 * Optional Phase 4 args (§5.1a) — back-compat with 4-arg callers:
 *  - `schemaOverride`: when set, replaces `extTool.inputSchema` in the
 *    wrapper's `parameters`. Used by the orchestration extension to inject
 *    a turn-specific enum of available agent ids.
 *  - `invocationMetadata`: opaque per-turn data closed over by the wrapper
 *    and forwarded as a trailing arg to `toolExecutor.executeToolCall`,
 *    which surfaces it to the subprocess via the JSON-RPC `_meta` channel.
 */
export function extensionToAgentTool(
  extTool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /** Optional DISPATCH key, decoupled from the LLM-visible `name`. The
     *  registry's `toolMap` is keyed by the NAMESPACED name
     *  (`<ext>__<tool>`), but some callers want the LLM to see the BARE
     *  `originalName` (orchestration's `invoke_agent` — subscribe-bridge
     *  event-suppression, auto-spin-up, and the ORCHESTRATION_TOOLS filter
     *  all key on the bare AgentTool name). Those callers keep `name` bare
     *  and set `dispatchName` to the namespaced `registered.name` so
     *  `executeToolCall` resolves the tool instead of returning "Unknown
     *  tool". When absent, dispatch falls back to `name` (the common case —
     *  every caller that already passes the namespaced name is unaffected). */
    dispatchName?: string;
  },
  toolExecutor: { executeToolCall: ExecuteToolCall },
  conversationId: string,
  messageId: string,
  schemaOverride?: Record<string, unknown>,
  invocationMetadata?: Record<string, unknown>,
): AgentTool {
  // Dispatch key: prefer the explicit `dispatchName` (namespaced registry
  // key) over the LLM-visible `name`. Keeps the bare name in the model's
  // toolset while routing `executeToolCall` → `getRegisteredTool` to the
  // real (namespaced) toolMap entry.
  const dispatchName = extTool.dispatchName ?? extTool.name;
  return {
    name: extTool.name,
    label: extTool.name,
    description: extTool.description,
    parameters: Type.Unsafe(schemaOverride ?? extTool.inputSchema),
    execute: async (toolCallId, params, _signal) => {
      // Per-call merge: thread the host-minted `toolCallId` into the
      // invocation metadata so handlers can use it as a stable gate
      // key (e.g. `ask-user`'s pending-answer map). Additive —
      // extensions that don't read the field ignore it.
      const callMetadata = { ...invocationMetadata, toolCallId };
      // Pass `toolCallId` as `invocationId` on the `tool:start` bus
      // event too, so the chat UI's tool-card stream (stores.svelte.ts
      // `case "tool:start"`) can correlate this call with later
      // tool:complete / tool:error events. Without this the executor's
      // own emit at `executeToolCall` would carry no invocationId,
      // forcing the UI to depend on the parallel pi-agent stream emit
      // — which carries no `cardType`, breaking specialized cards
      // like AskUserQuestionCard.
      const result = await toolExecutor.executeToolCall(
        dispatchName, params as Record<string, unknown>, conversationId, messageId,
        { metadata: { invocationId: toolCallId } }, callMetadata,
      );
      return {
        content: result.content.map(c => ({ type: "text" as const, text: c.text })),
        details: { isError: result.isError },
      };
    },
  };
}
