// ── Per-tool-call context via AsyncLocalStorage ─────────────────
//
// First use of `node:async_hooks` in this codebase. Day-1 sanity test
// (run before this file landed) confirmed Bun propagates ALS context
// across `await Promise.resolve()`, `setTimeout`, and concurrent
// `als.run(...)` calls — see commit message.
//
// Phase 2 use case: the in-sandbox `globalThis.fetch` wrapper installed
// by `src/extensions/runtime/sandbox-preload.ts` reads the running tool's
// name to enforce per-tool host allowlists (`EZCORP_TOOL_NETWORK_CAPS`).
// The SDK's `tools/call` dispatcher (channel.ts) wraps every tool
// handler with `withToolContext` so the wrapper always sees the active
// tool when an extension makes a network call from inside a handler.
//
// Phase 4 will reuse `callerExtensionId` for cross-extension attribution
// (intersect caps when ext A invokes ext B's tool through `ezcorp/invoke`).

import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolContext {
  /** Tool name as the host dispatched it (post-namespace, e.g. `search`). */
  toolName: string;
  /** Conversation id forwarded by the host on `_meta.ezConversationId`. */
  conversationId: string;
  /**
   * Reserved for Phase 4 cross-extension attribution. When extension A
   * calls extension B's tool via `ezcorp/invoke`, the host records A's
   * id here so B's wrapper enforcement can compute the post-intersection
   * cap set. Phase 2 leaves this undefined — the field exists so we
   * don't break the type contract when Phase 4 wires it up.
   */
  callerExtensionId?: string;
}

const als = new AsyncLocalStorage<ToolContext>();

/**
 * Run `fn` with `ctx` bound as the active tool context. ALS propagates
 * the context across every `await` inside `fn` so handlers that call
 * `getToolContext()` from any depth see the same value.
 *
 * Concurrent `withToolContext` calls are isolated — see
 * tool-context.test.ts for the matrix.
 */
export function withToolContext<T>(
  ctx: ToolContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  // Wrap the synchronous return path in `Promise.resolve` so callers can
  // pass either an async or a sync handler. The ALS contract is
  // identical for both.
  return als.run(ctx, async () => fn());
}

/**
 * Read the active tool context, or `undefined` when called outside any
 * `withToolContext` scope (e.g. at module-load time, before the first
 * tool dispatch). The fetch wrapper treats `undefined` as "no per-tool
 * override, fall back to extension-wide allowlist only".
 */
export function getToolContext(): ToolContext | undefined {
  return als.getStore();
}
