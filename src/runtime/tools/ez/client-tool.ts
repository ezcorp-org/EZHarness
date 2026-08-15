/**
 * The Ez concierge's CLIENT-SIDE tools (`fill_form`, `navigate_to`,
 * `read_page`) as an adapter over the generic remote-tool engine.
 *
 * A client-side tool is not executed server-side: when the LLM calls it the
 * runtime emits an `ez:client-tool` SSE event, the Ez panel performs the real
 * UI operation (reading the page, filling a form, navigating), and POSTs the
 * resolution back to `/api/conversations/[id]/tool-results`. The POST handler
 * wakes the suspended promise via `runtime/remote-tool-registry`.
 *
 * Everything structural — register-before-emit, the abort listener, the
 * `finally`-clear, result normalization — lives in `../remote-tool.ts`, which
 * the caller-executed-tools family shares. THIS file contributes only what is
 * Ez-specific: the panel's five-minute budget, the failure sentences the model
 * reads, and the `clientSide: true` details marker the Ez tool cards key on.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { EventBus } from "../../events";
import type { AgentEvents } from "../../../types";
import {
  remoteResultToToolResult,
  remoteToolWatchdogBudgetMs,
  runRemoteTool,
  REMOTE_TOOL_WATCHDOG_MARGIN_MS,
} from "../remote-tool";

export interface ClientToolContext {
  conversationId: string;
  bus?: EventBus<AgentEvents>;
  /** Conversation owner — captured at wire time so the POST endpoint's
   *  auth check doesn't need a DB hop. Optional (tests can omit). */
  userId?: string | null;
}

export const EZ_CLIENT_TOOL_DEFERRED_MARKER = "[ez-client-tool:deferred]";

/** `details{}` fields every Ez client-tool result carries, so the panel's
 *  card renderer can tell an Ez round-trip from a server-side computation. */
const EZ_RESULT_MARKER = { clientSide: true } as const;

/**
 * How long a client-side Ez tool may legitimately suspend: the panel gets
 * five minutes to POST its resolution before the gate rejects with a concrete
 * timeout error.
 *
 * THE single source of truth for that wait. The three client-side tool defs
 * derive their watchdog `callTimeoutMs` from it via
 * {@link ezClientToolWatchdogBudgetMs} rather than restating the number — a
 * duplicated literal is exactly how the two halves drifted into the
 * 90s-vs-300s inversion that killed runs mid-wait.
 */
export const EZ_CLIENT_TOOL_TIMEOUT_MS = 5 * 60_000;
let ezClientToolTimeoutMs = EZ_CLIENT_TOOL_TIMEOUT_MS;

/** The live gate timeout — {@link EZ_CLIENT_TOOL_TIMEOUT_MS} in production, or
 *  whatever a test installed via {@link _setEzClientToolTimeoutForTests}. Read
 *  this (never the constant) when deriving anything that must track the real
 *  gate. */
export function getEzClientToolTimeoutMs(): number {
  return ezClientToolTimeoutMs;
}

/** Grace between the Ez gate's own rejection and the watchdog's run kill.
 *  Shared with the caller-tools family — see the reasoning on
 *  {@link REMOTE_TOOL_WATCHDOG_MARGIN_MS}. */
export const EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS = REMOTE_TOOL_WATCHDOG_MARGIN_MS;

/**
 * Watchdog `callTimeoutMs` for a client-side Ez tool def: the live gate
 * timeout plus {@link EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS}. Called by each
 * client-tool factory at def-construction time (once per turn), so a test that
 * shrinks the gate gets a proportionally shrunk watchdog budget with no second
 * knob to set.
 */
export function ezClientToolWatchdogBudgetMs(): number {
  return remoteToolWatchdogBudgetMs(getEzClientToolTimeoutMs());
}

/** Test-only: shorten the 5-minute timeout so the timeout branch can be
 *  exercised without a real wait. */
export function _setEzClientToolTimeoutForTests(ms: number): void {
  ezClientToolTimeoutMs = ms;
}

/** Test-only: reset to the production default. */
export function _resetEzClientToolTimeoutForTests(): void {
  ezClientToolTimeoutMs = EZ_CLIENT_TOOL_TIMEOUT_MS;
}

/**
 * Normalize whatever the Ez panel POSTs back into a stable `AgentToolResult`.
 * Uncapped: the payload is shaped by this app's own UI, and `read_page`'s
 * server-side excerpting already bounds it.
 */
export function panelResultToToolResult(
  result: unknown,
  toolName: string,
): ReturnType<typeof remoteResultToToolResult> {
  return remoteResultToToolResult(result, toolName, { marker: EZ_RESULT_MARKER });
}

/**
 * Emit `ez:client-tool` and suspend until the panel POSTs the resolution (or
 * the call aborts / times out).
 *
 * When no bus is wired (tests, non-streaming callers) the tool returns a
 * concrete error immediately rather than hanging for the five-minute timeout.
 */
export async function runEzClientTool(args: {
  ctx: ClientToolContext;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  /** Extra fields merged into the error result if the suspend rejects
   *  (abort / timeout) — the per-tool identifying args (formId, path). */
  errorDetails?: Record<string, unknown>;
}): Promise<AgentToolResult<unknown>> {
  const { ctx, toolCallId, toolName, input, signal, errorDetails } = args;
  return runRemoteTool({
    eventName: "ez:client-tool",
    event: { conversationId: ctx.conversationId, toolCallId, toolName, input },
    bus: ctx.bus,
    origin: "ez",
    toolCallId,
    toolName,
    input,
    conversationId: ctx.conversationId,
    userId: ctx.userId ?? null,
    // The Ez panel drops its pending list wholesale on disconnect rather than
    // per-run, so an Ez entry has no run to attribute and records none.
    runId: null,
    timeoutMs: getEzClientToolTimeoutMs(),
    messages: {
      timeout: "Timed out waiting for Ez client tool result",
      aborted: `Aborted while waiting for ${toolName} client result`,
      noBus: "client-tool bus not wired",
    },
    signal,
    result: { marker: EZ_RESULT_MARKER },
    errorDetails,
  });
}
