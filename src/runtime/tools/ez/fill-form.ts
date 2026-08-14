/**
 * fill_form Ez tool (CLIENT-SIDE).
 *
 * Marked `clientSide: true`: the runtime does not execute it server-side.
 * When the LLM emits a `fill_form(...)` call the runtime emits an
 * `ez:client-tool` SSE event; the Ez panel intercepts it, fills the named
 * form's fields in the live DOM (dispatching bubbling `input`/`change`
 * events so Svelte `bind:value` picks them up), and POSTs the per-field
 * `{ filled[], skipped[] }` outcome back via
 * `/api/conversations/[id]/tool-results` so the agent loop continues.
 *
 * The suspend/abort/emit machinery is shared with navigate_to / read_page
 * via {@link runEzClientTool} — see `client-tool.ts`.
 */
import { Type } from "@earendil-works/pi-ai";
import { toolError, type BuiltinToolDef } from "../types";
import { runEzClientTool, type ClientToolContext } from "./client-tool";
import { ezClientToolWatchdogBudgetMs } from "../../ez-client-tool-registry";
import type { ToolParams } from "../validate";

// Re-exported for back-compat with older import sites; the canonical
// definitions now live in `client-tool.ts`.
export type { ClientToolContext };
export { EZ_CLIENT_TOOL_DEFERRED_MARKER } from "./client-tool";

export function createFillFormTool(ctx: ClientToolContext): BuiltinToolDef {
  return {
    name: "fill_form",
    label: "fill_form",
    description:
      "Fill fields in a form on the page the user is currently looking at. Call read_page first to discover the form's id and its field names. Provide `formId` (from read_page) and a `values` map of field-name → value. The panel fills the matching fields and reports which were filled and which were skipped (and why). NEVER submits the form — the user reviews the filled values and submits themselves. Password and file inputs are refused.",
    category: "ez",
    cardType: "default",
    clientSide: true,
    // The call suspends until the panel POSTs back, so the watchdog must
    // defer its idle kill for the WHOLE gate wait — never the 90s default.
    // Derived from the gate's own timeout; see ez-client-tool-registry.ts.
    callTimeoutMs: ezClientToolWatchdogBudgetMs(),
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        formId: { type: "string", minLength: 1, description: "ID of the form to fill, as reported by read_page." },
        values: { type: "object", additionalProperties: true, description: "Field-name → value map. Fields not present on the form are skipped." },
      },
      required: ["formId", "values"],
    }),
    execute: async (toolCallId, params: ToolParams, signal) => {
      const formId = typeof params?.formId === "string" ? params.formId : "";
      const values = params?.values && typeof params.values === "object" ? params.values : {};
      if (!formId) {
        return toolError("formId is required");
      }
      return runEzClientTool({
        ctx,
        toolCallId,
        toolName: "fill_form",
        input: { formId, values },
        signal,
        errorDetails: { formId },
      });
    },
  };
}
