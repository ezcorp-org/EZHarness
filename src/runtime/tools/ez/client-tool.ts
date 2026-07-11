/**
 * Shared scaffolding for the Ez concierge's CLIENT-SIDE tools
 * (`fill_form`, `navigate_to`, `read_page`).
 *
 * A client-side tool is not executed server-side: when the LLM calls it
 * the runtime emits an `ez:client-tool` SSE event, the Ez panel performs
 * the real UI operation (reading the page, filling a form, navigating),
 * and POSTs the resolution back to `/api/conversations/[id]/tool-results`.
 * The POST handler wakes the suspended promise via
 * `ez-client-tool-registry`.
 *
 * All three tools share the SAME suspend/abort/emit machinery — this
 * module owns it so the individual factories only contribute their
 * per-tool argument validation + the event payload. That keeps the
 * client-tool contract (register-before-emit ordering, abort listener,
 * finally-clear) in one place instead of copy-pasted three ways.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { EventBus } from "../../events";
import type { AgentEvents } from "../../../types";
import {
  registerPendingEzClientTool,
  rejectEzClientTool,
  clearPendingEzClientTool,
} from "../../ez-client-tool-registry";

export interface ClientToolContext {
  conversationId: string;
  bus?: EventBus<AgentEvents>;
  /** Conversation owner — captured at wire time so the POST endpoint's
   *  auth check doesn't need a DB hop. Optional (tests can omit). */
  userId?: string | null;
}

export const EZ_CLIENT_TOOL_DEFERRED_MARKER = "[ez-client-tool:deferred]";

type ToolResultShape = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
};

/**
 * Normalize whatever the panel POSTs back into a stable `AgentToolResult`.
 * We intentionally accept a permissive `unknown` from the registry — the
 * panel may send either a structured `DispatchResult`
 * (`{ ok, error?, code?, detail? }`) or a bare error string.
 *
 * On an OK result carrying a `detail` object, the detail is ALSO rendered
 * as a compact fenced JSON block appended to the content text. `content[]`
 * is the only channel the LLM reads — `details{}` alone is card metadata
 * it never sees — so for `read_page` (whose whole point is returning page
 * context) and for `fill_form` / `navigate_to` (fill outcome / navigation
 * destination) the detail must ride the text channel to reach the model.
 */
export function panelResultToToolResult(
  result: unknown,
  toolName: string,
): ToolResultShape {
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
        content: [{ type: "text", text }],
        details: { clientSide: true, toolName, ...detail },
      };
    }
    return {
      content: [{ type: "text", text: r.error ?? `${toolName} failed` }],
      details: {
        isError: true,
        clientSide: true,
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
    content: [{ type: "text", text }],
    details: { clientSide: true, toolName },
  };
}

/**
 * Emit the `ez:client-tool` event and suspend until the panel POSTs the
 * resolution (or the call aborts / times out). The pending entry is
 * registered BEFORE the emit so a same-tick panel POST can resolve us; the
 * abort listener is wired for the runtime's `tool:kill` path; and the
 * registry entry is cleared in `finally` regardless of how it settled.
 *
 * When no bus is wired (tests, non-streaming callers) the tool returns a
 * concrete error immediately rather than hanging for the 5-minute timeout.
 */
export async function runEzClientTool(args: {
  ctx: ClientToolContext;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  /** Extra fields merged into the error result if the suspend rejects
   *  (abort / timeout) — the per-tool identifying args (formId, path)
   *  the pre-refactor inline bodies carried. */
  errorDetails?: Record<string, unknown>;
}): Promise<AgentToolResult<unknown>> {
  const { ctx, toolCallId, toolName, input, signal, errorDetails } = args;
  if (!ctx.bus) {
    return {
      content: [{ type: "text" as const, text: "Error: client-tool bus not wired" }],
      details: { isError: true, clientSide: true, toolName },
    };
  }

  const pending = registerPendingEzClientTool({
    toolCallId,
    conversationId: ctx.conversationId,
    userId: ctx.userId ?? null,
  });
  const onAbort = () => {
    rejectEzClientTool(toolCallId, `Aborted while waiting for ${toolName} client result`);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    ctx.bus.emit("ez:client-tool", {
      conversationId: ctx.conversationId,
      toolCallId,
      toolName,
      input,
    });
    const panelResult = await pending;
    return panelResultToToolResult(panelResult, toolName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      details: { isError: true, clientSide: true, toolName, deferred: true, ...(errorDetails ?? {}) },
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Defensive: if the Promise settled via timeout/abort the entry is
    // already gone, but call clear anyway so the map is tidy.
    clearPendingEzClientTool(toolCallId);
  }
}
