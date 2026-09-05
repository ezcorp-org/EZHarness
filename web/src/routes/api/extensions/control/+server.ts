import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { extensionControlTools } from "$server/extensions/extension-control";
import { getExtensionControl } from "$server/extensions/extension-lifecycle-service";
import { extensionControlError } from "$lib/server/extensions/control-errors";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const denial = requireScope(locals, "extensions");
    if (denial) return denial;
    const user = requireAuth(locals);
    const body = await readBoundedJson(request, 128 * 1024 * 1024);
    if (!body || typeof body !== "object" || !("tool" in body) || !("input" in body)) return json({ code: "invalid_input", message: "Provide a tool and input object." }, { status: 400 });
    const tool = extensionControlTools.find((entry) => entry.name === body.tool);
    if (!tool || !body.input || typeof body.input !== "object" || Array.isArray(body.input)) return json({ code: "invalid_input", message: "Unknown tool or invalid input." }, { status: 400 });
    const result = await (await getExtensionControl()).execute({ principalId: user.id, scope: "global", kind: locals.authMethod === "session" ? "human" : "agent" }, tool.name, body.input as Record<string, unknown>, request.signal);
    return json(result);
  } catch (error) {
    return extensionControlError(error);
  }
};
