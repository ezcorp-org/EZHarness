// ── Re-exported pi-ai types ──────────────────────────────────────────
// Downstream code imports from here for convenience

export type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  Context,
  Tool,
  Usage,
  AssistantMessageEvent,
  Model,
} from "@earendil-works/pi-ai";

export type { KnownProvider } from "@earendil-works/pi-ai";

// ── Provider Name ────────────────────────────────────────────────────
// Open-ended string to support all 20+ pi-ai providers

export type ProviderName = string;

// ── Capability & Status ──────────────────────────────────────────────

export type AgentCapability = "llm" | "shell" | "file" | "http" | "agent" | "custom";

export type AgentStatus = "idle" | "running" | "success" | "error" | "cancelled";

// ── Logging ──────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AgentLog {
  timestamp: number;
  level: LogLevel;
  message: string;
}

// ── Provider Interfaces ──────────────────────────────────────────────

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellOptions {
  cwd?: string;
  quiet?: boolean;
  timeout?: number;
}

export interface ShellProvider {
  run(command: string, options?: ShellOptions): Promise<ShellResult>;
}

export interface FileProvider {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

// ── Agent Context & Result ───────────────────────────────────────────

export interface AgentContext {
  input: Record<string, unknown>;
  llm: any; // Code-based agents receive an LLM wrapper; typed as any for flexibility
  shell: ShellProvider;
  file: FileProvider;
  log(message: string, level?: LogLevel): void;
  signal: AbortSignal;
  run(agentName: string, input: Record<string, unknown>): Promise<AgentResult>;
  tools?: {
    invoke(toolName: string, input: Record<string, unknown>): Promise<unknown>;
  };
}

export interface AgentResult {
  success: boolean;
  output: unknown;
  /**
   * Either a free-form string (legacy/agent-thrown failures) or a
   * structured discriminator used by the cancel paths. The cancel path
   * populates `{ code: "cancelled" | "swallowed_abort", message }` so
   * downstream consumers can distinguish a well-behaved abort (agent
   * threw on `ctx.signal`) from a swallowed abort (agent resolved
   * despite the signal). See cancelRun / runAgent in
   * src/runtime/executor.ts and the parity branch in
   * src/runtime/stream-chat/finalize.ts.
   */
  error?: string | { code: string; message: string };
}

// ── Input Schema ────────────────────────────────────────────────────

export type InputFieldType = "string" | "text" | "number" | "boolean" | "select" | "file-path" | "custom";

export interface InputField {
  type: InputFieldType;
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];       // for "select" type
  component?: string;       // for "custom" type: filename in web/src/lib/custom/
}

export type InputSchema = Record<string, InputField>;

// ── Agent Definition ─────────────────────────────────────────────────

export interface AgentDefinition {
  name: string;
  description: string;
  capabilities: AgentCapability[];
  inputSchema?: InputSchema;
  execute(ctx: AgentContext): Promise<AgentResult>;
}

// ── Agent Run ────────────────────────────────────────────────────────

export interface AgentRun {
  id: string;
  agentName: string;
  projectId?: string;
  provider?: string;
  status: AgentStatus;
  startedAt: number;
  finishedAt?: number;
  logs: AgentLog[];
  result?: AgentResult;
  memoriesUsed?: { id: string; content: string; category: string }[];
}

// ── Agent Config (declarative) ──────────────────────────────────────

export interface AgentConfig {
  name: string;
  description: string;
  capabilities: AgentCapability[];
  inputSchema?: InputSchema;
  prompt: string;
  outputFormat?: "text" | "json";
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// ── Workflow ─────────────────────────────────────────────────────────
//
// A workflow is a named graph of steps. Steps come in three kinds:
//   - `agent`     — invoke a named agent (the only historical kind).
//   - `transform` — a pure, declarative data reshape (no LLM, no I/O).
//   - `gate`      — evaluate a declarative condition; throw if it fails.
// Steps may `loop` (bounded repetition with an until-condition). The word
// "pipeline" is retained only as a hidden CLI alias + legacy YAML glob.

/** Comparison operator for a leaf {@link WorkflowCondition}. Comparisons
 *  on non-numbers evaluate to `false` (never throw). `contains` covers
 *  string-substring and array-includes; `exists` = not undefined/null;
 *  `truthy` = JS truthiness. */
export type WorkflowConditionOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "exists"
  | "truthy";

/** Declarative condition tree evaluated by `gate` steps and loop `until`
 *  clauses. A leaf resolves `ref` (a `$input.` / `$prev.` / `$steps.` ref,
 *  plus `$result.` / `$iteration` inside a loop `until`) and compares it
 *  against `value`; `all` / `any` / `not` compose leaves. Never evaluates
 *  arbitrary code — this is a security constraint (spec §Design 2). */
export type WorkflowCondition =
  | { ref: string; op: WorkflowConditionOp; value?: unknown }
  | { all: WorkflowCondition[] }
  | { any: WorkflowCondition[] }
  | { not: WorkflowCondition };

/** Bounded per-step repetition. `maxIterations` is REQUIRED and
 *  server-clamped to 1..25. `until` is evaluated AFTER each iteration; when
 *  satisfied the loop exits successfully. `onExhausted` decides the
 *  budget-exhausted outcome — default `"fail"` (loud; never a silent
 *  truncation). Mutually exclusive with `retries`; invalid on `gate`. */
export interface LoopConfig {
  maxIterations: number;
  until?: WorkflowCondition;
  onExhausted?: "fail" | "pass";
}

export type WorkflowStepKind = "agent" | "transform" | "gate";

export interface WorkflowStep {
  name: string;
  /** Defaults to `"agent"` — every legacy pipeline step stays valid with
   *  zero edits. */
  kind?: WorkflowStepKind;

  // ── agent kind ──
  agent?: string;
  input?: Record<string, string>;
  /**
   * Per-step retry budget (agent kind only). When a step's agent run
   * finishes unsuccessfully, the executor re-runs it up to `retries` more
   * times before failing the whole workflow. Clamped to 0..2; absent /
   * invalid ⇒ 0 (no retry). A run that was *cancelled* (workflow abort or
   * sibling-failure cancel) is never retried — only a genuine failure is.
   * Mutually exclusive with `loop`.
   */
  retries?: number;

  // ── transform kind ──
  /** Output mapping resolved with the step-input ref language PLUS
   *  `{{…}}` template interpolation. Produces an `AgentResult`-shaped
   *  `{ success: true, output: <resolved object> }`. */
  output?: Record<string, string>;

  // ── gate kind ──
  /** Condition evaluated by a gate step; false ⇒ the workflow fails. */
  condition?: WorkflowCondition;

  dependsOn?: string[];
  /** Bounded loop (agent | transform kinds only). */
  loop?: LoopConfig;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  inputSchema?: InputSchema;
  steps: WorkflowStep[];
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  projectId?: string;
  status: AgentStatus;
  startedAt: number;
  finishedAt?: number;
  steps: WorkflowStepRun[];
  result?: AgentResult;
}

export interface WorkflowStepRun {
  stepName: string;
  runId: string;
  status: AgentStatus;
  /** Final iteration count for a looped step (omitted for non-loop steps). */
  iterations?: number;
}

// ── Team Member Types ────────────────────────────────────────────────

/** Sentinel value meaning "use the parent conversation's current model/provider." */
export const CURRENT_MODEL_SENTINEL = "__current__";

export interface TeamMemberOverrides {
  permissionMode?: "ask" | "auto-edit" | "yolo";
  toolRestriction?: "all" | "read-only" | "none";
  modeId?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  provider?: string;
  model?: string;
  systemPromptAppend?: string;
}

export interface TeamMember {
  agentConfigId: string;
  overrides?: TeamMemberOverrides;
  subAgents?: TeamMember[];
}

/**
 * Team-level tool scoping applied to every invoked member of the team.
 * When set (either list non-empty), overrides each member's individual
 * `toolRestriction` / `allowedTools` / `deniedTools`. Orchestration tools
 * (invoke_agent, task tracking, scratchpad) are always preserved.
 */
export interface TeamToolScope {
  /** If set & non-empty, only these tool names are available to members. */
  allowedTools?: string[];
  /** Tool names always filtered out (applied after allow list). */
  deniedTools?: string[];
}

// ── Events ───────────────────────────────────────────────────────────

export interface AgentEvents {
  [key: string]: unknown;
  // `runId` duplicates `run.id` so SSE clients get a top-level `data.runId`
  // to correlate on (parity with `run:status`), without traversing `data.run`.
  "run:start": { run: AgentRun; runId: string };
  "run:log": { runId: string; log: AgentLog };
  "run:complete": { run: AgentRun; conversationId?: string };
  "run:error": { run: AgentRun; error: string; conversationId?: string; runId: string };
  "run:cancel": { run: AgentRun; conversationId?: string };
  "run:status": { runId: string; status: string };
  "run:token": { runId: string; token: string; kind?: "thinking" | "text" };
  "run:usage": {
    runId: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      /** Subset of `cacheWrite` written with 1h retention (Anthropic-only split). */
      cacheWrite1h?: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
  };
  // `userId` (Wave 0) names the initiating user so the SSE filter can
  // scope delivery fail-closed. CLI-triggered workflows omit it and are
  // not SSE-observable (stdout/DB only).
  "workflow:start": { workflowRun: WorkflowRun; userId?: string };
  "workflow:step": { workflowRun: WorkflowRun; step: WorkflowStepRun; userId?: string };
  "workflow:complete": { workflowRun: WorkflowRun; userId?: string };
  "workflow:error": { workflowRun: WorkflowRun; error: string; userId?: string };
  "tool:start": { conversationId: string; extensionId: string; toolName: string; input: unknown; timestamp: number; source?: 'inline' | 'agent-run'; invocationId?: string; cardType?: string; cardLayout?: string; category?: string };
  "tool:complete": { conversationId: string; extensionId: string; toolName: string; output: unknown; duration: number; success: boolean; source?: 'inline' | 'agent-run'; invocationId?: string; cardType?: string; cardLayout?: string };
  "tool:error": { conversationId: string; extensionId: string; toolName: string; error: string; duration: number; source?: 'inline' | 'agent-run'; invocationId?: string; cardType?: string; cardLayout?: string };
  "tool:permission_request": {
    conversationId: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
    cardType?: string;
    cardLayout?: string;
    category?: string;
    /**
     * Phase 6 H7: owning user id. The SSE filter at
     * `runtime-events/+server.ts` cross-checks this against the
     * subscriber so a permission prompt fires only on the originating
     * user's UI session — never cross-tab / cross-user.
     */
    userId?: string;
    /**
     * Phase 6: extension-scoped permission request marker. When set,
     * the event was emitted by the PDP's `prompt` branch in
     * `tool-executor.ts` and the UI MUST render the four-scope chooser
     * (session/conversation/project/forever) plus the extension's
     * display name + capability description.
     */
    extensionId?: string;
    /** Sensitive capability kind that triggered the prompt — `shell`
     *  or `fs.write`. Used by the modal to render a human-readable
     *  description of what's being requested. */
    capabilityKind?: "shell" | "fs.write";
    /** Sensitive capability value (for `fs.write` it's the concrete
     *  path). Empty / undefined for `shell`. */
    capabilityValue?: string;
    /** PDP prompt id — becomes the `toolCallId` here so the existing
     *  `/api/tool-calls/:id/permission` route resolves the gate
     *  unchanged. Mirrors the gate key for clarity. */
    promptId?: string;
  };
  "tool:kill": { toolCallId: string };
  "tool:permission_mode_change": { conversationId: string; mode: string };
  /**
   * agent-install-ux-polish Phase 2 (D3): a lightweight, USER-SCOPED
   * signal that an agent-driven extension install just succeeded.
   * Emitted host-side from the `ezcorp/drafts` install path AFTER
   * `registry.reload()`, best-effort (D6 — emitting it must never
   * fail or delay the install). Carries NO `conversationId` — it is a
   * cross-surface "your Library is stale" nudge, scoped to the
   * installing user ONLY. Delivery is gated by `shouldDeliverEvent`'s
   * `userId` branch (mirrors `tool:permission_request`'s H7 scoping):
   * never broadcast, never cross-user.
   */
  "extensions:installed": {
    userId: string;
    extensionId: string;
    name: string;
  };
  /**
   * Daily Briefing Phase 1: a server-initiated conversation was created
   * on the user's behalf (the briefing pipeline today; any future
   * server-side creator can reuse it via `source`). USER-scoped like
   * `extensions:installed` — the SSE filter delivers it ONLY to the
   * owning `userId` and FAILS CLOSED on a missing/mismatched id, so a
   * briefing landing in user A's sidebar can never ping user B.
   * Phase 2 wires the client: sidebar live-insert + unread mark.
   */
  "conversation:created": {
    conversationId: string;
    projectId: string;
    userId: string;
    source: "briefing" | (string & {});
  };
  /**
   * Daily Briefing Phase 1: a briefing run finished successfully and
   * its conversation carries real assistant content. Same fail-closed
   * per-user SSE scoping as `conversation:created`.
   */
  "briefing:delivered": {
    userId: string;
    conversationId: string;
    projectId: string;
  };
  /**
   * github-projects integration: a board-move proposal was created,
   * decided (approve/dismiss), or reached a terminal state. A content-free
   * Hub-refresh nudge (mirrors `ext:page-state`) — carries only the owning
   * `projectId` so the Hub re-fetches the project's proposal list. Emitted
   * by the poller daemon and the approve/dismiss API routes.
   */
  "github-projects:proposal-update": {
    projectId: string;
  };
  "obs:turn": { conversationId: string; messageId?: string; llmDurationMs: number; toolDurationMs: number; totalDurationMs: number; tokenUsage: { input: number; output: number } };
  "run:turn_saved": { runId: string; conversationId: string; messageId: string; parentMessageId: string | null; content: string; thinkingContent?: string; final: boolean };
  "run:turn_text_reset": { runId: string };
  // ── Multi-Agent Orchestration ──
  "agent:spawn": {
    runId: string;
    agentRunId: string;
    subConversationId: string;
    agentName: string;
    agentConfigId: string;
    task: string;
    parentConversationId: string;
  };
  "agent:status": {
    runId: string;
    subConversationId: string;
    agentName: string;
    status: string;
  };
  "agent:complete": {
    runId: string;
    agentRunId: string;
    subConversationId: string;
    agentName: string;
    agentConfigId: string;
    success: boolean;
    resultPreview: string;
    parentConversationId: string;
  };
  // ── ask-user extension: bundled tool for asking the user a question
  //    (free-text or multiple-choice). Single direction event: the host
  //    POST endpoint at `/api/ask-user/answer` emits this when the user
  //    submits a response, and the extension's subscription handler
  //    resolves the pending gate keyed on `toolCallId`. The question side
  //    rides on the regular `tool:start` lifecycle (cardType:
  //    "ask-user-question") — no separate question event is needed.
  "ask-user:answer": {
    toolCallId: string;
    conversationId: string;
    answer: string;
  };
  // ── Ez concierge client-side tools (read_page, fill_form, navigate_to).
  //    The runtime emits this when the LLM calls a `clientSide: true` tool:
  //    the panel intercepts it via the SSE stream, runs the UI-side
  //    resolution (page-read, form-fill, goto), and POSTs the result back
  //    so the LLM continues.
  "ez:client-tool": {
    conversationId: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
  // ── Task Tracking Panel ──
  "task:snapshot": {
    conversationId: string;
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      status: "pending" | "active" | "completed" | "failed";
      agentId?: string;
      agentName?: string;
      assignments: Array<{
        id: string;
        agentConfigId: string;
        agentName: string;
        isTeam: boolean;
        status: "assigned" | "running" | "completed" | "failed";
        assignedAt: string;
        startedAt?: string;
        completedAt?: string;
        failedAt?: string;
        subConversationId?: string;
        agentRunId?: string;
        resultPreview?: string;
      }>;
      subtasks: Array<{ id: string; title: string; completed: boolean; position: number }>;
      createdAt: string;
      startedAt?: string;
      completedAt?: string;
      failedAt?: string;
      failureReason?: string;
      completionSummary?: string;
      priority: number;
    }>;
    activeTaskId?: string;
  };
  "task:assignment_update": {
    conversationId: string;
    taskId: string;
    assignment: {
      id: string;
      agentConfigId: string;
      agentName: string;
      isTeam: boolean;
      status: "assigned" | "running" | "completed" | "failed";
      assignedAt: string;
      startedAt?: string;
      completedAt?: string;
      failedAt?: string;
      subConversationId?: string;
      agentRunId?: string;
      resultPreview?: string;
    };
    /**
     * Orchestration reliability (Wave 1): the sub-agent's FULL final
     * text (sentinel-stripped, capped at {@link ASSIGNMENT_RESULT_FULL_CAP}),
     * present only on a terminal update. Kept OFF the `assignment` object
     * so the persisted task-store snapshot and the panel `task:snapshot`
     * stay lean — only the orchestration extension reads it, to return
     * the complete result to the orchestrator LLM instead of the
     * 200-char `resultPreview`.
     */
    resultFull?: string;
    /**
     * Structured output (Phase B1): when the invocation carried an
     * `outputSchema` and the child's final text validated against it, the
     * host-validated parsed value — present only on the terminal update.
     * Kept OFF the `assignment` object for the same reason as
     * `resultFull`: only the orchestration extension reads it, to return
     * validated JSON to the orchestrator LLM.
     */
    structuredResult?: unknown;
    /**
     * Structured output (Phase B1): set INSTEAD of `structuredResult` when
     * the child completed but never produced schema-valid JSON within the
     * bounded re-prompt budget — a human-readable summary of the
     * violations. The child's status stays `completed` (it did finish);
     * the orchestration extension surfaces this as a distinct error.
     */
    structuredResultError?: string;
    /**
     * Set alongside `structuredResultError` when the output DID validate
     * against the schema but its compact serialization exceeded the 30KB
     * structured cap — the (capped) `resultFull` carries the salvage.
     * Lets consumers frame this as an oversized success rather than a
     * schema violation.
     */
    structuredResultOverCap?: boolean;
  };
  // ── Extension Panel State ──
  "ext:state": {
    extensionId: string;
    extensionName: string;
    state: Record<string, unknown>;
    timestamp: number;
  };
  /**
   * Extension Pages Hub §2.5 — content-free invalidation signal.
   * Emitted by the state mediator after a VALIDATED `ezcorp/page-state`
   * push. Deliberately carries NO tree content: the payload leaks only
   * "page X of extension Y changed", so the SSE layer broadcasts it to
   * every authenticated subscriber (it is NOT in
   * `DIRECT_CARRIER_EVENT_TYPES`). Hub tabs showing
   * `ext:<extensionName>:<pageId>` re-pull the render endpoint, which
   * is session-authed and serves from the freshly-updated page cache.
   */
  "ext:page-state": {
    extensionId: string;
    extensionName: string;
    pageId: string;
    timestamp: number;
  };
  /**
   * `/goal` autopilot indicator (PRD §6 FR-20, decision D7). Emitted
   * by the host-side goal-host (`src/runtime/goal-host.ts`) on every
   * state transition: arm, evaluator update, pause, achieve, clear.
   * Phase 1 emits the event; Phase 2 wires SSE delivery
   * (`runtime-events/+server.ts` `BUS_EVENTS` allowlist +
   * `sse-conversation-filter.ts` `DIRECT_CARRIER_EVENT_TYPES`) and
   * the `◎ /goal active|paused` chip in the chat header. The payload
   * carries `conversationId` so the SSE filter can scope delivery per
   * subscriber.
   */
  "goal:update": {
    conversationId: string;
    state: "active" | "paused" | "off";
    condition?: string;
    armedAt?: number;
    turnsEvaluated?: number;
    lastReason?: string | null;
  };
  /**
   * Sessions P4 (rewind/checkpoint): the conversation's message tree /
   * durable leaf pointer changed (a rewind moved the leaf). A content-free
   * nudge — the client re-fetches the ownership-gated `GET
   * /api/conversations/:id/tree` on receipt. Carries `conversationId` at the
   * top level so the SSE filter scopes delivery to the owner
   * (`DIRECT_CARRIER_EVENT_TYPES`), same as `goal:update`. `currentLeaf` is
   * the new durable leaf (a `messages` row id) so a same-tab client can
   * update without the round-trip.
   */
  "conversation:tree-changed": {
    conversationId: string;
    currentLeaf: string | null;
  };
  /**
   * Loops EZ Mode Phase 2 — a loop run PARKED awaiting a human approve/decline
   * (`approval_pending`) or was RESOLVED (`approval_resolved`). Both are
   * CONTENT-FREE invalidation nudges (loopId + runId, + `decision` on resolve)
   * — the web badge/inbox re-fetches the authorized dashboard on receipt; the
   * proposal body NEVER rides the event. The `loopId` is host-STAMPED
   * (`<extensionId>:<loopId>`) so it is provenance-bound to the emitting
   * extension; consumers treat it as an opaque invalidation key.
   * `conversationId` is OPTIONAL: present
   * when the loop is conversation-wired (SSE scopes delivery to that owner via
   * the standard conv-scope branch), absent for a global-scope loop (the nudge
   * broadcasts to every authenticated subscriber, like `ext:page-state` /
   * `github-projects:proposal-update`). Listed in `DIRECT_CARRIER_EVENT_TYPES`
   * as optional carriers (fail-open, mirroring `run:complete`).
   */
  "loops:approval_pending": {
    loopId: string;
    runId: string;
    conversationId?: string;
  };
  "loops:approval_resolved": {
    loopId: string;
    runId: string;
    decision: "approved" | "declined";
    conversationId?: string;
  };
  /**
   * Loops EZ Mode Phase 2 — a loop auto-disabled after N consecutive
   * permanent errors. A user-visible notice so a stop is never silent
   * (inbox/toast surface). Content-carrying but non-sensitive (loop id +
   * error count). Optional conversationId scopes delivery like the approval
   * events; a global loop broadcasts.
   */
  "loops:auto_disabled": {
    loopId: string;
    consecutiveErrors: number;
    conversationId?: string;
  };
}
