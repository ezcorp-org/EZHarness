/**
 * Canonical client-facing runtime event names — the SINGLE source from
 * which both the server SSE endpoint (`BUS_EVENTS`) and the browser SSE
 * consumer (`ws.ts`'s `WSRunEvent`) derive. Previously this list was
 * duplicated in those two places (and would have been a third time in the
 * harness client). A curated subset of the backend `AgentEvents` payload
 * map (`src/types.ts`) — server-only events (e.g. `obs:turn`,
 * `briefing:delivered`) are intentionally excluded.
 *
 * Pure data (no imports) so it is safe to import from server route code,
 * client lib code, and the standalone harness-client package alike.
 */
export const RUNTIME_EVENT_NAMES = [
  "run:start", "run:status", "run:log", "run:complete", "run:error", "run:cancel",
  "run:token", "run:usage", "run:turn_saved", "run:turn_text_reset",
  "pipeline:start", "pipeline:step", "pipeline:complete", "pipeline:error",
  "tool:start", "tool:complete", "tool:error", "tool:permission_request",
  "agent:spawn", "agent:status", "agent:complete",
  "task:snapshot", "task:assignment_update",
  "ask-user:answer",
  // Ez concierge client-side tool delivery (fill_form / navigate_to).
  "ez:client-tool",
  "ext:state",
  // Extension Pages Hub: content-free page invalidation signal.
  "ext:page-state",
  // User-scoped live Library refresh (install).
  "extensions:installed",
  // /goal autopilot indicator (conversation-scoped).
  "goal:update",
  // Daily Briefing: server-initiated conversation delivery (user-scoped).
  "conversation:created",
] as const;

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];
