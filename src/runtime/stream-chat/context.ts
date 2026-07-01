import type { AgentRun, Usage } from "../../types";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BuiltinToolDef } from "../tools/types";

/**
 * Per-call mutable state for `AgentExecutor.streamChat`.
 *
 * The original `streamChat` body declared ~20 `let`/`const` locals at the
 * top of the method, then captured them across many sibling closures
 * (parallel tool-loader IIFEs, the `piAgent.subscribe` event handler,
 * the bus subscriptions, and the success/error/finally cleanup blocks).
 * That dense capture made splitting the method into smaller pieces
 * unsafe — each helper would need 10+ params threaded through, or the
 * fields would have to leak onto the AgentExecutor instance.
 *
 * Bundling the locals into one per-call object means closures capture
 * a single `ctx` reference. Mutation is still in-place (via `ctx.foo =
 * bar`); ordering and observable behavior are unchanged. Phase modules
 * under `src/runtime/stream-chat/*` take `(ctx, host, ...)` and mutate
 * this object instead of being threaded a wide param list.
 *
 * NOT a class field. Created once per `streamChat` invocation; lives
 * only for that call's lifetime.
 */
export interface StreamChatContext {
  // ── identity & lifecycle ──
  /** The AgentRun being driven by this streamChat call. */
  run: AgentRun;
  /** Top-level abort controller for the whole turn. */
  controller: AbortController;
  /**
   * Base URL of the resolved model's endpoint. Stashed after model
   * resolution so the error-finalize path can name the unreachable host
   * in a friendly provider-connection error (see `friendlyProviderError`).
   * Undefined until setup resolves the model (or if resolution never ran).
   */
  modelBaseUrl: string | undefined;

  // ── prompt / tools (mutated during setup phase) ──
  /** System prompt — re-assigned by memory injection + orchestrator-prompt builders. */
  system: string | undefined;
  /** Tool list passed to pi-agent-core; mutated/filtered by tool loaders + scope filters. */
  agentTools: AgentTool[];
  /** Per-tool abort controllers, used by tool:kill bus handler + cleared in finally. */
  toolAbortControllers: Map<string, AbortController>;
  /** Built-in tool defs by name; used in tool wrappers + subscribe handler for cardType/category. */
  builtinToolDefsMap: Map<string, BuiltinToolDef>;
  /** Unsubscribe for the tool:permission_mode_change bus handler (only set when project tools loaded). */
  unsubModeChange: (() => void) | undefined;

  // ── streaming state (mutated by piAgent.subscribe handler) ──
  /** Accumulated text across all turns; read by watchdog + final result + cancel-partial path. */
  allTurnsText: string;
  /** Current-turn text only; reset on turn_start, used by cancel fallback. */
  turnText: string;
  /** Current-turn thinking deltas; reset on turn_start. */
  turnThinking: string;
  /** True once the current turn has emitted any tool_execution_start. */
  turnHasToolCalls: boolean;
  /** Latest persisted assistant-message id; used as parentMessageId for the next turn save. */
  lastSavedMessageId: string | null;
  /** Total token usage from the last turn_end (forwarded to obs:turn). */
  totalUsage: Usage;
  /** Serializes async DB writes triggered from the sync subscribe callback. */
  dbQueue: Promise<void>;
  /** Buffered tool-call args between tool_execution_start and tool_execution_end (for DB persistence). */
  pendingToolArgs: Map<string, Record<string, unknown>>;
  /** Wall-clock ms when the turn began (for obs:turn duration). */
  turnStart: number;

  // ── unsubs (collected during setup, called in finally) ──
  /** Unsubscribe for the piAgent.subscribe event stream. */
  unsub: (() => void) | undefined;
  /** Unsubscribe for the tool:kill bus handler. */
  unsubKill: (() => void) | undefined;
  /** Unsubscribes for agent:spawn/status/complete bus handlers (one per event). */
  unsubAgentActivity: Array<() => void>;
}

/**
 * Build a fresh `StreamChatContext` for a single `streamChat` call.
 *
 * Pure factory — takes only the values that are known at the call site
 * (the `run` and the top-level `controller`) plus the user-supplied
 * `parentMessageId` for the initial `lastSavedMessageId`. Everything
 * else is initialized to its empty/zero value. Subsequent setup code
 * mutates the returned object in place.
 */
export function createStreamChatContext(
  run: AgentRun,
  controller: AbortController,
  parentMessageId: string | undefined,
): StreamChatContext {
  return {
    run,
    controller,
    modelBaseUrl: undefined,
    system: undefined,
    agentTools: [],
    toolAbortControllers: new Map(),
    builtinToolDefsMap: new Map(),
    unsubModeChange: undefined,
    allTurnsText: "",
    turnText: "",
    turnThinking: "",
    turnHasToolCalls: false,
    lastSavedMessageId: parentMessageId ?? null,
    totalUsage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    dbQueue: Promise.resolve(),
    pendingToolArgs: new Map(),
    turnStart: Date.now(),
    unsub: undefined,
    unsubKill: undefined,
    unsubAgentActivity: [],
  };
}
