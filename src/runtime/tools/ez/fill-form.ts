/**
 * Phase 48 Wave 2 — fill_form Ez tool (CLIENT-SIDE).
 *
 * Marked `clientSide: true`, which the runtime treats as "do not execute
 * this server-side." Instead, when the LLM emits a `fill_form(...)` call,
 * the runtime emits an `ez:client-tool` SSE event to the streaming
 * client; the Ez panel intercepts the event and POSTs the resolution
 * back via `/api/conversations/[id]/tool-results` so the agent loop
 * continues. The page-side form registry that previously routed the
 * request to a live handler was retired with the `<EzContext>`
 * mechanism — the panel currently always responds "no-handler". A
 * future on-demand form-discovery design will reinstate the round-trip.
 *
 * The execute body emits the event AND registers a pending entry in
 * `ez-client-tool-registry`. The Promise returned by
 * `registerPendingEzClientTool` is awaited; the POST handler resolves
 * it (or it rejects on timeout / abort). When wired without a bus the
 * tool returns an error result immediately — the LLM sees a concrete
 * failure rather than a 5-minute hang.
 */
import { Type } from "@mariozechner/pi-ai";
import type { BuiltinToolDef } from "../types";
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

/**
 * Shape the panel POSTs back via `/tool-results`. We intentionally accept
 * a permissive `unknown` from the registry — the panel may send either a
 * structured `DispatchResult` or a bare error string. The tool body
 * normalizes whatever arrives into a stable `AgentToolResult` for the LLM.
 */
function panelResultToToolResult(
  result: unknown,
  toolName: string,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  // The dispatcher returns DispatchResult: `{ ok: true, ... }` or
  // `{ ok: false, error: string, code: string, ... }`. Mirror those into
  // AgentToolResult shape — `details.isError` flips `true` on failure so
  // the LLM treats it as a tool error.
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
      return {
        content: [{ type: "text", text: `${toolName} completed.` }],
        details: { clientSide: true, toolName, ...(r.detail ?? {}) },
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

export function createFillFormTool(ctx: ClientToolContext): BuiltinToolDef {
  return {
    name: "fill_form",
    label: "fill_form",
    description:
      "[COMING SOON — currently disabled] Fill in a form on the page the user is looking at. The page-context registry needed to discover and route to live forms is being redesigned and is not available in v1.3. Calls return a 'feature in development' result. Avoid using this tool until a future release reinstates page-context support.",
    category: "ez",
    cardType: "default",
    clientSide: true,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        formId: { type: "string", minLength: 1, description: "ID of the page-registered form to fill (from page context)." },
        values: { type: "object", additionalProperties: true, description: "Field-name → value map matching the form's declared schema." },
      },
      required: ["formId", "values"],
    }),
    execute: async (toolCallId, params: any, signal) => {
      const formId = typeof params?.formId === "string" ? params.formId : "";
      const values = params?.values && typeof params.values === "object" ? params.values : {};
      if (!formId) {
        return {
          content: [{ type: "text" as const, text: "Error: formId is required" }],
          details: { isError: true },
        };
      }
      if (!ctx.bus) {
        return {
          content: [{ type: "text" as const, text: "Error: client-tool bus not wired" }],
          details: { isError: true, clientSide: true, toolName: "fill_form" },
        };
      }

      // Register the pending Promise BEFORE emitting so a same-tick
      // panel POST can resolve us. Set up the abort listener too — the
      // runtime's `tool:kill` handler aborts via the signal, and we
      // surface that as a concrete error to the LLM.
      const pending = registerPendingEzClientTool({
        toolCallId,
        conversationId: ctx.conversationId,
        userId: ctx.userId ?? null,
      });
      const onAbort = () => {
        rejectEzClientTool(toolCallId, "Aborted while waiting for fill_form client result");
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        ctx.bus.emit("ez:client-tool", {
          conversationId: ctx.conversationId,
          toolCallId,
          toolName: "fill_form",
          input: { formId, values },
        });
        const panelResult = await pending;
        return panelResultToToolResult(panelResult, "fill_form");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { isError: true, clientSide: true, toolName: "fill_form", deferred: true, formId },
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        // Defensive: if the Promise settled via timeout/abort the entry
        // is already gone, but call clear anyway so the map is tidy.
        clearPendingEzClientTool(toolCallId);
      }
    },
  };
}
