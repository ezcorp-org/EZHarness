import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { importExtensionSource, parseExtensionSourceInput } from "$server/extensions/source-import";
import { extensionControlError } from "$lib/server/extensions/control-errors";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const user = requireSessionAuth(locals);
    if (user instanceof Response) return user;
    const source = parseExtensionSourceInput(await readBoundedJson(request, 16_384));
    if (user.role !== "admin" && (!source.targetInstallationId || source.kind === "local" || source.kind === "bundled")) return json({ code: "forbidden", message: "Administrator session required for new or host-local imports" }, { status: 403 });
    return json(await importExtensionSource({ principalId: user.id, scope: "global", kind: "human" }, source));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SyntaxError) return json({ code: "invalid_input" }, { status: 400 });
    return extensionControlError(error);
  }
};
