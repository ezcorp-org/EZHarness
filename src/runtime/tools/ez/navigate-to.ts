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
import { toolError, type BuiltinToolDef } from "../types";
import { runEzClientTool, type ClientToolContext } from "./client-tool";
import { ezClientToolWatchdogBudgetMs } from "../../ez-client-tool-registry";
import type { ToolParams } from "../validate";

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
    // The call suspends until the panel POSTs back, so the watchdog must
    // defer its idle kill for the WHOLE gate wait — never the 90s default.
    // Derived from the gate's own timeout; see ez-client-tool-registry.ts.
    callTimeoutMs: ezClientToolWatchdogBudgetMs(),
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
    execute: async (toolCallId, params: ToolParams, signal) => {
      const path = params?.path;
      if (!isValidInAppPath(path)) {
        return toolError("path must be a relative in-app path starting with '/'. External URLs are rejected.");
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
