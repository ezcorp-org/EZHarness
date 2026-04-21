// ── invoke — reverse RPC to call another extension's tool ───────
//
// Wraps the `ezcorp/invoke` JSON-RPC method. The host (see
// src/extensions/tool-executor.ts handlePiInvoke) routes the call
// through the dep-resolution table and returns the raw
// `ToolCallResult`. A protocol error from the host (dep not declared,
// depth exceeded, unknown tool) rejects the promise with the host's
// error message.

import { getChannel } from "./channel";

export interface InvokeOptions {
  /**
   * Per-call timeout override. 0 or negative disables the timeout.
   * Defaults to the channel's 30s timeout.
   */
  timeoutMs?: number;
}

/**
 * Invoke another extension's tool over the `ezcorp/invoke` reverse RPC.
 *
 * The returned value is whatever the target tool resolves — typically
 * a `ToolCallResult`, but any JSON-serialisable value is passed
 * through. Callers who need type narrowing should supply the generic
 * parameter.
 */
export async function invoke<T = unknown>(
  toolName: string,
  args: Record<string, unknown>,
  opts?: InvokeOptions,
): Promise<T> {
  const timeoutMs = opts?.timeoutMs;
  return getChannel().request<T>(
    "ezcorp/invoke",
    { tool: toolName, arguments: args },
    timeoutMs,
  );
}
