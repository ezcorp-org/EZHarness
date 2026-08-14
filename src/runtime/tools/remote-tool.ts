/**
 * The engine for tools whose RESULT ARRIVES OVER HTTP rather than from a
 * server-side computation.
 *
 * Two families ride it — the Ez concierge's client-side tools
 * (`src/runtime/tools/ez/client-tool.ts`, `origin: "ez"`) and caller-executed
 * tools declared by an external application (`src/runtime/caller-tools-host.ts`,
 * `origin: "caller"`). They differ only in which event carries the call, which
 * strings the failure paths use, and whether the LLM-visible text is capped.
 * Everything else — register-before-emit ordering, the abort listener, the
 * `finally`-clear, the result normalization — is identical, and lives here so
 * the contract has one implementation rather than two that drift.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentEvents } from "../../types";
import type { EventBus } from "../events";
import {
  clearPendingRemoteTool,
  registerPendingRemoteTool,
  rejectRemoteTool,
  type RemoteToolOrigin,
} from "../remote-tool-registry";
import { truncateText } from "./output-limits";
import { errorMessage, toolError } from "./types";

/**
 * Grace added on top of a family's gate timeout to form the watchdog's
 * per-call deferral budget.
 *
 * **Who is meant to win the race, and why.** Two clocks bound one suspended
 * call: the registry's `setTimeout` (rejects the pending promise → the tool
 * returns a normal error result → the LLM reads a concrete "nobody answered"
 * and can tell the user), and the executor watchdog (kills the whole RUN once
 * the in-flight deferral lapses and the idle window then elapses → generic
 * error banner, turn dead, model never learns why). The registry MUST win: it
 * degrades one tool call, the watchdog degrades the turn. So the watchdog
 * budget is deliberately the LONGER of the two, and the watchdog survives only
 * as the backstop for the case the registry's own timer never fires (a leaked
 * entry, a future refactor that drops the timer).
 *
 * **Sizing — two watchdog ticks (`WATCHDOG_TICK_MS` = 15s), and that is a
 * FLOOR, not the distance to a kill.** The deferral is re-evaluated only once
 * per tick, so the margin has to outlast the tick that straddles the registry
 * rejection, plus the reject → `tool_execution_end` → `noteToolEnd`
 * propagation on a loaded box. The watchdog does NOT kill at `callTimeoutMs`:
 * every deferring tick calls `bumpActivity`, so the clock that matters starts
 * at the LAST DEFERRING TICK and then has to run a WHOLE idle window. Real
 * kill time is
 *
 *     callTimeoutMs + idleThreshold ± one tick
 *
 * — measured at **405s** for a non-reasoning Ez run (330 + 90 − 15), and up to
 * ~21 min on a reasoning-high run (900s idle window). That hold is deliberate
 * and bounded; the per-tier table, and the tests that pin these numbers, are in
 * `docs/features/chat/runs-lifecycle.md`.
 *
 * Not imported from the watchdog module on purpose — the tools layer never
 * depends on the watchdog (same posture as `LONG_BLOCKING_WATCHDOG_BUDGET_MS`
 * in `./filter.ts`).
 */
export const REMOTE_TOOL_WATCHDOG_MARGIN_MS = 30_000;

/** Watchdog `callTimeoutMs` for a remote tool that waits `gateTimeoutMs` for
 *  its client. Derived, never restated — a duplicated literal is exactly how
 *  the two halves of the Ez budget drifted into the 90s-vs-300s inversion that
 *  killed runs mid-wait. */
export function remoteToolWatchdogBudgetMs(gateTimeoutMs: number): number {
  return gateTimeoutMs + REMOTE_TOOL_WATCHDOG_MARGIN_MS;
}

/** The bus events that carry a remote tool call to its client. */
export type RemoteToolEventName = "ez:client-tool" | "caller:tool-call";

/** Failure text, supplied per family so the LLM reads a sentence that names
 *  the thing which did not answer. Stated explicitly rather than derived from
 *  `origin`: these strings are the model's only account of what went wrong. */
export interface RemoteToolMessages {
  /** Rejection when the client never POSTs within the gate timeout. */
  timeout: string;
  /** Rejection when the run's signal fires while we wait. */
  aborted: string;
  /** Error result when no bus is wired to carry the event at all. */
  noBus: string;
}

/** How a client's payload becomes an `AgentToolResult`. */
export interface RemoteResultOptions {
  /** Fixed fields merged into `details{}` so a card renderer can tell which
   *  family answered (`clientSide: true` for Ez, `callerSide: true`). */
  marker: Record<string, unknown>;
  /**
   * Cap on the LLM-visible text, in UTF-8 bytes. Set for caller tools, whose
   * payload comes from a machine outside this deployment; omitted for the Ez
   * panel, which is this app's own UI and whose payload the server shaped.
   */
  maxTextBytes?: number;
}

type ToolResultShape = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
};

function capText(text: string, toolName: string, maxTextBytes?: number): string {
  if (maxTextBytes === undefined) return text;
  return truncateText(text, maxTextBytes, toolName).text;
}

/**
 * Normalize whatever the client POSTs back into a stable `AgentToolResult`.
 * We intentionally accept a permissive `unknown` — a client may send either a
 * structured `{ ok, error?, code?, detail? }` or a bare error string.
 *
 * On an OK result carrying a `detail` object, the detail is ALSO rendered as a
 * compact fenced JSON block appended to the content text. `content[]` is the
 * only channel the LLM reads — `details{}` alone is card metadata it never
 * sees — so for `read_page` (whose whole point is returning page context), for
 * `fill_form` / `navigate_to` (fill outcome / navigation destination) and for
 * every caller tool (whose entire output IS its detail) the detail must ride
 * the text channel to reach the model.
 */
export function remoteResultToToolResult(
  result: unknown,
  toolName: string,
  opts: RemoteResultOptions,
): ToolResultShape {
  const { marker, maxTextBytes } = opts;
  if (
    result &&
    typeof result === "object" &&
    "ok" in result &&
    typeof (result as { ok: unknown }).ok === "boolean"
  ) {
    const r = result as {
      ok: boolean;
      error?: string;
      code?: string;
      detail?: Record<string, unknown>;
    };
    if (r.ok) {
      const detail = r.detail ?? {};
      let text = `${toolName} completed.`;
      if (Object.keys(detail).length > 0) {
        text += `\n\n\`\`\`json\n${JSON.stringify(detail, null, 2)}\n\`\`\``;
      }
      return {
        content: [{ type: "text", text: capText(text, toolName, maxTextBytes) }],
        details: { ...marker, toolName, ...detail },
      };
    }
    return {
      content: [
        {
          type: "text",
          text: capText(r.error ?? `${toolName} failed`, toolName, maxTextBytes),
        },
      ],
      details: {
        isError: true,
        ...marker,
        toolName,
        code: r.code,
        ...(r.detail ?? {}),
      },
    };
  }

  // Unknown shape — surface as text so the LLM still gets some signal.
  let text: string;
  try {
    text = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    text = String(result);
  }
  return {
    content: [{ type: "text", text: capText(text, toolName, maxTextBytes) }],
    details: { ...marker, toolName },
  };
}

export interface RunRemoteToolArgs<K extends RemoteToolEventName> {
  /** Bus event that carries the call out. Generic so `event` is checked
   *  against exactly this event's payload shape, not a union of both. */
  eventName: K;
  event: AgentEvents[K];
  /** Absent in tests and non-streaming callers — the tool then fails fast
   *  rather than parking for the whole gate timeout with nobody listening. */
  bus: EventBus<AgentEvents> | undefined;
  origin: RemoteToolOrigin;
  toolCallId: string;
  /** The name the CLIENT dispatches on — bare, matching `event.toolName`. */
  toolName: string;
  conversationId: string;
  userId: string | null;
  runId: string | null;
  /** How long the client has to POST before the gate rejects. */
  timeoutMs: number;
  messages: RemoteToolMessages;
  signal?: AbortSignal;
  result: RemoteResultOptions;
  /** Extra fields merged into the error result if the suspend rejects
   *  (abort / timeout) — the per-tool identifying args (formId, path). */
  errorDetails?: Record<string, unknown>;
}

/**
 * Emit the family's event and suspend until the client POSTs the resolution
 * (or the call aborts / times out). The pending entry is registered BEFORE the
 * emit so a same-tick POST can resolve us; the abort listener is wired for the
 * runtime's `tool:kill` path; and the registry entry is cleared in `finally`
 * regardless of how it settled.
 */
export async function runRemoteTool<K extends RemoteToolEventName>(
  args: RunRemoteToolArgs<K>,
): Promise<AgentToolResult<unknown>> {
  const { bus, toolCallId, toolName, messages, signal, result, errorDetails } = args;
  if (!bus) {
    return toolError(messages.noBus, { ...result.marker, toolName });
  }

  const pending = registerPendingRemoteTool({
    toolCallId,
    conversationId: args.conversationId,
    userId: args.userId,
    toolName,
    runId: args.runId,
    origin: args.origin,
    timeoutMs: args.timeoutMs,
    timeoutMessage: messages.timeout,
  });
  const onAbort = () => {
    rejectRemoteTool(toolCallId, messages.aborted);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    bus.emit(args.eventName, args.event);
    const clientResult = await pending;
    return remoteResultToToolResult(clientResult, toolName, result);
  } catch (err) {
    return toolError(errorMessage(err), {
      ...result.marker,
      toolName,
      deferred: true,
      ...(errorDetails ?? {}),
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Defensive: if the Promise settled via timeout/abort the entry is
    // already gone, but call clear anyway so the map is tidy.
    clearPendingRemoteTool(toolCallId);
  }
}
