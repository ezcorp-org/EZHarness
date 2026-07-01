/**
 * Phase 48 Wave 2 — navigate_to Ez tool (CLIENT-SIDE).
 *
 * Mirror of fill_form: marked `clientSide: true`, the execute body emits
 * an `ez:client-tool` event, registers a pending entry in the
 * `ez-client-tool-registry`, and awaits the panel's POST. The Ez panel
 * intercepts the event and calls SvelteKit's `goto(path)`, then POSTs
 * the result to `/api/conversations/[id]/tool-results`.
 *
 * Path validation is server-side here (must be a relative in-app path,
 * starting with `/`, no protocol or host) so even a buggy/malicious
 * client can't redirect the user to an external site by re-emitting the
 * event. We reject `//` (protocol-relative URLs) and any string with
 * `://` (full URLs). The Ez panel applies its own `goto`-side
 * validation as defense-in-depth.
 */
import { Type } from "@earendil-works/pi-ai";
import type { BuiltinToolDef } from "../types";
import type { ClientToolContext } from "./fill-form";
import { EZ_CLIENT_TOOL_DEFERRED_MARKER } from "./fill-form";
import {
  registerPendingEzClientTool,
  rejectEzClientTool,
  clearPendingEzClientTool,
} from "../../ez-client-tool-registry";

// Re-export so `index.ts` can use the same marker constant.
export { EZ_CLIENT_TOOL_DEFERRED_MARKER };

export function isValidInAppPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false; // protocol-relative
  if (path.includes("://")) return false; // absolute URL
  // Reject newlines / control chars that could smuggle headers downstream.
  if (/[\r\n]/.test(path)) return false;
  return true;
}

/** Mirror of `panelResultToToolResult` in fill-form. Kept inline rather
 *  than imported because the messages each tool surfaces differ ("filled"
 *  vs "navigated"), and pulling them through a shared helper would force
 *  every caller to thread the tool name as an argument anyway. */
function panelResultToToolResult(
  result: unknown,
  toolName: string,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
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

export function createNavigateToTool(ctx: ClientToolContext): BuiltinToolDef {
  return {
    name: "navigate_to",
    label: "navigate_to",
    description:
      "[LIMITED — page-context redesign pending] Navigate the user to an in-app route (e.g. '/marketplace?q=pdf' or '/agents/<id>'). External URLs are rejected. Routing-only navigation works, but reasoning about the destination's page state requires the page-context system being redesigned for a future release. Confirm with the user before navigating.",
    category: "ez",
    cardType: "default",
    clientSide: true,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Relative in-app path starting with '/'. External URLs (with ://) are rejected.",
        },
      },
      required: ["path"],
    }),
    execute: async (toolCallId, params: any, signal) => {
      const path = params?.path;
      if (!isValidInAppPath(path)) {
        return {
          content: [{ type: "text" as const, text: "Error: path must be a relative in-app path starting with '/'. External URLs are rejected." }],
          details: { isError: true },
        };
      }
      if (!ctx.bus) {
        return {
          content: [{ type: "text" as const, text: "Error: client-tool bus not wired" }],
          details: { isError: true, clientSide: true, toolName: "navigate_to" },
        };
      }

      // Suspend until the panel POSTs the resolution. Mirror of
      // fill-form's flow — register, attach abort listener, emit, await,
      // clear in finally.
      const pending = registerPendingEzClientTool({
        toolCallId,
        conversationId: ctx.conversationId,
        userId: ctx.userId ?? null,
      });
      const onAbort = () => {
        rejectEzClientTool(toolCallId, "Aborted while waiting for navigate_to client result");
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        ctx.bus.emit("ez:client-tool", {
          conversationId: ctx.conversationId,
          toolCallId,
          toolName: "navigate_to",
          input: { path },
        });
        const panelResult = await pending;
        return panelResultToToolResult(panelResult, "navigate_to");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { isError: true, clientSide: true, toolName: "navigate_to", deferred: true, path },
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        clearPendingEzClientTool(toolCallId);
      }
    },
  };
}
