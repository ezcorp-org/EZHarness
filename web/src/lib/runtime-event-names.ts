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
  // Sessions P4 rewind/checkpoint: the conversation's message tree / durable
  // leaf pointer changed (conversation-scoped). Content-free nudge → client
  // re-fetches GET /api/conversations/:id/tree.
  "conversation:tree-changed",
  // github-projects integration: a proposal was created/decided/finished —
  // a content-free Hub-refresh nudge (mirrors `ext:page-state`). Scoped to
  // the proposal's project; the poller daemon + approve/dismiss API routes
  // emit it so the Hub re-fetches.
  "github-projects:proposal-update",
  // Loops EZ Mode Phase 2: a loop run parked awaiting approval / was resolved.
  // Content-free invalidation nudges — the approval inbox/badge re-fetches the
  // authorized dashboard (GET is source of truth). Optional conversation
  // scope; global loops broadcast.
  "loops:approval_pending",
  "loops:approval_resolved",
  // Loop auto-disabled after N consecutive errors — a user-visible notice
  // (never a silent stop).
  "loops:auto_disabled",
] as const;

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];
