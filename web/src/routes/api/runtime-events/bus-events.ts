/**
 * The runtime-bus event names the SSE endpoint (`./+server.ts`) forwards
 * to browser clients. Kept in its own module (SvelteKit rejects non-handler
 * exports from `+server.ts`) so tests can import the REAL subscription list
 * — an event the runtime emits but that is missing here silently never
 * reaches a production client (the e2e mock emitter bypasses this pipe),
 * which is exactly the failure mode the regression test guards against.
 */
export const BUS_EVENTS = [
  "run:start", "run:status", "run:log", "run:complete", "run:error", "run:cancel",
  "run:token", "run:usage", "run:turn_saved", "run:turn_text_reset",
  "pipeline:start", "pipeline:step", "pipeline:complete", "pipeline:error",
  "tool:start", "tool:complete", "tool:error", "tool:permission_request",
  "agent:spawn", "agent:status", "agent:complete",
  "task:snapshot", "task:assignment_update",
  "ask-user:answer",
  // Ez concierge client-side tool delivery (Phase 48 Wave 3). The
  // runtime emits this when the LLM calls fill_form / navigate_to;
  // EzPanel intercepts the event and dispatches the resolution to
  // the page-registered handler / SvelteKit goto. Filtered per
  // subscriber by conversationId via shouldDeliverEvent.
  "ez:client-tool",
  "ext:state",
  // agent-install-ux-polish Phase 2 (D3): user-scoped live Library
  // refresh signal. Subscribed here so the bus event reaches the SSE
  // pipe; `shouldDeliverEvent`'s dedicated userId branch (fail-closed)
  // enforces single-user delivery — it is NOT conversation-scoped.
  "extensions:installed",
  // /goal Phase 2 (FR-20, D7): conversation-scoped autopilot
  // indicator. The goal-host emits this on every state transition
  // (arm, evaluator update, pause, achieve, clear); the direct-carrier
  // filter routes it per subscriber by the payload's top-level
  // `conversationId`, so user A's chip never updates from user B's
  // armed conversation.
  "goal:update",
  // Daily Briefing Phase 2: server-initiated conversation delivery.
  // The briefing runner (src/runtime/briefing/run.ts) emits this after
  // minting the briefing conversation; `shouldDeliverEvent`'s userId
  // branch (fail-closed) scopes it to the owning user, and the client's
  // global subscriber marks it unread + live-refreshes the sidebar.
  "conversation:created",
] as const;
