/**
 * navigate_to Ez tool (CLIENT-SIDE).
 *
 * Mirror of fill_form: marked `clientSide: true`, emits an `ez:client-tool`
 * event and suspends until the Ez panel POSTs the result. The panel calls
 * SvelteKit's `goto(path)` and then best-effort serializes the
 * destination page (route / title / headings) into `detail.destination`
 * so the model gains destination-state awareness after the navigation.
 *
 * Path validation is server-side here (must be a relative in-app path,
 * starting with `/`, no protocol or host) so even a buggy/malicious
 * client can't redirect the user to an external site by re-emitting the
 * event. We reject `//` (protocol-relative URLs) and any string with
 * `://` (full URLs). The Ez panel applies its own `goto`-side validation
 * as defense-in-depth.
 *
 * The suspend/abort/emit machinery is shared via {@link runEzClientTool}.
 */
import { Type } from "@earendil-works/pi-ai";
import type { BuiltinToolDef } from "../types";
import { runEzClientTool, type ClientToolContext } from "./client-tool";

export function isValidInAppPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false; // protocol-relative
  if (path.includes("://")) return false; // absolute URL
  // Reject newlines / control chars that could smuggle headers downstream.
  if (/[\r\n]/.test(path)) return false;
  return true;
}

export function createNavigateToTool(ctx: ClientToolContext): BuiltinToolDef {
  return {
    name: "navigate_to",
    label: "navigate_to",
    description:
      "Navigate the user to an in-app route (e.g. '/marketplace?q=pdf' or '/agents/<id>'). External URLs are rejected. After navigating, the result includes the destination page's route, title, and headings so you can reason about where the user landed. Confirm with the user before navigating them away from what they were doing.",
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
      return runEzClientTool({
        ctx,
        toolCallId,
        toolName: "navigate_to",
        input: { path },
        signal,
        errorDetails: { path },
      });
    },
  };
}
