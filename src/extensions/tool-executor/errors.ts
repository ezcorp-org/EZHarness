import type { EventBus } from "../../runtime/events";
import type { AgentEvents } from "../../types";
import type { ToolCallResult } from "../types";
import type { CapabilitySet } from "../capability-types";

/**
 * The `ToolExecutor.executeToolCall` call signature, expressed as a standalone
 * type so the leaf modules (`agent-tool`, `invoke`) can accept an
 * executeToolCall-shaped dependency WITHOUT importing the `ToolExecutor` class
 * type from `./executor` — that back-edge would form a type-only import cycle
 * (executor → invoke/agent-tool values; invoke/agent-tool → executor type).
 * Keeping the contract here (a no-cycle leaf) makes the module graph a clean
 * DAG. Assignability of the real method to this type is enforced by tsc at the
 * `invokeHost()` binding site in executor.ts, so it cannot silently drift.
 */
export type ExecuteToolCall = (
  toolName: string,
  input: Record<string, unknown>,
  conversationId: string,
  messageId: string | null,
  _opts?: {
    callerExtensionId?: string;
    _callDepth?: number;
    metadata?: { invocationId?: string; source?: "inline" | "agent-run" };
    /** Phase 4: caller∩callee intersected cap set for cross-ext invokes. */
    capContext?: CapabilitySet;
    /** Phase 1: parent audit row for the chain — set by `handlePiInvoke` etc. */
    parentAuditId?: string;
  },
  invocationMetadata?: Record<string, unknown>,
) => Promise<ToolCallResult>;

/**
 * @deprecated Phase 6 removal. Pre-PDP per-call hook replaced by the
 * `PermissionEngine` injected at `ToolExecutor` construction. The type
 * is retained briefly for any out-of-tree caller that referenced it;
 * production wires the engine directly.
 */
export type PermissionChecker = (
  extensionId: string,
  toolName: string,
  input: Record<string, unknown>,
) => Promise<boolean>;

export class PermissionDeniedError extends Error {
  constructor(
    public readonly extensionId: string,
    public readonly toolName: string,
    public readonly reason?: string,
  ) {
    const detail = reason ? ` — ${reason}` : "";
    super(`Permission denied for tool "${toolName}" from extension "${extensionId}"${detail}`);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Orchestrates tool calls between LLM and extension subprocesses.
 * Every call routes through the `PermissionEngine` (Phase 1 PDP)
 * supplied at construction time. The engine is required — fail-closed
 * by design (closes finding C6).
 */
export type ArgsResolver = (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface ToolExecutorOptions {
  bus?: EventBus<AgentEvents>;
  /** Phase 53.7 — when true, runtime-invoke calls from this executor's
   *  wired subprocesses are treated as event-driven. The conversation-
   *  scope gate (`checkConversationGate` in `runtime-invoke-handler.ts`)
   *  falls back to a `conversation_extensions` wiring lookup when the
   *  strict `currentConversationId` match fails. Used by the boot-spawn
   *  ToolExecutor in `web/src/lib/server/context.ts`; per-turn executors
   *  default to false so cross-extension manual calls keep the strict
   *  gate. */
  eventDriven?: boolean;
}
