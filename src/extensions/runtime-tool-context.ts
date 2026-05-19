/**
 * Host-side AsyncLocalStorage for cross-extension call attribution.
 *
 * Phase 4 §M1 — full-chain chained-deputy semantics. When extension A
 * calls extension B's tool via `ezcorp/invoke`, B's `handlePiInvoke`
 * needs to see the upstream `capContext` (the post-intersection cap set
 * authorized at the A→B step), NOT just A's installed grants. Without
 * the upstream view, a chain A → B → C with all `acceptsCallerCaps:
 * true` would silently widen at the B→C step (B's installed grants
 * would slip past A's intersection). The spec at
 * `tasks/phase-4-cross-ext-attribution.md:331` locks in:
 *
 *     A → B → C with acceptsCallerCaps everywhere →
 *     C sees intersect(intersect(A,B), C)
 *
 * To honor that contract without restructuring the JSON-RPC transport,
 * we use a host-process ALS keyed on the per-tool execution scope.
 *
 * The store also carries `currentAuditId`, set by the engine on each
 * authorize() return. When a tool dispatches via `ezcorp/invoke`, the
 * inner authorize() reads it and threads it as `parentAuditId` so the
 * audit trail forms a single chain. The same field is consumed by the
 * spawn-assignment handler so child conversations inherit the spawn's
 * audit row as their root.
 *
 * NOTE: this is the HOST-side ALS. The SDK exposes a separate
 * tool-context ALS (packages/@ezcorp/sdk/src/runtime/tool-context.ts)
 * for in-sandbox handler context propagation. The two stores are
 * intentionally distinct: SDK runs in the subprocess, this runs in the
 * host. They never share data — each side reads its own view of the
 * call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CapabilitySet } from "./capability-types";

export interface RuntimeToolContext {
  /**
   * Effective capability set the upstream engine authorized this call
   * with. When the next `handlePiInvoke` runs inside this scope, it
   * reads this value as the caller's grants — so chained deputies see
   * progressively narrower sets.
   */
  currentCapContext?: CapabilitySet;
  /**
   * Audit row id from the most recent `engine.authorize()` call. The
   * next authorize() in this scope sets `parentAuditId` to it so the
   * audit log captures the chain.
   */
  currentAuditId?: string;
}

const als = new AsyncLocalStorage<RuntimeToolContext>();

/**
 * Wrap `fn` with `ctx` as the active runtime context. Inherits any
 * fields from a surrounding scope that aren't explicitly overridden.
 */
export function withRuntimeToolContext<T>(
  ctx: RuntimeToolContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prior = als.getStore();
  const merged: RuntimeToolContext = {
    ...(prior ?? {}),
    ...ctx,
  };
  return als.run(merged, async () => fn());
}

/**
 * Read the active runtime context, or `undefined` when called outside
 * any `withRuntimeToolContext` scope. Top-level dispatches (LLM tool
 * calls, ezcorp HTTP routes) always see `undefined` — only nested
 * cross-ext invokes see a populated context.
 */
export function getRuntimeToolContext(): RuntimeToolContext | undefined {
  return als.getStore();
}
