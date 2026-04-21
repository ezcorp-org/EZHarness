// ── registerLifecycleHook — typed wrapper over channel.onRequest ─
//
// Mirrors the allowed-hook set from
// src/extensions/lifecycle-dispatcher.ts ALLOWED_LIFECYCLE_HOOKS.
// Restricting to those strings via the `LifecycleEvent` union lets
// TypeScript catch typos at compile time; unknown hook names at
// runtime (host sending `lifecycle/<unknown>`) still surface via the
// channel as a -32601 method-not-found.

import { getChannel } from "./channel";

export type LifecycleEvent =
  | "agent:spawn"
  | "agent:complete"
  | "run:start"
  | "run:complete";

/**
 * Register a handler for a lifecycle hook delivered by the host.
 * The handler returns `void` / `Promise<void>` — lifecycle hooks are
 * notification-style and the host ignores the return value.
 */
export function registerLifecycleHook(
  event: LifecycleEvent,
  handler: (params: unknown) => Promise<void> | void,
): void {
  getChannel().onRequest(`lifecycle/${event}`, handler);
}
