/**
 * Dispatch surface for workflow `kind: "tool"` steps.
 *
 * A tool step runs a real extension tool through the host's ONE tool
 * dispatch path (`ToolExecutor.executeToolCall`) so it goes through the
 * identical PDP authorization, capability gate, audit row and provenance
 * plumbing a chat-driven tool call does. This module exists purely to
 * (a) name the narrow slice of `ToolExecutor` a workflow needs, so
 * `workflow-executor.ts` can be unit-tested against a fake, and (b) own
 * the cold-start construction of the real one in a single place.
 */
import { ExtensionRegistry } from "../extensions/registry";
import { getPermissionEngine } from "../extensions/permission-engine";
import { ToolExecutor } from "../extensions/tool-executor";
import type { ToolCallResult } from "../extensions/types";
import type { EventBus } from "./events";
import type { AgentEvents } from "../types";

/**
 * The slice of `ToolExecutor` a workflow tool step uses. Structural, so
 * the real `ToolExecutor` satisfies it without an `implements` clause
 * and tests can supply a two-method fake.
 */
export interface WorkflowToolRunner {
  /**
   * Bind the acting principal for this dispatch. Load-bearing, not
   * cosmetic: without it `registerCallProvenance` marks the call
   * `ownerless`, every reverse-RPC the tool makes soft-fails -32106, and
   * user-scoped extension storage resolves to no bucket at all.
   */
  setCurrentUserId(userId: string): void;
  /**
   * Pin the conversation coordinate a nested reverse-RPC will inherit.
   * Optional so a minimal test double need not implement it, but the
   * real `ToolExecutor` does: `handlePiInvoke` reads
   * `host.currentConversationId` and falls back to a synthetic
   * `cross-ext-<reqId>` when it is unset. That synthetic is a key no
   * non-interactive scope claims, so a gate raised against it used to
   * park — hanging the workflow that was awaiting the outer call.
   */
  setCurrentConversationId?(conversationId: string): void;
  executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    conversationId: string,
    messageId: string | null,
  ): Promise<ToolCallResult>;
}

/** Factory shape the executor injects; see `WorkflowExecutorOptions`. */
export type WorkflowToolRunnerFactory = () => WorkflowToolRunner;

/**
 * Build the production runner: the process-wide extension registry + the
 * PDP singleton + a fresh `ToolExecutor` bound to the workflow bus.
 *
 * Deps are passed to `getPermissionEngine` so a workflow fired before any
 * chat turn (the cold-start case — a scheduled or CLI run) initialises
 * the singleton instead of throwing "not initialized". If another path
 * already built it, the deps are ignored and the existing instance is
 * returned; the factory has no race-sensitive state. Same pattern as the
 * EZ-action forwarder (`web/src/routes/api/ez-actions/[name]/+server.ts`).
 */
export function createWorkflowToolRunner(
  bus: EventBus<AgentEvents>,
): WorkflowToolRunner {
  const registry = ExtensionRegistry.getInstance();
  const engine = getPermissionEngine({
    registry,
    bus,
    db: { _token: "workflow-tool-step" },
  });
  return new ToolExecutor(registry, engine, { bus });
}
