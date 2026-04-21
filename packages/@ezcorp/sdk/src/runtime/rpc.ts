// ── JSON-RPC tool-dispatch helpers ──────────────────────────────
//
// Small set of helpers that every extension re-implements by hand. The
// channel (channel.ts) imports the dispatch-registration hook from here,
// so tool authors only need to pass a map of handlers to
// `createToolDispatcher` and the stdin loop does the rest.

import type { ToolCallResult } from "../types";

// ── Tool-result builders ────────────────────────────────────────

/**
 * Build a successful tool result with a single text content block.
 * `meta` keys are merged onto the top-level object (e.g. to attach
 * `cardType` or override `isError`).
 */
export function toolResult(
  text: string,
  meta?: Record<string, unknown>,
): ToolCallResult {
  const base = {
    content: [{ type: "text" as const, text }],
    isError: false,
  };
  if (!meta) return base;
  return { ...base, ...meta } as ToolCallResult;
}

/**
 * Build an error tool result (`isError: true`). The optional `code` is
 * echoed back to the caller as a top-level field; most hosts ignore it
 * but it's useful for pi-agent-core tracing / tests.
 */
export function toolError(message: string, code?: string): ToolCallResult {
  const result: ToolCallResult & { code?: string } = {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
  if (code !== undefined) result.code = code;
  return result;
}

// ── Tool handler signature ──────────────────────────────────────

export type ToolHandler<A = Record<string, unknown>> = (
  args: A,
) => Promise<ToolCallResult> | ToolCallResult;

export interface ToolDispatcherOptions {
  /**
   * Called when a handler throws. Default behavior: wrap the error message
   * in a `toolError(...)`. Returning a `ToolCallResult` lets you customize.
   */
  onError?: (err: unknown, tool: string) => ToolCallResult;
}

// ── Internal registration hook consumed by channel.ts ───────────
//
// The channel holds the stdin/stdout readline loop and is the party that
// actually handles `tools/call` requests. To keep rpc.ts independent of
// channel.ts (so tests can import the builders without opening stdin) we
// expose a registration function the channel calls when it starts.
//
// Contract:
//   - `createToolDispatcher(handlers, opts)` stores the pair via the
//     module-level `_register` callback.
//   - channel.ts sets `_register` once at module-load time and calls it
//     with its own onRequest("tools/call", ...) wiring.

type DispatcherRegistration = {
  handlers: Record<string, ToolHandler>;
  opts?: ToolDispatcherOptions;
};

type RegisterFn = (reg: DispatcherRegistration) => void;

let _register: RegisterFn = () => {
  throw new Error(
    "[@ezcorp/sdk] channel not ready — call getChannel().start() before createToolDispatcher()",
  );
};

/** @internal — channel.ts calls this once at module init. */
export function _setDispatcherRegister(fn: RegisterFn): void {
  _register = fn;
}

/**
 * Register a map of JSON-RPC tool-call handlers. Must be called after the
 * channel has started (task #1). Replaces the hand-rolled switch/case
 * stdin loop pattern used in every example extension.
 */
export function createToolDispatcher(
  handlers: Record<string, ToolHandler>,
  opts?: ToolDispatcherOptions,
): void {
  _register({ handlers, ...(opts ? { opts } : {}) });
}
