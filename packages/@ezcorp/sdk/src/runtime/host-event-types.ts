// ── Host event payload shapes — Phase 2c subscribable subset ────────
//
// Structural copy of the 13 direct-carrier bus events that extensions
// can subscribe to via the `eventSubscriptions` manifest field. The
// canonical definitions live in `src/types.ts#AgentEvents` on the host
// side — this file re-exports a NARROW, SDK-facing shape so an
// extension author doesn't need to import the full host type graph.
//
// Keep this file in sync with:
//   - `src/types.ts` (host `AgentEvents`), AND
//   - `src/runtime/sse-conversation-filter.ts#DIRECT_CARRIER_EVENT_TYPES`
// when either changes. A mismatch here won't crash anything — the
// dispatcher treats payloads as `unknown` and the clamp filters unknown
// names — but consumers will see wrong typings.
//
// Complex nested objects (`AgentRun`, `toolCall.input`, etc.) are typed
// as `unknown` so the SDK doesn't duplicate the host runtime model.
// Downstream consumers that need typed `run` / `input` fields must
// cast at the handler boundary; that's intentional — we don't want
// the SDK to re-export host internals as stable API.

export interface RunCompleteEvent {
  /** Host `AgentRun` — opaque from the SDK's perspective. */
  run: unknown;
  conversationId?: string;
}
export interface RunErrorEvent {
  run: unknown;
  error: string;
  conversationId?: string;
}
export interface RunCancelEvent {
  run: unknown;
  conversationId?: string;
}
export interface RunTurnSavedEvent {
  runId: string;
  conversationId: string;
  messageId: string;
  parentMessageId: string | null;
  content: string;
}
export interface ToolStartEvent {
  conversationId: string;
  extensionId: string;
  toolName: string;
  input: unknown;
  timestamp: number;
  source?: "inline" | "agent-run";
  invocationId?: string;
  cardType?: string;
  category?: string;
}
export interface ToolCompleteEvent {
  conversationId: string;
  extensionId: string;
  toolName: string;
  output: unknown;
  duration: number;
  success: boolean;
  source?: "inline" | "agent-run";
  invocationId?: string;
  cardType?: string;
}
export interface ToolErrorEvent {
  conversationId: string;
  extensionId: string;
  toolName: string;
  error: string;
  duration: number;
  source?: "inline" | "agent-run";
  invocationId?: string;
  cardType?: string;
}
export interface ToolPermissionRequestEvent {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  cardType?: string;
  category?: string;
}
export interface ToolPermissionModeChangeEvent {
  conversationId: string;
  mode: string;
}
export interface ObsTurnEvent {
  conversationId: string;
  messageId?: string;
  llmDurationMs: number;
  toolDurationMs: number;
  totalDurationMs: number;
  tokenUsage: { input: number; output: number };
}
export interface OrchestratorHumanInputEvent {
  runId: string;
  conversationId: string;
  question: string;
  requestId: string;
}

// task:snapshot + task:assignment_update are already typed on the SDK
// in `./task-events` — re-export those to give subscribers the same
// shapes the *emit* side uses.
import type { TrackedTask, TaskAssignment } from "./task-events";

export interface TaskSnapshotEvent {
  conversationId: string;
  tasks: TrackedTask[];
  activeTaskId?: string;
}
export interface TaskAssignmentUpdateEvent {
  conversationId: string;
  taskId: string;
  assignment: TaskAssignment;
}

/** The 13 subscribable event types and their payload shapes. Key names
 *  MUST match `DIRECT_CARRIER_EVENT_TYPES` on the host. */
export interface SubscribableEventMap {
  "run:complete": RunCompleteEvent;
  "run:error": RunErrorEvent;
  "run:cancel": RunCancelEvent;
  "run:turn_saved": RunTurnSavedEvent;
  "tool:start": ToolStartEvent;
  "tool:complete": ToolCompleteEvent;
  "tool:error": ToolErrorEvent;
  "tool:permission_request": ToolPermissionRequestEvent;
  "tool:permission_mode_change": ToolPermissionModeChangeEvent;
  "obs:turn": ObsTurnEvent;
  "orchestrator:human_input": OrchestratorHumanInputEvent;
  "task:snapshot": TaskSnapshotEvent;
  "task:assignment_update": TaskAssignmentUpdateEvent;
}

export type SubscribableEvent = keyof SubscribableEventMap;
