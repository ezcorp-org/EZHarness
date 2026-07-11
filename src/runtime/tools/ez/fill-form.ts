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
import type { BuiltinToolDef } from "../types";
import { runEzClientTool, type ClientToolContext } from "./client-tool";

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
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        formId: { type: "string", minLength: 1, description: "ID of the form to fill, as reported by read_page." },
        values: { type: "object", additionalProperties: true, description: "Field-name → value map. Fields not present on the form are skipped." },
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
