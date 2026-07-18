/**
 * Extracted start-assignment logic — shared between the SvelteKit
 * manual-start route and the Phase 2d `ezcorp/spawn-assignment` reverse
 * RPC (which the bundled `task-tracking` extension drives from inside
 * the subprocess).
 *
 * Phase 3 commit-5 removed the dynamic imports of
 * `./tools/task-tracking`. After the cutover this file owns NONE of
 * the task-state bookkeeping — that moved inside the bundled extension
 * and is driven by its `task:assignment_update` subscription (see
 * docs/extensions/examples/task-tracking/index.ts). This file's only
 * remaining job around task state is emitting `task:snapshot` +
 * `task:assignment_update` bus events so the extension (and SSE) see
 * the lifecycle transitions.
 *
 * Responsibilities: create/reuse a sub-conversation, mutate the
 * assignment record the caller passed in to "running", emit lifecycle
 * events, fire streamChat non-blocking, and wire run:complete /
 * run:error listeners that handle pending-message auto-continue and
 * terminal-state emission.
 */
import type { AgentExecutor } from "./executor";
import type { EventBus } from "./events";
import type { AgentEvents, TeamMemberOverrides, TeamToolScope } from "../types";
import { CURRENT_MODEL_SENTINEL } from "../types";
import {
  createSubConversation,
  getSubConversations,
  resolveConversationOwnerUserId,
} from "../db/queries/conversations";
import { getSetting } from "../db/queries/settings";
import { dequeue, enqueue } from "./pending-messages";
import {
  TASK_DONE_RE,
  TASK_BLOCKED_RE,
  TASK_DONE_RE_G,
  TASK_BLOCKED_RE_G,
} from "./sentinels";
import { logger } from "../logger";
import {
  validateStructuredOutput,
  buildSchemaInstruction,
  buildSchemaCorrection,
} from "./structured-output";
import type {
  TaskAssignment,
  TaskSnapshot,
  TrackedTask,
} from "./task-tracking-host";

const log = logger.child("start-assignment");

// ── Autonomous self-continuation primitives ────────────────────────
//
// A sub-agent has no native "I'm done" signal (it's told NOT to call
// task_complete — see the taskDescription guardrail below). When
// autonomous continuation is opted in, the agent self-reports via an
// output sentinel; the cycle cap is the hard backstop if it never does.

const DEFAULT_MAX_AUTONOMOUS_CYCLES = 8;

/**
 * Bounded structured-output re-prompt budget. When an `outputSchema` is
 * set and the child's final output fails validation, the child is
 * re-prompted with the violations at most this many times before the run
 * terminates with a `structuredResultError`.
 */
const MAX_SCHEMA_RETRIES = 2;

/**
 * Cap for the FULL sub-agent result returned to the orchestrator LLM
 * (Wave 1 — replaces the 200-char preview as the orchestrator's input).
 * 30KB (~7-8k tokens) is generous for a worker's final message while
 * bounding the bus/SSE payload and the parent's context growth; longer
 * outputs are truncated with an explicit marker so the orchestrator
 * knows to fetch the sub-conversation for the remainder.
 */
export const ASSIGNMENT_RESULT_FULL_CAP = 30_000;

/** Cap a full result to {@link ASSIGNMENT_RESULT_FULL_CAP}, appending a
 *  visible truncation marker when clipped. Empty input → undefined so a
 *  no-output run omits the field entirely. */
export function capFullResult(text: string): string | undefined {
  if (!text) return undefined;
  if (text.length <= ASSIGNMENT_RESULT_FULL_CAP) return text;
  return (
    text.slice(0, ASSIGNMENT_RESULT_FULL_CAP) +
    `\n\n[... truncated ${text.length - ASSIGNMENT_RESULT_FULL_CAP} more characters — open the sub-conversation for the full output]`
  );
}

const CONTINUATION_PROMPT =
  "Continue working toward the Pinned Objective in your system prompt. " +
  "When the objective is fully met, output `<<TASK_DONE>>` on its own line. " +
  "If you are blocked and cannot proceed, output " +
  "`<<TASK_BLOCKED: reason>>` and stop.";

/** Normalize a run result's `output` (string | `{ fullText }` | other)
 *  into plain text. Mirrors the legacy resultPreview extraction. */
export function extractFullText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "fullText" in output) {
    const t = (output as { fullText: unknown }).fullText;
    return typeof t === "string" ? t : "";
  }
  return "";
}

/** Detect the sub-agent's self-reported terminal signal. `done` wins
 *  over `blocked` if both somehow appear. */
export function detectDoneSignal(
  text: string,
): { kind: "done" } | { kind: "blocked"; reason: string } | null {
  if (TASK_DONE_RE.test(text)) return { kind: "done" };
  const m = text.match(TASK_BLOCKED_RE);
  if (m) return { kind: "blocked", reason: (m[1] ?? "").trim() };
  return null;
}

/** Strip every sentinel occurrence so the user-facing preview is clean. */
export function stripSignals(text: string): string {
  return text.replace(TASK_DONE_RE_G, "").replace(TASK_BLOCKED_RE_G, "").trim();
}

export interface StartAssignmentAgentConfig {
  id: string;
  name: string;
  prompt: string;
  model?: string | null;
  provider?: string | null;
}

export interface StartAssignmentOpts {
  executor: AgentExecutor;
  bus: EventBus<AgentEvents>;
  conversationId: string;
  taskId: string;
  assignment: TaskAssignment; // mutated in place
  task: TrackedTask;
  snapshot: TaskSnapshot;
  projectId: string;
  /** Absolute directory the child's built-in file/shell tools root at instead
   *  of the project path — the spawn-assignment `workingDir` pin for
   *  extension-dispatched agents that must operate in a specific checkout
   *  (e.g. a pipeline run's git worktree). Forwarded verbatim to EVERY cycle's
   *  streamChat (initial run, auto-continue, autonomous, schema re-prompt) so
   *  a later cycle never silently falls back to the shared project checkout. */
  workingDir?: string;
  agentConfig: StartAssignmentAgentConfig;
  /** Fallback model from the parent conversation (used for CURRENT_MODEL_SENTINEL). */
  parentModel?: string;
  /** Fallback provider from the parent conversation (used for CURRENT_MODEL_SENTINEL). */
  parentProvider?: string;
  /** When provided, skip the reuse-by-agentConfigId lookup and treat this
   *  id as the sub-conversation. Useful when the caller already resolved
   *  the target sub-conv (e.g. the spawn-assignment handler's
   *  `reuseSubConversationFor` branch). */
  reuseSubConversationId?: string;
  /** Parent message id to anchor a newly-created sub-conversation to. */
  parentMessageId?: string;
  /** Per-member override bundle forwarded to `streamChat`. */
  overrides?: TeamMemberOverrides;
  /** Team-level allow/deny list forwarded to `streamChat`. When active,
   *  wins over `overrides.toolRestriction` / `overrides.allowedTools` /
   *  `overrides.deniedTools`. */
  teamToolScope?: TeamToolScope;
  /** Orchestration depth forwarded to `streamChat.options.orchestrationDepth`. */
  orchestrationDepth?: number;
  /** Parent orchestrator run id. When set, EVERY run this assignment
   *  starts (the initial task run AND each auto-continue / autonomous
   *  cycle) is registered on the executor as a child of this run, so a
   *  cancel of the parent cascades down and stops the sub-agent. */
  parentRunId?: string;
  /** Opt-in autonomous self-continuation. When set, a finished run with
   *  no pending user message and no done/blocked sentinel re-prompts the
   *  sub-agent toward the pinned objective until it signals completion
   *  or `maxCycles` is reached. Default OFF; default `maxCycles` is
   *  {@link DEFAULT_MAX_AUTONOMOUS_CYCLES}. */
  autonomousContinuation?: { maxCycles?: number };
  /** Called at each cycle boundary (auto-continue AND autonomous), AFTER the
   *  new cycle's run is confirmed to start, with `(oldRunId, newRunId)`. The
   *  spawn-assignment handler uses it to re-key its spawn-quota reservation
   *  onto the live cycle run so the concurrent slot follows the running child
   *  and `ezcorp/cancel-run` can still cancel it. Not called for the initial
   *  run (the handler reserves/​swaps that itself post-dispatch), nor when a
   *  cycle is refused because the parent already ended. */
  onCycleRunIdChange?: (oldRunId: string, newRunId: string) => void;
  /** Optional JSON Schema (object) the sub-agent's FINAL output must
   *  satisfy (Phase B1). When set, startAssignment appends an explicit
   *  output-format instruction to the child's first message, validates
   *  the child's final text host-side against the documented JSON-Schema
   *  subset (`structured-output.ts`), and re-prompts the SAME
   *  sub-conversation (bounded, {@link MAX_SCHEMA_RETRIES}) with the
   *  violations on failure. The terminal `task:assignment_update` carries
   *  `structuredResult` (parsed object) on success, or `structuredResultError`
   *  (violation summary) when the retry budget is exhausted — the child
   *  still completes either way. If both `autonomousContinuation` and
   *  `outputSchema` are set, autonomous looping runs first and the schema
   *  validates the FINAL cycle's output. */
  outputSchema?: Record<string, unknown>;
  /** Background-spawn completion notify (Phase B2). Set by the
   *  orchestration extension's `background: true` invoke path. When true,
   *  EVERY terminal transition (complete / error / cancel / refused-start /
   *  stream-crash) additionally enqueues a plain, capped completion-notify
   *  pending message onto the PARENT conversation (`conversationId`) so an
   *  orchestrator that dispatched this child without blocking can react on
   *  its next turn. `agent:complete` is emitted on the terminal transition
   *  regardless of this flag (it is the immediate UI / observability / ext-
   *  subscription signal); this flag ONLY gates the parent-queue nudge.
   *
   *  Drain semantics — WHICH parents actually get the queued nudge delivered
   *  to their LLM (be precise; do NOT over-promise):
   *    • PARENT IS ITSELF A SUB-AGENT (nested teams): delivered. Its own
   *      `startAssignment` run:complete drains `dequeue(conversationId)` and
   *      auto-continues the orchestrator with the notify text.
   *    • PARENT IS A GOAL-HOST conversation: delivered — the goal loop drains
   *      it (as a supersede signal) on its next evaluated turn.
   *    • PARENT IS A TOP-LEVEL user chat: NOT delivered in-conversation. Nothing
   *      drains a plain chat's pending-messages queue (the main chat + agent-
   *      chat idle paths do NOT dequeue). The message sits until such a drainer
   *      runs, which for a plain chat never happens — so `collect_agent_result`
   *      is the ONLY reliable path for a top-level orchestrator, and the tool's
   *      returned text says so. `agent:complete` (emitted regardless of this
   *      flag) still drives the UI chip + observability + ext subscriptions in
   *      every case. The enqueue is kept because it's free and correct for the
   *      nested/goal-host cases; it is simply a no-op for top-level chats. */
  notifyParentOnTerminal?: boolean;
  /** Detached (background) spawn: the child is DESIGNED to outlive the parent
   *  orchestrator run (the parent's turn typically ends before the child
   *  finishes; run:complete cascade-cancel deliberately does not fire for it).
   *  Multi-cycle background children (`autonomousContinuation` or `outputSchema`)
   *  re-enter startRun at each cycle boundary and call `registerChildRun` again;
   *  once the parent has terminalized that returns false. For a SYNC spawn that
   *  false is correct — don't start an ownerless child whose result nobody
   *  consumes. For a DETACHED spawn it is NOT: the child legitimately continues,
   *  so instead of force-failing it (and enqueuing a false "finished (failure)"
   *  notify to the parent) we stream the cycle UNPARENTED. It stays supervised
   *  by its own idle watchdog + the task-panel Stop (`assignment.agentRunId`
   *  tracks the live cycle run). The INITIAL background spawn still registers
   *  under the parent while the parent IS running, so an early Stop still
   *  cascades. Default OFF (sync). */
  detached?: boolean;
}

export interface StartAssignmentResult {
  subConversationId: string;
  agentRunId: string;
}

function emitTaskSnapshot(
  bus: EventBus<AgentEvents>,
  snapshot: TaskSnapshot,
): void {
  bus.emit("task:snapshot", {
    conversationId: snapshot.conversationId,
    tasks: snapshot.tasks,
    ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}),
  });
}

function emitAssignmentUpdate(
  bus: EventBus<AgentEvents>,
  conversationId: string,
  taskId: string,
  assignment: TaskAssignment,
  resultFull?: string,
  structured?: { result?: unknown; error?: string; overCap?: boolean },
): void {
  // Terminal updates are the ONLY signal a spawning extension gets that its
  // sub-agent finished (the ez-code-factory pipeline awaits them) — a missed
  // one wedges the caller until its dispatch timeout. Rare + load-bearing, so
  // log every emit; the dispatcher logs the matching delivery decision.
  log.info("assignment_update emit", {
    conversationId,
    taskId,
    assignmentId: assignment.id,
    status: assignment.status,
    hasStructured: structured?.result !== undefined,
  });
  bus.emit("task:assignment_update", {
    conversationId,
    taskId,
    assignment,
    ...(resultFull !== undefined ? { resultFull } : {}),
    ...(structured?.result !== undefined ? { structuredResult: structured.result } : {}),
    ...(structured?.error !== undefined ? { structuredResultError: structured.error } : {}),
    ...(structured?.overCap ? { structuredResultOverCap: true } : {}),
  });
}

/**
 * Start an assignment: create its sub-conversation (or reuse an existing
 * one for the same agent), mutate the assignment to "running", emit the
 * required bus events, and fire streamChat in the background with
 * lifecycle listeners that mark the assignment completed/failed when
 * the run ends.
 *
 * The caller owns the task-tracking storage row — this function only
 * mutates the passed-in assignment/task/snapshot objects and emits bus
 * events. The bundled task-tracking extension's
 * `task:assignment_update` subscription picks up those events and
 * persists the merged state back to its own storage row (two-hop
 * bridge, plan §4.2).
 */
export async function startAssignment(opts: StartAssignmentOpts): Promise<StartAssignmentResult> {
  const {
    executor, bus, conversationId, taskId, assignment, task, snapshot,
    projectId, workingDir, agentConfig, parentModel, parentProvider,
    reuseSubConversationId, parentMessageId, overrides, teamToolScope,
    orchestrationDepth, autonomousContinuation, parentRunId,
    onCycleRunIdChange, outputSchema, notifyParentOnTerminal, detached,
  } = opts;

  // Master kill-switch (Advanced Settings → "Agent goal pinning &
  // autonomous continuation"). Default-true: absent / null / non-boolean
  // ⇒ enabled. When OFF, behavior reverts to pre-feature: no pinned
  // objective in the system prompt and no autonomous self-continuation,
  // regardless of any per-spawn opt-in. Gating here covers EVERY spawn
  // path (manual route, spawn-assignment reverse-RPC, future callers).
  const autonomyFeatureEnabled =
    (await getSetting("global:agentAutonomyEnabled")) !== false;

  const autonomousEnabled = autonomyFeatureEnabled && !!autonomousContinuation;
  const maxAutoCycles =
    autonomousContinuation?.maxCycles ?? DEFAULT_MAX_AUTONOMOUS_CYCLES;
  let autoCycle = 0;
  // Structured-output re-prompt state (Phase B1). Independent of the
  // autonomy kill-switch: schema validation is its own feature.
  let schemaRetries = 0;
  // Set while a schema-correction cycle is in flight. A correction run's
  // response carries no `<<TASK_DONE>>` sentinel, so without this flag the
  // autonomous branch (2) would treat it as "still working" and fire a
  // CONTINUATION — swallowing the corrected JSON and sending a conflicting
  // prompt. While set, branch (2) is skipped and the correction run's
  // completion goes straight to schema validation, which clears the flag.
  let schemaRepromptInFlight = false;

  // P4 steer mode for THIS assignment's runs (constant across cycles — both
  // flags are fixed for the assignment's lifetime). An autonomous or
  // structured-output child must NOT be mid-run-steered: a live steer would
  // interleave with an autonomous/schema-correction cycle and break the
  // run-boundary "user steering wins / abandons the in-flight schema
  // correction" invariant (the schemaRepromptInFlight gate). Registered per
  // cycle in startRun so steerConversation refuses those runs (`guarded`) and
  // the caller routes the message to pending-messages, where branch (1)'s
  // run-boundary drain delivers it — preserving today's behavior for these
  // children. A plain child (both false) stays mid-run-steerable (P2/P3).
  const runMode = { autonomous: autonomousEnabled, schema: !!outputSchema };

  // Reuse an existing sub-conversation for this agent, or create one.
  // If the caller pre-resolved a reuse id, honor it verbatim and skip the
  // by-agentConfigId lookup. Otherwise preserve legacy reuse semantics.
  let subConversationId: string;
  if (reuseSubConversationId) {
    subConversationId = reuseSubConversationId;
  } else {
    const existingSubConvos = await getSubConversations(conversationId);
    const existingAgentConv = existingSubConvos.find(
      (sc) => sc.agentConfigId === assignment.agentConfigId,
    );
    if (existingAgentConv) {
      subConversationId = existingAgentConv.id;
    } else {
      // Wave 0: persist the owning user on the sub-conversation so
      // conversation-scoped authorization (SSE filter, /api/runs
      // ownership) works without walking the parent chain. Inherited
      // from the nearest ancestor with an owner; legacy null-owner
      // rows are covered by the filter's parent walk.
      const ownerUserId = await resolveConversationOwnerUserId(conversationId);
      const subConv = await createSubConversation(projectId, {
        parentConversationId: conversationId,
        agentConfigId: assignment.agentConfigId,
        systemPrompt: agentConfig.prompt,
        title: agentConfig.name,
        ...(ownerUserId ? { userId: ownerUserId } : {}),
        ...(parentMessageId ? { parentMessageId } : {}),
      });
      subConversationId = subConv.id;
    }
  }
  const teamScopeActive = !!(
    teamToolScope &&
    ((teamToolScope.allowedTools?.length ?? 0) > 0 ||
      (teamToolScope.deniedTools?.length ?? 0) > 0)
  );

  const agentRunId = crypto.randomUUID();
  const now = new Date().toISOString();

  assignment.status = "running";
  assignment.startedAt = now;
  assignment.subConversationId = subConversationId;
  assignment.agentRunId = agentRunId;

  emitTaskSnapshot(bus, snapshot);
  emitAssignmentUpdate(bus, conversationId, taskId, assignment);
  bus.emit("agent:spawn", {
    runId: agentRunId,
    agentRunId,
    subConversationId,
    agentName: agentConfig.name,
    agentConfigId: assignment.agentConfigId,
    task: task.title,
    parentConversationId: conversationId,
  });

  // Build the task prompt with full plan context so the sub-agent
  // understands the broader goal and what other agents are working on.
  const planContext = [...snapshot.tasks]
    .sort((a, b) => a.priority - b.priority)
    .map((t) => {
      const status = t.id === task.id ? ">> THIS TASK" : t.status.toUpperCase();
      const agents = t.assignments
        .map((a) => `@${a.agentName}${a.status === "running" ? " (running)" : a.status === "completed" ? " (done)" : ""}`)
        .join(", ");
      return `- [${status}] ${t.title}${agents ? ` — ${agents}` : ""}`;
    })
    .join("\n");

  const taskBody = task.description ? `${task.title}\n\n${task.description}` : task.title;
  // Goal pinning: the objective rides in the system prompt so it is
  // re-anchored on EVERY chat cycle (initial run, user-driven
  // auto-continue, and autonomous continuation) — not just the first
  // message, which otherwise drifts out of context on long runs.
  const objectiveBlock =
    `## Pinned Objective\n${taskBody}\n\n` +
    `Stay focused on this objective for the duration of this assignment.`;
  // Structured-output instruction rides ONLY on the first message. When
  // no outputSchema is set this appends the empty string, so the prompt is
  // byte-identical to the legacy behavior.
  const taskDescription =
    `## Your Task\n${taskBody}\n\n## Full Plan Context\nThis task is part of a larger plan. Here are all tasks:\n${planContext}\n\nFocus on completing YOUR task. If you need information from other tasks, note it in your output.\n\nIMPORTANT: Do NOT call task_complete, task_fail, or task_plan in this run. Your parent conversation tracks your completion automatically when this run ends — calling those tools here only writes to your own (empty) sub-conversation storage and wastes turns. Just finish the work and stop.` +
    (outputSchema ? buildSchemaInstruction(outputSchema) : "");

  const resolveSentinel = (value: string | undefined | null, fallback: string | undefined): string | undefined =>
    value === CURRENT_MODEL_SENTINEL ? fallback : value ?? undefined;
  const resolveModel = () =>
    resolveSentinel(overrides?.model as string | undefined, parentModel)
    ?? resolveSentinel(agentConfig.model, parentModel)
    ?? parentModel;
  const resolveProvider = () =>
    resolveSentinel(overrides?.provider as string | undefined, parentProvider)
    ?? resolveSentinel(agentConfig.provider, parentProvider)
    ?? parentProvider;
  const resolveSystem = () => {
    const base = overrides?.systemPromptAppend
      ? `${agentConfig.prompt}\n\n${overrides.systemPromptAppend}`
      : agentConfig.prompt;
    return autonomyFeatureEnabled ? `${base}\n\n${objectiveBlock}` : base;
  };

  // ── Terminal notify + agent:complete (Phase B2) ──────────────────
  //
  // Called from EVERY terminal branch inside startRun with the LIVE cycle
  // run id (`cycleRunId`) — auto-continue / autonomous / schema-retry cycles
  // each start a fresh run, and the cascade-cancel + observability trails key
  // on the run that actually authored the terminal turn.
  //
  // (1) Emits the `agent:complete` bus event for ALL assignments. This closes
  //     the historical gap where the invoke_agent → startAssignment path only
  //     ever emitted `agent:spawn` + `task:assignment_update` and NEVER
  //     `agent:complete`, so the SSE chip refresh / observability agent_call
  //     rows / extension lifecycle subscriptions never saw the terminal. The
  //     event is already a `parentConversationId`-scoped direct carrier in
  //     `sse-conversation-filter.ts` and is consumed by `observability/
  //     collector.ts` + `lifecycle-dispatcher.ts` — this is purely the missing
  //     emit.
  //     F6 CALLOUT (intended behavior change): `agent:complete` now ALSO fires
  //     for SYNCHRONOUS invoke_agent (and team/task-panel spawns), not just the
  //     agent-chat idle path. So `observability/collector.ts` writes an
  //     agent_call/agent_error row per sync sub-agent, and any
  //     `lifecycle-dispatcher` `agent:complete` subscriber now receives these
  //     events. This is the deliberate gap-fill — consumers should expect the
  //     new events (they were previously emitted only from the agent-chat route).
  // (2) For a background spawn (`notifyParentOnTerminal`), ALSO enqueues a
  //     plain, capped completion-notify pending message onto the PARENT
  //     conversation so an orchestrator that dispatched this child without
  //     blocking can react on its next turn (drain semantics: see
  //     StartAssignmentOpts.notifyParentOnTerminal). The text carries no
  //     secrets (only the already-sanitized 200-char preview) and is capped.
  const NOTIFY_PREVIEW_CAP = 400;
  // Single terminal per assignment. The four terminal branches
  // (run:complete, run:error, run:cancel, streamPromise.catch) rely on the
  // executor's mutual-exclusion to fire at most once, and cleanup()
  // unsubscribes the sibling listeners on the first. This flag is a
  // belt-and-suspenders backstop so any future change that lets two terminals
  // race (e.g. streamChat rejecting AFTER already emitting run:error) can't
  // double-fire `agent:complete` + a duplicate parent notify. Set on the first
  // terminal; subsequent calls early-return.
  let terminalized = false;
  function emitTerminal(
    cycleRunId: string,
    success: boolean,
    resultPreview: string,
  ): void {
    if (terminalized) return;
    terminalized = true;
    bus.emit("agent:complete", {
      runId: cycleRunId,
      agentRunId: cycleRunId,
      subConversationId,
      agentName: agentConfig.name,
      agentConfigId: assignment.agentConfigId,
      success,
      resultPreview,
      parentConversationId: conversationId,
    });
    if (!notifyParentOnTerminal) return;
    const clipped =
      resultPreview.length > NOTIFY_PREVIEW_CAP
        ? resultPreview.slice(0, NOTIFY_PREVIEW_CAP) + "…"
        : resultPreview;
    const status = success ? "success" : "failure";
    const content =
      `Background agent "${agentConfig.name}" finished (${status})` +
      (clipped ? `: ${clipped}` : "") +
      ". Use collect_agent_result for the full output.";
    enqueue(conversationId, {
      messageId: crypto.randomUUID(),
      content,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Start a run and register lifecycle listeners. Called for the
   * initial task and recursively for auto-continue when the user
   * injects messages via the agent-chat endpoint while the agent is
   * running.
   */
  function startRun(
    runId: string,
    message: string,
    runParentMessageId?: string,
    previousRunId?: string,
  ) {
    // Link this run to the parent orchestrator BEFORE it streams, so a
    // cancel racing the spawn still cascades. Done inside startRun (not
    // once outside) because auto-continue + autonomous cycles call startRun
    // again with a NEW run id — each cycle's run must be registered or a
    // mid-cycle cancel would orphan the live child.
    //
    // registerChildRun returns false when the parent is already terminal:
    // startAssignment awaits several DB reads before reaching here, so a
    // user's Stop can kill the orchestrator inside that window — AND, for a
    // multi-cycle child, each cycle boundary re-enters startRun long after the
    // parent's turn has legitimately ended.
    //
    // SYNC spawn: starting a child now would stream ownerless with nobody to
    // consume the result. Fail the assignment instead of starting dead work;
    // the terminal assignment_update also releases the parent's
    // (already-rejected) invoke_agent gate cleanly.
    //
    // DETACHED (background) spawn: the child is DESIGNED to outlive the parent
    // run (docs/extensions/examples/orchestration — cascade-cancel does not
    // fire for a background child), so a background+autonomous or
    // background+outputSchema child WILL hit this false branch at a normal
    // cycle boundary while still doing real work. Force-failing it here would
    // non-deterministically self-fail the child mid-run and enqueue a false
    // "finished (failure)" notify to the parent. Instead we degrade gracefully:
    // stream this cycle UNPARENTED (cascade registration is already a no-op —
    // the parent is gone) and let the child's own idle watchdog + task-panel
    // Stop supervise it. `assignment.agentRunId` already tracks this live cycle
    // run (set by the caller before startRun), so Stop still targets it.
    if (parentRunId && !executor.registerChildRun(parentRunId, runId)) {
      if (detached) {
        log.info("Detached child outlived terminal parent — streaming unparented", {
          conversationId, taskId, parentRunId, runId,
        });
        // Fall through (no return): re-key the cycle quota reservation below
        // and stream the cycle as normal, just without a parent to cascade to.
      } else {
        assignment.status = "failed";
        assignment.failedAt = new Date().toISOString();
        assignment.resultPreview = "Parent run ended before this agent could start";
        emitTaskSnapshot(bus, snapshot);
        emitAssignmentUpdate(
          bus, conversationId, taskId, assignment,
          "Parent run ended before this agent could start — child was not started.",
        );
        emitTerminal(runId, false, "Parent run ended before this agent could start");
        log.info("Refused to start child of terminal parent run", {
          conversationId, taskId, parentRunId, runId,
        });
        return;
      }
    }

    // Cycle continuation: this run replaces `previousRunId` (a new id minted
    // for an auto-continue or autonomous cycle). Re-key the caller's
    // spawn-quota reservation onto this live run so the concurrent slot
    // follows the running child and `ezcorp/cancel-run` can still cancel it.
    // Done AFTER the registerChildRun success gate so a cycle refused because
    // the parent already ended never leaks a reservation; the initial run
    // (previousRunId undefined) is reserved/​swapped by the handler itself.
    if (previousRunId !== undefined) {
      onCycleRunIdChange?.(previousRunId, runId);
    }

    // P4: record this cycle's steer mode BEFORE streamChat makes the run
    // steerable (streamChat registers runConversations synchronously at its
    // start). Every cycle re-registers because each mints a new run id; the
    // executor drops the entry at the run's terminal bus event. An
    // autonomous/schema run is then refused by steerConversation (`guarded`)
    // and its steers route to pending-messages instead.
    executor.registerRunMode(runId, runMode);

    const streamPromise = executor.streamChat(subConversationId, message, {
      projectId,
      ...(workingDir ? { workingDir } : {}),
      agentConfigId: assignment.agentConfigId,
      runId,
      model: resolveModel() ?? undefined,
      provider: resolveProvider() ?? undefined,
      system: resolveSystem(),
      ...(runParentMessageId ? { parentMessageId: runParentMessageId } : {}),
      ...(typeof orchestrationDepth === "number" ? { orchestrationDepth } : {}),
      ...(overrides?.permissionMode ? { permissionMode: overrides.permissionMode } : {}),
      ...(overrides?.modeId ? { modeId: overrides.modeId } : {}),
      ...(teamScopeActive
        ? {
            ...(teamToolScope!.allowedTools ? { allowedTools: teamToolScope!.allowedTools } : {}),
            ...(teamToolScope!.deniedTools ? { deniedTools: teamToolScope!.deniedTools } : {}),
          }
        : {
            ...(overrides?.toolRestriction ? { toolRestriction: overrides.toolRestriction } : {}),
            ...(overrides?.allowedTools ? { allowedTools: overrides.allowedTools as string[] } : {}),
            ...(overrides?.deniedTools ? { deniedTools: overrides.deniedTools as string[] } : {}),
          }),
    });

    let unsubComplete: () => void = () => {};
    let unsubError: () => void = () => {};
    let unsubCancel: () => void = () => {};
    const cleanup = () => { unsubComplete(); unsubError(); unsubCancel(); };

    unsubComplete = bus.on("run:complete", (data) => {
      if (data.run.id !== runId) return;
      cleanup();

      // (1) User steering always wins: a queued user message re-prompts
      // the sub-agent verbatim, regardless of autonomous mode. A user
      // message also ABANDONS any in-flight schema correction (the
      // correction run's output is discarded here anyway), so the flag
      // is cleared and the user-driven run gets normal autonomous
      // semantics — branch (2.5) still validates at the natural terminal
      // point. This cannot reintroduce the correction-swallow bug: that
      // bug is about protecting an ISSUED correction response, which the
      // user message replaces entirely.
      const pending = dequeue(subConversationId);
      if (pending) {
        schemaRepromptInFlight = false;
        const newRunId = crypto.randomUUID();
        assignment.agentRunId = newRunId;
        emitTaskSnapshot(bus, snapshot);
        emitAssignmentUpdate(bus, conversationId, taskId, assignment);

        bus.emit("agent:spawn", {
          runId: newRunId, agentRunId: newRunId, subConversationId,
          agentName: agentConfig.name, agentConfigId: assignment.agentConfigId,
          task: pending.content, parentConversationId: conversationId,
        });

        startRun(newRunId, pending.content, pending.messageId, runId);
        log.info("Auto-continue with pending message", {
          conversationId, taskId, newRunId,
        });
        return;
      }

      // (2) Autonomous self-continuation (opt-in). The `status ===
      // "running"` guard makes this interruptible for free: the Stop
      // endpoint flips the assignment to "assigned" before cancelling,
      // and run:cancel/run:error already unsubscribed via cleanup(), so
      // a stopped/cancelled run never re-loops. The objective is
      // re-pinned each cycle via resolveSystem(), so CONTINUATION_PROMPT
      // stays terse.
      // `!schemaRepromptInFlight` gates out the corrected-JSON run: it has
      // no sentinel, so branch (2) would otherwise re-absorb it as a
      // continuation and discard the correction (see schemaRepromptInFlight).
      let autonomousNote: string | undefined;
      if (autonomousEnabled && assignment.status === "running" && !schemaRepromptInFlight) {
        const signal = detectDoneSignal(
          extractFullText(data.run.result?.output),
        );
        if (signal === null && autoCycle < maxAutoCycles) {
          autoCycle++;
          assignment.autonomousCycle = autoCycle;
          assignment.autonomousMaxCycles = maxAutoCycles;
          const newRunId = crypto.randomUUID();
          assignment.agentRunId = newRunId;
          emitTaskSnapshot(bus, snapshot);
          emitAssignmentUpdate(bus, conversationId, taskId, assignment);

          bus.emit("agent:spawn", {
            runId: newRunId, agentRunId: newRunId, subConversationId,
            agentName: agentConfig.name, agentConfigId: assignment.agentConfigId,
            task: CONTINUATION_PROMPT, parentConversationId: conversationId,
          });

          startRun(newRunId, CONTINUATION_PROMPT, undefined, runId);
          log.info("Autonomous continuation", {
            conversationId, taskId, newRunId,
            cycle: autoCycle, maxCycles: maxAutoCycles,
          });
          return;
        }
        if (signal?.kind === "blocked") {
          autonomousNote = signal.reason
            ? `[blocked] ${signal.reason}`
            : "[blocked]";
        } else if (signal === null) {
          autonomousNote =
            `[stopped after ${autoCycle} autonomous cycle${autoCycle === 1 ? "" : "s"}]`;
        }
        // signal.kind === "done" → no note; normal completion below.
      }

      // (2.5) Structured-output validation + bounded re-prompt (Phase B1).
      // Runs only when the run would otherwise terminally complete — i.e.
      // AFTER autonomous sentinel handling (a schema child's autonomous
      // loop, if any, has already stopped here). On a validation failure
      // the SAME sub-conversation is re-prompted with the violations, up to
      // MAX_SCHEMA_RETRIES times, reusing the exact cycle mechanics
      // (parentRunId registration + onCycleRunIdChange quota re-key) as an
      // autonomous cycle. A valid parse rides the terminal update as
      // `structuredResult`; an exhausted budget as `structuredResultError`
      // (the child still completes — success is unchanged).
      let structuredResult: unknown | undefined;
      let structuredResultError: string | undefined;
      let structuredResultOverCap = false;
      if (outputSchema && assignment.status === "running") {
        // This completion consumed any in-flight correction — clear the
        // gate before deciding the next step (a fresh correction re-arms it).
        schemaRepromptInFlight = false;
        const finalText = stripSignals(extractFullText(data.run.result?.output));
        const outcome = validateStructuredOutput(outputSchema, finalText);
        if (outcome.ok) {
          // Cap parity with resultFull: the parsed object rides the bus and
          // is echoed to the orchestrator, so bound it by the same 30KB cap.
          // Over-cap validated output is NOT attached; the (capped)
          // resultFull carries the salvage instead. `overCap` marks this as
          // a VALIDATED-but-oversized result (not a schema failure) so the
          // extension frames it honestly rather than as a violation.
          if (JSON.stringify(outcome.value).length > ASSIGNMENT_RESULT_FULL_CAP) {
            structuredResultOverCap = true;
            structuredResultError =
              "result validated against the schema but exceeds the 30KB structured cap; the (capped) raw output carries the result";
          } else {
            structuredResult = outcome.value;
          }
        } else if (schemaRetries < MAX_SCHEMA_RETRIES) {
          schemaRetries++;
          // Re-arm the gate so branch (2) skips the sentinel-less correction run.
          schemaRepromptInFlight = true;
          const correction = buildSchemaCorrection(outputSchema, outcome.summary, {
            autonomous: autonomousEnabled,
          });
          const newRunId = crypto.randomUUID();
          assignment.agentRunId = newRunId;
          emitTaskSnapshot(bus, snapshot);
          emitAssignmentUpdate(bus, conversationId, taskId, assignment);

          bus.emit("agent:spawn", {
            runId: newRunId, agentRunId: newRunId, subConversationId,
            agentName: agentConfig.name, agentConfigId: assignment.agentConfigId,
            task: correction, parentConversationId: conversationId,
          });

          startRun(newRunId, correction, undefined, runId);
          log.info("Structured-output re-prompt", {
            conversationId, taskId, newRunId,
            retry: schemaRetries, maxRetries: MAX_SCHEMA_RETRIES,
          });
          return;
        } else {
          structuredResultError = outcome.summary;
        }
      }

      // (3) Terminal completion. stripSignals keeps the preview clean;
      // for non-autonomous runs the output never carries a sentinel so
      // this branch is byte-for-byte the legacy behavior.
      //
      // Idempotency (mirrors the run:cancel listener): the task panel's
      // Stop endpoint and the task_stop tool flip the assignment to
      // "assigned" BEFORE cancelling the run. When the natural completion
      // wins that race, run:complete lands here with the assignment
      // already transitioned — leave it alone to preserve the resumable
      // state instead of clobbering it back to "completed". Branches
      // (2)/(2.5) already carry the same status === "running" guard.
      if (assignment.status !== "running") return;
      assignment.status = "completed";
      assignment.completedAt = new Date().toISOString();

      const rawOutput = data.run.result?.output;
      const previewable =
        typeof rawOutput === "string" ||
        (!!rawOutput && typeof rawOutput === "object" && "fullText" in rawOutput);
      // Full result carried to the orchestrator LLM (Wave 1). The panel
      // still shows the 200-char preview; `resultFull` rides the
      // assignment_update event only and feeds the invoke_agent return.
      let resultFull: string | undefined;
      if (previewable || autonomousNote) {
        const cleaned = stripSignals(extractFullText(rawOutput));
        let preview = cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
        let full = cleaned;
        if (autonomousNote) {
          preview = preview ? `${autonomousNote} ${preview}` : autonomousNote;
          full = full ? `${autonomousNote} ${full}` : autonomousNote;
        }
        assignment.resultPreview = preview;
        resultFull = capFullResult(full);
      }

      // Structured-output payload (Phase B1) rides the terminal update
      // alongside resultFull: a validated object as `structuredResult`, or
      // an exhausted-retry violation summary as `structuredResultError`
      // (with `overCap` marking the validated-but-oversized case).
      let structuredArg: { result?: unknown; error?: string; overCap?: boolean } | undefined;
      if (structuredResult !== undefined) {
        structuredArg = { result: structuredResult };
      } else if (structuredResultError !== undefined) {
        structuredArg = { error: structuredResultError, overCap: structuredResultOverCap };
      }

      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(
        bus, conversationId, taskId, assignment, resultFull, structuredArg,
      );
      emitTerminal(runId, true, assignment.resultPreview ?? "");
    });

    unsubError = bus.on("run:error", (data) => {
      if (data.run.id !== runId) return;
      cleanup();

      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      const errorMsg = typeof data.error === "string" ? data.error : String(data.error ?? "Unknown error");
      assignment.resultPreview = errorMsg.slice(0, 200);

      emitTaskSnapshot(bus, snapshot);
      // Return the full error to the orchestrator so it can diagnose and
      // retry/route, not just the truncated panel preview.
      emitAssignmentUpdate(bus, conversationId, taskId, assignment, capFullResult(errorMsg));
      emitTerminal(runId, false, assignment.resultPreview ?? "");
    });

    // Cancellation lifecycle. `executor.cancelRun` AND streamChat's own
    // AbortError branch both emit `run:cancel` (never `run:error`) — so
    // without this listener a cancelled sub-agent leaves the assignment
    // stuck in "running" forever. That's the "agent is stuck" bug in
    // the task panel: watchdog kills → run:error (handled); anything
    // else aborts → run:cancel (was unhandled).
    //
    // Idempotency: the task panel's Stop endpoint (/stop/+server.ts)
    // and task_stop tool both mutate the assignment DIRECTLY to
    // "assigned" before calling cancelRun. If the status is no longer
    // "running" by the time this listener fires, an earlier handler
    // already transitioned it — leave it alone to preserve the
    // resumable state.
    unsubCancel = bus.on("run:cancel", (data) => {
      if (data.run.id !== runId) return;
      cleanup();

      if (assignment.status !== "running") return;

      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      assignment.resultPreview = "Run was cancelled";

      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(bus, conversationId, taskId, assignment, "Run was cancelled");
      emitTerminal(runId, false, "Run was cancelled");
    });

    streamPromise.catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("streamChat error", { error: errorMsg });
      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      assignment.resultPreview = errorMsg.slice(0, 200);
      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(bus, conversationId, taskId, assignment, capFullResult(errorMsg));
      emitTerminal(runId, false, assignment.resultPreview ?? "");
    });
  }

  startRun(agentRunId, taskDescription);

  log.info("Started assignment", {
    conversationId,
    taskId,
    assignmentId: assignment.id,
    agentConfigId: assignment.agentConfigId,
    agentName: agentConfig.name,
    subConversationId,
    agentRunId,
  });

  return { subConversationId, agentRunId };
}
