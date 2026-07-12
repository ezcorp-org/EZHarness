/**
 * read_page Ez tool (CLIENT-SIDE) — on-demand page context.
 *
 * The Ez concierge cannot see the user's screen by default. When a request
 * references "this page", "here", or an on-screen form, the LLM calls
 * read_page; the runtime emits an `ez:client-tool` event, the Ez panel
 * serializes the current page's DOM (route, title, headings, forms, and
 * their fields) and POSTs it back. The serialized context rides the
 * result's `detail` so {@link panelResultToToolResult} renders it into the
 * LLM-visible text (see client-tool.ts).
 *
 * `detail: "summary"` (the default) omits field VALUES — route, headings,
 * and form/field structure only. `detail: "full"` includes current field
 * values (password inputs are always masked panel-side). Summary is the
 * default so a bare "what's on this page?" doesn't pull the user's typed
 * data into the transcript unless the model explicitly asks for it.
 *
 * The suspend/abort/emit machinery is shared with fill_form / navigate_to
 * via {@link runEzClientTool}.
 */
import { Type } from "@earendil-works/pi-ai";
import type { BuiltinToolDef } from "../types";
import { runEzClientTool, type ClientToolContext } from "./client-tool";

export function createReadPageTool(ctx: ClientToolContext): BuiltinToolDef {
  return {
    name: "read_page",
    label: "read_page",
    description:
      "Read the page the user is currently looking at. Returns its route, title, headings, a visible-text excerpt of the main content (what the user is actually reading — e.g. the messages of an open chat), and any forms (with their field names/labels/types). Call this whenever a request references \"this page\", \"here\", or an on-screen form — it's how you discover a form's id before calling fill_form. Pass detail:\"full\" to also include current field values (passwords are always masked); the default detail:\"summary\" returns structure and content text only.",
    category: "ez",
    cardType: "default",
    clientSide: true,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        detail: {
          type: "string",
          enum: ["summary", "full"],
          description: "\"summary\" (default) = structure only; \"full\" = include current field values (masked passwords).",
        },
      },
      required: [],
    }),
    execute: async (toolCallId, params: any, signal) => {
      // Lenient: anything other than the explicit "full" opt-in falls back
      // to the privacy-preserving summary level.
      const detail: "summary" | "full" = params?.detail === "full" ? "full" : "summary";
      return runEzClientTool({
        ctx,
        toolCallId,
        toolName: "read_page",
        input: { detail },
        signal,
        errorDetails: { detail },
      });
    },
  };
}
