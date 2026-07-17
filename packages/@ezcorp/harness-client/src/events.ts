/**
 * Public runtime-event contract for harness consumers.
 *
 * This mirrors the app's canonical list at
 * `web/src/lib/runtime-event-names.ts` — the package can't import the app's
 * source (it ships standalone), so a parity assertion (in `index.test.ts`,
 * "event-name parity with the app") keeps the two in lockstep, and the
 * governance route-contract test cross-checks them in CI. Keep them
 * identical.
 */
export const RUNTIME_EVENT_NAMES = [
  "run:start", "run:status", "run:log", "run:complete", "run:error", "run:cancel",
  "run:token", "run:usage", "run:turn_saved", "run:turn_text_reset",
  "workflow:start", "workflow:step", "workflow:complete", "workflow:error",
  "tool:start", "tool:complete", "tool:error", "tool:permission_request",
  "agent:spawn", "agent:status", "agent:complete",
  "task:snapshot", "task:assignment_update",
  "ask-user:answer",
  "ez:client-tool",
  "ext:state",
  "ext:page-state",
  "extensions:installed",
  "goal:update",
  "conversation:created",
  "conversation:tree-changed",
  "github-projects:proposal-update",
  "loops:approval_pending",
  "loops:approval_resolved",
  "loops:auto_disabled",
] as const;

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];

/** A runtime event as delivered over SSE: `{ type, data }`. */
export interface RuntimeEvent {
  type: RuntimeEventName | (string & {});
  data: Record<string, unknown>;
}
